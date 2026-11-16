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
  assert.deepEqual(Array.from(run("candidateNameShards('abcd', {'3': {abc: '3', bcd: '2'}})")), [1]);
  assert.deepEqual(Array.from(run("candidateNameShards('abcz', {'3': {abc: '3'}})")), []);
});

test('name search deduplicates IDs, remembers labels, and reuses cached results', async () => {
  const {run} = loadApp();
  run(`gramMap = async () => ({'3': {son: '3'}});
       nameShard = async i => i === 0
         ? [['sonic', 5, 1], ['panasonic', 7, 2]]
         : [['sonic', 5, 0], ['sonar', 9, 0]];`);
  const first = await run("searchNames('son', 0)");
  assert.deepEqual(Array.from(first), [5, 7, 9]);
  assert.equal(run('labelsForMatches.get(5)[1]'), 0, 'Preferred label kind should win');
  run('gramMap = async () => { throw Error("cache miss"); };');
  const second = await run("searchNames('son', 0)");
  assert.deepEqual(Array.from(second), [5, 7, 9]);
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
