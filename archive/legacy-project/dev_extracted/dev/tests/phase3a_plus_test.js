const vm = require('vm');
const fs = require('fs');
const { buildSandbox } = require('./dom-stub');

function extractJS(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return scripts.join('\n');
}

async function run() {
  const PROD_JS = extractJS('/home/claude/dist/index.html');
  const sandbox = buildSandbox();
  const ctx = vm.createContext(sandbox);
  vm.runInContext(PROD_JS, ctx);
  vm.runInContext('loadAll(); loadData();', ctx);

  const results = {};
  const errors = [];
  async function step(name, body) {
    try {
      const fn = vm.runInContext(`(async function(){\n${body}\n})`, ctx, { filename: name });
      results[name] = await fn();
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }

  await step('seed', `
    data.acc.push({name:'كفر', mainCat:'اكسسوار', buy:20, sell:50, profit:30, time:ts()});
    inventory.push({id:'ph1', brand:'Samsung', model:'A54', ram:'8GB', storage:'128GB', color:'', internalCode:'', qty:5, buyPrice:5000, supplier:'', notes:'', addedDate:td(), lastBuyDate:td(), purchaseHistory:[]});
    save(); saveInventory();
    return 'seeded';
  `);

  // ── 1) Migration framework exists and behaves correctly for current + unknown versions ──
  await step('migration_framework_current_version_passthrough', `
    const result = await createSecureBackup(null);
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    // current version should validate with zero migration needed
    const v = await validateBackupObject(fileObj, null);
    return { ok: v.ok, registryExists: typeof MSHOP_BACKUP_MIGRATIONS === 'object', migrateFnExists: typeof migrateBackupData === 'function' };
  `);

  await step('migration_framework_rejects_unknown_old_version', `
    const result = await createSecureBackup(null);
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    fileObj.meta.backupFormatVersion = 0; // simulate an old version with no registered migration
    const v = await validateBackupObject(fileObj, null);
    return { ok: v.ok, hasReason: !!v.reason };
  `);

  await step('migration_framework_applies_registered_migration', `
    // Temporarily register a fake migration 0 -> 1 to prove the framework actually runs migrations
    MSHOP_BACKUP_MIGRATIONS[0] = (data, meta) => ({ data: {...data, __migrated_marker: true}, meta: {} });
    const result = await createSecureBackup(null);
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    fileObj.meta.backupFormatVersion = 0;
    const v = await validateBackupObject(fileObj, null);
    delete MSHOP_BACKUP_MIGRATIONS[0]; // cleanup
    return { ok: v.ok, markerApplied: v.data && v.data.__migrated_marker === true };
  `);

  // ── 2) Restore lock overlay + save() guard ──
  await step('restore_lock_blocks_save_and_shows_overlay', `
    const overlay = document.getElementById('restore-lock-overlay');
    overlay.style.display = 'none'; // matches the real HTML's initial inline style (dom-stub doesn't parse HTML attributes)
    const beforeLockDisplay = overlay.style.display;
    lockAppForRestore(true);
    const duringLockDisplay = overlay.style.display;
    const dataBefore = JSON.stringify(data);
    save(); // should be a no-op while locked
    // Force-write something different to prove save() didn't persist it
    data.acc.push({name:'DURING_LOCK_TEST', mainCat:'x', buy:1, sell:1, profit:0, time:ts()});
    save();
    const persisted = Storage.get(DK());
    const savedWhileLocked = persisted.acc.some(a=>a.name==='DURING_LOCK_TEST');
    lockAppForRestore(false);
    const afterUnlockDisplay = overlay.style.display;
    data.acc.pop(); // cleanup in-memory
    return { beforeLockDisplay, duringLockDisplay, afterUnlockDisplay, savedWhileLocked };
  `);

  // ── 3) Automatic emergency backup created before restore, and manually restorable ──
  await step('emergency_backup_created_before_restore', `
    const backupResult = await createSecureBackup('emergpass');
    const text = await backupResult.blob.text();
    const fakeFile = new File([text], backupResult.fname, {type:'application/octet-stream'});

    const hadEmergencyBefore = !!Storage.get('mshop_emergency_backup');
    await restoreSecureBackup(fakeFile, 'emergpass');
    const emergencyAfter = Storage.get('mshop_emergency_backup');
    return { hadEmergencyBefore, emergencyCreatedAfterRestore: !!emergencyAfter, hasBackupId: !!emergencyAfter?.backupId };
  `);

  await step('manual_emergency_restore_works', `
    // emergency backup should exist from the previous step
    const before = Storage.get('mshop_emergency_backup');
    // mutate current data so we can verify restore brings back the emergency snapshot's state
    data.acc.push({name:'MUTATED_AFTER_EMERGENCY', mainCat:'x', buy:1,sell:1,profit:0,time:ts()});
    save();
    await restoreEmergencyBackup();
    const accNamesAfter = data.acc.map(a=>a.name);
    return { emergencyExisted: !!before, mutatedItemGoneAfterRestore: !accNamesAfter.includes('MUTATED_AFTER_EMERGENCY') };
  `);

  // ── 4) Backup summary dialog shows correct info before share/download ──
  await step('backup_summary_dialog_shows_correct_metadata', `
    const result = await createSecureBackup('summarytest');
    const dialogPromise = showBackupSummaryDialog(result);
    const modalDisplay = document.getElementById('modal-backup-summary').style.display;
    const content = document.getElementById('backup-summary-content').innerHTML;
    backupSummaryAction(true); // simulate user clicking "proceed"
    const proceed = await dialogPromise;
    return {
      modalWasShown: modalDisplay === 'flex',
      containsDate: content.includes(result.meta.date),
      containsBackupId: content.includes(result.meta.backupId),
      containsEncryptedLabel: content.includes('مشفّرة'),
      proceedResolvedTrue: proceed === true
    };
  `);

  await step('backup_summary_dialog_cancel_returns_false', `
    const result = await createSecureBackup(null);
    const dialogPromise = showBackupSummaryDialog(result);
    backupSummaryAction(false); // simulate user clicking "cancel"
    const proceed = await dialogPromise;
    return { proceedResolvedFalse: proceed === false };
  `);

  // ── 5) Encryption default messaging: empty password triggers explicit confirm ──
  await step('empty_password_requires_explicit_confirm', `
    let confirmCalled = false;
    let confirmMessage = '';
    const origConfirm = globalThis.confirm;
    globalThis.confirm = (msg) => { confirmCalled = true; confirmMessage = msg; return false; }; // simulate user declining to proceed unencrypted
    document.getElementById('backup-password-inp').value = ''; // no password
    await doCreateSecureBackup();
    globalThis.confirm = origConfirm;
    return { confirmCalled, mentionsEncryptionRecommended: confirmMessage.includes('موصى') };
  `);

  await step('password_provided_skips_extra_confirm_prompt', `
    let confirmCallCount = 0;
    const origConfirm = globalThis.confirm;
    globalThis.confirm = (msg) => { confirmCallCount++; return true; };
    document.getElementById('backup-password-inp').value = 'hasapassword';
    // Stub share/download + summary dialog auto-accept to isolate just the encryption-confirm behavior
    const origSummary = showBackupSummaryDialog;
    globalThis.showBackupSummaryDialog = async () => false; // cancel after summary to avoid actual share/download side effects
    await doCreateSecureBackup();
    globalThis.showBackupSummaryDialog = origSummary;
    globalThis.confirm = origConfirm;
    return { confirmCallCount }; // should be 0 extra confirms for the "no password" warning specifically
  `);

  return { results, errors };
}

run().then(({results, errors}) => {
  console.log('=== PHASE 3A+ IMPROVEMENTS TEST SUITE ===\n');
  console.log('Errors:', errors.length ? errors : 'none');
  console.log('\n--- Results ---');
  for (const [name, val] of Object.entries(results)) console.log(`${name}:`, JSON.stringify(val));

  console.log('\n--- Verdicts ---');
  console.log('1a. Migration registry & function exist:', results.migration_framework_current_version_passthrough?.registryExists && results.migration_framework_current_version_passthrough?.migrateFnExists);
  console.log('1b. Current version validates without migration:', results.migration_framework_current_version_passthrough?.ok === true);
  console.log('1c. Unknown old version (no migration path) rejected:', results.migration_framework_rejects_unknown_old_version?.ok === false);
  console.log('1d. Registered migration actually runs and transforms data:', results.migration_framework_applies_registered_migration?.markerApplied === true);
  console.log('2a. Overlay hidden before lock:', results.restore_lock_blocks_save_and_shows_overlay?.beforeLockDisplay === 'none');
  console.log('2b. Overlay visible during lock:', results.restore_lock_blocks_save_and_shows_overlay?.duringLockDisplay === 'flex');
  console.log('2c. Overlay hidden after unlock:', results.restore_lock_blocks_save_and_shows_overlay?.afterUnlockDisplay === 'none');
  console.log('2d. save() is blocked while locked:', results.restore_lock_blocks_save_and_shows_overlay?.savedWhileLocked === false);
  console.log('3a. Emergency backup auto-created before restore:', results.emergency_backup_created_before_restore?.emergencyCreatedAfterRestore === true);
  console.log('3b. Manual emergency-backup restore works:', results.manual_emergency_restore_works?.mutatedItemGoneAfterRestore === true);
  console.log('4a. Summary dialog shown with correct metadata:', results.backup_summary_dialog_shows_correct_metadata?.modalWasShown && results.backup_summary_dialog_shows_correct_metadata?.containsDate && results.backup_summary_dialog_shows_correct_metadata?.containsBackupId);
  console.log('4b. Summary dialog "proceed" resolves true:', results.backup_summary_dialog_shows_correct_metadata?.proceedResolvedTrue === true);
  console.log('4c. Summary dialog "cancel" resolves false:', results.backup_summary_dialog_cancel_returns_false?.proceedResolvedFalse === true);
  console.log('5a. Empty password triggers explicit recommended-encryption confirm:', results.empty_password_requires_explicit_confirm?.confirmCalled === true && results.empty_password_requires_explicit_confirm?.mentionsEncryptionRecommended === true);
}).catch(e => { console.error('FATAL:', e); process.exit(1); });
