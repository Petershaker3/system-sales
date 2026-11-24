#!/usr/bin/env node
// Command-line run of the same pipeline the HTML tool uses.
//
// It exists twice on purpose: the owner can double-click the HTML file, and a
// developer (or this repository's tests) can run the identical code without a
// browser. Both call `runPipeline` in `src/pipeline.mjs`.
//
// Usage:
//   node scripts/run-migration.mjs <legacy.json> --password <8+ chars> \
//        [--out <dir>] [--current-month 2026-10] [--past summary|detail|skip] \
//        [--logo-smoke] [--kdf-min]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import initSqlJs from 'sql.js';
import { preparePlan, buildFromPlan, backupFileName } from '../src/pipeline.mjs';
import { buildReport } from '../src/report.mjs';
import { readBackupFile } from '../src/backup.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

function argValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const input = args.find((arg) => !arg.startsWith('--') && !['summary', 'detail', 'skip'].includes(arg));
  const password = argValue(args, '--password');
  if (!input || !password) {
    console.error('usage: run-migration.mjs <legacy.json> --password <8+ chars> [--out DIR] [--current-month YYYY-MM] [--past summary|detail|skip]');
    process.exit(2);
  }
  const outDir = resolve(argValue(args, '--out', join(process.cwd(), 'migration-out')));
  mkdirSync(outDir, { recursive: true });

  const SQL = await initSqlJs({
    wasmBinary: readFileSync(join(here, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')),
  });

  const text = readFileSync(resolve(input), 'utf8');
  const prepared = preparePlan(text, {
    currentMonth: argValue(args, '--current-month', undefined),
    pastMode: argValue(args, '--past', 'summary'),
  });
  if (!prepared.ok) {
    console.error('could not read the legacy backup:', prepared.problems);
    process.exit(1);
  }

  writeFileSync(join(outDir, 'migration-package.json'), JSON.stringify(prepared.plan, null, 2), 'utf8');

  const result = buildFromPlan({
    SQL,
    plan: prepared.plan,
    password,
    now: Date.now(),
    kdf: args.includes('--kdf-min') ? { memoryKib: 8192, iterations: 1, parallelism: 1 } : undefined,
  });
  if (!result.ok) {
    const errors = result.findings.filter((finding) => finding.level === 'error');
    console.error('the plan has errors:', errors);
    process.exit(1);
  }

  const dbPath = join(outDir, 'shop.db');
  writeFileSync(dbPath, Buffer.from(result.dbBytes));
  const backupName = backupFileName(prepared.plan.settings.shopName);
  writeFileSync(join(outDir, backupName), Buffer.from(result.bytes));

  const reread = readBackupFile(Buffer.from(result.bytes), password);
  const report = buildReport({
    plan: prepared.plan,
    legacy: prepared.legacy,
    result,
    manifest: reread.manifest,
    backupName,
    passwordLength: password.length,
  });
  writeFileSync(join(outDir, 'migration-report.md'), report, 'utf8');

  console.log(JSON.stringify({
    ok: true,
    outDir,
    backup: join(outDir, backupName),
    database: dbPath,
    bytes: result.bytes.length,
    stats: result.stats,
    totals: result.totals,
    findings: result.findings.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
