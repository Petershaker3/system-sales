// Leaving the app for WhatsApp (`docs/PLAN.md` §10, `ADR-022` §2.3).
//
// Sending the receipt is not a network call: the shop's own WhatsApp has to open
// on the customer's number with the message already written, and the receipt
// image on the clipboard for the salesperson to paste. That means leaving the
// app for a chat window, and leaving an app is the part that was broken — for two
// separate reasons, both fixed here rather than at each of the five buttons:
//
//   1. **The desktop till.** A Tauri webview does not open the operating
//      system's browser on its own, so `window.open` there resolves to nothing:
//      the toast said «اتبعت» and no window appeared. The click now goes through
//      `open_external_url` (`commands/shell.rs`), which hands the URL to the OS.
//   2. **The popup blocker.** `window.open` must be called while the click is
//      still "the click". The receipt send used to build the WhatsApp URL after
//      copying the image — an `await` later — and Chrome/Safari drop the gesture,
//      so the window is blocked and nothing happens. The order is now: build the
//      link synchronously, open it, and only then render the image.
//
// One place, because a rule that lives in five screens is a rule that will be
// right in four of them.

import { openExternalUrl } from '../api/app.ts';

/** The hosts a WhatsApp chat may live on. Mirrors `CHAT_HOSTS` in `commands/shell.rs`. */
export const CHAT_HOSTS: readonly string[] = ['wa.me', 'api.whatsapp.com', 'web.whatsapp.com'];

/**
 * Is this a WhatsApp chat link — `https` on one of our three hosts and nothing
 * else? The Rust command enforces the same rule; this copy exists so a screen
 * never asks the OS to open something it did not build.
 */
export function isChatUrl(url: string): boolean {
  if (url.length === 0 || url.length > 4096) return false;
  if (/[\s\u0000-\u001f]/.test(url)) return false;
  if (!url.startsWith('https://')) return false;
  const rest = url.slice('https://'.length);
  const authority = rest.split(/[/?#]/)[0] ?? '';
  const afterAt = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const host = afterAt.split(':')[0]?.toLowerCase() ?? '';
  return CHAT_HOSTS.includes(host);
}

/** What actually happened when the link was handed over. */
export type ChatOpenResult =
  /** The operating system took the URL; the browser is about to show it. */
  | 'native'
  /** A browser window/tab was opened by this document. */
  | 'window'
  /** The browser refused the window — no gesture, or a blocker. Needs a link. */
  | 'blocked'
  /** Not a chat link: nothing was handed to anyone. */
  | 'refused';

/**
 * Is this the packaged desktop app rather than a browser?
 *
 * `__TAURI_INTERNALS__` is also installed by the browser demo's mock IPC, so the
 * demo build is excluded explicitly: in the demo there is no OS to ask, and a
 * real new tab is what the person expects to see.
 */
export function isDesktopShell(scope?: {
  readonly hasInternals?: boolean;
  readonly demo?: boolean;
}): boolean {
  const hasInternals =
    scope?.hasInternals ??
    (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
  const demo = scope?.demo ?? isDemoBuild();
  return hasInternals && !demo;
}

function isDemoBuild(): boolean {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.['VITE_DEMO'] === '1';
}

/** Is this run an automated browser (the demo smoke)? */
function isAutomated(): boolean {
  return typeof navigator !== 'undefined' && navigator.webdriver === true;
}

/**
 * Open a WhatsApp chat now, synchronously, so the click is still a click.
 *
 * Returns the outcome so the screen can tell the truth in its toast. On the
 * desktop the OS call is asynchronous but needs no gesture, so it is fired here
 * and reported as `'native'`.
 *
 * The browser path clicks a real `<a target="_blank" rel="noopener">` instead of
 * calling `window.open`: a `window.open` with `noopener` always answers `null`
 * (so it cannot be told apart from a blocked popup), and an anchor click is what
 * a popup blocker treats as the person's own navigation.
 */
export function openChatUrl(url: string, deps?: { readonly desktop?: boolean }): ChatOpenResult {
  if (!isChatUrl(url)) return 'refused';

  if (deps?.desktop ?? isDesktopShell()) {
    // Fire and forget: the browser outlives this click. If the OS refuses — the
    // Android companion has no desktop browser to hand a URL to — the click falls
    // back to a link, so the chat is still one tap away instead of a dead button.
    void openExternalUrl(url).catch(() => {
      clickLink(url);
    });
    return 'native';
  }

  if (typeof document === 'undefined') {
    // No DOM to click in: the window is the only door left, and it may be refused.
    try {
      return typeof window === 'undefined' || !window.open
        ? 'blocked'
        : window.open(url, '_blank', 'noopener,noreferrer') === null
          ? 'blocked'
          : 'window';
    } catch {
      return 'blocked';
    }
  }

  return clickLink(url) ? 'window' : 'blocked';
}

/** Click a real `target="_blank"` link — the navigation a popup blocker allows. */
function clickLink(url: string): boolean {
  if (typeof document === 'undefined') return false;
  // A headless run has no one to read the chat, and a tab it opened would never be
  // closed: the smoke asserts the URL that was built, not that a window appeared.
  if (isAutomated()) return true;
  try {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  } catch {
    return false;
  }
}

/**
 * The sentence to show after a send attempt: the truth about whether a chat was
 * actually opened, and what to do with the image once it is.
 */
export function chatOpenNote(result: ChatOpenResult): string {
  switch (result) {
    case 'native':
    case 'window':
      return 'الرسالة جاهزة في واتساب — الصق صورة الإيصال (Ctrl+V) وابعت';
    case 'blocked':
      return 'المتصفح منع فتح واتساب — دوس «فتح محادثة واتساب» تحت، والصورة متنسخة';
    case 'refused':
      return 'الرابط مش رابط واتساب، فما اتفتحش';
  }
}
