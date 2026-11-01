// Coupon Run service worker. App-shell cache only.
// Updates only when this file's bytes change (browser re-installs on change).
// RULE: bump SHELL on every app-code change (index.html, css/, js/,
// manifest.webmanifest, assets/icons/). Installed phones will NOT get
// new app code otherwise: the browser only installs a new worker when
// sw.js changes, and the fetch handler below is cache-first for the
// shell. A data-only master-list change does NOT need a SHELL bump,
// because data/master-list.json bypasses this worker entirely (see
// fetch handler below) — its freshness comes from fetchMaster()'s
// no-store fetch, not from the shell cache.
// NEVER deletes personal data: IndexedDB, localStorage and sessionStorage
// are untouched by every handler here. The master-list cache
// (couponrun-master-v1, owned by js/data.js) is also untouched: activate
// only deletes couponrun-shell-* caches.
const SHELL = 'couponrun-shell-v2';
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
  // Master-list bypass: data/master-list.json must NEVER be served
  // from, or written to, the shell cache. Without this, the first
  // runtime fetch would put it in the shell cache and every later
  // fetchMaster() (which uses cache: 'no-store') would still get the
  // cached copy from this worker, so list updates would be stuck
  // behind the shell version. Returning without respondWith lets the
  // request go straight to the network, as fetchMaster() intends.
  // js/data.js still keeps its own couponrun-master-v1 cache for
  // offline/failure fallback — that cache is separate and untouched.
  if (url.pathname.endsWith('/data/master-list.json') || url.pathname === 'data/master-list.json') return;
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
