#!/usr/bin/env node
// The backup panel, driven in the real app on the browser demo.
//
// This is the regression the operator hit on 2026-10-22: the panel printed
// «يلزم إعادة إدخال كلمة المرور» and offered nowhere to type it, so the import
// could not be completed at all — and a refusal that never touched the database
// was announced as «أعد تشغيل التطبيق، لا يعمل أي أمر», which is only true for a
// restore that got past authorization.
//
//   npm run demo &
//   node scripts/backup-flow.mjs http://127.0.0.1:5173/ /tmp/backup-shots
//
// Uses the headless Chromium the mockup tools install
// (`npm ci` in docs/ui/mockup-v1/tools). Not part of CI.

import fs from 'node:fs';
import path from 'node:path';

import { launch } from '../docs/ui/mockup-v1/tools/launch.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
const BASE = `${URL}${URL.includes('?') ? '&' : '?'}shop=1`;
const OUT = process.argv[3] || '/tmp/backup-shots';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const count = (sel) => page.$$eval(sel, (els) => els.length);
const panelText = () =>
  page.$eval('[data-settings-panel="backup"]', (el) => el.textContent ?? '').catch(() => '');
const fill = (sel, value) =>
  page.$eval(
    sel,
    (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value
  );

async function clickText(selector, label) {
  for (const h of await page.$$(selector)) {
    if ((await h.evaluate((el) => el.textContent ?? '')).includes(label)) {
      await h.click();
      return true;
    }
  }
  return false;
}

/** Sign in on the lock card with the PIN. */
async function signIn(name, pin) {
  await page.waitForSelector('.user-card');
  await clickText('.user-card', name);
  await page.waitForSelector('.pinpad');
  await page.keyboard.type(pin);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.shell', { timeout: 5000 });
  await page.waitForSelector('.lock.over', { hidden: true, timeout: 5000 });
}

/** Answer the identity dialog the panel opens. */
async function proveIdentity(password) {
  await page.waitForSelector('#backup-reauth-password', { timeout: 3000 });
  await fill('#backup-reauth-password', password);
  await page.click('#backup-reauth-confirm');
  await sleep(150);
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await signIn('بيتر', '1111');

  await clickText('.rail .nav-btn', 'الإعدادات');
  await page.waitForSelector('[data-settings-tab="backup"]');
  await page.click('[data-settings-tab="backup"]');
  await page.waitForSelector('#backup-create');

  const suggested = await page.$eval('#backup-create-name', (el) => el.value);
  check(
    'the backup file name is filled in, so creating one needs no typing',
    /^backup-\d{4}-\d{2}-\d{2}-\d{4}\.msb1$/.test(suggested),
    suggested
  );
  check('the panel tells the operator a dropped file is enough', (await panelText()).includes('افلته هنا'));
  await shot('01-backup-panel');

  // --- create -----------------------------------------------------------------
  await fill('#backup-create-password', 'shop12345');
  await page.click('#backup-create');
  await sleep(250); // let the dialog's 140ms entrance animation settle before the shot
  check(
    'creating a backup ASKS for the manager password instead of printing the refusal',
    (await count('#backup-reauth-password')) === 1
  );
  check(
    'the refusal text is not a dead end any more',
    !(await panelText()).includes('لعرض هذه البيانات')
  );
  await shot('02-password-dialog');

  await proveIdentity('wrong-password');
  const afterWrong = await page.$eval('#backup-reauth-error', (el) => el.textContent ?? '').catch(() => '');
  check('a wrong password keeps the dialog open with its own message', afterWrong.trim() !== '', afterWrong.trim());
  check('a wrong password leaves no half-finished backup', !(await panelText()).includes('تم إنشاء النسخة'));

  await proveIdentity('1234');
  check('the right password creates the backup', (await panelText()).includes('تم إنشاء النسخة الاحتياطية'));
  check(
    'the next backup gets a fresh name instead of overwriting this one',
    /^backup-\d{4}-\d{2}-\d{2}-\d{4}\.msb1$/.test(await page.$eval('#backup-create-name', (el) => el.value))
  );
  await shot('03-backup-created');

  // --- a path the backend refuses BEFORE it touches anything -------------------
  await fill('#backup-restore-path', '..\\..\\Windows\\evil.msb1');
  await fill('#backup-restore-password', 'shop12345');
  await page.click('#backup-restore');
  await proveIdentity('1234');
  const refusal = await panelText();
  check('a refused path says the data was not touched', refusal.includes('البيانات ما اتلمستش'), refusal.slice(-120));
  check(
    'a refused path does NOT tell the operator the app is dead',
    !refusal.includes('لا يعمل أي أمر') && !refusal.includes('أعد تشغيل التطبيق يدويًا الآن')
  );
  check('the backend code is shown so it can be reported', refusal.includes('BACKUP_UNSAFE_PATH'));
  await shot('04-refused-path');

  // --- a real import ----------------------------------------------------------
  await fill('#backup-restore-path', 'C:\\Users\\peter\\Downloads\\الطاحونة.msb1');
  await fill('#backup-restore-password', 'shop12345');
  await page.click('#backup-restore');
  await proveIdentity('1234');
  const imported = await panelText();
  check('the import runs once the password is proven', imported.includes('تم استيراد النسخة الاحتياطية'));
  check('and the panel asks for the manual restart the engine requires', imported.includes('أعد تشغيل التطبيق يدويًا'));
  await shot('05-imported');

  check('no page errors while doing any of that', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed — shots in ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);
