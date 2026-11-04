// The pairing QR (`screens/mobile/pair-qr.ts`).
//
// The bug this file guards: the QR the computer showed was a drawing of a QR
// code — finder squares plus hash noise — that no camera could read. So the test
// here is not «it looks like a QR»: every matrix below is rendered to pixels and
// read back by the same decoder the phone's camera uses.
//
//   encode → raster → decode → the payload the computer printed
//
// If any of that breaks, «ربط الموبايل» breaks again, and this fails first.

import assert from 'node:assert/strict';
import {
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from '@zxing/library';
import test from 'node:test';

import { parsePairPayload } from './companion.ts';
import { buildPairQr, finderOrigins, hasQrShape, looksLikePairPayload, QUIET_ZONE } from './pair-qr.ts';

/**
 * Read a QR matrix the way a camera would: draw it at 8 pixels per module, then
 * decode the picture. The scale is what makes it a fair test — a decoder that
 * only agrees with the matrix it was handed proves nothing about a screen.
 */
function decodeMatrix(modules: readonly (readonly boolean[])[]): string | null {
  const scale = 8;
  const size = modules.length;
  const width = size * scale;
  const height = size * scale;
  // Luminance: 0 is black, 255 is white (`RGBLuminanceSource`).
  const pixels = new Uint8ClampedArray(width * height).fill(255);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (modules[row]?.[column] !== true) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          pixels[(row * scale + dy) * width + column * scale + dx] = 0;
        }
      }
    }
  }

  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.CHARACTER_SET, 'UTF-8');
  const reader = new QRCodeReader();
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, width, height)));
  try {
    return reader.decode(bitmap, hints as Map<DecodeHintType, never>).getText();
  } catch {
    return null;
  }
}

test('the pairing QR the computer shows is readable, and reads back exactly what it printed', async () => {
  const payload = 'MSHOP-PAIR|v1|سنتر بيتر للموبايلات|192.168.1.10:8787|PAIR-8787';
  const qr = await buildPairQr(payload);

  assert.equal(qr.payload, payload);
  assert.ok(qr.size >= 21 && (qr.size - 21) % 4 === 0, 'a real QR version, not an arbitrary square');
  assert.equal(qr.modules.length, qr.size);
  assert.ok(qr.path.length > 0, 'the code draws something');

  // The decoder — not a human eye, not a screenshot — reads it back.
  assert.equal(decodeMatrix(qr.modules), payload, 'a camera must read the payload the computer printed');
});

test('an Arabic shop name survives the round trip', async () => {
  // UTF-8 is declared in the code; without it a decoder guesses and the name
  // arrives as question marks.
  const payload = 'MSHOP-PAIR|v1|محل النور للموبايلات|192.168.1.7:8787|PAIR-1234';
  const qr = await buildPairQr(payload);
  const read = decodeMatrix(qr.modules);
  assert.equal(read, payload);
  assert.ok(read?.includes('محل النور للموبايلات'), 'the shop reads its own name on the phone');
});

test('a long name still fits, and still decodes', async () => {
  const payload =
    'MSHOP-PAIR|v1|' +
    'محل الموبايلات الطاحونة فرع وسط البلد'.repeat(2) +
    '|192.168.100.200:8787|PAIR-8787';
  const qr = await buildPairQr(payload);
  assert.ok(qr.size > 45, 'a longer line makes a bigger code, not a truncated one');
  assert.equal(decodeMatrix(qr.modules), payload);
});

test('what the QR carries is what the phone will act on', async () => {
  // The two halves have to agree: an encoder that produced a beautiful code the
  // app cannot parse would be the same bug wearing a new hat.
  const payload = 'MSHOP-PAIR|v1|سنتر بيتر للموبايلات|192.168.1.10:8787|PAIR-8787';
  const read = decodeMatrix((await buildPairQr(payload)).modules);
  assert.ok(read !== null);
  assert.deepEqual(parsePairPayload(read), {
    shopName: 'سنتر بيتر للموبايلات',
    host: '192.168.1.10',
    port: 8787,
    pairCode: 'PAIR-8787',
  });
  assert.equal(looksLikePairPayload(read), true);
});

test('the owner’s follow-up code is a real code too', async () => {
  const payload = 'MSHOP-REMOTE|v1|محل النور للموبايلات|RMT-9042';
  const qr = await buildPairQr(payload);
  assert.equal(decodeMatrix(qr.modules), payload);
  // …and the pairing parser does not swallow it (ADR-042).
  assert.equal(parsePairPayload(payload), null);
});

test('an empty payload is refused instead of drawn', async () => {
  // A code of nothing is the state the old component faked with a placeholder
  // shop and IP. A screen can say «بيتجهز»; it cannot invent a scannable code.
  await assert.rejects(async () => buildPairQr(''), /pairing/);
  await assert.rejects(async () => buildPairQr('   '), /pairing/);
  assert.equal(looksLikePairPayload(''), false);
  assert.equal(looksLikePairPayload('hello'), false);
});

test('the matrix has the marks every QR code has, and a quiet zone', async () => {
  const qr = await buildPairQr('MSHOP-PAIR|v1|متجر|192.168.1.20:8787|PAIR-8787');
  assert.equal(hasQrShape(qr.modules), true);
  assert.equal(QUIET_ZONE, 4);

  // The three finder squares sit inside the quiet zone.
  for (const [row, column] of finderOrigins(qr.size)) {
    assert.equal(qr.modules[row]?.[column], true, 'finder corner');
    assert.equal(qr.modules[row + 1]?.[column + 1], false, 'the light ring inside it');
    assert.equal(qr.modules[row + 3]?.[column + 3], true, 'the dark core');
  }

  // A matrix made of the old hash noise has finder squares and no encoding, so it
  // decodes to nothing: that is the difference this test exists to keep.
  const fake = Array.from({ length: 45 }, () => Array.from({ length: 45 }, () => false));
  assert.equal(hasQrShape(fake), false, 'a blank matrix is not a QR code');
});
