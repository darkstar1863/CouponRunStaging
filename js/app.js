import * as L from './logic.js';
import { store, loadView, saveView, saveBack, loadBack, uid } from './store.js';
import { fetchMaster, readCachedMaster, isInstalled, INSTALL_TEXT } from './data.js';

const HELP_TEXT = 'If gambling stops being fun, help is available, free and confidential, 24 hours a day. National Problem Gambling Helpline: call 1-800-522-4700 or 1-800-MY-RESET (1-800-697-3738), text 800GAM, or chat at ncpgambling.org/chat. Please gamble responsibly, and only with money you can afford to lose.';
// Requirements §3.3: numbers are a proposal to be re-verified before release; wording above is verbatim from requirements.
const DISCLAIMER = 'This coupon information is crowdsourced. It may change at any time, or may even be incorrect. The author is not liable for any discrepancies. Always confirm the offer at the venue before redeeming.';
// Requirements UC3 asks for a disclaimer to that effect; final legal wording is an open question (requirements §11), so this plain wording is labelled as such in the detail view note.

const $ = s => document.querySelector(s);
const app = $('#app'), headerTitle = $('#headerTitle'), headerControls = $('#headerControls'), backBtn = $('#backBtn');
let master = null, coupons = [], catsById = { [L.PERSONAL_CATEGORY.id]: L.PERSONAL_CATEGORY }, locsById = {}, books = [];
let runs = [], personal = [];
let installed = isInstalled();
let view = { name: 'home' }; // {name, ...}
let history = []; // in-app back stack (separate from Back-position restore)
let lastFetchAt = null, lastFetchText = '', fetchStatus = '';
let mapObj = null, mapMarkers = null, userMarker = null;
let focusInOutOnDetail = false;

function today() { return L.todayStr(); }
function byId(id) { return coupons.find(c => c.id === id) || personal.find(c => c.id === id) || null; }
// Deduped merge (fix A): `coupons` already contains personal coupons after
// boot(), so a naive [...coupons, ...personal] lists each personal coupon
// twice. Dedupe by id; first occurrence wins.
function allCoupons() { return L.dedupeCouponsById([...coupons, ...personal]); }
function setCatsFromMaster(data) {
  catsById = { [L.PERSONAL_CATEGORY.id]: L.PERSONAL_CATEGORY };
  (data.categories || []).forEach(c => catsById[c.id] = c);
}
function normalizePersonal(list) { return (list || []).map(p => L.withPersonalCategory(p)); }
// Blocking no-list lock (requirements §3.2, fix C): shown ONLY when no list
// at all is present (master === null). It blocks the screen; Retry
// re-attempts the fetch; it unlocks only when a fetch succeeds. A stale
// list stays usable, so a failed fetch with a list present never shows it.
function updateNoListLock() {
  const lock = $('#noListLock');
  if (!lock) return;
  const show = master === null;
  lock.style.display = show ? 'flex' : 'none';
  lock.setAttribute('aria-hidden', show ? 'false' : 'true');
  if (show) { const btn = $('#noListRetry'); if (btn) { btn.disabled = false; btn.textContent = 'Retry'; } }
}
function hidePane() {
  const pane = $('#mapPane');
  if (pane) { pane.classList.add('d-none'); pane.style.transform = ''; }
  lastPaneGroup = null;
}
let lastPaneGroup = null;
function gatingBanner() {
  return installed ? '' : `<div class="alert alert-warning" role="alert">${L.escapeHtml(INSTALL_TEXT)}</div>`;
}
function catBadges(c) {
  return L.couponCategories(c, catsById).map(cat =>
    `<span class="badge cat-badge" style="background:${cat.color}">${L.escapeHtml(cat.shortTitle)}</span>`).join(' ');
}
function expiredMark(c) { return L.isExpired(c, today()) ? `<span class="badge text-bg-secondary">EXPIRED</span>` : ''; }
function locTitle(c) { return locsById[c.location]?.title || 'No location'; }

// ---- Coupon card: same card everywhere. Action area varies by context. ----
function cardHtml(c, ctx) {
  const exp = L.isExpired(c, today());
  const stop = ctx.run ? ctx.run.stops.find(s => s.couponId === c.id) : null;
  let action = '';
  if (ctx.mode === 'run') {
    if (!installed) action = `<button class="btn btn-sm btn-outline-secondary" disabled title="${L.escapeHtml(INSTALL_TEXT)}">Logging disabled in web mode</button>`;
    else if (stop?.redeemed) {
      const w = L.winLoss(stop.in, stop.out);
      action = `<button class="btn btn-sm btn-success" data-act="toggle" data-id="${c.id}">Redeemed ✓</button>` +
        (w !== null ? ` <span class="fw-bold ${w >= 0 ? 'text-success' : 'text-danger'}">Win/Loss: ${L.formatMoney(w)}</span>` : '');
    } else action = `<button class="btn btn-sm btn-primary" data-act="mark" data-id="${c.id}">Mark as Redeemed</button>`;
  } else if (ctx.mode === 'runEdit') {
    action = ctx.inRun
      ? `<button class="btn btn-sm btn-outline-danger" data-act="remove" data-id="${c.id}">Remove</button>`
      : `<button class="btn btn-sm btn-primary" data-act="add" data-id="${c.id}">Add to run</button>`;
  } else if (ctx.mode === 'browse') {
    if (c.isPersonal) action = `<button class="btn btn-sm btn-outline-secondary" data-act="edit-personal" data-id="${c.id}" aria-label="Edit personal coupon">✎ Edit</button>`;
    else action = ''; // Action area reserved / blank for master coupons in browse, per spec.
  }
  return `<article class="card coupon-card mb-2 ${exp ? 'expired-card' : ''}" data-open="${c.id}" id="coupon-${c.id}">
    <div class="card-body">
      <div class="d-flex flex-wrap gap-1 mb-1">${catBadges(c)} ${expiredMark(c)} ${c.removed ? '<span class="badge text-bg-warning">REMOVED from master list</span>' : ''} ${c.isPersonal ? '<span class="badge text-bg-info">Personal</span>' : ''}</div>
      <h3 class="h6 mb-1">${L.escapeHtml(c.title)}</h3>
      <div class="text-muted small">${L.escapeHtml(c.bookShortTitle || 'Personal')} · ${L.escapeHtml(locTitle(c))}</div>
      ${action ? `<div class="mt-2 action-area" data-action-area="${c.id}">${action}</div>` : '<div class="mt-2 action-area"></div>'}
    </div></article>`;
}
function bindCards(container, ctx, onOpen) {
  container.querySelectorAll('[data-open]').forEach(el => {
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (btn) { e.stopPropagation(); ctx.onAction(btn.dataset.act, btn.dataset.id); return; }
      onOpen(el.dataset.open);
    });
  });
}

