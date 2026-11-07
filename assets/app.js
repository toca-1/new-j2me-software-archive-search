'use strict';
const $ = id => document.getElementById(id);
const root = './data/';
const ARCHIVE = 'https://archive.org/download/96x65pixels_j2me/';
const FILES = ['JARchiveLite_v11.7z', 'JARchive_v11.7z'];
let manifest, mode = 'name', activeResults = [], shown = 0, token = 0, matchedNames = new Map();
let gramMapPromise = null;
const recordCache = new Map(), hashCache = new Map(), nameShardCache = new Map();
const MAX_NAME_CACHE = 24, NAME_WORKERS = 10;
const PAGE_SIZE = 20;
function create(tag, text, className) { const el = document.createElement(tag); if(text !== undefined) el.textContent = String(text); if(className) el.className = className; return el; }
function fmt(n) { return Number(n).toLocaleString('en-US'); }
function size(n) { if(n<1024) return fmt(n)+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KiB'; return (n/1048576).toFixed(2)+' MiB'; }
function status(t) { $('status').textContent = t; }
function urlFor(c, path) {
  // Internet Archive expects the full internal 7z member path as one URL component.
  const member = encodeURIComponent(path).replace(
    /[!'()*]/g,
    ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase()
  );
  return ARCHIVE + encodeURIComponent(FILES[c]) + '/' + member;
}
async function json(path) { const resp = await fetch(root + path); if(!resp.ok) throw new Error(`Failed to load ${path} (HTTP ${resp.status})`); return await resp.json(); }
async function record(id) { const chunk = Math.floor(id/manifest.record_chunk); if(!recordCache.has(chunk)) recordCache.set(chunk,json('records/'+String(chunk).padStart(4,'0')+'.json')); return (await recordCache.get(chunk))[id%manifest.record_chunk]; }
async function lookup(mode, hash) { const key = mode+':'+hash.substring(0,2); if(!hashCache.has(key)) hashCache.set(key, json(mode+'/'+hash.slice(0,2)+'.json').catch(e=>{if(String(e).includes('404')) return {}; throw e;})); return (await hashCache.get(key))[hash]; }
async function gzJson(path) {
  const r = await fetch(root + path);
  if (!r.ok) throw new Error(`Failed to load ${path} (HTTP ${r.status})`);
  // A CDN can serve .gz with or without Content-Encoding: gzip. In the
  // former case the browser may already decompress the response bytes.
  const bytes = await r.arrayBuffer();
  const view = new Uint8Array(bytes);
  let text;
  if (view.length >= 2 && view[0] === 0x1f && view[1] === 0x8b) {
    if (!('DecompressionStream' in window)) throw new Error('Filename search requires a browser supporting gzip DecompressionStream.');
    text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  } else {
    text = new TextDecoder().decode(bytes);
  }
  return JSON.parse(text);
}
async function loadGramMap() {
  if (manifest.name_index_version !== 2 || !manifest.names_grams)
    throw new Error('Filename index is outdated. Rebuild site data with the updated build_site.py.');
  if (!gramMapPromise) gramMapPromise = gzJson(manifest.names_grams).catch(e => { gramMapPromise = null; throw e; });
  return gramMapPromise;
}
function candidateShards(query, grams) {
  const chars = Array.from(query);
  const length = chars.length >= 3 ? 3 : 2;
  const table = grams[String(length)];
  let mask = (1n << BigInt(manifest.names_chunks)) - 1n;
  for (let i = 0; i <= chars.length-length; i++) {
    const hex = table[chars.slice(i,i+length).join('')];
    if (!hex) return [];
    mask &= BigInt('0x' + hex);
    if (mask === 0n) return [];
  }
  const shards = [];
  for (let i = 0; i < manifest.names_chunks; i++)
    if ((mask & (1n << BigInt(i))) !== 0n) shards.push(i);
  return shards;
}
async function loadNameShard(shard) {
  if (!nameShardCache.has(shard)) {
    const promise = gzJson('names/' + String(shard).padStart(3,'0') + '.json.gz').catch(e => {
      nameShardCache.delete(shard); throw e;
    });
    nameShardCache.set(shard, promise);
    // Limit retained lists; in-flight requests still complete normally.
    while (nameShardCache.size > MAX_NAME_CACHE) nameShardCache.delete(nameShardCache.keys().next().value);
  } else {
    const promise = nameShardCache.get(shard);
    nameShardCache.delete(shard);
    nameShardCache.set(shard, promise);
  }
  return await nameShardCache.get(shard);
}
async function searchFilenames(query, current) {
  status('Loading filename search map…');
  const grams = await loadGramMap();
  if (current !== token) return [];
  const shards = candidateShards(query, grams);
  if (!shards.length) return [];
  status(`Searching ${shards.length} relevant filename shard${shards.length===1?'':'s'}…`);
  const found = new Array(shards.length);
  let next = 0, completed = 0;
  const workers = Array.from({length:Math.min(NAME_WORKERS,shards.length)}, async () => {
    while (true) {
      if (current !== token) return;
      const i = next++;
      if (i >= shards.length) return;
      const list = await loadNameShard(shards[i]);
      if (current !== token) return;
      found[i] = list.filter(([name]) => name.includes(query));
      completed++;
      status(`Searching filenames… ${completed}/${shards.length} shards`);
    }
  });
  await Promise.all(workers);
  if (current !== token) return [];
  const unique = new Set();
  for (const matches of found) for (const [name,id] of matches) {
    unique.add(id);
    if (!matchedNames.has(id)) matchedNames.set(id,name);
  }
  return Array.from(unique);
}
function copyButton(text,label='Copy') { const b=create('button', label,'copy'); b.type='button'; b.addEventListener('click', async()=>{try{await navigator.clipboard.writeText(text); b.textContent='Copied'; setTimeout(()=>b.textContent=label,1300)}catch(e){b.textContent='Copy failed'}});return b; }
function hashLine(label,hash) { const row=create('div',undefined,'hashline'); row.append(create('span',label),create('code',hash),copyButton(hash)); return row; }
function renderResult(rec, matchName) {
 const [sha256,sha1,bytes,sources] = rec;
 const card=create('article',undefined,'card'); const head=create('div',undefined,'card-head');
 const title=create('h3',matchName || sources[0][1]); head.append(title,create('span',size(bytes),'size'));card.append(head);
 card.append(hashLine('SHA-1',sha1),hashLine('SHA-256',sha256));
 const list=create('div',undefined,'sources');
 for(const [c,name,path,crc] of sources) {
   const item=create('div',undefined,'source'); const hdr=create('div',undefined,'source-line');
   hdr.append(create('span',c===0?'JARchiveLite':'JARchive Full','pill'));
   if(name!==sources[0][1]) hdr.append(create('span',name,'small'));
   item.append(hdr,create('div',path,'path'));
   const foot=create('div',undefined,'source-line');
   const link=create('a','Open JAR in Internet Archive ↗'); link.href=urlFor(c,path);link.target='_blank';link.rel='noopener noreferrer';
   foot.append(link,copyButton(path,'Copy path'), create('span','CRC32 '+crc,'small'));
   item.append(foot, create('span','Internet Archive can take a minute or longer to prepare this JAR; HTTP 504 means their server is busy. Retry later.','source-delay'));
   list.append(item);
 }
 card.append(list);return card;
}
async function renderMore(current) {
 if(current!==token) return;
 const button=$('more'); button.disabled=true;
 const end=Math.min(shown+PAGE_SIZE,activeResults.length);
 const ids=activeResults.slice(shown,end);
 const values=await Promise.all(ids.map(record));
 if(current!==token) return;
 for(let k=0;k<values.length;k++) $('results').append(renderResult(values[k],matchedNames.get(ids[k])));
 shown=end; button.hidden=shown>=activeResults.length; button.disabled=false;
 button.textContent=`Show more (${fmt(activeResults.length-shown)} remaining)`;
}
async function runSearch() {
 const current=++token; const term=$('query').value.trim();
 $('results').replaceChildren(); $('more').hidden=true; matchedNames = new Map();
 if(!term){status('Enter a search term');return;}
 $('search-form').querySelector('button').disabled=true;
 try {
   let ids=[];
   if(mode==='name') {
     if(Array.from(term).length<2) throw new Error('Please enter at least 2 characters for filename searches.');
     ids = await searchFilenames(term.toLocaleLowerCase(), current);
   } else {
     const valid=mode==='sha1' ? /^[0-9a-f]{40}$/i : /^[0-9a-f]{64}$/i;
     if(!valid.test(term)) throw new Error(`Enter a complete ${mode==='sha1'?'40-character SHA-1':'64-character SHA-256'} hash.`);
     const id=await lookup(mode,term.toLowerCase());
     if(id!==undefined) ids=[id];
   }
   if(current!==token) return;
   activeResults=ids;shown=0;
   if(!ids.length){status('0 matching files');$('results').append(create('div','No files found. Try another filename or hash.','empty'));return;}
   status(`${fmt(ids.length)} unique matching file${ids.length===1?'':'s'}`);
   await renderMore(current);
 } catch(e){ if(current!==token)return;status('Search error');$('results').append(create('div',e.message,'empty')); console.error(e); }
 finally {if(current===token) $('search-form').querySelector('button').disabled=false;}
}
async function init() {
 document.querySelectorAll('[data-mode]').forEach(btn=>btn.addEventListener('click',()=>{
   mode=btn.dataset.mode; document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('active',b===btn);b.setAttribute('aria-pressed',b===btn?'true':'false')});
   $('query').placeholder=mode==='name'?'Game title or filename…':mode==='sha1'?'40-character SHA-1 hash…':'64-character SHA-256 hash…';
   $('hint').textContent=mode==='name'?'Case-insensitive substring search. Downloads only filename shards relevant to your query.':`Exact ${mode.toUpperCase()} lookup loads only a small hash index.`;
   $('query').focus();
 }));
 $('search-form').addEventListener('submit', e=>{e.preventDefault(); runSearch()});
 $('more').addEventListener('click',()=>renderMore(token).catch(e=>{status('Unable to load more results');console.error(e)}));
 try {manifest=await json('manifest.json'); $('unique-count').textContent=fmt(manifest.unique_files);$('entries-count').textContent=fmt(manifest.total_rows);$('shared-count').textContent=fmt(manifest.shared_files);} catch(e){status('Index is not available yet');$('results').replaceChildren(create('div',e.message,'empty'));}
}
init();
