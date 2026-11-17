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
  assert.equal(run('summaryShardsForMatches.get(5)'), 0, 'Remember which name shard can supply metadata');
  run('gramMap = async () => { throw Error("cache miss"); };');
  const second = await run("searchNames('son', 0)");
  assert.deepEqual(Array.from(second), [5, 9, 7]);
  assert.equal(run('summaryShardsForMatches.get(7)'), 0, 'Cached hits retain their summary shard');
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

test('@ operators parse strictly and quoted tokens remain literal', () => {
  const {run} = loadApp();
  const parse = text => run(`parseSearchQuery(${JSON.stringify(text)})`);
  const normal = parse('sonic @version=1.0.0 @midp=2.0 @cldc=1.1 @size>1.5KiB');
  assert.deepEqual(Array.from(normal.included), ['sonic']);
  assert.deepEqual(Array.from(normal.filters, x => [x.field, x.operator, x.value]), [
    ['version', '=', '1.0.0'], ['midp', '=', '2.0'], ['cldc', '=', '1.1'], ['size', '>', 1536]
  ]);
  assert.deepEqual(Array.from(parse('sonic @vendor="Some Studio"').filters, x => x.value), ['some studio']);
  assert.deepEqual(Array.from(parse('sonic "@version=1.0.0" -"@midp=2.0"').included),
    ['sonic', '@version=1.0.0']);
  assert.deepEqual(Array.from(parse('sonic "@version=1.0.0" -"@midp=2.0"').excluded), ['@midp=2.0']);
  assert.deepEqual(Array.from(parse('"@vendor=foo"').included), ['@vendor=foo']);
  assert.deepEqual(Array.from(parse('sonic @CLDC=CLDC-1.1').filters, x => x.value), ['1.1']);
  assert.deepEqual(Array.from(parse('sonic @midp=MIDP-2.0').filters, x => x.value), ['2.0']);
  assert.deepEqual(Array.from(parse('sonic @size<100KB').filters, x => x.value), [100000]);
  assert.deepEqual(Array.from(parse('sonic @size=1MB').filters, x => x.value), [1000000]);
  for (const query of ['sonic @version=', 'sonic @version>1.0', 'sonic @vendor="Some',
    'sonic @size>3', 'sonic @size>1XB', 'sonic @size=0.1B', 'sonic @vendor="',
    'sonic @unknown=abc', 'sonic @midp!=2.0', 'sonic -@version=1.0', 'sonic @version',
    'sonic @size<=100KB', 'sonic @size>=100KB', 'sonic @size=<100KB',
    'sonic @size=>100KB']) {
    assert.equal(parse(query).error, true, `Operator ${query} must be rejected`);
  }
  assert.equal(parse('sonic @version=?').error, false);
  assert.equal(parse('user@example.com').error, false, 'Embedded @ remains a literal');
  assert.deepEqual(Array.from(parse('prince -persia "test game"').included), ['prince', 'test game']);
});

test('@ operators filter exact compact metadata, size and missing values without changing relevance', () => {
  const {run} = loadApp();
  run(`let operatorSample = {
    ids: [7, 2, 8, 3, 9],
    summaries: new Map([
      [7, {title: 'Sonic', bytes: 100001, fields: ['sonic','gameloft'], quick: ['Sonic','Gameloft','1.0.0','CLDC-1.1','MIDP-2.0']}],
      [2, {title: 'Sonic', bytes: 99999, fields: ['sonic','some studio'], quick: ['Sonic','Some Studio','1.0','CLDC-1.0','MIDP-1.0']}],
      [8, {title: 'Sonic', bytes: 300000, fields: ['sonic','gameloft'], quick: ['Sonic','Gameloft','1.0.0','CLDC-1.1','MIDP-2.0']}],
      [3, {title: 'Sonic', bytes: 4096, fields: ['sonic'], quick: ['Sonic','','','','']}],
      [9, {title: 'Sonic', bytes: 100001, fields: ['sonic','gameloft'], quick: ['Sonic','Gameloft','1.0.0','CLDC-1.0','MIDP-2.0']}]
    ])
  };`);
  const ids = q => Array.from(run(`selectResultIds(operatorSample, ${JSON.stringify(q)}, 'default')`));
  assert.deepEqual(ids('sonic @version=1.0.0'), [7, 8, 9]);
  assert.deepEqual(ids('sonic @version=1.0'), [2]);
  assert.deepEqual(ids('sonic @midp=2.0 @cldc=1.1'), [7, 8]);
  assert.deepEqual(ids('sonic @vendor=GAMELOFT @size>100KB'), [7, 8, 9]);
  assert.deepEqual(ids('sonic @vendor="Some Studio"'), [2]);
  assert.deepEqual(ids('sonic @size<100KB'), [2, 3]);
  assert.deepEqual(ids('sonic @version=?'), [3]);
  assert.deepEqual(ids('sonic @midp=?'), [3]);
  assert.deepEqual(ids('sonic @vendor=?'), [3]);
  assert.deepEqual(ids('sonic @size>10MiB'), []);
  assert.deepEqual(ids('sonic -gameloft @version=1.0'), [2]);
  assert.deepEqual(Array.from(run('operatorSample.ids')), [7, 2, 8, 3, 9],
    'Filtering cannot reorder/mutate the base result set');
  assert.throws(() => ids('sonic @midp>1.0'), /searchOperatorInvalid/);
});