// ---- Views state / navigation ----
function setHeader(title, controlsHtml, backLabel) {
  headerTitle.textContent = title;
  headerControls.innerHTML = controlsHtml || '';
  if (backLabel) { backBtn.style.display = ''; backBtn.textContent = backLabel; backBtn.setAttribute('aria-label', backLabel.replace('<', '').trim() || 'Back'); }
  else backBtn.style.display = 'none';
}
function go(next, opts = {}) {
  if (!opts.noPush) history.push(view);
  if (opts.saveBack) saveBack(opts.saveBack);
  view = next; render();
}
// Anchor navigation (static Back, 2026-11-01): Coupons and Runs always
// return to Home, Run always returns to Runs, regardless of how the
// anchor was reached. History is cleared on a static move, so a stale
// transient entry can never resurface as a Back target afterwards.
function goAnchor(next) {
  history = [];
  view = next; render();
}
function goBack() {
  const prev = history.pop() || { name: 'home' };
  view = prev; render(true);
}
function goStaticBack() {
  if (view.name === 'coupons' || view.name === 'runs') goAnchor({ name: 'home' });
  else if (view.name === 'run') goAnchor({ name: 'runs' });
  else goBack();
}
backBtn.addEventListener('click', () => {
  if (view.name === 'filter') { applyFilter(); return; }
  if (view.name === 'personalEdit') { savePersonalFromForm(); return; }
  if (view.name === 'runEdit') {
    // RunEdit header Back is a discard, not a save: stops are already
    // saved on add/remove, so only an unsaved name change can be lost.
    const nameVal = ($('#runName')?.value || '').trim();
    const run = runById(view.runId);
    if (run && nameVal && nameVal !== run.name && !confirm('Discard the name change?')) return;
    goBack(); return;
  }
  goStaticBack();
});

// ---- Filters (per-view settings in localStorage) ----
function filterKey(ctx) { return ctx === 'run' ? 'run-' + (view.runId || '') : ctx; }
function getFilter(ctx) {
  const v = loadView('filter-' + filterKey(ctx), L.defaultFilter());
  // Run view: Show expired locked on.
  if (ctx === 'run') v.showExpired = true;
  return v;
}
function setFilter(ctx, f) { saveView('filter-' + filterKey(ctx), f); }

function openDetail(id, fromCtx) {
  const back = { from: fromCtx, scrollY: window.scrollY, couponId: id, filter: getFilter(fromCtx === 'run' ? 'run' : 'browse'), map: mapObj ? { lat: mapObj.getCenter().lat, lng: mapObj.getCenter().lng, zoom: mapObj.getZoom() } : null };
  go({ name: 'detail', couponId: id, from: fromCtx, runId: view.runId || null }, { saveBack: back, noPush: false });
  // Keep history simple: detail's Back returns via goBack().
}

