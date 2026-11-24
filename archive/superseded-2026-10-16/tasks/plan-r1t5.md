# R1-T5 Execution Plan — supervised recovery panel + device run

Status: **AWAITING PRODUCT OWNER APPROVAL.** Nothing in this plan has been
implemented. No APK built, no device touched, no data or credential changed, no
commit. Working tree preserved (all R1 changes remain uncommitted).

## 1. Objective

Give the supervisor a way to drive the two existing recovery commands from the
app on a recovery build, then execute one supervised recovery on the shop device
and verify sign-in with a temporary password. R1-T6 (forced final password,
Pattern re-establishment, `TEST-MA-1`) and R1-T7 (path closure + production APK
scan) remain separate gates.

## 2. Mechanism decisions (verified, not assumed)

**The security control is the Rust `recovery` feature, unchanged.** The two
commands do not exist in a production build, so a production bundle that
somehow carried the panel would only produce a failed invoke. Panel inclusion is
a *build hygiene* measure, explicitly **not** a security boundary, and the
Panel-absent-from-production requirement is enforced as a build check plus the
R1-T7 APK scan.

**Frontend gate — no config change needed.** `vite` exposes `import.meta.env.VITE_*`
from the build-time process environment, and `tauri.conf.json` sets
`beforeBuildCommand: "npm run build"`. Setting `VITE_RECOVERY=1` in the
environment before invoking the Android build therefore produces a recovery
bundle, and leaving it unset produces a production bundle. No `package.json`
script, no `tauri.conf.json` edit, no second entry point. Default is off.

**Cargo feature.** `tauri android build` supports `-f, --features` (verified from
`--help`), so the recovery APK is built with
`tauri android build --features recovery --apk --target aarch64` under the same
environment variable.

**Target selection reuses existing code.** `listUsers()` (`src/api/identity.ts:60`)
already returns id, display name, username and role. The supervisor picks the
manager by name; no UUID is hardcoded anywhere.

**No external channel.** No `intent`, no deep-link, no URL handler. The panel is
reachable only by a person operating the device in the app.

## 3. Files expected to change

Frontend (new):
- `src/api/recovery.ts` — typed wrappers for `stage_recovery_approval` and
  `execute_manager_recovery`. Plain data only; no token, no stored value.
- `src/components/RecoveryPanel.vue` — minimal single-use form: choose target,
  reference, reason, approver, Pattern → stage; then temporary password →
  execute. Password inputs are transient, cleared on unmount, never persisted.

Frontend (minimal edit):
- `src/App.vue` — mount the panel only under `import.meta.env.VITE_RECOVERY`.

Rust: **no changes.** The commands, the Pattern gate, the throttle and the audit
payloads are already in place and tested.

Tests:
- `src-tauri/tests/architecture/main.rs` — one guard asserting the production
  mount site is `VITE_RECOVERY`-gated and the panel source carries no
  `intent`/deep-link/URL-scheme handling.

Explicitly not touched: any costing, inventory, identity, session or Pattern
file; any migration; `users.failed_attempts` semantics.

## 4. Tasks

**T5.1 — API wrappers.** Typed invoke wrappers mirroring `src/api/identity.ts`
style; errors mapped through the existing `errors.ts` table so
`RECOVERY_RATE_LIMITED` renders in Arabic. *Acceptance:* typecheck clean; no
persistence of any entered value. *Verify:* `npm run typecheck`.

**T5.2 — Recovery panel.** Single screen, no navigation, no retry loop.
*Acceptance:* a throttle refusal shows the Arabic "wait" message and does **not**
auto-retry; a stage success advances to the execute step; execute failure leaves
the panel usable for a supervised retry. *Verify:* `npm run build` under both
settings, plus manual read of the rendered flow.

**T5.3 — Gated mount.** `App.vue` mounts the panel only when
`import.meta.env.VITE_RECOVERY` is set. *Verify:* grep `dist/` after each build.

**T5.4 — Separation checks (before any install).**
1. Production frontend: `npm run build` → `dist/` must contain no recovery
   marker and no `stage_recovery_approval`.
2. Recovery frontend: `VITE_RECOVERY=1 npm run build` → marker present.
3. Rust unchanged from the accepted slice: `cargo test` and
   `cargo test --features recovery` re-run green.
4. Recovery APK produced, then scanned for recovery symbols before install.

**T5.5 — Supervised device run.** Sequence and stop conditions in §6.

**T5.6 — Evidence capture.** Screenshots of the panel, the stage result, the
execute result and the successful sign-in; the logcat window; the resulting audit
rows. Then STOP.

## 5. Build-separation verification mechanism

