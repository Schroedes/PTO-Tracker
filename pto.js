/*
 * PTO projection engine. Pure functions, no DOM — shared by the app and the tests.
 *
 * Model:
 *   - The user records a known balance ("startingBalance") as of a date ("asOfDate").
 *     That balance is end-of-day on asOfDate, so anything on or before it is already counted.
 *   - On every payday after asOfDate, "accrualHours" are added (limited by an optional cap).
 *   - On every day with a time-off entry after asOfDate, that many hours are subtracted.
 *     Paydays accrue before same-day usage is subtracted.
 *
 * Dates are ISO strings "YYYY-MM-DD" handled as UTC day numbers, so DST never shifts a day.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PTO = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MS_PER_DAY = 86400000;

  function toDayNum(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
  }
  function fromDayNum(n) {
    return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
  }
  function addDays(iso, k) {
    return fromDayNum(toDayNum(iso) + k);
  }
  function dayOfWeek(iso) {
    return new Date(toDayNum(iso) * MS_PER_DAY).getUTCDay();
  }
  function daysInMonth(year, month0) {
    return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  }
  function isoFromParts(year, month0, day) {
    return fromDayNum(Math.round(Date.UTC(year, month0, day) / MS_PER_DAY));
  }
  function todayIso(now) {
    const d = now || new Date();
    return isoFromParts(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  /** Paydays strictly after `afterIso` and on or before `endIso`, ascending. */
  function paydaysBetween(settings, afterIso, endIso) {
    const out = [];
    const start = toDayNum(afterIso);
    const end = toDayNum(endIso);
    if (end <= start) return out;
    const freq = settings.frequency || 'biweekly';

    if (freq === 'weekly' || freq === 'biweekly') {
      const period = freq === 'weekly' ? 7 : 14;
      const anchor = toDayNum(settings.anchorPayday);
      // First anchor + k*period that is > start (works for anchors before or after start).
      const k = Math.floor((start - anchor) / period) + 1;
      for (let n = anchor + k * period; n <= end; n += period) out.push(fromDayNum(n));
      return out;
    }

    // Month-based schedules: walk month by month.
    const s = new Date(start * MS_PER_DAY);
    let y = s.getUTCFullYear();
    let m = s.getUTCMonth();
    const anchorDay = settings.anchorPayday ? Number(settings.anchorPayday.slice(8, 10)) : 1;
    for (;;) {
      const dim = daysInMonth(y, m);
      const days = freq === 'semimonthly' ? [15, dim] : [Math.min(anchorDay, dim)];
      for (const d of days) {
        const n = Math.round(Date.UTC(y, m, d) / MS_PER_DAY);
        if (n > end) return out;
        if (n > start) out.push(fromDayNum(n));
      }
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
  }

  function nextPayday(settings, fromIso) {
    // Search up to ~2 months ahead; every supported schedule pays at least monthly.
    const list = paydaysBetween(settings, addDays(fromIso, -1), addDays(fromIso, 62));
    return list[0] || null;
  }

  /**
   * Day-by-day projection from asOfDate through endIso.
   * Returns { start, end, days: Map<iso, Day> } where Day =
   *   { balance (end of day), accrued, lost (accrual lost to the cap), used, payday, entry }.
   */
  function buildTimeline(state, endIso) {
    const s = state.settings;
    const entries = state.entries || {};
    const cap = s.cap === null || s.cap === undefined || s.cap === '' ? null : Number(s.cap);
    const accrual = Number(s.accrualHours) || 0;
    const startNum = toDayNum(s.asOfDate);
    const endNum = Math.max(toDayNum(endIso), startNum);
    const paydays = new Set(paydaysBetween(s, s.asOfDate, fromDayNum(endNum)));

    const days = new Map();
    let bal = Number(s.startingBalance) || 0;
    days.set(s.asOfDate, {
      balance: round2(bal), accrued: 0, lost: 0, used: 0, payday: false,
      entry: entries[s.asOfDate] || null,
    });

    for (let n = startNum + 1; n <= endNum; n++) {
      const iso = fromDayNum(n);
      let accrued = 0;
      let lost = 0;
      const payday = paydays.has(iso);
      if (payday && accrual > 0) {
        if (cap !== null) {
          const room = Math.max(0, cap - bal);
          accrued = Math.min(accrual, room);
          lost = accrual - accrued;
        } else {
          accrued = accrual;
        }
        bal += accrued;
      }
      const entry = entries[iso] || null;
      const used = entry ? Number(entry.hours) || 0 : 0;
      bal -= used;
      days.set(iso, {
        balance: round2(bal), accrued: round2(accrued), lost: round2(lost),
        used, payday, entry,
      });
    }
    return { start: s.asOfDate, end: fromDayNum(endNum), days };
  }

  /** Balance at end of `iso`, or null if before asOfDate / outside the timeline. */
  function balanceOn(timeline, iso) {
    const d = timeline.days.get(iso);
    return d ? d.balance : null;
  }

  /** Lowest end-of-day balance in [fromIso, timeline.end], plus first negative day. */
  function lowPoint(timeline, fromIso) {
    let from = toDayNum(fromIso);
    if (from < toDayNum(timeline.start)) from = toDayNum(timeline.start);
    const end = toDayNum(timeline.end);
    let min = Infinity;
    let minDate = null;
    let firstNegative = null;
    for (let n = from; n <= end; n++) {
      const iso = fromDayNum(n);
      const b = timeline.days.get(iso).balance;
      if (b < min) { min = b; minDate = iso; }
      if (b < 0 && !firstNegative) firstNegative = iso;
    }
    if (minDate === null) return { min: null, minDate: null, firstNegative: null, recovery: null };
    // When does the balance climb back to >= 0 after the first negative day?
    let recovery = null;
    if (firstNegative) {
      for (let n = toDayNum(firstNegative) + 1; n <= end; n++) {
        const iso = fromDayNum(n);
        if (timeline.days.get(iso).balance >= 0) { recovery = iso; break; }
      }
    }
    return { min: round2(min), minDate, firstNegative, recovery };
  }

  /**
   * Most hours you could take on `iso` (on top of what is already planned) without the
   * balance going negative on that day or any later day in the timeline.
   */
  function safeToUse(timeline, iso) {
    const lp = lowPoint(timeline, iso);
    return lp.min === null ? null : Math.max(0, round2(lp.min));
  }

  /**
   * Earliest day on/after `fromIso` where `hours` could be taken without going negative
   * then or later. Ignores the cap (taking time off only makes a capped balance better).
   */
  function earliestAffordable(timeline, fromIso, hours) {
    const start = Math.max(toDayNum(fromIso), toDayNum(timeline.start) + 1);
    const end = toDayNum(timeline.end);
    if (start > end) return null;
    // Suffix minimum of balances.
    const suffixMin = new Array(end - start + 1);
    let run = Infinity;
    for (let n = end; n >= start; n--) {
      run = Math.min(run, timeline.days.get(fromDayNum(n)).balance);
      suffixMin[n - start] = run;
    }
    for (let n = start; n <= end; n++) {
      if (suffixMin[n - start] - hours >= -1e-9) return fromDayNum(n);
    }
    return null;
  }

  /** Copy of state with `changes` ({iso: {hours, note} | null}) applied. */
  function withChanges(state, changes) {
    const entries = Object.assign({}, state.entries);
    for (const iso of Object.keys(changes)) {
      const c = changes[iso];
      if (!c || !(Number(c.hours) > 0)) delete entries[iso];
      else {
        entries[iso] = { hours: Number(c.hours), note: c.note || '' };
        if (c.trip) entries[iso].trip = c.trip;
      }
    }
    return { settings: state.settings, entries };
  }

  function isWeekend(iso) {
    const w = dayOfWeek(iso);
    return w === 0 || w === 6;
  }

  /**
   * All dates in the trip that `iso` belongs to, ascending.
   * Entries saved together share a `trip` id. Entries without one (e.g. saved before trips
   * existed) form a trip with neighbouring untagged entries when only weekend days separate them.
   */
  function tripDates(entries, iso) {
    const e = entries[iso];
    if (!e) return [];
    if (e.trip) return Object.keys(entries).filter((d) => entries[d].trip === e.trip).sort();
    const out = [iso];
    for (const dir of [-1, 1]) {
      let n = toDayNum(iso);
      for (;;) {
        n += dir;
        let d = fromDayNum(n);
        while (!entries[d] && isWeekend(d)) { n += dir; d = fromDayNum(n); }
        if (entries[d] && !entries[d].trip) out.push(d);
        else break;
      }
    }
    return out.sort();
  }

  /** Split the given dates into trips (arrays of dates), in date order. */
  function groupTrips(entries, dates) {
    const wanted = new Set(dates);
    const seen = new Set();
    const trips = [];
    for (const d of dates.slice().sort()) {
      if (seen.has(d)) continue;
      const trip = tripDates(entries, d).filter((x) => wanted.has(x));
      trip.forEach((x) => seen.add(x));
      trips.push(trip);
    }
    return trips;
  }

  /** ISO dates from startIso..endIso inclusive, optionally skipping Sat/Sun. */
  function dateRange(startIso, endIso, skipWeekends) {
    const out = [];
    for (let n = toDayNum(startIso); n <= toDayNum(endIso); n++) {
      const iso = fromDayNum(n);
      const w = dayOfWeek(iso);
      if (skipWeekends && (w === 0 || w === 6)) continue;
      out.push(iso);
    }
    return out;
  }

  /** How far ahead to project: covers the view, every planned entry, and a year from today. */
  function horizonFor(state, todayIsoStr, viewEndIso) {
    let end = toDayNum(addDays(todayIsoStr, 366));
    if (viewEndIso) end = Math.max(end, toDayNum(viewEndIso));
    for (const iso of Object.keys(state.entries || {})) end = Math.max(end, toDayNum(iso) + 120);
    return fromDayNum(Math.max(end, toDayNum(state.settings.asOfDate)));
  }

  /**
   * Compare the plan before and after `changes`. Everything the day sheet needs to explain
   * the consequences of booking (or removing) time off.
   */
  function analyzeChange(state, changes, todayIsoStr, horizonIso) {
    const before = buildTimeline(state, horizonIso);
    const nextState = withChanges(state, changes);
    const after = buildTimeline(nextState, horizonIso);
    const dates = Object.keys(changes).sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    const countable = dates.filter((d) => toDayNum(d) > toDayNum(state.settings.asOfDate));
    let deltaHours = 0;
    for (const d of dates) {
      const prev = state.entries[d] ? Number(state.entries[d].hours) : 0;
      const next = changes[d] && Number(changes[d].hours) > 0 ? Number(changes[d].hours) : 0;
      deltaHours += next - prev;
    }
    const lowFrom = toDayNum(first) > toDayNum(todayIsoStr) ? first : todayIsoStr;
    return {
      first, last, deltaHours: round2(deltaHours),
      alreadyCounted: countable.length < dates.length,
      balanceBefore: balanceOn(before, last),
      balanceAfter: balanceOn(after, last),
      lowBefore: lowPoint(before, lowFrom),
      lowAfter: lowPoint(after, lowFrom),
      after,
      nextState,
    };
  }

  return {
    toDayNum, fromDayNum, addDays, dayOfWeek, daysInMonth, isoFromParts, todayIso, round2,
    paydaysBetween, nextPayday, buildTimeline, balanceOn, lowPoint, safeToUse,
    earliestAffordable, withChanges, dateRange, isWeekend, tripDates, groupTrips, horizonFor, analyzeChange,
  };
});
