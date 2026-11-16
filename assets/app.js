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
// Separate search-only index. The main manifest is kept byte-identical
// for archive-folder verification and compatibility with older cached pages.
const NAME_INDEX = Object.freeze({
  chunks: 1024,
  grams: 'names-v2/grams.json.gz',
  directory: 'names-v2'
});
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
const FOLDER_UI = {
  "en": {
    other: "Other files",
    folders: "Archive folders",
    heading: "Files in archive folder",
    disclaimer: "These files share an archive folder; they are not necessarily versions of the same app.",
    filter: "Filter within this folder…",
    choose: "Archive folder",
    loading: "Loading folder contents…",
    empty: "No other matching files.",
    view: "View result",
    showMore: "Show more",
    loadError: "Could not load folder contents:",
    counter: "{matching} of {total} other files",
  },
  "de": {
    other: "Weitere Dateien",
    folders: "Archivordner",
    heading: "Dateien im Archivordner",
    disclaimer: "Diese Dateien liegen im selben Archivordner. Sie sind nicht unbedingt verschiedene Versionen derselben Anwendung.",
    filter: "In diesem Ordner filtern…",
    choose: "Archivordner",
    loading: "Ordnerinhalt wird geladen…",
    empty: "Keine weiteren passenden Dateien.",
    view: "Ergebnis öffnen",
    showMore: "Mehr anzeigen",
    loadError: "Ordnerinhalt konnte nicht geladen werden:",
    counter: "{matching} von {total} weiteren Dateien",
  },
  "es": {
    other: "Otros archivos",
    folders: "Carpetas del archivo",
    heading: "Archivos de la carpeta",
    disclaimer: "Estos archivos están en la misma carpeta del archivo, pero no tienen por qué ser versiones de la misma aplicación.",
    filter: "Filtrar en esta carpeta…",
    choose: "Carpeta del archivo",
    loading: "Cargando contenido de la carpeta…",
    empty: "No hay otros archivos que coincidan.",
    view: "Ver resultado",
    showMore: "Mostrar más",
    loadError: "No se pudo cargar el contenido de la carpeta:",
    counter: "{matching} de {total} archivos adicionales",
  },
  "pt-BR": {
    other: "Outros arquivos",
    folders: "Pastas do acervo",
    heading: "Arquivos na pasta do acervo",
    disclaimer: "Estes arquivos estão na mesma pasta do acervo, mas não são necessariamente versões do mesmo aplicativo.",
    filter: "Filtrar nesta pasta…",
    choose: "Pasta do acervo",
    loading: "Carregando conteúdo da pasta…",
    empty: "Nenhum outro arquivo correspondente.",
    view: "Ver resultado",
    showMore: "Mostrar mais",
    loadError: "Não foi possível carregar o conteúdo da pasta:",
    counter: "{matching} de {total} outros arquivos",
  },
  "ru": {
    other: "Другие файлы",
    folders: "Папки архива",
    heading: "Файлы в папке архива",
    disclaimer: "Эти файлы находятся в одной папке архива, но не обязательно являются версиями одного приложения.",
    filter: "Поиск в этой папке…",
    choose: "Папка архива",
    loading: "Загрузка содержимого папки…",
    empty: "Других подходящих файлов нет.",
    view: "Открыть результат",
    showMore: "Показать ещё",
    loadError: "Не удалось загрузить содержимое папки:",
    counter: "{matching} из {total} других файлов",
  },
  "id": {
    other: "File lain",
    folders: "Folder arsip",
    heading: "File dalam folder arsip",
    disclaimer: "File-file ini berada dalam folder arsip yang sama, tetapi belum tentu merupakan versi dari aplikasi yang sama.",
    filter: "Filter dalam folder ini…",
    choose: "Folder arsip",
    loading: "Memuat isi folder…",
    empty: "Tidak ada file lain yang cocok.",
    view: "Lihat hasil",
    showMore: "Tampilkan lainnya",
    loadError: "Tidak dapat memuat isi folder:",
    counter: "{matching} dari {total} file lainnya",
  },
  "zh-CN": {
    other: "其他文件",
    folders: "归档文件夹",
    heading: "归档文件夹中的文件",
    disclaimer: "这些文件位于同一个归档文件夹，但不一定是同一应用的不同版本。",
    filter: "在此文件夹中筛选…",
    choose: "归档文件夹",
    loading: "正在加载文件夹内容…",
    empty: "没有其他符合条件的文件。",
    view: "查看结果",
    showMore: "显示更多",
    loadError: "无法加载文件夹内容：",
    counter: "其他 {total} 个文件中有 {matching} 个符合条件",
  },
  "pl": {
    other: "Inne pliki",
    folders: "Foldery archiwum",
    heading: "Pliki w folderze archiwum",
    disclaimer: "Te pliki znajdują się w tym samym folderze archiwum, ale niekoniecznie są wersjami tej samej aplikacji.",
    filter: "Filtruj w tym folderze…",
    choose: "Folder archiwum",
    loading: "Wczytywanie zawartości folderu…",
    empty: "Brak innych pasujących plików.",
    view: "Zobacz wynik",
    showMore: "Pokaż więcej",
    loadError: "Nie udało się wczytać zawartości folderu:",
    counter: "{matching} z {total} innych plików",
  },
  "vi": {
    other: "Tệp khác",
    folders: "Thư mục lưu trữ",
    heading: "Tệp trong thư mục lưu trữ",
    disclaimer: "Các tệp này nằm trong cùng một thư mục lưu trữ nhưng không nhất thiết là các phiên bản của cùng một ứng dụng.",
    filter: "Lọc trong thư mục này…",
    choose: "Thư mục lưu trữ",
    loading: "Đang tải nội dung thư mục…",
    empty: "Không có tệp phù hợp nào khác.",
    view: "Xem kết quả",
    showMore: "Hiển thị thêm",
    loadError: "Không thể tải nội dung thư mục:",
    counter: "{matching} / {total} tệp khác",
  },
  "fr": {
    other: "Autres fichiers",
    folders: "Dossiers de l’archive",
    heading: "Fichiers du dossier d’archive",
    disclaimer: "Ces fichiers se trouvent dans le même dossier d’archive, mais ne sont pas nécessairement des versions de la même application.",
    filter: "Filtrer dans ce dossier…",
    choose: "Dossier d’archive",
    loading: "Chargement du dossier…",
    empty: "Aucun autre fichier correspondant.",
    view: "Voir le résultat",
    showMore: "Afficher plus",
    loadError: "Impossible de charger le contenu du dossier :",
    counter: "{matching} sur {total} autres fichiers",
  },
  "tr": {
    other: "Diğer dosyalar",
    folders: "Arşiv klasörleri",
    heading: "Arşiv klasöründeki dosyalar",
    disclaimer: "Bu dosyalar aynı arşiv klasöründedir ancak aynı uygulamanın farklı sürümleri olmak zorunda değildir.",
    filter: "Bu klasörde filtrele…",
    choose: "Arşiv klasörü",
    loading: "Klasör içeriği yükleniyor…",
    empty: "Eşleşen başka dosya yok.",
    view: "Sonucu görüntüle",
    showMore: "Daha fazla göster",
    loadError: "Klasör içeriği yüklenemedi:",
    counter: "{total} diğer dosyadan {matching} tanesi",
  },
  "it": {
    other: "Altri file",
    folders: "Cartelle dell’archivio",
    heading: "File nella cartella dell’archivio",
    disclaimer: "Questi file si trovano nella stessa cartella dell’archivio, ma non sono necessariamente versioni della stessa applicazione.",
    filter: "Filtra in questa cartella…",
    choose: "Cartella dell’archivio",
    loading: "Caricamento del contenuto della cartella…",
    empty: "Nessun altro file corrispondente.",
    view: "Visualizza risultato",
    showMore: "Mostra altri",
    loadError: "Impossibile caricare il contenuto della cartella:",
    counter: "{matching} di {total} altri file",
  },
  "uk": {
    other: "Інші файли",
    folders: "Папки архіву",
    heading: "Файли в папці архіву",
    disclaimer: "Ці файли містяться в одній папці архіву, але не обов’язково є версіями тієї самої програми.",
    filter: "Фільтрувати в цій папці…",
    choose: "Папка архіву",
    loading: "Завантаження вмісту папки…",
    empty: "Інших відповідних файлів немає.",
    view: "Переглянути результат",
    showMore: "Показати більше",
    loadError: "Не вдалося завантажити вміст папки:",
    counter: "{matching} із {total} інших файлів",
  },
  "th": {
    other: "ไฟล์อื่น",
    folders: "โฟลเดอร์ในคลัง",
    heading: "ไฟล์ในโฟลเดอร์ของคลัง",
    disclaimer: "ไฟล์เหล่านี้อยู่ในโฟลเดอร์เดียวกันของคลัง แต่ไม่จำเป็นต้องเป็นเวอร์ชันของแอปเดียวกัน",
    filter: "กรองไฟล์ในโฟลเดอร์นี้…",
    choose: "โฟลเดอร์ในคลัง",
    loading: "กำลังโหลดไฟล์ในโฟลเดอร์…",
    empty: "ไม่พบไฟล์อื่นที่ตรงเงื่อนไข",
    view: "ดูผลลัพธ์",
    showMore: "แสดงเพิ่มเติม",
    loadError: "ไม่สามารถโหลดไฟล์ในโฟลเดอร์ได้:",
    counter: "ตรงเงื่อนไข {matching} จาก {total} ไฟล์อื่น",
  },
  "cs": {
    other: "Další soubory",
    folders: "Složky archivu",
    heading: "Soubory ve složce archivu",
    disclaimer: "Tyto soubory jsou ve stejné složce archivu, ale nemusí jít o různé verze téže aplikace.",
    filter: "Filtrovat v této složce…",
    choose: "Složka archivu",
    loading: "Načítání obsahu složky…",
    empty: "Žádné další odpovídající soubory.",
    view: "Zobrazit výsledek",
    showMore: "Zobrazit více",
    loadError: "Obsah složky se nepodařilo načíst:",
    counter: "{matching} z {total} dalších souborů",
  },
  "zh-TW": {
    other: "其他檔案",
    folders: "封存資料夾",
    heading: "封存資料夾中的檔案",
    disclaimer: "這些檔案位於同一個封存資料夾，但不一定是同一應用程式的不同版本。",
    filter: "篩選此資料夾中的檔案…",
    choose: "封存資料夾",
    loading: "正在載入資料夾內容…",
    empty: "沒有其他符合條件的檔案。",
    view: "檢視結果",
    showMore: "顯示更多",
    loadError: "無法載入資料夾內容：",
    counter: "其他 {total} 個檔案中有 {matching} 個符合條件",
  },
  "ro": {
    other: "Alte fișiere",
    folders: "Folderele arhivei",
    heading: "Fișiere din folderul arhivei",
    disclaimer: "Aceste fișiere se află în același folder al arhivei, dar nu sunt neapărat versiuni ale aceleiași aplicații.",
    filter: "Filtrează în acest folder…",
    choose: "Folderul arhivei",
    loading: "Se încarcă fișierele din folder…",
    empty: "Nu există alte fișiere potrivite.",
    view: "Vezi rezultatul",
    showMore: "Afișează mai multe",
    loadError: "Nu s-au putut încărca fișierele din folder:",
    counter: "{matching} din {total} alte fișiere",
  },
  "hi": {
    other: "अन्य फ़ाइलें",
    folders: "संग्रह के फ़ोल्डर",
    heading: "संग्रह के फ़ोल्डर में फ़ाइलें",
    disclaimer: "ये फ़ाइलें संग्रह के एक ही फ़ोल्डर में हैं, लेकिन ज़रूरी नहीं कि ये एक ही ऐप के अलग-अलग संस्करण हों।",
    filter: "इस फ़ोल्डर में फ़िल्टर करें…",
    choose: "संग्रह का फ़ोल्डर",
    loading: "फ़ोल्डर की सामग्री लोड हो रही है…",
    empty: "कोई अन्य मेल खाती फ़ाइल नहीं।",
    view: "परिणाम देखें",
    showMore: "और दिखाएँ",
    loadError: "फ़ोल्डर की सामग्री लोड नहीं हो सकी:",
    counter: "{total} अन्य फ़ाइलों में से {matching}",
  },
  "ja": {
    other: "ほかのファイル",
    folders: "アーカイブ内のフォルダー",
    heading: "アーカイブフォルダー内のファイル",
    disclaimer: "これらのファイルは同じアーカイブフォルダーにありますが、必ずしも同じアプリの別バージョンとは限りません。",
    filter: "このフォルダー内を絞り込む…",
    choose: "アーカイブフォルダー",
    loading: "フォルダーの内容を読み込み中…",
    empty: "一致するほかのファイルはありません。",
    view: "検索結果を見る",
    showMore: "さらに表示",
    loadError: "フォルダーの内容を読み込めませんでした：",
    counter: "ほかの {total} 件中 {matching} 件",
  },
  "ko": {
    other: "다른 파일",
    folders: "보관 폴더",
    heading: "보관 폴더의 파일",
    disclaimer: "이 파일들은 같은 보관 폴더에 있지만 반드시 동일한 앱의 다른 버전인 것은 아닙니다.",
    filter: "이 폴더에서 필터링…",
    choose: "보관 폴더",
    loading: "폴더 내용 불러오는 중…",
    empty: "일치하는 다른 파일이 없습니다.",
    view: "결과 보기",
    showMore: "더 보기",
    loadError: "폴더 내용을 불러올 수 없습니다:",
    counter: "다른 파일 {total}개 중 {matching}개",
  },
  "nl": {
    other: "Andere bestanden",
    folders: "Archiefmappen",
    heading: "Bestanden in archiefmap",
    disclaimer: "Deze bestanden staan in dezelfde archiefmap, maar zijn niet noodzakelijk verschillende versies van dezelfde app.",
    filter: "Filter binnen deze map…",
    choose: "Archiefmap",
    loading: "Mapinhoud laden…",
    empty: "Geen andere overeenkomende bestanden.",
    view: "Resultaat bekijken",
    showMore: "Meer tonen",
    loadError: "Kan mapinhoud niet laden:",
    counter: "{matching} van {total} andere bestanden",
  },
  "ms": {
    other: "Fail lain",
    folders: "Folder arkib",
    heading: "Fail dalam folder arkib",
    disclaimer: "Fail ini berada dalam folder arkib yang sama, tetapi tidak semestinya versi berlainan bagi aplikasi yang sama.",
    filter: "Tapis dalam folder ini…",
    choose: "Folder arkib",
    loading: "Memuatkan kandungan folder…",
    empty: "Tiada fail lain yang sepadan.",
    view: "Lihat hasil",
    showMore: "Tunjukkan lagi",
    loadError: "Tidak dapat memuatkan kandungan folder:",
    counter: "{matching} daripada {total} fail lain",
  },
};
function folderT(key) {
  return (FOLDER_UI[document.documentElement.lang] || FOLDER_UI.en)[key];
}
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
  const link = elem('a', folderT('view'), 'folder-file-link');
  const url = new URL(location.href);
  url.searchParams.set('sha256', sha);
  link.href = url.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `${folderT('view')}: ${title}`);
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
    ? `${folderT('other')} · ${fmt(groups[0].count - 1)}`
    : `${folderT('folders')} · ${fmt(groups.length)}`;
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
  panel.append(elem('p', folderT('disclaimer'), 'folder-disclaimer'));
  if (groups.length > 1) {
    const choice = elem('div', undefined, 'folder-choice');
    const label = elem('label', folderT('choose'));
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
    panel.append(elem('div', `${folderT('heading')}: ${activeGroup}`, 'folder-title'));
  }
  panel.append(content);

  async function loadFolder() {
    const selected = activeGroup;
    const token = ++request;
    content.replaceChildren(elem('p', folderT('loading'), 'small'));
    try {
      const all = await folderEntries(selected);
      if (token !== request || !card.isConnected) return;
      if (!Array.isArray(all)) throw new Error('Invalid folder member list');
      // The current result is already visible; don't repeat it in the list.
      const members = all.filter(row => row[0] !== id);
      const tools = elem('div', undefined, 'folder-tools');
      const filter = elem('input');
      filter.type = 'search'; filter.placeholder = folderT('filter');
      filter.setAttribute('aria-label', folderT('filter'));
      const counter = elem('span', undefined, 'folder-counter');
      tools.append(filter, counter);
      const rows = elem('div', undefined, 'folder-files');
      const more = elem('button', folderT('showMore'), 'folder-more');
      more.type = 'button';
      let visible = FOLDER_PAGE_SIZE;
      const render = () => {
        const q = filter.value.toLocaleLowerCase().trim();
        const matching = q ? members.filter(([,sha,title,vendor,version]) =>
          [sha,title,vendor,version].some(v => String(v || '').toLocaleLowerCase().includes(q))) : members;
        counter.textContent = folderT('counter')
          .replace('{matching}', fmt(matching.length))
          .replace('{total}', fmt(members.length));
        rows.replaceChildren(...matching.slice(0, visible).map(folderMemberRow));
        if (!matching.length) rows.append(elem('p', folderT('empty'), 'small'));
        more.hidden = visible >= matching.length;
      };
      filter.addEventListener('input', () => { visible = FOLDER_PAGE_SIZE; render(); });
      more.addEventListener('click', () => { visible += FOLDER_PAGE_SIZE; render(); });
      content.replaceChildren(tools, rows, more);
      render();
    } catch (error) {
      if (token === request && card.isConnected)
        content.replaceChildren(elem('p', `${folderT('loadError')} ${error.message}`, 'folder-error'));
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
  // The existing translated heading includes a parenthesized source name;
  // remove it for the generic disclosure label without changing locale files.
  const downloadLabel = t('downloadLinks').replace(/\s*[（(][^()（）]*[）)]\s*$/u, '').trim();
  const downloadToggle = elem('button', downloadLabel, 'download-toggle');
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

  // Reuse each locale's existing source description, omitting the redundant
  // 'Download links (...)' prefix in the expanded panel.
  const sourceHeading = key => {
    const translated = t(key);
    const match = translated.match(/[（(]([^()（）]+)[）)]\s*$/u);
    return match ? match[1].trim() : translated;
  };
  const iaHeading = sourceHeading('downloadLinks');
  downloadPanel.append(
    elem('h4', document.documentElement.lang === 'en' && iaHeading === 'Internet Archive'
      ? 'Internet archive' : iaHeading, 'download-heading'),
    iaList
  );

  if (mirrorList.childElementCount) {
    const mirrors = elem('div', undefined, 'download-mirror-group');
    mirrors.append(
      elem('h4', sourceHeading('downloadLinksOtherMirrors'), 'download-heading'),
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
// Localized "Show all" label (all supported interface languages).
const SHOW_ALL_LABELS = {
  en:'Show all', de:'Alle anzeigen', es:'Mostrar todo', 'pt-BR':'Mostrar tudo',
  ru:'Показать все', id:'Tampilkan semua', 'zh-CN':'显示全部', pl:'Pokaż wszystkie',
  vi:'Hiển thị tất cả', fr:'Tout afficher', tr:'Tümünü göster', it:'Mostra tutti',
  uk:'Показати всі', th:'แสดงทั้งหมด', cs:'Zobrazit vše', 'zh-TW':'顯示全部',
  ro:'Afișează tot', hi:'सभी दिखाएँ', ja:'すべて表示', ko:'모두 보기',
  nl:'Alles tonen', ms:'Papar semua'
};
function updatePaginationButtons() {
  const remaining = Math.max(0, active.length - shown);
  const more = $('more'), all = $('show-all');
  more.hidden = all.hidden = remaining === 0;
  more.textContent = t('moreRemaining', {count: fmt(remaining)});
  const lang = $('language-select')?.value || 'en';
  all.textContent = `${SHOW_ALL_LABELS[lang] || SHOW_ALL_LABELS.en} (${fmt(remaining)})`;
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
    } else if (searchMode === 'crc32') {
      if (!/^[0-9a-f]{8}$/i.test(term)) throw new Error(t('enterCrc'));
      status(t('lookingUpCrc'));
      ids = await crc32Lookup(term);
    } else {
      const re = searchMode === 'sha1' ? /^[0-9a-f]{40}$/i : /^[0-9a-f]{64}$/i;
      if (!re.test(term)) throw new Error(t('enterExactHash', {hash: searchMode.toUpperCase()}));
      const id = await exactHashLookup(searchMode, term.toLowerCase());
      if (id !== undefined) ids = [id];
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
async function init() {
  await I18N.init();
  installResultTools();
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    searchMode = button.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(b => {
      b.classList.toggle('active', b === button);
      b.setAttribute('aria-pressed', b === button ? 'true' : 'false');
    });
    $('query').placeholder = searchMode === 'name' ? t('queryPlaceholder') :
      searchMode === 'crc32' ? t('queryPlaceholderCrc') :
      searchMode === 'sha1' ? t('queryPlaceholderSha1') : t('queryPlaceholderSha256');
    $('hint').textContent = searchMode === 'name' ?
      t('hintName') :
      searchMode === 'crc32' ? t('hintCrc') :
      t('hintHash', {hash: searchMode.toUpperCase()});
    $('query').focus();
  }));
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
    manifest = await readJson('manifest.json');
    if (manifest.schema_version !== 4) throw new Error(t('schemaMismatch'));
    $('unique-count').textContent = fmt(manifest.unique_files);
    if ($('entries-count')) $('entries-count').textContent = fmt(manifest.total_rows);
    if ($('shared-count')) $('shared-count').textContent = fmt(manifest.shared_files);
    // Open a specific group member in a separate tab by its stable SHA-256.
    const linkedSha = new URLSearchParams(location.search).get('sha256');
    if (linkedSha && /^[0-9a-f]{64}$/i.test(linkedSha)) {
      document.querySelector('[data-mode="sha256"]').click();
      $('query').value = linkedSha.toLowerCase();
      await runSearch();
    }
  } catch (e) {
    status(t('searchIndexUnavailable')); $('results').replaceChildren(elem('div', e.message, 'empty'));
  }
}
init();
