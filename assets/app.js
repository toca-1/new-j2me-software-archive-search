(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const queryInput = $('#query');
  const resultsContainer = $('#results');
  const status = $('#result-status');
  const help = $('#search-help');
  const searchButton = $('#search-button');
  const modes = {filename:$('#mode-filename'),sha:$('#mode-sha')};
  const archiveBase = 'https://archive.org/download/j2me-archive-unified-2019-09/';
  const archivePrefix = 'j2me-archive-unified-2019-09.7z.';
  const resultCache = new Map();
  let manifest, mode='filename', worker, pendingId=0, debounce;

  async function getJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw Error(`Failed to load ${url}: HTTP ${response.status}`);
    return response.json();
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function statusText(text) { status.textContent = text; }
  function clearResults(message) {
    resultsContainer.replaceChildren(el('div','empty-state',message));
  }
  function shellQuote(text) { return "'" + text.replaceAll("'", "'\\''") + "'"; }
  async function copy(value, button) {
    await navigator.clipboard.writeText(value);
    const original = button.textContent;
    button.textContent = 'Copied!';
    setTimeout(() => { button.textContent = original; }, 1350);
  }
  function copyButton(label, text) {
    const button = el('button','button-inline',label);
    button.type='button';
    button.addEventListener('click',()=>copy(text, button).catch(err=>statusText(`Copy failed: ${err.message}`)));
    return button;
  }
  function addPartLinks(root, partNumbers) {
    const container=el('div','part-links');
    for (const part of partNumbers) {
      const name = archivePrefix+part+(part==='001'?'.zip':'');
      const a=el('a','',part==='001'?'001.zip':part);
      a.href=archiveBase+name;
      a.target='_blank'; a.rel='noopener noreferrer'; a.title=name;
      container.append(a);
    }
    root.append(container);
  }
  function makeCommand(path, sha, parts) {
    const url = new URL('j2me_fetch.py',document.baseURI).href;
    return `# On Ubuntu: sudo apt install python3 curl 7zip\ncurl -fL -o j2me_fetch.py ${shellQuote(url)}\npython3 j2me_fetch.py --parts ${parts.join(',')} --path ${shellQuote(path)} --sha1 ${sha}`;
  }
  function createResult(record) {
    const [name,path,size,sha,block,required] = record;
    const partNumbers=required.split(',');
    const card=el('article','result');
    const top=el('div','result-top');
    const left=el('div');
    left.append(el('h3','',name),el('div','path',path));
    const chip=el('span','pill',`${(size/1024).toLocaleString(undefined,{maximumFractionDigits:1})} KiB`);
    top.append(left,chip); card.append(top);
    const details=el('div','details');
    const blk=el('div','meta');
    blk.append(el('span','','Solid block '),el('strong','',String(block).padStart(2,'0')));
    const parts=el('div','meta');
    parts.append(el('span','','Required parts: '),el('strong','',partNumbers.map(p=>p==='001'?'001.zip':p).join(', ')));
    details.append(blk,parts); card.append(details);
    const hash=el('div','hash-row');
    hash.append(el('code','',sha),copyButton('Copy SHA-1',sha),copyButton('Copy path',path));
    card.append(hash);
    const disclosure=el('details');
    disclosure.append(el('summary','','Show download & extraction instructions'));
    const recovery=el('div','recovery');
    recovery.append(el('p','meta','Direct links to the required archive volumes:'));
    addPartLinks(recovery,partNumbers);
    const command=makeCommand(path,sha,partNumbers);
    recovery.append(el('pre','',command));
    const actions=el('div','recovery-actions');
    actions.append(copyButton('Copy complete command',command));
    const helper=el('a','button-inline','Download Python helper');
    helper.href='j2me_fetch.py';helper.download='j2me_fetch.py';
    actions.append(helper);recovery.append(actions);
    recovery.append(el('p','note','Run on Ubuntu/Linux. The helper downloads the real parts, creates correctly sized sparse placeholders for the missing ones, extracts only this file, and verifies its SHA-1. The first numbered part is distributed as a ZIP wrapper.'));
    disclosure.append(recovery);card.append(disclosure);
    return card;
  }
  async function getRecord(id) {
    const chunk=Math.floor(id/manifest.record_chunk_size);
    if (!resultCache.has(chunk)) {
      const file=`data/records/${String(chunk).padStart(4,'0')}.json`;
      const promise=getJson(file).catch(error => { resultCache.delete(chunk); throw error; });
      resultCache.set(chunk,promise);
    }
    const data=await resultCache.get(chunk);
    const record=data[id % manifest.record_chunk_size];
    if (!record) throw Error(`Record ${id} missing from chunk ${chunk}`);
    return record;
  }
  async function renderMatches(ids,total,id) {
    if (id!==pendingId) return;
    statusText(`Found ${total.toLocaleString()} file${total===1?'':'s'}`);
    if (!ids.length) {clearResults('No matching files found.');return;}
    const info=el('div','micro',total>ids.length?`Showing the first ${ids.length} alphabetically. Refine your query for more results.`:`Showing all ${ids.length} matching results.`);
    const list=el('div','results');
    resultsContainer.replaceChildren(info,list);
    const values=await Promise.all(ids.map(getRecord));
    if (id!==pendingId) return;
    list.replaceChildren(...values.map(createResult));
  }
  function ensureWorker() {
    if (worker) return;
    worker=new Worker('assets/name-worker.js');
    worker.postMessage({type:'init',manifest});
    worker.onmessage = async ({data}) => {
      if (data.type==='progress' && mode==='filename') {
        statusText(`Loading filename catalog: ${data.loaded}/${data.total} chunks`);
      } else if (data.type==='error' && data.id===pendingId) {
        statusText('Search failed');clearResults(data.message);
      } else if (data.type==='results' && data.id===pendingId) {
        try{await renderMatches(data.ids,data.total,data.id);}catch(e){statusText('Error');clearResults(e.message);}
      }
    };
    worker.onerror=(e)=>{statusText('Search error');clearResults(e.message);};
  }
  async function searchNow() {
    if (!manifest) return;
    const id=++pendingId;
    const query=queryInput.value.trim();
    if (!query) {statusText('Enter a search above');clearResults('Enter a filename or a SHA-1 hash.');return;}
    if (mode==='sha') {
      if (!/^[\da-fA-F]{40}$/.test(query)) {
        statusText('SHA-1 must contain 40 hexadecimal characters');clearResults('Enter a complete 40-character SHA-1 hash.');return;
      }
      statusText('Checking hash index…');
      try {
        const lowered=query.toLowerCase();
        const entries=await getJson(`data/hashes/${lowered.slice(0,2)}.json`);
        if(id!==pendingId)return;
        const found=Object.prototype.hasOwnProperty.call(entries,lowered)?[entries[lowered]]:[];
        await renderMatches(found,found.length,id);
      }catch(error){if(id===pendingId){statusText('Error');clearResults(error.message);}}
    } else {
      if (query.length<2){statusText('Enter at least 2 characters');clearResults('Use at least two characters for a filename search.');return;}
      ensureWorker();
      statusText('Searching filenames…');
      worker.postMessage({type:'search',query,id});
    }
  }
  function changeMode(newMode) {
    if(mode===newMode)return;
    mode=newMode;
    for (const [name,button] of Object.entries(modes)) {
      button.classList.toggle('active',name===mode);
      button.setAttribute('aria-pressed',name===mode?'true':'false');
    }
    queryInput.placeholder=mode==='filename'?'e.g. Coca-Cola or Need for Speed':'Paste a complete 40-character SHA-1 hash';
    help.textContent=mode==='filename'?'Case-insensitive substring search. First filename search downloads a compressed filename catalog.':'Exact SHA-1 lookup. Only a small hash index is downloaded.';
    queryInput.value='';
    ++pendingId;
    statusText('Enter a search above');
    clearResults('Enter a search above to see matching files.');
    queryInput.focus();
  }
  Object.entries(modes).forEach(([name,button])=>button.addEventListener('click',()=>changeMode(name)));
  queryInput.addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(searchNow,350);});
  queryInput.addEventListener('keydown',e=>{if(e.key==='Enter'){clearTimeout(debounce);searchNow();}});
  searchButton.addEventListener('click',()=>{clearTimeout(debounce);searchNow();});
  getJson('data/manifest.json').then(data=>{
    manifest=data;
    $('#record-count').textContent=data.records.toLocaleString();
  }).catch(error=>{
    statusText('Index files not built');
    clearResults(`Search data is missing. Generate it first using build_site.py. (${error.message})`);
  });
})();