// ---- Rendering ----
function render(isBack = false) {
  $('#fetchBanner').textContent = fetchStatus;
  // No-list lock is evaluated on every render so it can only ever appear
  // when master === null and disappears the moment a fetch succeeds.
  updateNoListLock();
  switch (view.name) {
    case 'home': renderHome(); break;
    case 'coupons': renderCoupons(isBack); break;
    case 'runs': renderRuns(); break;
    case 'run': renderRun(isBack); break;
    case 'runEdit': renderRunEdit(); break;
    case 'filter': renderFilter(); break;
    case 'detail': renderDetail(); break;
    case 'personalEdit': renderPersonalEdit(); break;
    default: renderHome();
  }
  window.scrollTo(0, 0);
}
function renderHome() {
  setHeader('Coupon Run', '');
  app.innerHTML = `
    <div class="d-grid gap-3">
      <button class="btn btn-primary btn-lg" id="btnCoupons">Coupons</button>
      <button class="btn btn-primary btn-lg" id="btnRuns">Runs</button>
    </div>
    <p class="mt-3">Master list: ${master ? `${coupons.length} coupons` : 'not loaded yet'} · Last fetch: ${lastFetchAt ? L.timeSince(lastFetchAt) : 'never'} (${lastFetchAt ? new Date(lastFetchAt).toLocaleString() : '—'}) · Curator updated: ${master ? L.escapeHtml(String(master.curatorUpdatedAt || '—')) : '—'}</p>
    <button class="btn btn-outline-secondary" id="btnFetch">Fetch master list</button>
    <span id="fetchMsg" class="ms-2 text-muted"></span>
    <div class="alert alert-info mt-3" role="alert">${L.escapeHtml(HELP_TEXT)}</div>
    ${installed ? '' : `<div class="alert alert-warning">${L.escapeHtml(INSTALL_TEXT)}</div>`}
    <p class="text-muted small">Installed mode: ${installed ? 'yes' : 'no (web mode — browsing only)'}.</p>`;
  $('#btnCoupons').onclick = () => goAnchor({ name: 'coupons' });
  $('#btnRuns').onclick = () => goAnchor({ name: 'runs' });
  $('#btnFetch').onclick = async () => { const m = $('#fetchMsg'); m.textContent = 'Fetching…'; try { await doFetch(true); m.textContent = fetchStatus; renderHome(); } catch (e) { m.textContent = (master ? 'Fetch failed — previous list kept. ' : 'Fetch failed — no list loaded yet. ') + e.message; updateNoListLock(); } };
}
function toolbarHtml(viewMode, filterActive, ctx) {
  // Live-E2E fix (2026-11-01): personal coupons previously had no creation
  // entry point at all — personalEdit was only reachable by editing an
  // existing personal coupon. Browse now gets a + Personal button, visible
  // but disabled in web mode (same gating pattern as Runs +), enabled in
  // installed mode. Run context does not get it (personal coupons are
  // added to runs from run edit, not from a run's own header).
  const personalBtn = ctx === 'browse'
    ? (installed
      ? `<button class="btn btn-sm btn-primary" id="hdrPersonal" aria-label="Add personal coupon">+ Personal</button>`
      : `<button class="btn btn-sm btn-outline-secondary" id="hdrPersonal" disabled title="${L.escapeHtml(INSTALL_TEXT)}" aria-label="Add personal coupon (disabled in web mode)">+ Personal</button>`)
    : '';
  return `<button class="btn btn-sm btn-outline-secondary" id="hdrView" aria-label="Toggle map/list view">${viewMode === 'map' ? 'List' : 'Map'}</button>
    <button class="btn btn-sm ${filterActive ? 'btn-warning filter-active' : 'btn-outline-secondary'}" id="hdrFilter" aria-label="${filterActive ? 'Filter applied — open filter' : 'Open filter'}">⚑ Filter${filterActive ? ' • applied' : ''}</button>${personalBtn}`;
}
function bindHdrPersonal() {
  $('#hdrPersonal')?.addEventListener('click', () => {
    if (!installed) { alert(INSTALL_TEXT); return; }
    go({ name: 'personalEdit' });
  });
}
function renderCoupons(isBack) {
  const settings = loadView('view-coupons', { mode: 'list' });
  const filter = getFilter('browse');
  const filtered = L.sortCoupons(L.filterCoupons(coupons, filter, { locationsById: locsById, categoriesById: catsById }), filter.sort, { locationsById: locsById, categoriesById: catsById });
  const active = L.filterIsActive(filter, 'browse');
  setHeader('Coupons', toolbarHtml(settings.mode, active, 'browse'), '←');
  if (settings.mode === 'map') { renderMapView(filtered, 'browse', settings); return; }
  app.innerHTML = `<p class="text-muted">${filtered.length} of ${coupons.length} coupons · Sort: ${filter.sort === 'category' ? 'by category' : 'by venue'}${active ? ' · filter applied' : ''}</p><div id="list"></div>
    ${filtered.length === 0 ? '<p>No coupons match. <button class="btn btn-link" id="clearF">Clear filters</button></p>' : ''}`;
  const list = $('#list');
  list.innerHTML = filtered.map(c => cardHtml(c, { mode: 'browse' })).join('');
  bindCards(list, { mode: 'browse', onAction: (act, id) => { if (act === 'edit-personal') { if (!installed) { alert(INSTALL_TEXT); return; } go({ name: 'personalEdit', couponId: id }); } } }, id => openDetail(id, 'browse'));
  $('#clearF')?.addEventListener('click', () => { setFilter('browse', L.defaultFilter()); render(); });
  $('#hdrView').onclick = () => { saveView('view-coupons', { mode: 'map' }); render(); };
  $('#hdrFilter').onclick = () => go({ name: 'filter', ctx: 'browse' });
  bindHdrPersonal();
  if (isBack) { const b = loadBack(); if (b?.scrollY) setTimeout(() => window.scrollTo(0, b.scrollY), 0); else if (b?.couponId) document.getElementById('coupon-' + b.couponId)?.scrollIntoView(); }
}
function renderRuns() {
  setHeader('Runs', installed ? '<button class="btn btn-sm btn-primary" id="hdrAdd" aria-label="Add run">+</button>' : '<button class="btn btn-sm btn-outline-secondary" id="hdrAdd" disabled title="Install the app to create runs">+</button>', '←');
  app.innerHTML = `${gatingBanner()}<div id="runsList"></div>
    ${runs.length === 0 ? '<p>No runs yet.</p>' : ''}
    ${installed ? '' : '<p class="text-muted">Run creation is disabled in web mode (see above).</p>'}`;
  const el = $('#runsList');
  el.innerHTML = runs.map(r => {
    const t = L.runTotal(r.stops);
    return `<div class="card mb-2"><div class="card-body d-flex justify-content-between align-items-center">
      <div><strong>${L.escapeHtml(r.name)}</strong><br><span class="text-muted small">${r.stops.length} stops · ${r.stops.filter(s => s.redeemed).length} redeemed · Total (recorded only): <span class="${t.total >= 0 ? 'text-success' : 'text-danger'}">${L.formatMoney(t.total)}</span> (${t.counted} of ${t.totalStops} stops recorded)</span></div>
      <div><button class="btn btn-sm btn-primary" data-open-run="${r.id}">Open</button> <button class="btn btn-sm btn-outline-secondary" data-edit-run="${r.id}" aria-label="Edit run">✎</button></div></div></div>`;
  }).join('');
  el.querySelectorAll('[data-open-run]').forEach(b => b.onclick = () => go({ name: 'run', runId: b.dataset.openRun }));
  el.querySelectorAll('[data-edit-run]').forEach(b => b.onclick = () => { if (!installed) { alert(INSTALL_TEXT); return; } go({ name: 'runEdit', runId: b.dataset.editRun }); });
  $('#hdrAdd')?.addEventListener('click', () => {
    if (!installed) { alert(INSTALL_TEXT); return; }
    const name = prompt('Run name (must be unique):');
    if (!name) return;
    if (runs.some(r => r.name.trim().toLowerCase() === name.trim().toLowerCase())) { alert('A run with that name already exists. Please choose a different name.'); return; }
    const run = { id: uid('run'), name: name.trim(), stops: [] };
    store.put('runs', run).then(() => { runs.push(run); go({ name: 'runEdit', runId: run.id }); });
  });
}
function runById(id) { return runs.find(r => r.id === id); }
function renderRun(isBack) {
  const run = runById(view.runId); if (!run) { goAnchor({ name: 'runs' }); return; }
  const settings = loadView('view-run-' + run.id, { mode: 'list' });
  const filter = getFilter('run');
  const inRun = run.stops.map(s => ({ stop: s, coupon: byId(s.couponId) })).filter(x => x.coupon);
  const filtered = L.sortCoupons(L.filterCoupons(inRun.map(x => x.coupon), filter, { locationsById: locsById, categoriesById: catsById, includeRemoved: true }), filter.sort, { locationsById: locsById, categoriesById: catsById });
  const t = L.runTotal(run.stops);
  const active = L.filterIsActive(filter, 'run');
  setHeader(run.name, `<span class="me-2 fw-bold ${t.total >= 0 ? 'text-success' : 'text-danger'}">Total: ${L.formatMoney(t.total)}</span>
    <button class="btn btn-sm btn-outline-secondary" id="hdrShare">Share</button>
    ${installed ? `<button class="btn btn-sm btn-outline-secondary" id="hdrEdit" aria-label="Edit run">✎</button>` : ''}
    ${toolbarHtml(settings.mode, active, 'run')}`, '←');
  if (settings.mode === 'map') { renderMapView(filtered, 'run', settings, run); return; }
  app.innerHTML = `<p class="text-muted">Total covers recorded amounts only: ${t.counted} of ${t.totalStops} stops recorded. Show expired is locked on in Run view.</p>
    ${gatingBanner()}<div id="list"></div>`;
  const list = $('#list');
  list.innerHTML = filtered.map(c => cardHtml(c, { mode: 'run', run })).join('') || '<p>No coupons in this run match the filter.</p>';
  bindCards(list, { mode: 'run', run, onAction: (act, id) => {
    if (!installed) { alert(INSTALL_TEXT); return; }
    const stop = run.stops.find(s => s.couponId === id);
    if (act === 'mark') { focusInOutOnDetail = true; openDetail(id, 'run'); }
    if (act === 'toggle' && stop) { stop.redeemed = !stop.redeemed; if (!stop.redeemed) { stop.in = ''; stop.out = ''; } store.put('runs', run).then(render); }
  } }, id => openDetail(id, 'run'));
  $('#hdrShare').onclick = () => shareRun(run);
  $('#hdrEdit')?.addEventListener('click', () => go({ name: 'runEdit', runId: run.id }));
  $('#hdrView').onclick = () => { saveView('view-run-' + run.id, { mode: 'map' }); render(); };
  $('#hdrFilter').onclick = () => go({ name: 'filter', ctx: 'run', runId: run.id });
  if (isBack) { const b = loadBack(); if (b?.scrollY) setTimeout(() => window.scrollTo(0, b.scrollY), 0); }
}
function renderRunEdit() {
  const run = runById(view.runId); if (!run) { goAnchor({ name: 'runs' }); return; }
  const filter = getFilter('runEdit');
  setHeader('Edit run: ' + run.name, `<button class="btn btn-sm btn-outline-danger" id="hdrDelete">Delete</button>`, '←');
  const inIds = new Set(run.stops.map(s => s.couponId));
  // Fix D (coordinator decision): in-run stops are ALWAYS visible here,
  // regardless of the Show expired filter, so an expired stop already in
  // the run can be seen and removed. Available-to-add below continues to
  // respect the filter exactly as set (including Show expired).
  const inList = L.filterCoupons(run.stops.map(s => byId(s.couponId)).filter(Boolean), L.runEditInRunFilter(filter), { locationsById: locsById, categoriesById: catsById, includeRemoved: true });
  // Fix A: Available uses `coupons` alone — it already contains the personal
  // coupons merged at boot, so allCoupons() ([...coupons, ...personal])
  // would duplicate every personal coupon. Dedupe as a second guard.
  const avail = L.dedupeCouponsById(L.filterCoupons(coupons, filter, { locationsById: locsById, categoriesById: catsById }).filter(c => !inIds.has(c.id)));
  app.innerHTML = `<div class="mb-3"><label class="form-label">Run name (must be unique)</label><input class="form-control" id="runName" value="${L.escapeHtml(run.name)}"></div>
    <p class="text-muted">Filter applies to both sections, except expired stops already in this run are always shown in “In this run” so they can be removed. Removed coupons already in this run stay here and can be kept or removed, but cannot be newly added.</p>
    <button class="btn btn-sm btn-outline-secondary mb-2" id="editFilter">⚑ Filter</button>
    <h2 class="h5">In this run (${inList.length})</h2><div id="inList"></div>
    <h2 class="h5 mt-3">Available to add (${avail.length})</h2><div id="avList"></div>
    <p class="mt-3"><button class="btn btn-primary" id="doneEdit">Done</button></p>`;
  const inEl = $('#inList'), avEl = $('#avList');
  inEl.innerHTML = inList.map(c => cardHtml(c, { mode: 'runEdit', inRun: true })).join('') || '<p class="text-muted">None match.</p>';
  avEl.innerHTML = avail.map(c => cardHtml(c, { mode: 'runEdit', inRun: false })).join('') || '<p class="text-muted">None match.</p>';
  const handler = (act, id) => {
    if (act === 'add') { if (!run.stops.some(s => s.couponId === id)) run.stops.push({ couponId: id, redeemed: false, in: '', out: '' }); }
    if (act === 'remove') run.stops = run.stops.filter(s => s.couponId !== id);
    store.put('runs', run).then(render);
  };
  bindCards(inEl, { onAction: handler }, id => openDetail(id, 'runEdit'));
  bindCards(avEl, { onAction: handler }, id => openDetail(id, 'runEdit'));
  $('#editFilter').onclick = () => go({ name: 'filter', ctx: 'runEdit', runId: run.id });
  // Live-E2E fix (2026-11-01): Run Edit previously had no name field, so a
  // run could never be renamed in the UI (sketch Run Edit shows Name as a
  // single-line field). Done now saves the name, with the same uniqueness
  // rule as creation (case-insensitive, excluding this run).
  $('#doneEdit').onclick = () => {
    const name = ($('#runName')?.value || '').trim();
    if (!name) { alert('Run name is required.'); return; }
    if (runs.some(r => r.id !== run.id && r.name.trim().toLowerCase() === name.toLowerCase())) { alert('A run with that name already exists. Please choose a different name.'); return; }
    run.name = name;
    // Done is a result, not a navigation push: Run is an anchor, so
    // replace the edit view with it and clear history (Run's Back is
    // static to Runs, and its children push Run themselves if needed).
    store.put('runs', run).then(() => goAnchor({ name: 'run', runId: run.id }));
  };
  $('#hdrDelete').onclick = () => { if (confirm(`Delete run "${run.name}"? Its stops and logs for this run will be deleted. Master and personal coupons are not deleted.`)) store.del('runs', run.id).then(() => { runs = runs.filter(r => r.id !== run.id); goAnchor({ name: 'runs' }); }); };
}
function renderFilter() {
  const ctx = view.ctx;
  // Fix C(1): no-list guard — never touch master.categories when there is
  // no list. The blocking modal (updateNoListLock) covers this screen, but
  // the view itself must not throw if reached.
  if (!L.hasMasterList(master)) { setHeader('Filter', '', '←'); app.innerHTML = `<div class="alert alert-warning">No master list loaded yet. Use Retry in the blocking message to load it.</div>`; return; }
  const filter = getFilter(ctx);
  const draft = JSON.parse(JSON.stringify(filter));
  // "< Apply" is the Back button for this screen; Cancel is separate.
  setHeader('Filter', `<button class="btn btn-sm btn-outline-secondary" id="hdrCancel">Cancel</button> <button class="btn btn-sm btn-outline-secondary" id="hdrClear">Clear</button>`, '< Apply');
  // Fix G: filter categories include the synthetic Personal category
  // (app-side only, never in master-list.json), so personal coupons can
  // be filtered by category. Note: category filtering is ANY-match, like
  // every multi-category coupon — a personal Dining coupon still matches
  // a Dining-only selection via Dining, not only via Personal.
  const cats = L.allDisplayCategories(master.categories);
  const vBooks = L.visibleBooks(books, coupons);
  const selCats = draft.categories === null ? new Set(cats.map(c => c.id)) : new Set(draft.categories);
  const selBooks = draft.books === null ? new Set(vBooks.map(b => b.id)) : new Set(draft.books);
  app.innerHTML = `<div class="mb-3"><label class="form-label">Phrase search (matches all coupon fields)</label>
      <input class="form-control" id="fSearch" value="${L.escapeHtml(draft.search)}" placeholder="Search…"></div>
    <div class="mb-3"><label class="form-label">Sort</label>
      <select class="form-select" id="fSort"><option value="venue" ${draft.sort === 'venue' ? 'selected' : ''}>By venue</option><option value="category" ${draft.sort === 'category' ? 'selected' : ''}>By category</option></select>
      <div class="form-text">Sort by venue or by category only.</div></div>
    <div class="mb-3"><label class="form-label">Valid on a given date</label><input type="date" class="form-control" id="fDate" value="${draft.validityDate}"></div>
    <fieldset class="mb-3"><legend class="h6">Categories</legend>${cats.map(c => `<label class="d-block"><input type="checkbox" data-cat="${c.id}" ${selCats.has(c.id) ? 'checked' : ''}> ${L.escapeHtml(c.shortTitle)}. ${L.escapeHtml(c.title)}</label>`).join('')}</fieldset>
    <fieldset class="mb-3"><legend class="h6">Coupon book / source</legend>${vBooks.map(b => `<label class="d-block"><input type="checkbox" data-book="${b.id}" ${selBooks.has(b.id) ? 'checked' : ''}> ${L.escapeHtml(b.shortTitle)} — ${L.escapeHtml(b.title)}</label>`).join('')}
      <label class="d-block"><input type="checkbox" data-book="personal" ${selBooks.has('personal') || draft.books === null ? 'checked' : ''}> Personal</label></fieldset>
    <label class="d-block mb-3"><input type="checkbox" id="fExpired" ${draft.showExpired ? 'checked' : ''} ${ctx === 'run' ? 'disabled' : ''}> Show expired ${ctx === 'run' ? '(locked on in Run view)' : ''}</label>
    <p class="text-muted small">Clear resets this view's filter to its default, not to empty. Cancel leaves the previous filter unchanged.</p>`;
  const readDraft = () => {
    draft.search = $('#fSearch').value; draft.sort = $('#fSort').value; draft.validityDate = $('#fDate').value;
    const cs = [...document.querySelectorAll('[data-cat]')].filter(x => x.checked).map(x => x.dataset.cat);
    draft.categories = cs.length === cats.length ? null : cs;
    const bs = [...document.querySelectorAll('[data-book]')].filter(x => x.checked).map(x => x.dataset.book);
    const allBookIds = [...vBooks.map(b => b.id), 'personal'];
    draft.books = bs.length === allBookIds.length ? null : bs;
    if (ctx !== 'run') draft.showExpired = $('#fExpired').checked;
    return draft;
  };
  // Personal coupons live in `personal` and are also merged into `coupons`
  // at boot/fetch (deduped); the books filter for them works by treating
  // bookId 'personal', and the category filter by the synthetic 'personal'
  // category (fix G).
  window._applyFilterDraft = () => { const d = readDraft(); setFilter(ctx, d); goBackToList(ctx); };
  $('#hdrCancel').onclick = () => goBackToList(ctx, true);
  $('#hdrClear').onclick = () => { const d = L.defaultFilter(); if (ctx === 'run') d.showExpired = true; setFilter(ctx, d); goBackToList(ctx); };
  function goBackToList(c, cancel = false) {
    // Return-to-caller: Filter was pushed onto history when opened, so
    // popping returns to its caller (Coupons / Run / RunEdit) without
    // pushing Filter back onto the stack — the old go(caller) version
    // is what made Coupons <-> Filter loop forever.
    goBack();
  }
  window._goBackToList = goBackToList;
}
function applyFilter() { if (window._applyFilterDraft) window._applyFilterDraft(); else goBack(); }

