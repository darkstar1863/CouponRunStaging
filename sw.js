// Coupon Run service worker. App-shell cache only.
// Updates only when this file's bytes change (browser re-installs on change).
// NEVER deletes personal data: IndexedDB, localStorage and sessionStorage
// are untouched by every handler here.
const SHELL = 'couponrun-shell-v1';
const SHELL_FILES = ['./', './index.html', './css/app.css', './js/app.js', './js/logic.js', './js/store.js', './js/data.js', './manifest.webmanifest', './assets/icons/icon-512.png', './assets/icons/icon.svg'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // Only remove old *shell* caches, never the master-list cache and never any user data store.
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('couponrun-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // App shell / same-origin: cache-first, fall back to network.
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html'))));
    return;
  }
  // CDN (Bootstrap/Leaflet) and tiles: network-first with runtime cache, so
  // offline-after-first-load works once cached; first load needs network.
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match(e.request)));
});
