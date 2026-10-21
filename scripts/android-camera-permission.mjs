#!/usr/bin/env node
// The Android manifest is generated, not written by hand: `tauri android init`
// creates `src-tauri/gen/android` and the repository deliberately keeps that folder
// out of git (`.gitignore`). The camera, however, is a product requirement — every
// barcode and IMEI field offers it (`ADR-043`) — and an Android app that does not
// declare `android.permission.CAMERA` has no camera at all: the WebView's
// `getUserMedia` is answered with a runtime permission request that the OS refuses
// before the user is ever asked.
//
// So the generated project is patched immediately after `init` and before Gradle
// packs the APK. The patch is idempotent, and a no-op on a machine that has never
// generated the Android project (desktop-only checkouts).
//
// Run it through `npm run android:init`, or as its own step in CI:
//
//     npx tauri android init --ci
//     node scripts/android-camera-permission.mjs
//     npx tauri android build --debug --target aarch64 --apk

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(
  ROOT,
  'src-tauri',
  'gen',
  'android',
  'app',
  'src',
  'main',
  'AndroidManifest.xml'
);

const CAMERA = 'android.permission.CAMERA';

if (!fs.existsSync(MANIFEST)) {
  console.log('[android] no generated project yet — nothing to patch');
  process.exit(0);
}

const xml = fs.readFileSync(MANIFEST, 'utf8');

if (xml.includes(CAMERA)) {
  console.log('[android] camera permission already declared');
  process.exit(0);
}

// `uses-feature ... required="false"` matters: without it Play treats the camera as
// a hard requirement, and a shop tablet without one could not install the app even
// though typing an IMEI still works there.
const block = [
  `    <uses-permission android:name="${CAMERA}" />`,
  '    <uses-feature android:name="android.hardware.camera" android:required="false" />',
].join('\n');

const patched = xml.replace(/(<manifest\b[^>]*>)/, `$1\n${block}`);

if (patched === xml) {
  console.error('[android] could not find <manifest> in the generated AndroidManifest.xml');
  process.exit(1);
}

fs.writeFileSync(MANIFEST, patched);
console.log('[android] camera permission declared in the generated manifest');