test('@ operators are supported by compact summaries and record fallback', () => {
  const {run} = loadApp();
  run(`labelsForMatches = new Map([[2, ['sonic.jar', 0]]]);`);
  const compact = run(`resultSummaryFromCompact(2, [2, 123456, ['Sonic','Gameloft','1.0.0','CLDC-1.1','MIDP-2.0'], ['sonic.jar']])`);
  assert.equal(compact.quick[2], '1.0.0');
  assert.equal(compact.bytes, 123456);
  assert.deepEqual(Array.from(run(`selectResultIds({ids: [2], summaries: new Map([[2, resultSummaryFromCompact(2,
    [2,123456,['Sonic','Gameloft','1.0.0','CLDC-1.1','MIDP-2.0'],['sonic.jar']])]])},
    'sonic @version=1.0.0 @size>100KiB', 'default')`)), [2]);
});


test('@version uses the compact search metadata on the first request, not full record shards', async () => {
  const {run, context} = loadApp();
  const {nodes} = startupTestDom(context);
  nodes.set('result-tools', {hidden: true});
  nodes.get('search-form').querySelector = () => ({disabled: false});
  run(`manifest = {record_chunk: 4};
       searchMode = 'name';
       resetResultTools = () => {};
       setResultControlsBusy = () => {};
       setPaginationBusy = () => {};
       renderPage = async () => {};
       searchNames = async anchor => {
         if (anchor !== 'forgotten') throw Error('Wrong search anchor');
         summaryShardsForMatches = new Map([[0, 5], [1, 6]]);
         labelsForMatches = new Map([[0, ['pop the forgotten sands.jar', 0]],
           [1, ['forgotten sands demo.jar', 0]]]);
         return [0, 1];
       };
       let compactReads = 0, recordReads = 0;
       searchSummaryCatalog = async () => ({schema_version: 1});
       nameSummaryShard = async shard => {
         compactReads++;
         return shard === 5
           ? new Map([[0, [0, 275763, ['POP The Forgotten Sands', 'Gameloft SA',
               '1.1.7', 'CLDC-1.0', 'MIDP-2.0'], ['POP The Forgotten Sands.jar']]]])
           : new Map([[1, [1, 50000, ['Forgotten Sands demo', 'Studio',
               '1.0.0', 'CLDC-1.1', 'MIDP-2.0'], ['Forgotten Sands demo.jar']]]]);
       };
       readGzipJson = async () => {recordReads++; throw Error('Unnecessary full record download');};`);
  nodes.get('query').value = 'forgotten sands @version=1.1.7';
  await run('runSearch()');
  assert.deepEqual(Array.from(run('active')), [0]);
  assert.equal(run('compactReads'), 2, 'Only small metadata shards are fetched');
  assert.equal(run('recordReads'), 0, 'The expensive record-shard path is not used');
  assert.equal(run('originalResults.ready'), true);
  assert.equal(run('originalResults.summaries.get(0).quick[2]'), '1.1.7');
});

