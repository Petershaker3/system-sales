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
    data.repairs.push({id:'r1', brand:'iPhone', model:'11', servicePrice:400, profit:150, status:'inProgress', time:ts()});
    inventory.push({id:'ph1', brand:'Samsung', model:'A54', ram:'8GB', storage:'128GB', color:'', internalCode:'', qty:5, buyPrice:5000, supplier:'', notes:'', addedDate:td(), lastBuyDate:td(), purchaseHistory:[]});
    notes.push({id:'n1', title:'x', content:'y', type:'note', priority:2, created:td(), createdTime:ts(), done:false});
    save(); saveInventory(); saveNotes(); saveCfg();
    return 'seeded';
  `);

  // ── 1) Enhanced metadata: record counts, UUID format, sync placeholders ──
  await step('enhanced_metadata', `
    const result = await createSecureBackup(null);
    const m = result.meta;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return {
      hasRecordCounts: !!m.recordCounts,
      accessoriesCounted: m.recordCounts.accessories >= 1,
      repairsCounted: m.recordCounts.repairs >= 1,
      notesCounted: m.recordCounts.notes >= 1,
      backupIdIsUUID: uuidPattern.test(m.backupId),
      hasApproxSize: m.approxSizeBytes > 0,
      hasDeviceId: !!m.deviceId,
      hasSyncPlaceholders: m.lastSyncTime === null && m.syncGeneration === 0,
      hasDate: !!m.date, hasTime: !!m.time, hasCreatedAt: !!m.createdAt,
      hasAppVersion: !!m.appVersion, hasBackupFormatVersion: !!m.backupFormatVersion,
      hasEncryptedFlag: m.encrypted === false, // no password given
    };
  `);

  // ── 2) Version compatibility: reject backup from a newer APP version (not just format version) ──
  await step('newer_app_version_rejected', `
    const result = await createSecureBackup(null);
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    fileObj.meta.appVersion = '99.0'; // simulate a much newer app version
    const v = await validateBackupObject(fileObj, null);
    return { ok: v.ok, hasReason: !!v.reason, mentionsNewerVersion: v.reason && v.reason.includes('أحدث') };
  `);

  await step('same_or_older_app_version_accepted', `
    const result = await createSecureBackup(null);
    const text = await result.blob.text();
    const fileObj = JSON.parse(text);
    fileObj.meta.appVersion = '0.9'; // older version, should still work (migration framework handles format differences)
    const v = await validateBackupObject(fileObj, null);
    return { ok: v.ok };
  `);

  // ── 3) Backup history: array capped at 10, tracks success AND failure ──
  await step('history_caps_at_10_entries', `
    for (let i=0;i<13;i++){ await createSecureBackup(null); }
    const history = Storage.get('mshop_backup_history_log');
    return { length: history.length, cappedAt10: history.length === 10, newestFirst: history[0].date===td() };
  `);

  await step('history_records_failure', `
    // Force the outer catch block by making gatherAllBackupData throw mid-operation
    const origSearch = Storage.search;
    Storage.search = () => { throw new Error('simulated storage failure'); };
    const result = await createSecureBackup(null);
    Storage.search = origSearch;
    const history = Storage.get('mshop_backup_history_log');
    return { creationFailed: result === null, historyTopEntryFailed: history[0].success === false };
  `);

  // ── 4) Storage capacity warning (non-blocking) ──
  await step('capacity_warning_shown_but_non_blocking', `
    let toastMessages = [];
    const origToast = showToast;
    globalThis.showToast = (msg, type) => { toastMessages.push(msg); };
    // Fill localStorage with a lot of data to cross the warning threshold
    for (let i=0;i<50;i++){
      Storage.save('mshop_bulkfill_'+i, 'x'.repeat(100000)); // ~100KB each => ~5MB
    }
    const result = await createSecureBackup(null);
    globalThis.showToast = origToast;
    // cleanup bulk keys
    for (let i=0;i<50;i++){ Storage.remove('mshop_bulkfill_'+i); }
    const warningShown = toastMessages.some(m => m.includes('مساحة') || m.includes('امتلاء'));
    return { warningShown, backupStillSucceeded: result !== null };
  `);

  await step('capacity_warning_not_shown_when_usage_low', `
    let toastMessages = [];
    const origToast = showToast;
    globalThis.showToast = (msg, type) => { toastMessages.push(msg); };
    const result = await createSecureBackup(null);
    globalThis.showToast = origToast;
    const warningShown = toastMessages.some(m => m.includes('مساحة') || m.includes('امتلاء'));
    return { warningShown, backupSucceeded: result !== null };
  `);

  // ── 5) Emergency backup deletion ──
  await step('delete_emergency_backup', `
    Storage.save('mshop_emergency_backup', {createdAt:new Date().toISOString(), backupId:'test', raw:'{}'});
    const existedBefore = Storage.exists('mshop_emergency_backup');
    deleteEmergencyBackup();
    const existsAfter = Storage.exists('mshop_emergency_backup');
    // verify other data untouched
    const otherDataIntact = Storage.exists('mshop_cfg') && Storage.exists('mshop_inventory');
    return { existedBefore, existsAfter, otherDataIntact };
  `);

  await step('delete_emergency_backup_when_none_exists', `
    Storage.remove('mshop_emergency_backup');
    let toastMsg = '';
    const origToast = showToast;
    globalThis.showToast = (msg) => { toastMsg = msg; };
    deleteEmergencyBackup();
    globalThis.showToast = origToast;
    return { noCrash: true, informativeMessage: toastMsg.includes('لا توجد') };
  `);

  // ── 7) Concurrent backup prevention ──
  await step('concurrent_backups_prevented', `
    let secondCallMessage = '';
    const origToast = showToast;
    globalThis.showToast = (msg) => { secondCallMessage = msg; };
    const p1 = createSecureBackup(null);
    const p2 = createSecureBackup(null); // should be ignored immediately since p1 is in-flight
    const [r1, r2] = await Promise.all([p1, p2]);
    globalThis.showToast = origToast;
    return {
      firstSucceeded: r1 !== null,
      secondRejected: r2 === null,
      messageIndicatesInProgress: secondCallMessage.includes('قيد الإنشاء')
    };
  `);

  await step('sequential_backups_both_succeed', `
    const r1 = await createSecureBackup(null);
    const r2 = await createSecureBackup(null);
    return { bothSucceeded: r1 !== null && r2 !== null };
  `);

  // ── 8) Progress indicator stages ──
  await step('progress_indicator_updates_during_backup', `
    document.getElementById('backup-create-progress-text').classList.add('backup-progress-indicator');
    const seenStages = [];
    const origUpdate = updateBackupProgress;
    globalThis.updateBackupProgress = (stage) => { if(stage) seenStages.push(stage); origUpdate(stage); };
    await createSecureBackup('progresstest');
    globalThis.updateBackupProgress = origUpdate;
    return {
      sawPreparing: seenStages.some(s=>s.includes('التحضير')),
      sawEncrypting: seenStages.some(s=>s.includes('التشفير')),
      sawFinalizing: seenStages.some(s=>s.includes('الإنهاء')),
      clearedAfterDone: document.getElementById('backup-create-progress-text').textContent === ''
    };
  `);

  await step('progress_indicator_updates_during_restore', `
    document.getElementById('restore-progress-text').classList.add('backup-progress-indicator');
    const backupResult = await createSecureBackup('restoreprogresstest');
    const text = await backupResult.blob.text();
    const fakeFile = new File([text], backupResult.fname, {type:'application/octet-stream'});
    const seenStages = [];
    const origUpdate = updateBackupProgress;
    globalThis.updateBackupProgress = (stage) => { if(stage) seenStages.push(stage); origUpdate(stage); };
    await restoreSecureBackup(fakeFile, 'restoreprogresstest');
    globalThis.updateBackupProgress = origUpdate;
    return {
      sawPreparing: seenStages.some(s=>s.includes('التحضير')),
      sawRestoring: seenStages.some(s=>s.includes('الاستعادة')),
      sawFinalizing: seenStages.some(s=>s.includes('الإنهاء'))
    };
  `);

  return { results, errors };
}

run().then(({results, errors}) => {
  console.log('=== PHASE 3A — ROUND 2 IMPROVEMENTS TEST SUITE ===\n');
  console.log('Errors:', errors.length ? errors : 'none');
  console.log('\n--- Results ---');
  for (const [name, val] of Object.entries(results)) console.log(`${name}:`, JSON.stringify(val));

  console.log('\n--- Verdicts ---');
  const em = results.enhanced_metadata || {};
  console.log('1a. Record counts present & correct:', em.hasRecordCounts && em.accessoriesCounted && em.repairsCounted && em.notesCounted);
  console.log('1b. Backup ID is proper UUID v4:', em.backupIdIsUUID === true);
  console.log('1c. Approx size, device, date/time/createdAt present:', em.hasApproxSize && em.hasDeviceId && em.hasDate && em.hasTime && em.hasCreatedAt);
  console.log('1d. App/format version present:', em.hasAppVersion && em.hasBackupFormatVersion);
  console.log('1e. Encryption status field correct:', em.hasEncryptedFlag === true);
  console.log('1f. Future sync placeholders present (unused):', em.hasSyncPlaceholders === true);
  console.log('2a. Newer app-version backup rejected:', results.newer_app_version_rejected?.ok === false && results.newer_app_version_rejected?.mentionsNewerVersion);
  console.log('2b. Older app-version backup still accepted (migration handles it):', results.same_or_older_app_version_accepted?.ok === true);
  console.log('3a. History capped at 10, newest first:', results.history_caps_at_10_entries?.cappedAt10 && results.history_caps_at_10_entries?.newestFirst);
  console.log('3b. Failed backup recorded as failure in history:', results.history_records_failure?.creationFailed && results.history_records_failure?.historyTopEntryFailed);
  console.log('4a. Capacity warning shown when usage high (non-blocking):', results.capacity_warning_shown_but_non_blocking?.warningShown && results.capacity_warning_shown_but_non_blocking?.backupStillSucceeded);
  console.log('4b. No warning when usage is normal:', results.capacity_warning_not_shown_when_usage_low?.warningShown === false && results.capacity_warning_not_shown_when_usage_low?.backupSucceeded);
  console.log('5a. Emergency backup deleted, others untouched:', results.delete_emergency_backup?.existedBefore && !results.delete_emergency_backup?.existsAfter && results.delete_emergency_backup?.otherDataIntact);
  console.log('5b. Deleting non-existent emergency backup handled gracefully:', results.delete_emergency_backup_when_none_exists?.noCrash && results.delete_emergency_backup_when_none_exists?.informativeMessage);
  console.log('7a. Concurrent backup calls: second ignored with message:', results.concurrent_backups_prevented?.firstSucceeded && results.concurrent_backups_prevented?.secondRejected && results.concurrent_backups_prevented?.messageIndicatesInProgress);
  console.log('7b. Sequential (non-overlapping) backups both succeed:', results.sequential_backups_both_succeed?.bothSucceeded === true);
  console.log('8a. Progress stages shown during backup creation:', results.progress_indicator_updates_during_backup?.sawPreparing && results.progress_indicator_updates_during_backup?.sawEncrypting && results.progress_indicator_updates_during_backup?.sawFinalizing);
  console.log('8b. Progress indicator cleared after completion:', results.progress_indicator_updates_during_backup?.clearedAfterDone === true);
  console.log('8c. Progress stages shown during restore:', results.progress_indicator_updates_during_restore?.sawPreparing && results.progress_indicator_updates_during_restore?.sawRestoring && results.progress_indicator_updates_during_restore?.sawFinalizing);
}).catch(e => { console.error('FATAL:', e); process.exit(1); });
