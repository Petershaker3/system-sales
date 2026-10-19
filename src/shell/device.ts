// Which kind of screen this build is on (`ADR-039` §الموبايل).
//
// Two things depend on it, and only two: which screen the shop opens on, and
// whether the desktop companion-preview screen belongs on the rail at all. The
// *layout* is not decided here — `src/styles/mobile.css` reflows the shell at a
// narrow width, so a resized desktop window gets the same arrangement as a phone
// without needing to be told which one it is.
//
// Nothing here is a security boundary, and it is not asked about: permissions come
// from Rust (`spec:210`), and a phone that lies about its user agent only gets an
// uglier till.

export type DeviceKind = 'phone' | 'desktop';

/** Handheld user agents, as the WebView on each of them actually reports itself. */
const HANDHELD = /Android|iPhone|iPod|iPad|Windows Phone|IEMobile|Opera Mini/i;

export interface DeviceSignal {
  readonly userAgent: string;
  /** iPadOS in "Desktop Site" mode reports a Macintosh UA; it is the only touch Mac. */
  readonly maxTouchPoints: number;
}

/**
 * A phone, or the computer.
 *
 * Small Android tablets count as a phone here, and that is the intent: the question
 * is "should this open on the till rather than on a desktop preview screen", and a
 * tablet held in a hand is answering yes.
 */
export function deviceKindOf(signal: DeviceSignal): DeviceKind {
  if (HANDHELD.test(signal.userAgent)) return 'phone';
  if (/Macintosh/i.test(signal.userAgent) && signal.maxTouchPoints > 0) return 'phone';
  return 'desktop';
}

/** Read the running browser. Outside a browser (a unit test, a build) it is a desktop. */
export function currentDevice(): DeviceKind {
  if (typeof navigator === 'undefined') return 'desktop';
  return deviceKindOf({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });
}

let device: DeviceKind | null = null;

/** The kind, read once. Nothing in the app needs it before the shell is built. */
function kind(): DeviceKind {
  if (device === null) device = currentDevice();
  return device;
}

/**
 * Ask once, at start-up, and mark the document.
 *
 * The `data-device` attribute is there for anyone reading the DOM later — the guide,
 * a screenshot, a developer tools session — so the answer the app acted on is visible
 * without opening a console.
 */
export function markDevice(): DeviceKind {
  device = currentDevice();
  if (typeof document !== 'undefined') {
    document.documentElement.dataset['device'] = device;
  }
  return device;
}

export function isPhone(): boolean {
  return kind() === 'phone';
}
