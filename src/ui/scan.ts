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

// ---------------------------------------------------------------------------
// The main rear camera (owner request 2026-10-21)
// ---------------------------------------------------------------------------

/**
 * Which of the phone's rear lenses a WebView hands over for
 * `facingMode: environment` is the WebView's choice, and on a multi-lens
 * handset it is often the *wide-angle* one: the picture bends at the edges and
 * a barcode held straight reads crooked. The owner's rule is the shop's rule —
 * the scanner uses the main camera («الكاميرا الأساسية»).
 *
 * The web platform has no «main lens» flag, so the lens is chosen by the only
 * thing the platform does report: the device label. Android WebViews label the
 * lenses «camera2 0, facing back», «camera2 2, facing back»… with the main lens
 * first; iPhones name them «Back Camera», «Back Ultra Wide Camera», «Back
 * Telephoto Camera». Both agree on one thing: the *auxiliary* lenses carry a
 * word in the label, and the main one does not.
 */

/** Labels that mark a rear lens as an auxiliary one, not the main camera. */
const AUX_LENS_LABEL = /ultra|wide|macro|depth|tele|aux|portrait|fisheye|bokeh|zoom|dual|triple|periscope/i;

/** Labels that mark a camera as the rear-facing one. */
const REAR_LENS_LABEL = /back|rear|environment|خلف/i;

/** One video input as `enumerateDevices` reports it. */
export interface CameraDevice {
  readonly deviceId: string;
  readonly label: string;
}

export interface MainCameraChoice {
  /** The lens to open, or `null` when the current one should stay. */
  readonly deviceId: string | null;
  /** Why: the label named the main lens, or it is simply the first rear one. */
  readonly reason: 'named-main' | 'first-rear' | 'keep';
}

/**
 * Pick the main rear camera out of the device list — pure, so the rule is
 * tested without a handset.
 *
 * The rules, in order:
 * 1. No labels (permission not granted yet, or a desktop with one webcam):
 *    keep whatever is open.
 * 2. Rear lenses whose label carries no auxiliary word: the first of them is
 *    the main camera. If the open one is already it, keep it.
 * 3. Every rear lens is named as auxiliary (some handsets label the main one
 *    «wide»): keep the first rear lens, which is still the one the platform
 *    lists first — unless the open camera already is it.
 * 4. No rear lens at all (a desktop webcam): keep what is open.
 */
export function pickMainRearCamera(
  devices: readonly CameraDevice[],
  currentDeviceId: string | null,
): MainCameraChoice {
  const labeled = devices.filter((d) => d.deviceId !== '' && d.label.trim() !== '');
  if (labeled.length === 0) return { deviceId: null, reason: 'keep' };

  const rears = labeled.filter((d) => REAR_LENS_LABEL.test(d.label));
  if (rears.length === 0) return { deviceId: null, reason: 'keep' };

  const mains = rears.filter((d) => !AUX_LENS_LABEL.test(d.label));
  const pool = mains.length > 0 ? mains : rears;
  const reason = mains.length > 0 ? 'named-main' : 'first-rear';
  const chosen = pool[0]!;
  if (chosen.deviceId === currentDeviceId) return { deviceId: null, reason: 'keep' };
  return { deviceId: chosen.deviceId, reason };
}

/** The request the scanner opens with, before any label is known. */
function rearCameraConstraints(): MediaStreamConstraints {
  return { video: { facingMode: { ideal: 'environment' } }, audio: false };
}

/**
 * Open the main rear camera, in two honest steps.
 *
 * The first `getUserMedia` is what earns the permission and what a single-lens
 * machine (or a desktop webcam) keeps. Only then do the devices carry labels,
 * and only if the open lens is an auxiliary one — and a better rear lens is
 * listed — is the stream swapped, `deviceId`-exact. Any failure of the second
 * step keeps the first stream: a wide-angle reading still reads.
 */