function renderDetail() {
  const c = byId(view.couponId);
  if (!c) { goBack(); return; }
  const run = view.runId ? runById(view.runId) : null;
  const stop = run ? run.stops.find(s => s.couponId === c.id) : null;
  const inRuns = runs.filter(r => r.stops.some(s => s.couponId === c.id)).map(r => r.name);
  const exp = L.isExpired(c, today());
  setHeader(c.title, c.isPersonal && installed ? `<button class="btn btn-sm btn-outline-secondary" id="hdrEditP" aria-label="Edit personal coupon">✎</button>` : '', '←');
  const loc = locsById[c.location];
  const hasCoords = loc && loc.latitude !== null && loc.longitude !== null;
  const mapsBtns = hasCoords
    ? `<a class="btn btn-sm btn-outline-primary" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}">Google Maps</a>
       <a class="btn btn-sm btn-outline-primary" target="_blank" rel="noopener" href="https://maps.apple.com/?ll=${loc.latitude},${loc.longitude}">Apple Maps</a>`
    : `<button class="btn btn-sm btn-outline-secondary" disabled title="No location for this coupon">Google Maps</button>
       <button class="btn btn-sm btn-outline-secondary" disabled title="No location for this coupon">Apple Maps</button>`;
  // vpFREE2: link only when the curator supplied a verified vpFREE2 URL for this
  // location (data/master-list.json, locations[].vpfree2); otherwise disabled — never guessed.
  const vpfree = (loc && loc.vpfree2)
    ? `<a class="btn btn-sm btn-outline-primary" target="_blank" rel="noopener" href="${L.escapeHtml(loc.vpfree2)}">vpFREE2</a>`
    : `<button class="btn btn-sm btn-outline-secondary" disabled title="No vpFREE2 link supplied by the curator for this venue">vpFREE2</button>`;
  let logging = '';
  if (view.from === 'run' && run && stop) {
    if (!installed) logging = `<div class="alert alert-warning mt-3">${L.escapeHtml(INSTALL_TEXT)}</div>`;
    else {
      const w = L.winLoss(stop.in, stop.out);
      logging = `<div class="card mt-3"><div class="card-body"><h2 class="h6">Log this stop</h2>
        <button class="btn btn-sm ${stop.redeemed ? 'btn-success' : 'btn-primary'}" id="logToggle">${stop.redeemed ? 'Redeemed ✓' : 'Mark as Redeemed'}</button>
        ${stop.redeemed ? `<div class="row g-2 mt-2"><div class="col"><label class="form-label">Money In ($)</label><input type="number" step="0.01" class="form-control" id="logIn" value="${L.escapeHtml(stop.in ?? '')}"></div>
        <div class="col"><label class="form-label">Money Out ($)</label><input type="number" step="0.01" class="form-control" id="logOut" value="${L.escapeHtml(stop.out ?? '')}"></div></div>
        <p class="mt-2" id="logWL">Win/Loss: ${w !== null ? `<strong class="${w >= 0 ? 'text-success' : 'text-danger'}">${L.formatMoney(w)}</strong>` : '<em>Not displayed — both In and Out are blank (stop still counts as redeemed).</em>'}</p>
        <p class="text-muted small">Win/Loss = Out − In. If you fill only one box, the other counts as 0.</p>` : ''}
        </div></div>`;
    }
  }
  app.innerHTML = `<div class="d-flex flex-wrap gap-1 mb-2">${catBadges(c)} ${expiredMark(c)} ${c.isPersonal ? '<span class="badge text-bg-info">Personal coupon</span>' : '<span class="badge text-bg-secondary">Master coupon</span>'}</div>
    <h2 class="h5">${L.escapeHtml(c.title)}</h2>
    <p><strong>Venue:</strong> ${L.escapeHtml(locTitle(c))}<br><strong>Book:</strong> ${L.escapeHtml(c.bookShortTitle || 'Personal')}<br>
    <strong>Start:</strong> ${c.startDate || 'Not given'}<br><strong>Expires:</strong> ${c.expirationDate || 'Ongoing until removed from the master list'}${exp ? ' — EXPIRED' : ''}</p>
    <div>${L.linkify(c.description || '')}</div>
    ${c.extra ? `<p class="mt-2"><strong>Extra:</strong> ${L.linkify(c.extra)}</p>` : ''}
    <p><strong>Source:</strong> ${L.escapeHtml(c.source || '')} ${c.sourceUrl ? `<a href="${L.escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">Evidence link (opens outside the app)</a>` : ''}</p>
    <p><strong>In runs:</strong> ${inRuns.length ? L.escapeHtml(inRuns.join(', ')) : 'None'}</p>
    <p>${mapsBtns} ${vpfree}</p>
    <div class="alert alert-secondary small" role="note">${L.escapeHtml(DISCLAIMER)} <em>Final legal wording is still an open question in the requirements; this plain wording is used until the curator supplies it.</em></div>
    ${logging}
    ${c.isPersonal ? `<div class="mt-3"><button class="btn btn-sm btn-outline-danger" id="delPersonal">Delete</button></div>` : ''}`;
  $('#hdrEditP')?.addEventListener('click', () => go({ name: 'personalEdit', couponId: c.id }));
  $('#delPersonal')?.addEventListener('click', () => {
    const inAny = runs.filter(r => r.stops.some(s => s.couponId === c.id));
    if (inAny.length) { alert(`Cannot delete: this coupon is in run(s): ${inAny.map(r => r.name).join(', ')}. Remove it from all runs first.`); return; }
    if (!confirm('Delete this personal coupon?')) return;
    store.del('personal', c.id).then(() => { personal = personal.filter(p => p.id !== c.id); coupons = coupons.filter(x => x.id !== c.id); goAnchor({ name: 'coupons' }); });
  });
  const toggle = $('#logToggle');
  if (toggle && stop) {
    toggle.onclick = () => { stop.redeemed = !stop.redeemed; if (!stop.redeemed) { stop.in = ''; stop.out = ''; } store.put('runs', run).then(render); };
    const saveLog = () => { stop.in = $('#logIn')?.value ?? stop.in; stop.out = $('#logOut')?.value ?? stop.out; store.put('runs', run).then(() => { const w2 = L.winLoss(stop.in, stop.out); const el = $('#logWL'); if (el) el.innerHTML = `Win/Loss: ${w2 !== null ? `<strong class="${w2 >= 0 ? 'text-success' : 'text-danger'}">${L.formatMoney(w2)}</strong>` : '<em>Not displayed — both In and Out are blank (stop still counts as redeemed).</em>'}`; }); };
    $('#logIn')?.addEventListener('change', saveLog);
    $('#logOut')?.addEventListener('change', saveLog);
    if (focusInOutOnDetail) { focusInOutOnDetail = false; setTimeout(() => $('#logIn')?.focus(), 0); }
  }
}
function renderPersonalEdit() {
  const existing = view.couponId ? personal.find(p => p.id === view.couponId) : null;
  if (!installed) { setHeader('Personal coupon', '', '←'); app.innerHTML = `<div class="alert alert-warning">${L.escapeHtml(INSTALL_TEXT)}</div>`; return; }
  // Fix C(1): no-list guard — never touch master.locations when there is
  // no list. The blocking modal covers this screen, but it must not throw.
  if (!L.hasMasterList(master)) { setHeader('Personal coupon', '', '←'); app.innerHTML = `<div class="alert alert-warning">No master list loaded yet. Use Retry in the blocking message to load it.</div>`; return; }
  setHeader(existing ? 'Edit personal coupon' : 'Add personal coupon', `<button class="btn btn-sm btn-outline-secondary" id="hdrCancelP">Cancel</button> ${existing ? '<button class="btn btn-sm btn-outline-danger" id="hdrDelP">Delete</button>' : ''}`, '< Save');
  // Personal category is synthetic and always attached at save/load, so it
  // is deliberately NOT offered as a checkbox here — the user picks real
  // categories; 'personal' is added automatically (fix G).
  const cats = L.sortedCategories(master.categories).filter(c => c.id !== 'personal');
  // Personal category is built-in; ensure it exists in the list for display.
  const sel = new Set(existing?.categories || []);
  app.innerHTML = `<form id="pForm" class="d-grid gap-3">
    <div><label class="form-label">Title</label><input class="form-control" id="pTitle" required value="${L.escapeHtml(existing?.title || '')}"></div>
    <div><label class="form-label">Location (type to filter)</label><input class="form-control" id="pLocSearch" placeholder="Type a venue name…">
      <select class="form-select mt-1" id="pLoc" size="6">${master.locations.map(l => `<option value="${l.id}" ${existing?.location === l.id ? 'selected' : ''}>${L.escapeHtml(l.title)}</option>`).join('')}</select></div>
    <fieldset><legend class="h6">Categories</legend>${cats.map(c => `<label class="d-block"><input type="checkbox" data-pcat="${c.id}" ${sel.has(c.id) ? 'checked' : ''}> ${L.escapeHtml(c.shortTitle)}. ${L.escapeHtml(c.title)}</label>`).join('')}</fieldset>
    <div><label class="form-label">Description</label><textarea class="form-control" id="pDesc" rows="4">${L.escapeHtml(existing?.description || '')}</textarea></div>
    <div><label class="form-label">Source</label><textarea class="form-control" id="pSrc" rows="2">${L.escapeHtml(existing?.source || '')}</textarea></div>
    <div><label class="form-label">Extra</label><textarea class="form-control" id="pExtra" rows="2">${L.escapeHtml(existing?.extra || '')}</textarea></div>
    <div class="row"><div class="col"><label class="form-label">Start date</label><input type="date" class="form-control" id="pStart" value="${existing?.startDate || ''}"></div>
    <div class="col"><label class="form-label">End date</label><input type="date" class="form-control" id="pEnd" value="${existing?.expirationDate || ''}"></div></div>
    <p class="text-muted small">Personal coupons live in the built-in Personal book and Personal category, as regular coupons.</p></form>`;
  $('#pLocSearch').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    [...$('#pLoc').options].forEach(o => o.hidden = q && !o.text.toLowerCase().includes(q));
  });
  $('#hdrCancelP').onclick = () => {
    if (confirm('Discard changes?')) goBack();
  };
  $('#hdrDelP')?.addEventListener('click', () => {
    const inAny = runs.filter(r => r.stops.some(s => s.couponId === existing.id));
    if (inAny.length) { alert(`Cannot delete: this coupon is in run(s): ${inAny.map(r => r.name).join(', ')}. Remove it from all runs first.`); return; }
    if (!confirm('Delete this personal coupon?')) return;
    store.del('personal', existing.id).then(() => { personal = personal.filter(p => p.id !== existing.id); coupons = coupons.filter(x => x.id !== existing.id); goAnchor({ name: 'coupons' }); });
  });
  window._savePersonal = () => {
    const title = $('#pTitle').value.trim(); if (!title) { alert('Title is required.'); return; }
    const catsSel = [...document.querySelectorAll('[data-pcat]')].filter(x => x.checked).map(x => x.dataset.pcat);
    if (!catsSel.length) { alert('Choose at least one category.'); return; }
    // Fix G: the synthetic Personal category is always attached, so a
    // personal coupon can be filtered by it. It is not a user checkbox
    // (see renderPersonalEdit) and is never written to master-list.json.
    const rec = L.withPersonalCategory({ id: existing?.id || uid('personal'), location: $('#pLoc').value, title, description: $('#pDesc').value, categories: catsSel, startDate: $('#pStart').value || null, expirationDate: $('#pEnd').value || null, source: $('#pSrc').value, extra: $('#pExtra').value, removed: false, isPersonal: true, bookId: 'personal', bookTitle: 'Personal', bookShortTitle: 'Personal' });
    store.put('personal', rec).then(() => {
      if (existing) { personal = personal.map(p => p.id === rec.id ? rec : p); coupons = coupons.map(x => x.id === rec.id ? { ...rec } : x); }
      else { personal.push(rec); coupons.push({ ...rec }); }
      // Return-to-caller: PersonalEdit was pushed when opened, so popping
      // returns to its opener (Coupons, or Detail if opened from Detail).
      goBack();
    });
  };
}
function savePersonalFromForm() { if (window._savePersonal) window._savePersonal(); else goBack(); }

