#!/usr/bin/env node
// The phone half of `ADR-039`, photographed and checked on a handset-shaped viewport.
//
// The Android app is this same build in a 400×800 window, so the questions the owner
// asked — «تطبيق الاندرويد بيعرض واجهه الكمبيوتر» — are answerable here: does the shell
// reflow, does anything stick out past the edge of the screen, and does the till open on
// the till. The script signs nothing in: it starts in the open-shop demo (`?openShop=1`,
// `ADR-039`) and walks it through making the owner account.
//
//   npm run demo            # the browser demo on :5173
//   node scripts/phone-shots.mjs http://127.0.0.1:5173/ /tmp/phone-shots
//
// Uses the headless Chromium the mockup tools install (npm ci in
// docs/ui/mockup-v1/tools). Not part of CI.

import fs from 'node:fs';
import path from 'node:path';

import { launch } from '../docs/ui/mockup-v1/tools/launch.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:5173/';
const OUT = process.argv[3] || '/tmp/phone-shots';
fs.mkdirSync(OUT, { recursive: true });

const PHONE = { width: 400, height: 800 };
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-N976N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ ...PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.setUserAgent(ANDROID_UA);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const text = (sel) => page.$eval(sel, (el) => el.textContent?.trim() ?? '').catch(() => '');
const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
/**
 * Set a field's value the way a person's typing ends up looking.
 *
 * `page.type` sends one key event per character, and in an RTL input the headless
 * renderer lands them in visual order — «شاحن» arrives reversed and nothing matches.
 * Assigning and dispatching `input` is what the app's own `v-model` listens to.
 */
const fill = (sel, value) =>
  page.$eval(sel, (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
/** Whether one of `sel` carries `label` — read only, unlike `clickText`. */
const hasText = (sel, label) =>
  page.$$eval(sel, (els, l) => els.some((el) => (el.textContent ?? '').includes(l)), label).catch(() => false);
async function clickText(selector, label) {
  for (const h of await page.$$(selector)) {
    if ((await h.evaluate((el) => el.textContent ?? '')).includes(label)) {
      await h.click();
      return true;
    }
  }
  return false;
}
/** How far the page reaches past the screen: the phone bug, measured. */
const overflow = () =>
  page.evaluate(
    ({ w }) => {
      // Only elements no scroller is responsible for: `.rail` and `.inv-tabs` scroll on
      // purpose, and a clipped child inside them is not the page sticking out.
      const inScroller = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (p.scrollWidth > p.clientWidth + 1 || p.scrollHeight > p.clientHeight + 1) return true;
        }
        return false;
      };
      const wide = [...document.querySelectorAll('body *')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return !inScroller(el) && r.width > 0 && (r.right > w + 1 || r.left < -1);
        })
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
      return { x: document.documentElement.scrollWidth - w, wide: [...new Set(wide)].slice(0, 6) };
    },
    { w: PHONE.width }
  );

await page.goto(`${URL}?openShop=1`, { waitUntil: 'networkidle0' });
await page.waitForSelector('.shell', { timeout: 10_000 });

const device = await page.$eval('html', (h) => h.dataset.device ?? '');
check('the phone is recognised as a phone', device === 'phone', `data-device=${device || '—'}`);
check(
  'the shell opens on the till, not on the desktop companion preview',
  (await text('.topbar h1')) === 'البيع'
);
const railDir = await page.$eval('.rail', (el) => getComputedStyle(el).flexDirection);
check('the rail became a bottom bar', railDir === 'row', `flex-direction: ${railDir}`);
const railBox = await page.$eval('.rail', (el) => el.getBoundingClientRect().top);
check('the bottom bar sits at the bottom of the screen', railBox > PHONE.height - 120, `top: ${Math.round(railBox)}px`);
check(
  'an open shop offers no lock on the rail',
  (await count('.rail .nav-btn')) > 0 && !(await hasText('.rail .nav-btn', 'قفل'))
);
const ov0 = await overflow();
check('nothing sticks out past a 400px screen at start-up', ov0.x <= 1, `overflow-x: ${ov0.x}px ${ov0.wide.join(' ')}`);
check('the open-shop banner is shown', (await text('[data-open-mode-note]')).includes('من غير حساب'));
await shot('01-phone-open-till');

// A sale on the phone: the till must work at this width, not just look right.
await fill('#q', 'شاحن ايفون');
await page.waitForSelector('.result', { timeout: 5000 });
await page.focus('#q');
await page.keyboard.press('Enter');
await sleep(150);
check('a search adds a line to the invoice', (await count('.line')) >= 1);
const payBox = await page.$eval('.btn-pay', (el) => {
  const r = el.getBoundingClientRect();
  return { h: Math.round(r.height), w: Math.round(r.width) };
});
check('the pay button is a thumb-sized target', payBox.h >= 48 && payBox.w >= 200, `${payBox.w}×${payBox.h}`);
const ov1 = await overflow();
check('an invoice with a line still fits the screen', ov1.x <= 1, `overflow-x: ${ov1.x}px ${ov1.wide.join(' ')}`);
await shot('02-phone-till-with-invoice');

// The account, from الإعدادات ← المستخدمين والصلاحيات.
await page.click('[data-open-account-btn]');
await sleep(250);
check('the banner takes the owner to الإعدادات', (await text('.topbar h1')) === 'الإعدادات');
const card = await text('[data-owner-account-card]');
check('the owner-account card explains the open shop', card.includes('شغال من غير حساب'), card.slice(0, 60));
await shot('03-phone-settings-owner-card');

await page.click('[data-owner-account-btn]');
await page.waitForSelector('.modal', { timeout: 5000 });
await fill('#oa-name', 'أبو كريم');
await fill('#oa-pass', '12345678');
await fill('#oa-confirm', '1234567');
await sleep(100);
check(
  'the form refuses two different passwords',
  (await text('.modal .err-msg')).includes('غير متطابقتين')
);
await shot('04-phone-owner-form');
await fill('#oa-confirm', '12345678');
await clickText('.modal .btn', 'اعمل الحساب');
await page.waitForSelector('.rc-code', { timeout: 5000 });
// Five groups of four, exactly as the code is printed on paper.
check(
  'the claim hands over a recovery code to write down',
  (await count('.rc-code span')) === 5,
  await text('.rc-code')
);
await shot('05-phone-recovery-code');
await clickText('.modal .btn', 'تمام');
await sleep(300);

check('the banner is gone once the account exists', (await count('[data-open-mode-note]')) === 0);
check('the lock is back on the rail', await hasText('.rail .nav-btn', 'قفل'));
check('the chip now carries the claimed name', (await text('.user-chip .who')).includes('أبو كريم'));
await shot('06-phone-after-claim');

console.log(errors.length === 0 ? '\nok   no console errors' : `\nFAIL console errors:\n${errors.join('\n')}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed — shots in ${OUT}`);
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
