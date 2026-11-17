'use strict';
// Small regression tests for the existing browser app, using Node's built-in test runner.
// The real app initializes a DOM on load; here we omit only its final init() call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.resolve(__dirname, '../assets/app.js');
const original = fs.readFileSync(filename, 'utf8');
assert.match(original, /\binit\(\);\s*$/, 'Expected the app to initialize at the end of app.js');
const withoutStartup = original.replace(/\binit\(\);\s*$/, '');

// These UI tests must also run on the source-only ZIP, which has no data/.
// Generated index consistency is tested separately by check_repo/check_index.
const TEST_MANIFEST = Object.freeze({
  schema_version: 4, record_chunk: 4096, unique_files: 620287,
  names_chunks: 256, names_grams: 'names-v2/grams.json.gz'
});

function loadApp() {
  const context = vm.createContext({
    window: {J2ME_I18N: {
      t: (key, vars = {}) => key === 'loadFailed'
        ? `Unable to load ${vars.path} (HTTP ${vars.status})` : key,
      numberLocale: () => 'en-US'
    }},
    document: {getElementById: () => ({textContent: ''})},
    console: {log() {}, info() {}, warn() {}, error() {}},
    setTimeout: callback => callback() // Skip real retry waits in tests.
  });
  vm.runInContext(withoutStartup, context, {filename});
  const run = expression => vm.runInContext(expression, context);
  return {context, run};
}

test('archive paths are encoded as ONE URL member, including slashes and symbols', () => {
  const {run} = loadApp();
  const result = run("urlFor(1, 'Games/João & friends (v1)! #%.jar')");
  assert.equal(result,
    'https://archive.org/download/96x65pixels_j2me/JARchive_v11.7z/' +
    'Games%2FJo%C3%A3o%20%26%20friends%20%28v1%29%21%20%23%25.jar');
});

test('gram intersection selects only relevant name shards', () => {
  const {run} = loadApp();
  run("NAME_INDEX = nameIndexConfig({names_chunks: 4, names_grams: 'names-v2/grams.json.gz'})");
  assert.deepEqual(Array.from(run("candidateNameShards('abcd', {'3': {abc: '3', bcd: '2'}})")), [1]);
  assert.deepEqual(Array.from(run("candidateNameShards('abcz', {'3': {abc: '3'}})")), []);
});

test('name shard count and paths follow manifest settings, not hardcoded defaults', async () => {
  const {run, context} = loadApp();
  context.config = TEST_MANIFEST;
  // Verify the expected manifest configuration is accepted.
  assert.equal(run('nameIndexConfig(config).chunks'), context.config.names_chunks);
  assert.equal(run('nameIndexConfig(config).grams'), context.config.names_grams);
  // A hypothetical future build changes both the shard count and directory.
  run("NAME_INDEX = nameIndexConfig({names_chunks: 4, names_grams: 'search/next/grams.json.gz'})");
  context.requestedPaths = [];
  run('readGzipJson = async path => { requestedPaths.push(path); return {}; };');
  await run('gramMap()');
  await run('nameShard(3)');
  assert.deepEqual(context.requestedPaths, ['search/next/grams.json.gz', 'search/next/003.json.gz']);
  assert.deepEqual(Array.from(run("candidateNameShards('abc', {'3': {abc: 'f'}})")), [0, 1, 2, 3]);
  assert.throws(() => run("nameIndexConfig({names_chunks: 0, names_grams: 'search/grams.json.gz'})"), /schemaMismatch/);
  assert.throws(() => run("nameIndexConfig({names_chunks: 4, names_grams: '../grams.json.gz'})"), /schemaMismatch/);
});

test('name search deduplicates IDs, remembers labels, and reuses cached results', async () => {
  const {run} = loadApp();
  run(`NAME_INDEX = nameIndexConfig({names_chunks: 2, names_grams: 'names-v2/grams.json.gz'});
       gramMap = async () => ({'3': {son: '3'}});
       nameShard = async i => i === 0
         ? [['sonic', 5, 1], ['panasonic', 7, 2]]
         : [['sonic', 5, 0], ['sonar', 9, 0]];`);
  const first = await run("searchNames('son', 0)");
  assert.deepEqual(Array.from(first), [5, 9, 7]);
  assert.equal(run('labelsForMatches.get(5)[1]'), 0, 'Preferred label kind should win');
  run('gramMap = async () => { throw Error("cache miss"); };');
  const second = await run("searchNames('son', 0)");
  assert.deepEqual(Array.from(second), [5, 9, 7]);
});

test('text results rank exact, prefix, word-start, substring, and vendor-only hits', async () => {
  const {run} = loadApp();
  run(`NAME_INDEX = nameIndexConfig({names_chunks: 1, names_grams: 'names-v2/grams.json.gz'});
       gramMap = async () => ({'3': {son: '1', oni: '1', nic: '1'}});
       nameShard = async () => [
         ['panasonic', 11, 0],     // Inside a filename word.
         ['sonic studio', 22, 2],  // Vendor prefix, below filename hits.
         ['the sonic game', 33, 1],
         ['sonic adventure', 44, 1],
         ['sonic.jar', 55, 0],      // Exact filename without extension.
         ['sonic', 66, 1],          // Exact MIDlet title.
         ['sonic', 77, 2],          // Exact vendor still follows filenames.
         ['megasonic', 88, 0],
         ['panasonic sonic', 99, 0], // Later occurrence starts a word.
         ['sonic', 11, 1]          // Same file: title outranks filename substring.
       ];`);
  const ids = await run("searchNames('sonic', 0)");
  assert.deepEqual(Array.from(ids), [11, 55, 66, 44, 33, 99, 88, 77, 22]);
  // Default result tools must retain the relevance ordering without requiring summaries.
  run('originalResults = {ids: [...recentNameSearches.get("sonic").ids], summaries: new Map()};');
  assert.deepEqual(Array.from(run("selectResultIds(originalResults, '', 'default')")), Array.from(ids));
});

test('Unicode word boundaries distinguish whole words from embedded matches', () => {
  const {run} = loadApp();
  assert.equal(run("nameMatchRank('sonic', '🚀sonic', 0)"), 2);
  assert.equal(run("nameMatchRank('sonic', '界sonic', 0)"), 3);
  assert.equal(run("nameMatchRank('sonic', '漢字 sonic', 0)"), 2);
  assert.equal(run("nameMatchRank('sonic', 'panasonic sonic', 0)"), 2);
  assert.equal(run("nameMatchRank('sonic.jar', 'sonic.jar', 0)"), 0);
});

test('CRC32 collision lookup returns every distinct matching record ID', async () => {
  const {run, context} = loadApp();
  context.buckets = {'crc32/d.json.gz': {deadbeef: [10, 20]}};
  run('readGzipJson = async path => buckets[path] ?? {};');
  assert.deepEqual(Array.from(await run("crc32Lookup('DEADBEEF')")), [10, 20]);
});

