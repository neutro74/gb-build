// Cross-origin isolation for static hosting. The engine needs SharedArrayBuffer, which requires
// COOP/COEP headers that CDNs like StaticDelivr don't send; this worker adds them to the page's
// own responses. COEP "credentialless" lets cross-origin parts (raw.githubusercontent.com) load
// without CORP headers.
//
// Page side: ensureIsolation() registers this file (served next to the page) and reloads once.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }),
  );
});
