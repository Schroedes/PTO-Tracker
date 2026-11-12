const test = require('node:test');
const assert = require('node:assert/strict');
const PTO = require('../pto.js');

const base = (over = {}) => ({
  settings: Object.assign({
    startingBalance: 40, asOfDate: '2026-11-01', accrualHours: 5,
    frequency: 'biweekly', anchorPayday: '2026-11-06', cap: null,
  }, over),
  entries: {},
});

test('biweekly paydays from an anchor in the past or future', () => {
  const s = base().settings;
  assert.deepEqual(PTO.paydaysBetween(s, '2026-11-01', '2026-12-10'),
    ['2026-11-06', '2026-11-20', '2026-12-04']);
  const past = Object.assign({}, s, { anchorPayday: '2025-01-03' }); // also a biweekly Friday on cycle
  assert.deepEqual(PTO.paydaysBetween(past, '2026-11-01', '2026-11-30'), ['2026-11-06', '2026-11-20']);
});

test('payday on the as-of date is excluded (already in the balance)', () => {
  const s = base({ asOfDate: '2026-11-06' }).settings;
  assert.deepEqual(PTO.paydaysBetween(s, '2026-11-06', '2026-11-21'), ['2026-11-20']);
});

test('semimonthly and monthly schedules', () => {
  const semi = base({ frequency: 'semimonthly' }).settings;
  assert.deepEqual(PTO.paydaysBetween(semi, '2027-01-20', '2027-03-15'),
    ['2027-01-31', '2027-02-15', '2027-02-28', '2027-03-15']);
  const monthly = base({ frequency: 'monthly', anchorPayday: '2026-10-31' }).settings;
  assert.deepEqual(PTO.paydaysBetween(monthly, '2027-01-01', '2027-04-30'),
    ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
});

test('timeline accrues on paydays and subtracts time off', () => {
  const st = base();
  st.entries['2026-11-20'] = { hours: 8 };
  st.entries['2026-11-25'] = { hours: 50 };
  const tl = PTO.buildTimeline(st, '2026-12-31');
  assert.equal(PTO.balanceOn(tl, '2026-11-01'), 40);
  assert.equal(PTO.balanceOn(tl, '2026-11-06'), 45);
  assert.equal(PTO.balanceOn(tl, '2026-11-20'), 42); // +5 then -8
  assert.equal(PTO.balanceOn(tl, '2026-11-25'), -8);
  assert.equal(PTO.balanceOn(tl, '2026-12-04'), -3);
  assert.equal(PTO.balanceOn(tl, '2026-10-31'), null);
  const lp = PTO.lowPoint(tl, '2026-11-01');
  assert.equal(lp.min, -8);
  assert.equal(lp.firstNegative, '2026-11-25');
  assert.equal(lp.recovery, '2026-12-18'); // -3 -> +2
});

test('entries on/before as-of date are not double counted', () => {
  const st = base();
  st.entries['2026-11-01'] = { hours: 8 };
  st.entries['2026-10-15'] = { hours: 8 };
  const tl = PTO.buildTimeline(st, '2026-11-05');
  assert.equal(PTO.balanceOn(tl, '2026-11-05'), 40);
});

test('cap limits accrual and reports lost hours', () => {
  const st = base({ startingBalance: 48, cap: 50 });
  const tl = PTO.buildTimeline(st, '2026-11-21');
  const d1 = tl.days.get('2026-11-06');
  assert.equal(d1.balance, 50);
  assert.equal(d1.accrued, 2);
  assert.equal(d1.lost, 3);
  assert.equal(tl.days.get('2026-11-20').lost, 5);
});

test('safe-to-use accounts for later plans', () => {
  const st = base();
  st.entries['2026-12-01'] = { hours: 50 };
  const tl = PTO.buildTimeline(st, '2027-03-01');
  // Nov 10: balance 45; later dip: 40+5+5 -50 = 0 on Dec 1. So nothing extra is safe.
  assert.equal(PTO.safeToUse(tl, '2026-11-10'), 0);
  // After Dec 1 the low point is 0 then rising.
  assert.equal(PTO.safeToUse(tl, '2026-12-05'), 5);
});

test('earliest affordable date', () => {
  const st = base({ startingBalance: 0 });
  const tl = PTO.buildTimeline(st, '2027-03-01');
  assert.equal(PTO.earliestAffordable(tl, '2026-11-02', 8), '2026-11-20'); // 5, then 10
  assert.equal(PTO.earliestAffordable(tl, '2026-11-02', 0), '2026-11-02');
});

test('analyzeChange describes the before/after', () => {
  const st = base({ startingBalance: 10 });
  const r = PTO.analyzeChange(st, { '2026-11-09': { hours: 24 } }, '2026-11-02', '2027-06-01');
  assert.equal(r.balanceBefore, 15);
  assert.equal(r.balanceAfter, -9);
  assert.equal(r.deltaHours, 24);
  assert.equal(r.lowAfter.firstNegative, '2026-11-09');
  assert.equal(r.lowAfter.recovery, '2026-12-04'); // -4 on 11/20, +1 on 12/04
  assert.equal(r.lowBefore.firstNegative, null);
  // Removing works too
  const st2 = PTO.withChanges(st, { '2026-11-09': { hours: 24 } });
  const r2 = PTO.analyzeChange(st2, { '2026-11-09': null }, '2026-11-02', '2027-06-01');
  assert.equal(r2.deltaHours, -24);
  assert.ok(!('2026-11-09' in r2.nextState.entries));
});

test('dateRange skips weekends', () => {
  assert.deepEqual(PTO.dateRange('2026-11-13', '2026-11-17', true),
    ['2026-11-13', '2026-11-16', '2026-11-17']);
});

test('dates are DST-safe', () => {
  assert.equal(PTO.addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(PTO.addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(PTO.dayOfWeek('2026-11-12'), 4);
});

test('withChanges keeps trip ids', () => {
  const st = PTO.withChanges(base(), { '2026-12-01': { hours: 8, note: 'x', trip: 't1' } });
  assert.deepEqual(st.entries['2026-12-01'], { hours: 8, note: 'x', trip: 't1' });
});

test('tripDates uses the trip id when present', () => {
  const e = {
    '2026-12-21': { hours: 8, trip: 'a' }, '2026-12-22': { hours: 8, trip: 'a' },
    '2026-12-23': { hours: 8, trip: 'b' }, '2026-12-28': { hours: 8, trip: 'a' },
  };
  assert.deepEqual(PTO.tripDates(e, '2026-12-22'), ['2026-12-21', '2026-12-22', '2026-12-28']);
  assert.deepEqual(PTO.tripDates(e, '2026-12-23'), ['2026-12-23']);
  assert.deepEqual(PTO.tripDates(e, '2026-12-24'), []);
});

test('untagged entries group across weekends but not across weekdays', () => {
  const e = {
    '2026-12-17': { hours: 8 }, '2026-12-18': { hours: 8 }, // Thu, Fri
    '2026-12-21': { hours: 8 }, '2026-12-22': { hours: 8 }, // Mon, Tue (weekend between)
    '2026-12-24': { hours: 8 },                             // Thu (Wed gap → separate)
    '2026-12-25': { hours: 8, trip: 'x' },                  // tagged → separate
  };
  assert.deepEqual(PTO.tripDates(e, '2026-12-21'), ['2026-12-17', '2026-12-18', '2026-12-21', '2026-12-22']);
  assert.deepEqual(PTO.tripDates(e, '2026-12-24'), ['2026-12-24']);
  assert.deepEqual(PTO.groupTrips(e, Object.keys(e)), [
    ['2026-12-17', '2026-12-18', '2026-12-21', '2026-12-22'], ['2026-12-24'], ['2026-12-25'],
  ]);
  // Restricting to a subset (e.g. upcoming only) trims trips to that subset.
  assert.deepEqual(PTO.groupTrips(e, ['2026-12-22', '2026-12-24']), [['2026-12-22'], ['2026-12-24']]);
});

const personal = (over = {}) => Object.assign({
  id: 'personal', name: 'Personal holidays', unit: 'days', amount: 3, startingBalance: 1,
  month: 7, day: 1, expiry: 'next-grant',
}, over);

test('personal-day entries do not touch the PTO balance', () => {
  const st = base();
  st.entries['2026-11-10'] = { hours: 8, bank: 'personal' };
  st.entries['2026-11-11'] = { hours: 8 };
  const tl = PTO.buildTimeline(st, '2026-11-12');
  assert.equal(PTO.balanceOn(tl, '2026-11-12'), 37); // 40 + 5 - 8 (only the PTO day)
  const r = PTO.analyzeChange(st, { '2026-11-12': { hours: 8, bank: 'personal' } }, '2026-11-02', '2027-01-01');
  assert.equal(r.deltaHours, 0);
  // Moving an existing PTO day onto the personal bank gives the PTO hours back.
  const r2 = PTO.analyzeChange(st, { '2026-11-11': { hours: 8, bank: 'personal' } }, '2026-11-02', '2027-01-01');
  assert.equal(r2.deltaHours, -8);
  assert.equal(PTO.withChanges(st, { '2026-11-13': { hours: 4, bank: 'personal' } }).entries['2026-11-13'].bank, 'personal');
  assert.ok(!('bank' in PTO.withChanges(st, { '2026-11-13': { hours: 4, bank: 'pto' } }).entries['2026-11-13']));
});

test('bank grants yearly and unused hours expire at the next grant', () => {
  const st = Object.assign(base(), { settings: Object.assign(base().settings, { defaultHours: 8 }) });
  const bank = personal();
  st.entries['2026-12-24'] = { hours: 8, bank: 'personal' };
  st.entries['2027-07-02'] = { hours: 4, bank: 'personal' };
  const tl = PTO.buildBankTimeline(st, bank, '2028-07-05');
  assert.equal(tl.days.get('2026-11-01').balance, 8);
  assert.equal(tl.days.get('2026-12-24').balance, 0);
  assert.equal(tl.days.get('2027-07-01').granted, 24);
  assert.equal(tl.days.get('2027-07-01').balance, 24);
  assert.equal(tl.days.get('2027-07-02').balance, 20);
  const g = tl.days.get('2028-07-01');
  assert.equal(g.lost, 20);
  assert.equal(g.balance, 24);
  assert.equal(PTO.bankExpiresOn(bank, '2026-11-12'), '2027-06-30');
});

test('bank expiry options: year-end and never', () => {
  const st = base();
  const ye = PTO.buildBankTimeline(st, personal({ expiry: 'year-end', unit: 'hours', amount: 24, startingBalance: 10 }), '2027-07-02');
  assert.equal(ye.days.get('2027-01-01').lost, 10);
  assert.equal(ye.days.get('2027-01-01').balance, 0);
  assert.equal(ye.days.get('2027-07-01').balance, 24);
  const nv = PTO.buildBankTimeline(st, personal({ expiry: 'never', unit: 'hours', amount: 24, startingBalance: 10 }), '2027-07-02');
  assert.equal(nv.days.get('2027-07-01').balance, 34);
  assert.equal(PTO.bankExpiresOn(personal({ expiry: 'never' }), '2026-11-12'), null);
});

test('grant dates clamp to short months', () => {
  assert.deepEqual(PTO.grantDatesBetween({ month: 2, day: 30 }, '2027-01-01', '2028-12-31'), ['2027-02-28', '2028-02-29']);
});

test('withChanges keeps banks and other state', () => {
  const st = Object.assign(base(), { banks: [personal()] });
  const next = PTO.withChanges(st, { '2026-12-01': { hours: 8 } });
  assert.deepEqual(next.banks, st.banks);
  assert.equal(next.settings, st.settings);
});

test('leave pauses accrual for whole pay periods on leave', () => {
  // Paydays Nov 6, Nov 20, Dec 4, Dec 18 (biweekly Fridays), 5h each.
  const st = Object.assign(base(), { leaves: [{ id: 'l', start: '2026-11-07', end: '2026-12-04' }] });
  const tl = PTO.buildTimeline(st, '2026-12-31');
  assert.equal(tl.days.get('2026-11-06').accrued, 5);      // period Oct 24–Nov 6: worked
  assert.equal(tl.days.get('2026-11-20').accrued, 0);      // fully on leave
  assert.equal(tl.days.get('2026-11-20').paused, 5);
  assert.equal(tl.days.get('2026-12-04').accrued, 0);
  assert.equal(tl.days.get('2026-12-18').accrued, 5);      // back at work
  assert.equal(PTO.balanceOn(tl, '2026-12-18'), 50);
  assert.equal(tl.days.get('2026-11-10').leave, true);
  assert.equal(tl.days.get('2026-12-07').leave, false);
});

test('leave pro-rates a partly worked pay period and can be open-ended', () => {
  // Pay period Nov 21–Dec 4 has 10 weekdays; leave starts Mon Nov 30, so 5 worked and 5 on leave.
  const st = Object.assign(base(), { leaves: [{ id: 'l', start: '2026-11-30' }] }); // no end date
  const tl = PTO.buildTimeline(st, '2027-01-31');
  assert.equal(tl.days.get('2026-12-04').accrued, 2.5);
  assert.equal(tl.days.get('2026-12-04').paused, 2.5);
  assert.equal(tl.days.get('2027-01-29').accrued, 0);      // still on leave
  assert.equal(PTO.onLeave(st.leaves, '2027-06-01'), true);
});

test('PTO can still be used while on leave', () => {
  const st = Object.assign(base(), { leaves: [{ id: 'l', start: '2026-11-07', end: '2026-12-04' }] });
  st.entries['2026-11-16'] = { hours: 4 };
  const tl = PTO.buildTimeline(st, '2026-12-05');
  assert.equal(PTO.balanceOn(tl, '2026-11-16'), 41);       // 40 + 5 - 4
  assert.equal(PTO.balanceOn(tl, '2026-12-05'), 41);       // nothing accrued on leave
});