test('@ refinement and sorting reuse fast metadata without extra downloads', async () => {
  const {run, context} = loadApp();
  const {nodes} = startupTestDom(context);
  nodes.set('result-tools', {hidden: true});
  nodes.set('refine-query', {value: ''});
  nodes.set('result-sort', {value: 'default'});
  nodes.set('export-status', {textContent: ''});
  nodes.set('export-csv', {disabled: false});
  nodes.get('search-form').querySelector = () => ({disabled: false});
  run(`manifest = {record_chunk: 4};
       searchMode = 'name';
       resetResultTools = () => {};
       setResultControlsBusy = () => {};
       setPaginationBusy = () => {};
       renderPage = async () => {};
       searchNames = async anchor => {
         if (anchor !== 'forgotten') throw Error('Wrong search anchor');
         summaryShardsForMatches = new Map([[0, 5], [1, 6]]);
         labelsForMatches = new Map([[0, ['pop the forgotten sands.jar', 0]],
           [1, ['forgotten sands demo.jar', 0]]]);
         return [0, 1];
       };
       let compactReads = 0, recordReads = 0;
       searchSummaryCatalog = async () => ({schema_version: 1});
       nameSummaryShard = async shard => {
         compactReads++;
         return shard === 5
           ? new Map([[0, [0, 275763, ['POP The Forgotten Sands', 'Gameloft SA',
               '1.1.7', 'CLDC-1.0', 'MIDP-2.0'], ['POP The Forgotten Sands.jar']]]])
           : new Map([[1, [1, 50000, ['Forgotten Sands demo', 'Studio',
               '1.0.0', 'CLDC-1.1', 'MIDP-2.0'], ['Forgotten Sands demo.jar']]]]);
       };
       readGzipJson = async () => {recordReads++; throw Error('Unnecessary full record download');};`);
  nodes.get('query').value = 'forgotten';
  await run('runSearch()');
  assert.equal(run('compactReads'), 0, 'Plain searches must remain lazy');
  nodes.get('refine-query').value = '@version=1.1.7';
  await run('applyResultTools()');
  assert.deepEqual(Array.from(run('active')), [0]);
  assert.equal(run('compactReads'), 2, 'First refinement loads only small metadata shards');
  assert.equal(run('recordReads'), 0);
  nodes.get('refine-query').value = '';
  nodes.get('result-sort').value = 'size-asc';
  await run('applyResultTools()');
  assert.deepEqual(Array.from(run('active')), [1, 0]);
  assert.equal(run('compactReads'), 2, 'Sorting reuses the first refinement download');
  nodes.get('refine-query').value = '@midp=2.0 @vendor="Gameloft SA"';
  await run('applyResultTools()');
  assert.deepEqual(Array.from(run('active')), [0]);
  assert.equal(run('compactReads'), 2, 'Additional @ filters reuse the summary cache');
  assert.equal(run('recordReads'), 0);
});

test('Search Help documents the supported @ operators without inclusive size comparisons', () => {
  const markup = fs.readFileSync(path.resolve(__dirname, '../html/search-help.html'), 'utf8');
  for (const operator of ['@version=', '@midp=', '@cldc=', '@vendor=', '@size&gt;', '@size&lt;'])
    assert.ok(markup.includes(operator), `Missing ${operator} from Search Help`);
  assert.ok(!markup.includes('@size&lt;='));
  assert.ok(!markup.includes('@size&gt;='));
  assert.match(markup, /test -game\ntest game\n"test game"\n"test game" -demo\ntestgame -test/);
  assert.match(markup, /GAME @vendor="TEST Studios"/);
  assert.match(markup, /GAME @version=\?<\/code> <span data-i18n="searchHelpMissingMetadata">\(missing metadata\)/);
  assert.ok(!markup.includes('forgotten sands'));
  assert.ok(!markup.includes('searchHelpOperatorsNote'));
  assert.ok(!markup.includes('data-i18n="searchHelpRequiresPositive"'));
});

