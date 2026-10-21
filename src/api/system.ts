/**
 * System-level commands: opening one web address in the OS's own browser.
 *
 * A thin typed wrapper over `invoke`, like the other `api/` files. The WebView
 * cannot open a second window, so every WhatsApp link and every outside page
 * (GSMArena) leaves the app through this one command — and Rust refuses any
 * address that is not plain `http(s)` (`commands/system.rs`).
 */

import { invoke } from '@tauri-apps/api/core';

/** Hand one validated web address to the operating system. */
export function openExternalUrl(url: string): Promise<void> {
  return invoke<void>('open_external_url', { url });
}
