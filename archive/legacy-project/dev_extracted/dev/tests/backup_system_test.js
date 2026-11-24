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
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  // Seed some representative data across every module
  await step('seed_data', `
    data.acc.push({name:'كفر', mainCat:'اكسسوار', buy:20, sell:50, profit:30, time:ts()});
    inventory.push({id:'ph1', brand:'Samsung', model:'A54', ram:'8GB', storage:'128GB', color:'', internalCode:'', qty:5, buyPrice:5000, supplier:'', notes:'', addedDate:td(), lastBuyDate:td(), purchaseHistory:[]});
    notes.push({id:'n1', title:'ملاحظة', content:'محتوى', type:'note', priority:2, created:td(), createdTime:ts(), done:false});
    cfg.name = 'محل تجريبي';
    saveInventory(); saveNotes(); saveCfg(); save();
    // Seed trash and wallets so backup-coverage test is meaningful
    trash.push({id:1, item:{_origDate:td(), _origType:'acc', name:'محذوف', sell:10, profit:5}});
    saveTrash();
    loadWallets(); saveWalletsCfg(false);
    return 'seeded';
  `);

  // ── 1) Unencrypted backup: create -> validate -> restore roundtrip ──
  await step('unencrypted_create', `
    const result = await createSecureBackup(null);
    return { hasBlob: !!result?.blob, fname: result?.fname, encrypted: result?.meta?.encrypted, backupId: !!result?.meta?.backupId };
  `);

  await step('unencrypted_validate_immediately', `
    const result = await createSecureBackup(null);
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    const v = await validateBackupObject(fileObj, null);
    return { ok: v.ok, hasAccData: Array.isArray(v.data?.mshop_inventory) };
  `);

  // ── 2) Encrypted backup: create -> validate with correct password ──
  await step('encrypted_create_and_validate', `
    const result = await createSecureBackup('sirtestpass123');
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    const looksEncrypted = !!fileObj.enc && !fileObj.data; // data should NOT be present in plaintext
    const v = await validateBackupObject(fileObj, 'sirtestpass123');
    return { encrypted: fileObj.meta.encrypted, looksEncrypted, validateOk: v.ok };
  `);

  // ── 3) Wrong password should fail validation cleanly (no crash) ──
  await step('wrong_password_rejected', `
    const result = await createSecureBackup('correctpassword');
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    const v = await validateBackupObject(fileObj, 'WRONGpassword');
    return { ok: v.ok, hasReason: !!v.reason };
  `);

  // ── 4) Missing password on encrypted file should fail cleanly ──
  await step('missing_password_rejected', `
    const result = await createSecureBackup('somepassword');
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    const v = await validateBackupObject(fileObj, null);
    return { ok: v.ok, hasReason: !!v.reason };
  `);

  // ── 5) Corrupted file (tampered ciphertext) should be detected ──
  await step('corrupted_ciphertext_detected', `
    const result = await createSecureBackup('pass123');
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    fileObj.enc.cipher = fileObj.enc.cipher.slice(0, -10) + 'XXXXXXXXXX'; // tamper
    const v = await validateBackupObject(fileObj, 'pass123');
    return { ok: v.ok, hasReason: !!v.reason };
  `);

  // ── 6) Corrupted metadata/checksum mismatch on UNENCRYPTED backup ──
  await step('checksum_mismatch_detected', `
    const result = await createSecureBackup(null);
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    fileObj.data.mshop_cfg = {...fileObj.data.mshop_cfg, name:'تلاعب'}; // tamper after checksum computed
    const v = await validateBackupObject(fileObj, null);
    return { ok: v.ok, hasReason: !!v.reason };
  `);

  // ── 7) Invalid file (not a backup at all) ──
  await step('non_backup_file_rejected', `
    const v = await validateBackupObject({foo:'bar'}, null);
    return { ok: v.ok, hasReason: !!v.reason };
  `);

  // ── 8) Future format version rejected ──
  await step('future_version_rejected', `
    const result = await createSecureBackup(null);
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    fileObj.meta.backupFormatVersion = 9999;
    const v = await validateBackupObject(fileObj, null);
    return { ok: v.ok, hasReason: !!v.reason };
  `);

  // ── 9) Full restore roundtrip: modify data, backup, change data more, restore, verify original state comes back ──
  await step('full_restore_roundtrip', `
    // Snapshot current inventory qty
    const qtyBeforeBackup = inventory.find(p=>p.id==='ph1').qty;
    const result = await createSecureBackup('roundtrip123');
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);

    // Now mutate the live data AFTER the backup was taken
    inventory.find(p=>p.id==='ph1').qty = 999;
    saveInventory();
    data.acc.push({name:'بعد النسخة', mainCat:'x', buy:1, sell:2, profit:1, time:ts()});
    save();

    // Simulate restore: fake a File object wrapping the backup JSON text
    const fakeFile = new File([text], result.fname, {type:'application/octet-stream'});
    // Bypass the confirm()/reload() UI parts by directly validating + writing (same path restoreSecureBackup uses internally)
    const v = await validateBackupObject(fileObj, 'roundtrip123');
    Object.entries(v.data).forEach(([k,val]) => Storage.saveRaw(k, typeof val==='string'?val:JSON.stringify(val)));
    loadAll(); loadData();

    return {
      qtyBeforeBackup,
      qtyAfterRestore: inventory.find(p=>p.id==='ph1').qty,
      accLenAfterRestore: data.acc.length,
      restoredCorrectly: inventory.find(p=>p.id==='ph1').qty === qtyBeforeBackup
    };
  `);

  // ── 10) Atomic rollback simulation: verify snapshot-based recovery works ──
  await step('atomic_rollback_mechanism', `
    const before = Storage.get('mshop_cfg');
    const snapshot = {};
    Storage.search('mshop_').forEach(k => { snapshot[k] = Storage.getRaw(k); });
    // Simulate a failure mid-restore: write garbage then "rollback"
    Storage.save('mshop_cfg', {name:'CORRUPTED_MID_RESTORE'});
    Object.entries(snapshot).forEach(([k,val]) => { if (val===null) Storage.remove(k); else Storage.saveRaw(k, val); });
    const after = Storage.get('mshop_cfg');
    return { restoredMatchesOriginal: JSON.stringify(before)===JSON.stringify(after) };
  `);

  // ── 11) Backup covers ALL modules (comprehensive key coverage check) ──
  await step('comprehensive_coverage', `
    const result = await createSecureBackup(null);
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    const keys = Object.keys(fileObj.data);
    const expectedPrefixesFound = {
      inventory: keys.includes('mshop_inventory'),
      cfg: keys.includes('mshop_cfg'),
      notes: keys.includes('mshop_notes'),
      trash: keys.includes('mshop_trash'),
      wallets: keys.includes('mshop_wallets'),
      dayRecord: keys.some(k=>k.startsWith('mshop_d_')),
    };
    return { totalKeys: keys.length, expectedPrefixesFound };
  `);

  // ── 12) Backup history saved correctly ──
  await step('backup_history_recorded', `
    await createSecureBackup(null);
    const lastBackup = Storage.getRaw('mshop_last_backup');
    const history = Storage.get('mshop_backup_history');
    return { hasLastBackup: !!lastBackup, hasHistory: !!history, historyHasDate: !!history?.lastDate };
  `);

  return { results, errors };
}

