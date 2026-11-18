'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const original = fs.readFileSync(path.resolve(__dirname, '../assets/app.js'), 'utf8');
assert.match(original, /\binit\(\);\s*$/);

function setup() {
  const context = vm.createContext({
    window: {J2ME_I18N: { t: x => x, numberLocale: () => 'en-US' }},
    document: {getElementById: () => ({textContent:''})},
    console: {warn() {}, error() {}},
    setTimeout: callback => callback()
  });
  vm.runInContext(original.replace(/\binit\(\);\s*$/, ''), context);
  return {run: code => vm.runInContext(code, context), context};
}

test('mini file source export generates the verified #.7z individual-JAR URL', () => {
  const {run} = setup();
  const url = run("urlFor(2, '#.7z/007 Top Agent/007JamesBondTopAgent_02C998DC.jar')");
  assert.equal(url, 'https://archive.org/download/96x65pixels_j2me_mini/' +
    '%23.7z/007%20Top%20Agent%2F007JamesBondTopAgent_02C998DC.jar');
});

test('mini SHA-1 lookup reads only a two-character hash prefix bucket', async () => {
  const {run, context} = setup();
  context.lookups = [];
  run(`readGzipJson = async filename => {
    lookups.push(filename);
    return {
      '4014d1fb1cb9e95d58a58c7c3487a079e66baff2': [
        '#.7z','007 Top Agent/007JamesBondTopAgent_02C998DC.jar',
        '%23.7z/007%20Top%20Agent%2F007JamesBondTopAgent_02C998DC.jar']
    };
  };`);
  const result = await run("miniMatchFor('4014d1fb1cb9e95d58a58c7c3487a079e66baff2')");
  assert.equal(result.url,
    'https://archive.org/download/96x65pixels_j2me_mini/%23.7z/' +
    '007%20Top%20Agent%2F007JamesBondTopAgent_02C998DC.jar');
  assert.deepEqual(context.lookups, ['mini/40.json.gz']);
});

test('old JARchive and mini direct links remain independent', async () => {
  const {run, context} = setup();
  run(`miniMatchFor = async () => ({label:'96x65pixels mini', path:'A/Game.jar', url:'https://archive.org/mini'});
       upstreamMatchesFor = async () => [{label:'Original mirror', path:'B/Game.jar', url:'https://archive.org/original'}];`);
  // Use a minimal list object. UI row creation is not needed for this fetch contract.
  context.links = {isConnected:true,childElementCount:0,children:[],append(...items){this.children.push(...items)}};
  run(`downloadSourceRow = (number, label, path, url) => ({number,label,path,url});`);
  await run("appendOptionalDownloads('a'.repeat(40), 'b'.repeat(64), true, false, links)");
  assert.deepEqual(context.links.children.map(x => x.url),
    ['https://archive.org/mini','https://archive.org/original']);
});
