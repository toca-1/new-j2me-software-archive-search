'use strict';
// New J2ME Software Archive Search v4: no external JS dependencies.
const $ = id => document.getElementById(id);
const ROOT = './data/';
const I18N = window.J2ME_I18N;
const t = (key, vars) => I18N.t(key, vars);
const IA = 'https://archive.org/download/96x65pixels_j2me/';
const ARCHIVES = ['JARchiveLite_v11.7z', 'JARchive_v11.7z'];
// Full archive paths unavailable on the nnproject mirror.
const NNPROJECT_FULL_MISSING = new Set([".                                       1/.                                       1 (WORMS) (1.0) (CLDC-1.1, MIDP-2.0) (BootJoker) (7f17fdeefba505d9fe2e5a51e789347e2f5153ec8ab8d32ac9c1c79b99e1c789).jar", "..VIETVTC..nguoi con gai mau lanh/..VIETVTC..nguoi con gai mau lanh (HeroCraft) (1.4.0) (CLDC-1.0, MIDP-2.0) (Main) (01505f772d07305863f419a69179c73e9ebebfdfc754e24d2592ef66c1b72ba3).jar", "ChinhDomTV/ChinhDomTV (nguyendoanchinh.wapsite.meTELEVISION%202G-S40) (1.01) (CLDC-1.0, MIDP-2.0) (GameMidlet) (9ce85ae8fddff39f10c5cea313c7c43d82b88761540c9406915cfb933a4e0f0f).jar", "M_YouTube_ChinhDom/M_YouTube_ChinhDom (m.youtube.comwatchdesktop_uri=http%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D-yOXycNEoAc&v=-yOXycNEoAc&gl=US) (1.01) (CLDC-1.0, MIDP-2.0) (GameMidlet) (1fa199e30bfadadde6ece841ad54e2e0b6afa13b9332cd9f738ad1aadb939571).jar", "Readme - T41/Readme - T41 (Cugel@T41) (0.0.1) (CLDC-1.0, MIDP-1.0) (nl.t41.midlet.readme.Main) (532b09be357ff5054ba559825912bc6f43de6f8de41fdadeadc9773821e0a727).jar", "Readme - T41/Readme - T41 (Cugel@T41) (0.0.1) (CLDC-1.0, MIDP-1.0) (nl.t41.midlet.readme.Main) (6847ae78ed5a35676f251f370584ccaaebee8a496080580abd5a22292c0ed425).jar", "Readme - T41/Readme - T41 (Cugel@T41) (0.0.1) (CLDC-1.0, MIDP-1.0) (nl.t41.midlet.readme.Main) (ac001c962b1dc5803c34333fbed1f7d86e23b1ca52be7a11d1419a7e89f41381).jar", "Readme - T41/Readme - T41 (Cugel@T41) (0.0.1) (CLDC-1.0, MIDP-1.0) (nl.t41.midlet.readme.Main) (ea019cb412a7cabf0de0a34df8f198c9610505b4750bf3e2b448f79ea172228d).jar"]);
const NNPROJECT_FULL_OVERRIDES = new Map([]);
const PAGE = 20;
const INITIAL_PAGE = 5;
const WORKERS = 8;
// Sorting/refining needs metadata from record chunks spread across the archive.
// Use more concurrent reads than before (2) without fetching every chunk at once.
const SUMMARY_WORKERS = 6;
const MAX_CACHED_SEARCH_SHARDS = 12;
// Read the search-only index settings from data/manifest.json. This change
// leaves the manifest byte-identical for the folder browser's SHA-256 check.
function nameIndexConfig(index) {
  const chunks = index.names_chunks;
  const grams = index.names_grams;
  const suffix = '/grams.json.gz';
  const directory = typeof grams === 'string' && grams.endsWith(suffix)
    ? grams.slice(0, -suffix.length) : '';
  if (!Number.isSafeInteger(chunks) || chunks < 1 || !directory ||
      directory.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')))
    throw new Error(t('schemaMismatch'));
  return Object.freeze({chunks, grams, directory});
}
let NAME_INDEX;
let manifest, searchMode = 'name', active = [], shown = 0, generation = 0;
let searchGramPromise = null;
let labelsForMatches = new Map();
// Remember completed queries without retaining all parsed name shards.
const recentNameSearches = new Map();
const MAX_RECENT_NAME_SEARCHES = 5;
let showAllBusy = false;
const recordsCache = new Map(), detailsCache = new Map(), hashesCache = new Map(), namesCache = new Map();

const upstreamShardCache = new Map();
let upstreamSourcesPromise = null;

function elem(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = String(text);
  if (cls) e.className = cls;
  return e;
}
function fmt(x) { return Number(x).toLocaleString(I18N.numberLocale()); }
function size(x) { return x < 1024 ? `${fmt(x)} B` : x < 1048576 ? `${(x / 1024).toFixed(1)} KiB` : `${(x / 1048576).toFixed(2)} MiB`; }
function status(text) { $('status').textContent = text; }
function urlFor(collection, archivePath) {
  // Archive.org's 7z viewer URL-encodes the WHOLE member path (including '/').
  const member = encodeURIComponent(archivePath).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return IA + ARCHIVES[collection] + '/' + member;
}
// Retry temporary network and HTTP failures without silently losing search shards.
// Four total attempts: the first request plus up to three retries.
const FETCH_MAX_ATTEMPTS = 4;
const FETCH_RETRY_BASE_MS = 650;
const FETCH_RETRY_MAX_MS = 8000;
function fetchRetryDelay(response, attempt) {
  const retryAfter = response?.headers?.get('Retry-After');
  let suggestedMs = 0;
  if (retryAfter) {
    const value = retryAfter.trim();
    if (/^\d+(?:\.\d+)?$/.test(value)) {
      suggestedMs = Number(value) * 1000;
    } else {
      const until = Date.parse(value);
      if (Number.isFinite(until)) suggestedMs = Math.max(0, until - Date.now());
    }
  }
  const backoffMs = FETCH_RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * 250;
  return Math.min(FETCH_RETRY_MAX_MS, Math.max(suggestedMs, backoffMs));
}
async function fetchIndexWithRetry(path) {
  const url = ROOT + path;
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      // Retry temporary network failures, but not intentional cancellations.
      if (attempt === FETCH_MAX_ATTEMPTS || error?.name === 'AbortError') throw error;
      const delay = fetchRetryDelay(null, attempt);
      console.warn(`[J2ME] Network error loading ${path}; retry ${attempt}/${FETCH_MAX_ATTEMPTS - 1} in ${Math.round(delay)}ms`, error);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    if (response.ok) return response;
    // Never retry 404 (or other permanent client errors). Exact-hash lookup
    // intentionally handles 404 as an empty bucket elsewhere in the code.
    const transient = response.status === 408 || response.status === 429 ||
      (response.status >= 500 && response.status <= 599);
    if (!transient || attempt === FETCH_MAX_ATTEMPTS)
      throw new Error(t('loadFailed', {path, status: response.status}));
    const delay = fetchRetryDelay(response, attempt);
    console.warn(`[J2ME] HTTP ${response.status} loading ${path}; retry ${attempt}/${FETCH_MAX_ATTEMPTS - 1} in ${Math.round(delay)}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

async function readJson(path) {
  const response = await fetchIndexWithRetry(path);
  if (!response.ok) throw new Error(t('loadFailed', {path, status: response.status}));
  return response.json();
}
async function readGzipJson(path) {
  const response = await fetchIndexWithRetry(path);
  if (!response.ok) throw new Error(t('loadFailed', {path, status: response.status}));
  // Some hosts serve .gz with Content-Encoding, others as raw gzip bytes.
  const raw = new Uint8Array(await response.arrayBuffer());
  let text;
  if (raw.length > 1 && raw[0] === 31 && raw[1] === 139) {
    if (!('DecompressionStream' in window)) {
      throw new Error(t('gzipRequired'));
    }
    text = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  } else {
    text = new TextDecoder().decode(raw);
  }
  return JSON.parse(text);
}
function memoized(cache, key, load, max = 20) {
  if (!cache.has(key)) {
    const task = load().catch(error => { cache.delete(key); throw error; });
    cache.set(key, task);
    while (cache.size > max) cache.delete(cache.keys().next().value);
  } else {
    const promise = cache.get(key);
    cache.delete(key); cache.set(key, promise);
  }
  return cache.get(key);
}
async function recordById(id) {
  const chunk = Math.floor(id / manifest.record_chunk);
  const rows = await memoized(recordsCache, chunk, () => readGzipJson(`records/${String(chunk).padStart(4, '0')}.json.gz`), 12);
  return rows[id % manifest.record_chunk];
}
async function detailsById(id) {
  const chunk = Math.floor(id / manifest.record_chunk);
  const rows = await memoized(detailsCache, chunk, () => readGzipJson(`details/${String(chunk).padStart(4, '0')}.json.gz`), 6);
  return rows[id % manifest.record_chunk];
}
// Recognize an entire hexadecimal checksum, never just a matching prefix.
// CRC32 can collide, so that lookup continues to return every matching ID.
function detectHashType(value) {
  const hash = value.trim();
  if (!/^[0-9a-f]+$/i.test(hash)) return null;
  if (hash.length === 8) return 'crc32';
  if (hash.length === 40) return 'sha1';
  if (hash.length === 64) return 'sha256';
  return null;
}
// Exact CRC32 lookup can return multiple distinct file contents.
async function crc32Lookup(crc) {
  const key = crc.toLowerCase();
  const bucket = await memoized(hashesCache, 'crc32:' + key[0],
    () => readGzipJson(`crc32/${key[0]}.json.gz`), 12);
  return bucket[key] || [];
}
async function exactHashLookup(mode, hash) {
  const prefix = hash[0];
  const bucket = await memoized(hashesCache, mode + ':' + prefix,
    () => readGzipJson(`${mode}/${prefix}.json.gz`).catch(e => {
      if (e.message.includes('HTTP 404')) return {};
      throw e;
    }), 12);
  return bucket[hash];
}
async function gramMap() {
  if (!searchGramPromise) searchGramPromise = readGzipJson(NAME_INDEX.grams).catch(e => { searchGramPromise = null; throw e; });
  return searchGramPromise;
}
function candidateNameShards(query, maps) {
  const chars = Array.from(query);
  const length = chars.length >= 3 ? 3 : 2;
  const grams = maps[String(length)];
  let bits = (1n << BigInt(NAME_INDEX.chunks)) - 1n;
  for (let i = 0; i <= chars.length - length; i++) {
    const value = grams[chars.slice(i, i + length).join('')];
    if (!value) return [];
    bits &= BigInt('0x' + value);
    if (bits === 0n) return [];
  }
  const shards = [];
  for (let i = 0; i < NAME_INDEX.chunks; i++)
    if (bits & (1n << BigInt(i))) shards.push(i);
  return shards;
}
function nameShard(i) {
  return memoized(namesCache, i,
    () => readGzipJson(`${NAME_INDEX.directory}/${String(i).padStart(3, '0')}.json.gz`), MAX_CACHED_SEARCH_SHARDS);
}
// Lower scores are more relevant. Kind 0 = filename, 1 = MIDlet title,
// 2 = vendor. Vendor-only hits follow all filename/title matches.
// Use Unicode letters, digits and combining marks when detecting word starts.
const NAME_WORD_END = /[\p{L}\p{N}\p{M}]$/u;
function nameMatchRank(query, label, kind) {
  const vendorPenalty = kind === 2 ? 4 : 0;
  // "sonic.jar" should be an exact filename match for a search for "sonic".
  if (label === query || (kind === 0 && label.endsWith('.jar') && label.slice(0, -4) === query))
    return vendorPenalty;
  if (label.startsWith(query)) return vendorPenalty + 1;
  // A label can contain the term more than once: "panasonic sonic" has a
  // whole-word match even though its first occurrence is inside a word.
  for (let at = label.indexOf(query); at !== -1; at = label.indexOf(query, at + 1)) {
    if (!NAME_WORD_END.test(label.slice(0, at))) return vendorPenalty + 2;
  }
  return vendorPenalty + 3; // Remaining substring matches, e.g. "panasonic".
}
async function searchNames(query, current) {
  const remembered = recentNameSearches.get(query);
  if (remembered) {
    recentNameSearches.delete(query);
    recentNameSearches.set(query, remembered);
    labelsForMatches = new Map(remembered.labels);
    console.info('[J2ME search cache] HIT:', query, remembered.ids.length, 'results');
    return [...remembered.ids];
  }
  console.info('[J2ME search cache] MISS:', query);
  status(t('loadingIndex'));
  const grams = await gramMap();
  if (current !== generation) return [];
  const candidates = candidateNameShards(query, grams);
  if (candidates.length === 0) return [];
  status(t('searchingShards', {count: fmt(candidates.length)}));
  const found = new Array(candidates.length);
  let next = 0, completed = 0;
  const workers = Array.from({length: Math.min(WORKERS, candidates.length)}, async () => {
    while (current === generation) {
      const index = next++;
      if (index >= candidates.length) return;
      const list = await nameShard(candidates[index]);
      if (current !== generation) return;
      found[index] = list.filter(([label]) => label.includes(query));
      const done = ++completed;
      const percent = Math.floor(100 * done / candidates.length);
      // Reuse existing translated status template and place percent before (done/total).
      status(t('searchingNames', {done: `${percent}% (${fmt(done)}`, total: `${fmt(candidates.length)})`}));
    }
  });
  await Promise.all(workers);
  if (current !== generation) return [];
  const ids = new Set(), bestRank = new Map();
  for (const batch of found) for (const [label, id, kind] of batch) {
    ids.add(id);
    const rank = nameMatchRank(query, label, kind);
    if (!bestRank.has(id) || rank < bestRank.get(id)) bestRank.set(id, rank);
    // Keep the original preferred label for card-title fallback; ranking
    // separately considers every matching label for the same record.
    const earlier = labelsForMatches.get(id);
    if (!earlier || kind < earlier[1]) labelsForMatches.set(id, [label, kind]);
  }
  // Eight stable tiers avoid a full sort and preserve the previous order
  // between matches of equal relevance, even for very broad searches.
  const ranked = Array.from({length: 8}, () => []);
  for (const id of ids) ranked[bestRank.get(id)].push(id);
  const matches = ranked.flat();
  recentNameSearches.set(query, {ids: matches, labels: [...labelsForMatches]});
  while (recentNameSearches.size > MAX_RECENT_NAME_SEARCHES)
    recentNameSearches.delete(recentNameSearches.keys().next().value);
  return matches;
}
function copyButton(value, label = t('copy')) {
  const b = elem('button', label, 'copy'); b.type = 'button';
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(value); b.textContent = t('copied'); }
    catch { b.textContent = t('copyFailed'); }
    setTimeout(() => { b.textContent = label; }, 1600);
  });
  return b;
}
function hashRow(name, hash) {
  const row = elem('div', undefined, 'hashline');
  row.append(elem('span', name), elem('code', hash), copyButton(hash));
  return row;
}
function infoField(parent, title, value) {
  if (!value) return;
  const item = elem('div', undefined, 'info-field');
  item.append(elem('span', title), elem('strong', value));
  parent.append(item);
}
function showDetails(target, detailRows) {
  target.replaceChildren();
  if (!detailRows || !detailRows.length) {
    target.append(elem('p', t('noDetails'))); return;
  }
  for (const [collection, raw, paths, allPathCount] of detailRows) {
    const section = elem('section', undefined, 'detail-group');
    section.append(elem('h4', collection === 0 ? t('manifestLite') : t('manifestFull')));
    const fields = elem('dl', undefined, 'manifest-grid');
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'paths') continue;
      fields.append(elem('dt', key), elem('dd', value));
    }
    section.append(fields);
    const h = elem('h5', t('originalLocations', {count: fmt(allPathCount)}));
    section.append(h);
    if (paths.length) {
      const list = elem('div', undefined, 'original-paths');
      for (const p of paths) {
        const row = elem('div', undefined, 'original-path');
        row.append(elem('code', p), copyButton(p));
        list.append(row);
      }
      section.append(list);
    }
    if (allPathCount > paths.length)
      section.append(elem('p', t('showingLocations', {shown: fmt(paths.length), total: fmt(allPathCount)}), 'small'));
    target.append(section);
  }
}
// A verified JAR can have multiple archive sources, but needs only one fallback
// action per search result. Copying this command does NOT initiate a download.
function fallbackDownloadAction(sha256) {
  const wrapper = elem('div', undefined, 'fallback-download');
  const actions = elem('div', undefined, 'fallback-actions');

  const helpButton = elem('button', t('helpToggle') + ' ▾', 'fallback-help-toggle');
  helpButton.type = 'button';
  const panelId = `download-help-${sha256}`;
  helpButton.setAttribute('aria-controls', panelId);
  helpButton.setAttribute('aria-expanded', 'false');

  // Both commands are available without expanding the help panel.
  const linuxCommand = `python3 jarchive_download.py ${sha256}`;
  const windowsCommand = `py -3 .\\jarchive_download.py ${sha256}`;
  const copyGroup = elem('div', undefined, 'fallback-copy-group');
  copyGroup.append(elem('span', t('copyCommand'), 'fallback-copy-label'));
  const feedback = elem('span', '', 'sr-only');
  feedback.setAttribute('role', 'status');

  function commandCopyButton(label, command) {
    const button = elem('button', label, 'fallback-copy');
    button.type = 'button';
    button.setAttribute('aria-label', t('copyCommandAria', {system: label}));
    let reset;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(command);
        button.textContent = t('copiedBang');
        feedback.textContent = t('commandCopied', {system: label});
      } catch {
        button.textContent = t('copyFailed');
        feedback.textContent = t('clipboardError');
      }
      clearTimeout(reset);
      reset = setTimeout(() => {
        button.textContent = label;
        feedback.textContent = '';
      }, 2000);
    });
    return button;
  }
  copyGroup.append(
    commandCopyButton('Windows', windowsCommand),
    commandCopyButton('Linux/macOS', linuxCommand)
  );

  const panel = elem('div', undefined, 'fallback-help-panel');
  panel.id = panelId;
  panel.hidden = true;
  helpButton.addEventListener('click', () => {
    const opening = helpButton.getAttribute('aria-expanded') !== 'true';
    helpButton.setAttribute('aria-expanded', String(opening));
    helpButton.textContent = `${t('helpToggle')} ${opening ? '▴' : '▾'}`;
    panel.hidden = !opening;
  });

  const explanation = elem('p', t('downloadExplanationBefore'));
  const scriptLink = elem('a', 'jarchive_download.py');
  // A same-origin link allows Firefox to honor the download attribute.
  scriptLink.href = './jarchive_download.py';
  scriptLink.download = 'jarchive_download.py';
  explanation.append(scriptLink, document.createTextNode(t('downloadExplanationAfter')));

  const requirements = elem('p', t('downloadRequirements'));

  const linuxIntro = elem('p', t('linuxIntro'));
  const linuxExample = elem('pre');
  linuxExample.append(elem('code', linuxCommand));
  const windowsIntro = elem('p', t('windowsIntro'));
  const windowsExample = elem('pre');
  windowsExample.append(elem('code', windowsCommand));

  const links = elem('p', undefined, 'fallback-help-links');
  const guide = elem('a', t('guide'));
  guide.href = 'https://github.com/toca-1/new-j2me-software-archive-search/blob/main/docs/DOWNLOADER.md';
  guide.target = '_blank';
  guide.rel = 'noopener noreferrer';
  links.append(document.createTextNode(t('guidePrefix')),
    guide, document.createTextNode(t('guideSuffix')));

  panel.append(elem('h4', t('downloadHelpHeading')), explanation,
    requirements, linuxIntro, linuxExample, windowsIntro, windowsExample, links);
  actions.append(helpButton, copyGroup);
  wrapper.append(actions, feedback, panel);
  return wrapper;
}
// BEGIN compact download list (v2)
// A numbered download button and a separate disclosure for the internal path.
// All text is added as text nodes, not interpreted as HTML.
function downloadSourceRow(number, archive, memberPath, url) {
  const row = elem('div', undefined, 'download-row');
  const link = elem('a', String(number), 'download-number');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = t('downloadFrom', {archive});
  link.setAttribute('aria-label', t('downloadLinkAria', {number, archive}));

  const archiveLabel = elem('span', archive, 'download-archive');
  const pathBox = elem('details', undefined, 'download-path');
  const summary = elem('summary', undefined, 'download-path-summary');
  summary.append(elem('span', t('filePath'), 'download-filename'));
  const expanded = elem('div', undefined, 'download-path-full');
  expanded.append(elem('code', memberPath));
  pathBox.append(summary, expanded);
  row.append(link, archiveLabel, pathBox);
  return row;
}
// END compact download list (v2)

// BEGIN upstream direct download sources (v1)
// Lookups are isolated from the main search index. Only shards required for
// displayed results are fetched; missing matches do not alter search results.
async function upstreamSourceCatalog() {
  if (!upstreamSourcesPromise) {
    upstreamSourcesPromise = readJson('upstream/sources.json').catch(error => {
      upstreamSourcesPromise = null;
      throw error;
    });
  }
  return upstreamSourcesPromise;
}
function upstreamMemberUrl(base, path) {
  // Archive.org ZIP member URLs keep '/' between path components. Encode all
  // reserved characters within components, including '#' and '?'.
  const encoded = path.split('/').map(segment =>
    encodeURIComponent(segment).replace(/[!'()*]/g,
      ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase())).join('/');
  return base + encoded;
}
async function upstreamMatchesFor(sha256) {
  const catalog = await upstreamSourceCatalog();
  if (catalog.version !== 1 || !Array.isArray(catalog.sources))
    throw new Error('Unsupported upstream source catalog');
  const bucket = await memoized(upstreamShardCache, sha256[0],
    () => readGzipJson(`upstream/${sha256[0]}.json.gz`), 16);
  return (bucket[sha256] || []).map(([sourceIndex, memberPath]) => {
    const source = catalog.sources[sourceIndex];
    if (!source || typeof memberPath !== 'string') return null;
    return {label: source.label, path: memberPath,
      url: upstreamMemberUrl(source.base_url, memberPath)};
  }).filter(Boolean);
}
async function appendUpstreamDownloads(sha256, list) {
  try {
    const matches = await upstreamMatchesFor(sha256);
    if (!list.isConnected) return; // The search results could have changed.
    // Build all optional rows before inserting them, avoiding individual updates.
    const firstNumber = list.childElementCount + 1;
    list.append(...matches.map((match, index) =>
      downloadSourceRow(firstNumber + index, match.label, match.path, match.url)));
  } catch (error) {
    // Optional upstream URLs must not affect primary links or CLI fallback.
    console.warn('Optional upstream download links unavailable:', error);
  }
}

// END upstream direct download sources (v1)

// BEGIN optional archive-folder browser (prototype v1).
// This is a separate index. Search results and downloads still work even if
// data/folders/ hasn't been generated yet. Grouping means shared *folder*,
// never a verified software-version relationship.
const folderShardsCache = new Map();
let folderCatalogPromise = null;
const FOLDER_PAGE_SIZE = 10;
function folderBucket(folder) {
  // FNV-1a on UTF-8: must match tools/build_folder_groups.py exactly.
  let h = 2166136261;
  for (const byte of new TextEncoder().encode(folder))
    h = Math.imul(h ^ byte, 16777619) >>> 0;
  return (h >>> 24).toString(16).padStart(2, '0');
}
function folderCatalog() {
  if (!folderCatalogPromise) folderCatalogPromise = (async () => {
    const info = await readJson('folders/manifest.json');
    if (info.schema_version !== 1 || info.unique_files !== manifest.unique_files ||
        info.record_chunk !== manifest.record_chunk || !/^[0-9a-f]{64}$/.test(info.index_manifest_sha256))
      throw new Error('Folder index and search index do not match. Rebuild data/folders/.');
    // Verify the byte-identical manifest used when record IDs were assigned.
    if (!crypto?.subtle) throw new Error('Folder index requires a secure origin (localhost or HTTPS).');
    const response = await fetch(ROOT + 'manifest.json');
    if (!response.ok) throw new Error('Could not verify search index manifest');
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,'0')).join('');
    if (hex !== info.index_manifest_sha256)
      throw new Error('Folder index was built for a different version of data/manifest.json.');
    const counts = await readGzipJson('folders/counts.json.gz');
    if (!Array.isArray(counts)) throw new Error('Invalid folder count index');
    return new Map(counts);
  })().catch(error => {
    // Optional feature. No visible empty/broken control if it was not built.
    console.warn('Archive-folder browsing disabled:', error);
    return null;
  });
  return folderCatalogPromise;
}
function folderEntries(folder) {
  const key = folderBucket(folder);
  return memoized(folderShardsCache, key,
    () => readGzipJson(`folders/groups/${key}.json.gz`), 8).then(rows => rows[folder] || []);
}
function folderMemberRow(entry) {
  // [id, sha256, display_title, vendor, version, bytes]
  const [, sha, title, vendor, version, bytes] = entry;
  const row = elem('div', undefined, 'folder-file');
  const main = elem('div', undefined, 'folder-file-main');
  main.append(elem('div', title, 'folder-file-title'));
  const meta = elem('div', undefined, 'folder-file-meta');
  if (vendor) meta.append(elem('span', vendor));
  if (version) meta.append(elem('span', t('version', {version})));
  meta.append(elem('span', size(bytes)));
  meta.append(elem('span', `SHA-256 ${sha.slice(0, 12)}…`, 'folder-file-sha'));
  main.append(meta);
  const link = elem('a', t('folderView'), 'folder-file-link');
  const url = new URL(location.href);
  url.searchParams.set('sha256', sha);
  link.href = url.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `${t('folderView')}: ${title}`);
  row.append(main, link);
  return row;
}
async function addFolderBrowser(id, record, card, downloadSection, downloadBar,
                                downloadToggle, downloadPanel) {
  const seen = new Set();
  const paths = [];
  for (const source of record[3]) {
    const folder = source[2].slice(0, source[2].lastIndexOf('/'));
    if (folder && !seen.has(folder)) {seen.add(folder); paths.push(folder);}
  }
  if (!paths.length) return;
  const catalog = await folderCatalog();
  if (!catalog || !card.isConnected) return;
  const groups = paths.map(folder => ({folder, count: catalog.get(folder) || 0}))
    .filter(group => group.count > 1);
  if (!groups.length) return;

  const buttonText = groups.length === 1
    ? `${t('folderOther')} · ${fmt(groups[0].count - 1)}`
    : `${t('folderFolders')} · ${fmt(groups.length)}`;
  const button = elem('button', buttonText, 'folder-toggle');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  const panel = elem('div', undefined, 'folder-panel');
  panel.id = `folder-panel-${id}`;
  panel.hidden = true;
  button.setAttribute('aria-controls', panel.id);
  // Inside the existing action row: small and neutral, no extra card section.
  downloadBar.insertBefore(button, downloadBar.querySelector('.metadata-action'));
  downloadSection.insertBefore(panel, downloadPanel);
  let activeGroup = groups[0].folder;
  let request = 0;
  const content = elem('div', undefined, 'folder-content');
  panel.append(elem('p', t('folderDisclaimer'), 'folder-disclaimer'));
  if (groups.length > 1) {
    const choice = elem('div', undefined, 'folder-choice');
    const label = elem('label', t('folderChoose'));
    label.htmlFor = `folder-choose-${id}`;
    const select = elem('select');
    select.id = label.htmlFor;
    for (const group of groups) {
      const opt = elem('option', `${group.folder} (${fmt(group.count)})`);
      opt.value = group.folder;
      select.append(opt);
    }
    select.addEventListener('change', () => {activeGroup = select.value; loadFolder();});
    choice.append(label, select);
    panel.append(choice);
  } else {
    panel.append(elem('div', `${t('folderHeading')}: ${activeGroup}`, 'folder-title'));
  }
  panel.append(content);

  async function loadFolder() {
    const selected = activeGroup;
    const token = ++request;
    content.replaceChildren(elem('p', t('folderLoading'), 'small'));
    try {
      const all = await folderEntries(selected);
      if (token !== request || !card.isConnected) return;
      if (!Array.isArray(all)) throw new Error('Invalid folder member list');
      // The current result is already visible; don't repeat it in the list.
      const members = all.filter(row => row[0] !== id);
      const tools = elem('div', undefined, 'folder-tools');
      const filter = elem('input');
      filter.type = 'search'; filter.placeholder = t('folderFilter');
      filter.setAttribute('aria-label', t('folderFilter'));
      const counter = elem('span', undefined, 'folder-counter');
      tools.append(filter, counter);
      const rows = elem('div', undefined, 'folder-files');
      const more = elem('button', t('folderShowMore'), 'folder-more');
      more.type = 'button';
      let visible = FOLDER_PAGE_SIZE;
      const render = () => {
        const q = filter.value.toLocaleLowerCase().trim();
        const matching = q ? members.filter(([,sha,title,vendor,version]) =>
          [sha,title,vendor,version].some(v => String(v || '').toLocaleLowerCase().includes(q))) : members;
        counter.textContent = t('folderCounter', {
          matching: fmt(matching.length), total: fmt(members.length)
        });
        rows.replaceChildren(...matching.slice(0, visible).map(folderMemberRow));
        if (!matching.length) rows.append(elem('p', t('folderEmpty'), 'small'));
        more.hidden = visible >= matching.length;
      };
      filter.addEventListener('input', () => { visible = FOLDER_PAGE_SIZE; render(); });
      more.addEventListener('click', () => { visible += FOLDER_PAGE_SIZE; render(); });
      content.replaceChildren(tools, rows, more);
      render();
    } catch (error) {
      if (token === request && card.isConnected)
        content.replaceChildren(elem('p', `${t('folderLoadError')} ${error.message}`, 'folder-error'));
    }
  }
  function collapse() {
    button.setAttribute('aria-expanded','false');
    panel.hidden = true;
  }
  button.addEventListener('click', () => {
    const open = panel.hidden;
    if (open) {
      // Avoid having two huge result-card sections open at once.
      downloadPanel.hidden = true;
      downloadToggle.setAttribute('aria-expanded', 'false');
      downloadToggle.removeAttribute('aria-busy');
    }
    button.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open && !content.hasChildNodes()) loadFolder();
  });
  downloadToggle.addEventListener('click', () => { if (!downloadPanel.hidden) collapse(); });
}
// END optional archive-folder browser (prototype v1).

function renderResult(id, record) {
  // [sha256, sha1, byteSize, sources, [title,vendor,version,cldc,midp]]
  const [sha256, sha1, bytes, sources, quick] = record;
  const [title, vendor, version, cldc, midp] = quick;
  const match = labelsForMatches.get(id);
  const card = elem('article', undefined, 'card');
  const header = elem('div', undefined, 'card-head');
  header.append(elem('h3', title || (match && match[1] === 0 ? match[0] : sources[0][1])), elem('span', size(bytes), 'size'));
  card.append(header);
  if (vendor || version || cldc || midp) {
    const summary = elem('div', undefined, 'midlet-summary');
    if (vendor) summary.append(elem('span', vendor));
    if (version) summary.append(elem('span', t('version', {version})));
    if (cldc) summary.append(elem('span', cldc));
    if (midp) summary.append(elem('span', midp));
    card.append(summary);
  }
  // Archive-source CRC32s belong to the same file-content hash, so show one
  // shared checksum. Flag inconsistent source metadata instead of hiding it.
  const crcValues = [...new Set(sources.map(source => String(source[3] || '').toUpperCase()).filter(Boolean))];
  if (crcValues.length === 1) {
    card.append(hashRow('CRC32', crcValues[0]));
  } else if (crcValues.length > 1) {
    card.append(elem('p', t('conflictingCrc', {values: crcValues.join(', ')}), 'crc-warning'));
  }
  card.append(hashRow('SHA-1', sha1), hashRow('SHA-256', sha256));
  const downloadSection = elem('section', undefined, 'download-section');
  const iaList = elem('div', undefined, 'download-list');
  const mirrorList = elem('div', undefined, 'download-list');

  for (const [coll, , path] of sources) {
    iaList.append(downloadSourceRow(iaList.childElementCount + 1,
      coll === 0 ? 'JARchive Lite' : 'JARchive Full',
      path, urlFor(coll, path)));

    if (coll === 0) {
      mirrorList.append(downloadSourceRow(mirrorList.childElementCount + 1,
        'nnproject (Lite)', path, upstreamMemberUrl(
          'https://f.nnproject.cc/jarchive/JARchiveLite_v11/', path)));
    } else if (coll === 1 && !NNPROJECT_FULL_MISSING.has(path)) {
      const mirrorUrl = NNPROJECT_FULL_OVERRIDES.get(path) || upstreamMemberUrl(
        'https://f.nnproject.cc/jarchive/JARchive_v11/', path);
      mirrorList.append(downloadSourceRow(mirrorList.childElementCount + 1,
        'nnproject (Full)', path, mirrorUrl));
    }
  }

  // Keep the download links and fallback commands collapsed until requested.
  const downloadToggle = elem('button', t('downloadToggle'), 'download-toggle');
  downloadToggle.type = 'button';
  downloadToggle.setAttribute('aria-expanded', 'false');
  const downloadPanel = elem('div', undefined, 'download-panel');
  downloadPanel.id = `download-panel-${id}`;
  downloadPanel.hidden = true;
  downloadToggle.setAttribute('aria-controls', downloadPanel.id);
  // Fetch optional links only on the first expansion, but reveal the complete
  // panel together. Otherwise primary links show first and optional ones pop in.
  let upstreamLookupStarted = false;
  let upstreamReady = false;
  downloadToggle.addEventListener('click', () => {
    const opening = downloadToggle.getAttribute('aria-expanded') !== 'true';
    downloadToggle.setAttribute('aria-expanded', String(opening));
    if (!opening) {
      downloadPanel.hidden = true;
      downloadToggle.removeAttribute('aria-busy');
      return;
    }
    if (upstreamReady) {
      downloadPanel.hidden = false;
      return;
    }
    downloadPanel.hidden = true;
    downloadToggle.setAttribute('aria-busy', 'true');
    if (!upstreamLookupStarted) {
      upstreamLookupStarted = true;
      appendUpstreamDownloads(sha256, iaList).then(() => {
        // Even if the optional lookup fails, the primary links must be shown.
        upstreamReady = true;
        downloadToggle.removeAttribute('aria-busy');
        // Another disclosure might have been opened during the request.
        if (card.isConnected && downloadToggle.getAttribute('aria-expanded') === 'true')
          downloadPanel.hidden = false;
      });
    }
  });

  // The disclosure label and source headings are translated separately.
  downloadPanel.append(
    elem('h4', t('downloadHeadingInternetArchive'), 'download-heading'),
    iaList
  );

  if (mirrorList.childElementCount) {
    const mirrors = elem('div', undefined, 'download-mirror-group');
    mirrors.append(
      elem('h4', t('downloadHeadingOtherMirrors'), 'download-heading'),
      mirrorList
    );
    downloadPanel.append(mirrors);
  }
  downloadPanel.append(fallbackDownloadAction(sha256));

  const more = elem('button', t('showMetadata'), 'metadata-toggle');
  more.type = 'button'; more.setAttribute('aria-expanded', 'false');
  const body = elem('div', undefined, 'metadata-body'); body.hidden = true;
  let loaded = false;
  more.addEventListener('click', async () => {
    const open = more.getAttribute('aria-expanded') !== 'true';
    more.setAttribute('aria-expanded', open ? 'true' : 'false');
    more.textContent = open ? t('hideMetadata') : t('showMetadata');
    body.hidden = !open;
    if (open && !loaded) {
      body.replaceChildren(elem('p', t('loadingMetadata'), 'small'));
      try {
        showDetails(body, await detailsById(id)); loaded = true;
      } catch (e) {
        body.replaceChildren(elem('p', t('metadataError', {error: e.message}), 'small'));
      }
    }
  });
  // Keep the manifest accessible even while downloads are collapsed.
  const manifestAction = elem('div', undefined, 'metadata-action');
  manifestAction.append(more);
  const downloadBar = elem('div', undefined, 'download-bar');
  downloadBar.append(downloadToggle, manifestAction);
  downloadSection.append(downloadBar, downloadPanel);
  card.append(downloadSection, body);
  addFolderBrowser(id, record, card, downloadSection, downloadBar, downloadToggle, downloadPanel)
    .catch(error => console.warn('Archive-folder UI unavailable:', error));
  return card;
}
// Search within all original matches, with metadata loaded only on demand.
let originalResults = null, resultViewVersion = 0, moreLoadingVersion = null;
function resultTitle(id, record) {
  const match = labelsForMatches.get(id);
  return record[4][0] || (match && match[1] === 0 ? match[0] : record[3][0][1]);
}
function setResultControlsBusy(busy) {
  document.querySelectorAll('#result-tools input, #result-tools button, #result-tools select')
    .forEach(control => { control.disabled = busy; });
}
function resetResultTools() {
  originalResults = null; resultViewVersion++;
  $('result-tools').hidden = true;
  $('refine-query').value = ''; $('result-sort').value = 'default';
}
function installResultTools() {
  const tools = elem('div', undefined, 'result-tools');
  tools.id = 'result-tools'; tools.hidden = true;
  const form = elem('form', undefined, 'refine-form');
  const label = elem('label', t('refineLabel')); label.htmlFor = 'refine-query';
  const input = elem('input');
  input.id = 'refine-query'; input.type = 'search'; input.autocomplete = 'off';
  input.placeholder = t('refinePlaceholder'); 
  const apply = elem('button', t('refineButton')); apply.type = 'submit';
  const clear = elem('button', t('refineClear'), 'refine-clear'); clear.type = 'button';
  form.append(label, input, apply, clear);
  const sortLabel = elem('label', t('sortLabel'), 'result-sort-label'); sortLabel.htmlFor = 'result-sort';
  const sort = elem('select'); sort.id = 'result-sort';
  for (const [value, text] of [['default', t('sortDefault')], ['title-asc', t('sortTitleAsc')],
    ['title-desc', t('sortTitleDesc')], ['size-asc', t('sortSmallFirst')], ['size-desc', t('sortLargeFirst')]]) {
    const option = elem('option', text); option.value = value; sort.append(option);
  }
   
  tools.append(form, sortLabel, sort);
  document.querySelector('.result-heading').after(tools);
  form.addEventListener('submit', event => { event.preventDefault(); applyResultTools(); });
  clear.addEventListener('click', () => { input.value = ''; applyResultTools(); });
  input.addEventListener('search', () => { if (!input.value) applyResultTools(); });
  sort.addEventListener('change', () => applyResultTools());
}
async function prepareResultSummaries(state, current) {
  if (state.ready) return;
  const groups = new Map();
  for (const id of state.ids) {
    if (state.summaries.has(id)) continue;
    const chunk = Math.floor(id / manifest.record_chunk);
    if (!groups.has(chunk)) groups.set(chunk, []);
    groups.get(chunk).push(id);
  }
  const batches = [...groups]; let next = 0, completed = state.summaries.size;
  const worker = async () => {
    while (current === generation && originalResults === state) {
      const index = next++;
      if (index >= batches.length) return;
      const [chunk, ids] = batches[index];
      const rows = await memoized(recordsCache, chunk,
        () => readGzipJson(`records/${String(chunk).padStart(4, '0')}.json.gz`), 12);
      if (current !== generation || originalResults !== state) return;
      for (const id of ids) {
        const record = rows[id % manifest.record_chunk], title = resultTitle(id, record);
        const fields = [title, ...record[4], ...record[3].map(source => source[1])]
          .map(value => String(value || '').toLowerCase());
        state.summaries.set(id, {title, bytes: record[2], fields});
      }
      completed += ids.length;
      status(t('preparingRefine', {done: fmt(completed), total: fmt(state.ids.length)}));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
  const outcomes = await Promise.allSettled(Array.from({length: Math.min(SUMMARY_WORKERS, batches.length)}, worker));
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed) throw failed.reason;
  if (current === generation && originalResults === state) state.ready = true;
}
function selectResultIds(state, query, order) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  let ids = words.length ? state.ids.filter(id => words.every(word =>
    state.summaries.get(id).fields.some(field => field.includes(word)))) : [...state.ids];
  if (order !== 'default') {
    const collator = new Intl.Collator(I18N.numberLocale(), {numeric: true, sensitivity: 'base'});
    ids.sort((a, b) => {
      const x = state.summaries.get(a), y = state.summaries.get(b);
      const difference = order.startsWith('size-') ? x.bytes - y.bytes : collator.compare(x.title, y.title);
      return order.endsWith('desc') ? -difference : difference;
    });
  }
  return ids;
}
async function applyResultTools() {
  const state = originalResults;
  if (!state || state.busy) return;
  const current = generation;
  const query = $('refine-query').value.trim(), order = $('result-sort').value;
  state.busy = true; setResultControlsBusy(true); $('more').disabled = true; $('show-all').disabled = true;
  try {
    if (query || order !== 'default') await prepareResultSummaries(state, current);
    if (current !== generation || originalResults !== state) return;
    active = selectResultIds(state, query, order); shown = 0; resultViewVersion++;
    $('results').replaceChildren(); $('more').hidden = true; $('show-all').hidden = true;
    status(query ? t('subsetCount', {count: fmt(active.length), total: fmt(state.ids.length)}) :
      t('matchingFiles', {count: fmt(active.length), pluralCount: active.length}));
    if (active.length) await renderMore(current, INITIAL_PAGE);
    else $('results').append(elem('div', t('noRefinedResults'), 'empty'));
  } catch (error) {
    if (current === generation && originalResults === state) {
      status(t('refineError', {error: error.message})); console.error(error);
    }
  } finally {
    state.busy = false;
    if (current === generation && originalResults === state) {
      setResultControlsBusy(false); $('more').disabled = false; $('show-all').disabled = false;
    }
  }
}
function updatePaginationButtons() {
  const remaining = Math.max(0, active.length - shown);
  const more = $('more'), all = $('show-all');
  more.hidden = all.hidden = remaining === 0;
  more.textContent = t('moreRemaining', {count: fmt(remaining)});
  all.textContent = t('showAllRemaining', {count: fmt(remaining)});
}
async function renderAllRemaining(current) {
  if (showAllBusy || current !== generation) return;
  showAllBusy = true;
  const view = resultViewVersion;
  $('more').disabled = true;
  $('show-all').disabled = true;
  try {
    while (current === generation && view === resultViewVersion && shown < active.length) {
      const before = shown;
      await renderMore(current, PAGE);
      if (shown === before) break; // Prevent looping if the view was cancelled.
      // Allow browser painting and user interactions between batches.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } catch (error) {
    if (current === generation && view === resultViewVersion) {
      status(t('loadMoreError'));
      console.error(error);
    }
  } finally {
    if (current === generation && view === resultViewVersion) {
      showAllBusy = false;
      $('more').disabled = Boolean(originalResults?.busy);
      $('show-all').disabled = Boolean(originalResults?.busy);
      updatePaginationButtons();
    }
  }
}
async function renderMore(current, pageSize = PAGE) {
  const view = resultViewVersion;
  if (current !== generation || moreLoadingVersion === view) return;
  const button = $('more'); button.disabled = true; $('show-all').disabled = true; moreLoadingVersion = view;
  try {
    const ids = active.slice(shown, Math.min(shown + pageSize, active.length));
    const results = await Promise.all(ids.map(recordById));
    if (current !== generation || view !== resultViewVersion) return;
    results.forEach((rec, i) => $('results').append(renderResult(ids[i], rec)));
    shown += ids.length; updatePaginationButtons();
  } finally {
    if (moreLoadingVersion === view) moreLoadingVersion = null;
    if (current === generation && view === resultViewVersion) {
      button.disabled = Boolean(showAllBusy || (originalResults && originalResults.busy));
      $('show-all').disabled = Boolean(showAllBusy || (originalResults && originalResults.busy));
    }
  }
}

async function runSearch() {
  document.querySelector('.results-section').hidden = false;
  const current = ++generation;
  resetResultTools();
  const term = $('query').value.trim();
  $('results').replaceChildren(); $('more').hidden = true; $('show-all').hidden = true; labelsForMatches = new Map();
  showAllBusy = false;
  if (!manifest) { status(t('indexNotLoaded')); return; }
  if (!term) { status(t('enterSearchTerm')); return; }
  $('search-form').querySelector('button').disabled = true;
  try {
    let ids = [];
    if (searchMode === 'name') {
      if (Array.from(term).length < 2) throw new Error(t('enterName'));
      ids = await searchNames(term.toLowerCase(), current);
    } else {
      const hashType = detectHashType(term);
      if (!hashType) throw new Error(t('enterAnyHash'));
      if (hashType === 'crc32') {
        status(t('lookingUpCrc'));
        ids = await crc32Lookup(term);
      } else {
        const id = await exactHashLookup(hashType, term.toLowerCase());
        if (id !== undefined) ids = [id];
      }
    }
    if (current !== generation) return;
    active = ids; shown = 0;
    originalResults = {ids: [...ids], summaries: new Map(), ready: false, busy: false};
    $('result-tools').hidden = ids.length === 0;
    setResultControlsBusy(false);
    if (!ids.length) {
      status(t('zeroMatching')); $('results').append(elem('div', t('noMatchingFiles'), 'empty')); return;
    }
    status(t('matchingFiles', {count: fmt(ids.length), pluralCount: ids.length}));
    await renderMore(current, INITIAL_PAGE);
  } catch (e) {
    if (current !== generation) return;
    status(t('searchError')); $('results').append(elem('div', e.message, 'empty')); console.error(e);
  } finally {
    if (current === generation) $('search-form').querySelector('button').disabled = false;
  }
}
function updateSearchHint() {
  if (searchMode === 'name') {
    $('hint').textContent = t('hintName');
    return;
  }
  const type = detectHashType($('query').value);
  const label = {crc32: 'CRC32', sha1: 'SHA-1', sha256: 'SHA-256'}[type];
  $('hint').textContent = label ? t('detectedHash', {hash: label}) : t('hintHashAuto');
}
async function init() {
  await I18N.init();
  installResultTools();
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    searchMode = button.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(b => {
      b.classList.toggle('active', b === button);
      b.setAttribute('aria-pressed', b === button ? 'true' : 'false');
    });
    $('query').placeholder = searchMode === 'name' ? t('queryPlaceholder') : t('queryPlaceholderHashAuto');
    updateSearchHint();
    $('query').focus();
  }));
  $('query').addEventListener('input', updateSearchHint);
  $('search-form').addEventListener('submit', e => {
    e.preventDefault();
    // If a folder result opened this page by hash, normal searches clear that link.
    const url = new URL(location.href);
    if (url.searchParams.has('sha256')) {
      url.searchParams.delete('sha256');
      history.replaceState(history.state, '', url.href);
    }
    runSearch();
  });
  $('more').addEventListener('click', () => renderMore(generation).catch(e => {
    status(t('loadMoreError')); console.error(e);
  }));
  $('show-all').addEventListener('click', () => renderAllRemaining(generation));
  $('language-select').addEventListener('change', () => updatePaginationButtons());
  try {
    const loadedManifest = await readJson('manifest.json');
    if (loadedManifest.schema_version !== 4) throw new Error(t('schemaMismatch'));
    const loadedNameIndex = nameIndexConfig(loadedManifest);
    // Publish both settings together so a malformed index cannot leave the
    // search handler with a loaded manifest but no name-index configuration.
    manifest = loadedManifest;
    NAME_INDEX = loadedNameIndex;
    $('unique-count').textContent = fmt(manifest.unique_files);
    if ($('entries-count')) $('entries-count').textContent = fmt(manifest.total_rows);
    if ($('shared-count')) $('shared-count').textContent = fmt(manifest.shared_files);
    // Open a specific group member in a separate tab by its stable SHA-256.
    const linkedSha = new URLSearchParams(location.search).get('sha256');
    if (linkedSha && /^[0-9a-f]{64}$/i.test(linkedSha)) {
      document.querySelector('[data-mode="hash"]').click();
      $('query').value = linkedSha.toLowerCase();
      updateSearchHint();
      await runSearch();
    }
  } catch (e) {
    // Show the error only after fetchIndexWithRetry has exhausted its retries.
    // Otherwise the results section remains hidden and startup failures look
    // like an unresponsive search page.
    document.querySelector('.results-section').hidden = false;
    status(t('searchIndexUnavailable'));
    const message = elem('div', e.message, 'empty');
    const reload = elem('button', t('reloadPage'), 'startup-reload');
    reload.type = 'button';
    reload.addEventListener('click', () => location.reload());
    message.append(reload);
    $('results').replaceChildren(message);
    console.error('[J2ME] Index startup failed:', e);
  }
}
init();
