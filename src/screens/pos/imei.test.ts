import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PosUnit } from '../../api/pos';
import {
  imeiLuhn,
  isSerialProduct,
  normalizeImeiDigits,
  requiresImeiOnSale,
  searchUnitsByImei,
  validateImeiInput,
} from './imei.ts';

describe('pos/imei', () => {
  it('normalizes Arabic digits and checks 15-digit Luhn IMEIs', () => {
    assert.equal(normalizeImeiDigits(' ٣٥٦٩٣٨-٠٣٥٦٤٣-٨٠٩ '), '356938035643809');
    assert.equal(imeiLuhn('356938035643809'), true);
    assert.equal(imeiLuhn('490154203237518'), true);
    assert.equal(imeiLuhn('356938035643800'), false);
    assert.equal(imeiLuhn('35693803564380'), false);

    assert.deepEqual(validateImeiInput('356938035643809'), {
      ok: true,
      imei: '356938035643809',
    });
    assert.deepEqual(validateImeiInput('356938035643800'), {
      ok: false,
      code: 'IMEI_CHECK_DIGIT_INVALID',
      digits: '356938035643800',
    });
    assert.deepEqual(validateImeiInput('12345'), {
      ok: false,
      code: 'IMEI_LENGTH_INVALID',
      digits: '12345',
    });
  });

  it('determines serial tracking and required mode', () => {
    assert.equal(isSerialProduct({ tracking: 'serial_optional', brandId: 'b1' }), true);
    assert.equal(isSerialProduct({ tracking: 'none', brandId: null }), false);
    assert.equal(requiresImeiOnSale({ tracking: 'serial_optional' }, 'optional'), false);
    assert.equal(requiresImeiOnSale({ tracking: 'serial_optional' }, 'required'), true);
    assert.equal(requiresImeiOnSale({ tracking: 'serial_required' }, 'optional'), true);
    assert.equal(requiresImeiOnSale({ tracking: 'none' }, 'required'), false);
  });

  it('searches units by last 4 digits or 8+ digit substring while skipping taken IMEIs', () => {
    const units: PosUnit[] = [
      {
        id: 'u1',
        productId: 'p1',
        imei: '356938035643809',
        imei2: null,
        color: 'أسود',
        createdAt: 1000,
      },
      {
        id: 'u2',
        productId: 'p1',
        imei: '490154203237518',
        imei2: null,
        color: 'أزرق',
        createdAt: 2000,
      },
    ];

    const byLast4 = searchUnitsByImei(units, '3809', new Set());
    assert.equal(byLast4.length, 1);
    assert.equal(byLast4[0]?.id, 'u1');

    const skipTaken = searchUnitsByImei(units, '3809', new Set(['356938035643809']));
    assert.equal(skipTaken.length, 0);

    const bySubstring = searchUnitsByImei(units, '01542032', new Set());
    assert.equal(bySubstring.length, 1);
    assert.equal(bySubstring[0]?.id, 'u2');
  });
});
