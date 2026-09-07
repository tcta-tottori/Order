/* Service worker: caches the app shell so it works offline once visited.
 * - Navigations (index.html) are network-first so a new release is picked up immediately.
 * - Versioned assets (?v=) are cache-first; the version query guarantees HTML and JS never mix.
 */
const VERSION = '1.6.3';
const CACHE = 'orderviewer-' + VERSION;
const V = '?v=' + VERSION;
const ASSETS = [
  './', './index.html',
  './css/app.css' + V, './js/app.js' + V, './js/numfmt.js' + V, './js/xlsx-lite.js' + V, './js/xlsx-write.js' + V,
  './vendor/jszip.min.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png', './icons/icon-180.png', './icons/icon-32.png', './favicon.ico',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(ASSETS.map((a) => c.add(new Request(a, { cache: 'reload' })).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(new Request(e.request, { cache: 'no-cache' })).then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put('./index.html', res.clone()));
        return res;
      }).catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      });
    })
  );
});
