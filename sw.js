/* Service worker: caches the app shell so it works offline once visited. */
const VERSION = 'v1.4.0';
const CACHE = 'orderviewer-' + VERSION;
const ASSETS = [
  './', './index.html', './css/app.css', './js/app.js', './js/numfmt.js', './js/xlsx-lite.js',
  './vendor/jszip.min.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png', './icons/icon-180.png', './icons/icon-32.png', './favicon.ico',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