export async function openMainRearCamera(): Promise<MediaStream> {
  const first = await navigator.mediaDevices.getUserMedia(rearCameraConstraints());
  try {
    const track = first.getVideoTracks()[0] ?? null;
    const current = track?.getSettings().deviceId ?? null;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs: CameraDevice[] = devices
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    const choice = pickMainRearCamera(inputs, current);
    if (choice.deviceId === null) return first;
    const better = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: choice.deviceId } },
      audio: false,
    });
    first.getTracks().forEach((t) => t.stop());
    return better;
  } catch {
    // Enumeration or the swap refused: the first stream stays the answer.
    return first;
  }
}

/** Whether this machine can open a camera at all. */
export function scannerSupport(): ScannerSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { supported: false, note: 'الكاميرا مش متاحة جوه التطبيق ده.' };
  }
  const hasCamera = navigator.mediaDevices?.getUserMedia !== undefined;
  if (!hasCamera) {
    return {
      supported: false,
      note: 'الجهاز ده ما بيدّيش كاميرا للتطبيق — اكتب الرقم أو الصقه، والطريقة دي شغالة زي ما هي.',
    };
  }
  return { supported: true, note: '' };
}

/**
 * What to tell a person when the camera refused to open.
 *
 * The Android WebView has two doors to open before the lens is allowed: the OS
 * runtime permission and the WebView's own permission request. If either stays
 * shut the screen must not shrug — it says which one to open.
 */
export function cameraFailureNote(error: unknown): string {
  const name =
    error instanceof Object && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : '';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'مفيش كاميرا على الجهاز ده — اكتب الرقم أو الصقه، والطريقة دي شغالة زي ما هي.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'الكاميرا مشغولة ببرنامج تاني — اقفل البرنامج التاني وجرّب تاني.';
  }
  return (
    'الكاميرا مرفوضة للتطبيق. من إعدادات الموبايل: التطبيقات ← البرنامج ده ← ' +
    'الأذونات ← الكاميرا ← اسمح، وبعدها جرّب تاني. لو مش لاقيها، اكتب الرقم أو الصقه.'
  );
}

/** One decoded frame: the text inside the first code the camera saw. */
export interface FrameDecoder {
  /** Which engine answered: the platform detector or the bundled reader. */
  readonly kind: 'native' | 'zxing';
  decode: (canvas: HTMLCanvasElement) => Promise<string | null>;
}

type DetectorResult = { readonly rawValue?: string | undefined };
type Detector = {
  detect: (source: CanvasImageSource) => Promise<readonly DetectorResult[]>;
};
type DetectorCtor = new (options: { formats: readonly string[] }) => Detector;

/**
 * Pick the decoder this device can actually run.
 *
 * Chrome on Android and Windows 11 ship `BarcodeDetector`; older Android WebViews
 * and some desktop WebViews do not. There the bundled ZXing reader (pure
 * JavaScript, no network and no Google service) reads the same frame. The camera
 * therefore opens wherever there is a camera, not only on machines with a
 * particular WebView version — which is the difference between "a button that
 * exists" and "a button that reads".
 */
export async function createFrameDecoder(): Promise<FrameDecoder> {
  const Ctor = (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
  if (typeof Ctor === 'function') {
    const detector = new (Ctor as DetectorCtor)({ formats: SCAN_FORMATS });
    return {
      kind: 'native',
      decode: async (canvas) => {
        const found = await detector.detect(canvas);
        const first = found[0]?.rawValue?.trim();
        return first !== undefined && first !== '' ? first : null;
      },
    };
  }

  const { BrowserMultiFormatReader } = await import('@zxing/browser');
  const reader = new BrowserMultiFormatReader(undefined, {
    delayBetweenScanAttempts: 0,
    delayBetweenScanSuccess: 0,
  });
  return {
    kind: 'zxing',
    decode: async (canvas) => {
      try {
        const result = reader.decodeFromCanvas(canvas);
        const text = result.getText().trim();
        return text !== '' ? text : null;
      } catch {
        // `NotFoundException` is the normal answer while the frame has no code in it.
        return null;
      }
    },
  };
}

/** Options every scanner is created with: retail codes, phone codes, pairing QR. */
export const SCAN_FORMATS: readonly string[] = [
  'ean_13',
  'code_128',
  'code_39',
  'qr_code',
];
