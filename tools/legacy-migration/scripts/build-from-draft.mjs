#!/usr/bin/env node
// Build the new system's backup from a *draft* (`مسودة-الترحيل.json`), not from
// the old program's export.
//
// The screen is the normal path, but a draft that already holds the owner's
// decisions should be buildable without a browser — same pipeline, same checks,
// and the same independent verifier afterwards.
//
// The logo is resized here too: the app insists on a 192×192 JPEG
// (`services/catalog/images.rs`), and a draft carries whatever the old program
// stored, which was 1280×1280 in the shop's case.
//
// Usage:
//   node scripts/build-from-draft.mjs <draft.json> --password <8+ chars> \
//        [--out <dir>] [--no-logo] [--kdf-min]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import initSqlJs from 'sql.js';
import jpeg from 'jpeg-js';

import { buildFromPlan, backupFileName } from '../src/pipeline.mjs';
import { readBackupFile } from '../src/backup.mjs';
import { buildReport } from '../src/report.mjs';
import { validatePlan } from '../src/plan.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

function argValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

/** Decode, centre-crop and re-encode to the 192×192 JPEG the app stores. */
function shrinkLogo(dataUrl) {
  const match = /^data:image\/(jpeg|jpg|png);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!match) return null;
  const raw = Buffer.from(match[2], 'base64');
  const decoded = jpeg.decode(raw, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const size = 192;
  const scale = Math.max(size / decoded.width, size / decoded.height);
  const width = Math.round(decoded.width * scale);
  const height = Math.round(decoded.height * scale);
  const out = new Uint8Array(size * size * 3).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Nearest-neighbour sampling is enough for a logo that ends up 192px wide,
      // and it keeps this script dependency-light.
      const sx = Math.min(decoded.width - 1, Math.max(0, Math.floor(((x - (size - width) / 2) * decoded.width) / width)));
      const sy = Math.min(decoded.height - 1, Math.max(0, Math.floor(((y - (size - height) / 2) * decoded.height) / height)));
      const from = (sy * decoded.width + sx) * 4;
      const to = (y * size + x) * 3;
      out[to] = decoded.data[from];
      out[to + 1] = decoded.data[from + 1];
      out[to + 2] = decoded.data[from + 2];
    }
  }
  const encoded = jpeg.encode({ data: out, width: size, height: size }, 90).data;
  return encoded.length <= 64 * 1024 ? new Uint8Array(encoded) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const input = args.find((arg) => !arg.startsWith('--'));
  const password = argValue(args, '--password');
  if (!input || !password) {
    console.error('usage: build-from-draft.mjs <draft.json> --password <8+ chars> [--out DIR] [--no-logo] [--kdf-min]');
    process.exit(2);
  }
  const outDir = resolve(argValue(args, '--out', join(process.cwd(), 'migration-out')));
  mkdirSync(outDir, { recursive: true });

  const plan = JSON.parse(readFileSync(resolve(input), 'utf8'));
  if (plan.format !== 'system-sales-migration') {
    console.error('this file is not a migration draft (format != system-sales-migration)');
    process.exit(1);
  }

  const validation = validatePlan(plan);
  const errors = validation.findings.filter((finding) => finding.level === 'error');
  if (errors.length) {
    console.error('the plan has errors:', errors);
    process.exit(1);
  }

  const SQL = await initSqlJs({
    wasmBinary: readFileSync(join(here, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')),
  });

  let logo = null;
  if (!args.includes('--no-logo') && plan.settings?.logoDataUrl) {
    logo = shrinkLogo(plan.settings.logoDataUrl);
    if (!logo) console.error('note: the logo could not be resized, the backup ships without it');
  }

  const result = buildFromPlan({
    SQL,
    plan,
    password,
    logoJpeg: logo,
    now: Date.now(),
    kdf: args.includes('--kdf-min') ? { memoryKib: 8192, iterations: 1, parallelism: 1 } : undefined,
  });
  if (!result.ok) {
    console.error('the plan was refused:', result.findings.filter((finding) => finding.level === 'error'));
    process.exit(1);
  }

  const backupName = backupFileName(plan.settings.shopName);
  writeFileSync(join(outDir, 'shop.db'), Buffer.from(result.dbBytes));
  writeFileSync(join(outDir, backupName), Buffer.from(result.bytes));
  writeFileSync(join(outDir, 'migration-package.json'), JSON.stringify(plan, null, 2), 'utf8');

  const reread = readBackupFile(Buffer.from(result.bytes), password);
  writeFileSync(join(outDir, 'migration-report.md'), buildReport({
    plan,
    legacy: { stats: { rolled: 0 }, excluded: plan.source?.excludedKeys || [] },
    result,
    manifest: reread.manifest,
    backupName,
    passwordLength: password.length,
  }), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    backup: join(outDir, backupName),
    database: join(outDir, 'shop.db'),
    bytes: result.bytes.length,
    logo: logo ? `${logo.length} bytes` : 'none',
    stats: result.stats,
    totals: result.totals,
    includes: result.includes,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
