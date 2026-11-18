'use strict';
// New J2ME Software Archive Search v4: no external JS dependencies.
const $ = id => document.getElementById(id);
const ROOT = './data/';
const I18N = window.J2ME_I18N;
const t = (key, vars) => I18N.t(key, vars);
const IA = 'https://archive.org/download/96x65pixels_j2me/';
const MINI_IA = 'https://archive.org/download/96x65pixels_j2me_mini/';
const ARCHIVES = ['JARchiveLite_v11.7z', 'JARchive_v11.7z'];
// Full archive paths unavailable on the nnproject mirror.
const NNPROJECT_FULL_MISSING = new Set([".                                       1/.                                       1 (WORMS) (1.0) (CLDC-1.1, MIDP-2.0) (BootJoker) (7f17fdeefba505d9fe2e5a51e789347e2f5153ec8ab8d32ac9c1c79b99e1c789).jar", "..VIETVTC..nguoi con gai mau lanh/..VIETVTC..nguoi con gai mau lanh (HeroCraft) (1.4.0) (CLDC-1.0, MIDP-2.0) (Main) (01505f772d07305863f419a69179c73e9ebebfdfc754e24d2592ef66c1b72ba3).jar", "ChinhDomTV/ChinhDomTV (nguyendoanchinh.wapsite.meTELEVISION%202G-S40) (1.01) (CLDC-1.0, MIDP-2.0) (GameMidlet) (9ce85ae8fddff39f10c5cea313c7c43d82b88761540c9406915cfb933a4e0f0f).jar", "M_YouTube_ChinhDom/M_YouTube_ChinhDom (m.youtube.comwatchdesktop_uri=http%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D-yOXycNEoAc&v=-yOXycNEoAc&gl=US) (1.01) (CLDC-1.0, MIDP-2.0) (GameMidlet) (1fa199e30bfadadde6ece841ad54e2e0b6afa13b9332cd9f738ad1aadb939571).jar", "Readme - T41/Readme - T41 (Cugel@T41) (0.0.1) (CLDC-1.0, MIDP-1.0) (nl.t41.midlet.readme.Main) (532b09be357ff5054ba559825912bc6f43de6f8de41fdadeadc9773821e0a727).jar", "Readme - T41/Readme - T41 (Cugel@T41) (0.0.1) (CLDC-1.0, MIDP-1.0) (nl.t41.midlet.readme.Main) (6847ae78ed5a35676f251f370584ccaaebee8a496080580abd5a22292c0ed425).jar", "Readme - T41/Readme - T41 (Cugel@T41) (0.0.1) (CLDC-1.0, MIDP-1.0) (nl.t41.midlet.readme.Main) (ac001c962b1dc5803c34333fbed1f7d86e23b1ca52be7a11d1419a7e89f41381).jar", "Readme - T41/Readme - T41 (Cugel@T41) (0.0.1) (CLDC-1.0, MIDP-1.0) (nl.t41.midlet.readme.Main) (ea019cb412a7cabf0de0a34df8f198c9610505b4750bf3e2b448f79ea172228d).jar"]);
const PAGE_SIZES = [5, 10, 20, 50];
let PAGE = PAGE_SIZES[0];
const WORKERS = 8;
// Sorting/refining needs metadata from record chunks spread across the archive.
// Use more concurrent reads than before (2) without fetching every chunk at once.
const SUMMARY_WORKERS = 6;
// Keep browser-side CSV exports bounded; users can refine very broad searches.
const EXPORT_MAX_RECORDS = 10000;
// Export is user-initiated: keep more record-shard requests in flight than
// ordinary result pages, but avoid an unbounded flood on slower connections.
const EXPORT_WORKERS = 8;
// Retain only completed CSV rows, never whole record shards. This makes a
// repeat export (or an overlapping refined export) inexpensive in memory.
const EXPORT_CACHED_ROWS = EXPORT_MAX_RECORDS;
const MAX_CACHED_SEARCH_SHARDS = 12;
// Read the search-only index settings from data/manifest.json.
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
let manifest, searchMode = 'name', active = [], currentPage = 1, generation = 0;
let searchGramPromise = null;
let labelsForMatches = new Map();
// Each name-search match also remembers the name shard that supplied it.
let summaryShardsForMatches = new Map();
// Remember completed queries without retaining all parsed name shards.
const recentNameSearches = new Map();
const MAX_RECENT_NAME_SEARCHES = 5;
let pageRequestId = 0;
const recordsCache = new Map(), detailsCache = new Map(), hashesCache = new Map(), namesCache = new Map();

const upstreamShardCache = new Map();
const miniShardCache = new Map();
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
// Localized @-operator errors contain a {help} placeholder. Insert a real
// link safely, without parsing translated strings as HTML.
const OPERATOR_HELP_MARKER = '\uE000';
function operatorErrorText() {
  return t('searchOperatorInvalid', {help: OPERATOR_HELP_MARKER});
}
function showOperatorHelp(target, message) {
  const parts = message.split(OPERATOR_HELP_MARKER);
  if (parts.length !== 2) {
    // An old cached locale may lack the placeholder: keep a usable link.
    target.textContent = message;
    target.append(' ', operatorHelpLink());
    return;
  }
  target.replaceChildren(parts[0], operatorHelpLink(), parts[1]);
}
function operatorHelpLink() {
  const link = elem('a', t('searchHelpLink'));
  link.href = './html/search-help.html';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}