// ---- Map ----
function renderMapView(filtered, ctx, settings, run) {
  // Fresh map object: drop the dot from the previous map so the new map
  // gets its own dot (a marker added to the old map would not show here).
  userMarker = null;
  const withCoords = filtered.filter(c => { const l = locsById[c.location]; return l && l.latitude !== null && l.longitude !== null && !L.isExpired(c, today()); });
  const noLoc = filtered.filter(c => { const l = locsById[c.location]; return !(l && l.latitude !== null && l.longitude !== null); });
  // Redeemed and expired are NOT shown on the map; expired already filtered by withCoords check, redeemed filtered for run context:
  const mapCoupons = ctx === 'run' && run ? withCoords.filter(c => !(run.stops.find(s => s.couponId === c.id)?.redeemed)) : withCoords;
  app.innerHTML = `<div id="map" style="height:60vh"></div>
    <button class="btn btn-warning position-fixed" style="left:12px;bottom:110px;z-index:1000" id="noLocBtn">No-location coupons (${noLoc.length})</button>
    <button class="btn btn-light position-fixed" style="right:12px;bottom:110px;z-index:1000" id="centreBtn" aria-label="Centre on my position">◎ My position</button>
    <div id="mapPane" class="card d-none mt-2"><div class="card-body"><div id="paneHandle" class="map-pane-handle" role="button" tabindex="0" aria-label="Drag down to close"><div class="map-pane-grip"></div></div><div class="d-flex justify-content-between"><h2 class="h6" id="paneTitle">Coupons here</h2><button class="btn btn-sm btn-outline-secondary" id="paneClose" aria-label="Close">×</button></div><div id="paneList"></div></div></div>
    <p class="text-muted small mt-2">Map pins merge coupons within 10 metres; cluster pins group nearby pins at lower zoom. Tap a cluster to zoom in; at max zoom, nearby pins spread out (spiderfy) — tap a pin to see its coupons below. Redeemed and expired coupons are not shown on the map.</p>`;
  const back = loadBack();
  const centre = back?.map ? [back.map.lat, back.map.lng] : [36.1699, -115.1398];
  const zoom = back?.map?.zoom || 12;
  mapObj = LmapInit('map', centre, zoom);
  // Leaflet via global L from CDN would clash with logic import alias; use window.L.
  const leaf = window.L;
  function showPane(g) {
    // Tap-selected-pin-again closes: if this group is already open, close it.
    if (lastPaneGroup === g && !$('#mapPane').classList.contains('d-none')) { hidePane(); return; }
    lastPaneGroup = g;
    $('#paneTitle').textContent = g.venue + ` (${g.coupons.length})`;
    const pane = $('#paneList');
    pane.innerHTML = g.coupons.map(c => cardHtml(c, ctx === 'run' ? { mode: 'run', run } : { mode: 'browse' })).join('') || '<p class="text-muted">No coupons here.</p>';
    bindCards(pane, { onAction: (act, id) => { if (ctx === 'run') { const stop = run.stops.find(s => s.couponId === id); if (act === 'mark') { focusInOutOnDetail = true; openDetail(id, 'run'); } if (act === 'toggle' && stop) { stop.redeemed = !stop.redeemed; store.put('runs', run).then(render); } } } }, id => openDetail(id, ctx));
    const el = $('#mapPane'); el.classList.remove('d-none'); el.style.transform = '';
  }
  $('#noLocBtn').onclick = () => showPane({ venue: 'No location', coupons: noLoc });
  $('#paneClose').onclick = () => hidePane();
  // Close pane by tapping empty map.
  mapObj.on('click', () => hidePane());
  $('#centreBtn').onclick = () => centreOnMe();
  // Header controls for map view (bound before the Leaflet guard below, so
  // list view stays reachable even when the map library failed to load).
  $('#hdrView').onclick = () => { if (ctx === 'run') saveView('view-run-' + run.id, { mode: 'list' }); else saveView('view-coupons', { mode: 'list' }); render(); };
  $('#hdrFilter').onclick = () => go({ name: 'filter', ctx: ctx === 'run' ? 'run' : 'browse', runId: run?.id });
  bindHdrPersonal();
  bindPaneHandleDrag();
  // Fix B: guard cluster creation on Leaflet + MarkerCluster actually
  // loading. LmapInit already wrote the "Map library did not load — list
  // view still works" warning into #map; return early so nothing below
  // throws and the half-rendered map / unbound buttons cannot happen.
  // The No-location pane, header List/Filter buttons and pane close above
  // still work without Leaflet.
  if (!L.canInitMap(leaf)) return;
  const cluster = leaf.markerClusterGroup();
  // Group by 10m merge: bucket coupons by rounded position / proximity.
  const groups = [];
  for (const c of mapCoupons) {
    const l = locsById[c.location];
    let g = groups.find(g => L.distanceM(g.lat, g.lng, l.latitude, l.longitude) <= 10);
    if (!g) { g = { lat: l.latitude, lng: l.longitude, venue: l.title, coupons: [] }; groups.push(g); }
    g.coupons.push(c);
  }
  groups.forEach(g => {
    const m = leaf.marker([g.lat, g.lng]).on('click', () => showPane(g));
    m._group = g; cluster.addLayer(m);
  });
  mapObj.addLayer(cluster);
  mapMarkers = cluster;
  startGeolocation();
}
function bindPaneHandleDrag() {
  // Fix E: drag-down-by-handle closes the half-pane. Pointer events cover
  // mouse + touch (touch-action:none in CSS); a touch fallback is added
  // only when PointerEvent is unavailable, so the two never double-fire.
  // Threshold 80px down. Existing fallbacks keep working: the × button,
  // tap-selected-pin-again (showPane toggle), and tap-empty-map (map click).
  const handle = $('#paneHandle'), pane = $('#mapPane');
  if (!handle || !pane) return;
  const THRESHOLD = 80;
  let startY = null, dragging = false;
  const move = dy => { if (dy > 0) pane.style.transform = `translateY(${dy}px)`; };
  const end = dy => {
    dragging = false; startY = null;
    if (dy >= THRESHOLD) hidePane(); else pane.style.transform = '';
  };
  handle.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hidePane(); } });
  if (window.PointerEvent) {
    handle.addEventListener('pointerdown', e => { startY = e.clientY; dragging = true; try { handle.setPointerCapture(e.pointerId); } catch {} });
    handle.addEventListener('pointermove', e => { if (dragging && startY !== null) move(e.clientY - startY); });
    const up = e => { if (dragging && startY !== null) end(e.clientY - startY); };
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', () => { dragging = false; startY = null; pane.style.transform = ''; });
  } else {
    handle.addEventListener('touchstart', e => { startY = e.touches[0].clientY; dragging = true; }, { passive: true });
    handle.addEventListener('touchmove', e => { if (dragging && startY !== null) move(e.touches[0].clientY - startY); }, { passive: true });
    handle.addEventListener('touchend', e => { if (dragging && startY !== null) end(e.changedTouches[0].clientY - startY); });
  }
}
function LmapInit(id, centre, zoom) {
  const leaf = window.L;
  if (!leaf) { document.getElementById(id).innerHTML = '<p class="alert alert-warning">Map library (Leaflet) did not load — check your connection. List view still works.</p>'; return { getCenter: () => ({ lat: centre[0], lng: centre[1] }), getZoom: () => zoom, addLayer: () => {}, on: () => {} }; }
  const m = leaf.map(id).setView(centre, zoom);
  leaf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(m);
  return m;
}
function updateUserDot(pos) {
  const ll = [pos.coords.latitude, pos.coords.longitude];
  if (window.L && mapObj && mapObj.addLayer) {
    if (userMarker) userMarker.setLatLng(ll); else userMarker = window.L.circleMarker(ll, { radius: 8, color: '#0d6efd' }).addTo(mapObj);
  }
}
function centreOnMe() {
  // Explicit tap only: centre the map once AND show the dot. This is the
  // only place where a position update moves the map. There is no
  // follow-me, no watch, and no automatic recentring anywhere else.
  if (!navigator.geolocation) { alert('Geolocation is not available on this device.'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (mapObj && mapObj.setView) mapObj.setView(ll, mapObj.getZoom ? mapObj.getZoom() : 15);
    updateUserDot(pos);
  }, () => alert('Could not get your position. Check location permission for this app.'));
}
function startGeolocation() {
  // Show the user's position dot when the map opens, without moving the
  // map at all: no setView, no zoom change, no watch. The dot is display
  // only — panning and zooming stay exactly where the user left them,
  // and a later position update never snaps the map back. Silent on
  // denial/error: opening the map must not pop an alert for a dot the
  // user did not ask to centre on.
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(updateUserDot, () => {});
}

