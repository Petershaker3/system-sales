# GAS Credential Rotation Runbook (human-operated)

Scope: retire the exposed Drive-sync capability (`[GAS_URL_REDACTED]`) and put a
new endpoint into service. The agent is NOT authorized for any console/account
action below — every step here requires the owner's Google/GAS access.

Notation: the retired value is never reproduced; it appears only as
`[GAS_URL_REDACTED]`.

## 1. Current exposure

- The retired URL was the app's sole network egress (full `localStorage` upload
  via POST, full data download via JSONP) with no additional auth, so possession
  equaled unauthenticated read/write of all shop data.
- It is embedded in: historical source copies, two inlined diagnostic HTMLs,
  two release ZIPs (all now marked `SECURITY-RETIRED / DO NOT DISTRIBUTE` via
  sidecar markers; contents intentionally preserved as evidence), and — critically —
  every single-file build ever shared (WhatsApp/email forwarding is invisible).
- Current source (`dev_extracted/dev/`) and fresh builds no longer contain it:
  the single boundary `js/app_config.js` holds a placeholder and both Drive
  functions fail closed (visible error, zero network) when unconfigured.
- Therefore: deleting local copies is NOT rotation. Only disabling the old
  GAS deployment kills the distributed capability.

## 2. Required human actions (GAS / Google console)

1. Open the Apps Script project backing the Drive sync; identify the deployment
   behind `[GAS_URL_REDACTED]`.
2. Review that project's `doPost`/`doGet`: confirm what (if anything) they check
   beyond the URL. Record the finding — it determines whether historical
   exposure could have been exploited silently (check execution logs).
3. Create a NEW versioned deployment (new deployment ID).
4. Set `Execute as: Me` (the owner account) and restrict access to the narrowest
   workable set (ideally owner-only; any "Anyone with the link" setting
   re-creates bearer-URL exposure for the new value).
5. (Recommended, same window) Add a server-side shared-secret check: `doPost`
   and `doGet` reject requests missing a per-shop token. Generate that token
   now (random, ≥128 bit) — it will accompany the new URL in step §3.
6. Execute the rollout in §4, THEN disable/delete the old deployment.
7. Verify per §5.

## 3. Replacement credential flow (never committed)

1. The new value enters ONLY at deploy time: the owner edits
   `dev_extracted/dev/js/app_config.js` locally, setting `APP_CONFIG.GAS_URL`
   to the new `/exec` URL (and the token, if §2.5 was adopted — the app sends it;
   no app-code change is needed for the URL itself).
2. Rebuild: `python build.py` inside `dev_extracted/dev/` → `dev_extracted/dist/index.html`.
3. The configured `app_config.js` + any configured build are DEPLOY ARTIFACTS,
   not repository content: do not email them loosely, do not commit them to any
   future git remote, distribute only to active devices.
4. The repository's canonical state stays placeholder-only; anyone rebuilding
   from the repo gets a Drive-disabled (but otherwise fully working) app.

## 4. Rollout sequence (dead-app-proof order)

1. Deploy + lock down the NEW endpoint (§2.1–2.5) while the old one still runs.
2. Configure locally (§3.1), rebuild, and smoke-test Drive upload/download with
   NON-CRITICAL data first (a fresh browser profile is ideal).
3. Distribute the new single file to ONE device; confirm upload + download.
4. Roll out to remaining devices; confirm each reports success.
5. ONLY NOW disable/delete the old deployment.
6. Confirm old builds fail closed (clear error toast, no crash, local data intact).

## 5. Verification

- [ ] New endpoint: upload returns success toast; download merges data; local-first
      operation unaffected when offline.
- [ ] Old endpoint: the retired URL no longer returns shop data (HTTP error or
      access-denied from Google; confirm in a clean session, not just in-app).
- [ ] `script.google.com` / `macros/s/` occur in ZERO active-source and fresh-dist
      files: re-run `node dev/tests/gas_config_boundary_test.js` (7/7) plus a
      tree scan; remaining occurrences must be ONLY the four marked historical
      artifacts.
- [ ] Application sync works end-to-end on every active device.
- [ ] No credential value appears in source, tests, docs, or reports
      (`[GAS_URL_REDACTED]` notation only).

## 6. Rollback

- If the new endpoint fails BEFORE old-disablement: devices keep working on the
  old build; fix forward on the new deployment. No rollback needed.
- If failure is discovered AFTER old-disablement: re-distribute the last working
  configured build (retained from §4.3) once the new deployment is repaired.
- ⚠️ Re-enabling the OLD exposed deployment "restores service" but also
  restores the exposure to everyone holding historical copies. Treat this as a
  SECURITY INCIDENT path, not a routine rollback: time-box it, log who holds
  copies, and re-disable immediately after recovery.
