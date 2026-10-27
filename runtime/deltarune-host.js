// Butterscotch WAD17 / DELTARUNE Chapters 1–5. No network outside static packs.
import { partStore } from './engine-host.js';
export async function launchGame({canvas,packs,manifest:ref,map,args=[],onStatus,onProgress,onExit}) {
 if(typeof WebAssembly.Suspending!=='function'||typeof WebAssembly.promising!=='function')throw new Error('DELTARUNE needs a Chrome version with WebAssembly JSPI support.');
 if(globalThis.gbDeltarune)throw new Error('DELTARUNE is already running; reload to restart.');
 const response=await fetch(new URL(ref,packs));if(!response.ok)throw new Error(`DELTARUNE manifest: HTTP ${response.status}`);
 const manifest=await response.json(),store=partStore(packs,manifest.game);
 // One file per stream lets us release raw chunks immediately after writing each file.
 async function readFile(id){const [,stream,offset,size]=manifest.files[id],out=new Uint8Array(size);let written=0;
  for(let i=Math.floor(offset/manifest.partSize);written<size;i++){const part=new Uint8Array(await store.get(manifest.streams[stream][i]));const start=Math.max(0,offset-i*manifest.partSize),count=Math.min(size-written,part.length-start);if(count<=0)throw new Error('Invalid DELTARUNE pack span');out.set(part.subarray(start,start+count),written);written+=count}return out;}
 onStatus?.('Loading DELTARUNE runner');
 const js=await readFile(manifest.engine['butterscotch.mjs']),wasm=await readFile(manifest.engine['butterscotch.wasm']);
 const url=URL.createObjectURL(new Blob([js],{type:'text/javascript'}));let create;
 try{create=(await import(url)).default}finally{URL.revokeObjectURL(url)}
 const runner=await create({canvas,wasmBinary:wasm,locateFile:name=>new URL(name,packs).href,print:(...a)=>console.log('[deltarune]',...a),printErr:(...a)=>console.warn('[deltarune]',...a),onAbort:s=>onExit?.({error:String(s||'runner aborted')})});
 globalThis.gbDeltarune=runner;
 let saveFolder='/saves';
 try{if(await runner.ccall('mountOpfs','number',[],[],{async:true})===0)saveFolder='/butterscotch/gamebox-deltarune-saves'}catch(e){console.warn('Persistent saves unavailable',e)}
 if(saveFolder==='/saves')runner.FS.mkdirTree(saveFolder);
 const loaded=new Set(),loadedGroups=new Set();
 async function loadGroup(group){
  if(loadedGroups.has(group))return;
  const ids=manifest.groups?.[group]??(group==='selector'?manifest.base:[]);
  for(let i=0;i<ids.length;i++){const id=ids[i];if(loaded.has(id))continue;const name=manifest.files[id][0],dest='/game/'+name;onStatus?.('Loading '+name);runner.FS.mkdirTree(dest.slice(0,dest.lastIndexOf('/')));runner.FS.writeFile(dest,await readFile(id));loaded.add(id);onProgress?.(group,i+1,ids.length)}
  loadedGroups.add(group);
 }
 const filesByName=new Map(manifest.files.map((f,id)=>[f[0],id]));
 runner.gameboxEnsureFile=async path=>{
  const name=new URL(path.replaceAll('\\','/'),'https://gamebox.invalid/').pathname.replace(/^\/game\//,'');
  const id=filesByName.get(name);if(id===undefined||loaded.has(id)||!name.startsWith('mus/'))return;
  const dest='/game/'+name;runner.FS.mkdirTree(dest.slice(0,dest.lastIndexOf('/')));runner.FS.writeFile(dest,await readFile(id));loaded.add(id);
 };
 runner.gameboxPrepareChapter=async path=>{
  const chapter=path.match(/chapter([1-5])_windows\/data\.win$/)?.[1];
  await loadGroup(chapter?'chapter'+chapter:'selector');

  // Old chapter files can be fetched again from Cache Storage; release MEMFS backing storage.
  for(const group of [...loadedGroups])if(/^chapter/.test(group)&&group!=='chapter'+chapter){
   for(const id of manifest.groups[group]){try{runner.FS.unlink('/game/'+manifest.files[id][0])}catch{}loaded.delete(id)}loadedGroups.delete(group);
  }
 };
 await loadGroup('selector');
 // Chapters pick ../mus/ only when that folder exists; its tracks download on first open.
 runner.FS.mkdirTree('/game/mus');
 const chapter=/^[1-5]$/.test(String(map))?String(map):null;
 const entry=chapter?`chapter${chapter}_windows/data.win`:manifest.entry;
 const held=new Set(),key=e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;e.preventDefault();if(e.type==='keydown'){if(!e.repeat){held.add(e.keyCode);runner._onKeyDown(e.keyCode)}}else{held.delete(e.keyCode);runner._onKeyUp(e.keyCode)}};
 document.addEventListener('keydown',key);document.addEventListener('keyup',key);window.addEventListener('blur',()=>{for(const k of held)runner._onKeyUp(k);held.clear()});
 canvas.style.objectFit='contain';canvas.style.imageRendering='pixelated';canvas.id='canvas';
 // A chapter opened directly gets the 'launcher' parameter the selector passes; without it, it looks for mus/ inside its own folder.
 const argvStrings=['--save-folder',saveFolder,'--lazy-rooms','--lazy-textures','--load-type','load-per-chunk','--os-type','windows','--disable-log-colors',...(chapter?['--game-args','-game data.win launcher']:[]),...args,'/game/'+entry];
 const pointers=argvStrings.map(s=>runner.stringToNewUTF8(s)),argv=runner._malloc(pointers.length*4);pointers.forEach((p,i)=>runner.setValue(argv+4*i,p,'i32'));
 // startRunner is a long-lived JSPI promise. Resolve launch only after its first rendered frame.
 let stopped=false;let firstFrameResolve;const firstFrame=new Promise(r=>{firstFrameResolve=r});runner.gameboxFirstFrame=firstFrameResolve;const running=runner.ccall('startRunner','number',['number','number'],[pointers.length,argv],{async:true});
 running.then(code=>{stopped=true;onExit?.({code})},error=>{stopped=true;onExit?.({error:String(error)})}).finally(()=>{for(const p of pointers)runner._free(p);runner._free(argv)});
 await Promise.race([firstFrame,running.then(()=>{throw new Error('DELTARUNE exited before rendering.')})]);if(stopped)throw new Error('DELTARUNE stopped during startup.');
 onStatus?.('DELTARUNE running');onProgress?.('Files',manifest.base.length+1,manifest.base.length+1);canvas.focus();return {runner,manifest,store,running,stop:()=>runner._requestRunnerExit()};
}
