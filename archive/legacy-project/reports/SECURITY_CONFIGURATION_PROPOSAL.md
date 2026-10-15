# Security Configuration Proposal — GAS_URL + Supabase (DESIGN ONLY)

Status: **proposal, NOT implemented**. No source file was changed to produce this document.
Date (UTC): 2026-09-26. Basis: read-only audit (`AUDIT_REPORT.md`, Phase 1 addendum).
Notation: the credential value is never reproduced; it appears only as `[GAS_URL_REDACTED]`.

---

## 1. Current configuration architecture

```
index.html <script> order (23 local files, helpers.js → app.js)
   └─ app.js:230  const [GAS_URL_REDACTED] = '…'        ← DEFINITION (hardcoded)
   └─ sync.js:10  fetch([GAS_URL_REDACTED], POST full localStorage dump)
   └─ sync.js:26  JSONP GET [GAS_URL_REDACTED]?callback=…&t=…
```

- No `.env`, no config file, no config boundary: the secret lives inline in application source and is therefore inlined into every `build.py` output (`dist/index.html`, diagnostic builds) and every distributed copy.
- Supabase side: `sync_supabase_config.js` (project URL + publishable key) exists but is **not loaded** and the SDK is absent — effectively dormant configuration, not live configuration.
- There is exactly one live secret to govern: `[GAS_URL_REDACTED]`.

## 2. GAS_URL exposure analysis

