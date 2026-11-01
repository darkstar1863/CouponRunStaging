// Pure, DOM-free logic for Coupon Run. Used by the app and by node tests.
// No guessing: expired means expirationDate is a real date before today;
// a blank expirationDate means ongoing, never expired for sorting/filtering.

// Synthetic Personal category — APP-SIDE ONLY, never in master-list.json.
// Personal coupons carry it so they can be filtered by category; the master
// list itself has only the 9 curator categories. Display order 10 puts it
// after every master category (orders 1-9). Colour #D63384 is distinct from
// all master category colours.
export const PERSONAL_CATEGORY = { id: 'personal', title: 'Personal', shortTitle: 'P', color: '#D63384', displayOrder: 10 };
export function withPersonalCategory(c) {
  if (!c) return c;
  return { ...c, categories: Array.from(new Set([...(c.categories || []), 'personal'])) };
}
// Filter-page category list: master categories (never duplicating a master
// 'personal' if one ever appeared) plus the synthetic Personal category, sorted.
export function allDisplayCategories(masterCategories) {
  const base = (masterCategories || []).filter(c => c.id !== 'personal');
  return sortedCategories([...base, PERSONAL_CATEGORY]);
}
// Dedupe coupons by id, first occurrence wins. Used for Run Edit "Available
// to add": boot() merges personal coupons into `coupons`, so [...coupons,
// ...personal] would otherwise list each personal coupon twice.
export function dedupeCouponsById(list) {
  const seen = new Set(), out = [];
  for (const c of list || []) { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } }
  return out;
}
// No-list guard: true only when a master list is actually present.
export function hasMasterList(master) {
  return !!(master && Array.isArray(master.categories) && Array.isArray(master.locations));
}
// Map guard (pure part): Leaflet usable only if window.L exists AND the
// MarkerCluster plugin registered markerClusterGroup. app.js checks this
// before touching the cluster API, so a failed CDN load cannot throw.
export function canInitMap(leaf) {
  return !!(leaf && typeof leaf.map === 'function' && typeof leaf.markerClusterGroup === 'function');
}
// Run Edit in-run filter (coordinator decision, 2026-11-01): stops already
// in the run are ALWAYS visible in Run Edit, regardless of Show expired,
// so an expired stop can be seen and removed. The Available-to-add list
// does NOT use this override — it respects the filter as-is.
export function runEditInRunFilter(filter) {
  return { ...(filter || defaultFilter()), showExpired: true };
}

