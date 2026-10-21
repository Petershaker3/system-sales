// The one question `device.ts` answers (`ADR-039` §الموبايل): is this a handset that
// should open on the till and drop the desktop's phone-preview from its rail? The
// layout itself is a media query, so nothing else here is worth pinning.
import assert from 'node:assert/strict';
import test from 'node:test';

import { deviceKindOf } from './device.ts';

const androidPhone =
  'Mozilla/5.0 (Linux; Android 13; SM-N976N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const iphone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
const windowsDesktop =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const ipadDesktopMode =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';

test('the Android build is a phone', () => {
  assert.equal(deviceKindOf({ userAgent: androidPhone, maxTouchPoints: 5 }), 'phone');
});

test('an iPhone is a phone too, and a Windows machine is not', () => {
  assert.equal(deviceKindOf({ userAgent: iphone, maxTouchPoints: 5 }), 'phone');
  assert.equal(deviceKindOf({ userAgent: windowsDesktop, maxTouchPoints: 0 }), 'desktop');
});

test('an iPad pretending to be a Mac is caught by touch, not by the UA', () => {
  // Reported as a touch-capable Macintosh when "Desktop Site" is on. A desktop Safari
  // on the same hardware reports zero touch points.
  assert.equal(deviceKindOf({ userAgent: ipadDesktopMode, maxTouchPoints: 5 }), 'phone');
  assert.equal(deviceKindOf({ userAgent: ipadDesktopMode, maxTouchPoints: 0 }), 'desktop');
});
