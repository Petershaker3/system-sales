#!/usr/bin/env node
// Browser regression against the demo backend only, never production data.
// npm ci --prefix docs/ui/mockup-v1/tools; npm run demo; node scripts/reconciliation-check.mjs
import assert from 'node:assert/strict';
import { launch } from '../docs/ui/mockup-v1/tools/launch.mjs';
const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 800 });
const url = process.argv[2] || 'http://127.0.0.1:5173/';
async function clickText(selector, text) {
  const elements = await page.$$(selector);
  for (const el of elements) if ((await el.evaluate(e => e.textContent)).includes(text)) { await el.click(); return; }
  throw Error(`Missing ${text}`);
}
try {
  await page.goto(url + '?shop=1', { waitUntil: 'networkidle0' });
  await clickText('.user-card', 'بيتر');
  await page.waitForSelector('.pinpad');
  await page.keyboard.type('1111'); await page.keyboard.press('Enter');
  await page.waitForSelector('.shell');
  await clickText('.rail .nav-btn', 'المصاريف');
  await page.waitForSelector('[data-expenses-screen]');
  const initial = await page.$$eval('[data-expenses-screen] tbody tr', rows => rows.length);
  await page.type('[data-expenses-category]', 'قالب اختبار');
  await page.type('[data-expenses-amount]', '125');
  await page.click('[data-fixed-expenses-pin]');
  await page.waitForSelector('[data-fixed-expense]');
  assert.equal(await page.$$eval('[data-expenses-screen] tbody tr', rows => rows.length), initial, 'pin must not post');
  await page.click('[data-fixed-expense-edit]');
  await page.focus('[data-expenses-amount]');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.type('150');
  await page.click('[data-fixed-expenses-update]');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mshop.fixed-expenses.v1')));
  assert.equal(stored[0].amountMinor, 15000);
  assert.equal(await page.$$eval('[data-expenses-screen] tbody tr', rows => rows.length), initial, 'edit must not post');
  await page.click('[data-fixed-expense] button[aria-label="شيل التثبيت"]');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('mshop.fixed-expenses.v1'))), []);
  assert.equal(await page.$$eval('[data-expenses-screen] tbody tr', rows => rows.length), initial, 'delete must not post');
  console.log('PASS fixed template create/edit/delete does not post a transaction');

  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__reconciliationOriginalInvoke = original;
    window.__TAURI_INTERNALS__.invoke = (cmd, ...args) => cmd === 'expenses_overview' ? Promise.reject({ code: 'LOCAL_STORAGE_UNAVAILABLE' }) : original(cmd, ...args);
  });
  await clickText('.rail .nav-btn', 'التقارير');
  await page.waitForSelector('[data-reports-incomplete] button');
  assert.equal(await page.$('[data-day-net]'), null);
  assert.equal(await page.$('[data-reports-month-net]'), null);
  assert.equal(await page.$eval('[data-reports-wa-summary]', el => el.disabled), true);
  assert.equal(await page.$eval('[data-reports-export]', el => el.disabled), true);
  assert.match(await page.$eval('[data-reports-incomplete]', el => el.textContent), /المصاريف/);
  console.log('PASS failed expense source hides report and disables exports');
  // Transport/UI test with deliberately synthetic event components: it is not
  // an end-to-end SQLx or financial reconciliation test.
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__eventCalls = [];
    window.__TAURI_INTERNALS__.invoke = (cmd, args, ...rest) => {
      if (cmd !== 'sales_financial_event_totals') return original(cmd, args, ...rest);
      window.__eventCalls.push(args);
      return Promise.resolve({ saleCount: 5002, saleTotalMinor: 50020000, saleCostMinor: 30012000,
        returnCount: 2, refundMinor: 1000, intactCostMinor: 600, damagedCostMinor: 0,
        cancellationCount: 1, cancelledTotalMinor: 10000, cancelledCostMinor: 6000, inconsistentCancellationCount: 0 });
    };
  });
  await page.click('[data-reports-event-components] button');
  await page.waitForSelector('[data-reports-event-components] dl');
  assert.match(await page.$eval('[data-reports-event-components]', e => e.textContent), /معاينة غير مُراجَعة/);
  assert.equal(await page.$('[data-day-net]'), null, 'component preview must not unlock guarded report');
  const calls = await page.evaluate(() => window.__eventCalls);
  assert.ok(calls[0].fromMs < calls[0].toMsExclusive);
  await page.click('[data-reports-tab="month"]');
  await page.waitForFunction(() => window.__eventCalls.length >= 2);
  assert.ok((await page.evaluate(() => window.__eventCalls[1].toMsExclusive - window.__eventCalls[1].fromMs)) > 27 * 86400000);
  console.log('PASS synthetic event preview respects guard and requests separate day/month periods');
  await clickText('.rail .nav-btn', 'المصاريف');
  await page.evaluate(() => {
    const original = window.__reconciliationOriginalInvoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, ...args) => {
      const value = await original(cmd, ...args);
      if (cmd !== 'list_sales_history') return value;
      if (value.length === 0) throw new Error('fixture needs sales');
      return value.map((sale, index) => index === 0 ? { ...sale, returnCount: 1, alreadyRefundedMinor: 0, isCancelled: false } : sale);
    };
  });
  await clickText('.rail .nav-btn', 'التقارير');
  await page.waitForSelector('[data-reports-incomplete] button');
  assert.match(await page.$eval('[data-reports-incomplete]', el => el.textContent), /مرتجعات/);
  assert.equal(await page.$('[data-day-net]'), null, 'zero refund return must not show a trusted total');
  console.log('PASS zero-value return hides incomplete report');
  await page.click('[data-open-shift-modal]');
  await page.waitForSelector('[data-close-shift-view]');
  assert.equal(await page.$eval('[data-shift-counted-input]', el => el.value), '', 'count must not be invented from estimate');
  assert.ok(await page.$('[data-shift-unreconciled]'));
  assert.equal(await page.$eval('[data-close-shift-submit]', el => el.disabled), true);
  await page.type('[data-shift-counted-input]', '0');
  await page.click('[data-shift-record-count]');
  await page.waitForFunction(() => document.querySelector('[data-shift-count-state]')?.textContent.includes('آخر عدّ'));
  assert.equal(await page.$eval('[data-close-shift-submit]', el => el.disabled), true, 'count is not reconciliation');
  const direct = await page.evaluate(async () => {
    try { await window.__TAURI_INTERNALS__.invoke('close_shift', { countedCashMinor: 0, closeNote: 'test' }); return 'unexpected success'; }
    catch (e) { return e.code; }
  });
  assert.equal(direct, 'SHIFT_CASH_UNRECONCILED');
  await page.keyboard.press('Escape');
  console.log('PASS count observation persists and direct unreconciled close is refused by demo');
  await page.click('[data-open-reminders]');
  await page.type('[data-reminder-text]', 'تذكير اختبار');
  await page.click('[data-reminder-add]');
  assert.equal(await page.$eval('[data-reminder-row]', el => el.textContent.includes('تذكير اختبار')), true);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mshop.reminders.v1'))[0].text), 'تذكير اختبار');
  await page.evaluate(() => localStorage.setItem('mshop.reminders.v1', '[{broken]'));
  await page.reload({ waitUntil: 'networkidle0' });
  await clickText('.user-card', 'بيتر');
  await page.waitForSelector('.pinpad');
  await page.keyboard.type('1111'); await page.keyboard.press('Enter');
  await page.waitForSelector('.shell');
  await page.click('[data-open-reminders]');
  assert.ok(await page.$('[data-reminders-modal] [role="alert"]'));
  await page.type('[data-reminder-text]', 'لا تكتب فوق البيانات');
  await page.click('[data-reminder-add]');
  assert.equal(await page.evaluate(() => localStorage.getItem('mshop.reminders.v1')), '[{broken]');
  console.log('PASS reminder save and corruption refusal');
} finally { await browser.close(); }
