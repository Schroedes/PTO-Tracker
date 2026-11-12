/* PTO Tracker UI. All data lives in localStorage on this device. */
(function () {
  'use strict';
  const P = window.PTO;
  const STORAGE_KEY = 'pto-tracker:v1';
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
    };
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return valid(s) ? normalize(s) : null;
    } catch (e) { return null; }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { toast('Could not save — storage is unavailable'); }
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
    }
    return { settings, entries };
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

  // ---------- Render ----------
  function render() {
    today = P.todayIso();
    const tl = timeline();
    renderSummary(tl);
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
      $('sum-payday-sub').textContent = d ? signed(d.accrued) + ' → ' + h(d.balance) : '';
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

  function renderAlerts(tl) {
    const box = $('alert');
    const items = [];
    const lp = P.lowPoint(tl, today);
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
    const age = P.toDayNum(today) - P.toDayNum(state.settings.asOfDate);
    if (age > 45) {
      items.push(['warn', 'Your balance was last updated ' + esc(shortDate(state.settings.asOfDate)) +
        '. Enter the number from your latest pay stub to stay accurate.', 'settings', 'Update']);
    }
    box.innerHTML = items.map(([cls, html, target, label]) =>
      '<div class="alert-item ' + cls + '"><span class="icon" aria-hidden="true">' + (cls === 'bad' ? 'error' : 'warning') + '</span>' +
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
      if (entry && isCounted(iso)) cls.push('counted');
      if (d && d.payday) cls.push('payday');
      if (d && d.balance < 0) cls.push('negative');
      if (d && d.lost > 0) cls.push('capped');
      else if (d && cap !== null && cap !== '' && d.balance >= Number(cap) && d.payday) cls.push('capped');
      const label = [longDay(iso)];
      if (d) label.push('balance ' + h(d.balance));
      if (entry) label.push(h(entry.hours) + ' off');
      if (d && d.payday) label.push('payday');
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
      const b = P.balanceOn(tl, last);
      const after = isCounted(last) ? 'already counted' : 'leaves ' + h(b);
      const year = d.slice(0, 4) !== today.slice(0, 4) ? ' ' + d.slice(0, 4) : '';
      const when = trip.length > 1
        ? '<span class="range">' + esc(shortDate(d)) + ' – ' + esc(shortDate(last)) + year + ' · ' + trip.length + ' days</span>'
        : esc(fmtDate(d, { weekday: 'long' })) + year;
      const note = trip.map((x) => state.entries[x].note).find((n) => n) || '';
      return '<li><button type="button" data-date="' + d + '">' +
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
      tags.push('<span class="tag pay"><span class="icon" aria-hidden="true">payments</span>Payday ' + esc(signed(d.accrued)) + '</span>');
      if (d.lost > 0) tags.push('<span class="tag warn"><span class="icon" aria-hidden="true">warning</span>' + esc(h(d.lost)) + ' lost to cap</span>');
    }
    if (isCounted(iso)) tags.push('<span class="tag">Before balance date — already counted</span>');
    $('day-tags').innerHTML = tags.join('');

    $('day-balance').textContent = d ? h(d.balance) : '–';
    $('day-balance').classList.toggle('neg', !!d && d.balance < 0);
    if (d && !isCounted(iso)) {
      const without = P.buildTimeline(P.withChanges(state, { [iso]: null }), horizon());
      $('day-safe').textContent = h(P.safeToUse(without, iso));
    } else {
      $('day-safe').textContent = '–';
    }
    $('day-safe').classList.remove('neg');

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
    for (const d of dates) changes[d] = hours > 0 ? { hours, note } : null;
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

    if (r.deltaHours === 0) {
      out.push(box('info', hours > 0 ? 'No change to your plan.' : 'Enter the hours you’ll take off this day.'));
      $('impact').innerHTML = out.join('');
      return;
    }

    out.push(row('Balance after ' + esc(shortDate(r.last)),
      esc(h(r.balanceBefore)) + '<span class="arrow">→</span><span class="' + (r.balanceAfter < 0 ? 'neg' : '') + '">' + esc(h(r.balanceAfter)) + '</span>'));
    out.push(row('Lowest point ahead',
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
      if (!multi && hours > 0) {
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
    $('impact').innerHTML = out.join('');

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
    $('settings-intro').hidden = !firstRun;
    $('settings-close').hidden = firstRun;
    syncAnchorField();
    $('settings-sheet').showModal();
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
    firstRun = false;
    save();
    $('settings-sheet').close();
    render();
    toast('Settings saved');
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
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
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

  render();
  if (firstRun) openSettings();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