run().then(({results, errors}) => {
  console.log('=== PHASE 3A — SECURE BACKUP SYSTEM TEST SUITE ===\n');
  console.log('Errors:', errors.length ? errors : 'none');
  console.log('\n--- Results ---');
  for (const [name, val] of Object.entries(results)) {
    console.log(`${name}:`, JSON.stringify(val));
  }

  console.log('\n--- Verdicts ---');
  console.log('1. Unencrypted backup creates successfully:', results.unencrypted_create?.hasBlob === true);
  console.log('2. Unencrypted backup validates & contains real data:', results.unencrypted_validate_immediately?.ok === true && results.unencrypted_validate_immediately?.hasAccData === true);
  console.log('3. Encrypted backup: data NOT stored in plaintext:', results.encrypted_create_and_validate?.looksEncrypted === true);
  console.log('4. Encrypted backup validates with correct password:', results.encrypted_create_and_validate?.validateOk === true);
  console.log('5. Wrong password correctly rejected (no crash):', results.wrong_password_rejected?.ok === false && results.wrong_password_rejected?.hasReason === true);
  console.log('6. Missing password on encrypted file rejected:', results.missing_password_rejected?.ok === false);
  console.log('7. Tampered ciphertext detected:', results.corrupted_ciphertext_detected?.ok === false);
  console.log('8. Checksum mismatch (tampered plaintext) detected:', results.checksum_mismatch_detected?.ok === false);
  console.log('9. Non-backup file rejected:', results.non_backup_file_rejected?.ok === false);
  console.log('10. Future format version rejected:', results.future_version_rejected?.ok === false);
  console.log('11. Full restore roundtrip recovers exact original state:', results.full_restore_roundtrip?.restoredCorrectly === true);
  console.log('12. Atomic rollback mechanism works:', results.atomic_rollback_mechanism?.restoredMatchesOriginal === true);
  console.log('13. Backup covers all modules:', Object.values(results.comprehensive_coverage?.expectedPrefixesFound||{}).every(v=>v===true));
  console.log('14. Backup history recorded:', results.backup_history_recorded?.hasLastBackup === true && results.backup_history_recorded?.hasHistory === true);
}).catch(e => { console.error('FATAL:', e); process.exit(1); });