- **Propagation:** 7 locations — 1 source definition, 2 source consumers (+2 duplicate-dir consumers), 2 inlined HTML builds, 2 release ZIPs (see `AUDIT_REPORT.md` → Credential Propagation). Documentation/prose is clean.
- **Capability:** possession of the URL = unauthenticated full read (JSONP download) and full write (POST upload) of all shop data. Verified: no auth header/token/param in either call; this is the app's only network egress.
- **Blast radius:** every person who ever received a single-file build (WhatsApp/email forwarding multiplies this invisibly) holds a live read/write capability. There is no per-recipient scoping and no server-side check verifiable from the repo (GAS `doPost`/`doGet` code lives in the owner's Google account, uninspected).
- **Classification:** capability-style bearer URL (authorization embedded in the URL). Handled as an access-bearing secret until the GAS project is inspected.

## 3. Supabase configuration analysis

- The publishable key is public-by-design; its presence in cleartext is normal for browser apps **provided RLS enforces isolation** — but RLS status is unverified (SUPABASE VERIFICATION: BLOCKED).
- Because the config file is unreachable at runtime, the key is currently inert. Risk is latent, not active: it becomes live the day someone adds the three `<script>` tags.
- No `service_role`/secret key exists anywhere — the highest-severity Supabase failure mode is absent.
- Recommendation: keep the files untouched (dormant, informative, tiny); gate any activation on the manual verification checklist in `AUDIT_REPORT.md`.

## 4. Recommended configuration boundary

Single configuration boundary, two halves — one shippable now without behavior change, one requiring the human owner:

**(a) Source hygiene (reversible, no secrecy claimed):** introduce one clearly-marked `APP_CONFIG` object as the single place the app reads endpoints from (populated today by the existing constants file content, moved verbatim). Goal: exactly one definition site, rotation = edit one block + rebuild. This changes NOTHING about who can see the value.

**(b) Real access control (the actual fix, human-only):** restrict/rotate at the GAS deployment itself — new deployment ID, `Execute as: Me`, access limited to the owner account, plus a server-side shared-secret check (`doPost`/`doGet` require a per-shop token the client sends) so that a leaked URL alone is insufficient. Old deployment disabled. Inventory who holds distributed HTML copies, because old copies keep working until the old deployment dies.

Order matters: (b) first or together; (a) alone is theater (see §6).

## 5. Alternatives considered

### A. Build-time configuration (inject URL at `build.py` time, e.g. from a local file outside the repo)
- Benefit: secret leaves versioned source; per-environment builds; rotation without editing app code.
- Hides from users? **No.** The value is still inlined into the shipped HTML/JS the browser executes — visible to every recipient and DevTools.
- Offline-first compatibility: full. Operational complexity: low (small `build.py` change + local secret file + `.gitignore` if git is adopted).
- Verdict: worthwhile hygiene, zero secrecy. Do not present it as a fix.

### B. Runtime configuration file (e.g. `config.js`/`config.json` loaded beside the HTML, excluded from sharing)
- Benefit: one shared HTML template; URL lives in a per-device file.
- Hides from users? **No** — same visibility once loaded; additionally fragile: the app is distributed as ONE file (WhatsApp), so a sidecar file breaks the distribution model (missing file = broken Drive sync; users will just paste the URL back in).
- Offline-first compatibility: poor (violates single-file distribution). Complexity: medium (load-order handling, missing-config UX).
- Verdict: not recommended for this product shape.

### C. Backend/proxy mediation (browser calls owner-controlled proxy; proxy holds the real GAS URL + per-shop token)
- Benefit: the real capability URL is never shipped; per-shop/per-device tokens become revocable; abuse logging possible. This is the only option that genuinely removes the secret from user hands.
- Hides from users? **Yes — the only option that does** (users see a proxy address + revocable token, not the capability).
- Offline-first compatibility: partial — proxy calls need connectivity (Drive sync already needs it; local-first operation unaffected). Complexity: high (hosting, auth, uptime, cost, new component to secure).
- Verdict: correct long-term direction if multi-shop distribution continues; overkill if there is exactly one shop and rotation + GAS access lockdown suffice.

### D. Server-side secret storage (Secret Manager / vault for the GAS-side or proxy-side secret)
- Benefit: proper secret lifecycle (versioning, rotation, audit) on the server side.
- Hides from users? Only in combination with C — a browser app cannot consume a vault directly without re-exposing whatever grants access to it.
- Offline-first compatibility: N/A (server-side). Complexity: medium-high.
- Verdict: companion to C, not a standalone fix; adopt if/when C is adopted.

### E. Access restriction / rotation of the existing GAS endpoint (owner console actions)
- Benefit: immediately shrinks blast radius; kills all previously distributed capabilities at once (disable old deployment); least code churn (zero app changes if URL shape preserved; one phased change if a server-side token is added).
- Hides from users? Restriction (execute-as-owner, account-limited access) reduces WHO can invoke; rotation invalidates old copies. A fresh URL is still visible to new holders — so E must be paired with usage discipline (minimal distribution list).
- Offline-first compatibility: full. Complexity: low (console + redeploy), plus rollout coordination (all devices need the new build).
- Verdict: **the mandatory first step regardless of which of A–D is chosen later.** No architecture decision can substitute for it.

## 6. Security limitations of frontend configuration (anti-false-security notice)

A value required by browser JavaScript at runtime **cannot be made secret by relocation**: source constant, build-time injected variable, or sidecar config file are equally readable by anyone holding the file or opening DevTools. Any proposal claiming otherwise is rejected. Genuine secrecy for a browser capability requires either (i) not shipping the capability (proxy, option C), or (ii) making possession insufficient (server-side per-shop token + GAS access lockdown, option E). Everything else is rotation agility and code hygiene — valuable, but labeled as such.

## 7. Credential rotation requirements

`[GAS_URL_REDACTED]` rotation is REQUIRED (treat as exposed: it sits in ZIPs, diagnostic builds, and every shared copy):
1. Owner redeploys the GAS web app → new deployment ID; sets `Execute as: Me`; restricts access to the owner Google account (or narrowest workable set).
2. (Recommended in the same window) Add a server-side shared-secret check in `doPost`/`doGet` + per-shop token; the app sends it with each call.
3. Disable/delete the old deployment; verify old URL no longer responds with data.
4. Rebuild (`build.py`) and redistribute the single file through a deliberate channel; confirm all active devices report success; account for stragglers on the old build (they fail closed after step 3).
5. Supabase publishable key: NO rotation required (public by design, currently inert). Rotate only if it is ever replaced by — or confused with — a `service_role` key.

## 8. Migration / rollout plan (for Phase-3 approval, not executed here)

1. Human: complete §7 steps 1–3 in the GAS console (owner credentials required).
2. Human: supply the new endpoint (+ optional per-shop token) for configuration.
3. Code (single, reviewable change): point the ONE configuration boundary (§4a) at the new values; rebuild; smoke-test upload/download against the new deployment with test data first.
4. Distribute new build; confirm each device; monitor GAS executions for calls to the disabled deployment (indicates un-updated copies in the wild).
5. Re-run the full secret scan; confirm old URL string is absent from source and fresh builds (archived ZIPs intentionally retain it as history — see §9).

## 9. Rollback plan

- Keep the old GAS deployment disabled-but-restorable for a short, time-boxed window (e.g. 7 days) in case the new deployment misbehaves; re-enabling restores old builds' sync at the cost of re-opening exposure — owner decision, documented.
- Code rollback = previous single-file build (retained) + one-line config revert + rebuild. No schema, no migrations, no dependency changes involved, so rollback is a file swap.
- Historical ZIPs and this report series are append-only evidence; never rewrite them to "scrub" the old URL (scrubbing history while copies exist outside it is false security; rotation, not editing, kills a capability).

## 10. What requires human credentials / access (cannot be done by the agent)

- GAS project ownership + Apps Script console (redeploy, access settings, execution logs, disable old deployment).
- Google account that owns the backing Drive/Sheet store.
- Inventory of who received shared HTML builds (to know the exposure set).
- Supabase dashboard access (project ownership, key status, tables, RLS, advisors, data presence) — full checklist in `AUDIT_REPORT.md`.
- Decision on distribution model going forward (single shop vs. multi-shop → determines whether option C is justified).
- Explicit go-ahead for Phase 3 implementation.

## 11. What should NOT be changed yet

- No deletion of `phase24_recovered/`, `node_modules/`, diagnostic HTMLs, or ZIPs (separate cleanup decision with its own evidence bar).
- No PIN logic changes; no Supabase schema/RLS/policy/data changes; no key rotation by the agent; no dependency upgrades; no architecture rewrite; no `.env` theater that claims secrecy without a proxy.
- No contact with the live Supabase project or the GAS endpoint beyond what the owner explicitly authorizes (probing was deliberately out of scope for this phase).