test('SHA-256 lookup returns the matching record or undefined', async () => {
  const {run, context} = loadApp();
  const sha = 'a'.repeat(64);
  context.testHash = sha;
  context.buckets = {'sha256/a.json.gz': {[sha]: 42}};
  run('readGzipJson = async path => buckets[path] ?? {};');
  assert.equal(await run("exactHashLookup('sha256', testHash)"), 42);
  assert.equal(await run("exactHashLookup('sha256', 'b'.repeat(64))"), undefined);
});

test('refinement checks all words while explicit sorting respects file size', () => {
  const {run} = loadApp();
  const results = run(`selectResultIds({
    ids: [3, 1, 2],
    summaries: new Map([
      [3, {title: 'Racing', bytes: 900, fields: ['racing', 'studio']}],
      [1, {title: 'Sonic', bytes: 300, fields: ['sonic', 'sega']}],
      [2, {title: 'Sonic 2', bytes: 600, fields: ['sonic 2', 'sega']}]
    ])
  }, 'sonic sega', 'size-desc')`);
  assert.deepEqual(Array.from(results), [2, 1]);
});

test('refinement exclusions work with inclusion, Unicode, and original ordering', () => {
  const {run} = loadApp();
  run(`let sample = {
    ids: [10, 20, 30, 40, 50],
    summaries: new Map([
      [10, {title: 'Sonic', bytes: 90, fields: ['sonic', 'sega', 'cldc-1.1']}],
      [20, {title: 'Panasonic', bytes: 20, fields: ['panasonic', 'sonic', 'cldc-1.0']}],
      [30, {title: 'Sonic demo', bytes: 70, fields: ['sonic demo', 'sega']}],
      [40, {title: 'Pokémon', bytes: 30, fields: ['pokémon', 'nintendo']}],
      [50, {title: 'Соник', bytes: 10, fields: ['соник', 'разработчик']}]
    ])
  };`);
  const ids = (q, sort = 'default') => Array.from(run(`selectResultIds(sample, ${JSON.stringify(q)}, ${JSON.stringify(sort)})`));
  assert.deepEqual(ids(''), [10, 20, 30, 40, 50]);
  assert.deepEqual(ids('sonic sega'), [10, 30], 'Existing all-words behavior remains');
  assert.deepEqual(ids('sonic -panasonic'), [10, 30]);
  assert.deepEqual(ids('-panasonic -demo'), [10, 40, 50], 'Exclusions alone are supported');
  assert.deepEqual(ids('sonic -panasonic -demo'), [10]);
  assert.deepEqual(ids('sonic -panasonic', 'size-desc'), [10, 30], 'Explicit sorting still works');
  assert.deepEqual(ids('sonic -panasonic', 'size-asc'), [30, 10]);
  assert.deepEqual(ids('cLdC-1.1'), [10], 'Hyphens inside a word are not an exclusion operator');
  assert.deepEqual(ids('  СОНиК  -РАЗРАБОТЧИК  '), [], 'Unicode exclusions ignore case');
  assert.deepEqual(ids('POKÉMON'), [40], 'Accents are preserved while matching Latin letters');
  assert.deepEqual(ids('Pokémon -DEMO'), [40], 'Unicode include terms work case-insensitively');
  assert.deepEqual(ids('СОНИК -sega'), [50], 'Cyrillic inclusion also works');
  assert.deepEqual(ids('sonic -sonic'), [], 'Exclusions win if both terms match');
  assert.deepEqual(ids('-trial -demo', 'title-asc'), [20, 40, 10, 50]);
  assert.deepEqual(Array.from(run('sample.ids')), [10, 20, 30, 40, 50], 'Original results never mutate');
});

test('quoted refinements match contiguous phrases within the same metadata field', () => {
  const {run} = loadApp();
  run(`let phraseSample = {
    ids: [1, 2, 3, 4, 5, 6, 7],
    summaries: new Map([
      [1, {title: 'Test Game', bytes: 120, fields: ['test game deluxe', 'sega']}],
      [2, {title: 'Separated', bytes: 40, fields: ['test', 'game', 'test big game']}],
      [3, {title: 'Prefix', bytes: 80, fields: ['a test game v2']}],
      [4, {title: 'Joined', bytes: 60, fields: ['testgame']}],
      [5, {title: 'Split fields', bytes: 30, fields: ['foo test', 'game bar']}],
      [6, {title: 'Demo', bytes: 140, fields: ['demo of test game']}],
      [7, {title: 'Accented', bytes: 20, fields: ['tést game']}]
    ])
  };`);
  const ids = (q, sort = 'default') => Array.from(run(
    `selectResultIds(phraseSample, ${JSON.stringify(q)}, ${JSON.stringify(sort)})`));
  assert.deepEqual(ids('test game'), [1, 2, 3, 4, 5, 6],
    'Unquoted words may match separately and across fields');
  assert.deepEqual(ids('"test game"'), [1, 3, 6],
    'Quoted text is case-insensitive and contiguous within one field');
  assert.deepEqual(ids('"test game" -demo'), [1, 3]);
  assert.deepEqual(ids('-"test game"'), [2, 4, 5, 7], 'Negated phrases work alone');
  assert.deepEqual(ids('test -"test game"'), [2, 4, 5], 'Words can mix with negated phrases');
  assert.deepEqual(ids('"test game"', 'size-desc'), [6, 1, 3]);
  assert.deepEqual(ids('"tést game"'), [7], 'Accented phrases retain their characters');
  assert.deepEqual(ids('"test  game"'), [], 'Spaces within quotes are literal');
  assert.deepEqual(Array.from(run('phraseSample.ids')), [1, 2, 3, 4, 5, 6, 7]);
});

test('main Text search uses inclusion/exclusion metadata rules consistently with refinement', async () => {
  const {run, context} = loadApp();
  const {nodes} = startupTestDom(context);
  nodes.set('result-tools', {hidden: true});
  nodes.get('search-form').querySelector = () => ({disabled: false});
  run(`manifest = {record_chunk: 4096};
       searchMode = 'name';
       resetResultTools = () => {};
       setResultControlsBusy = () => {};
       let searched = [];
       searchNames = async anchor => { searched.push(anchor); return anchor === 'prince of persia' ? [1] : [1, 2, 3, 4]; };
       prepareResultSummaries = async (state) => {
         state.summaries = new Map([
           [1, {title:'Prince of Persia', bytes:50, fields:['prince of persia']}],
           [2, {title:'Prince Adventure', bytes:40, fields:['prince adventure', 'studio']}],
           [3, {title:'Prince of the World', bytes:30, fields:['prince of the world', 'persia studios']}],
           [4, {title:'Prince Persia Demo', bytes:20, fields:['prince persia demo']}]
         ]);
         state.ready = true;
       };
       renderMore = async () => {};`);
  nodes.get('query').value = 'prince -persia';
  await run('runSearch()');
  assert.deepEqual(Array.from(run('active')), [2]);
  assert.deepEqual(Array.from(run('selectResultIds({ids:[1,2,3,4],summaries:originalResults.summaries}, "-persia", "default")')), [2],
    'Main exclusions and result refinements must return the same subset');
  assert.deepEqual(Array.from(run('searched')), ['prince']);
  nodes.get('query').value = 'prince of persia';
  await run('runSearch()');
  assert.deepEqual(Array.from(run('active')), [1, 3], 'Unquoted words can match across metadata fields');
  nodes.get('query').value = '"prince of persia"';
  await run('runSearch()');
  assert.equal(run('searched[2]'), 'prince of persia', 'Quoted search is an exact substring');
  assert.deepEqual(Array.from(run('active')), [1],
    'Quoted phrases use exact contiguous substring matching');
  // Negative-only searches must fail fast rather than loading the entire 620k-record index.
  nodes.get('query').value = '-persia';
  await run('runSearch()');
  assert.equal(run('searched.length'), 3);
  assert.match(nodes.get('results').children[0].textContent, /Include at least one/);
});

