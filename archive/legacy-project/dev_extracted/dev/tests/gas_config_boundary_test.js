'use strict';
// gas_config_boundary_test.js — Phase 3 (security remediation).
//
// Proves the GAS endpoint configuration boundary:
//   1. app_config.js exists and is the SINGLE definition site (placeholder only).
//   2. app.js / sync.js contain no GAS endpoint literal.
//   3. sync.js reads the endpoint through APP_CONFIG (boundary actually used).
//   4. index.html loads app_config.js before sync.js and app.js.
//   5. Missing/empty configuration fails CLOSED (no fetch, clear error) —
//      the app never silently sends shop data elsewhere.
//   6. Built dist output (when present) contains no endpoint literal.
//
// Convention: plain node (vm + dom-stub), step() harness, exit(1) on failure.
// The literal below is the HOST fragment only (never a credential value).

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');
const { buildSandbox } = require('./dom-stub');

const JS_DIR    = path.join(__dirname, '..', 'js');
const INDEX     = path.join(__dirname, '..', 'index.html');
const DIST      = path.join(__dirname, '..', '..', 'dist', 'index.html');
const HOST_FRAG = 'script.google.com';
const PATH_FRAG = 'macros/s/';

const read = (f) => fs.readFileSync(path.join(JS_DIR, f), 'utf-8');
const results = {};
const errors  = [];

async function step(id, fn) {
  try { await fn(); results[id] = 'PASS'; }
  catch (e) { results[id] = 'FAIL: ' + e.message; errors.push(id + ': ' + e.message); }
}

async function run() {

  await step('CFG-T1-config-file-exists', () => {
    if (!fs.existsSync(path.join(JS_DIR, 'app_config.js')))
      throw new Error('js/app_config.js missing — no configuration boundary');
  });

  await step('CFG-T2-placeholder-contract', () => {
    const src = read('app_config.js');
    if (!/APP_CONFIG/.test(src)) throw new Error('APP_CONFIG not defined');
    if (!/GAS_URL/.test(src)) throw new Error('APP_CONFIG has no GAS_URL key');
    if (src.includes(HOST_FRAG) || src.includes(PATH_FRAG))
      throw new Error('app_config.js contains an endpoint literal — must be placeholder only');
  });

  await step('CFG-T3-no-literal-in-app-js', () => {
    const src = read('app.js');
    if (src.includes(HOST_FRAG) || src.includes(PATH_FRAG))
      throw new Error('app.js still contains a GAS endpoint literal');
  });

  await step('CFG-T4-no-literal-in-sync-js', () => {
    const src = read('sync.js');
    if (src.includes(HOST_FRAG) || src.includes(PATH_FRAG))
      throw new Error('sync.js still contains a GAS endpoint literal');
    // Boundary usage = the app_config.js accessor (single definition site).
    if (!/_getGasUrl\(\)/.test(src))
      throw new Error('sync.js does not read the endpoint through the app_config.js boundary');
  });

  await step('CFG-T5-load-order', () => {
    const html = fs.readFileSync(INDEX, 'utf-8');
    const pos = (name) => html.indexOf(`<script src="js/${name}"></script>`);
    const c = pos('app_config.js'), s = pos('sync.js'), a = pos('app.js');
    if (c === -1) throw new Error('index.html does not load js/app_config.js');
    if (s === -1 || a === -1) throw new Error('index.html lost sync.js/app.js tags');
    if (!(c < s && c < a)) throw new Error('app_config.js must load before sync.js and app.js');
  });

  await step('CFG-T6-missing-config-fails-closed', async () => {
    const sandbox = buildSandbox();
    let fetchCalls = 0;
    sandbox.fetch = async () => { fetchCalls++; return { text: async () => 'ok' }; };
    const ctx = vm.createContext(sandbox);
    // Empty/placeholder config + the real Drive functions.
    vm.runInContext(read('app_config.js'), ctx);
    vm.runInContext(read('helpers.js'), ctx);
    vm.runInContext(read('storage.js'), ctx);
    vm.runInContext(read('sync.js'), ctx);
    // Capture toasts; showToast is a plain global lookup at call time.
    vm.runInContext('var __toasts = []; showToast = function(m,t){ __toasts.push([String(m),String(t)]); };', ctx);
    await vm.runInContext('(async()=>{ await uploadToDrive(); })()', ctx);
    if (fetchCalls !== 0)
      throw new Error(`uploadToDrive performed ${fetchCalls} fetch call(s) with no endpoint configured`);
    const errs = vm.runInContext('__toasts.filter(t=>t[1]==="err").length', ctx);
    if (errs < 1) throw new Error('no visible error toast when endpoint is unconfigured');
    // downloadFromDrive must also refuse before touching the network/DOM.
    const created = vm.runInContext('var __created=[]; document.createElement=function(t){__created.push(t);}; 0', ctx);
    void created;
    vm.runInContext('downloadFromDrive()', ctx);
    const nTags = vm.runInContext('__created.length', ctx);
    if (nTags !== 0) throw new Error('downloadFromDrive created DOM elements with no endpoint configured');
  });

  await step('CFG-T7-dist-has-no-literal', () => {
    if (!fs.existsSync(DIST)) return; // no build artifact yet — nothing to check
    const html = fs.readFileSync(DIST, 'utf-8');
    if (html.includes(HOST_FRAG) || html.includes(PATH_FRAG))
      throw new Error('dist/index.html contains a GAS endpoint literal');
  });

  const pass  = Object.values(results).filter((v) => v === 'PASS').length;
  const total = Object.keys(results).length;
  console.log('\n== GAS config boundary tests ==');
  Object.entries(results).forEach(([k, v]) => console.log(`  [${v === 'PASS' ? '✓' : '✗'}] ${k}: ${v}`));
  console.log(`\n${pass}/${total} passed`);
  if (errors.length) { console.error('\nFailed:'); errors.forEach((e) => console.error('  ✗', e)); process.exit(1); }
}

run().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
