# Phase 3 Security Remediation Report (2026-09-26)

"Moving a browser-consumed endpoint into configuration does not make it secret."

## 1. Changes made

- New single configuration boundary `dev_extracted/dev/js/app_config.js`:
  `APP_CONFIG` (with `GAS_URL: ''` placeholder) + fail-closed accessor
  `_getGasUrl()`. Placeholder only — the retired value was NOT copied in.
- `dev_extracted/dev/js/app.js`: removed the hardcoded endpoint literal; section
  header kept with a pointer to the boundary. No logic touched.
- `dev_extracted/dev/js/sync.js`: `uploadToDrive`/`downloadFromDrive` read the
  endpoint exclusively via `_getGasUrl()`; when empty they show a clear Arabic
  error toast and return BEFORE any network/DOM action (fail closed). Payload,
  success/error messages, JSONP flow, and all offline/localStorage behavior
  unchanged.
- `dev_extracted/dev/index.html`: one added line loading `js/app_config.js`
  first. No other markup touched.
- New test `dev_extracted/dev/tests/gas_config_boundary_test.js` (7 checks;
  written first, observed failing 6/7, then green).
- Fresh build `dev_extracted/dist/index.html` (515,453 bytes) via `build.py`.
- Report hygiene: prior `AKfyc…` value-mentions in `AUDIT_REPORT.md` replaced
  with `[GAS_URL_REDACTED]`; §6 and exposure note updated to Phase 3 state.
- Four sidecar markers `*.SECURITY-RETIRED-DO-NOT-DISTRIBUTE.txt` (2 ZIPs +
  2 diagnostic HTMLs). Additive only; artifact contents untouched.

## 2. Files modified

1. `dev_extracted/dev/js/app_config.js` (NEW)
2. `dev_extracted/dev/js/app.js` (1 block replaced with boundary pointer)
3. `dev_extracted/dev/js/sync.js` (2 call sites + 2 guards)
4. `dev_extracted/dev/index.html` (1 script tag)
5. `dev_extracted/dev/tests/gas_config_boundary_test.js` (NEW)
6. `dev_extracted/dist/index.html` (NEW build output)
7. `AUDIT_REPORT.md` (Phase-0 wording updated, no values)
8. `docs/SECURITY_CONFIGURATION_PROPOSAL.md` (pre-existing from Phase 2, untouched)
9. `docs/GAS_CREDENTIAL_ROTATION_RUNBOOK.md` (NEW)
10. This report (NEW) + 4 sidecar marker files (NEW)

## 3. Files intentionally not modified

`phase24_recovered/*` (separate cleanup task), Supabase files + `package.json`/
`node_modules` (dormant integration, untouched per 3G), `dev.zip` + RC zip +
diagnostic HTML contents (historical evidence, marked not scrubbed),
`build.py` (works; pre-existing Win-console emoji crash noted below, cosmetic —
file IS written before the crash), PIN/security logic, all other app source,
all other tests and docs.

## 4. Old credential exposure status

- OLD endpoint: **0 occurrences** in active source (`dev_extracted/dev/`) and in
  the fresh `dist` build (verified by host/path-fragment scan + boundary test).
- Retained ONLY in 4 marked historical artifacts (contents preserved as
  evidence). These MUST be treated as exposed until the GAS deployment is
  disabled by the owner.

## 5. New configuration architecture

```
UI / sync.js  →  _getGasUrl()  →  APP_CONFIG (app_config.js, placeholder '')
                                         ↓ (deploy time only, never committed)
                                   rotated GAS endpoint
```
Unconfigured app = Drive buttons show a clear error; everything else works
offline exactly as before.

## 6. Validation commands / results

| Check | Command | Result |
|---|---|---|
| New boundary test (RED→GREEN) | `node dev/tests/gas_config_boundary_test.js` | RED 1/7 pre-change (as required by TDD), GREEN **7/7** post-change |
| Runnable suites | `node dev/tests/rc_closure_test.js`, `phone_date_roundtrip_test.js` | **11/11**, **4/4** PASS (rc loads edited `sync.js`) |
| Legacy suite (14 files) | `node dev/tests/*.js` | Fail with ENOENT on hardcoded `/home/claude/…` paths — **pre-existing environmental**, unrelated to this change |
| GAS-fragment scan (active source) | tree scan `script.google.com`/`macros/s/` | 0 in app code (only the test's own detector constants) |
| Secret-material rescan | private-key/`service_role`/JWT/bearer patterns | 0 values; only prose + pre-existing "NEVER use" comments |
| Build | `python build.py` in `dev_extracted/dev/` | `dist/index.html` 515,453 bytes; 0 endpoint fragments; `APP_CONFIG` inlined before first use (pos 98919 < 327941) |
| No replacement credential | scan dist+source for configured URL | placeholder `GAS_URL: ''` only |

Known pre-existing issue (NOT introduced here): `build.py` crashes AFTER writing
the file when printing the ✅ line on Windows cp1252 consoles
(`UnicodeEncodeError`). Artifact is complete; left untouched as out of scope.

## 7. Historical artifacts still containing the old credential

- `dev.zip` → `dev/js/app.js`
- `dev_phase24_rc_closed_2026-08-18.zip` → `dev/js/app.js`
- `mshop-diag.html`, `mshop-regression-test.html` (inlined builds)
- Each has a `SECURITY-RETIRED-DO-NOT-DISTRIBUTE` sidecar. Do NOT claim the
  working tree is free of the old value while these exist.

## 8. Human actions still required

GAS redeploy + lockdown + old-disablement, distribution inventory, new-value
entry at deploy time, Supabase dashboard verification (unchanged, still
BLOCKED) — see runbook §§2–5 and `AUDIT_REPORT.md` Phase 1 addendum.

## 9. Remaining security risks

Old deployment still live (owner action pending); historical copies circulating
outside the repo; client-side PIN remains UI-only by design; Supabase RLS
unverified (integration dormant); single-file distribution re-exposes ANY future
endpoint to each recipient — lasting fix needs proxy (option C) or strict
distribution discipline.

## 10. What this remediation DOES NOT solve

- It does not make the endpoint secret (see epigraph; proposal §6).
- It does not rotate, restrict, or disable anything server-side.
- It does not remove the old value from historical artifacts.
- It does not change access control, PIN strength, Supabase posture,
  storage limits, or the open Issue 2 restore bug.
