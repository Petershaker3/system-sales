// The shared camera reading (`ADR-043`): one rule for every barcode and IMEI field,
// so two screens cannot disagree about what a set of digits is.
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyScan, SCAN_FORMATS } from './scan.ts';

test('fifteen digits is an IMEI, wherever the scan happened', () => {
  const reading = classifyScan('  356789104512345 ');
  assert.equal(reading.kind, 'imei');
  assert.equal(reading.digits, '356789104512345');
  assert.equal(reading.raw, '356789104512345');
});

test('a pairing line keeps its own kind, so the link screen can take it', () => {
  const reading = classifyScan('MSHOP-PAIR|v1|محل النور|192.168.1.20:8787|PAIR-8787');
  assert.equal(reading.kind, 'pair');
  assert.equal(reading.digits, '', 'a pairing payload is not a number field');
});

test('anything else is a barcode, digits separated by the shop’s printer and all', () => {
  assert.equal(classifyScan('6221234560011').kind, 'barcode');
  assert.equal(classifyScan('622123456001').kind, 'barcode', '14 digits is not an IMEI');
  const spaced = classifyScan('6221 2345 60011');
  assert.equal(spaced.kind, 'barcode');
  assert.equal(spaced.digits, '6221234560011', 'the IMEI field can still use the digits');
});

test('the formats cover retail codes, phone codes and the pairing QR', () => {
  assert.deepEqual([...SCAN_FORMATS], ['ean_13', 'code_128', 'code_39', 'qr_code']);
});
