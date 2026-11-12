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