test('main search applies operators after name anchoring and blocks operator-only scans', async () => {
  const {run, context} = loadApp();
  const {nodes} = startupTestDom(context);
  nodes.set('result-tools', {hidden: true});
  nodes.get('search-form').querySelector = () => ({disabled: false});
  run(`manifest = {record_chunk: 4096};
       searchMode = 'name';
       resetResultTools = () => {};
       setResultControlsBusy = () => {};
       let searched = [];
       searchNames = async anchor => {searched.push(anchor); return [1, 2, 3];};
       prepareResultSummaries = async state => {
         state.summaries = new Map([
           [1, {title: 'Sonic', bytes: 10, fields: ['sonic'], quick: ['Sonic','Sega','1.0.0','CLDC-1.1','MIDP-2.0']}],
           [2, {title: 'Sonic', bytes: 20, fields: ['sonic'], quick: ['Sonic','Sega','1.1.0','CLDC-1.1','MIDP-2.0']}],
           [3, {title: 'Sonic', bytes: 40, fields: ['sonic'], quick: ['Sonic','','','','']}]
         ]);
         state.ready = true;
       };
       renderPage = async () => {};`);
  nodes.get('query').value = 'sonic @version=1.0.0';
  await run('runSearch()');
  assert.deepEqual(Array.from(run('active')), [1]);
  assert.deepEqual(Array.from(run('searched')), ['sonic']);
  nodes.get('query').value = '@version=1.0.0';
  await run('runSearch()');
  assert.deepEqual(Array.from(run('searched')), ['sonic'], 'Operator-only query should not fetch shards');
  assert.match(nodes.get('results').children[0].textContent, /Include at least one search word/);
  nodes.get('query').value = 'sonic @version>1.0.0';
  await run('runSearch()');
  assert.deepEqual(Array.from(run('searched')), ['sonic'], 'Invalid query should not fetch shards');
  const errorBox = nodes.get('results').children[0];
  assert.equal(errorBox.children[0], 'Invalid @ operator. See ');
  assert.equal(errorBox.children[1].tagName, 'a');
  assert.equal(errorBox.children[1].textContent, 'Search help');
  assert.equal(errorBox.children[1].href, './html/search-help.html');
  assert.equal(errorBox.children[1].target, '_blank');
  assert.equal(errorBox.children[1].rel, 'noopener noreferrer');
  assert.equal(errorBox.children[2], ' for supported syntax (or quote it to search literally).');
});

test('invalid @ refinement also links to localized Search help', async () => {
  const {run, context} = loadApp();
  const {nodes} = startupTestDom(context);
  nodes.set('refine-query', {value: '@size<=100KB'});
  nodes.set('result-sort', {value: 'default'});
  nodes.set('export-csv', {disabled: false});
  run(`originalResults = {ids: [1], summaries: new Map(), busy: false};
       setResultControlsBusy = () => {};
       setPaginationBusy = () => {};`);
  await run('applyResultTools()');
  const message = nodes.get('status').children;
  assert.equal(message.length, 3);
  assert.match(message[0], /Could not refine or sort results: Invalid @ operator/);
  assert.equal(message[1].tagName, 'a');
  assert.equal(message[1].textContent, 'Search help');
  assert.equal(message[1].href, './html/search-help.html');
  assert.match(message[2], /supported syntax/);

  const de = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../assets/locales/de.json'), 'utf8'));
  context.window.J2ME_I18N.t = (key, vars = {}) =>
    String(de[key] || key).replace(/\{(\w+)\}/g, (match, name) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : match);
  await run('applyResultTools()');
  assert.equal(nodes.get('status').children[1].textContent, 'Suchhilfe');
  assert.match(nodes.get('status').children[0], /Ungültiger @-Operator/);
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
       renderPage = async () => {};`);
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
       renderPage = async () => {};`);
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
  assert.equal(sortRow.children.length, 2, 'Sort row contains sorting and CSV export');
  assert.equal(sortRow.children[0].className, 'result-sort-controls');
  assert.equal(sortRow.children[1].className, 'export-csv');
  assert.equal(sortRow.children[1].textContent, 'exportCsv');
  assert.equal(find(context.resultTools, 'refine-help-link'), null,
    'The old refinement-specific help link is gone');
});

