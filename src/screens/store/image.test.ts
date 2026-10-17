import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approxBytesFromDataUrl,
  approxKilobytes,
  cropSquare192,
  IMAGE_SIDE,
} from './image.ts';

test('cropSquare192 centre-crops landscape, portrait, and square source dimensions to 192×192', () => {
  assert.deepEqual(cropSquare192(400, 200), {
    sx: 100,
    sy: 0,
    sSide: 200,
    dSide: IMAGE_SIDE,
  });
  assert.deepEqual(cropSquare192(300, 500), {
    sx: 0,
    sy: 100,
    sSide: 300,
    dSide: IMAGE_SIDE,
  });
  assert.deepEqual(cropSquare192(192, 192), {
    sx: 0,
    sy: 0,
    sSide: 192,
    dSide: IMAGE_SIDE,
  });
});

test('approxBytesFromDataUrl and approxKilobytes compute decoded byte length and rounded KB', () => {
  const fourBytes = 'data:image/jpeg;base64,////AA==';
  assert.equal(approxBytesFromDataUrl(fourBytes), 4);
  assert.equal(approxKilobytes(fourBytes), 1);

  const payload12kb = 'A'.repeat(16_384); // 16384 * 3 / 4 = 12288 bytes = 12 KB
  assert.equal(approxKilobytes(`data:image/jpeg;base64,${payload12kb}`), 12);
});