// ---- Sharing ----
let pendingShareRun = null;
function openShareModal(run) {
  const modal = $('#shareModal');
  if (!modal) { doShareRun(run, false); return; } // stale shell without the modal: share summary, never prompt
  pendingShareRun = run;
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
}
function closeShareModal() {
  const modal = $('#shareModal');
  if (modal) { modal.style.display = 'none'; modal.setAttribute('aria-hidden', 'true'); }
  pendingShareRun = null;
}
// Fix F: the summary-vs-detailed choice is a real picker (two buttons +
// Cancel in the #shareModal overlay in index.html), not a prompt(). The
// underlying share logic below is unchanged: phone Share if available,
// else clipboard, else the manual-copy fallback. Other prompt()/confirm()
// flows (run name, run/personal delete, discard) are deliberately left as-is.
function shareRun(run) { openShareModal(run); }
async function doShareRun(run, detailed) {
  const t = L.runTotal(run.stops);
  let text;
  if (detailed) {
    const lines = [`Coupon Run: ${run.name}`, `Total Win/Loss: ${L.formatMoney(t.total)} (recorded only, ${t.counted} of ${t.totalStops} stops)`, ''];
    for (const s of run.stops) {
      const c = byId(s.couponId); if (!c) continue;
      const w = L.winLoss(s.in, s.out);
      lines.push(`${locTitle(c)} — ${c.title} — ${s.redeemed ? 'Redeemed' : 'Not redeemed'} — In: ${s.in || '—'} Out: ${s.out || '—'} Win/Loss: ${w !== null ? L.formatMoney(w) : '—'}`);
    }
    text = lines.join('\n');
  } else {
    text = `Coupon Run: ${run.name}\nCoupons redeemed: ${run.stops.filter(s => s.redeemed).length} of ${run.stops.length}\nTotal Win/Loss: ${L.formatMoney(t.total)}`;
  }
  if (navigator.share) { try { await navigator.share({ title: 'Coupon Run summary', text }); return; } catch {} }
  try { await navigator.clipboard.writeText(text); alert('Run summary copied to clipboard.'); }
  catch { prompt('Copy this run summary:', text); }
}
// Share picker wiring (modal lives outside #app so render() never wipes it).
$('#shareSummaryBtn')?.addEventListener('click', () => { const r = pendingShareRun; closeShareModal(); if (r) doShareRun(r, false); });
$('#shareDetailedBtn')?.addEventListener('click', () => { const r = pendingShareRun; closeShareModal(); if (r) doShareRun(r, true); });
$('#shareCancelBtn')?.addEventListener('click', closeShareModal);
$('#shareModal')?.addEventListener('click', e => { if (e.target.id === 'shareModal') closeShareModal(); });
// No-list lock Retry wiring (modal lives outside #app so render() never wipes it).
$('#noListRetry')?.addEventListener('click', async () => {
  const btn = $('#noListRetry'), msg = $('#noListMsg');
  if (btn) { btn.disabled = true; btn.textContent = 'Retrying…'; }
  try { await doFetch(true); updateNoListLock(); render(); }
  catch (e) { if (msg) msg.textContent = 'Fetch failed — no list loaded yet. Check your connection and try again.'; if (btn) { btn.disabled = false; btn.textContent = 'Retry'; } }
});