test('CSV export escapes quotes, Unicode, delimiters and spreadsheet formulas', () => {
  const {run} = loadApp();
  run(`manifest = {record_chunk: 2};`);
  assert.equal(run(`csvCell('A,"B"')`), '"A,""B"""');
  assert.equal(run(`csvCell('=HYPERLINK("bad")')`), `"'=HYPERLINK(""bad"")"`);
  assert.equal(run(`csvCell('  +123')`), "'  +123");
  assert.equal(run(`csvCell('@cmd')`), "'@cmd");
  assert.equal(run(`csvCell('Ångström')`), 'Ångström');
  const row = run(`exportRecordRow(7, [
    '${'a'.repeat(64)}', '${'b'.repeat(40)}', 1500,
    [[0,'A.jar','Dir/A.jar','a1b2c3d4'], [1,'B.jar','Elsewhere/B.jar','a1b2c3d4']],
    ['=DANGER','Vendor, Inc.','1.0','CLDC-1.1','MIDP-2.0']
  ])`);
  const fields = String(row).split(',');
  assert.match(row, /^7,'=DANGER,"Vendor, Inc\.",1\.0,CLDC-1\.1,MIDP-2\.0,1500,/);
  assert.match(row, /A1B2C3D4/);
  assert.match(row, /"Lite\nFull"/);
  assert.match(row, /"Dir\/A\.jar\nElsewhere\/B\.jar"/);
  assert.match(row, /archive\.org\/download\/96x65pixels_j2me/);
  assert.ok(fields.length >= 14);
});

test('CSV export respects the cap and uses the active result order', async () => {
  const {run, context} = loadApp();
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {textContent: '', disabled: false});
    return elements.get(id);
  };
  context.document.getElementById = get;
  let clicked = false, exportedBlob, revoked = false;
  context.Blob = Blob;
  context.URL = {
    createObjectURL(blob) { exportedBlob = blob; return 'blob:test'; },
    revokeObjectURL(url) { assert.equal(url, 'blob:test'); revoked = true; }
  };
  context.document.body = {append(link) {assert.equal(link.download, 'j2me-search-results.csv');}};
  context.document.createElement = () => ({click() {clicked = true;}, remove() {}});
  run(`manifest = {record_chunk: 2};
       originalResults = {busy: false};
       active = Array.from({length: EXPORT_MAX_RECORDS + 1}, (_, i) => i);`);
  await run('exportCurrentResults()');
  assert.equal(clicked, false);
  assert.equal(get('export-status').textContent, 'exportLimit');

  context.testChunks = {
    'records/0000.json.gz': [
      ['a'.repeat(64), 'b'.repeat(40), 200, [[0,'A.jar','Folder/A.jar','deadbeef']], ['Alpha','','','','']],
      ['c'.repeat(64), 'd'.repeat(40), 300, [[1,'B.jar','Folder/B.jar','feedbeef']], ['Bravo','','','','']]
    ],
    'records/0001.json.gz': [
      ['e'.repeat(64), 'f'.repeat(40), 400, [[0,'C.jar','Folder/C.jar','cafebabe']], ['Charlie','','','','']]
    ]
  };
  run(`readGzipJson = async path => testChunks[path];
       active = [2,0,1];`);
  await run('exportCurrentResults()');
  assert.equal(clicked, true);
  assert.equal(revoked, true);
  const content = await exportedBlob.text();
  assert.deepEqual(Array.from(new Uint8Array(await exportedBlob.arrayBuffer()).slice(0, 3)), [239, 187, 191]);
  assert.ok(content.startsWith('ID,Title,Vendor,Version,CLDC,MIDP,'));
  const lines = content.trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^2,Charlie,/);
  assert.match(lines[2], /^0,Alpha,/);
  assert.match(lines[3], /^1,Bravo,/);
  assert.equal(get('export-status').textContent, 'exportReady');
  assert.equal(get('export-csv').disabled, false);
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

test('fast refinement uses compact metadata from matching name shards, not record chunks', async () => {
  const {run} = loadApp();
  run(`manifest = {unique_files: 12, record_chunk: 4};
       originalResults = {ids: [0, 4, 8], summaries: new Map(), ready: false, busy: false};
       summaryShardsForMatches = new Map([[0, 0], [4, 1], [8, 0]]);
       labelsForMatches = new Map([[0, ['Prince.jar', 0]], [4, ['Prince of Persia', 1]], [8, ['Prince Game.jar', 0]]]);
       let opened = [];
       searchSummaryCatalog = async () => ({schema_version: 1});
       nameSummaryShard = async shard => {
         opened.push(shard);
         return shard === 0
           ? new Map([[0, [0, 10, ['', 'Studio A'], ['Prince.jar']]],
                      [8, [8, 30, ['Prince Game', 'Studio B'], ['Game.jar']]]])
           : new Map([[4, [4, 20, ['Prince of Persia', 'Studio A'], ['Persia.jar']]]]);
       };
       readGzipJson = async () => {throw Error('Should not load a full record chunk');};`);
  await run('prepareResultSummaries(originalResults, generation)');
  assert.deepEqual(Array.from(run('opened')), [0, 1]);
  assert.equal(run('originalResults.ready'), true);
  assert.equal(run('originalResults.summaries.get(0).title'), 'Prince.jar');
  assert.deepEqual(Array.from(run('selectResultIds(originalResults, "-persia", "size-desc")')), [8, 0]);
  await run('prepareResultSummaries(originalResults, generation)');
  assert.deepEqual(Array.from(run('opened')), [0, 1], 'Later sorts reuse the summaries');
});

