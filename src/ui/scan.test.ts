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

// The main rear camera, not the wide-angle one (owner request 2026-10-21).
// The rule is pure: labels in, the lens to open out.
import { pickMainRearCamera } from './scan.ts';

test('an Android handset: the first plain back lens is the main camera', () => {
  const devices = [
    { deviceId: 'cam0', label: 'camera2 0, facing back' },
    { deviceId: 'cam1', label: 'camera2 1, facing front' },
    { deviceId: 'cam2', label: 'camera2 2, facing back' },
    { deviceId: 'cam3', label: 'camera2 3, facing back, ultra wide' },
  ];
  // The WebView opened the wide-angle lens; the plain back lens takes over.
  assert.deepEqual(pickMainRearCamera(devices, 'cam3'), {
    deviceId: 'cam0',
    reason: 'named-main',
  });
  // The WebView already opened the main one: nothing to swap.
  assert.deepEqual(pickMainRearCamera(devices, 'cam0'), { deviceId: null, reason: 'keep' });
});

test('an iPhone: «Back Camera» wins over the named auxiliary lenses', () => {
  const devices = [
    { deviceId: 'front', label: 'Front Camera' },
    { deviceId: 'ultra', label: 'Back Ultra Wide Camera' },
    { deviceId: 'main', label: 'Back Camera' },
    { deviceId: 'tele', label: 'Back Telephoto Camera' },
  ];
  assert.deepEqual(pickMainRearCamera(devices, 'ultra'), {
    deviceId: 'main',
    reason: 'named-main',
  });
});

test('when every rear lens is named auxiliary, the first rear one stays the answer', () => {
  const devices = [
    { deviceId: 'w1', label: 'back wide camera' },
    { deviceId: 'w2', label: 'back ultra wide camera' },
  ];
  assert.deepEqual(pickMainRearCamera(devices, 'w2'), {
    deviceId: 'w1',
    reason: 'first-rear',
  });
});

test('no labels, no rear lens, or a lone desktop webcam: keep what is open', () => {
  // Labels are empty until the permission was granted once.
  const unlabeled = [
    { deviceId: 'a', label: '' },
    { deviceId: 'b', label: '' },
  ];
  assert.deepEqual(pickMainRearCamera(unlabeled, 'a'), { deviceId: null, reason: 'keep' });
  // A front-only handset.
  assert.deepEqual(pickMainRearCamera([{ deviceId: 'f', label: 'Front Camera' }], 'f'), {
    deviceId: null,
    reason: 'keep',
  });
  // A desktop webcam with no facing word in its label.
  assert.deepEqual(
    pickMainRearCamera([{ deviceId: 'hd', label: 'HD Webcam' }], 'hd'),
    { deviceId: null, reason: 'keep' },
  );
});
