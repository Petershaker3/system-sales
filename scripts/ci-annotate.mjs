#!/usr/bin/env node
// Turn a build or test log into GitHub annotations.
//
// Why: the agent sessions that write this code can reach api.github.com but not
// the storage that holds raw Actions logs. Annotations are served by the API, so
// the result of every run (counts, failing tests, compiler errors) stays
// readable from the session: `gh api repos/OWNER/REPO/check-runs/JOB/annotations`.
//
// Usage: node scripts/ci-annotate.mjs <log-file> <label>
// Never fails the job by itself; the step that produced the log decides that.

import { readFileSync } from 'node:fs';

const [file, label = 'log'] = process.argv.slice(2);
let text = '';
try {
  text = readFileSync(file, 'utf8');
} catch {
  console.log(`::warning title=${label.replace(/[:,]/g, ' ')}::no log at ${file}`);
  process.exit(0);
}

// Annotation text: newlines and percent signs must be escaped.
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
// Property values (the title) also escape `:` and `,`.
const prop = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const note = (level, title, body) => `::${level} title=${prop(title)}::${esc(body)}`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…` : s);
// Strip ANSI colour codes that cargo may emit.
const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n');

const out = [];

// 1. cargo test: per-binary result lines and the grand total.
const results = [];
let current = '';
for (const line of lines) {
  const run = line.match(/Running (?:unittests )?(\S+)/);
  if (run) current = run[1];
  const m = line.match(/test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored/);
  if (m) results.push({ bin: current, ok: m[1], passed: +m[2], failed: +m[3], ignored: +m[4] });
}
if (results.length) {
  const sum = (k) => results.reduce((a, r) => a + r[k], 0);
  const head = `${sum('passed')} passed, ${sum('failed')} failed, ${sum('ignored')} ignored in ${results.length} test binaries`;
  const body = results
    .filter((r) => r.passed + r.failed + r.ignored > 0)
    .map((r) => `${r.ok === 'ok' ? 'ok  ' : 'FAIL'} ${r.passed}/${r.failed}/${r.ignored}  ${r.bin}`)
    .join('\n');
  out.push(note('notice', `${label}: ${head}`, clip(body, 6000)));
}

// 2. Failing tests with their panic message.
const failed = [...new Set(lines.map((l) => l.match(/^test (\S+) \.\.\. FAILED/)?.[1]).filter(Boolean))];
for (const name of failed.slice(0, 12)) {
  const start = lines.findIndex((l) => l.includes(`---- ${name} stdout ----`));
  const detail = [];
  for (let j = start + 1; start >= 0 && j < lines.length && detail.length < 15; j++) {
    if (lines[j].startsWith('---- ') || lines[j].trim() === 'failures:') break;
    detail.push(lines[j]);
  }
  out.push(note('error', `${label}: FAILED ${name}`, clip(detail.join('\n') || '(no captured output)', 3000)));
}

// 3. Compiler and type-checker errors (rustc, vue-tsc).
const errors = [];
for (let i = 0; i < lines.length && errors.length < 12; i++) {
  const l = lines[i];
  if (/^error(\[E\d+\])?: /.test(l) && !/could not compile|aborting due to/.test(l)) {
    const block = [l];
    for (let j = i + 1; j < lines.length && j < i + 14 && lines[j].trim() !== ''; j++) block.push(lines[j]);
    errors.push(block.join('\n'));
  } else if (/error TS\d+:/.test(l)) {
    errors.push(lines.slice(i, i + 3).join('\n'));
  }
}
for (const e of errors) out.push(note('error', `${label}: compile`, clip(e, 3000)));

// 4. Nothing recognisable: show the tail so the cause is never invisible.
if (!results.length && !failed.length && !errors.length) {
  const tail = lines.filter((l) => l.trim()).slice(-25).join('\n');
  out.push(note('warning', `${label}: tail`, clip(tail, 5000)));
}

console.log(out.join('\n'));
