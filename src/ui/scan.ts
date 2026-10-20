/**
 * Reading a code with the camera, shared by every screen that has a barcode or an
 * IMEI field (`ADR-043`).
 *
 * The rule is the one `ADR-042` set for the phone, applied everywhere: the camera is
 * a shortcut, never a requirement. If the browser on this machine cannot decode
 * codes, the button says so and typing or pasting keeps working. Nothing is sent
 * anywhere — the frame is drawn to a canvas and read on the device.
 */

/** What one camera reading turned out to be. */
export type ScanKind = 'pair' | 'imei' | 'barcode';

export interface ScanReading {
  /** Exactly what the camera decoded, trimmed. */
  readonly raw: string;
  /** The digits inside `raw`, which is what an IMEI field should receive. */
  readonly digits: string;
  readonly kind: ScanKind;
}

/**
 * Classify a decoded value.
 *
 * 15 digits is an IMEI because that is what the standard says, and a pairing line is
 * recognised by its prefix so the same button can hand it to the link screen. A
 * barcode that happens to be 15 digits is the ambiguous case, and it is deliberately
 * read as an IMEI: an IMEI typed into a barcode field is refused loudly, while a
 * barcode typed into an IMEI field is accepted as a wrong device — the first failure
 * is the easier one to notice.
 */
export function classifyScan(raw: string): ScanReading {
  const value = raw.trim();
  const digits = value.replace(/\D+/g, '');
  if (value.startsWith('MSHOP-PAIR')) {
    // No digits, deliberately: the pairing line carries a port and a code, and a
    // field that grabbed those numbers would file them as an IMEI.
    return { raw: value, digits: '', kind: 'pair' };
  }
  if (digits.length === 15) {
    return { raw: value, digits, kind: 'imei' };
  }
  return { raw: value, digits, kind: 'barcode' };
}

export interface ScannerSupport {
  readonly supported: boolean;
  readonly note: string;
}

/** Whether this browser can decode a code from the camera at all. */
export function scannerSupport(): ScannerSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { supported: false, note: 'الكاميرا مش متاحة جوه التطبيق ده.' };
  }
  const hasDetector =
    typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector ===
    'function';
  const hasCamera = navigator.mediaDevices?.getUserMedia !== undefined;
  if (hasDetector && hasCamera) {
    return { supported: true, note: '' };
  }
  if (!hasCamera) {
    return {
      supported: false,
      note: 'الجهاز ده ما بيدّيش كاميرا للتطبيق — اكتب الرقم أو الصقه، والطريقة دي شغالة زي ما هي.',
    };
  }
  return {
    supported: false,
    note: 'كاميرا الجهاز ده ما بتقراش الباركود — اكتب الرقم أو الصقه، والطريقة دي شغالة زي ما هي.',
  };
}

/** Options every scanner is created with: retail codes, phone codes, pairing QR. */
export const SCAN_FORMATS: readonly string[] = [
  'ean_13',
  'code_128',
  'code_39',
  'qr_code',
];
