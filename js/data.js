// Master-list acquisition: ONE fetch path (used by silent start fetch and
// by the explicit Fetch button). A failed fetch never erases the previous
// list or personal data; a stale list stays usable.
const CACHE = 'couponrun-master-v1';
const URL = 'data/master-list.json';
export async function fetchMaster() {
  const res = await fetch(URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('Fetch failed: HTTP ' + res.status);
  const text = await res.text();
  const data = JSON.parse(text);
  try {
    const cache = await caches.open(CACHE);
    await cache.put(URL, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
  } catch { /* Cache Storage unavailable; in-memory list still works */ }
  return { data, text };
}
export async function readCachedMaster() {
  try {
    const cache = await caches.open(CACHE);
    const res = await cache.match(URL);
    if (res) return JSON.parse(await res.text());
  } catch {}
  return null;
}
export function isInstalled() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;
}
export const INSTALL_TEXT = 'This needs the installed app, because saved personal data (runs, logs, personal coupons) is only kept in the installed app. Install it on your phone: on iPhone, tap Share, then Add to Home Screen; on Android, tap Install, or Add to Home Screen, as offered by your browser. Then open the installed app — your master list will be the same.';
