/* Separate worker: filename substring scanning doesn't block the page UI. */
let chunks;
let loading;
let config;

async function unzipText(url) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`Could not load ${url} (${response.status})`);
  if (typeof DecompressionStream === 'undefined') throw Error('This browser does not support DecompressionStream. Use a recent Chrome, Firefox or Safari.');
  // .bin intentionally has no server-side Content-Encoding header.
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function ensureLoaded() {
  if (chunks) return;
  if (!loading) loading = (async () => {
    const completed = [];
    for (let start = 0; start < config.name_chunks; start += 4) {
      const end = Math.min(start + 4, config.name_chunks);
      const batch = await Promise.all(Array.from({length:end-start}, (_,i)=>start+i).map(async i => {
        const text = await unzipText(`../data/names/${String(i).padStart(3,'0')}.bin`);
        return JSON.parse(text);
      }));
      completed.push(...batch);
      self.postMessage({type:'progress', loaded:end, total:config.name_chunks});
    }
    chunks = completed;
  })();
  return loading;
}

self.onmessage = async ({data}) => {
  try {
    if (data.type === 'init') { config = data.manifest; return; }
    if (data.type !== 'search') return;
    if (!config) throw Error('Search index not initialized');
    await ensureLoaded();
    const query = data.query.toLowerCase();
    const ids = [];
    let total = 0;
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      const base = c * config.name_chunk_size;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i].includes(query)) {
          total++;
          if (ids.length < config.search_limit) ids.push(base+i);
        }
      }
    }
    self.postMessage({type:'results', id:data.id, ids, total});
  } catch (error) {
    self.postMessage({type:'error', id:data.id, message:String(error.message || error)});
  }
};