test('missing optional summary shard falls back to full record metadata', async () => {
  const {run} = loadApp();
  run(`manifest = {unique_files: 4, record_chunk: 4};
       originalResults = {ids: [0], summaries: new Map(), ready: false, busy: false};
       summaryShardsForMatches = new Map([[0, 2]]);
       searchSummaryCatalog = async () => ({schema_version: 1});
       nameSummaryShard = async () => new Map();
       let legacyReads = 0;
       readGzipJson = async path => {
         legacyReads++;
         if (path !== 'records/0000.json.gz') throw Error('Unexpected path ' + path);
         return [['sha', 'sha1', 55, [[0, 'Prince.jar', 'dir/Prince.jar', 'abcd']],
           ['Prince', 'Vendor', '1.0.0', 'CLDC-1.0', 'MIDP-2.0']]];
       };`);
  await run('prepareResultSummaries(originalResults, generation)');
  assert.equal(run('legacyReads'), 1);
  assert.equal(run('originalResults.summaries.get(0).title'), 'Prince');
  assert.equal(run('originalResults.ready'), true);
  assert.deepEqual(Array.from(run(`selectResultIds(originalResults,
    '@version=1.0.0 @midp=2.0', 'default')`)), [0],
    'Operators must also work with the full-record fallback');
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
      dispatch(type, event = {preventDefault() {}}) {
        for (const handler of listeners.get(type) || []) handler(event);
      },
      querySelectorAll(selector) {
        const tags = new Set(selector.split(',').map(x => x.trim().toLowerCase()));
        const found = [];
        function walk(node) {
          for (const child of node.children || []) {
            if (tags.has(String(child.tagName).toLowerCase())) found.push(child);
            walk(child);
          }
        }
        walk(this);
        return found;
      },
      focus() { this.focused = true; },
      scrollIntoView() { this.scrolled = true; },
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

test('localized download headings and page navigation use the locale files', () => {
  for (const [lang, expected] of Object.entries({
    en: ['Download links', 'Internet archive', 'Other mirrors'],
    de: ['Downloadlinks', 'Internet Archive', 'andere Mirrors'],
    'zh-TW': ['下載連結', 'Internet Archive', '其他鏡像站']
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

    const bottom = context.document.createElement('nav');
    context.document.getElementById = id => id === 'pagination-bottom' ? bottom : null;
    run('active = Array.from({length: 41}, (_, i) => i); currentPage = 2; updatePaginationButtons()');
    assert.equal(bottom.children[0].textContent, context.window.J2ME_I18N.t('pageRange',
      {first: '6', last: '10', total: '41'}), `Page range (${lang})`);
    assert.equal(bottom.getAttribute('aria-label'), dictionary.pageNavigation);
    assert.equal(bottom.children[2].children[0].textContent, dictionary.pageSize);
    assert.equal(bottom.children[2].children[1].value, '5');
    const ellipsis = bottom.children[1].children.find(b => b.className === 'page-ellipsis');
    assert.equal(ellipsis.getAttribute('aria-label'), dictionary.pageJump);
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
    'search-form', 'pagination-bottom', 'query']) nodes.set(id, node());
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
    'pagination-bottom': {hidden: true, replaceChildren() {}},
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
       renderPage = async () => {};
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
       renderPage = async () => { $('results').append(elem('div', 'Sonic result', 'card')); };`);
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
       renderPage = async () => {
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
  assert.equal(nodes.get('pagination-bottom').hidden, true);
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

function paginationTestDom(context) {
  downloadTestDom(context);
  const nodes = new Map();
  for (const id of ['pagination-bottom', 'results', 'status'])
    nodes.set(id, context.document.createElement(id.startsWith('pagination') ? 'nav' : 'div'));
  context.document.getElementById = id => nodes.get(id) ?? null;
  const english = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../assets/locales/en.json'), 'utf8'));
  context.window.J2ME_I18N.t = (key, vars = {}) =>
    String(english[key] ?? key).replace(/\{(\w+)\}/g, (original, name) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : original);
  context.window.J2ME_I18N.numberLocale = () => 'en-US';
  return nodes;
}

test('page number windows stay bounded even for tens of thousands of pages', () => {
  const {run} = loadApp();
  assert.deepEqual(Array.from(run('paginationPages(1, 1)')), [1]);
  assert.deepEqual(Array.from(run('paginationPages(5, 3)')), [1, 2, 3, 4, 5]);
  assert.deepEqual(Array.from(run('paginationPages(10000, 1)')), [1, 2, 3, null, 10000]);
  assert.deepEqual(Array.from(run('paginationPages(10000, 5000)')),
    [1, null, 4998, 4999, 5000, 5001, 5002, null, 10000]);
  assert.deepEqual(Array.from(run('paginationPages(10000, 10000)')),
    [1, null, 9998, 9999, 10000]);
});

test('pagination defaults to five, navigates by ellipsis, and changes page size', async () => {
  const {run, context} = loadApp();
  const nodes = paginationTestDom(context);
  context.window.prompt = () => '9';
  run(`active = Array.from({length: 45}, (_, i) => i);
       originalResults = {ids: [...active], busy: false};
       window.loaded = [];
       recordById = async id => {window.loaded.push(id); return [id];};
       renderResult = (id) => elem('article', String(id), 'card');`);
  assert.equal(run('PAGE'), 5);
  await run('renderPage(generation, 1)');
  assert.equal(nodes.get('results').children.length, 5);
  assert.equal(nodes.get('results').children[0].textContent, '0');
  assert.equal(nodes.get('results').children.at(-1).textContent, '4');
  const nav = nodes.get('pagination-bottom');
  assert.equal(nav.hidden, false);
  assert.equal(nav.children[0].textContent, 'Showing 1–5 of 45');
  assert.equal(nav.getAttribute('aria-label'), 'Result pages');
  assert.equal(nav.children[1].children[0].disabled, true, 'Previous disabled on first page');
  assert.equal(nav.children[1].children[1].getAttribute('aria-current'), 'page');
  assert.equal(nav.children[2].children[0].textContent, 'Results per page');
  const options = nav.children[2].children[1].children;
  assert.deepEqual(options.map(option => option.value), ['5', '10', '20', '50']);
  nav.children[1].children.at(-1).click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('currentPage'), 2);
  assert.equal(nodes.get('results').children[0].textContent, '5');
  assert.equal(nav.children[0].textContent, 'Showing 6–10 of 45');
  assert.equal(nodes.get('results').focused, true, 'Focus the new page for keyboard navigation');
  assert.equal(nodes.get('results').scrolled, true, 'Scroll to the new page');
  const ellipsis = nav.children[1].children.find(child => child.className === 'page-ellipsis');
  assert.equal(ellipsis.tagName, 'button');
  assert.equal(ellipsis.getAttribute('aria-label'), 'Go to page');
  ellipsis.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('currentPage'), 9);
  assert.equal(nodes.get('results').children.length, 5);
  assert.equal(nodes.get('results').children[0].textContent, '40');
  assert.equal(nodes.get('results').children.at(-1).textContent, '44');
  assert.equal(nav.children[1].children.at(-1).disabled, true,
    'Next disabled on the last page');
  const callsBeforeInvalid = context.window.loaded.length;
  context.window.prompt = () => '999';
  nav.children[1].children.find(child => child.className === 'page-ellipsis').click();
  assert.equal(nodes.get('status').textContent, 'Enter a page from 1 to 9.');
  assert.equal(context.window.loaded.length, callsBeforeInvalid);
  context.window.prompt = () => null;
  nav.children[1].children.find(child => child.className === 'page-ellipsis').click();
  assert.equal(context.window.loaded.length, callsBeforeInvalid, 'Cancel does not load a page');
  // Switching to 20 keeps the first file on screen in the resulting page.
  const select = nav.children[2].children[1];
  select.value = '20';
  select.dispatch('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('PAGE'), 20);
  assert.equal(run('currentPage'), 3);
  assert.equal(nodes.get('results').children.length, 5);
  assert.equal(nodes.get('results').children[0].textContent, '40');
  assert.equal(nav.children[0].textContent, 'Showing 41–45 of 45');
  assert.equal(nav.children[2].children[1].value, '20');
  assert.equal(context.window.loaded.length, 20, 'Only the visited pages were requested');
  nav.children[2].children[1].value = '50';
  nav.children[2].children[1].dispatch('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('PAGE'), 50);
  assert.equal(run('currentPage'), 1);
  assert.equal(nodes.get('results').children.length, 45);
  assert.equal(nav.children[1].children.length, 0, 'Single-page searches omit page buttons');
  assert.equal(nav.hidden, false, 'Size picker is available even for one page');
});

test('pagination cancels stale searches and switches pages atomically after network errors', async () => {
  const {run, context} = loadApp();
  const nodes = paginationTestDom(context);
  run(`active = Array.from({length: 43}, (_, i) => i);
       originalResults = {ids: [...active], busy: false};
       renderResult = (id) => elem('article', String(id), 'card');
       recordById = async id => [id];`);
  await run('renderPage(generation, 1)');
  run(`recordById = async id => {
    if (id === 6) throw Error('Test record shard offline');
    return [id];
  };`);
  await assert.rejects(run('renderPage(generation, 2)'), /Test record shard offline/);
  assert.equal(run('currentPage'), 1);
  assert.equal(nodes.get('results').children.length, 5);
  assert.equal(nodes.get('results').children[0].textContent, '0',
    'A failed page cannot replace any existing cards');
  assert.equal(nodes.get('pagination-bottom').children[1].children.at(-1).disabled, false,
    'Controls are re-enabled when a page fails');
  run(`let finishLater;
       recordById = id => id >= 5 ? new Promise(resolve => {finishLater ??= []; finishLater.push(() => resolve([id]));}) : Promise.resolve([id]);
       window.finishLater = () => finishLater.forEach(resolve => resolve());`);
  const pending = run('renderPage(generation, 2)');
  run('generation++; resultViewVersion++;'); // New query or sort supersedes the old request.
  run('window.finishLater()');
  await pending;
  assert.equal(run('currentPage'), 1);
  assert.equal(nodes.get('results').children[0].textContent, '0',
    'A stale result page cannot overwrite newer search results');
});

test('refinement and CSV keep the whole matching set while paging its display', async () => {
  const {run, context} = loadApp();
  const nodes = paginationTestDom(context);
  nodes.set('refine-query', {value: ''});
  nodes.set('result-sort', {value: 'default'});
  nodes.set('export-status', {textContent: ''});
  nodes.set('export-csv', {disabled: false});
  context.document.querySelectorAll = () => [];
  run(`active = Array.from({length: 40}, (_, i) => i);
       originalResults = {ids: [...active], summaries: new Map(), ready: false, busy: false};
       renderResult = (id) => elem('article', String(id), 'card');
       recordById = async id => [id];
       selectResultIds = (state, query, order) => state.ids.filter(id => id % 2 === 0).reverse();`);
  await run('renderPage(generation, 2)');
  assert.equal(run('currentPage'), 2);
  await run('applyResultTools()');
  assert.equal(run('currentPage'), 1, 'Refinement resets the visible page');
  assert.deepEqual(Array.from(run('active')).slice(0, 3), [38, 36, 34]);
  assert.equal(run('active.length'), 20, 'Refinement keeps all 20 matching IDs');
  assert.equal(nodes.get('results').children.length, 5);
  assert.equal(nodes.get('results').children[0].textContent, '38');
  assert.equal(nodes.get('pagination-bottom').hidden, false, '20 matches occupy four five-file pages');
});

test('page-size changes are atomic and recover after a failed record request', async () => {
  const {run, context} = loadApp();
  const nodes = paginationTestDom(context);
  run(`active = Array.from({length: 30}, (_, i) => i);
       originalResults = {ids: [...active], busy: false};
       renderResult = id => elem('article', String(id), 'card');
       recordById = async id => [id];`);
  await run('renderPage(generation, 2)');
  assert.equal(nodes.get('results').children[0].textContent, '5');
  run(`recordById = async id => {if (id === 6) throw Error('Network offline'); return [id];};`);
  const nav = nodes.get('pagination-bottom');
  nav.children[2].children[1].value = '20';
  nav.children[2].children[1].dispatch('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('PAGE'), 5, 'Failed requests must not commit new page sizes');
  assert.equal(run('currentPage'), 2);
  assert.equal(nav.children[2].children[1].value, '5');
  assert.equal(nodes.get('results').children[0].textContent, '5');
  assert.equal(nodes.get('status').textContent, 'Could not load that page. Try again.');
});

test('single-page results still display the adjustable result count, no page buttons', async () => {
  const {run, context} = loadApp();
  const nodes = paginationTestDom(context);
  run(`active = [10, 20, 30];
       originalResults = {ids: [...active], busy: false};
       renderResult = id => elem('article', String(id), 'card');
       recordById = async id => [id];`);
  await run('renderPage(generation, 1)');
  const nav = nodes.get('pagination-bottom');
  assert.equal(nav.hidden, false);
  assert.equal(nav.children[1].children.length, 0);
  assert.equal(nav.children[2].children[1].value, '5');
  run('active = []; updatePaginationButtons()');
  assert.equal(nav.hidden, true);
});