test('main search leaves simple single-term queries on the fast shard path', async () => {
  const {run, context} = loadApp();
  const {nodes} = startupTestDom(context);
  nodes.set('result-tools', {hidden: true});
  nodes.get('search-form').querySelector = () => ({disabled: false});
  run(`manifest = {record_chunk: 4096};
       searchMode = 'name';
       resetResultTools = () => {};
       setResultControlsBusy = () => {};
       searchNames = async anchor => { if(anchor !== 'sonic') throw Error('Bad anchor'); return [4, 2]; };
       prepareResultSummaries = async () => { throw Error('Simple query should not fetch every summary'); };
       renderMore = async () => {};`);
  nodes.get('query').value = 'sonic';
  await run('runSearch()');
  assert.deepEqual(Array.from(run('active')), [4, 2]);
});

test('Search help link appears beneath the main form, not in the result tools', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  const searchStart = html.indexOf('<section class="search"');
  const resultsStart = html.indexOf('<section class="results-section"');
  const linkStart = html.indexOf('id="search-help-link"');
  assert.ok(linkStart > searchStart && linkStart < resultsStart,
    'Search help is shown with the main search form before any results load');
  assert.match(html, /id="search-help-link"[^>]+href="\.\/html\/search-help\.html"/);
  assert.match(html, /id="search-help-link"[^>]+target="_blank"/);
  assert.match(html, /id="search-help-link"[^>]+data-i18n="searchHelpLink"/);
  const {run, context} = loadApp();
  const find = downloadTestDom(context);
  context.document.querySelector = selector => selector === '.result-heading'
    ? {after(node) {context.resultTools = node;}} : null;
  run('installResultTools()');
  const sortRow = find(context.resultTools, 'result-sort-row');
  assert.equal(sortRow.children.length, 1, 'Sort row only contains sorting controls');
  assert.equal(sortRow.children[0].className, 'result-sort-controls');
  assert.equal(find(context.resultTools, 'refine-help-link'), null,
    'The old refinement-specific help link is gone');
});

test('full downloader guide link uses the local styled HTML page', () => {
  const {run} = loadApp();
  const script = fs.readFileSync(path.resolve(__dirname, '../assets/app.js'), 'utf8');
  assert.match(script, /guide\.href = '\.\/html\/downloader-help\.html'/);
  const page = fs.readFileSync(path.resolve(__dirname, '../html/downloader-help.html'), 'utf8');
  assert.match(page, /data-i18n-title="downloaderGuideTitle"/);
  assert.match(page, /id="errors-and-troubleshooting"/);
});

test('sorting metadata reads up to six record chunks concurrently and caches summaries', async () => {
  const {run} = loadApp();
  run(`manifest = {record_chunk: 4};
       originalResults = {
         ids: [0, 4, 8, 12, 16, 20, 24, 28, 32],
         summaries: new Map(), ready: false, busy: false
       };
       let openReads = 0, peakReads = 0, totalReads = 0;
       readGzipJson = async () => {
         openReads++; totalReads++;
         peakReads = Math.max(peakReads, openReads);
         await Promise.resolve();
         openReads--;
         return Array.from({length: 4}, () =>
           ['sha256', 'sha1', 123, [[0, 'example.jar', 'example.jar', 'crc']],
            ['Example', 'Example Studio', '', '', '']]);
       };`);
  await run('prepareResultSummaries(originalResults, generation)');
  assert.equal(run('peakReads'), 6, 'Limit concurrent metadata chunk reads');
  assert.equal(run('totalReads'), 9, 'Read each needed chunk once');
  assert.equal(run('originalResults.ready'), true);
  assert.equal(run('originalResults.summaries.size'), 9);
  // Changing the sort order for the same search must not reload metadata.
  await run('prepareResultSummaries(originalResults, generation)');
  assert.equal(run('totalReads'), 9);
});

test('temporary HTTP 503 is retried; permanent HTTP 404 is not', async () => {
  const {run, context} = loadApp();
  const requested = [];
  const makeResponse = (status) => ({ok: status === 200, status, headers: {get: () => null}});
  const responses = [makeResponse(503), makeResponse(200)];
  context.fetch = async (url) => { requested.push(url); return responses.shift(); };
  assert.equal((await run("fetchIndexWithRetry('manifest.json')")).status, 200);
  assert.deepEqual(requested, ['./data/manifest.json', './data/manifest.json']);

  requested.length = 0;
  context.fetch = async (url) => { requested.push(url); return makeResponse(404); };
  await assert.rejects(run("fetchIndexWithRetry('missing.json')"), /HTTP 404/);
  assert.deepEqual(requested, ['./data/missing.json']);
});

// Minimal DOM for the real download disclosure handler, without a browser dependency.
function downloadTestDom(context) {
  function makeElement(tag) {
    const attrs = new Map();
    const listeners = new Map();
    return {
      tagName: tag, className: '', value: '', children: [], hidden: false, isConnected: true,
      append(...nodes) { this.children.push(...nodes); },
      insertBefore(node, reference) {
        const at = this.children.indexOf(reference);
        if (at < 0) this.children.push(node);
        else this.children.splice(at, 0, node);
      },
      querySelector(selector) {
        const wanted = selector.startsWith('.') ? selector.slice(1) : selector;
        return find(this, wanted);
      },
      hasChildNodes() { return this.children.length !== 0; },
      replaceChildren(...nodes) { this.children = nodes; },
      setAttribute(key, value) { attrs.set(key, String(value)); },
      getAttribute(key) { return attrs.get(key) ?? null; },
      removeAttribute(key) { attrs.delete(key); },
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      click() { for (const handler of listeners.get('click') || []) handler(); },
      get childElementCount() { return this.children.filter(x => x?.tagName).length; }
    };
  }
  context.document.createElement = makeElement;
  context.document.createTextNode = text => ({nodeType: 3, textContent: text});
  context.document.documentElement = {lang: 'en'};
  function find(root, className) {
    if (root.className === className) return root;
    for (const child of root.children || []) {
      const matched = find(child, className);
      if (matched) return matched;
    }
    return null;
  }
  return find;
}

