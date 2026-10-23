// Leaving the app for WhatsApp (`src/ui/external.ts`).
//
// Two failures are being pinned down here, because both were invisible in a
// browser-only test and both are why the receipt button "did nothing":
//   * a webview that must hand the URL to the operating system, and
//   * a `window.open` that must still be inside the click that caused it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatOpenNote, isChatUrl, isDesktopShell, openChatUrl } from './external.ts';

test('only a WhatsApp chat link is handed to the system', () => {
  assert.equal(isChatUrl('https://wa.me/201012345678?text=%D8%A3%D9%87%D9%84%D8%A7'), true);
  assert.equal(isChatUrl('https://api.whatsapp.com/send?phone=201012345678'), true);
  assert.equal(isChatUrl('https://web.whatsapp.com/send?text=hi'), true);
  assert.equal(isChatUrl('https://WA.ME/201012345678'), true, 'host names are case-insensitive');

  // Another scheme is another program.
  assert.equal(isChatUrl('http://wa.me/201012345678'), false);
  assert.equal(isChatUrl('file:///C:/Windows/System32/cmd.exe'), false);
  assert.equal(isChatUrl('shell:cmd'), false);
  // The host is the whole host: a lookalike is not ours.
  assert.equal(isChatUrl('https://wa.me.evil.com/201012345678'), false);
  assert.equal(isChatUrl('https://evil.com/?x=https://wa.me'), false);
  assert.equal(isChatUrl('https://wa.me@evil.com/2010'), false);
  // A space or a newline is how a second command hides in a shell argument.
  assert.equal(isChatUrl('https://wa.me/2010 && calc'), false);
  assert.equal(isChatUrl('https://wa.me/2010\ncalc'), false);
  assert.equal(isChatUrl(''), false);
});

test('the desktop shell is the packaged app, never the browser demo', () => {
  assert.equal(isDesktopShell({ hasInternals: true, demo: false }), true);
  assert.equal(
    isDesktopShell({ hasInternals: true, demo: true }),
    false,
    'the demo installs the same internals as a mock; it must still open a real tab'
  );
  assert.equal(isDesktopShell({ hasInternals: false, demo: false }), false);
});

test('a browser with no document is reported as blocked, not as "sent"', () => {
  // `document` is absent here, which is the one case the function cannot click in.
  assert.equal(openChatUrl('https://wa.me/201012345678', { desktop: false }), 'blocked');
  // A URL this app did not build is not opened at all.
  assert.equal(openChatUrl('https://evil.com/', { desktop: false }), 'refused');
});

test('the browser path clicks a real link rather than calling window.open', () => {
  const previousDocument = (globalThis as { document?: unknown }).document;
  const clicked: string[] = [];
  try {
    (globalThis as { document?: unknown }).document = {
      createElement: () => ({
        set href(value: string) {
          clicked.push(value);
        },
        target: '',
        rel: '',
        click() {
          clicked.push('clicked');
        },
        remove() {
          clicked.push('removed');
        },
      }),
      body: { appendChild: () => undefined },
    };
    assert.equal(openChatUrl('https://wa.me/201012345678', { desktop: false }), 'window');
    assert.deepEqual(clicked, ['https://wa.me/201012345678', 'clicked', 'removed']);
  } finally {
    (globalThis as { document?: unknown }).document = previousDocument;
  }
});

test('the note after a send tells the truth, and says what to do next', () => {
  assert.match(chatOpenNote('window'), /الصق صورة الإيصال/);
  assert.match(chatOpenNote('native'), /الصق صورة الإيصال/);
  assert.match(chatOpenNote('blocked'), /منع/);
  assert.match(chatOpenNote('blocked'), /فتح محادثة واتساب/);
  assert.match(chatOpenNote('refused'), /مش رابط واتساب/);
});

test('every screen leaves the app through this one door', async () => {
  // The rule that keeps this fixed: no screen calls `window.open` for a chat by
  // itself, because the two places that got it wrong were screens that did.
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|vue)$/.test(entry) || entry.endsWith('.test.ts')) continue;
      if (full.endsWith(join('ui', 'external.ts'))) continue;
      const code = readFileSync(full, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
        .join('\n');
      if (code.includes('window.open(')) offenders.push(full.slice(root.length));
    }
  };
  walk(root);

  assert.deepEqual(offenders, [], 'a chat is opened by src/ui/external.ts, never by a screen');
});
