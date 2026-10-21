/**
 * Opening one outside address — a WhatsApp chat (`wa.me`) or a GSMArena page —
 * from wherever the app runs.
 *
 * One helper for every button, because the three homes of the app answer
 * `window.open` differently and a screen that guesses gets it wrong silently:
 *
 * - In the real app (Tauri, Windows or Android) the WebView has no second
 *   window: `window.open` returns nothing and *nothing happens* — which is how
 *   the owner's daily WhatsApp summary became «فيك». There, the address goes to
 *   Rust (`open_external_url`), and the OS opens its browser or WhatsApp.
 * - In the browser demo (`npm run demo`) and `npm run dev` there is no Rust:
 *   the `invoke` is refused, and a normal new tab is the honest fallback.
 * - Under WebDriver (the smoke test) nothing is opened at all — the test reads
 *   the URL the app *would* open from its own hooks, not a real tab.
 *
 * The return says what actually happened, so no toast can claim «اتبعت» for a
 * message that only reached the clipboard.
 */

import { openExternalUrl } from '../api/system.ts';

/** True while a smoke test drives the app: opening real tabs would be noise. */
function underWebDriver(): boolean {
  return typeof navigator !== 'undefined' && navigator.webdriver === true;
}

/**
 * Open one `http(s)` address outside the app.
 *
 * Returns `true` when the address was handed to the OS or to a new tab, and
 * `false` when nothing was opened (WebDriver, empty URL, or every door shut) —
 * the caller says which of the two happened instead of promising a send.
 */
export async function openInSystemBrowser(url: string): Promise<boolean> {
  if (url === '' || underWebDriver()) return false;
  try {
    await openExternalUrl(url);
    return true;
  } catch {
    // Not Tauri (demo/dev in a plain browser), or the OS refused: fall through
    // to the browser's own new tab, which is the right answer there.
  }
  try {
    return window.open(url, '_blank', 'noopener,noreferrer') !== null;
  } catch {
    return false;
  }
}
