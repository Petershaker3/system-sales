// Short messages at the bottom of the screen (docs/ui/mockup-v1/app.js,
// `toast`). At most three at a time; each fades after a few seconds.
//
// Every message also has a sound (owner, 2026-11-09): a short rising chime for
// «تم», a lower double buzz for an error, and a soft single note for
// information. The sound is the same one the shopkeeper already hears when a
// scan is refused (`beep`), so nothing new has to be learned — only that the
// message now lands on the right-hand side of the screen in Arabic (`RTL`) too.
import { reactive } from 'vue';

export type ToastKind = 'ok' | 'err' | 'info';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
  out: boolean;
}

export const toasts: Toast[] = reactive([]);

/**
 * Sound on or off, for a shop that works silently at night.
 *
 * Kept in `localStorage` rather than the settings table: it is a property of
 * this machine's speaker, not of the shop's books, and it must still work
 * before a session is opened.
 */
export const ALERT_SOUND_KEY = 'mshop.alert_sound';

export function alertSoundEnabled(): boolean {
  try {
    return window.localStorage.getItem(ALERT_SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setAlertSoundEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(ALERT_SOUND_KEY, on ? 'on' : 'off');
  } catch {
    // A browser with no storage still gets the default: sound on.
  }
}

let next = 1;

export function toast(message: string, kind: ToastKind = 'ok', ms = 2800): void {
  const item: Toast = reactive({ id: next++, kind, message, out: false });
  toasts.push(item);
  while (toasts.length > 3) toasts.shift();
  playAlert(kind);
  window.setTimeout(() => {
    item.out = true;
  }, ms);
  window.setTimeout(() => {
    const at = toasts.indexOf(item);
    if (at >= 0) toasts.splice(at, 1);
  }, ms + 300);
}

/** Drop every toast at once: a lock must leave nothing of the locked session on screen. */
export function clearToasts(): void {
  toasts.splice(0, toasts.length);
}

let audio: AudioContext | null = null;

function context(): AudioContext | null {
  try {
    audio = audio ?? new AudioContext();
    // A context created before the first click starts suspended in most
    // browsers. Asking again here is harmless and lets the very first message
    // after a click be heard.
    if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
    return audio;
  } catch {
    return null;
  }
}

/** One short note at `at` seconds from now. */
function note(
  ctx: AudioContext,
  freq: number,
  at: number,
  duration: number,
  type: OscillatorType = 'sine',
  volume = 0.05,
): void {
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime + at);
    // A small fade at the end stops the click a square wave makes when cut.
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime + at);
    osc.stop(ctx.currentTime + at + duration);
  } catch {
    // An oscillator the browser refused is not worth a second message about it.
  }
}

/**
 * The sound that goes with a message.
 *
 * `ok` rises (done), `err` is two low square buzzes (something was refused),
 * `info` is a single soft note (nothing to fix). Silence is always acceptable:
 * a machine with no speaker must not turn a saved sale into an error.
 */
export function playAlert(kind: ToastKind): void {
  if (!alertSoundEnabled()) return;
  const ctx = context();
  if (ctx === null) return;
  if (kind === 'ok') {
    note(ctx, 660, 0, 0.09, 'sine', 0.045);
    note(ctx, 990, 0.085, 0.12, 'sine', 0.045);
  } else if (kind === 'err') {
    note(ctx, 240, 0, 0.11, 'square', 0.04);
    note(ctx, 180, 0.14, 0.16, 'square', 0.04);
  } else {
    note(ctx, 540, 0, 0.1, 'sine', 0.03);
  }
}

/** A short low beep for a refused scan or an out-of-stock item. */
export function beep(freq = 230, duration = 0.13): void {
  const ctx = context();
  if (ctx === null) return;
  note(ctx, freq, 0, duration, 'square', 0.04);
}
