// Runs a packed game (tools/pack.mjs) in this page. Parts are fetched once from the CDN and kept
// in Cache Storage; the engine binaries are rebuilt from them as Blob URLs, so nothing but
// static files is needed. One engine per page: leaving a game means reloading.
//
//   const engine = await launchEngine({ canvas, packs: 'https://…/packs/', manifest: 'portal/manifest-….json', map, args })
//
// The page must be cross-origin isolated (the engine uses threads); see coi-sw.js.

const CACHE = 'gamebox-parts-v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (res.ok) return res;
      if (res.status === 404 || i >= tries - 1) throw new Error(`${res.status} for ${url}`);
    } catch (error) {
      if (i >= tries - 1) throw error;
    }
    await sleep(500 * 2 ** i);
  }
}

async function gunzip(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

// Cache Storage can be unavailable (private windows, blocked site data); fall back to network.
async function openCache() {
  try {
    return await caches.open(CACHE);
  } catch {
    return null;
  }
}

export function partStore(packsUrl, game, { onBytes } = {}) {
  const cachePromise = openCache();
  const inflight = new Map();
  const urlOf = (hash) => new URL(`${game}/${hash}.bin`, packsUrl).href;

  const get = (hash) => {
    if (inflight.has(hash)) return inflight.get(hash);
    const p = (async () => {
      const url = urlOf(hash);
      const cache = await cachePromise;
      let res = cache && (await cache.match(url).catch(() => null));
      if (!res) {
        res = await fetchRetry(url);
        const body = await res.arrayBuffer();
        onBytes?.(body.byteLength);
        if (cache) cache.put(url, new Response(body.slice(0))).catch(() => {});
        return gunzip(body);
      }
      return gunzip(await res.arrayBuffer());
    })();
    inflight.set(hash, p);
    p.finally(() => inflight.delete(hash));
    return p;
  };

  // Which of the given hashes are already cached (for "downloaded" badges and storage UI).
  const cached = async (hashes) => {
    const cache = await cachePromise;
    if (!cache) return new Set();
    const keys = new Set((await cache.keys()).map((r) => r.url));
    return new Set(hashes.filter((h) => keys.has(urlOf(h))));
  };

  return { get, cached, urlOf };
}

function sliceFile(manifest, file, parts) {
  const [, stream, offset, size] = file;
  const part = manifest.partSize;
  const out = new Uint8Array(size);
  let written = 0;
  for (let i = Math.floor(offset / part); written < size; i++) {
    const bytes = parts.get(`${stream}:${i}`);
    const start = Math.max(offset - i * part, 0);
    const end = Math.min(offset + size - i * part, bytes.length);
    out.set(bytes.subarray(start, end), written);
    written += end - start;
  }
  return out;
}

async function loadFiles(manifest, store, ids, onProgress) {
  const wanted = new Map();
  for (const id of ids) {
    const [, stream, offset, size] = manifest.files[id];
    for (let i = Math.floor(offset / manifest.partSize); i <= Math.floor((offset + Math.max(size, 1) - 1) / manifest.partSize); i++) {
      wanted.set(`${stream}:${i}`, manifest.streams[stream][i]);
    }
  }
  const parts = new Map();
  let done = 0;
  const queue = [...wanted];
  const next = async () => {
    while (queue.length) {
      const [key, hash] = queue.shift();
      parts.set(key, new Uint8Array(await store.get(hash)));
      onProgress?.(++done, wanted.size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, next));
  return ids.map((id) => sliceFile(manifest, manifest.files[id], parts));
}

export async function launchEngine({
  canvas,
  packs,
  manifest: manifestRef,
  map,
  args = [],
  onProgress,
  onStatus,
  onMiss,
  onExit,
  print = (...a) => console.log(...a),
}) {
  if (!crossOriginIsolated) throw new Error('This page is not cross-origin isolated, so the engine cannot use threads.');
  if (globalThis.Module?.gbStarted) throw new Error('An engine is already running in this page.');

  onStatus?.('Reading game index');
  const manifest = await (await fetchRetry(new URL(manifestRef, packs).href)).json();
  const store = partStore(packs, manifest.game);

  onStatus?.('Loading engine');
  const names = Object.keys(manifest.engine);
  const binaries = await loadFiles(manifest, store, names.map((n) => manifest.engine[n]), (d, t) => onProgress?.('Engine', d, t));
  const urls = {};
  let engineJs = '';
  names.forEach((name, i) => {
    if (name.endsWith('.js')) engineJs = new TextDecoder().decode(binaries[i]);
    else urls[name] = URL.createObjectURL(new Blob([binaries[i]], { type: name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' }));
  });

  const fullArgs = [...args, ...(map ? ['+map', map] : [])];
  // The worker copy carries only JSON-safe fields; functions stay on the main thread.
  const shared = { game: manifest.mod, args: fullArgs, manifest };
  globalThis.gbConfig = {
    ...shared,
    part: (hash) => store.get(hash),
    onProgress,
    onStatus,
    onMiss,
  };

  const worker = new Blob([`self.gbConfig = ${JSON.stringify(shared)};\n`, engineJs], { type: 'text/javascript' });
  globalThis.Module = {
    gbStarted: true,
    canvas,
    mainScriptUrlOrBlob: worker,
    locateFile: (name) => urls[name] ?? name,
    print,
    printErr: (...a) => print('[err]', ...a),
    setStatus: () => {},
    onAbort: (what) => onExit?.({ error: String(what) }),
    onExit: (code) => onExit?.({ code }),
  };

  const script = document.createElement('script');
  script.src = URL.createObjectURL(new Blob([engineJs], { type: 'text/javascript' }));
  document.body.append(script);

  return {
    manifest,
    store,
    // Flush saves and config to IndexedDB (also done every few seconds and on pagehide).
    persist: () => globalThis.Module.gbPersist?.(),
  };
}