const testRecord = `[
  '${'a'.repeat(64)}', '${'b'.repeat(40)}', 3072,
  [[0, 'Sonic.jar', 'Games/Sonic.jar', '1234ABCD']],
  ['Sonic', 'Publisher', '1.0', 'CLDC-1.1', 'MIDP-2.0']
]`;

test('download disclosure reveals all links at once after the optional lookup', async () => {
  const {run, context} = loadApp();
  const find = downloadTestDom(context);
  run(`addFolderBrowser = async () => {};
       let upstreamCalls = 0;
       let finishUpstream;
       upstreamMatchesFor = () => {
         upstreamCalls++;
         return new Promise(resolve => { finishUpstream = resolve; });
       };`);
  const card = run(`renderResult(42, ${testRecord})`);
  const toggle = find(card, 'download-toggle');
  const panel = find(card, 'download-panel');
  const archiveLinks = find(card, 'download-list');
  assert.ok(toggle && panel && archiveLinks);
  assert.equal(panel.hidden, true);
  assert.equal(archiveLinks.childElementCount, 1, 'Primary link exists before opening');
  assert.equal(run('upstreamCalls'), 0, 'Rendering does not start optional requests');

  toggle.click();
  assert.equal(run('upstreamCalls'), 1);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-busy'), 'true');
  assert.equal(panel.hidden, true, 'Do not reveal only the primary links');
  assert.equal(archiveLinks.childElementCount, 1);
  run(`finishUpstream([
    {label: 'Historical mirror', path: 'Archive/Sonic.jar', url: 'https://example.org/a'},
    {label: 'Second mirror', path: 'Sonic.jar', url: 'https://example.org/b'}
  ])`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(archiveLinks.childElementCount, 3, 'Both optional rows are ready');
  assert.equal(archiveLinks.children[1].children[0].textContent, '2');
  assert.equal(archiveLinks.children[2].children[0].textContent, '3');
  assert.equal(panel.hidden, false, 'Reveal the complete panel together');
  assert.equal(toggle.getAttribute('aria-busy'), null);

  toggle.click(); // Collapse.
  assert.equal(panel.hidden, true);
  toggle.click(); // Reopen without any lookup.
  assert.equal(panel.hidden, false);
  assert.equal(run('upstreamCalls'), 1, 'Reopening does not repeat the lookup');
  assert.equal(archiveLinks.childElementCount, 3, 'No duplicate download links');
});

test('closing while loading prevents a late reveal, and errors still show primary links', async () => {
  const {run, context} = loadApp();
  const find = downloadTestDom(context);
  run(`addFolderBrowser = async () => {};
       let calls = 0;
       let finishUpstream;
       upstreamMatchesFor = () => {
         calls++;
         return new Promise(resolve => { finishUpstream = resolve; });
       };`);
  const card = run(`renderResult(43, ${testRecord})`);
  const toggle = find(card, 'download-toggle');
  const panel = find(card, 'download-panel');
  toggle.click(); // Start loading.
  toggle.click(); // Cancel the expansion during loading.
  assert.equal(toggle.getAttribute('aria-busy'), null);
  run('finishUpstream([])');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.hidden, true, 'Do not reopen a panel the visitor closed');
  toggle.click();
  assert.equal(panel.hidden, false, 'After loading, opening is immediate');
  assert.equal(run('calls'), 1);

  // A failed optional lookup must not hide the primary link indefinitely.
  run(`upstreamMatchesFor = async () => { throw new Error('Optional source offline'); };`);
  const errorCard = run(`renderResult(44, ${testRecord})`);
  const errorToggle = find(errorCard, 'download-toggle');
  const errorPanel = find(errorCard, 'download-panel');
  errorToggle.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errorPanel.hidden, false);
  assert.equal(find(errorCard, 'download-list').childElementCount, 1);
  assert.equal(errorToggle.getAttribute('aria-busy'), null);
});

test('opening downloads during mirror loading closes the expanded folder browser', async () => {
  const {run, context} = loadApp();
  const find = downloadTestDom(context);
  run(`folderCatalog = async () => new Map([['Games', 2]]);
       // Keep the folder contents pending; only the disclosure state matters.
       folderEntries = () => new Promise(() => {});
       let finishUpstream;
       upstreamMatchesFor = () => new Promise(resolve => { finishUpstream = resolve; });`);
  const card = run(`renderResult(42, ${testRecord})`);
  // addFolderBrowser inserts the button after awaiting the optional catalog.
  await new Promise(resolve => setImmediate(resolve));
  const folderToggle = find(card, 'folder-toggle');
  const folderPanel = find(card, 'folder-panel');
  const downloadToggle = find(card, 'download-toggle');
  const downloadPanel = find(card, 'download-panel');
  assert.ok(folderToggle && folderPanel && downloadToggle && downloadPanel);

  folderToggle.click();
  assert.equal(folderToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(folderPanel.hidden, false);

  downloadToggle.click(); // First click: mirror lookup is still pending.
  assert.equal(downloadToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(downloadToggle.getAttribute('aria-busy'), 'true');
  assert.equal(downloadPanel.hidden, true, 'Download links wait for mirrors');
  assert.equal(folderToggle.getAttribute('aria-expanded'), 'false',
    'Opening downloads must collapse Other files even while loading');
  assert.equal(folderPanel.hidden, true);

  run('finishUpstream([])');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(downloadPanel.hidden, false);
  assert.equal(folderPanel.hidden, true, 'Only the requested disclosure remains open');
});

test('localized download headings and Show all use the locale files', () => {
  for (const [lang, expected] of Object.entries({
    en: ['Download links', 'Internet archive', 'Other mirrors', 'Show all (3)'],
    de: ['Downloadlinks', 'Internet Archive', 'andere Mirrors', 'Alle anzeigen (3)'],
    'zh-TW': ['下載連結', 'Internet Archive', '其他鏡像站', '顯示全部 (3)']
  })) {
    const dictionary = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, `../assets/locales/${lang}.json`), 'utf8'));
    const {run, context} = loadApp();
    const find = downloadTestDom(context);
    context.document.documentElement.lang = lang;
    context.window.J2ME_I18N.t = (key, vars = {}) => {
      const message = dictionary[key] || key;
      if (typeof message !== 'string') return key;
      return message.replace(/\{(\w+)\}/g, (whole, name) =>
        Object.hasOwn(vars, name) ? String(vars[name]) : whole);
    };
    run('addFolderBrowser = async () => {};');
    const card = run(`renderResult(42, ${testRecord})`);
    const toggle = find(card, 'download-toggle');
    const panel = find(card, 'download-panel');
    const headings = panel.children.filter(x => x?.className === 'download-heading' ||
      x?.className === 'download-mirror-group').map(x =>
        x.className === 'download-mirror-group' ? x.children[0].textContent : x.textContent);
    assert.equal(toggle.textContent, expected[0], `Disclosure label (${lang})`);
    assert.deepEqual(headings, expected.slice(1, 3), `Source headings (${lang})`);

    const elements = new Map();
    context.document.getElementById = id => {
      if (!elements.has(id)) elements.set(id, {textContent: '', hidden: false});
      return elements.get(id);
    };
    run('active = [1, 2, 3, 4]; shown = 1; updatePaginationButtons()');
    assert.equal(elements.get('show-all').textContent, expected[3], `Show all (${lang})`);
  }
});

