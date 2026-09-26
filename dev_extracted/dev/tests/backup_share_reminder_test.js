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

  // ── Scenario A: Mobile with Web Share API available ──
  const sandboxA = buildSandbox();
  sandboxA.navigator.share = async (opts) => { sandboxA.__sharedWith = opts; return true; };
  sandboxA.navigator.canShare = (opts) => true;
  const ctxA = vm.createContext(sandboxA);
  vm.runInContext(PROD_JS, ctxA);
  vm.runInContext('loadAll(); loadData();', ctxA);
  const resultA = await vm.runInContext(`(async function(){
    const blob = new Blob(['test content'], {type:'application/octet-stream'});
    const how = await shareOrDownloadBackup(blob, 'test.mshop');
    return { how, sharedCalled: !!globalThis.__sharedWith, sharedFileName: globalThis.__sharedWith?.files?.[0]?.name };
  })()`, ctxA);

  // ── Scenario B: Desktop, no Web Share API ──
  const sandboxB = buildSandbox();
  sandboxB.navigator.share = undefined;
  sandboxB.navigator.canShare = undefined;
  let downloadTriggered = false;
  const ctxB = vm.createContext(sandboxB);
  vm.runInContext(PROD_JS, ctxB);
  vm.runInContext('loadAll(); loadData();', ctxB);
  // Track if an <a> element gets .click() called (simulating download trigger)
  vm.runInContext(`
    const origCreateElement = document.createElement.bind(document);
    document.createElement = function(tag) {
      const el = origCreateElement(tag);
      if (tag === 'a') { const origClick = el.click; el.click = function(){ globalThis.__downloadClicked = true; }; }
      return el;
    };
    globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  `, ctxB);
  const resultB = await vm.runInContext(`(async function(){
    const blob = new Blob(['test content'], {type:'application/octet-stream'});
    const how = await shareOrDownloadBackup(blob, 'test.mshop');
    return { how, downloadClicked: !!globalThis.__downloadClicked };
  })()`, ctxB);

  // ── Scenario C: Share API present but user cancels (throws) -> should fall back to download ──
  const sandboxC = buildSandbox();
  sandboxC.navigator.share = async () => { throw new Error('AbortError: user cancelled'); };
  sandboxC.navigator.canShare = () => true;
  const ctxC = vm.createContext(sandboxC);
  vm.runInContext(PROD_JS, ctxC);
  vm.runInContext('loadAll(); loadData();', ctxC);
  vm.runInContext(`
    const origCreateElement = document.createElement.bind(document);
    document.createElement = function(tag) {
      const el = origCreateElement(tag);
      if (tag === 'a') { el.click = function(){ globalThis.__downloadClicked = true; }; }
      return el;
    };
    globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  `, ctxC);
  const resultC = await vm.runInContext(`(async function(){
    const blob = new Blob(['test'], {type:'application/octet-stream'});
    const how = await shareOrDownloadBackup(blob, 'test.mshop');
    return { how, downloadClicked: !!globalThis.__downloadClicked };
  })()`, ctxC);

  // ── Scenario D: Daily reminder logic ──
  const sandboxD = buildSandbox();
  const ctxD = vm.createContext(sandboxD);
  vm.runInContext(PROD_JS, ctxD);
  vm.runInContext('loadAll(); loadData();', ctxD);
  const resultD = await vm.runInContext(`(function(){
    const out = {};
    // Case 1: never backed up -> should show popup
    checkBackupReminder();
    out.firstCallShowsModal = document.getElementById('modal-backup-reminder').style.display === 'flex';
    // Case 2: calling again same day -> should NOT show again (already shown today)
    document.getElementById('modal-backup-reminder').style.display = 'none';
    checkBackupReminder();
    out.secondCallSameDaySkipped = document.getElementById('modal-backup-reminder').style.display === 'none';
    // Case 3: dismiss forever -> should never show again
    Storage.saveRaw('mshop_backup_reminder_last_shown', ''); // reset so it would show if not dismissed
    backupReminderAction('dismiss');
    checkBackupReminder();
    out.dismissedStaysHidden = document.getElementById('modal-backup-reminder').style.display === 'none';
    return out;
  })()`, ctxD);

  const sandboxE = buildSandbox();
  const ctxE = vm.createContext(sandboxE);
  vm.runInContext(PROD_JS, ctxE);
  vm.runInContext('loadAll(); loadData();', ctxE);
  const resultE = await vm.runInContext(`(function(){
    // Snooze case: "remind later" should hide for a few hours, not show immediately again
    Storage.saveRaw('mshop_backup_reminder_last_shown', '');
    backupReminderAction('later');
    checkBackupReminder();
    return { snoozedStaysHidden: document.getElementById('modal-backup-reminder').style.display !== 'flex' };
  })()`, ctxE);

  const sandboxF = buildSandbox();
  const ctxF = vm.createContext(sandboxF);
  vm.runInContext(PROD_JS, ctxF);
  vm.runInContext('loadAll(); loadData();', ctxF);
  const resultF = await vm.runInContext(`(function(){
    // If backup was already made today, should not show at all
    Storage.saveRaw('mshop_last_backup', td()+' '+ts());
    checkBackupReminder();
    return { noPromptIfBackedUpToday: document.getElementById('modal-backup-reminder').style.display !== 'flex' };
  })()`, ctxF);

  return { resultA, resultB, resultC, resultD, resultE, resultF };
}

run().then(r => {
  console.log('=== SHARE / DOWNLOAD / REMINDER TEST ===\n');
  console.log('A (mobile share available):', JSON.stringify(r.resultA));
  console.log('B (desktop, no share API):', JSON.stringify(r.resultB));
  console.log('C (share throws -> fallback):', JSON.stringify(r.resultC));
  console.log('D (reminder logic):', JSON.stringify(r.resultD));
  console.log('E (snooze):', JSON.stringify(r.resultE));
  console.log('F (already backed up today):', JSON.stringify(r.resultF));

  console.log('\n--- Verdicts ---');
  console.log('Mobile: uses Web Share API when available:', r.resultA.how === 'shared' && r.resultA.sharedCalled === true && r.resultA.sharedFileName === 'test.mshop');
  console.log('Desktop: auto-downloads when Share API absent:', r.resultB.how === 'downloaded' && r.resultB.downloadClicked === true);
  console.log('Share cancelled/failed falls back to download:', r.resultC.how === 'downloaded' && r.resultC.downloadClicked === true);
  console.log('Reminder shows on first check (never backed up):', r.resultD.firstCallShowsModal === true);
  console.log('Reminder does not repeat same day:', r.resultD.secondCallSameDaySkipped === true);
  console.log('Dismiss forever works:', r.resultD.dismissedStaysHidden === true);
  console.log('Snooze (remind later) hides temporarily:', r.resultE.snoozedStaysHidden === true);
  console.log('No prompt if already backed up today:', r.resultF.noPromptIfBackedUpToday === true);
}).catch(e => { console.error('FATAL:', e); process.exit(1); });
