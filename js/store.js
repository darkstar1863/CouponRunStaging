// Storage: IndexedDB for personal data, localStorage for view settings ONLY,
// sessionStorage for Back position ONLY. The service worker must never
// delete IndexedDB; this module never deletes it except on explicit user
// deletion of a single run / personal coupon.
const DB = 'couponrun', VER = 1;
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('personal')) db.createObjectStore('personal', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export const store = {
  getAll: (s) => tx(s, 'readonly', st => st.getAll()),
  get: (s, k) => tx(s, 'readonly', st => st.get(k)),
  put: (s, v) => tx(s, 'readwrite', st => st.put(v)),
  del: (s, k) => tx(s, 'readwrite', st => st.delete(k)),
};
// View settings (localStorage only).
export function loadView(key, fallback) {
  try { const raw = localStorage.getItem('cr-view-' + key); return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback }; }
  catch { return { ...fallback }; }
}
export function saveView(key, value) {
  try { localStorage.setItem('cr-view-' + key, JSON.stringify(value)); } catch { /* storage may be evicted in web mode; acceptable */ }
}
// Back position (sessionStorage only).
export function saveBack(v) { try { sessionStorage.setItem('cr-back', JSON.stringify(v)); } catch {} }
export function loadBack() { try { return JSON.parse(sessionStorage.getItem('cr-back') || 'null'); } catch { return null; } }
export function uid(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
