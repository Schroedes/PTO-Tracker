# PTO Tracker

A mobile-friendly web app for tracking your PTO balance as it accrues each pay period and
seeing the consequences of taking time off before you commit to it.

## What it does

- **Projected balance on every calendar day.** Enter the balance from your pay stub, how many
  hours you earn per paycheck and your pay schedule. Each day on the calendar shows your
  end-of-day balance with accruals (green dot = payday) and planned time off included.
- **Plan time off.** Tap a day, set the hours (quick 2h / 4h / full-day buttons or ±), add a note.
  Use *Repeat for multiple days* to book a whole vacation at once (optionally skipping weekends).
- **See the consequences before saving.** While you edit, the sheet shows:
  - your balance after that day, before → after
  - the lowest your balance will get afterwards, considering everything else you've planned
  - **Safe to use this day**: the most you can take without going negative now *or later*
  - if it would go negative: how far, and the date you'd climb back above zero
  - the earliest date you could take those hours without going negative
  - if you set a balance cap: hours you'd save from (or lose to) the cap
- **At-a-glance summary**: balance today, next payday, lowest point ahead, Dec 31 balance, plus
  warnings when your plan goes negative, when you'll hit your cap, or when your stub balance is stale.
- **Pay schedules**: every 2 weeks, weekly, 15th & last day, or monthly.
- **Works offline and installs to your home screen** (it's a PWA). Data stays in your browser's
  local storage on that device; use *Settings → Export backup* to save or move it.

## Keeping it accurate

Whenever you get a new pay stub, open Settings and update **Hours** and **As of** to the stub's
numbers. Time off on or before the *As of* date is treated as already deducted, so nothing gets
counted twice.

## Running it

It's plain HTML/CSS/JS with no build step.

```sh
npm start        # serves on http://localhost:8080
npm test         # runs the balance-math tests
```

## Hosting on GitHub Pages

`.github/workflows/pages.yml` runs the tests and publishes the site on every push to `main`.

One-time setup: in the repo go to **Settings → Pages → Build and deployment → Source** and pick
**GitHub Actions**. The next push to `main` (or *Actions → Deploy to GitHub Pages → Run workflow*)
publishes it at `https://<your-username>.github.io/PTO-Tracker/`. Open that on your phone and
choose *Add to Home Screen*.

## Files

- `pto.js`: projection engine (paydays, accrual, cap, low point, safe-to-use); pure functions
- `app.js`: UI
- `index.html`, `styles.css`: layout and Material 3 styling (color roles generated from a teal seed, light and dark; Roboto + Material Symbols from Google Fonts)
- `sw.js`, `manifest.webmanifest`, `icons/`: offline support and installability
- `tests/`: unit tests for `pto.js`