test('folder-browser text uses the same translation and interpolation functions', () => {
  const {run, context} = loadApp();
  const dictionary = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../assets/locales/zh-CN.json'), 'utf8'));
  context.window.J2ME_I18N.t = (key, vars = {}) =>
    String(dictionary[key] || key).replace(/\{(\w+)\}/g,
      (whole, name) => Object.hasOwn(vars, name) ? String(vars[name]) : whole);
  assert.equal(run("t('folderOther')"), '其他文件');
  assert.equal(run("t('folderView')"), '查看结果');
  assert.equal(run("t('folderCounter', {matching: '2', total: '10'})"),
    '其他 10 个文件中有 2 个符合条件');
});

test('updated locale files bypass stale browser caches and resolve migrated labels', async () => {
  const i18nSource = fs.readFileSync(path.resolve(__dirname, '../assets/i18n.js'), 'utf8');
  const homepage = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  const scriptRevision = homepage.match(/assets\/i18n\.js\?v=([^"&]+)/)?.[1];
  assert.ok(scriptRevision, 'The translation loader must have a versioned script URL');
  assert.match(homepage, new RegExp(`assets/app\\.js\\?v=${scriptRevision}`),
    'The app and translation loader should be published with the same asset revision');

  for (const language of ['en', 'de']) {
    const fetched = [];
    const select = {setAttribute() {}, addEventListener() {}, replaceChildren() {}, value: ''};
    const context = vm.createContext({
      window: {},
      location: {search: `?lang=${language}`},
      URLSearchParams,
      Intl,
      localStorage: {getItem: () => null, setItem() {}},
      document: {
        documentElement: {lang: 'en'},
        title: '',
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: id => id === 'language-select' ? select : null,
        createElement: () => ({value: '', textContent: ''})
      },
      fetch: async (url, options) => {
        fetched.push({url, options});
        // Model a previously cached locale without Step 5 keys. An unversioned
        // fetch would return this stale payload and render raw translation keys.
        const localeFile = /assets\/locales\/([^/?]+)\.json/.exec(url)?.[1];
        const dictionary = JSON.parse(fs.readFileSync(
          path.resolve(__dirname, `../assets/locales/${localeFile}.json`), 'utf8'));
        if (!url.includes('?v=')) {
          delete dictionary.downloadToggle;
          delete dictionary.downloadHeadingInternetArchive;
          delete dictionary.showAllRemaining;
        }
        return {ok: true, json: async () => dictionary};
      }
    });
    vm.runInContext(i18nSource, context);
    await context.window.J2ME_I18N.init();
    const translations = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, `../assets/locales/${language}.json`), 'utf8'));
    const t = context.window.J2ME_I18N.t;
    assert.equal(t('downloadToggle'), translations.downloadToggle, language);
    assert.equal(t('downloadHeadingInternetArchive'), translations.downloadHeadingInternetArchive, language);
    assert.equal(t('downloadHeadingOtherMirrors'), translations.downloadHeadingOtherMirrors, language);
    assert.equal(t('showAllRemaining', {count: 3}), translations.showAllRemaining.replace('{count}', '3'), language);
    assert.equal(context.document.documentElement.lang, language);
    for (const request of fetched) {
      assert.equal(request.options.cache, 'no-cache', 'Locale files must be revalidated');
      assert.equal(new URL(request.url, 'https://example.org/').searchParams.get('v'),
        scriptRevision, 'Locale files must use the same revision as the loader script');
    }
    assert.equal(fetched.length, language === 'en' ? 2 : 3);
    assert.match(fetched[0].url, /assets\/locales\/languages\.json\?v=/);
  }
});

