// Short messages at the bottom of the screen (docs/ui/mockup-v1/app.js,
// `toast`). At most three at a time; each fades after a few seconds.
import { reactive } from 'vue';

export type ToastKind = 'ok' | 'err' | 'info';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
  out: boolean;
}

export const toasts: Toast[] = reactive([]);

let next = 1;

export function toast(message: string, kind: ToastKind = 'ok', ms = 2800): void {
  const item: Toast = reactive({ id: next++, kind, message, out: false });
  toasts.push(item);
  while (toasts.length > 3) toasts.shift();
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

/** A short low beep for a refused scan or an out-of-stock item. */
export function beep(freq = 230, duration = 0.13): void {
  try {
    audio = audio ?? new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.value = 0.04;
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + duration);
  } catch {
    // No audio device: silence is fine.
  }
}
