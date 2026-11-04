#!/usr/bin/env node
// Generates `src/migrations.generated.mjs` from the application's real
// migrations, so the standalone tool builds the *same* schema the app builds.
//
// The generated module is committed: the tool must work with no build step and
// no repository around it once the single HTML file is produced.
//
// Usage: node scripts/gen-migrations.mjs

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const migrationsDir = join(repo, 'src-tauri', 'src', 'data', 'migrations');
const outFile = join(here, '..', 'src', 'migrations.generated.mjs');

const files = readdirSync(migrationsDir)
  .filter((name) => /^\d+_.*\.sql$/.test(name))
  .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));

if (files.length === 0) {
  throw new Error(`no migrations found in ${migrationsDir}`);
}

const entries = files.map((name) => {
  const sql = readFileSync(join(migrationsDir, name), 'utf8');
  const [, version, description] = name.match(/^(\d+)_(.*)\.sql$/);
  return { file: name, version: Number(version), description, sql };
});

const body = `// GENERATED FILE — do not edit by hand.
// Source: src-tauri/src/data/migrations/*.sql
// Regenerate: node tools/legacy-migration/scripts/gen-migrations.mjs
//
// The tool applies these exact migrations and writes the matching
// \`_sqlx_migrations\` rows, so the new system opens the produced shop.db without
// re-running a migration (SQLx refuses a checksum mismatch).

export const MIGRATIONS = ${JSON.stringify(entries, null, 2)};
`;

writeFileSync(outFile, body, 'utf8');
console.log(`wrote ${files.length} migrations -> ${outFile}`);
