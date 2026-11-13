'use strict';
// New J2ME Software Archive Search v4: no external JS dependencies.
const $ = id => document.getElementById(id);
const ROOT = './data/';
const I18N = window.J2ME_I18N;
const t = (key, vars) => I18N.t(key, vars);
const IA = 'https://archive.org/download/96x65pixels_j2me/';
const ARCHIVES = ['JARchiveLite_v11.7z', 'JARchive_v11.7z'];
const PAGE = 20;
const WORKERS = 8;
const MAX_CACHED_SEARCH_SHARDS = 12;
let manifest, searchMode = 'name', active = [], shown = 0, generation = 0;
let searchGramPromise = null;
let labelsForMatches = new Map();
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
async function readJson(path) {
  const response = await fetch(ROOT + path);
  if (!response.ok) throw new Error(t('loadFailed', {path, status: response.status}));
  return response.json();
}
async function readGzipJson(path) {
  const response = await fetch(ROOT + path);
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
  if (!searchGramPromise) searchGramPromise = readGzipJson(manifest.names_grams).catch(e => { searchGramPromise = null; throw e; });
  return searchGramPromise;
}
function candidateNameShards(query, maps) {
  const chars = Array.from(query);
  const length = chars.length >= 3 ? 3 : 2;
  const grams = maps[String(length)];
  let bits = (1n << BigInt(manifest.names_chunks)) - 1n;
  for (let i = 0; i <= chars.length - length; i++) {
    const value = grams[chars.slice(i, i + length).join('')];
    if (!value) return [];
    bits &= BigInt('0x' + value);
    if (bits === 0n) return [];
  }
  const shards = [];
  for (let i = 0; i < manifest.names_chunks; i++)
    if (bits & (1n << BigInt(i))) shards.push(i);
  return shards;
}
function nameShard(i) {
  return memoized(namesCache, i,
    () => readGzipJson(`names/${String(i).padStart(3, '0')}.json.gz`), MAX_CACHED_SEARCH_SHARDS);
}
async function searchNames(query, current) {
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
      status(t('searchingNames', {done: fmt(++completed), total: fmt(candidates.length)}));
    }
  });
  await Promise.all(workers);
  if (current !== generation) return [];
  const ids = new Set();
  for (const batch of found) for (const [label, id, kind] of batch) {
    ids.add(id);
    const earlier = labelsForMatches.get(id);
    if (!earlier || kind < earlier[1]) labelsForMatches.set(id, [label, kind]);
  }
  return [...ids];
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
    for (const match of matches) {
      list.append(downloadSourceRow(list.childElementCount + 1,
        match.label, match.path, match.url));
    }
  } catch (error) {
    // Optional upstream URLs must not affect primary links or CLI fallback.
    console.warn('Optional upstream download links unavailable:', error);
  }
}

// END upstream direct download sources (v1)

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
    }
  }

  downloadSection.append(
    elem('h4', t('downloadLinks'), 'download-heading'),
    iaList
  );

  if (mirrorList.childElementCount) {
    const mirrors = elem('div', undefined, 'download-mirror-group');
    mirrors.append(
      elem('h4', t('downloadLinksOtherMirrors'), 'download-heading'),
      mirrorList
    );
    downloadSection.append(mirrors);
  }

  card.append(downloadSection, fallbackDownloadAction(sha256));
  appendUpstreamDownloads(sha256, iaList);
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
  // Place metadata control after the download command buttons.
  const manifestAction = elem('div', undefined, 'metadata-action');
  manifestAction.append(more);
  card.querySelector('.fallback-actions').append(manifestAction);
  card.append(body);
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
  const outcomes = await Promise.allSettled(Array.from({length: Math.min(2, batches.length)}, worker));
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
  state.busy = true; setResultControlsBusy(true); $('more').disabled = true;
  try {
    if (query || order !== 'default') await prepareResultSummaries(state, current);
    if (current !== generation || originalResults !== state) return;
    active = selectResultIds(state, query, order); shown = 0; resultViewVersion++;
    $('results').replaceChildren(); $('more').hidden = true;
    status(query ? t('subsetCount', {count: fmt(active.length), total: fmt(state.ids.length)}) :
      t('matchingFiles', {count: fmt(active.length), pluralCount: active.length}));
    if (active.length) await renderMore(current);
    else $('results').append(elem('div', t('noRefinedResults'), 'empty'));
  } catch (error) {
    if (current === generation && originalResults === state) {
      status(t('refineError', {error: error.message})); console.error(error);
    }
  } finally {
    state.busy = false;
    if (current === generation && originalResults === state) {
      setResultControlsBusy(false); $('more').disabled = false;
    }
  }
}
async function renderMore(current) {
  const view = resultViewVersion;
  if (current !== generation || moreLoadingVersion === view) return;
  const button = $('more'); button.disabled = true; moreLoadingVersion = view;
  try {
    const ids = active.slice(shown, Math.min(shown + PAGE, active.length));
    const results = await Promise.all(ids.map(recordById));
    if (current !== generation || view !== resultViewVersion) return;
    results.forEach((rec, i) => $('results').append(renderResult(ids[i], rec)));
    shown += ids.length; button.hidden = shown >= active.length;
    button.textContent = t('moreRemaining', {count: fmt(active.length - shown)});
  } finally {
    if (moreLoadingVersion === view) moreLoadingVersion = null;
    if (current === generation && view === resultViewVersion) button.disabled = Boolean(originalResults && originalResults.busy);
  }
}

async function runSearch() {
  document.querySelector('.results-section').hidden = false;
  const current = ++generation;
  resetResultTools();
  const term = $('query').value.trim();
  $('results').replaceChildren(); $('more').hidden = true; labelsForMatches = new Map();
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
    await renderMore(current);
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
  $('search-form').addEventListener('submit', e => { e.preventDefault(); runSearch(); });
  $('more').addEventListener('click', () => renderMore(generation).catch(e => {
    status(t('loadMoreError')); console.error(e);
  }));
  try {
    manifest = await readJson('manifest.json');
    if (manifest.schema_version !== 4) throw new Error(t('schemaMismatch'));
    $('unique-count').textContent = fmt(manifest.unique_files);
    if ($('entries-count')) $('entries-count').textContent = fmt(manifest.total_rows);
    if ($('shared-count')) $('shared-count').textContent = fmt(manifest.shared_files);
  } catch (e) {
    status(t('searchIndexUnavailable')); $('results').replaceChildren(elem('div', e.message, 'empty'));
  }
}
init();
