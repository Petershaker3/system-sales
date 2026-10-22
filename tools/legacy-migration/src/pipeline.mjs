// One run of the tool, from a legacy backup to a new-system backup.
//
// Kept separate from both the screen and the command line so the tests exercise
// exactly what the owner's click does.

import { readLegacyBackup } from './legacy.mjs';
import { buildDefaultPlan, planTotals, validatePlan } from './plan.mjs';
import { buildShopDatabase } from './build-db.mjs';
import { buildBackupFile, readBackupFile } from './backup.mjs';

/**
 * Build a plan from raw legacy text.
 *
 * Returns the plan plus the reader's findings, so a screen can show
 * "this key was not recognised" before the owner starts editing.
 */
export function preparePlan(legacyText, options = {}) {
  const legacy = readLegacyBackup(legacyText);
  if (!legacy.ok) {
    return { ok: false, problems: legacy.problems };
  }
  const plan = buildDefaultPlan(legacy, options);
  return { ok: true, legacy, plan, problems: legacy.problems };
}

/**
 * Turn a (possibly edited) plan into bytes.
 *
 * `SQL` is sql.js. `serialize` is called with the final plan so the caller can
 * save exactly what was built — the package and the backup stay in step.
 */
export function buildFromPlan({ SQL, plan, password, logoJpeg = null, now = Date.now(), kdf }) {
  const validation = validatePlan(plan);
  const errors = validation.findings.filter((finding) => finding.level === 'error');
  if (errors.length) {
    return { ok: false, findings: validation.findings, reason: 'errors' };
  }
  const database = buildShopDatabase({ SQL, plan, logoJpeg, now });
  const images = logoJpeg && logoJpeg.length
    ? [{ path: 'images/shop-logo.jpg', bytes: logoJpeg }]
    : [];
  const backup = buildBackupFile({
    dbBytes: database.bytes,
    password,
    images,
    createdAt: now,
    ...(kdf ? { kdf } : {}),
  });
  // Read it back with the same password before handing it over: a file that the
  // tool cannot open is not a backup, and the owner must not find that out on the
  // day he needs it.
  const check = readBackupFile(backup.bytes, password);
  if (check.database.length !== database.bytes.length) {
    throw new Error('self-check failed: restored database length differs');
  }

  return {
    ok: true,
    bytes: backup.bytes,
    manifest: backup.manifest,
    dbBytes: database.bytes,
    stats: database.stats,
    findings: validation.findings,
    totals: planTotals(plan),
    includes: validation.includes,
    kdf: backup.kdf,
  };
}

/** A file name that survives Windows, Arabic included. */
export function backupFileName(shopName, date = new Date()) {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const safe = String(shopName || 'المحل')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'المحل';
  return `${safe}-ترحيل-${day}.msb1`;
}
