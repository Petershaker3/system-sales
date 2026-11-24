// Headless Chromium for the mockup QA scripts, without a system browser.
// Uses @sparticuz/chromium; on a plain Linux sandbox its shared libs + fonts must be unpacked first
// (al2023.tar.br / fonts.tar.br → /tmp/al2023x), then passed via LD_LIBRARY_PATH / FONTCONFIG_PATH.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIBX = '/tmp/al2023x';
function unpack(br, dest) {
  const tar = path.join('/tmp', `${path.basename(br, '.br')}-${process.pid}`);
  fs.writeFileSync(tar, zlib.brotliDecompressSync(fs.readFileSync(br)));
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xf', tar, '-C', dest]);
  fs.unlinkSync(tar);
}
export async function launch() {
  const bin = path.join(HERE, 'node_modules', '@sparticuz', 'chromium', 'bin');
  if (!fs.existsSync(path.join(LIBX, 'lib'))) {
    unpack(path.join(bin, 'al2023.tar.br'), LIBX);
    unpack(path.join(bin, 'fonts.tar.br'), LIBX);
  }
  const executablePath = await chromium.executablePath();
  return puppeteer.launch({
    executablePath, headless: true, args: [...chromium.args, '--lang=ar'],
    env: { ...process.env, LD_LIBRARY_PATH: `${LIBX}/lib`, FONTCONFIG_PATH: LIBX },
  });
}
export const URL = process.env.MOCKUP_URL || 'http://127.0.0.1:4173/';