export function todayStr(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function isExpired(c, today = todayStr()) {
  return !!(c && c.expirationDate && c.expirationDate < today);
}
export function isRemoved(c) { return c && c.removed === true; }

// Win/Loss = Out - In. One box filled means the other is 0.
// Both blank => null (redeemed stays true, Win/Loss NOT displayed).
export function winLoss(inVal, outVal) {
  const hasIn = inVal !== null && inVal !== undefined && inVal !== '';
  const hasOut = outVal !== null && outVal !== undefined && outVal !== '';
  if (!hasIn && !hasOut) return null;
  const i = hasIn ? Number(inVal) : 0;
  const o = hasOut ? Number(outVal) : 0;
  if (Number.isNaN(i) || Number.isNaN(o)) return null;
  return o - i;
}
// Run total = sum of DISPLAYED amounts only (nulls skipped).
export function runTotal(stops) {
  let sum = 0, counted = 0;
  for (const s of stops || []) {
    const w = winLoss(s.in, s.out);
    if (w !== null) { sum += w; counted++; }
  }
  return { total: sum, counted, totalStops: (stops || []).length };
}
export function formatMoney(n) {
  if (n === null || n === undefined) return '';
  const sign = n < 0 ? '−' : n > 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
export function timeSince(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
// Categories sorted by displayOrder; a coupon's "first category" is the
// lowest displayOrder among its categories (ties: category id).
export function sortedCategories(categories) {
  return [...(categories || [])].sort((a, b) => (a.displayOrder - b.displayOrder) || String(a.id).localeCompare(String(b.id)));
}
export function couponCategories(c, categoriesById) {
  return (c.categories || []).map(id => categoriesById[id]).filter(Boolean)
    .sort((a, b) => (a.displayOrder - b.displayOrder) || String(a.id).localeCompare(String(b.id)));
}
export function firstCategoryOrder(c, categoriesById) {
  const cats = couponCategories(c, categoriesById);
  return cats.length ? cats[0].displayOrder : 999;
}
// Sort chains (requirements, settled): venue: venue, expired, category
// first, title, coupon id. Category: category first, expired, venue, title, id.
// Expired therefore sits at the bottom of each venue/category block.
export function sortCoupons(coupons, sortBy, ctx) {
  const { locationsById, categoriesById, today = todayStr() } = ctx;
  const venue = c => (locationsById[c.location]?.title || '').toLowerCase();
  const cmp = (a, b) => {
    if (sortBy === 'category') {
      let d = firstCategoryOrder(a, categoriesById) - firstCategoryOrder(b, categoriesById);
      if (d) return d;
      d = (isExpired(a, today) ? 1 : 0) - (isExpired(b, today) ? 1 : 0);
      if (d) return d;
      d = venue(a).localeCompare(venue(b)); if (d) return d;
    } else {
      let d = venue(a).localeCompare(venue(b)); if (d) return d;
      d = (isExpired(a, today) ? 1 : 0) - (isExpired(b, today) ? 1 : 0);
      if (d) return d;
      d = firstCategoryOrder(a, categoriesById) - firstCategoryOrder(b, categoriesById);
      if (d) return d;
    }
    let d = String(a.title).localeCompare(String(b.title)); if (d) return d;
    return String(a.id).localeCompare(String(b.id));
  };
  return [...coupons].sort(cmp);
}
export function defaultFilter() {
  return { search: '', categories: null, books: null, showExpired: false, validityDate: '', sort: 'venue' };
}
// filterActive: true when current differs from that view's default.
// Default: list view, sort by venue, Show expired off in browse / locked on
// in Run view, empty search, all categories and all books selected.
export function filterIsActive(filter, context = 'browse') {
  const defShowExpired = context === 'run';
  if (filter.search) return true;
  if (filter.validityDate) return true;
  if (filter.sort && filter.sort !== 'venue') return true;
  if (filter.showExpired !== defShowExpired) return true;
  if (filter.categories !== null && filter.categories !== undefined) return true; // null = all selected
  if (filter.books !== null && filter.books !== undefined) return true;
  return false;
}
export function filterCoupons(coupons, filter, ctx) {
  const { locationsById, categoriesById, today = todayStr(), includeRemoved = false } = ctx;
  const phrase = (filter.search || '').trim().toLowerCase();
  return coupons.filter(c => {
    if (!includeRemoved && isRemoved(c)) return false;
    if (!filter.showExpired && isExpired(c, today)) return false;
    if (filter.categories && filter.categories.length && !c.categories.some(id => filter.categories.includes(id))) return false;
    if (filter.books && filter.books.length && !filter.books.includes(c.bookId)) return false;
    if (filter.validityDate) {
      const d = filter.validityDate;
      if (c.startDate && c.startDate > d) return false;
      if (c.expirationDate && c.expirationDate < d) return false;
    }
    if (phrase) {
      const loc = locationsById[c.location];
      const hay = [c.title, c.description, c.extra, c.source, loc?.title, c.bookTitle, c.bookShortTitle,
        ...(c.categories || []).map(id => categoriesById[id]?.title || ''),
        ...(c.categories || []).map(id => categoriesById[id]?.shortTitle || '')].join(' ').toLowerCase();
      // Phrase search: every word must match somewhere in ALL coupon fields.
      if (!phrase.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  });
}
// Books with all coupons removed do not appear on the filter page.
export function visibleBooks(books, allCoupons) {
  return books.filter(b => {
    const cs = allCoupons.filter(c => c.bookId === b.id);
    return cs.length === 0 || cs.some(c => !isRemoved(c));
  });
}
// Flatten the seeded nested book structure into one coupon list.
export function flattenMaster(data) {
  const out = [];
  for (const b of data.books || []) {
    for (const c of b.coupons || []) {
      out.push({ ...c, bookId: b.id, bookTitle: b.title, bookShortTitle: b.shortTitle, isPersonal: false });
    }
  }
  return out;
}
// Minimal master-list validation (mirrors the schema's key rules).
export function validateMaster(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['master list is not an object'];
  if (!Array.isArray(data.categories) || !data.categories.length) errors.push('no categories');
  if (!Array.isArray(data.locations)) errors.push('no locations');
  const locIds = new Set((data.locations || []).map(l => l.id));
  const catIds = new Set((data.categories || []).map(c => c.id));
  const seen = new Set();
  for (const b of data.books || []) {
    for (const c of b.coupons || []) {
      if (seen.has(c.id)) errors.push(`duplicate coupon id ${c.id}`); seen.add(c.id);
      if (!locIds.has(c.location)) errors.push(`coupon ${c.id} unknown location ${c.location}`);
      for (const cat of c.categories || []) if (!catIds.has(cat)) errors.push(`coupon ${c.id} unknown category ${cat}`);
      if (typeof c.removed !== 'boolean') errors.push(`coupon ${c.id} removed is not boolean`);
      for (const f of ['startDate', 'expirationDate']) {
        if (c[f] !== null && c[f] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(c[f])) errors.push(`coupon ${c.id} bad ${f}`);
      }
    }
  }
  return errors;
}
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
// Linkify plain-text URLs in descriptions; links open outside the app.
export function linkify(s) {
  const esc = escapeHtml(s);
  return esc.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}
// Haversine distance in metres (for the 10-metre pin merge).
export function distanceM(aLat, aLng, bLat, bLng) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
