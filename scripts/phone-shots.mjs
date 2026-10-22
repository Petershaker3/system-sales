#!/usr/bin/env node
// The phone half of `ADR-039`, photographed and checked on a handset-shaped viewport.
//
// The Android app is this same build in a 400×800 window, so the questions the owner
// asked — «تطبيق الاندرويد بيعرض واجهه الكمبيوتر» — are answerable here: does the shell
// reflow, does anything stick out past the edge of the screen, and does the till open on
// the till. The script signs nothing in: the demo itself starts that way now (`ADR-039`
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
/** Walk to a screen by its rail label, reporting the rail when the label is not there. */
async function goTo(label) {
  await sleep(400);
  if (label === 'الإعدادات') {
    // An icon at the foot of the rail since 2026-10-23: no label to search for.
    await page.$eval('.rail [data-rail-settings]', (el) => el.click());
    await sleep(300);
    return;
  }
  const found = await page.$$eval(
    '.rail .nav-btn',
    (els, l) => {
      const el = els.find((e) => (e.textContent ?? '').includes(l));
      if (!el) return false;
      el.click();
      return true;
    },
    label
  );
  if (!found) {
    const rail = await page.$$eval('.rail .nav-btn', (els) => els.map((e) => e.textContent.trim()));
    throw new Error(`nothing on the rail is called «${label}» — rail: ${rail.join(', ')}`);
  }
  await sleep(300);
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

await page.goto(URL, { waitUntil: 'networkidle0' });
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

// --- the phone captures, the computer records (ADR-042) ----------------------
// The owner's complaint in one line: the Android app was showing the computer's
// pairing page. A handset has a camera and no database, so this is what it gets.
await goTo('الالتقاط');
await page.waitForSelector('[data-phone-capture-screen]', { timeout: 8000 });
await sleep(250);
check('the till rail carries «الالتقاط» on a phone', (await count('[data-phone-capture-screen]')) === 1);
check(
  'the computer\'s preview screen is not offered to a handset',
  !(await hasText('.rail .nav-btn', 'الموبايل'))
);
check(
  'a phone is never shown a pairing QR',
  (await count('[data-companion-qr]')) === 0,
  `qr boxes: ${await count('[data-companion-qr]')}`
);
check(
  'an unlinked phone is told so, in words it can act on',
  (await text('[data-link-state]')).includes('امسح باركود الربط من الكمبيوتر')
);
check(
  'the pairing line has a camera beside it, so the phone can read the QR on the computer',
  (await count('[data-capture-scan-pair] [data-camera-scan]')) === 1 &&
    (await text('[data-capture-scan-pair] [data-camera-scan]')) === ''
);
await shot('06a-phone-link-card');
// Nothing is linked yet. A capture saved now cannot be sent, and the screen must
// say that with a button rather than with silence — this is the «مش بقدر» the owner
// described (`ADR-043`).
await fill('[data-capture-name]', 'كفر سيليكون أسود');
await fill('[data-capture-qty]', '3');
await fill('[data-capture-cost]', '12000');
await sleep(150);
await page.click('[data-capture-save]');
await sleep(400);
check(
  'a capture saved before linking stays on the phone, and says so',
  (await count('[data-outbox-row]')) === 1 &&
    (await text('[data-outbox-state]')).includes('مستنية البعته')
);
check(
  'the waiting capture is announced at the top with a send button',
  (await count('[data-capture-send-banner]')) === 1 &&
    (await text('[data-capture-send-banner-push]')).includes('ابعت للكمبيوتر')
);
await shot('06b-phone-waiting-to-send');

await fill(
  '[data-capture-paste]',
  'MSHOP-PAIR|v1|سنتر بيتر للموبايلات|192.168.1.10:8787|PAIR-8787'
);
await page.click('[data-capture-use-payload]');
await sleep(200);
check(
  'the pasted line fills in the address and the code',
  (await page.$eval('[data-capture-host]', (el) => el.value)) === '192.168.1.10:8787' &&
    (await page.$eval('[data-capture-code]', (el) => el.value)) === 'PAIR-8787'
);
await page.click('[data-capture-connect]');
await sleep(400);
check(
  'connecting is answered with what happened, not with a green dot',
  (await text('[data-capture-link-tag]')).includes('متّصل') &&
    (await text('[data-capture-link-detail]')).includes('اتسجّل')
);
check(
  'once linked, the phone shows the computer it will send to — not an empty field',
  (await text('[data-capture-stored-host]')).includes('192.168.1.10:8787')
);

await page.click('[data-capture-send-banner-push]');
await sleep(600);
const pushed = await text('[data-outbox-state]');
check(
  'the banner button sends, and the phone claims only delivery',
  pushed.includes('وصلت للكمبيوتر') && !pushed.includes('اتسجلت') && !pushed.includes('نزلت'),
  pushed
);
check(
  'the banner leaves once nothing is waiting',
  (await count('[data-capture-send-banner]')) === 0
);
await shot('07-phone-capture-link');

// An expense is recorded on the phone and sent the same way (`ADR-043`). The phone
// never writes the ledger; it fills the same queue the product went through.
await fill('[data-capture-expense-category]', 'إيجار');
await fill('[data-capture-expense-amount]', '1500');
await fill('[data-capture-expense-note]', 'إيجار شهر أكتوبر');
await page.click('[data-capture-expense-from="outside"]');
await sleep(150);
check(
  'the phone has an expense form, and it asks where the money came from',
  (await count('[data-capture-expense]')) === 1 &&
    (await count('[data-capture-expense-from="drawer"]')) === 1
);
await page.click('[data-capture-expense-save]');
await sleep(700);
check(
  'a linked phone sends the expense on save — no second button to find',
  (await count('[data-outbox-row]')) === 2 &&
    (await page.$$eval('[data-outbox-row]', (rows) => rows.map((r) => r.textContent ?? '').join(' '))).includes(
      'مصروف'
    )
);
const afterExpensePush = await page.$$eval('[data-outbox-row] [data-outbox-state]', (rows) =>
  rows.map((r) => r.textContent ?? '').join(' ')
);
check(
  'the expense went too, and the phone still claims only delivery',
  afterExpensePush.includes('وصلت للكمبيوتر') && !afterExpensePush.includes('اتسجل'),
  afterExpensePush.slice(0, 120)
);
check(
  'nothing is left waiting, so the banner is gone again',
  (await count('[data-capture-send-banner]')) === 0
);
await shot('08-phone-expense-queued');

// And the queue still has its own header button for anything that piles up later.
check(
  'the queue keeps its own send button for whatever piles up',
  (await text('[data-outbox-push]')).includes('ابعت للكمبيوتر')
);
await shot('09-phone-expense-sent');

// The settings page on a phone is the same rule: it explains the link, it does
// not print a code for the phone to read itself.
await goTo('الإعدادات');
await page.waitForSelector('[data-settings-tab="devices"]', { timeout: 8000 });
await page.click('[data-settings-tab="devices"]');
await page.waitForSelector('[data-devices-companion-card]', { timeout: 8000 });
await sleep(300);
check(
  'the devices page on a phone points at the computer instead of at itself',
  (await count('[data-companion-qr]')) === 0 &&
    (await text('[data-devices-companion-phone-note]')).includes('الكمبيوتر هو اللي بيعرضه')
);
const ovLink = await overflow();
check(
  'the capture screen fits a 400px phone',
  ovLink.x <= 1,
  `overflow-x: ${ovLink.x}px ${ovLink.wide.join(' ')}`
);
await shot('08-phone-settings-no-qr');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed — shots in ${OUT}`);
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