// ---- Fetch (one path) ----
async function doFetch(explicit) {
  const prevText = master ? JSON.stringify(master) : null;
  try {
    const { data, text } = await fetchMaster();
    const errs = L.validateMaster(data);
    if (errs.length) throw new Error('Master list failed validation: ' + errs.slice(0, 3).join('; '));
    const changed = prevText !== text;
    master = data; books = data.books || [];
    setCatsFromMaster(data);
    locsById = {}; data.locations.forEach(l => locsById[l.id] = l);
    coupons = L.flattenMaster(data);
    lastFetchAt = Date.now(); lastFetchText = new Date(lastFetchAt).toLocaleString();
    fetchStatus = explicit ? (changed ? 'Master list updated.' : 'Already up to date.') : (changed ? 'Master list updated in background.' : '');
    // Personal coupons keep their own ids; runs keep stops by coupon id, so a master update never erases personal data.
    // A failed fetch (catch below) never assigns master/coupons, so it
    // never erases a previous list or personal data.
    updateNoListLock();
    return changed;
  } catch (e) {
    if (explicit) throw e;
    // Fix C(2): only claim a previous list was kept when one exists. With
    // no list at all, the blocking modal (not this banner) is the message.
    fetchStatus = master ? 'Fetch failed — previous list kept.' : 'Fetch failed — no list loaded yet.';
    updateNoListLock();
    return false;
  }
}

