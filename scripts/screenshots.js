/*
 * Regenerates docs/screenshots/*.png from seeded example data.
 * Usage: npm start (serves on :8080) in one terminal, then `node scripts/screenshots.js`.
 * Needs Playwright with Chromium installed.
 */
const { chromium } = require('playwright');
const OUT = process.argv[2] || require('path').join(__dirname, '..', 'docs', 'screenshots');
const URL = 'http://localhost:8080/';
// Example data: stub balance, a dentist visit, a month-long trip, a personal-days bank and a leave.
function seed() {
  const entries = {};
  const start = Date.UTC(2027, 0, 4);
  for (let i = 0; i < 26; i++) {
    const d = new Date(start + i * 864e5); const w = d.getUTCDay();
    if (w === 0 || w === 6) continue;
    entries[d.toISOString().slice(0, 10)] = { hours: 8, note: 'Japan trip', trip: 'tjapan' };
  }
  entries['2026-11-25'] = { hours: 4, note: 'Dentist' };
  entries['2026-12-24'] = { hours: 8, note: 'Christmas Eve', bank: 'personal' };
  return {
    settings: { startingBalance: 150, asOfDate: '2026-11-12', accrualHours: 4.62, frequency: 'biweekly',
      anchorPayday: '2026-11-13', cap: null, defaultHours: 8 },
    entries,
    banks: [{ id: 'personal', name: 'Personal holidays', unit: 'days', amount: 3, startingBalance: 2, month: 7, day: 1, expiry: 'next-grant' }],
    leaves: [{ id: 'leave1', start: '2027-03-01', end: '2027-04-23', note: 'Parental leave' }],
  };
}
(async () => {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost' } : undefined;
  const b = await chromium.launch({ proxy, args: ['--ignore-certificate-errors'] });
  const errs = [];
  async function page(scheme = 'light') {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme, ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(URL);
    await p.evaluate((s) => localStorage.setItem('pto-tracker:v1', JSON.stringify(s)), seed());
    await p.reload(); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(400);
    return p;
  }
  const shot = async (p, name) => { await p.waitForTimeout(350); await p.screenshot({ path: `${OUT}/${name}.png` }); console.log('saved', name); };
  const toMonth = async (p, n) => { for (let i = 0; i < n; i++) await p.click('#next-month'); };
  const sheetBottom = (p) => p.evaluate(() => { const d = document.querySelector('dialog[open]'); d.scrollTop = d.scrollHeight; });

  // 1. Home: personal-days card, summary, calendar
  let p = await page();
  await shot(p, '01-home');

  // 2. Trip card in a day sheet
  await toMonth(p, 2);
  await p.click('.day[data-date="2027-01-12"]');
  await shot(p, '02-trip-card');
  // 3. Remove trip → snackbar with Undo, list collapses
  await p.click('#trip-delete');
  await p.evaluate(() => document.querySelector('.upcoming').scrollIntoView({ block: 'end' }));
  await shot(p, '03-trip-removed-undo');
  await p.close();

  // 4. Planned list showing one row per trip
  p = await page();
  await p.evaluate(() => document.querySelector('.upcoming').scrollIntoView({ block: 'end' }));
  await shot(p, '04-planned-list-trips');

  // 5. Book from personal days
  await p.evaluate(() => scrollTo(0, 0));
  await toMonth(p, 1);
  await p.click('.day[data-date="2026-12-28"]');
  await p.click('#bank-seg [data-bank="personal"]');
  await shot(p, '05-personal-day-impact');
  // 7. Overbooking personal days
  await p.fill('#day-hours', '16'); await p.dispatchEvent('#day-hours', 'input');
  await sheetBottom(p);
  await shot(p, '06-personal-day-overbooked');
  await p.close();

  // 8. Leave on the calendar + banner
  p = await page();
  await toMonth(p, 4);
  await p.evaluate(() => scrollTo(0, document.querySelector('.calendar').getBoundingClientRect().top + scrollY - 72));
  await shot(p, '07-leave-calendar');
  // 9. PTO during leave
  await p.click('.day[data-date="2027-03-10"]');
  await p.fill('#day-hours', '4'); await p.dispatchEvent('#day-hours', 'input');
  await shot(p, '08-leave-day-sheet');
  await sheetBottom(p);
  await shot(p, '09-leave-pto-impact');
  await p.close();

  // 11–13. Settings: personal days, leave, storage status
  p = await page();
  await p.click('#btn-settings');
  await p.evaluate(() => document.querySelector('#bank-list').scrollIntoView({ block: 'start' }));
  await shot(p, '10-settings-personal-days');
  await p.evaluate(() => document.querySelector('#leave-list').scrollIntoView({ block: 'start' }));
  await shot(p, '11-settings-leave-and-storage');
  await p.close();

  // 14. Dark mode home
  p = await page('dark');
  await shot(p, '12-home-dark');
  await p.close();

  console.log('errors', JSON.stringify(errs));
  await b.close();
})();
