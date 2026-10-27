// Single-player adapter for the user's existing .NET/FNA browser build.
import { partStore } from './engine-host.js';
import { syncUnlockedAchievements } from './activity.js';

// Terraria keeps achievements in <save path>/achievements.dat: BSON, AES-CBC with a fixed key
// that doubles as the IV. An achievement is unlocked once every one of its conditions is.
function readBson(bytes, at = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = {};
  const end = at + view.getInt32(at, true); at += 4;
  const cstring = () => { const stop = bytes.indexOf(0, at), text = new TextDecoder().decode(bytes.subarray(at, stop)); at = stop + 1; return text; };
  while (at < end - 1) {
    const type = bytes[at++], name = cstring();
    if (type === 3 || type === 4) { out[name] = readBson(bytes, at); at += view.getInt32(at, true); }
    else if (type === 8) out[name] = !!bytes[at++];
    else if (type === 1) { out[name] = view.getFloat64(at, true); at += 8; }
    else if (type === 16) { out[name] = view.getInt32(at, true); at += 4; }
    else if (type === 18) { out[name] = Number(view.getBigInt64(at, true)); at += 8; }
    else if (type === 2) { const n = view.getInt32(at, true); out[name] = new TextDecoder().decode(bytes.subarray(at + 4, at + 3 + n)); at += 4 + n; }
    else if (type === 10) out[name] = null;
    else throw new Error(`BSON type ${type}`);
  }
  return out;
}
async function unlockedAchievements(FS) {
  const find = (dir) => {
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const full = `${dir}/${name}`;
      if (FS.isDir(FS.stat(full).mode)) { const hit = find(full); if (hit) return hit; }
      else if (name === 'achievements.dat') return full;
    }
  };
  const file = find('/saves');
  if (!file) return [];
  const raw = new TextEncoder().encode('RELOGIC-TERRARIA');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
  const bson = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: raw }, key, FS.readFile(file)));
  return Object.entries(readBson(bson)).filter(([, a]) => {
    const conditions = Object.values(a?.Conditions ?? {});
    return conditions.length && conditions.every((c) => c?.Completed);
  }).map(([name]) => name);
}
const MIME = { js: 'text/javascript', wasm: 'application/wasm', dat: 'application/octet-stream' };
export async function launchGame({ canvas, packs, manifest: ref, args = [], onStatus, onProgress, onExit }) {
  if (globalThis.terrariaFS) throw new Error('Reload before starting another game.');
  canvas.style.outline = 'none';
  const response = await fetch(new URL(ref, packs));
  if (!response.ok) throw new Error(`Terraria manifest: ${response.status}`);
  const manifest = await response.json();
  const store = partStore(packs, manifest.game);
  const urls = new Map();
  const readStream = async (sid) => {
    const hashes = manifest.streams[sid];
    const parts = [];
    for (const hash of hashes) parts.push(new Uint8Array(await store.get(hash)));
    if (parts.length === 1) return parts[0];
    const raw = new Uint8Array(parts.reduce((s,p) => s+p.length,0));
    let at=0; for (const p of parts) { raw.set(p,at); at+=p.length; }
    return raw;
  };
  const entries = (sid) => manifest.files.filter(f => f[1] === sid);
  onStatus?.('Loading Terraria engine');
  const files = new Map();
  for (const sid of new Set(Object.values(manifest.engine).map(id => manifest.files[id][1]))) {
    const raw = await readStream(sid);
    for (const [name,,off,size] of entries(sid)) files.set(name, raw.subarray(off,off+size));
  }
  const blobUrl = (name) => {
    if (!urls.has(name)) {
      if (!files.has(name)) throw new Error(`Missing runtime file ${name}`);
      urls.set(name,URL.createObjectURL(new Blob([files.get(name)],{type:MIME[name.split('.').pop()] || 'application/octet-stream'})));
    }
    return urls.get(name);
  };
  // Each Opus cue is fetched only when played. No complete music bank in page memory.
  const tracks = new Map();
  const musicTrack = (name) => {
    if (tracks.has(name)) return tracks.get(name);
    const id = manifest.music[name];
    if (id === undefined) return null;
    const t = { el: new Audio(), state: 'stopped' };
    t.el.preservesPitch = false;
    t.ready = (async () => {
      const [,sid,off,size] = manifest.files[id];
      const raw = await readStream(sid);
      t.el.src = URL.createObjectURL(new Blob([raw.subarray(off,off+size)],{type:'audio/ogg'}));
    })();
    tracks.set(name,t); return t;
  };
  globalThis.terrariaMusic = {
    tracks, available: () => Object.keys(manifest.music).length > 0,
    play(name) { const t=musicTrack(name); if (!t) return; t.state='playing'; t.ready.then(() => { if(t.state==='playing') { t.el.currentTime=0; t.el.play().catch(()=>{}); } }).catch(console.warn); },
    stop(name) { const t=tracks.get(name); if(t) { t.el.pause(); t.state='stopped'; } },
    pause(name) { const t=tracks.get(name); if(t && t.state==='playing') { t.el.pause(); t.state='paused'; } },
    resume(name) { const t=tracks.get(name); if(t && t.state==='paused') { t.state='playing'; t.ready.then(()=>t.el.play()).catch(()=>{}); } },
    isPlaying: name => { const t=tracks.get(name); return !!t && t.state==='playing' && !t.el.ended; },
    isPaused: name => tracks.get(name)?.state==='paused',
    setVolume(name,v) { const t=tracks.get(name); if(t) t.el.volume=Math.max(0,Math.min(1,v)); },
    setRate(name,v) { const t=tracks.get(name); if(t) t.el.playbackRate=Math.max(.25,Math.min(4,v)); },
  };
  globalThis.__dotnetBaseUrl = 'https://terraria.invalid/_framework/dotnet.js';
  const { dotnet } = await import(blobUrl('dotnet.js'));
  const runtime = await dotnet
    .withConfig({ disableIntegrityCheck: true, disableNoCacheFetch: true })
    .withModuleConfig({ canvas })
    .withEnvironmentVariable('MONO_LOG_LEVEL','warning')
    .withResourceLoader((type,name,defaultUri) => {
      if (['dotnetjs','js-module-native','js-module-runtime','js-module-threads'].includes(type)) return blobUrl(name);
      const key=type==='resource' ? defaultUri.split('/').slice(-2).join('/') : name;
      const bytes=files.get(key)||files.get(name);
      return bytes ? Promise.resolve(new Response(bytes,{headers:{'content-type':MIME[name.split('.').pop()]||'application/octet-stream'}})) : undefined;
    }).create();
  const { Module } = runtime;
  // ABI-only stubs for imports still present in the prebuilt assembly. No sockets,
  // signaling, lobby implementation, listener, or background host tick is installed.
  const unavailable = () => { throw new Error('This GameBox port supports single-player only.'); };
  runtime.setModuleImports('terraria-net',{ send:unavailable,available:()=>0,isOpen:()=>false,close:()=>{},read:()=>0 });
  runtime.setModuleImports('terraria-lobby',{
    start:()=>{},count:()=>0,name:()=>'',world:()=>'',players:()=>0,max:()=>0,
    join:()=>false,joinState:()=>-1,joinConn:()=>0,joinError:()=> 'Single-player only',cancel:()=>{},
    hostStart:unavailable,hostPoll:()=>0,hostPlayers:()=>{},hostStop:()=>{},
  });
  files.clear();
  const FS = Module.FS;
  FS.mkdirTree('/saves');
  FS.mount(Module.IDBFS || FS.filesystems.IDBFS,{},'/saves');
  await new Promise((res,rej)=>FS.syncfs(true,e=>e?rej(e):res()));
  let syncing=false, again=false;
  const flush=()=>{
    unlockedAchievements(FS).then(names=>syncUnlockedAchievements('terraria',names)).catch(e=>console.warn('Terraria achievements unreadable',e));
    if(syncing) { again=true; return; } syncing=true;
    globalThis.__terrariaSaving=true;
    FS.syncfs(false,e=>{ syncing=false; if(e) console.warn('Terraria save sync failed',e); if(again) { again=false; flush(); } else globalThis.__terrariaSaving=false; });
  };
  runtime.setModuleImports('terraria-storage',{flush});
  setInterval(flush,10000);
  addEventListener('visibilitychange',()=>{if(document.hidden) flush();});
  addEventListener('pagehide',flush);
  globalThis.terrariaFlushSaves=flush;
  globalThis.terrariaFS=FS;
  const contentStreams=[...new Set(manifest.base.map(id=>manifest.files[id][1]))];
  let done=0;
  for(const sid of contentStreams) {
    onStatus?.(`Loading Terraria assets ${done+1}/${contentStreams.length}`);
    const raw=await readStream(sid);
    for(const [name,,off,size] of entries(sid)) {
      const slash=name.lastIndexOf('/'); const dir='/'+name.slice(0,slash);
      FS.mkdirTree(dir);
      FS.createDataFile(dir,name.slice(slash+1),raw.subarray(off,off+size),true,false,true);
    }
    // Use Engine until frames are ready: player.html otherwise hides the overlay early.
    onProgress?.('Engine',++done,contentStreams.length);
  }
  FS.chdir('/');
  // Keep resolution bounded on high-DPI Chromebooks; native game handles resize.
  canvas.width=Math.min(innerWidth,1280); canvas.height=Math.min(innerHeight,720);
  onStatus?.('Starting Terraria');
  const exports=await runtime.getAssemblyExports('Terraria');
  const game=exports.Terraria.BrowserMain;
  await runtime.runMain(); game.Start(args);
  globalThis.terrariaStats=()=>game.Stats();
  globalThis.terrariaPrepPlayer=name=>game.PrepareTestPlayer(name);
  globalThis.terrariaMemory=()=>({wasmMB:Module.HEAPU8.length/1048576,jsHeapMB:(performance.memory?.usedJSHeapSize||0)/1048576,game:game.MemoryReport(),textures:game.TextureReport()});
  globalThis.__terrariaFrames=0;
  addEventListener('beforeunload',e=>{if(globalThis.__terrariaInWorld||globalThis.__terrariaSaving){e.preventDefault(); e.returnValue='';}});
  return await new Promise((resolve,reject)=>{
    const frame=()=>{
      try {
        game.Frame(); globalThis.__terrariaFrames++;
        if(globalThis.__terrariaFrames%30===0) globalThis.__terrariaInWorld=game.InWorld();
        if(globalThis.__terrariaFrames===3) { onProgress?.('Terraria',1,1); canvas.focus(); resolve({manifest,persist:flush}); }
        requestAnimationFrame(frame);
      } catch(error) { onExit?.({error:String(error)}); reject(error); }
    }; requestAnimationFrame(frame);
  });
}