// ---- Boot ----
async function boot() {
  // Try cached copy first so the app opens offline, then silent fetch.
  const cached = await readCachedMaster();
  if (cached) { master = cached; books = cached.books || []; setCatsFromMaster(cached); locsById = {}; cached.locations.forEach(l => locsById[l.id] = l); coupons = L.flattenMaster(cached); }
  try { runs = await store.getAll('runs'); personal = normalizePersonal(await store.getAll('personal')); } catch { runs = []; personal = []; }
  // Personal coupons are regular coupons in browse: merge them into the
  // browse list (they keep isPersonal/bookId 'personal', plus the synthetic
  // Personal category from normalizePersonal). The doFetch wrapper below
  // re-applies this merge after a fresh master fetch.
  coupons = L.dedupeCouponsById([...coupons, ...personal.map(p => ({ ...p }))]);
  render();
  // Silent, non-blocking fetch on every start.
  doFetch(false).then(() => { if (view.name === 'home' || view.name === 'coupons') render(); });
}
// Personal coupons in browse: the boot merge above appends them to `coupons`
// after the first render; a later fetch re-appends them via doFetch wrapper.
const _doFetch = doFetch;
doFetch = async (explicit) => {
  const r = await _doFetch(explicit);
  // Re-merge personal coupons that a fresh master fetch would otherwise drop.
  const masterIds = new Set(coupons.filter(c => !c.isPersonal).map(c => c.id));
  coupons = L.dedupeCouponsById([...coupons.filter(c => !c.isPersonal), ...normalizePersonal(personal).filter(p => !masterIds.has(p.id))]);
  personal = normalizePersonal(personal);
  return r;
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
boot();