| Layer | Check | Expectation |
|---|---|---|
| Frontend bundle | grep `dist/` for the panel marker, production vs recovery build | absent / present |
| Rust | existing architecture tests (71) + rlib string scan (F4 method) | absent in prod |
| Device APK | scan the recovery APK before install | present (it is a recovery build) |
| **Production APK** | scan the final clean APK | **absent — assigned to R1-T7** |

Bundles and rlib scans are supporting evidence, not proof of every artifact. The
production APK scan is the mandatory close-out and is deliberately not performed
now.

## 6. Supervised sequence (requires the Product Owner's own inputs)

1. Build the recovery APK under `VITE_RECOVERY=1` + `--features recovery`; scan it.
2. `adb install -r` only — no uninstall, no data wipe.
3. Launch; open the recovery panel.
4. Select the target manager; enter reference, reason, approver.
5. **The Product Owner types the current device Pattern.** It is never sent to me.
6. Stage. A refusal is recorded as evidence, not retried in a loop.
7. **The Product Owner types the temporary password** (policy: minimum 8
   characters). It is never sent to me and is never written to any file I create.
8. Execute.
9. Verify sign-in with the temporary password.
10. Capture evidence and STOP.

**Stop conditions:** any error code other than the expected success path, any
unexpected screen, or any refusal of the Pattern check → stop, preserve
evidence, do not retry, do not proceed to R1-T6.

## 7. Inputs required from the Product Owner at execution time

These are needed live, and none should be transmitted to me:
- the current device Pattern (typed by the owner),
- the temporary password (typed by the owner),
- the approval reference to use (e.g. `R1-20261010-01`),
- the approver string to record.

## 8. Limits carried forward

- Throttle intact: Pattern gate, 5 s → 5 min backoff, atomic reservation, one-shot
  consumption, audit trail.
- Panel absent from production is hygiene; the Rust feature gate is the control.
- Deferred and out of scope: the unthrottled public `verify_pattern` command,
  recorded for a separate review.
- No costing or inventory work, no `TEST-MA-1` read before sign-in is restored.
## 9. Build commands and environment-leakage guarantee

### 9.1 The flag

`VITE_RECOVERY=1` includes the recovery panel. Unset is the default and the
safe state. It is hygiene only; the security control is the Rust `recovery`
cargo feature.

### 9.2 Production (default, no flag)

```
npm run build
```
Frontend only. Rust, without the feature:
```
cd src-tauri && cargo build
cd src-tauri && cargo test
```
APK: `.\scripts\android-build.ps1 -Apk` — it runs `tauri android build` with
no `--features`, so the recovery commands are not compiled in.

### 9.3 Recovery

Frontend:
```
cmd /c "set VITE_RECOVERY=1 && npm run build"
```
Rust tests:
```
cd src-tauri && cargo test --features recovery
```
APK (not built during this task — R1-T5 execution step):
```
cmd /c "set VITE_RECOVERY=1 && .\scripts\android-build.ps1 -Apk"
```
If the script's own invocation must carry the feature instead, the equivalent
is `tauri android build --features recovery --apk --target aarch64` under the
same flag. Both halves — frontend flag and cargo feature — are required; either
one alone yields a build that cannot complete a recovery.

### 9.4 How leakage between the two is prevented

1. **Never assign the variable persistently.** Every recovery command above
   uses `cmd /c "set VITE_RECOVERY=1 && ..."`, which scopes the variable to that
   child process. It cannot survive the command, so a later production build in
   the same shell cannot inherit it.
2. **Rebuild production last.** A recovery bundle left in `dist/` is a real leak.
   After any recovery build, re-run the production build and confirm
   `dist/assets/` contains no `RecoveryPanel-*` file.
3. **Verified both directions** (see the final report):
   production `dist/` → no `RecoveryPanel` chunk, no `stage_recovery_approval`,
   no `execute_manager_recovery`, no Arabic panel strings;
   recovery `dist/` → `RecoveryPanel-*.js` present, both command names present.
4. **Automated source guard.** Three architecture tests assert the gate holds,
   the import stays dynamic, no external channel exists, nothing is persisted
   and nothing schedules a retry. They run in both configurations.

### 9.5 Why the dot form matters

`import.meta.env.VITE_RECOVERY` is statically replaced by Vite, which is what
lets the bundler prove the guard false and drop the panel from the bundle.
`import.meta.env['VITE_RECOVERY']` typechecks but is not reliably replaced, and
the panel then ships in production — measured, not assumed: the bracket form
emitted `RecoveryPanel-*.js` in a production build. `src/vite-env.d.ts` exists
so the dot form typechecks without an index-signature cast, and an architecture
test fails the build if anyone reintroduces the bracket form.