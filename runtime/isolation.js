// Makes the page cross-origin isolated on hosts that can't send COOP/COEP (see coi-sw.js).
// Resolves true once isolated; otherwise registers the worker, reloads, and never resolves.
// Resolves false when service workers are unavailable (blocked by policy, private window).
export async function ensureIsolation(workerUrl = 'coi-sw.js') {
  const KEY = 'gamebox.coi-reloaded';
  if (globalThis.crossOriginIsolated) {
    try { sessionStorage.removeItem(KEY); } catch {}
    return true;
  }
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register(workerUrl);
    await navigator.serviceWorker.ready;
  } catch (error) {
    console.warn('gamebox: service worker unavailable', error);
    return false;
  }
  // One reload at most, so a host that strips the headers again can't loop the page.
  let reloaded = false;
  try {
    reloaded = sessionStorage.getItem(KEY) === '1';
    sessionStorage.setItem(KEY, '1');
  } catch {}
  if (reloaded) return false;
  location.reload();
  return new Promise(() => {});
}
