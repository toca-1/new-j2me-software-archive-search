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
  context.config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/manifest.json'), 'utf8'));
  // Verify the checked-in manifest is accepted without changing its bytes.
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
      tagName: tag, className: '', children: [], hidden: false, isConnected: true,
      append(...nodes) { this.children.push(...nodes); },
      setAttribute(key, value) { attrs.set(key, String(value)); },
      getAttribute(key) { return attrs.get(key) ?? null; },
      removeAttribute(key) { attrs.delete(key); },
      addEventListener(type, handler) { listeners.set(type, handler); },
      click() { listeners.get('click')?.(); },
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
