// Single-threaded Xash3D host. Parts/cache/manifest match the Source pack format.
import { partStore } from './engine-host.js';
let started = false;

async function visitFiles(manifest, store, ids, consume, progress) {
 const byStream = new Map();
 for (const id of ids) { const f = manifest.files[id]; if (!byStream.has(f[1])) byStream.set(f[1], []); byStream.get(f[1]).push(f); }
 let done = 0;
 const total = [...byStream.keys()].reduce((n,s) => n + manifest.streams[s].length,0);
 for (const [sid, entries] of byStream) {
  entries.sort((a,b) => a[2]-b[2]); let fi = 0, target, written = 0;
  for (let pi=0; pi<manifest.streams[sid].length; pi++) {
   const part = new Uint8Array(await store.get(manifest.streams[sid][pi]));
   const start = pi * manifest.partSize, end = start + part.length;
   while (fi < entries.length) {
    const f = entries[fi], offset = f[2], size = f[3];
    if (offset >= end && size) break;
    target ??= new Uint8Array(size);
    const a = Math.max(offset,start), b = Math.min(offset+size,end);
    if (b>a) { target.set(part.subarray(a-start,b-start),written); written += b-a; }
    if (written < size) break;
    await consume(f[0], target); target = undefined; written=0; fi++;
   }
   progress?.(++done,total);
  }
  if (fi !== entries.length) throw new Error('Incomplete Xash pack stream');
 }
}

export async function launchGame({ canvas, packs, manifest: ref, args = [], map, onStatus, onProgress, onExit }) {
 if (started) throw new Error('Reload the page before starting another game.');
 started = true;
 onStatus?.('Reading Xash pack');
 const response = await fetch(new URL(ref,packs));
 if (!response.ok) throw new Error(`Pack manifest: HTTP ${response.status}`);
 const manifest = await response.json(), store = partStore(packs,manifest.game);
 const binaries = new Map();
 await visitFiles(manifest,store,Object.values(manifest.engine),(name,data) => binaries.set(name,data),(d,t) => onProgress?.('Engine',d,t));
 const js = new TextDecoder().decode(binaries.get('xash.js')); binaries.delete('xash.js');
 const scriptURL = URL.createObjectURL(new Blob([js],{type:'text/javascript'}));
 await new Promise((resolve,reject) => { const s=document.createElement('script'); s.src=scriptURL; s.onload=resolve; s.onerror=reject; document.head.append(s); });
 URL.revokeObjectURL(scriptURL);
 let wasm = binaries.get('xash.wasm'); binaries.delete('xash.wasm');
 canvas.tabIndex = 0;
 const focus = () => { canvas.focus(); canvas.requestPointerLock?.(); };
 canvas.addEventListener('click',focus);
 canvas.addEventListener('contextmenu',e=>e.preventDefault());
 const factory = globalThis.createXash;
 if (!factory) throw new Error('Xash factory was not exported');
 let rejectLoading;
 const failure = new Promise((_,reject)=> { rejectLoading=reject; });
 const libraryURLs = new Map([...binaries].map(([name,data])=>["/game/"+name,URL.createObjectURL(new Blob([data],{type:"application/wasm"}))]));
 const loading = factory({
  locateFile: name => libraryURLs.get(name) ?? name,
  canvas, wasmBinary:wasm, noInitialRun:true,
  dynamicLibraries:[...binaries.keys()].filter(n=>n.endsWith('.wasm')).map(n=>'/game/'+n),
  arguments:[],
  print: (...a)=>console.log('[xash]',...a), printErr:(...a)=>console.warn('[xash]',...a),
  onAbort: error => { const e=new Error(String(error)); rejectLoading(e); onExit?.({error:e.message}); },
  onExit:code=>onExit?.({code}),
  preRun:[function(Module) {
   // Pack assets stay in MEMFS; only the writable overlay is synchronized.
   const userRoot = `/xash-user/${manifest.game}`;
   const writable = `${userRoot}/${manifest.mod}`;
   Module.ENV.XASH3D_BASEDIR=userRoot;
   Module.ENV.XASH3D_RODIR='/game';
   const FS=Module.FS;
   const write = (name,data) => { const full='/game/'+name; FS.mkdirTree(full.slice(0,full.lastIndexOf('/'))); FS.writeFile(full,data,{canOwn:true}); };
   FS.mkdirTree('/game'); FS.mkdirTree(writable); FS.chdir('/game');
   FS.mount(Module.IDBFS,{autoPersist:true},writable);
   for (const [name,data] of binaries) write(name,data);
   binaries.clear();
   Module.addRunDependency('gamebox-data');
   onStatus?.('Restoring saves and loading files');
   const restore = new Promise((resolve,reject)=>FS.syncfs(true,error=>error?reject(error):resolve()));
   Promise.all([restore, visitFiles(manifest,store,manifest.base,write,(d,t)=>onProgress?.(manifest.game,d,t))]).then(()=>{
    const config = `${writable}/config.cfg`;
    if (!FS.analyzePath(config).exists) FS.writeFile(config,'exec default.cfg\nfps_max 60\ncl_showfps 0\ntouch_enable 0\n');
    // Serialize explicit flushes. autoPersist queues writes after file closes and renames;
    // the timer/lifecycle flush also captures changes to open files.
    let pending = Promise.resolve();
    Module.gbPersist = () => pending = pending.catch(()=>{}).then(()=>new Promise((resolve,reject)=>{
     if (Module.gbEngineRunning) Module.ccall('GameBox_WriteConfig',null,[],[]);
     FS.syncfs(false,error=>error?reject(error):resolve());
    }));
    const flush = () => Module.gbPersist().catch(error=>console.error('Xash IndexedDB write failed',error));
    setInterval(flush,5000);
    addEventListener('pagehide',flush);
    addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden') flush();});
    Module.gbWritable = writable;
    Module.removeRunDependency('gamebox-data');
   }).catch(error=>{rejectLoading(error); onExit?.({error:`Could not restore saves/load data: ${error.message}`});});
  }],
 });
 const module = await Promise.race([loading,failure]);
 // Emscripten keeps the supplied binary on Module after compilation unless released.
 module.wasmBinary = undefined; wasm = undefined;
 for(const url of libraryURLs.values()) URL.revokeObjectURL(url);
 libraryURLs.clear();
 globalThis.xashModule=module;
 onStatus?.(`Starting ${manifest.game}`);
 const fullArgs=['-game',manifest.mod,'-menulib','/game/libmenu.wasm','-clientlib',`/game/${manifest.mod}/cl_dlls/client_emscripten_wasm32.wasm`,'-dll',`/game/${manifest.mod}/dlls/hl_emscripten_wasm32.wasm`,'-ref','gles3compat','-windowed','-width',String(canvas.width),'-height',String(canvas.height),'-nojoy','-nointro','-dev','1','-log','+developer','0',...args,...(map?['+map',map]:[])];
 module.callMain(fullArgs);
 module.gbEngineRunning = true;
 // The main-loop callback is registered by callMain before it returns.
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 onStatus?.('Running'); onProgress?.('Ready',1,1); canvas.focus();
 return { manifest,store,module,persist:()=>module.gbPersist(),command:cmd=>module.ccall('GameBox_Command',null,['string'],[cmd+'\n']), memory:()=>({wasm:module.HEAPU8.buffer.byteLength,js:performance.memory?.usedJSHeapSize}) };
}