test('language catalog and locale dictionaries are the sole runtime sources for menus and metadata', async () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../assets/i18n.js'), 'utf8');
  const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../assets/locales/languages.json'), 'utf8'));
  const dictionaries = Object.fromEntries(['en', 'ja'].map(lang => [lang, JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../assets/locales/${lang}.json`), 'utf8'))]));
  const picker = {
    value: '', options: [],
    replaceChildren(...options) { this.options = options; },
    setAttribute(name, value) { this[name] = value; },
    addEventListener() {}
  };
  const description = {dataset: {i18nContent: 'searchHelpMetaDescription'}, content: ''};
  const brand = {dataset: {i18nAriaLabel: 'searchSection'},
    setAttribute(name, value) { this[name] = value; }};
  const context = vm.createContext({
    window: {}, location: {search: '?lang=ja'}, URLSearchParams, Intl,
    localStorage: {getItem: () => null, setItem() {}},
    document: {
      documentElement: {lang: 'en'}, title: '',
      querySelector: selector => selector === '[data-i18n-title]'
        ? {dataset: {i18nTitle: 'searchHelpLink'}} : null,
      querySelectorAll: selector => selector === '[data-i18n-content]'
        ? [description] : (selector === '[data-i18n-aria-label]' ? [brand] : []),
      getElementById: id => id === 'language-select' ? picker : null,
      createElement: () => ({value: '', textContent: ''})
    },
    fetch: async url => ({ok: true, json: async () => url.includes('/languages.json')
      ? catalog : (url.includes('/ja.json') ? dictionaries.ja : dictionaries.en)})
  });
  vm.runInContext(script, context);
  await context.window.J2ME_I18N.init();
  assert.equal(picker.options.length, catalog.length);
  assert.deepEqual(picker.options.map(option => option.value), catalog.map(item => item.code));
  assert.deepEqual(picker.options.map(option => option.textContent), catalog.map(item => item.name));
  assert.equal(picker.value, 'ja');
  assert.equal(context.window.J2ME_I18N.numberLocale(), 'ja-JP');
  assert.equal(context.document.title, dictionaries.ja.searchHelpLink);
  assert.equal(description.content, dictionaries.ja.searchHelpMetaDescription);
  assert.equal(brand['aria-label'], dictionaries.ja.searchSection);
});

test('both standalone help pages initialize localized content and language picker', async () => {
  const localization = fs.readFileSync(path.resolve(__dirname, '../assets/i18n.js'), 'utf8');
  const helpInit = fs.readFileSync(path.resolve(__dirname, '../assets/help.js'), 'utf8');
  const english = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../assets/locales/en.json'), 'utf8'));
  const german = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../assets/locales/de.json'), 'utf8'));
  for (const [page, titleKey] of [
    ['html/search-help.html', 'searchHelpLink'],
    ['html/downloader-help.html', 'downloaderGuideTitle']
  ]) {
    const markup = fs.readFileSync(path.resolve(__dirname, '../' + page), 'utf8');
    assert.match(markup, /\.\.\/assets\/help\.js\?v=/);
    assert.match(markup, new RegExp('data-i18n-title="' + titleKey + '"'));
    const title = {dataset: {i18n: titleKey}, textContent: 'English placeholder'};
    const notice = {dataset: {i18n: page.includes('downloader')
      ? 'downloaderGuideNotice' : 'searchHelpTextIntro'}, textContent: 'English placeholder'};
    const picker = {value: '', setAttribute() {}, addEventListener() {}, replaceChildren() {}};
    const context = vm.createContext({
      window: {}, location: {search: '?lang=de'}, URLSearchParams, Intl,
      localStorage: {getItem: () => null, setItem() {}},
      document: {
        documentElement: {lang: 'en'}, title: '',
        querySelector: selector => selector === '[data-i18n-title]'
          ? {dataset: {i18nTitle: titleKey}} : null,
        querySelectorAll: selector => selector === '[data-i18n]'
          ? [title, notice] : [],
        getElementById: id => id === 'language-select' ? picker : null,
        createElement: () => ({value: '', textContent: ''})
      },
      fetch: async url => ({ok: true, json: async () =>
        url.includes('/languages.json')
          ? JSON.parse(fs.readFileSync(path.resolve(__dirname, '../assets/locales/languages.json'), 'utf8'))
          : (url.includes('/de.json') ? german : english)}),
      history: {replaceState() {}}, console: {warn() {}}
    });
    vm.runInContext(localization, context);
    // help.js must initialize the page independently of app.js.
    vm.runInContext(helpInit, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.document.title, german[titleKey], page);
    assert.equal(context.document.documentElement.lang, 'de', page);
    assert.equal(title.textContent, german[titleKey], page);
    assert.equal(notice.textContent, german[notice.dataset.i18n], page);
    assert.equal(picker.value, 'de', page);
  }
});

test('locale requests resolve next to i18n.js even when a page lives in html/', async () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../assets/i18n.js'), 'utf8');
  const english = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../assets/locales/en.json'), 'utf8'));
  const fetched = [];
  const context = vm.createContext({
    window: {}, URLSearchParams, Intl, location: {search: ''},
    localStorage: {getItem: () => null},
    document: {
      currentScript: {src: 'https://example.org/archive/assets/i18n.js?v=test'},
      documentElement: {lang: ''}, title: '', querySelector: () => null,
      querySelectorAll: () => [], getElementById: () => null
    },
    fetch: async url => { fetched.push(url); return {ok: true, json: async () =>
      url.includes('/languages.json')
        ? JSON.parse(fs.readFileSync(path.resolve(__dirname, '../assets/locales/languages.json'), 'utf8'))
        : english}; },
    console: {warn() {}}
  });
  vm.runInContext(script, context);
  await vm.runInContext('window.J2ME_I18N.init()', context);
  assert.match(fetched[0], /^https:\/\/example\.org\/archive\/assets\/locales\/languages\.json\?v=/);
  assert.match(fetched[1], /^https:\/\/example\.org\/archive\/assets\/locales\/en\.json\?v=/);
  assert.equal(context.document.title, english.pageTitle);
});

// The initial results area starts hidden. If the manifest finally fails to
// load, a visitor must see the error without having to submit a search first.
function startupTestDom(context) {
  const nodes = new Map();
  function node(tag = 'div') {
    const listeners = new Map();
    return {
      tagName: tag, textContent: '', hidden: false, children: [],
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      addEventListener(event, callback) { listeners.set(event, callback); },
      click() { listeners.get('click')?.(); }
    };
  }
  for (const id of ['status', 'results', 'unique-count', 'language-select',
    'search-form', 'more', 'show-all', 'query']) nodes.set(id, node());
  const section = {hidden: true};
  context.document = {
    getElementById: id => nodes.get(id) || null,
    querySelectorAll: () => [],
    querySelector: selector => selector === '.results-section' ? section : null,
    createElement: node
  };
  let reloads = 0;
  context.location = {search: '', reload: () => { reloads++; }};
  context.URLSearchParams = URLSearchParams;
  context.window.J2ME_I18N.init = async () => {};
  const english = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../assets/locales/en.json'), 'utf8'));
  context.window.J2ME_I18N.t = (key, vars = {}) =>
    String(english[key] || key).replace(/\{(\w+)\}/g,
      (match, name) => Object.hasOwn(vars, name) ? String(vars[name]) : match);
  return {nodes, section, getReloads: () => reloads};
}

test('Hash mode detects only complete 8/40/64-character hexadecimal inputs', () => {
  const {run, context} = loadApp();
  const cases = [
    [' DEADBEEF ', 'crc32'],
    ['a'.repeat(40), 'sha1'],
    ['F'.repeat(64), 'sha256'],
    ['deadbee', null], ['a'.repeat(39), null], ['b'.repeat(65), null],
    ['deadbeeg', null], ['0xdeadbeef', null], ['DEAD BEEF', null],
    ['some game', null], ['', null]
  ];
  for (const [value, type] of cases) {
    context.inputHash = value;
    assert.equal(run('detectHashType(inputHash)'), type, `Input: ${value}`);
  }
  const homepage = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.deepEqual([...homepage.matchAll(/data-mode="([^"]+)"/g)].map(match => match[1]),
    ['name', 'hash'], 'The search UI should offer only Text and Hash');
});

test('Hash search dispatches all three formats and reports invalid values', async () => {
  const {run, context} = loadApp();
  const state = {
    query: {value: ''}, results: {children: [], replaceChildren(...v) { this.children = v; }, append(...v) { this.children.push(...v); }},
    more: {hidden: true}, 'show-all': {hidden: true},
    status: {textContent: ''}, 'result-tools': {hidden: true},
    'search-form': {querySelector: () => ({disabled: false})}
  };
  context.document.getElementById = id => state[id];
  context.document.querySelector = selector => selector === '.results-section'
    ? {hidden: true} : null;
  context.document.createElement = tag => ({tagName: tag, textContent: '', className: ''});
  run(`manifest = {record_chunk: 4096};
       searchMode = 'hash';
       resetResultTools = () => {};
       setResultControlsBusy = () => {};
       renderMore = async () => {};
       window.lookupCalls = [];
       crc32Lookup = async value => { window.lookupCalls.push(['crc32', value]); return [17, 19]; };
       exactHashLookup = async (type, value) => { window.lookupCalls.push([type, value]); return 23; };`);
  const cases = [
    ['DEADBEEF', ['crc32', 'DEADBEEF'], [17, 19]],
    ['A'.repeat(40), ['sha1', 'a'.repeat(40)], [23]],
    ['F'.repeat(64), ['sha256', 'f'.repeat(64)], [23]]
  ];
  for (const [input, expectedLookup, expectedIds] of cases) {
    state.query.value = input;
    await run('runSearch()');
    assert.deepEqual(Array.from(run('active')), expectedIds);
    assert.deepEqual(Array.from(context.window.lookupCalls.at(-1)), expectedLookup);
    assert.equal(state.results.children.length, 0, 'Valid results should not show an error');
  }
  const callCount = context.window.lookupCalls.length;
  for (const bad of ['ZZZZZZZZ', '1234567', 'a'.repeat(41), '0xdeadbeef']) {
    state.query.value = bad;
    await run('runSearch()');
    assert.equal(state.status.textContent, 'searchError');
    assert.equal(state.results.children.length, 1);
    assert.equal(state.results.children[0].textContent, 'enterAnyHash');
  }
  assert.equal(context.window.lookupCalls.length, callCount,
    'Invalid hash inputs should not start any lookup');
});

test('Hash hint identifies the detected type and keeps Text mode unambiguous', () => {
  const {run, context} = loadApp();
  const dictionary = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../assets/locales/en.json'), 'utf8'));
  context.window.J2ME_I18N.t = (key, vars = {}) =>
    String(dictionary[key] || key).replace(/\{(\w+)\}/g,
      (whole, name) => Object.hasOwn(vars, name) ? String(vars[name]) : whole);
  const query = {value: ''}, hint = {textContent: ''};
  context.document.getElementById = id => id === 'query' ? query : hint;
  run("searchMode = 'hash'");
  query.value = 'dEaDbEeF';
  run('updateSearchHint()');
  assert.equal(hint.textContent, 'Detected: CRC32.');
  query.value = 'a'.repeat(40);
  run('updateSearchHint()');
  assert.equal(hint.textContent, 'Detected: SHA-1.');
  query.value = 'a'.repeat(64);
  run('updateSearchHint()');
  assert.equal(hint.textContent, 'Detected: SHA-256.');
  query.value = 'a'.repeat(9);
  run('updateSearchHint()');
  assert.equal(hint.textContent, dictionary.hintHashAuto);
  run("searchMode = 'name'; updateSearchHint()");
  assert.equal(hint.textContent, dictionary.hintName);
});

test('existing SHA-256 permalinks open the new Hash mode', async () => {
  const {run, context} = loadApp();
  const {nodes, section} = startupTestDom(context);
  run('installResultTools = () => {};');
  const sha = 'B'.repeat(64);
  context.location.search = `?sha256=${sha}`;
  const query = {value: '', placeholder: '', focus() {}, addEventListener() {}};
  nodes.set('query', query);
  nodes.set('hint', {textContent: ''});
  const buttons = ['name', 'hash'].map(mode => {
    const listeners = new Map();
    return {
      dataset: {mode}, classList: {toggle() {}}, setAttribute() {},
      addEventListener(event, fn) { listeners.set(event, fn); },
      click() { listeners.get('click')?.(); }
    };
  });
  context.document.querySelectorAll = selector => selector === '[data-mode]' ? buttons : [];
  context.document.querySelector = selector => selector === '.results-section' ? section
    : selector === '[data-mode="hash"]' ? buttons[1] : null;
  const manifestData = TEST_MANIFEST;
  context.fetch = async () => ({ok: true, json: async () => manifestData});
  run(`runSearch = async () => { window.permalink = {mode: searchMode, query: $('query').value}; };`);
  await run('init()');
  assert.deepEqual(Object.fromEntries(Object.entries(context.window.permalink)),
    {mode: 'hash', query: sha.toLowerCase()});
  assert.equal(query.placeholder, 'Paste a CRC32, SHA-1 or SHA-256 hash…');
  assert.equal(section.hidden, true, 'Successful permalink startup should not show an error');
});

test('startup reveals final 503 failure only after retries, with a translated reload button', async () => {
  const {run, context} = loadApp();
  const {nodes, section, getReloads} = startupTestDom(context);
  run('installResultTools = () => {};');
  const requested = [];
  context.fetch = async url => {
    requested.push(url);
    return {ok: false, status: 503, headers: {get: () => null}};
  };
  assert.equal(section.hidden, true, 'Results are initially hidden');
  await run('init()');
  assert.deepEqual(requested, Array(4).fill('./data/manifest.json'),
    'All four existing HTTP 503 attempts must run before showing the error');
  assert.equal(section.hidden, false, 'The final error must be visible immediately');
  assert.equal(nodes.get('status').textContent, 'Search index unavailable');
  const [message] = nodes.get('results').children;
  assert.match(message.textContent, /manifest\.json.*HTTP 503/);
  assert.equal(message.children.length, 1);
  const [button] = message.children;
  assert.equal(button.textContent, 'Reload page');
  assert.equal(button.type, 'button');
  assert.equal(getReloads(), 0);
  button.click();
  assert.equal(getReloads(), 1, 'Reload button should actually reload the page');
});

test('successful startup leaves the Results section hidden', async () => {
  const {run, context} = loadApp();
  const {nodes, section} = startupTestDom(context);
  run('installResultTools = () => {};');
  const manifest = TEST_MANIFEST;
  context.fetch = async () => ({ok: true, json: async () => manifest});
  await run('init()');
  assert.equal(section.hidden, true);
  assert.equal(nodes.get('results').children.length, 0);
  assert.equal(nodes.get('unique-count').textContent,
    Number(manifest.unique_files).toLocaleString('en-US'));
});

test('one unavailable text-search shard fails the search without caching partial results, then recovers', async () => {
  const {run, context} = loadApp();
  run(`NAME_INDEX = nameIndexConfig({names_chunks: 2, names_grams: 'names-v2/grams.json.gz'});
       gramMap = async () => ({'3': {son: '3'}});`);
  context.TextDecoder = TextDecoder;
  context.Uint8Array = Uint8Array;
  const hits = [];
  let blockShard = true;
  const responses = {
    './data/names-v2/000.json.gz': [['sonic', 1, 0]],
    './data/names-v2/001.json.gz': [['sonic adventure', 2, 1]]
  };
  context.fetch = async url => {
    hits.push(url);
    if (blockShard && url === './data/names-v2/001.json.gz')
      return {ok: false, status: 503, headers: {get: () => null}};
    const body = new TextEncoder().encode(JSON.stringify(responses[url]));
    return {ok: true, arrayBuffer: async () => body.buffer};
  };
  await assert.rejects(run("searchNames('son', generation)"), /001\.json\.gz.*HTTP 503/);
  assert.equal(hits.filter(url => url.endsWith('/001.json.gz')).length, 4,
    'A single failed shard should receive all four HTTP 503 attempts');
  assert.equal(run("recentNameSearches.has('son')"), false,
    'Do not retain incomplete search results');
  blockShard = false;
  assert.deepEqual(Array.from(await run("searchNames('son', generation)")), [1, 2],
    'A later retry should recover all matches from both shards');
});


test('search-index failure shows a friendly localized message; Retry search actually reruns it', async () => {
  const {run, context} = loadApp();
  const {nodes} = startupTestDom(context);
  nodes.get('query').value = 'sonic';
  nodes.get('search-form').querySelector = () => ({disabled: false});
  nodes.set('result-tools', {hidden: false});
  run(`manifest = {record_chunk: 4096};
       searchMode = 'name';
       let calls = 0;
       resetResultTools = () => {};
       setResultControlsBusy = () => {};
       searchNames = async () => {
         calls++;
         if (calls === 1) throw new TypeError('NetworkError when attempting to fetch resource');
         return [7];
       };
       renderMore = async () => { $('results').append(elem('div', 'Sonic result', 'card')); };`);
  await run('runSearch()');
  assert.equal(run('calls'), 1);
  assert.equal(nodes.get('status').textContent, 'Search error');
  const [errorPanel] = nodes.get('results').children;
  assert.equal(errorPanel.children[0].textContent,
    'Some search data could not be loaded. Check your connection and try again.');
  assert.ok(!errorPanel.children[0].textContent.includes('NetworkError'));
  assert.equal(nodes.get('result-tools').hidden, true);
  const [retry] = errorPanel.children.slice(1);
  assert.equal(retry.textContent, 'Retry search');
  assert.equal(retry.type, 'button');
  retry.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('calls'), 2, 'Retry must repeat the actual search');
  assert.equal(nodes.get('results').children[0].textContent, 'Sonic result');
  assert.equal(nodes.get('result-tools').hidden, false);
  // A stale Retry from an older query must not launch another search.
  run('generation++');
  retry.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('calls'), 2);
});

test('failure while loading result records clears any partial result cards', async () => {
  const {run, context} = loadApp();
  const {nodes} = startupTestDom(context);
  nodes.get('query').value = 'sonic';
  nodes.get('search-form').querySelector = () => ({disabled: false});
  nodes.set('result-tools', {hidden: false});
  run(`manifest = {record_chunk: 4096};
       searchMode = 'name';
       resetResultTools = () => {};
       setResultControlsBusy = () => {};
       searchNames = async () => [7, 8];
       renderMore = async () => {
         $('results').append(elem('div', 'Incomplete', 'card'));
         throw new Error('records/0001.json.gz: HTTP 503');
       };`);
  await run('runSearch()');
  assert.equal(nodes.get('results').children.length, 1);
  assert.equal(nodes.get('results').children[0].children[0].textContent,
    'Some search data could not be loaded. Check your connection and try again.');
  assert.equal(run('active.length'), 0);
  assert.equal(run('originalResults'), null);
  assert.equal(nodes.get('result-tools').hidden, true);
  assert.equal(nodes.get('more').hidden, true);
  assert.equal(nodes.get('show-all').hidden, true);
});


test('unsupported gzip browsers keep their specific guidance rather than offering futile retries', async () => {
  const {run, context} = loadApp();
  const {nodes} = startupTestDom(context);
  nodes.get('query').value = 'sonic';
  nodes.get('search-form').querySelector = () => ({disabled: false});
  nodes.set('result-tools', {hidden: true});
  run(`manifest = {record_chunk: 4096};
       searchMode = 'name';
       resetResultTools = () => {};
       searchNames = async () => { throw new Error(t('gzipRequired')); };`);
  await run('runSearch()');
  const panel = nodes.get('results').children[0];
  assert.equal(panel.children.length, 1);
  assert.equal(panel.children[0].textContent,
    'This site requires a current browser with gzip DecompressionStream support.');
});

test('folder member verification rejects stale IDs and changed archive paths', async () => {
  const {run, context} = loadApp();
  const main = [
    'a'.repeat(64), 'b'.repeat(40), 3072,
    [[0, 'Sonic.jar', 'Games/Sonic.jar', '1234ABCD']],
    ['Sonic', 'Publisher', '1.0', '', '']
  ];
  context.currentRecord = main;
  context.member = [42, main[0], 'Sonic', 'Publisher', '1.0', 3072];
  run(`manifest = {unique_files: 100};
       recordById = async id => currentRecord;`);
  await run("verifyFolderPage([member], 'Games')");

  // Reassigned ID: same group metadata, but the current record is different.
  context.currentRecord = ['f'.repeat(64), ...main.slice(1)];
  await assert.rejects(run("verifyFolderPage([member], 'Games')"), /folderIndexOutdated/);

  // Identical SHA but moved to a different folder is also incompatible.
  context.currentRecord = [main[0], main[1], main[2],
    [[0, 'Sonic.jar', 'Elsewhere/Sonic.jar', '1234ABCD']], main[4]];
  await assert.rejects(run("verifyFolderPage([member], 'Games')"), /folderIndexOutdated/);

  context.currentRecord = main;
  context.member = [42, main[0], 'Sonic', 'Incorrect publisher', '1.0', 3072];
  await assert.rejects(run("verifyFolderPage([member], 'Games')"), /folderIndexOutdated/);
});

test('obsolete folder-index manifests disable optional folder browsing', async () => {
  const {run, context} = loadApp();
  run(`manifest = {record_chunk: 4096, unique_files: 620287};
       readJson = async () => ({schema_version: 1,
         unique_files: 620287, record_chunk: 4096,
         index_manifest_sha256: 'a'.repeat(64)});`);
  assert.equal(await run('folderCatalog()'), null);
});

test('folder UI never displays a link for a member whose record ID changed', async () => {
  const {run, context} = loadApp();
  const find = downloadTestDom(context);
  run(`manifest = {unique_files: 620287, record_chunk: 4096};
       folderCatalog = async () => new Map([['Games', 2]]);
       folderEntries = async () => [
         [42, 'a'.repeat(64), 'Sonic', 'Publisher', '1.0', 3072],
         [43, 'b'.repeat(64), 'Echo', 'Publisher', '1.0', 3000]
       ];
       recordById = async id => id === 42
         ? ${testRecord}
         : ['c'.repeat(64), 'b'.repeat(40), 3000,
            [[0, 'Echo.jar', 'Games/Echo.jar', '1234ABCD']],
            ['Echo', 'Publisher', '1.0', '', '']];`);
  const card = run(`renderResult(42, ${testRecord})`);
  await new Promise(resolve => setImmediate(resolve));
  const toggle = find(card, 'folder-toggle');
  assert.ok(toggle);
  toggle.click();
  await new Promise(resolve => setImmediate(resolve));
  const panel = find(card, 'folder-panel');
  assert.equal(find(panel, 'folder-file-link'), null);
  assert.match(find(panel, 'folder-error').textContent, /folderIndexOutdated/);
});