function urlFor(collection, archivePath) {
  if (collection === 2) {
    // In the index, a mini source path begins with its 7z package name.
    const match = /^([^/]+\.7z)\/(.+)$/s.exec(archivePath);
    if (!match) return '';
    try {
      const encode = value => encodeURIComponent(value).replace(/[!'()*]/g,
        ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
      return MINI_IA + encode(match[1]) + '/' + encode(match[2]);
    } catch (_) {
      // Invalid legacy filename Unicode must not break the entire results UI.
      return '';
    }
  }
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
      // Always revalidate generated index assets after a deployment. Otherwise
      // a cached v1 manifest can overwrite the v2 count, and mixed-version
      // name/record shards can point to incorrect record IDs.
      response = await fetch(url, {cache: 'no-cache'});
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
    summaryShardsForMatches = new Map(remembered.summaryShards);
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
  for (let shardIndex = 0; shardIndex < found.length; shardIndex++) {
    const batch = found[shardIndex];
    for (const [label, id, kind] of batch) {
      ids.add(id);
      if (!summaryShardsForMatches.has(id)) summaryShardsForMatches.set(id, candidates[shardIndex]);
      const rank = nameMatchRank(query, label, kind);
      if (!bestRank.has(id) || rank < bestRank.get(id)) bestRank.set(id, rank);
      // Keep the original preferred label for card-title fallback; ranking
      // separately considers every matching label for the same record.
      const earlier = labelsForMatches.get(id);
      if (!earlier || kind < earlier[1]) labelsForMatches.set(id, [label, kind]);
    }
  }
  // Eight stable tiers avoid a full sort and preserve the previous order
  // between matches of equal relevance, even for very broad searches.
  const ranked = Array.from({length: 8}, () => []);
  for (const id of ids) ranked[bestRank.get(id)].push(id);
  const matches = ranked.flat();
  recentNameSearches.set(query, {ids: matches, labels: [...labelsForMatches],
    summaryShards: [...summaryShardsForMatches]});
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
    section.append(elem('h4', collection === 0 ? t('manifestLite') : collection === 1 ? t('manifestFull') : '96x65pixels mini manifest'));
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
  guide.href = './html/downloader-help.html';
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
// Load only the two-hex-digit SHA-1 bucket needed for this result.
// The manifest compiler has already escaped the entire 7z member path,
// including internal slashes, as Internet Archive expects.
async function miniMatchFor(sha1) {
  const hash = String(sha1).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error('Invalid mini SHA-1');
  const bucket = await memoized(miniShardCache, hash.slice(0, 2),
    () => readGzipJson(`mini/${hash.slice(0, 2)}.json.gz`), 12);
  const match = bucket[hash];
  if (!match) return null;
  if (!Array.isArray(match) || match.length !== 3 ||
      typeof match[0] !== 'string' || typeof match[1] !== 'string' ||
      typeof match[2] !== 'string') throw new Error('Invalid mini download mapping');
  return {label: '96x65pixels mini (' + match[0] + ')', path: match[1],
    url: MINI_IA + match[2]};
}
async function appendOptionalDownloads(sha1, sha256, hasOriginalSource, hasMiniSource, list) {
  // Fetch both independent optional sources concurrently. A failed lookup
  // must never remove existing Lite/Full/nnproject links.
  const [mini, upstream] = await Promise.all([
    miniMatchFor(sha1).catch(error => {
      console.warn('Optional mini archive link unavailable:', error);
      return null;
    }),
    hasOriginalSource ? upstreamMatchesFor(sha256).catch(error => {
      console.warn('Optional upstream download links unavailable:', error);
      return [];
    }) : Promise.resolve([])
  ]);
  if (!list.isConnected) return; // The search results could have changed.
  const links = [...(mini ? [mini] : []), ...upstream];
  const firstNumber = list.childElementCount + 1;
  list.append(...links.map((match, index) =>
    downloadSourceRow(firstNumber + index, match.label, match.path, match.url)));
  if (!mini && hasMiniSource)
    list.append(elem('p', '96x65pixels mini: direct link temporarily unavailable.', 'small'));
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
    if (info.schema_version !== 2 || info.unique_files !== manifest.unique_files ||
        info.record_chunk !== manifest.record_chunk ||
        !/^[0-9a-f]{64}$/.test(info.index_manifest_sha256) ||
        !/^[0-9a-f]{64}$/.test(info.records_sha256))
      throw new Error('Folder index and search index do not match. Rebuild data/folders/.');
    // Verify the byte-identical manifest used when record IDs were assigned.
    if (!crypto?.subtle) throw new Error('Folder index requires a secure origin (localhost or HTTPS).');
    const response = await fetch(ROOT + 'manifest.json', {cache: 'no-cache'});
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
// Verify only the rows about to become visible, against the current main index.
// The folder manifest also contains a full-record fingerprint checked in CI;
// per-row checks defend against stale/mixed assets at runtime without loading
// all ~620k main records just to open a folder.
function folderIndexMismatch() {
  return new Error(t('folderIndexOutdated'));
}
async function verifyFolderPage(entries, folder) {
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      if (!Array.isArray(entry) || entry.length !== 6) throw folderIndexMismatch();
      const [id, sha, title, vendor, version, bytes] = entry;
      if (!Number.isSafeInteger(id) || id < 0 || id >= manifest.unique_files ||
          typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha))
        throw folderIndexMismatch();
      const record = await recordById(id);
      if (!Array.isArray(record) || record[0] !== sha || record[2] !== bytes ||
          !Array.isArray(record[3]) || !Array.isArray(record[4]))
        throw folderIndexMismatch();
      const matchingSource = record[3].find(source =>
        typeof source[2] === 'string' &&
        source[2].slice(0, source[2].lastIndexOf('/')) === folder);
      if (!matchingSource || String(record[4][0] || matchingSource[1]) !== title ||
          String(record[4][1] || '') !== vendor ||
          String(record[4][2] || '') !== version)
        throw folderIndexMismatch();
    }
  };
  await Promise.all(Array.from({length: Math.min(SUMMARY_WORKERS, entries.length)}, worker));
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
      if (!Array.isArray(all)) throw new Error(t('folderInvalidMembers'));
      // Every group must contain the result which led us here. Detect stale
      // record-ID assignments even if the ordinary manifest was unchanged.
      if (!all.some(row => Array.isArray(row) && row[0] === id && row[1] === record[0]))
        throw folderIndexMismatch();
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
      const verifiedIds = new Set();
      let renderRequest = 0;
      const render = async () => {
        const tokenForRender = ++renderRequest;
        const q = filter.value.toLocaleLowerCase().trim();
        const matching = q ? members.filter(([,sha,title,vendor,version]) =>
          [sha,title,vendor,version].some(v => String(v || '').toLocaleLowerCase().includes(q))) : members;
        const page = matching.slice(0, visible);
        rows.replaceChildren(elem('p', t('folderLoading'), 'small'));
        more.hidden = true;
        try {
          const unverified = page.filter(row => !verifiedIds.has(row[0]));
          await verifyFolderPage(unverified, selected);
          unverified.forEach(row => verifiedIds.add(row[0]));
          if (token !== request || tokenForRender !== renderRequest || !card.isConnected) return;
          counter.textContent = t('folderCounter', {
            matching: fmt(matching.length), total: fmt(members.length)
          });
          rows.replaceChildren(...page.map(folderMemberRow));
          if (!matching.length) rows.append(elem('p', t('folderEmpty'), 'small'));
          more.hidden = visible >= matching.length;
        } catch (error) {
          if (token === request && tokenForRender === renderRequest && card.isConnected) {
            // Never show an unverified folder link.
            content.replaceChildren(elem('p', `${t('folderLoadError')} ${error.message}`, 'folder-error'));
            console.warn('Archive-folder entry verification failed:', error);
          }
        }
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
  // The download toggle is already expanded while optional links load, even
  // though its panel stays hidden. Close this folder for that state too.
  downloadToggle.addEventListener('click', () => {
    if (downloadToggle.getAttribute('aria-expanded') === 'true') collapse();
  });
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
    if (coll === 2) continue; // Mini links are added from the verified SHA-1 mapping.
    iaList.append(downloadSourceRow(iaList.childElementCount + 1,
      coll === 0 ? 'JARchive Lite' : 'JARchive Full',
      path, urlFor(coll, path)));

    if (coll === 0) {
      mirrorList.append(downloadSourceRow(mirrorList.childElementCount + 1,
        'nnproject (Lite)', path, upstreamMemberUrl(
          'https://f.nnproject.cc/jarchive/JARchiveLite_v11/', path)));
    } else if (coll === 1 && !NNPROJECT_FULL_MISSING.has(path)) {
      const mirrorUrl = upstreamMemberUrl('https://f.nnproject.cc/jarchive/JARchive_v11/', path);
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
      appendOptionalDownloads(sha1, sha256,
        sources.some(source => source[0] === 0 || source[0] === 1),
        sources.some(source => source[0] === 2), iaList).then(() => {
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
  // The CLI also supports Mini-only JARs through the published Mini lookup.
  // Offer the same recovery instructions for every record, regardless of source.
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
let originalResults = null, resultViewVersion = 0;
let appliedRefinement = '';
let exportBusy = false;
function resultTitle(id, record) {
  const match = labelsForMatches.get(id);
  return record[4][0] || (match && match[1] === 0 ? match[0] : record[3][0][1]);
}
function setResultControlsBusy(busy) {
  document.querySelectorAll('#result-tools input, #result-tools button, #result-tools select')
    .forEach(control => { control.disabled = busy; });
}
function resetResultTools() {
  originalResults = null; appliedRefinement = '';
  resultViewVersion++; pageRequestId++; currentPage = 1;
  $('result-tools').hidden = true;
  $('refine-query').value = ''; $('result-sort').value = 'default';
  $('export-status').textContent = '';
  $('export-csv').disabled = false;
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
   
  const sortRow = elem('div', undefined, 'result-sort-row');
  const sortControls = elem('div', undefined, 'result-sort-controls');
  sortControls.append(sortLabel, sort);
  const exportButton = elem('button', t('exportCsv'), 'export-csv');
  exportButton.id = 'export-csv'; exportButton.type = 'button';
  const exportStatus = elem('span', undefined, 'export-status');
  exportStatus.id = 'export-status'; exportStatus.setAttribute('role', 'status');
  exportStatus.setAttribute('aria-live', 'polite');
  sortRow.append(sortControls, exportButton);
  tools.append(form, sortRow, exportStatus);
  document.querySelector('.result-heading').after(tools);
  form.addEventListener('submit', event => { event.preventDefault(); applyResultTools(); });
  clear.addEventListener('click', () => { input.value = ''; applyResultTools(); });
  input.addEventListener('search', () => { if (!input.value) applyResultTools(); });
  sort.addEventListener('change', () => applyResultTools());
  exportButton.addEventListener('click', () => exportCurrentResults());
}
// Supplemental, name-shard-aligned metadata for fast first-time refinement and sorting.
// Its files contain compact metadata only, not the large records/download paths.
// Older deployments without data/search-summaries/ retain the original slow path.
const nameSummariesCache = new Map();
let searchSummaryCatalogPromise = null;
function searchSummaryCatalog() {
  if (!searchSummaryCatalogPromise) searchSummaryCatalogPromise = (async () => {
    const info = await readJson('search-summaries/manifest.json');
    if (info.schema_version !== 1 || info.unique_files !== manifest.unique_files ||
        info.record_chunk !== manifest.record_chunk ||
        info.names_chunks !== NAME_INDEX.chunks || info.names_grams !== NAME_INDEX.grams ||
        !/^[0-9a-f]{64}$/.test(info.index_manifest_sha256))
      throw new Error('Search summaries do not match the current name index. Rebuild data/search-summaries/.');
    // The supplemental index must refer to exactly the manifest used to assign IDs.
    if (typeof crypto === 'undefined' || !crypto.subtle)
      throw new Error('Search summaries require localhost or HTTPS.');
    const response = await fetchIndexWithRetry('manifest.json');
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hex !== info.index_manifest_sha256)
      throw new Error('Search summaries were built for a different index manifest.');
    return info;
  })().catch(error => {
    // The extra files are optional. Never break the existing search on a missing index.
    console.warn('[J2ME] Fast refinement index unavailable; using record shards:', error);
    return null;
  });
  return searchSummaryCatalogPromise;
}
function nameSummaryShard(shard) {
  return memoized(nameSummariesCache, shard, async () => {
    const rows = await readGzipJson(`search-summaries/${String(shard).padStart(3, '0')}.json.gz`);
    if (!Array.isArray(rows)) throw new Error('Invalid search summary shard');
    return new Map(rows.map(row => [row[0], row]));
  }, MAX_CACHED_SEARCH_SHARDS);
}
function resultSummaryFromCompact(id, compact) {
  const [, bytes, quick, filenames] = compact;
  const match = labelsForMatches.get(id);
  // Identical to resultTitle(), including fallback to the matching filename.
  const title = quick[0] || (match && match[1] === 0 ? match[0] : filenames[0]);
  const fields = [title, ...quick, ...filenames].map(value => String(value || '').toLowerCase());
  return {title, bytes, fields, quick};
}
async function prepareFastResultSummaries(state, current) {
  if (!state.ids.every(id => summaryShardsForMatches.has(id))) return false;
  if (!await searchSummaryCatalog()) return false;
  if (current !== generation || originalResults !== state) return true;
  const groups = new Map();
  for (const id of state.ids) {
    if (state.summaries.has(id)) continue;
    const shard = summaryShardsForMatches.get(id);
    if (!groups.has(shard)) groups.set(shard, []);
    groups.get(shard).push(id);
  }
  const batches = [...groups];
  let next = 0, completed = state.summaries.size;
  const worker = async () => {
    while (current === generation && originalResults === state) {
      const index = next++;
      if (index >= batches.length) return;
      const [shard, ids] = batches[index];
      const rows = await nameSummaryShard(shard);
      if (current !== generation || originalResults !== state) return;
      // Don't apply a partially valid shard: the legacy path can take over.
      for (const id of ids) if (!rows.has(id))
        throw new Error(`Missing search summary for ID ${id} (shard ${shard})`);
      for (const id of ids)
        state.summaries.set(id, resultSummaryFromCompact(id, rows.get(id)));
      completed += ids.length;
      status(t('preparingRefine', {done: fmt(completed), total: fmt(state.ids.length)}));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
  const outcomes = await Promise.allSettled(
    Array.from({length: Math.min(SUMMARY_WORKERS, batches.length)}, worker));
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed) throw failed.reason;
  if (current === generation && originalResults === state) state.ready = true;
  return true;
}
// Operator filters, ordinary refinement, and sorting all use the same compact
// metadata generated from records' [bytes, quick, filenames]. Never download
// full record shards just to evaluate @version, @vendor, @midp, @cldc or @size.
// The original record-shard fallback remains for missing/invalid compact data.
async function prepareResultSummaries(state, current) {
  if (state.ready) return;
  try {
    if (await prepareFastResultSummaries(state, current)) return;
  } catch (error) {
    console.warn('[J2ME] Fast summaries failed; falling back to records:', error);
  }
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
        state.summaries.set(id, {title, bytes: record[2], fields, quick: record[4]});
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
// @ operators are only recognized at the beginning of an unquoted token.
// Quoting an entire token ("@version=1.0") retains the old literal search.
// Never silently treat malformed @ tokens as regular search terms.
function parseSearchQuery(query) {
  const included = [], excluded = [], filters = [];
  const tokens = query.match(/(?:[^\s"]|"[^"]*")+/g) || [];
  for (const token of tokens) {
    const negative = token.startsWith('-') && token.length > 1;
    const raw = negative ? token.slice(1) : token;
    const quoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2;
    if (!quoted && raw.startsWith('@')) {
      if (negative) return {included, excluded, filters, error: true};
      const match = /^@(version|vendor|midp|cldc|size)(=|>|<)(.+)$/i.exec(raw);
      if (!match) return {included, excluded, filters, error: true};
      const field = match[1].toLowerCase(), operator = match[2];
      let value = match[3];
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
        value = value.slice(1, -1);
      else if (value.includes('"')) return {included, excluded, filters, error: true};
      value = value.trim().toLowerCase();
      if (!value || (field !== 'size' && operator !== '='))
        return {included, excluded, filters, error: true};
      if (field === 'size') {
        const sizeMatch = /^(\d+(?:\.\d+)?)(b|kb|mb|kib|mib)$/i.exec(value);
        if (!sizeMatch) return {included, excluded, filters, error: true};
        const factors = {b: 1, kb: 1000, mb: 1000000, kib: 1024, mib: 1048576};
        const bytes = Number(sizeMatch[1]) * factors[sizeMatch[2].toLowerCase()];
        if (!Number.isSafeInteger(bytes)) return {included, excluded, filters, error: true};
        filters.push({field, operator, value: bytes});
      } else {
        if (field === 'cldc' || field === 'midp')
          value = value.replace(new RegExp(`^${field}-`, 'i'), '');
        filters.push({field, operator, value});
      }
      continue;
    }
    const value = (quoted ? raw.slice(1, -1) : raw).toLowerCase();
    if (value) (negative ? excluded : included).push(value);
  }
  return {included, excluded, filters, error: false};
}
function matchesSearchFilter(summary, filter) {
  if (filter.field === 'size') {
    const a = summary.bytes, b = filter.value;
    return filter.operator === '=' ? a === b : filter.operator === '>' ? a > b : a < b;
  }
  const fieldIndex = {vendor: 1, version: 2, cldc: 3, midp: 4}[filter.field];
  const raw = String(summary.quick?.[fieldIndex] ?? '').trim().toLowerCase();
  const value = (filter.field === 'cldc' || filter.field === 'midp')
    ? raw.replace(new RegExp(`^${filter.field}-`, 'i'), '') : raw;
  // ? has one unambiguous meaning: this metadata field is absent.
  return filter.value === '?' ? !value : value === filter.value;
}
function selectResultIds(state, query, order, parsed = parseSearchQuery(query)) {
  if (parsed.error) throw new Error(t('searchOperatorInvalid', {help: t('searchHelpLink')}));
  const {included, excluded, filters} = parsed;
  let ids = included.length || excluded.length || filters.length ? state.ids.filter(id => {
    const summary = state.summaries.get(id), fields = summary.fields;
    return included.every(word => fields.some(field => field.includes(word))) &&
      excluded.every(word => fields.every(field => !field.includes(word))) &&
      filters.every(filter => matchesSearchFilter(summary, filter));
  }) : [...state.ids];
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
// Refinement is cumulative until Clear is pressed. The text field shows the
// full set of active constraints after each application, even when a user
// replaces its contents with just their next exclusion or @ filter.
function combinedRefinement(previous, input) {
  const next = input.trim();
  if (!next || !previous) return next;
  if (next === previous || next.startsWith(previous + ' ')) return next;
  // Deleting the last term from the displayed query deliberately relaxes it.
  if (previous.startsWith(next + ' ')) return next;
  return `${previous} ${next}`;
}
async function applyResultTools() {
  const state = originalResults;
  if (!state || state.busy) return;
  const current = generation;
  const query = combinedRefinement(appliedRefinement, $('refine-query').value);
  const order = $('result-sort').value;
  const parsed = parseSearchQuery(query);
  state.busy = true; setResultControlsBusy(true); setPaginationBusy(true);
  try {
    if (parsed.error) throw new Error(t('searchOperatorInvalid', {help: t('searchHelpLink')}));
    if (query || order !== 'default')
      await prepareResultSummaries(state, current);
    if (current !== generation || originalResults !== state) return;
    active = selectResultIds(state, query, order, parsed);
    appliedRefinement = query;
    $('refine-query').value = query;
    currentPage = 1; resultViewVersion++; pageRequestId++;
    $('export-status').textContent = '';
    $('results').replaceChildren(); updatePaginationButtons();
    status(query ? t('subsetCount', {count: fmt(active.length), total: fmt(state.ids.length)}) :
      t('matchingFiles', {count: fmt(active.length), pluralCount: active.length}));
    if (active.length) await renderPage(current, 1);
    else $('results').append(elem('div', t('noRefinedResults'), 'empty'));
  } catch (error) {
    if (current === generation && originalResults === state) {
      if (parsed.error) showOperatorHelp($('status'), t('refineError', {error: operatorErrorText()}));
      else status(t('refineError', {error: error.message}));
      console.error(error);
    }
  } finally {
    state.busy = false;
    if (current === generation && originalResults === state) {
      setResultControlsBusy(false); setPaginationBusy(false);
      $('export-csv').disabled = exportBusy;
    }
  }
}
// CSV needs archive paths and checksums absent from compact search summaries;
// fetch full record shards only for entries not already exported this session.
// One CSV row represents one unique file content, with all original archive
// locations in multiline cells. Spreadsheet formula-looking metadata is quoted
// as text so that untrusted manifest values never execute as formulas.
const EXPORT_COLUMNS = ['ID', 'Title', 'Vendor', 'Version', 'CLDC', 'MIDP',
  'Size (bytes)', 'CRC32', 'SHA-1', 'SHA-256', 'Collections',
  'Source filenames', 'Archive paths', 'Internet Archive URLs'];
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))
    text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
// Every ID has immutable contents within the published index. Cache a row only
// when its title is embedded in the record itself: title-less records may use
// a filename from the current search, which can vary between queries.
const exportRowCache = new Map();
function cachedExportRow(id) {
  if (!exportRowCache.has(id)) return null;
  const row = exportRowCache.get(id);
  exportRowCache.delete(id);
  exportRowCache.set(id, row);
  return row;
}
function rememberExportRow(id, record, row) {
  if (!record?.[4]?.[0]) return;
  exportRowCache.delete(id);
  exportRowCache.set(id, row);
  while (exportRowCache.size > EXPORT_CACHED_ROWS)
    exportRowCache.delete(exportRowCache.keys().next().value);
}
function exportRecordRow(id, record) {
  if (!Array.isArray(record) || record.length !== 5 || !Array.isArray(record[3]) ||
      !Array.isArray(record[4]) || !record[3].length)
    throw new Error(`Invalid record for CSV export: ${id}`);
  const [sha256, sha1, bytes, sources, quick] = record;
  const [title, vendor, version, cldc, midp] = quick;
  const locations = sources.map(source => {
    if (!Array.isArray(source) || (source[0] !== 0 && source[0] !== 1 && source[0] !== 2))
      throw new Error(`Invalid archive source for CSV export: ${id}`);
    return source;
  });
  const values = [id, title || resultTitle(id, record), vendor, version, cldc,
    midp, bytes, [...new Set(locations.map(source => String(source[3] || '').toUpperCase()).filter(Boolean))].join('\n'),
    sha1, sha256,
    [...new Set(locations.map(source => source[0] === 0 ? 'Lite' : source[0] === 1 ? 'Full' : '96x65pixels mini'))].join('\n'),
    locations.map(source => source[1]).join('\n'),
    locations.map(source => source[2]).join('\n'),
    locations.map(source => urlFor(source[0], source[2])).join('\n')];
  return values.map(csvCell).join(',');
}
async function exportCurrentResults() {
  const state = originalResults;
  if (!state || state.busy || exportBusy || !active.length) return;
  const output = $('export-status');
  if (active.length > EXPORT_MAX_RECORDS) {
    output.textContent = t('exportLimit', {limit: fmt(EXPORT_MAX_RECORDS)});
    return;
  }
  const current = generation, view = resultViewVersion;
  const ids = [...active]; // Snapshot the current refinement and sort order.
  const stillCurrent = () => current === generation && view === resultViewVersion && originalResults === state;
  const groups = new Map();
  const rows = new Array(ids.length);
  let done = 0;
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    const cached = cachedExportRow(id);
    if (cached !== null) {
      rows[index] = cached;
      done++;
      continue;
    }
    const chunk = Math.floor(id / manifest.record_chunk);
    if (!groups.has(chunk)) groups.set(chunk, []);
    groups.get(chunk).push([index, id]);
  }
  const batches = [...groups];
  let next = 0;
  exportBusy = true;
  $('export-csv').disabled = true;
  output.textContent = t('exportWorking', {done: 0, total: fmt(ids.length)});
  try {
    const worker = async () => {
      while (stillCurrent()) {
        const batch = batches[next++];
        if (!batch) return;
        const [chunk, entries] = batch;
        const records = await memoized(recordsCache, chunk,
          () => readGzipJson(`records/${String(chunk).padStart(4, '0')}.json.gz`), 12);
        if (!stillCurrent()) return;
        for (const [index, id] of entries) {
          const record = records[id % manifest.record_chunk];
          const row = exportRecordRow(id, record);
          rows[index] = row;
          rememberExportRow(id, record, row);
        }
        done += entries.length;
        output.textContent = t('exportWorking', {done: fmt(done), total: fmt(ids.length)});
      }
    };
    await Promise.all(Array.from({length: Math.min(EXPORT_WORKERS, batches.length)}, worker));
    if (!stillCurrent()) return;
    if (rows.some(row => row === undefined)) throw new Error('Incomplete CSV export');
    const csv = '\uFEFF' + EXPORT_COLUMNS.map(csvCell).join(',') + '\r\n' + rows.join('\r\n') + '\r\n';
    const blobUrl = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
    try {
      const link = elem('a');
      link.href = blobUrl;
      link.download = 'j2me-search-results.csv';
      document.body.append(link);
      link.click();
      link.remove();
    } finally {
      // Give the browser a chance to start the download before releasing the URL.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }
    output.textContent = t('exportReady', {count: fmt(ids.length)});
  } catch (error) {
    if (stillCurrent()) {
      output.textContent = t('exportError');
      console.error('[J2ME] CSV export failed:', error);
    }
  } finally {
    exportBusy = false;
    if (stillCurrent()) $('export-csv').disabled = Boolean(state.busy);
  }
}

// Page size defaults to five cards for slower connections and can be changed
// without fetching a new search index. Only the requested page's record chunks
// are loaded; sorting, refinement, and CSV still use the full matching ID set.
function paginationPages(total, current) {
  const selected = new Set([1, total]);
  if (total <= 7) {
    for (let page = 1; page <= total; page++) selected.add(page);
  } else {
    for (let page = Math.max(1, current - 2); page <= Math.min(total, current + 2); page++)
      selected.add(page);
  }
  const ordered = [...selected].sort((a, b) => a - b);
  const pages = [];
  for (let i = 0; i < ordered.length; i++) {
    if (i && ordered[i] - ordered[i - 1] > 1) pages.push(null);
    pages.push(ordered[i]);
  }
  return pages;
}
function setPaginationBusy(busy) {
  const nav = $('pagination-bottom');
  nav?.querySelectorAll?.('button, input, select').forEach(control => {
    control.disabled = busy || control.getAttribute('data-page-locked') === 'true';
  });
}
function navigateToPage(page, requestedSize = PAGE) {
  const current = generation, view = resultViewVersion;
  if (!PAGE_SIZES.includes(requestedSize) || !Number.isSafeInteger(page) ||
      page < 1 || page > Math.ceil(active.length / requestedSize)) return;
  renderPage(current, page, true, requestedSize).catch(error => {
    if (current !== generation || view !== resultViewVersion) return;
    status(t('pageLoadError'));
    console.error('[J2ME] Could not load result page:', error);
    updatePaginationButtons(); // Restore the current page and selected size.
  });
}
function promptForPage(total) {
  const input = window.prompt(`${t('pageJump')} (1–${fmt(total)})`, String(currentPage));
  if (input === null) return; // A cancelled prompt is not an error.
  const value = input.trim(), requested = Number(value);
  if (!value || !Number.isSafeInteger(requested) || requested < 1 || requested > total) {
    status(t('pageInvalid', {total: fmt(total)}));
    return;
  }
  navigateToPage(requested);
}
function updatePaginationButtons() {
  const nav = $('pagination-bottom');
  if (!nav) return;
  const total = Math.ceil(active.length / PAGE);
  nav.hidden = active.length === 0;
  if (nav.hidden) { nav.replaceChildren(); return; }
  nav.setAttribute('aria-label', t('pageNavigation'));
  const first = (currentPage - 1) * PAGE + 1;
  const last = Math.min(currentPage * PAGE, active.length);
  const range = elem('span', t('pageRange', {
    first: fmt(first), last: fmt(last), total: fmt(active.length)
  }), 'page-range');
  const buttons = elem('div', undefined, 'page-buttons');
  const button = (text, page, label, selected = false) => {
    const item = elem('button', text, selected ? 'is-current' : undefined);
    item.type = 'button'; item.disabled = selected;
    item.setAttribute('data-page-locked', String(selected));
    item.setAttribute('aria-label', label);
    if (selected) item.setAttribute('aria-current', 'page');
    item.addEventListener('click', () => navigateToPage(page));
    return item;
  };
  if (total > 1) {
    const previous = button(t('pagePrevious'), currentPage - 1, t('pagePrevious'));
    previous.disabled = currentPage === 1;
    previous.setAttribute('data-page-locked', String(currentPage === 1));
    buttons.append(previous);
    for (const page of paginationPages(total, currentPage)) {
      if (page === null) {
        const ellipsis = elem('button', '…', 'page-ellipsis');
        ellipsis.type = 'button';
        ellipsis.setAttribute('aria-label', t('pageJump'));
        ellipsis.setAttribute('title', t('pageJump'));
        ellipsis.addEventListener('click', () => promptForPage(total));
        buttons.append(ellipsis);
      } else {
        buttons.append(button(fmt(page), page,
          t('pageNumber', {page: fmt(page)}), page === currentPage));
      }
    }
    const next = button(t('pageNext'), currentPage + 1, t('pageNext'));
    next.disabled = currentPage === total;
    next.setAttribute('data-page-locked', String(currentPage === total));
    buttons.append(next);
  }
  const sizePicker = elem('div', undefined, 'page-size');
  const label = elem('label', t('pageSize'));
  label.htmlFor = 'page-size-select';
  const select = elem('select');
  select.id = label.htmlFor;
  for (const amount of PAGE_SIZES) {
    const option = elem('option', String(amount));
    option.value = String(amount);
    select.append(option);
  }
  select.value = String(PAGE);
  select.addEventListener('change', () => {
    const requestedSize = Number(select.value);
    if (!PAGE_SIZES.includes(requestedSize) || requestedSize === PAGE) return;
    // Keep the previously viewed position approximately in view.
    const newPage = Math.floor(((currentPage - 1) * PAGE) / requestedSize) + 1;
    navigateToPage(newPage, requestedSize);
  });
  sizePicker.append(label, select);
  nav.replaceChildren(range, buttons, sizePicker);
  if (originalResults?.busy) setPaginationBusy(true);
}
async function renderPage(current, requestedPage, scrollToResults = false, requestedSize = PAGE) {
  const view = resultViewVersion;
  const total = Math.ceil(active.length / requestedSize);
  if (current !== generation || !PAGE_SIZES.includes(requestedSize) ||
      !Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > total) return;
  const request = ++pageRequestId;
  setPaginationBusy(true);
  try {
    const first = (requestedPage - 1) * requestedSize;
    const ids = active.slice(first, first + requestedSize);
    const rows = await Promise.all(ids.map(recordById));
    if (current !== generation || view !== resultViewVersion || request !== pageRequestId) return;
    // Commit the new size and page together; failed requests never replace cards.
    const cards = rows.map((record, i) => renderResult(ids[i], record));
    PAGE = requestedSize;
    currentPage = requestedPage;
    $('results').replaceChildren(...cards);
    updatePaginationButtons();
    if (scrollToResults) {
      $('results').focus({preventScroll: true});
      $('results').scrollIntoView({block: 'start'});
    }
  } finally {
    if (current === generation && view === resultViewVersion && request === pageRequestId)
      setPaginationBusy(Boolean(originalResults?.busy));
  }
}

async function runSearch() {
  document.querySelector('.results-section').hidden = false;
  const current = ++generation;
  resetResultTools();
  const rawTerm = $('query').value.trim();
  const term = rawTerm;
  const textTerms = searchMode === 'name' ? parseSearchQuery(rawTerm) : null;
  // Use an included word/phrase to shortlist names, then check all metadata
  // for the remaining words and exclusions. A whole-index negative-only scan
  // would force hundreds of thousands of records to be downloaded.
  const anchor = textTerms?.included.find(word => Array.from(word).length >= 2);
  active = []; currentPage = 1;
  $('results').replaceChildren(); updatePaginationButtons();
  labelsForMatches = new Map(); summaryShardsForMatches = new Map();
  if (!manifest) { status(t('indexNotLoaded')); return; }
  if (!term) { status(t('enterSearchTerm')); return; }
  // Input mistakes are not network failures; keep them distinct from the
  // retryable error shown when an index shard or record cannot be loaded.
  const hashType = searchMode === 'name' ? null : detectHashType(term);
  const invalid = searchMode === 'name'
    ? (textTerms.error ? operatorErrorText() :
       !textTerms.included.length ? t('searchHelpRequiresPositive') :
       !anchor ? t('enterName') : null)
    : (!hashType ? t('enterAnyHash') : null);
  if (invalid) {
    status(t('searchError'));
    const message = elem('div', undefined, 'empty');
    if (textTerms?.error) showOperatorHelp(message, invalid);
    else message.textContent = invalid;
    $('results').append(message);
    return;
  }
  $('search-form').querySelector('button').disabled = true;
  try {
    let ids = [];
    let preparedSummaries = null;
    if (searchMode === 'name') {
      ids = await searchNames(anchor, current);
      if (current !== generation) return;
      if (ids.length && (textTerms.included.length > 1 || textTerms.excluded.length || textTerms.filters.length)) {
        // Filter with exactly the same metadata rules as Search within results,
        // so 'prince -persia' agrees with searching 'prince' then refining.
        const initial = {ids, summaries: new Map(), ready: false, busy: false};
        originalResults = initial;
        await prepareResultSummaries(initial, current);
        if (current !== generation || originalResults !== initial) return;
        ids = selectResultIds(initial, term, 'default', textTerms);
        preparedSummaries = initial.summaries;
      }
    } else {
      if (hashType === 'crc32') {
        status(t('lookingUpCrc'));
        ids = await crc32Lookup(term);
      } else {
        const id = await exactHashLookup(hashType, term.toLowerCase());
        if (id !== undefined) ids = [id];
      }
    }
    if (current !== generation) return;
    active = ids; currentPage = 1;
    originalResults = {ids: [...ids], summaries: preparedSummaries || new Map(),
      ready: Boolean(preparedSummaries),
      busy: false};
    $('result-tools').hidden = ids.length === 0;
    setResultControlsBusy(false);
    if (!ids.length) {
      status(t('zeroMatching')); $('results').append(elem('div', t('noMatchingFiles'), 'empty')); return;
    }
    status(t('matchingFiles', {count: fmt(ids.length), pluralCount: ids.length}));
    await renderPage(current, 1);
  } catch (e) {
    if (current !== generation) return;
    // Never present an underlying browser exception (or a partial result set)
    // as if it were a successful search. The console retains the actual error.
    active = []; currentPage = 1; originalResults = null; pageRequestId++;
    $('result-tools').hidden = true;
    updatePaginationButtons();
    status(t('searchError'));
    const message = elem('div', undefined, 'empty');
    // An unsupported browser cannot fix missing gzip support by retrying.
    const unsupportedBrowser = e?.message === t('gzipRequired');
    message.append(elem('p', unsupportedBrowser ? t('gzipRequired') : t('searchLoadError')));
    if (!unsupportedBrowser) {
      const retry = elem('button', t('retrySearch'), 'search-retry');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        if (current === generation) runSearch();
      });
      message.append(retry);
    }
    $('results').replaceChildren(message);
    console.error('[J2ME] Search failed:', e);
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
