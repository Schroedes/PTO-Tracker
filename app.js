/* PTO Tracker UI. All data lives in localStorage on this device. */
(function () {
  'use strict';
  const P = window.PTO;
  // Everything is stored in this browser's localStorage; nothing is sent to a server.
  const STORAGE_KEY = 'pto-tracker:v1';
  const SAVED_AT_KEY = STORAGE_KEY + ':savedAt';
  const UNREADABLE_KEY = STORAGE_KEY + ':unreadable';
  // Must be defined before load() runs below (const is not hoisted).
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const $ = (id) => document.getElementById(id);

  // ---------- State ----------
  let state = load();
  let firstRun = !state;
  if (!state) state = defaultState();
  let today = P.todayIso();
  let view = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 };
  let showPast = false;
  let sheetDate = null;
  let sheetBank = 'pto';
  const MONTHS = Array.from({ length: 12 }, (_, i) =>
    new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, i, 1))));

  function defaultState() {
    const t = P.todayIso();
    // Default anchor: the coming Friday.
    const toFri = (5 - P.dayOfWeek(t) + 7) % 7;
    return {
      settings: {
        startingBalance: 0, asOfDate: t, accrualHours: 4, frequency: 'biweekly',
        anchorPayday: P.addDays(t, toFri), cap: null, defaultHours: 8,
      },
      entries: {},
      banks: [],
      leaves: [],
    };
  }
  function load() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try {
      const s = JSON.parse(raw);
      if (valid(s)) return normalize(s);
    } catch (e) { /* fall through */ }
    // Saved data we can't read: keep a copy instead of letting the first-run setup overwrite it.
    try { if (!localStorage.getItem(UNREADABLE_KEY)) localStorage.setItem(UNREADABLE_KEY, raw); } catch (e) { /* ignore */ }
    return null;
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      localStorage.setItem(SAVED_AT_KEY, new Date().toISOString());
    } catch (e) {
      toast('Could not save — this browser is blocking storage (private mode?)');
      return;
    }
    requestPersistence();
  }

  /**
   * Ask the browser to keep our data even when it's short on space. Chrome/Edge grant this silently
   * for sites you use or install; Firefox may ask once; Safari keeps data for Home Screen apps.
   */
  let persistAsked = false;
  function requestPersistence() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persisted()
      .then((already) => already || navigator.storage.persist())
      .catch(() => {})
      .then(renderStorageStatus);
  }

  async function renderStorageStatus() {
    const el = $('storage-status');
    if (!el) return;
    let savedAt = null;
    try { savedAt = localStorage.getItem(SAVED_AT_KEY); } catch (e) { /* ignore */ }
    let persisted = null;
    try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (e) { /* ignore */ }
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const when = savedAt ? new Date(savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
    let msg = 'Your data is saved in this browser on this device' + (when ? ' (last saved ' + when + ')' : '') + '. Nothing is sent to a server. ';
    if (persisted) msg += 'Storage is marked persistent, so the browser won’t clear it on its own.';
    else if (standalone) msg += 'It stays as long as the app is on your Home Screen.';
    else msg += 'Browsers can clear site data — iPhone Safari does after 7 days without a visit — so add the app to your Home Screen and export a backup now and then.';
    el.textContent = msg;
  }
  function valid(s) {
    return s && s.settings && ISO_RE.test(s.settings.asOfDate) && typeof s.entries === 'object';
  }
  function normalize(s) {
    const d = defaultState().settings;
    const settings = Object.assign({}, d, s.settings);
    const entries = {};
    for (const [k, v] of Object.entries(s.entries || {})) {
      if (!ISO_RE.test(k) || !v || !(Number(v.hours) > 0)) continue;
      entries[k] = { hours: Number(v.hours), note: String(v.note || '') };
      if (v.trip) entries[k].trip = String(v.trip);
      if (v.bank && v.bank !== 'pto') entries[k].bank = String(v.bank);
    }
    const banks = (Array.isArray(s.banks) ? s.banks : []).filter((b) => b && b.id).map((b) => ({
      id: String(b.id), name: String(b.name || 'Personal days'), unit: b.unit === 'hours' ? 'hours' : 'days',
      amount: Number(b.amount) || 0, startingBalance: Number(b.startingBalance) || 0,
      month: Math.min(12, Math.max(1, Number(b.month) || 1)), day: Math.min(31, Math.max(1, Number(b.day) || 1)),
      expiry: ['next-grant', 'year-end', 'never'].includes(b.expiry) ? b.expiry : 'next-grant',
    }));
    // Entries pointing at a bank that no longer exists fall back to PTO.
    const ids = new Set(banks.map((b) => b.id));
    for (const e of Object.values(entries)) if (e.bank && !ids.has(e.bank)) delete e.bank;
    const leaves = (Array.isArray(s.leaves) ? s.leaves : [])
      .filter((l) => l && ISO_RE.test(l.start))
      .map((l) => ({ id: String(l.id || 'l' + l.start), start: l.start, end: ISO_RE.test(l.end || '') ? l.end : '', note: String(l.note || '') }));
    return { settings, entries, banks, leaves };
  }

  // ---------- Formatting ----------
  const fmtCache = {};
  function fmtDate(iso, opts) {
    const key = JSON.stringify(opts);
    const f = fmtCache[key] || (fmtCache[key] = new Intl.DateTimeFormat(undefined, Object.assign({ timeZone: 'UTC' }, opts)));
    return f.format(new Date(P.toDayNum(iso) * 86400000));
  }
  const shortDate = (iso) => fmtDate(iso, { month: 'short', day: 'numeric' });
  const shortDay = (iso) => fmtDate(iso, { weekday: 'short', month: 'short', day: 'numeric' });
  const longDay = (iso) => fmtDate(iso, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  function num(x) {
    const r = P.round2(x);
    const s = Math.abs(r).toLocaleString(undefined, { maximumFractionDigits: 2 });
    return (r < 0 ? '−' : '') + s;
  }
  const h = (x) => num(x) + 'h';
  const signed = (x) => (x > 0 ? '+' : '') + h(x);
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Projection helpers ----------
  function viewEnd() {
    return P.isoFromParts(view.year, view.month + 1, 7); // a week into next month covers the grid
  }
  function horizon() {
    return P.horizonFor(state, today, viewEnd());
  }
  function timeline(st) {
    return P.buildTimeline(st || state, horizon());
  }
  function totalLost(tl) {
    let t = 0;
    for (const d of tl.days.values()) t += d.lost;
    return P.round2(t);
  }
  const isCounted = (iso) => P.toDayNum(iso) <= P.toDayNum(state.settings.asOfDate);
  const banks = () => state.banks || [];
  const leaves = () => state.leaves || [];
  const leaveOn = (iso) => P.leaveOn(leaves(), iso);
  const leaveLabel = (l) => shortDate(l.start) + (l.end ? ' – ' + shortDate(l.end) : ' onward');
  const bankById = (id) => banks().find((b) => b.id === id) || null;
  const entryBank = (e) => (e && e.bank ? bankById(e.bank) : null);
  function bankTimeline(bank, st) {
    return P.buildBankTimeline(st || state, bank, horizon());
  }
  function bankBalanceOn(btl, iso) {
    const d = btl.days.get(iso);
    if (d) return d.balance;
    return P.toDayNum(iso) < P.toDayNum(btl.start) ? btl.days.get(btl.start).balance : null;
  }
  /** "24h" or "24h (3 days)" for banks counted in days. */
  function bankAmount(bank, hours) {
    if (bank.unit !== 'days') return h(hours);
    const days = P.round2(hours / (Number(state.settings.defaultHours) || 8));
    return h(hours) + ' (' + num(days) + (Math.abs(days) === 1 ? ' day)' : ' days)');
  }
  /** Lowest bank balance in [fromIso, end] (null if none). */
  function bankLow(btl, fromIso) {
    let min = Infinity, minDate = null;
    const from = Math.max(P.toDayNum(fromIso), P.toDayNum(btl.start));
    for (let n = from; n <= P.toDayNum(btl.end); n++) {
      const iso = P.fromDayNum(n);
      const b = btl.days.get(iso).balance;
      if (b < min) { min = b; minDate = iso; }
    }
    return minDate ? { min: P.round2(min), minDate } : null;
  }
  /** Next loss of unused hours on/after fromIso: { date (last usable day), hours }. */
  function nextBankLoss(btl, fromIso) {
    for (let n = Math.max(P.toDayNum(fromIso), P.toDayNum(btl.start) + 1); n <= P.toDayNum(btl.end); n++) {
      const iso = P.fromDayNum(n);
      const d = btl.days.get(iso);
      if (d.lost > 0) return { date: P.addDays(iso, -1), hours: d.lost };
    }
    return null;
  }

  // ---------- Render ----------
  function render() {
    today = P.todayIso();
    const tl = timeline();
    renderSummary(tl);
    renderBanks();
    renderAlerts(tl);
    renderCalendar(tl);
    renderList(tl);
  }

  function setVal(id, text, negative) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle('neg', !!negative);
  }

  function renderSummary(tl) {
    const s = state.settings;
    const ref = P.toDayNum(today) < P.toDayNum(s.asOfDate) ? s.asOfDate : today;
    const bal = P.balanceOn(tl, ref);
    setVal('sum-today', h(bal), bal < 0);
    $('sum-today-sub').textContent = 'From stub on ' + shortDate(s.asOfDate);

    const np = P.nextPayday(s, today);
    if (np) {
      const d = tl.days.get(np);
      $('sum-payday').textContent = shortDay(np).replace(',', '');
      $('sum-payday').classList.remove('neg');
      $('sum-payday-sub').textContent = !d ? '' : d.paused > 0 && d.accrued === 0 ? 'Paused for leave'
        : signed(d.accrued) + (d.paused > 0 ? ' (part leave)' : '') + ' → ' + h(d.balance);
      $('card-payday').dataset.date = np;
    }

    const lp = P.lowPoint(tl, today);
    setVal('sum-low', h(lp.min), lp.min < 0);
    $('sum-low-sub').textContent = 'on ' + shortDate(lp.minDate);
    $('card-low').dataset.date = lp.minDate;

    let y = Number(today.slice(0, 4));
    if (today.slice(5) > '12-15') y += 1;
    const eoy = y + '-12-31';
    const eb = P.balanceOn(P.buildTimeline(state, P.toDayNum(eoy) > P.toDayNum(tl.end) ? eoy : tl.end), eoy);
    $('sum-eoy-label').textContent = 'Dec 31, ' + y;
    setVal('sum-eoy', eb === null ? '–' : h(eb), eb < 0);
    $('sum-eoy-sub').textContent = 'with current plan';
    $('card-eoy').dataset.date = eoy;
  }

  function renderBanks() {
    const box = $('banks');
    const list = banks();
    box.hidden = list.length === 0;
    const ref = P.toDayNum(today) < P.toDayNum(state.settings.asOfDate) ? state.settings.asOfDate : today;
    box.innerHTML = list.map((b) => {
      const btl = bankTimeline(b);
      const left = bankBalanceOn(btl, ref);
      const next = P.grantDatesBetween(b, P.addDays(today, -1), P.addDays(today, 367))[0];
      const loss = nextBankLoss(btl, today);
      let sub = next ? 'Next: +' + bankAmount(b, P.bankHours(b, b.amount, state.settings.defaultHours)) + ' on ' + shortDate(next) : '';
      const warn = loss ? '<span class="bank-warn">' + esc(h(loss.hours)) + ' unused will expire after ' + esc(shortDate(loss.date)) + '</span>' : '';
      const unit = b.unit === 'days' ? P.round2(left / (Number(state.settings.defaultHours) || 8)) : null;
      return '<button type="button" class="bank-card" data-date="' + esc(loss ? loss.date : next || today) + '">' +
        '<span class="bank-icon"><span class="icon" aria-hidden="true">redeem</span></span>' +
        '<span class="bank-text"><span class="title-small">' + esc(b.name) + '</span>' +
        '<span class="body-small">' + esc(sub) + '</span>' + (warn ? '<span class="body-small">' + warn + '</span>' : '') + '</span>' +
        '<span class="bank-left' + (left < 0 ? ' neg' : '') + '">' + esc(h(left)) +
        (unit !== null ? '<small>' + esc(num(unit)) + (Math.abs(unit) === 1 ? ' day' : ' days') + ' left</small>' : '<small>left</small>') + '</span>' +
        '</button>';
    }).join('');
  }

  function renderAlerts(tl) {
    const box = $('alert');
    const items = [];
    const lp = P.lowPoint(tl, today);
    const current = leaveOn(today);
    if (current) {
      items.push(['info', 'You’re on leave' + (current.note ? ' (' + esc(current.note) + ')' : '') + ', so PTO isn’t accruing ' +
        (current.end ? 'through your last day of leave, <b>' + esc(shortDay(current.end)) + '</b>' : 'until you set a return date') +
        '. You can still use PTO to top up your pay.', 'settings', 'Edit leave']);
    } else {
      const soon = leaves().filter((l) => l.start > today && P.toDayNum(l.start) - P.toDayNum(today) <= 45).sort((a, b) => (a.start < b.start ? -1 : 1))[0];
      if (soon) {
        items.push(['info', 'Leave starts <b>' + esc(shortDay(soon.start)) + '</b>. PTO accrual pauses ' +
          (soon.end ? 'through ' + esc(shortDate(soon.end)) : 'until you set a return date') + '.', soon.start, 'View']);
      }
    }
    if (lp.firstNegative) {
      items.push(['bad', 'Your plan goes negative on <b>' + esc(shortDay(lp.firstNegative)) + '</b> (lowest ' +
        esc(h(lp.min)) + ' on ' + esc(shortDate(lp.minDate)) + ').', lp.firstNegative, 'View']);
    }
    let lost = 0, firstLost = null;
    for (const [iso, d] of tl.days) {
      if (d.lost > 0 && P.toDayNum(iso) >= P.toDayNum(today) && P.toDayNum(iso) <= P.toDayNum(today) + 366) {
        lost += d.lost; if (!firstLost) firstLost = iso;
      }
    }
    if (lost > 0) {
      items.push(['warn', 'You’ll hit your cap and lose <b>' + esc(h(lost)) + '</b> of accrual over the next year, starting ' +
        esc(shortDate(firstLost)) + '. Plan some time off before then.', firstLost, 'View']);
    }
    for (const b of banks()) {
      const loss = nextBankLoss(bankTimeline(b), today);
      if (loss && P.toDayNum(loss.date) - P.toDayNum(today) <= 60) {
        items.push(['warn', '<b>' + esc(h(loss.hours)) + '</b> of ' + esc(b.name) + ' will expire after <b>' +
          esc(shortDay(loss.date)) + '</b>. Book them before then.', loss.date, 'View']);
      }
    }
    const age = P.toDayNum(today) - P.toDayNum(state.settings.asOfDate);
    if (age > 45) {
      items.push(['warn', 'Your balance was last updated ' + esc(shortDate(state.settings.asOfDate)) +
        '. Enter the number from your latest pay stub to stay accurate.', 'settings', 'Update']);
    }
    box.innerHTML = items.map(([cls, html, target, label]) =>
      '<div class="alert-item ' + cls + '"><span class="icon" aria-hidden="true">' + ({ bad: 'error', info: 'beach_access' }[cls] || 'warning') + '</span>' +
      '<span class="body-medium">' + html + '</span>' +
      '<button type="button" class="button text" data-target="' + target + '">' + label + '</button></div>').join('');
    box.hidden = items.length === 0;
  }

  function renderCalendar(tl) {
    const grid = $('grid');
    const first = P.isoFromParts(view.year, view.month, 1);
    $('month-label').textContent = fmtDate(first, { month: 'long', year: 'numeric' });
    const start = P.addDays(first, -P.dayOfWeek(first));
    const dim = P.daysInMonth(view.year, view.month);
    const cells = Math.ceil((P.dayOfWeek(first) + dim) / 7) * 7;
    const cap = state.settings.cap;
    const todayNum = P.toDayNum(today);
    const grantDays = new Map();
    for (const b of banks()) {
      for (const g of P.grantDatesBetween(b, P.addDays(start, -1), P.addDays(start, cells))) grantDays.set(g, b);
    }
    const bl = banks();
    $('lg-bank').hidden = $('lg-grant').hidden = bl.length === 0;
    $('lg-leave').hidden = leaves().length === 0;
    $('lg-bank-label').textContent = bl.length === 1 ? bl[0].name : 'Personal day';
    let html = '';
    for (let i = 0; i < cells; i++) {
      const iso = P.addDays(start, i);
      const n = P.toDayNum(iso);
      const d = tl.days.get(iso);
      const entry = state.entries[iso];
      const cls = ['day'];
      if (Number(iso.slice(5, 7)) - 1 !== view.month) cls.push('out');
      if (iso === today) cls.push('today');
      if (n < todayNum) cls.push('past');
      if (entry) cls.push('off');
      if (entry && entryBank(entry)) cls.push('bank');
      if (grantDays.has(iso)) cls.push('grant');
      if (leaveOn(iso)) cls.push('leave');
      if (entry && isCounted(iso)) cls.push('counted');
      if (d && d.payday) cls.push('payday');
      if (d && d.balance < 0) cls.push('negative');
      if (d && d.lost > 0) cls.push('capped');
      else if (d && cap !== null && cap !== '' && d.balance >= Number(cap) && d.payday) cls.push('capped');
      const label = [longDay(iso)];
      if (d) label.push('balance ' + h(d.balance));
      if (entry) label.push(h(entry.hours) + ' off' + (entryBank(entry) ? ' from ' + entryBank(entry).name : ''));
      if (grantDays.has(iso)) label.push(grantDays.get(iso).name + ' granted');
      if (d && d.payday) label.push(d.paused > 0 && d.accrued === 0 ? 'payday, accrual paused' : 'payday');
      if (leaveOn(iso)) label.push('on leave');
      html += '<button type="button" class="' + cls.join(' ') + '" data-date="' + iso + '" aria-label="' + esc(label.join(', ')) + '">' +
        '<span class="num">' + Number(iso.slice(8)) + '</span>' +
        (entry ? '<span class="used">−' + esc(num(entry.hours)) + '</span>' : '') +
        (d ? '<span class="bal">' + esc(num(d.balance)) + '</span>' : '') +
        '</button>';
    }
    grid.innerHTML = html;
  }

  function renderList(tl) {
    const dates = Object.keys(state.entries).sort();
    const upcoming = dates.filter((d) => d >= today);
    const past = dates.filter((d) => d < today);
    const total = upcoming.reduce((a, d) => a + state.entries[d].hours, 0);
    $('planned-total').textContent = upcoming.length ? h(total) + ' · ' + upcoming.length + (upcoming.length === 1 ? ' day' : ' days') : '';
    // One row per trip; a single day is just a one-day trip.
    const row = (trip) => {
      const d = trip[0];
      const last = trip[trip.length - 1];
      const e = state.entries[d];
      const hours = trip.reduce((a, x) => a + state.entries[x].hours, 0);
      const bank = entryBank(state.entries[last]);
      const b = bank ? bankBalanceOn(bankTimeline(bank), last) : P.balanceOn(tl, last);
      const after = isCounted(last) ? 'already counted' : bank ? h(b) + ' left' : 'leaves ' + h(b);
      const year = d.slice(0, 4) !== today.slice(0, 4) ? ' ' + d.slice(0, 4) : '';
      const when = trip.length > 1
        ? '<span class="range">' + esc(shortDate(d)) + ' – ' + esc(shortDate(last)) + year + ' · ' + trip.length + ' days</span>'
        : esc(fmtDate(d, { weekday: 'long' })) + year;
      let note = trip.map((x) => state.entries[x].note).find((n) => n) || '';
      if (bank) note = bank.name + (note ? ' · ' + note : '');
      return '<li' + (bank ? ' class="bank-row"' : '') + '><button type="button" data-date="' + d + '">' +
        '<span class="avatar" aria-hidden="true"><span><small>' + esc(fmtDate(d, { month: 'short' })) + '</small>' + Number(d.slice(8)) + '</span></span>' +
        '<span class="when">' + when + '</span>' +
        '<span class="hrs">−' + esc(h(hours)) + '</span>' +
        '<span class="note">' + esc(note || e.note || '') + '</span>' +
        '<span class="after' + (b !== null && b < 0 && !isCounted(last) ? ' neg' : '') + '">' + esc(after) + '</span>' +
        '</button></li>';
    };
    $('upcoming-list').innerHTML = upcoming.length ? P.groupTrips(state.entries, upcoming).map(row).join('')
      : '<li class="empty">Nothing planned yet. Tap a day on the calendar to add time off.</li>';
    const tp = $('toggle-past');
    tp.hidden = past.length === 0;
    tp.textContent = (showPast ? 'Hide' : 'Show') + ' past time off (' + past.length + ')';
    $('past-list').hidden = !showPast || past.length === 0;
    $('past-list').innerHTML = P.groupTrips(state.entries, past).reverse().map(row).join('');
  }

  // ---------- Day sheet ----------
  function openDay(iso) {
    sheetDate = iso;
    const entry = state.entries[iso];
    const tl = timeline();
    const d = tl.days.get(iso);
    $('day-title').textContent = longDay(iso);

    const tags = [];
    if (iso === today) tags.push('<span class="tag">Today</span>');
    const w = P.dayOfWeek(iso);
    if (w === 0 || w === 6) tags.push('<span class="tag">Weekend</span>');
    if (d && d.payday) {
      tags.push('<span class="tag pay"><span class="icon" aria-hidden="true">payments</span>Payday ' +
        (d.accrued === 0 && d.paused > 0 ? '· accrual paused' : esc(signed(d.accrued))) + '</span>');
      if (d.paused > 0) tags.push('<span class="tag"><span class="icon" aria-hidden="true">beach_access</span>' + esc(h(d.paused)) + ' not earned (leave)</span>');
      if (d.lost > 0) tags.push('<span class="tag warn"><span class="icon" aria-hidden="true">warning</span>' + esc(h(d.lost)) + ' lost to cap</span>');
    }
    for (const b of banks()) {
      const bd = bankTimeline(b).days.get(iso);
      if (bd && bd.granted > 0) tags.push('<span class="tag pay"><span class="icon" aria-hidden="true">redeem</span>' + esc(b.name) + ' +' + esc(h(bd.granted)) + '</span>');
      if (bd && bd.lost > 0) tags.push('<span class="tag warn"><span class="icon" aria-hidden="true">warning</span>' + esc(h(bd.lost)) + ' ' + esc(b.name) + ' expired</span>');
    }
    const lv = leaveOn(iso);
    if (lv) tags.push('<span class="tag"><span class="icon" aria-hidden="true">beach_access</span>On leave · ' + esc(leaveLabel(lv)) + '</span>');
    if (isCounted(iso)) tags.push('<span class="tag">Before balance date — already counted</span>');
    $('day-tags').innerHTML = tags.join('');

    $('leave-toggle-label').textContent = lv ? (lv.start === iso ? 'Remove this leave' : 'End leave on this day') : 'Start leave on this day';
    sheetBank = entry && entryBank(entry) ? entry.bank : 'pto';
    renderBankPicker();

    $('day-hours').value = entry ? entry.hours : state.settings.defaultHours;
    $('day-note').value = entry ? entry.note : '';
    $('day-through').value = iso;
    $('day-through').min = iso;
    $('range-box').open = false;
    $('day-delete').hidden = !entry;
    renderTripBox(iso);
    $('day-save').textContent = entry ? 'Update' : 'Save';

    const dh = Number(state.settings.defaultHours) || 8;
    const opts = Array.from(new Set([2, 4, dh / 2, dh].map((x) => P.round2(x)))).filter((x) => x > 0).sort((a, b) => a - b);
    $('quick-hours').innerHTML = opts.map((x) =>
      '<button type="button" class="chip filter" data-hours="' + x + '"><span class="icon check" aria-hidden="true">check</span>' + esc(h(x)) + (x === P.round2(dh) ? ' · full day' : '') + '</button>').join('');

    updateImpact();
    $('day-sheet').showModal();
  }

  function renderBankPicker() {
    const list = banks();
    $('bank-pick').hidden = list.length === 0;
    const opts = [{ id: 'pto', name: 'PTO' }].concat(list);
    $('bank-seg').innerHTML = opts.map((o) =>
      '<button type="button" data-bank="' + esc(o.id) + '" aria-pressed="' + (o.id === sheetBank) + '">' +
      '<span class="icon" aria-hidden="true">check</span>' + esc(o.name) + '</button>').join('');
    renderTiles();
  }

  /** The two stat tiles describe whichever bank the hours come from. */
  function renderTiles() {
    const iso = sheetDate;
    const bank = bankById(sheetBank);
    const counted = isCounted(iso);
    if (!bank) {
      const d = timeline().days.get(iso);
      $('day-balance-label').textContent = 'Projected PTO balance';
      $('day-safe-label').textContent = 'Safe to use this day';
      $('day-balance').textContent = d ? h(d.balance) : '–';
      $('day-balance').classList.toggle('neg', !!d && d.balance < 0);
      if (d && !counted) {
        const without = P.buildTimeline(P.withChanges(state, { [iso]: null }), horizon());
        $('day-safe').textContent = h(P.safeToUse(without, iso));
      } else {
        $('day-safe').textContent = '–';
      }
    } else {
      const btl = bankTimeline(bank);
      const bal = bankBalanceOn(btl, iso);
      $('day-balance-label').textContent = bank.name + ' left';
      $('day-balance').textContent = bal === null ? '–' : h(bal);
      $('day-balance').classList.toggle('neg', bal !== null && bal < 0);
      const exp = P.bankExpiresOn(bank, iso);
      $('day-safe-label').textContent = 'Use by';
      $('day-safe').textContent = exp ? shortDate(exp) : 'No expiry';
    }
    $('day-safe').classList.remove('neg');
  }

  function renderTripBox(iso) {
    const trip = P.tripDates(state.entries, iso);
    const box = $('trip-box');
    $('day-delete-label').textContent = trip.length > 1 ? 'Remove day' : 'Remove';
    if (trip.length < 2) { box.hidden = true; return; }
    const hours = trip.reduce((a, d) => a + state.entries[d].hours, 0);
    $('trip-title').textContent = 'Part of a ' + trip.length + '-day trip';
    $('trip-sub').textContent = shortDay(trip[0]) + ' – ' + shortDay(trip[trip.length - 1]) + ' · ' + h(hours);
    const changes = {};
    for (const d of trip) changes[d] = null;
    const r = P.analyzeChange(state, changes, today, horizon());
    const counted = trip.filter(isCounted).length;
    // Days on/before the stub date are already in the balance, so removing them gives nothing back.
    const back = trip.filter((d) => !isCounted(d)).reduce((a, d) => a + state.entries[d].hours, 0);
    let msg = '';
    if (back > 0) {
      msg = 'Removing it gives back ' + h(back) + '. Lowest point ahead: ' + h(r.lowBefore.min) + ' → ' + h(r.lowAfter.min) + '.';
    }
    if (counted) msg += (msg ? ' ' : '') + counted + ' of these days are already in your stub balance and won’t change it.';
    $('trip-impact').textContent = msg;
    box.hidden = false;
  }

  function pendingChanges() {
    const iso = sheetDate;
    const hours = Math.max(0, Number($('day-hours').value) || 0);
    const note = $('day-note').value.trim();
    let dates = [iso];
    const through = $('day-through').value;
    if ($('range-box').open && through && through > iso) {
      dates = P.dateRange(iso, through, $('day-skip-weekends').checked);
      if (dates.length === 0) dates = [iso];
    }
    const changes = {};
    for (const d of dates) changes[d] = hours > 0 ? { hours, note, bank: sheetBank } : null;
    return { changes, dates, hours };
  }

  function updateImpact() {
    const { changes, dates, hours } = pendingChanges();
    document.querySelectorAll('#quick-hours .chip').forEach((c) =>
      c.classList.toggle('selected', Number(c.dataset.hours) === hours));
    const out = [];
    const hz = horizon();
    const r = P.analyzeChange(state, changes, today, hz);
    const multi = dates.length > 1;
    const booked = dates.filter((d) => state.entries[d]).length;
    $('day-save').textContent = hours > 0 ? (state.entries[sheetDate] && !multi ? 'Update' : 'Save')
      : booked > 1 ? 'Remove ' + booked + ' days' : booked === 1 ? 'Remove' : 'Save';

    if (multi) {
      out.push(row(dates.length + ' days (' + esc(shortDate(dates[0])) + ' – ' + esc(shortDate(dates[dates.length - 1])) + ')',
        esc(h(hours * dates.length)) + ' total'));
    }
    if (dates.every(isCounted)) {
      out.push(box('info', 'This is on or before your balance date (' + esc(shortDate(state.settings.asOfDate)) +
        '), so it’s assumed to already be deducted from your balance. It’s saved for your records only.'));
      $('impact').innerHTML = out.join('');
      return;
    }

    // Banks touched by this change: the one selected, plus any that existing entries come from.
    const touched = new Set();
    if (bankById(sheetBank) && hours > 0) touched.add(sheetBank);
    for (const d of dates) if (entryBank(state.entries[d])) touched.add(state.entries[d].bank);
    const bankOut = [];
    let bankChanged = false;
    for (const id of touched) {
      const b = bankById(id);
      const before = P.buildBankTimeline(state, b, hz);
      const after = P.buildBankTimeline(r.nextState, b, hz);
      const bb = bankBalanceOn(before, r.last);
      const ba = bankBalanceOn(after, r.last);
      if (bb === ba) continue;
      bankChanged = true;
      bankOut.push(row(esc(b.name) + ' after ' + esc(shortDate(r.last)),
        esc(h(bb)) + '<span class="arrow">→</span><span class="' + (ba < 0 ? 'neg' : '') + '">' + esc(h(ba)) + '</span>'));
      const low = bankLow(after, r.first);
      if (ba < bb && low && low.min < 0) {
        const have = bankBalanceOn(before, r.first) + (state.entries[r.first] && state.entries[r.first].bank === id ? state.entries[r.first].hours : 0);
        bankOut.push(box('bad', '<b>That’s more ' + esc(b.name) + ' than you’ll have.</b> You’d be at ' + esc(h(low.min)) + ' on ' +
          esc(shortDay(low.minDate)) + '. You have ' + esc(bankAmount(b, Math.max(0, have))) + ' available on ' + esc(shortDate(r.first)) +
          ' — use PTO for the rest.'));
      } else if (ba < bb) {
        const lostBefore = [...before.days.values()].reduce((a, d) => a + d.lost, 0);
        const lostAfter = [...after.days.values()].reduce((a, d) => a + d.lost, 0);
        const exp = P.bankExpiresOn(b, r.first);
        bankOut.push(box('ok', 'Comes out of ' + esc(b.name) + ', so your PTO isn’t touched.' +
          (lostAfter < lostBefore && exp ? ' These hours would otherwise expire after ' + esc(shortDate(exp)) + '.' : '')));
      }
    }

    if (r.deltaHours === 0) {
      if (!bankChanged) out.push(box('info', hours > 0 ? 'No change to your plan.' : 'Enter the hours you’ll take off this day.'));
      $('impact').innerHTML = out.concat(bankOut).join('');
      return;
    }

    const onLeaveDays = dates.filter((d) => leaveOn(d)).length;
    if (onLeaveDays && r.deltaHours > 0) {
      out.push(box('info', (onLeaveDays === dates.length ? 'You’re on leave then' : onLeaveDays + ' of these days are during leave') +
        ', so PTO isn’t accruing — these hours come straight off your balance with nothing coming back in until you return.'));
    }
    out.push(row('PTO after ' + esc(shortDate(r.last)),
      esc(h(r.balanceBefore)) + '<span class="arrow">→</span><span class="' + (r.balanceAfter < 0 ? 'neg' : '') + '">' + esc(h(r.balanceAfter)) + '</span>'));
    out.push(row('Lowest PTO ahead',
      esc(h(r.lowBefore.min)) + '<span class="arrow">→</span><span class="' + (r.lowAfter.min < 0 ? 'neg' : '') + '">' +
      esc(h(r.lowAfter.min)) + '</span> <span class="muted">' + esc(shortDate(r.lowAfter.minDate)) + '</span>'));

    const la = r.lowAfter;
    if (la.firstNegative && r.deltaHours > 0) {
      let msg = '<b>This would put you negative.</b> You’d be at ' + esc(h(r.after.days.get(la.firstNegative).balance)) +
        ' on ' + esc(shortDay(la.firstNegative));
      if (la.minDate !== la.firstNegative) msg += ', bottoming out at ' + esc(h(la.min)) + ' on ' + esc(shortDate(la.minDate));
      msg += '. ';
      msg += la.recovery ? 'You’d be back above zero on ' + esc(shortDay(la.recovery)) + '.'
        : 'You wouldn’t recover within the projection.';
      if (r.lowBefore.firstNegative) msg += ' (Your plan was already negative before this change.)';
      out.push(box('bad', msg));
      if (!multi && hours > 0 && !bankById(sheetBank)) {
        const base = P.buildTimeline(P.withChanges(state, { [sheetDate]: null }), hz);
        const e = P.earliestAffordable(base, today > sheetDate ? today : sheetDate, hours);
        out.push(box('info', e ? 'Earliest you could take ' + esc(h(hours)) + ' without going negative: <b>' + esc(shortDay(e)) + '</b>.'
          : 'Your current plan doesn’t leave room for ' + esc(h(hours)) + ' within the projection.'));
      }
    } else if (r.deltaHours > 0) {
      out.push(box('ok', 'You’ll stay positive. Your balance never drops below ' + esc(h(la.min)) + ' after this.'));
    } else {
      out.push(box('ok', 'This frees up ' + esc(h(-r.deltaHours)) + '.' +
        (r.lowBefore.firstNegative && !la.firstNegative ? ' Your plan would no longer go negative.' : '')));
    }

    if (state.settings.cap !== null && state.settings.cap !== '') {
      const before = totalLost(P.buildTimeline(state, hz));
      const after = totalLost(r.after);
      if (after < before) out.push(box('ok', 'Also saves ' + esc(h(before - after)) + ' that would have been lost to your cap.'));
      if (after > before) out.push(box('warn', 'You’d lose ' + esc(h(after - before)) + ' more to your cap.'));
    }
    $('impact').innerHTML = out.concat(bankOut).join('');

    function row(label, value) { return '<div class="row"><span>' + label + '</span><b>' + value + '</b></div>'; }
    function box(cls, html) {
      const icon = { ok: 'check_circle', bad: 'error', warn: 'warning', info: 'info' }[cls];
      return '<div class="box ' + cls + '"><span class="icon" aria-hidden="true">' + icon + '</span><span>' + html + '</span></div>';
    }
  }

  function newTripId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function saveDay() {
    const { changes, dates, hours } = pendingChanges();
    if (hours > 0) {
      // Days booked together become one trip so they can be removed together later.
      // Editing a single day keeps it in whatever trip it already belongs to.
      const existing = state.entries[sheetDate];
      const trip = dates.length > 1 ? newTripId() : existing && existing.trip;
      if (trip) for (const d of dates) changes[d].trip = trip;
    }
    const prev = state;
    state = P.withChanges(state, changes);
    save();
    $('day-sheet').close();
    render();
    if (hours > 0) toast(dates.length > 1 ? 'Saved ' + dates.length + ' days · ' + h(hours * dates.length) : 'Saved ' + h(hours) + ' on ' + shortDate(dates[0]));
    else toast('Removed ' + (dates.length > 1 ? dates.length + ' days' : 'time off'), () => restore(prev));
  }

  function restore(prev) {
    state = prev;
    save();
    render();
    toast('Restored');
  }

  function deleteDay() {
    const prev = state;
    state = P.withChanges(state, { [sheetDate]: null });
    save();
    $('day-sheet').close();
    render();
    toast('Removed time off on ' + shortDate(sheetDate), () => restore(prev));
  }

  /** Start, end or remove a leave from the day sheet. */
  function toggleLeave() {
    const iso = sheetDate;
    const prev = state;
    const lv = leaveOn(iso);
    let list = leaves().map((l) => Object.assign({}, l));
    let msg;
    if (!lv) {
      list.push({ id: 'l' + Date.now().toString(36), start: iso, end: '', note: '' });
      msg = 'Leave starts ' + shortDate(iso) + ' · accrual paused';
    } else if (lv.start === iso) {
      list = list.filter((l) => l.id !== lv.id);
      msg = 'Leave removed';
    } else {
      list = list.map((l) => (l.id === lv.id ? Object.assign(l, { end: iso }) : l));
      msg = 'Leave ends ' + shortDate(iso) + ' · accrual resumes after';
    }
    state = Object.assign({}, state, { leaves: list });
    save();
    render();
    openDay(iso);
    toast(msg, () => { restore(prev); if ($('day-sheet').open) openDay(iso); });
  }

  function deleteTrip() {
    const trip = P.tripDates(state.entries, sheetDate);
    if (!trip.length) return;
    const hours = trip.reduce((a, d) => a + state.entries[d].hours, 0);
    const changes = {};
    for (const d of trip) changes[d] = null;
    const prev = state;
    state = P.withChanges(state, changes);
    save();
    $('day-sheet').close();
    render();
    toast('Removed ' + trip.length + ' days · ' + h(hours), () => restore(prev));
  }

  // ---------- Settings ----------
  function openSettings() {
    const s = state.settings;
    $('s-balance').value = firstRun ? '' : s.startingBalance;
    $('s-asof').value = firstRun ? today : s.asOfDate;
    $('s-accrual').value = firstRun ? '' : s.accrualHours;
    $('s-frequency').value = s.frequency;
    $('s-anchor').value = s.anchorPayday;
    $('s-cap').value = s.cap === null || s.cap === '' ? '' : s.cap;
    $('s-default').value = s.defaultHours;
    renderBankEditors(banks());
    renderLeaveEditors(leaves());
    renderStorageStatus();
    $('settings-intro').hidden = !firstRun;
    $('settings-close').hidden = firstRun;
    syncAnchorField();
    $('settings-sheet').showModal();
  }
  function bankEditor(b) {
    const months = MONTHS.map((m, i) => '<option value="' + (i + 1) + '"' + (Number(b.month) === i + 1 ? ' selected' : '') + '>' + esc(m) + '</option>').join('');
    const opt = (v, label, cur) => '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
    return '<div class="bank-editor" data-id="' + esc(b.id) + '">' +
      '<label class="text-field filled"><span class="tf-label">Name</span><input class="b-name" type="text" maxlength="40" value="' + esc(b.name) + '" required></label>' +
      '<div class="three">' +
        '<label class="text-field filled"><span class="tf-label">Amount each year</span><input class="b-amount" type="number" inputmode="decimal" step="any" min="0" value="' + esc(b.amount) + '" required></label>' +
        '<label class="text-field filled select"><span class="tf-label">Counted in</span><select class="b-unit">' + opt('days', 'Days', b.unit) + opt('hours', 'Hours', b.unit) + '</select></label>' +
        '<label class="text-field filled select"><span class="tf-label">Given every</span><select class="b-month">' + months + '</select></label>' +
        '<label class="text-field filled"><span class="tf-label">On day</span><input class="b-day" type="number" inputmode="numeric" min="1" max="31" step="1" value="' + esc(b.day) + '" required></label>' +
        '<label class="text-field filled"><span class="tf-label">Left now</span><input class="b-left" type="number" inputmode="decimal" step="any" min="0" value="' + esc(b.startingBalance) + '" required></label>' +
        '<label class="text-field filled select"><span class="tf-label">Unused expire</span><select class="b-expiry">' +
          opt('next-grant', 'At next grant', b.expiry) + opt('year-end', 'On Dec 31', b.expiry) + opt('never', 'Never', b.expiry) +
        '</select></label>' +
      '</div>' +
      '<p class="supporting body-small on-variant">“Left now” is what you have as of your balance date above.</p>' +
      '<button type="button" class="button text danger remove-bank"><span class="icon" aria-hidden="true">delete</span>Remove</button>' +
      '</div>';
  }
  function renderBankEditors(list) {
    $('bank-list').innerHTML = list.map(bankEditor).join('');
  }
  function readBankEditors() {
    return [...document.querySelectorAll('#bank-list .bank-editor')].map((el) => ({
      id: el.dataset.id,
      name: el.querySelector('.b-name').value.trim() || 'Personal days',
      unit: el.querySelector('.b-unit').value,
      amount: Number(el.querySelector('.b-amount').value) || 0,
      month: Number(el.querySelector('.b-month').value) || 1,
      day: Math.min(31, Math.max(1, Number(el.querySelector('.b-day').value) || 1)),
      startingBalance: Number(el.querySelector('.b-left').value) || 0,
      expiry: el.querySelector('.b-expiry').value,
    }));
  }

  function leaveEditor(l) {
    return '<div class="leave-editor" data-id="' + esc(l.id) + '">' +
      '<div class="two">' +
        '<label class="text-field filled"><span class="tf-label">Leave starts</span><input class="l-start" type="date" value="' + esc(l.start) + '" required></label>' +
        '<label class="text-field filled"><span class="tf-label">Last day (optional)</span><input class="l-end" type="date" value="' + esc(l.end) + '"></label>' +
      '</div>' +
      '<label class="text-field filled"><span class="tf-label">Note (optional)</span><input class="l-note" type="text" maxlength="40" value="' + esc(l.note) + '" placeholder="e.g. Parental leave"></label>' +
      '<button type="button" class="button text danger remove-leave"><span class="icon" aria-hidden="true">delete</span>Remove</button>' +
      '</div>';
  }
  function renderLeaveEditors(list) {
    $('leave-list').innerHTML = list.map(leaveEditor).join('');
  }
  function readLeaveEditors() {
    return [...document.querySelectorAll('#leave-list .leave-editor')].map((el) => {
      const start = el.querySelector('.l-start').value;
      let end = el.querySelector('.l-end').value;
      if (end && end < start) end = start;
      return { id: el.dataset.id, start, end, note: el.querySelector('.l-note').value.trim() };
    }).filter((l) => l.start);
  }

  function syncAnchorField() {
    const semi = $('s-frequency').value === 'semimonthly';
    $('anchor-field').hidden = semi;
    $('s-anchor').required = !semi;
    $('anchor-field').querySelector('span').textContent =
      $('s-frequency').value === 'monthly' ? 'A payday (sets the day of the month)' : 'A payday (any past or upcoming one)';
  }
  function saveSettings() {
    const cap = $('s-cap').value.trim();
    state.settings = {
      startingBalance: Number($('s-balance').value) || 0,
      asOfDate: $('s-asof').value,
      accrualHours: Number($('s-accrual').value) || 0,
      frequency: $('s-frequency').value,
      anchorPayday: $('s-anchor').value || state.settings.anchorPayday || today,
      cap: cap === '' ? null : Number(cap),
      defaultHours: Number($('s-default').value) || 8,
    };
    state.banks = readBankEditors();
    state.leaves = readLeaveEditors();
    // Planned days from a removed bank go back to PTO.
    const ids = new Set(state.banks.map((b) => b.id));
    let moved = 0;
    const entries = {};
    for (const [d, e] of Object.entries(state.entries)) {
      entries[d] = Object.assign({}, e);
      if (e.bank && !ids.has(e.bank)) { delete entries[d].bank; moved++; }
    }
    state.entries = entries;
    firstRun = false;
    save();
    $('settings-sheet').close();
    render();
    toast(moved ? 'Settings saved · ' + moved + (moved === 1 ? ' day moved' : ' days moved') + ' back to PTO' : 'Settings saved');
  }

  async function exportData() {
    const json = JSON.stringify({ app: 'pto-tracker', version: 1, exported: new Date().toISOString(), ...state }, null, 2);
    const name = 'pto-backup-' + today + '.json';
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'PTO backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const s = JSON.parse(reader.result);
        if (!valid(s)) throw new Error('bad');
        if (!confirm('Replace your current data with this backup?')) return;
        state = normalize(s);
        firstRun = false;
        save();
        $('settings-sheet').close();
        render();
        toast('Backup restored');
      } catch (e) { toast('That file isn’t a PTO Tracker backup'); }
    };
    reader.readAsText(file);
  }

  // ---------- Misc UI ----------
  let toastTimer;
  function toast(msg, undo) {
    const t = $('toast');
    t.textContent = '';
    const span = document.createElement('span');
    span.textContent = msg;
    t.appendChild(span);
    if (undo) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'button text';
      b.textContent = 'Undo';
      b.addEventListener('click', () => { t.hidden = true; undo(); }, { once: true });
      t.appendChild(b);
    }
    t.hidden = true;
    void t.offsetWidth; // restart the enter animation
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 6000 : 2600);
  }
  function goToMonth(iso) {
    view = { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) - 1 };
    render();
  }
  function shiftMonth(k) {
    let m = view.month + k, y = view.year;
    while (m < 0) { m += 12; y -= 1; }
    while (m > 11) { m -= 12; y += 1; }
    view = { year: y, month: m };
    render();
  }
  function jumpAndOpen(iso) {
    if (!iso) return;
    goToMonth(iso);
    openDay(iso);
  }

  // ---------- Events ----------
  $('prev-month').addEventListener('click', () => shiftMonth(-1));
  $('next-month').addEventListener('click', () => shiftMonth(1));
  $('btn-today').addEventListener('click', () => goToMonth(today));
  $('btn-settings').addEventListener('click', openSettings);
  $('grid').addEventListener('click', (e) => {
    const b = e.target.closest('.day');
    if (b) openDay(b.dataset.date);
  });
  for (const id of ['upcoming-list', 'past-list']) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-date]');
      if (b) jumpAndOpen(b.dataset.date);
    });
  }
  $('fab-add').addEventListener('click', () => {
    // Today if it's in the month being viewed, otherwise the 1st of that month.
    const viewingToday = today.slice(0, 7) === P.isoFromParts(view.year, view.month, 1).slice(0, 7);
    openDay(viewingToday ? today : P.isoFromParts(view.year, view.month, 1));
  });
  const bar = $('app-bar');
  window.addEventListener('scroll', () => bar.classList.toggle('scrolled', window.scrollY > 4), { passive: true });
  $('toggle-past').addEventListener('click', () => { showPast = !showPast; render(); });
  $('card-today').addEventListener('click', () => goToMonth(today));
  for (const id of ['card-payday', 'card-low', 'card-eoy']) {
    $(id).addEventListener('click', (e) => jumpAndOpen(e.currentTarget.dataset.date));
  }
  $('alert').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-target]');
    if (!b) return;
    if (b.dataset.target === 'settings') openSettings();
    else jumpAndOpen(b.dataset.target);
  });

  // Swipe between months.
  let touch = null;
  $('grid').addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    touch = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  $('grid').addEventListener('touchend', (e) => {
    if (!touch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 45) shiftMonth(dx < 0 ? 1 : -1);
  }, { passive: true });

  // Day sheet
  const dayForm = $('day-form');
  dayForm.addEventListener('input', updateImpact);
  $('range-box').addEventListener('toggle', updateImpact);
  $('quick-hours').addEventListener('click', (e) => {
    const c = e.target.closest('[data-hours]');
    if (!c) return;
    $('day-hours').value = c.dataset.hours;
    updateImpact();
  });
  dayForm.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => {
    const v = Math.max(0, (Number($('day-hours').value) || 0) + Number(b.dataset.step));
    $('day-hours').value = P.round2(v);
    updateImpact();
  }));
  dayForm.addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    saveDay();
  });
  $('day-delete').addEventListener('click', deleteDay);
  $('trip-delete').addEventListener('click', deleteTrip);
  $('leave-toggle').addEventListener('click', toggleLeave);
  $('btn-add-leave').addEventListener('click', () => {
    const current = readLeaveEditors();
    current.push({ id: 'l' + Date.now().toString(36), start: today, end: '', note: '' });
    renderLeaveEditors(current);
    const last = $('leave-list').lastElementChild;
    last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    last.querySelector('.l-start').focus();
  });
  $('leave-list').addEventListener('click', (e) => {
    const rm = e.target.closest('.remove-leave');
    if (rm) rm.closest('.leave-editor').remove();
  });
  $('bank-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bank]');
    if (!b) return;
    sheetBank = b.dataset.bank;
    $('bank-seg').querySelectorAll('[data-bank]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.bank === sheetBank)));
    renderTiles();
    updateImpact();
  });
  $('banks').addEventListener('click', (e) => {
    const b = e.target.closest('[data-date]');
    if (b) jumpAndOpen(b.dataset.date);
  });
  $('btn-add-bank').addEventListener('click', () => {
    const current = readBankEditors();
    current.push({ id: 'b' + Date.now().toString(36), name: 'Personal holidays', unit: 'days', amount: 3,
      month: 7, day: 1, startingBalance: 0, expiry: 'next-grant' });
    renderBankEditors(current);
    const last = $('bank-list').lastElementChild;
    last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    last.querySelector('.b-name').select();
  });
  $('bank-list').addEventListener('click', (e) => {
    const rm = e.target.closest('.remove-bank');
    if (rm) rm.closest('.bank-editor').remove();
  });

  // Settings sheet
  const setForm = $('settings-form');
  $('s-frequency').addEventListener('change', syncAnchorField);
  setForm.addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    saveSettings();
  });
  $('settings-sheet').addEventListener('cancel', (e) => { if (firstRun) e.preventDefault(); });
  $('btn-export').addEventListener('click', exportData);
  $('import-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importData(f);
    e.target.value = '';
  });
  $('btn-reset').addEventListener('click', () => {
    if (!confirm('Erase your balance, settings and all planned time off on this device?')) return;
    try { [STORAGE_KEY, SAVED_AT_KEY].forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
    state = defaultState();
    firstRun = true;
    $('settings-sheet').close();
    render();
    openSettings();
  });

  // Tap the backdrop to close a sheet.
  for (const dlg of document.querySelectorAll('dialog.sheet')) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg && !(dlg.id === 'settings-sheet' && firstRun)) dlg.close();
    });
  }

  // Keep "today" fresh if the app stays open past midnight or is resumed.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && P.todayIso() !== today) render();
  });

  // Keep tabs in sync: another tab saved, so adopt its data rather than overwrite it later.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      const s = JSON.parse(e.newValue);
      if (!valid(s)) return;
      state = normalize(s);
      firstRun = false;
      for (const dlg of document.querySelectorAll('dialog[open]')) dlg.close();
      render();
      toast('Updated with changes from another tab');
    } catch (err) { /* ignore */ }
  });

  render();
  if (firstRun) openSettings();
  else requestPersistence();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
