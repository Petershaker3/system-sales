# PROJECT HANDOFF — محل الموبايلات (Mobile Shop Management System)

**Handoff Date:** 2026-07-28
**Prepared for:** New chat continuation

---

# Project Overview

Offline-first Arabic mobile shop management system. Single-page client-side web application (vanilla HTML/CSS/JS + localStorage). Build system compiles `dev/` into single `dist/index.html` file.

- **Type:** Offline-first SPA (no server, no database, no framework)
- **Storage:** localStorage (5MB browser limit)
- **Language:** Arabic (RTL)
- **Build:** Python script (`dev/build.py`)
- **Security:** 4-digit PIN lock + AES-GCM encrypted backups (Web Crypto API)
- **Architecture:** Layered (UI → Business → Repositories → Adapters → Provider → Storage)

---

# Current Architecture

## Layer Stack (post-ADR-003)

```
UI Layer (accessories.js, cash.js, usedPhones.js, expenses.js, software.js, phones.js, repair.js, etc.)
    ↓
Repository Layer (db_integration.js — Repository, LocalAdapter, LOCAL_COLLECTION_MAP, LOCAL_PARTITIONED_MAP)
    ↓
Mapper Layer (entity_mappers.js — BaseMapper + entity-specific mappers)
    ↓
Provider Layer (Storage API — storage.js)
    ↓
localStorage (browser)
```

### Cross-cutting (kept legacy, NOT migrated to Repository)
- `softDel()`, `rollbackTransaction()`/`finishRollback()`, `restoreTrash()`, `permDelTrash()`, `clearOldTrash()`
- `save()` function (writes `data` global to `mshop_d_TODAY`)
- `markAllNotifsRead()`, `calcHist.splice()`, category management

### Key Global State Variables
- `data` — object `{acc, used, cash, sw, exp, phones, repairs}` for the currently selected date (`sel`)
- `sel` — currently selected date string (YYYY-MM-DD), defaults to `TODAY`
- `TODAY` — today's date (YYYY-MM-DD)
- `cfg` — shop configuration (name, PIN, logo, admin timeout, etc.)
- `inventory` — phone inventory array
- `notes`, `notifs`, `trash`, `calcHist`, `repairParts`, `faultTypes` — static collections

### Key Storage Keys
- `mshop_d_YYYY-MM-DD` — daily transaction data: `{acc:[], used:[], cash:[], sw:[], exp:[], phones:[], repairs:[]}`
- `mshop_cfg` — shop configuration
- `mshop_inventory` — phone inventory
- `mshop_notes`, `mshop_notifs`, `mshop_trash`, `mshop_calc_hist`, `mshop_repair_parts`, `mshop_fault_types`
- `mshop_emergency_backup` — automatic emergency backup before restore
- `mshop_last_backup` — last backup date string
- `mshop_backup_history_log` — last 10 backup records

---

# Completed Phases

## Phase 1 — Refactor (Code Reorganization)
**Purpose:** Split monolithic HTML into organized `dev/` structure (js/, css/, tests/)
**Status:** Complete (long before this chat)

## Phase 2A — Unified Storage API
**Purpose:** Create `Storage` object wrapping all localStorage access
**Status:** Complete
**Files:** `storage.js`

## Phase 2B — Unified Financial Engine
**Purpose:** Single source of truth for financial calculations (computeFinancialTotals)
**Status:** Complete
**Files:** `ui.js:33-51`

## Phase 3A — Encrypted Backup System (.mshop format)
**Purpose:** AES-GCM + PBKDF2 encrypted backup/restore with Web Crypto API
**Files:** `backup.js:50-495`
**Status:** Complete (but contains the active Issue 2 bug)
**Key features:**
- `createSecureBackup(password)` — create encrypted backup
- `validateBackupObject()` — validate backup integrity
- `restoreSecureBackup(file, password)` — restore from encrypted backup
- Emergency auto-backup before restore
- Snapshot-based rollback on failure
- Backup reminder system

## Phase 3A+ — Migration Framework & Restore Lock
**Files:** `backup.js:238-260, 294-301`
**Status:** Complete

## Phase 4 — Sync Architecture (Documentation only)
**Purpose:** Architecture for future cloud sync
**Status:** Documented only — NO implementation

## Phase 5 — Database Foundation (Documentation only)
**Purpose:** Entity schema definitions, field maps, validation rules
**Files:** `db_foundation.js`
**Status:** Documentation only — NOT used at runtime

## Phase 6 — Database Integration Layer
**Purpose:** Repository pattern foundation — LocalAdapter, DatabaseAdapter interface, error codes
**Files:** `db_integration.js:1-815`
**Status:** Complete (foundation layer)

## Phase 6.5 — Entity Mappers
**Purpose:** Structural mapping layer between local format and future DB format
**Files:** `entity_mappers.js`
**Status:** Complete

## Phase 7.2 — LocalAdapter with Partitioned Collections
**Purpose:** Combined Static + Partitioned routing in LocalAdapter
**Files:** `db_integration.js:52-815`
**Status:** Complete

## ADR-003 — Repository Migration (Phases 8.3 - 8.7)

### Phase 8.3 — Static Repositories (Notes, Repair Parts, Fault Types)
**Status:** Complete — Verified: Yes
**Files changed:** `db_integration.js`, `notes.js`, `notifications.js`, `settings.js`, `repair.js`
**What:** `NoteRepository`, `RepairPartRepository`, `FaultTypeRepository` (standalone)
**Call sites migrated:** `saveNote()`, `toggleNotesDone()`, `deleteNote()`, `npAction()`, `addFaultType()`, `deleteFaultType()`, `toggleFaultType()`, `addRepairPart()`

### Phase 8.4 — Accessory & Expense Transaction Repositories
**Status:** Complete — Verified: Yes
**Files changed:** `db_integration.js`, `accessories.js`, `expenses.js`
**What:** `AccessoryTransactionRepository`, `ExpenseTransactionRepository`
**Mapper fixes:** `AccessoryTransactionMapper.validate()` (snapshotName→name), `ExpenseMapper.validate()` (snapshotCategory→category, amount→amount)

### Phase 8.5 — Phone, Used Phone, Software & Wallet Transaction Repositories
**Status:** Complete — Verified: Yes
**Files changed:** `db_integration.js`, `cash.js`, `software.js`, `usedPhones.js`, `phones.js`
**What:** `PhoneTransactionRepository`, `UsedPhoneTransactionRepository`, `SoftwareTransactionRepository`, `WalletTransactionRepository`
**Mapper fixes:** Multiple snapshot field renames

### Phase 8.6 — Repair Transaction Repository (CREATE)
**Status:** Complete — Verified: Yes
**Files changed:** `db_integration.js`, `repair.js`
**What:** `RepairTransactionRepository` with `initCache()` + `create()`

### Phase 8.7 — Repair & Software Update/Delete + Base Class Options
**Status:** Complete — Verified: Yes
**Files changed:** `db_integration.js`, `repair.js`, `software.js`
**What:** `Repository.update(id, changes, options)`, `Repository.delete(id, options)`
**Methods added:** `RepairTransactionRepository.update()`, `RepairTransactionRepository.delete()`, `SoftwareTransactionRepository.update()`
**Legacy fallback pattern:** 5 migrated functions use `if(entity.id){repo.*}else{/* direct mutation */}`

## ADR-00X — Fault Types Normalization
**Status:** Proposed (Future) — NOT started
**Documented at:** `dev/docs/ADR-00X-fault-types-normalization.md`
**Goal:** Normalize polymorphic faultTypes array (mix of strings + objects) into uniform objects with stable IDs, allowing FaultTypeRepository to inherit from Repository

## Backup/Restore Investigation (Current — Issue 2)
**Status:** In progress — Diagnostic V2 built but NOT yet tested by user
**Diagnostic file:** `C:\Users\PETER\Documents\سيستم\mshop-diag.html`

---

# Architecture Decisions

## Repository Pattern (ADR-003)
- **Decision:** All persistence must go through Repository classes
- **Rationale:** Single persistence entry point per entity, optimistic write-through, rollback on failure
- **Status:** Implemented for all transaction CREATE paths + key UPDATE/DELETE paths
- **Centralized instances:** `db_integration.js:1166-1176`

## Mapper Pattern (Phase 6.5)
- **Decision:** Every entity has a Mapper (validate, toDatabase, fromDatabase)
- **Rationale:** Structural decoupling between current localStorage format and future DB format
- **Status:** Implemented for all 7 transaction types + phones + notes + notifications + repairParts + faultTypes

## LocalAdapter (Phase 7.2)
- **Decision:** Combined Static (LOCAL_COLLECTION_MAP) + Partitioned (LOCAL_PARTITIONED_MAP) routing
- **Rationale:** Adapter handles date-based key construction, not Repository
- **Status:** Implemented

## LOCAL_COLLECTION_MAP
- **Decision:** Static collections use fixed storageKey + idField mapping
- **Entities:** phones, notes, notifications, repairParts, faultTypes

## LOCAL_PARTITIONED_MAP
- **Decision:** Partitioned collections use subKey + idField + dateField mapping
- **Entities:** phoneTransactions, usedPhoneTransactions, accessoryTransactions, softwareTransactions, walletTransactions, expenseTransactions, repairTransactions
- **Storage key:** built from `mshop_d_` + date via `_buildPartitionKey(dateStr)`

## Optimistic Cache
- **Decision:** Repositories update in-memory `data.*` arrays immediately, then persist
- **Rationale:** Instant UI feedback, rollback on persistence failure
- **Status:** Applied to all migrated repositories

## ID-based CRUD
- **Decision:** All entities use stable IDs (not array indices)
- **Status:** Applied to all migrated repositories
- **Exception:** faultTypes still uses `ft_default_N` / `ft_migrated_N` format — ADR-00X pending

## Separation of Create / Update / Delete
- **Decision:** Each operation has its own Repository method
- **Status:** Applied to all migrated repositories

## Legacy Paths Intentionally NOT Migrated
See section "Deferred Work" below.

## Backup / Restore Architecture
- **Normal backup (`exportBackup/importBackup`):** Plain JSON — no encryption, direct Storage access
- **Secure backup (`createSecureBackup/restoreSecureBackup`):** AES-GCM + PBKDF2, Web Crypto API
- **Emergency backup:** Created automatically before restore, stored in `mshop_emergency_backup`
- **Snapshot rollback:** All `mshop_*` keys snapshotted before restore, rolled back on failure
- **`_restoringBackup` flag:** Guards `save()` during restore

## Fault Types Normalization (ADR-00X — Future)
- **Decision:** Normalize polymorphic array into uniform objects
- **Status:** Deferred — NOT started

## What NOT to Expand Now
- ADR-00X scope (fault types ONLY)
- Cross-cutting persistence (softDel, rollback, trash) — needs new architecture
- Cloud sync — documented but NOT implemented
- Repository registry — needed before cross-cutting migration
- Rollback orchestrator — needed before cross-cutting migration
- Wallet balances system — future feature

---

# Current Plan

## Original Goals
1. Migrate all direct persistence from UI/business code into Repository pattern ✓ (Phases 8.3-8.7)
2. Normalize fault types format → ADR-00X (deferred)
3. Fix encrypted restore bug (Issue 2) → in progress
4. Fix file picker accept attribute (Issue 1) → complete

## What Has Been Done
1. ADR-003 (Phases 8.3-8.7) — complete and verified
2. ADR-00X documentation — complete (implementation deferred)
3. Issue 1 (File picker) — root cause confirmed, fix sufficient
4. Issue 2 (Encrypted restore) — forensic lifecycle trace complete, diagnostic V2 built

## What Remains
1. **Issue 2 root cause confirmation** — user must run the V2 diagnostic
2. **Issue 2 fix** — depends on root cause (quota vs guard timing vs other)
3. **ADR-00X implementation** — standalone phase (deferred until Issue 2 resolved)
4. Any remaining file picker refinements

## What Has Been Deferred
1. ADR-00X (Fault Types Normalization) — blocked by Issue 2
2. Cross-cutting persistence migration (softDel, rollback, trash, category management)
3. Cloud sync implementation
4. Wallet balance system

## What Is Out of Scope
- Any new features not related to current issues
- Architecture changes beyond ADR-003 scope
- UI redesign
- Database migration (PostgreSQL, Supabase, etc.)
- Multi-device sync

---

# Files Modified (ADR-003 Phases 8.3 - 8.7 + Diagnostic)

## Core Source Files Changed During ADR-003

### dev/js/db_integration.js
- **What changed:** Added Repository base class, LocalAdapter, LOCAL_COLLECTION_MAP, LOCAL_PARTITIONED_MAP, entity-specific Repository classes, centralized instances
- **Why:** ADR-003 Repository Migration
- **Phase:** 8.3, 8.4, 8.5, 8.6, 8.7
- **Current status:** Production — all changes active

### dev/js/entity_mappers.js
- **What changed:** Added entity-specific mappers with validate(), toDatabase(), fromDatabase(); fixed field name mismatches (snapshotName→name, snapshotCategory→category, etc.)
- **Why:** Phase 6.5 — required for ADR-003
- **Phase:** 6.5, 8.3-8.7
- **Current status:** Production — all changes active

### dev/js/accessories.js
- **What changed:** `addAcc()` → `accTransRepo.create()`
- **Why:** ADR-003 Phase 8.4
- **Current status:** Production

### dev/js/expenses.js
- **What changed:** `addExp()` → `expTransRepo.create()`
- **Why:** ADR-003 Phase 8.4
- **Current status:** Production

### dev/js/cash.js
- **What changed:** `addCash()` → `walletTransRepo.create()`
- **Why:** ADR-003 Phase 8.5
- **Current status:** Production

### dev/js/software.js
- **What changed:** `addSw()` → `softwareTransactionRepo.create()`, `toggleSwField()` → `softwareTransactionRepo.update()`
- **Why:** ADR-003 Phase 8.5, 8.7
- **Current status:** Production

### dev/js/usedPhones.js
- **What changed:** `addUsed()` → `usedPhoneTransactionRepo.create()`
- **Why:** ADR-003 Phase 8.5
- **Current status:** Production

### dev/js/phones.js
- **What changed:** `confirmSell()` → `phoneTransactionRepo.create()`
- **Why:** ADR-003 Phase 8.5
- **Current status:** Production

### dev/js/repair.js
- **What changed:** `saveRepair()` CREATE→repo, EDIT→repo.update, `updateRepairStatus()`→repo.update, `toggleRepairField()`→repo.update, `deleteRepair()`→repo.delete; removed trailing `save()`
- **Why:** ADR-003 Phase 8.6, 8.7
- **Current status:** Production

### dev/js/notes.js
- **What changed:** `saveNote()` → `noteRepo.*`, `toggleNotesDone()` → `noteRepo.*`, `deleteNote()` → `noteRepo.*`
- **Why:** ADR-003 Phase 8.3
- **Current status:** Production

### dev/js/notifications.js
- **What changed:** `npAction()` → `noteRepo.update()`
- **Why:** ADR-003 Phase 8.3
- **Current status:** Production

### dev/js/settings.js
- **What changed:** `addFaultType()` → `faultTypeRepo.*`, `deleteFaultType()` → `faultTypeRepo.*`, `toggleFaultType()` → `faultTypeRepo.*`, `addRepairPart()` → `repairPartRepo.*`
- **Why:** ADR-003 Phase 8.3
- **Current status:** Production

## Files NOT Changed
- **backup.js** — No ADR-003 changes (backup system is separate)
- **storage.js** — No ADR-003 changes (Repository layer abstracts above it)
- **ui.js** — No ADR-003 changes (softDel, rollback, trash kept legacy)
- **app.js** — No ADR-003 changes
- **helpers.js** — No ADR-003 changes
- **reports.js** — No ADR-003 changes
- **analytics.js** — No ADR-003 changes
- **sync.js** — No ADR-003 changes (documentation only)
- **db_foundation.js** — No ADR-003 changes (documentation only)
- **calculator.js** — No ADR-003 changes
- **dev/index.html** — No ADR-003 changes (the load order didn't change)

## Diagnostic Files (Temporary)

### mshop-diag.html (V2 — latest)
- **What changed:** Based on dist/index.html, added diagnostic panel overlay CSS, replaced `restoreSecureBackup` inner try-catch with diagnostic version, added `_showDiagPanel()` function
- **Why:** Investigate Issue 2 — encrypted restore drops today's sales
- **Changes from production:** Disables reload/logout, overrides `save()` to no-op, removes `beforeunload`, shows diagnostic results inline
- **Current status:** NOT yet tested by user

### mshop-regression-test.html
- **What changed:** Based on dev build, contains ADR-003 repository code
- **Why:** Regression testing after repository migration
- **Current status:** Preserved but diagnostic focus is on mshop-diag.html

---

# Current Production Build

**Build file:** `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dist\index.html`
**Size:** 466,661 bytes
**Build date:** 2026-07-27 (estimate — last ADR-003 build)
**Build command:** `python3 dev/build.py` (run from project root)
**Status:** Last known build succeeded
**Contents:** Single file — inlines CSS (from `dev/css/style.css`) + all JS files (from `dev/js/*.js` in `dev/index.html` load order)

---

# DEV Folder Structure

```
dev/
├── build.py                          # Python build script
├── index.html                        # Dev HTML (script tags point to individual JS files)
├── css/
│   └── style.css                     # All styles (350 lines)
├── js/
│   ├── helpers.js                    # DOM shortcuts, showToast, debounce, date utils (48 lines)
│   ├── db_foundation.js              # Phase 5 — Entity schema docs only (NOT runtime)
│   ├── storage.js                    # Storage API + loadAll/loadData/save + migration (213 lines)
│   ├── db_integration.js             # Phase 6 — Repository pattern (1184 lines)
│   ├── entity_mappers.js             # Phase 6.5 — Mappers (522 lines)
│   ├── security.js                   # PIN lock, admin unlock (82 lines)
│   ├── ui.js                         # Screen navigation, render functions, rollback, trash (264 lines)
│   ├── settings.js                   # Settings page, fault types, repair parts (109 lines)
│   ├── accessories.js                # Accessory transactions (3,895 bytes)
│   ├── usedPhones.js                 # Used phone transactions (1,261 bytes)
│   ├── expenses.js                   # Expense transactions (2,641 bytes)
│   ├── cash.js                       # Wallet/cash transactions (6,378 bytes)
│   ├── software.js                   # Software transactions (1,104 bytes)
│   ├── notifications.js              # Notification system (6,532 bytes)
│   ├── notes.js                      # Notes system (6,103 bytes)
│   ├── calculator.js                 # Calculator utility (3,346 bytes)
│   ├── reports.js                    # Monthly reports (24,983 bytes)
│   ├── analytics.js                  # Analytics dashboard (25,713 bytes)
│   ├── sync.js                       # Sync architecture (12,522 bytes — docs only)
│   ├── backup.js                     # Backup/restore system (28,477 bytes)
│   ├── phones.js                     # Phone inventory (65,797 bytes — LARGEST)
│   ├── repair.js                     # Repair management (13,772 bytes)
│   └── app.js                        # Init, constants, global state, event handlers (22,135 bytes)
├── docs/
│   ├── ADR-003-repository-migration.md   # ADR-003 documentation (195 lines)
│   └── ADR-00X-fault-types-normalization.md  # ADR-00X proposal (87 lines)
└── tests/
    ├── dom-stub.js
    ├── perf_baseline.js
    ├── storage_api_test.js
    ├── phase2b_financial_test.js
    ├── phase3a_plus_test.js
    ├── phase3a_round2_test.js
    ├── phase4_sync_arch_test.js
    ├── phase5_db_foundation_test.js
    ├── phase6_db_integration_test.js
    ├── phase6_5_entity_mappers_test.js
    ├── regression_test.js
    ├── stress_test.js
    ├── undo_stress_test.js
    ├── backup_system_test.js
    └── backup_share_reminder_test.js
```

---

# Known Issues

## Critical

### Issue 2 — Encrypted Restore Drops Today's Sales
- **Current behavior:** After restoring encrypted backup from Settings:
  1. "جاري التحميل" overlay appears
  2. System logs out / returns to login
  3. After re-login: Daily dashboard shows 0 transactions (empty data)
  4. Monthly page shows data correctly (because it reads Storage.search directly)
  5. Today's data is MISSING from the global `data` variable
- **Root cause:** CONFIRMED: Monthly reads `Storage.search('mshop_d_'+ym)` directly. Dashboard reads global `data` variable set by `loadData()`. The `data` global ends up empty. WHY it ends up empty is SUSPECTED but NOT VERIFIED.
- **Suspected root causes:**
  1. **Guard timing bug:** `_restoringBackup` reset to `false` in `finally` (backup.js:392) BEFORE the 1200ms `location.reload()` fires (backup.js:382). If `beforeunload`/`visibilitychange` fires during this gap, `save()` runs unguarded, writing whatever `data` is (potentially empty/default) to `mshop_d_TODAY`.
  2. **Emergency backup quota failure:** Emergency backup (`mshop_emergency_backup`) doubles localStorage usage. If data > ~2.5MB, this pushes over 5MB limit, causing `saveRaw()` for today's key to fail silently. `loadData()` then returns empty default, `data` remains empty, and the gap-triggered `save()` writes empty data.
  3. **Legacy format keys (non `mshop_` prefix) not restored:** The restore writes all `mshop_*` keys, but `search()` + `exists()` filters for old `shop_v1_` prefixes may miss some keys. (LOW probability)
- **Confidence:** SUSPECTED — NOT YET VERIFIED
- **Affected files:** `backup.js:333-395` (restoreSecureBackup), `storage.js:25-28` (saveRaw), `storage.js:118` (save function)
- **Next diagnostic/action:** User runs `mshop-diag.html` V2 from Settings page → performs encrypted restore → views inline diagnostic panel

## High

### Issue 1 — Encrypted Backup File Invisible in File Picker
- **Current behavior:** File picker shows .mshop files as disabled/grayed when `accept=".json"` is set
- **Root cause:** CONFIRMED: `.mshop` is not a MIME type. The `accept` attribute on the file input only had `.json` — browsers don't associate `.mshop` with any MIME type, so files are filtered out
- **Fix applied:** `accept=".json,.mshop,application/json"` (added `.mshop` + `application/octet-stream` alternative)
- **Confidence:** CONFIRMED — FIX SUFFICIENT
- **Affected files:** `settings.js` (the restore file input accept attribute)
- **Next action:** Verify in browser

## Medium

### saveRaw Silent Failure
- **Current behavior:** `Storage.saveRaw()` returns `false` on failure with `console.error` only — no UI notification
- **Root cause:** CONFIRMED: `storage.js:27` — `catch(e){ console.error(...); alert(...); ... return false; }`. The `alert()` in saveRaw is triggered on failure, but during restore the system is locked/overlaid, making it invisible
- **Confidence:** CONFIRMED
- **Affected files:** `storage.js:25-28`

### Backup Reminder Popup Not Shown in Diagnostic Build
- **Current behavior:** NOT a bug — the diagnostic build overrides `save()` and removes `beforeunload`, which may affect reminder timing
- **Next action:** Not relevant for production

## Low

### Fault Types Polymorphic Format
- **Current behavior:** `faultTypes` array contains mixed strings and objects
- **Root cause:** CONFIRMED — legacy format, ADR-00X deferred
- **Next action:** ADR-00X implementation after Issue 2 resolved

## Investigation Pending

### Restore Behavior from Monthly Accounts Page
- **Current behavior:** Encrypted backup restore from "Monthly Accounts" vs "Settings" may behave differently
- **Next action:** Test after Issue 2 root cause confirmed

### Normal (non-encrypted) Restore Behavior
- **Current behavior:** `importBackup()` (non-encrypted) at `backup.js:32` does NOT create emergency backup, does NOT have snapshot rollback, but uses same `location.reload()` pattern
- **Next action:** Verify if normal restore has the same issue after fixing encrypted restore

### Legacy `_restoringBackup` Guard on `save()`
- **Current behavior:** `save()` at `storage.js:118` checks `typeof _restoringBackup !== 'undefined' && _restoringBackup`
- **Risk:** If `backup.js` hasn't loaded yet (script error, network issue), `_restoringBackup` is undefined and `save()` runs normally
- **Next action:** Confirm if this is exploitable

---

# Backup / Restore Status

## Normal Backup (exportBackup)
- **Status:** Working
- **Format:** Plain JSON `.json` file
- **Flow:** `exportBackup()` → `gatherAllBackupData()` → `dlJSON()`
- **File picker:** Accepts `.json` files
- **Known issues:** None

## Normal Restore (importBackup)
- **Status:** Working (assumed — NOT formally verified)
- **Format:** Reads JSON file, expects `{data: {...}}` structure
- **Flow:** `importBackup(input)` → reads file → `Storage.saveRaw()` each key → `loadAll(); loadData(); renderAll()` → `location.reload()` after 1200ms
- **Known issues:** Same `location.reload()` pattern as encrypted restore — may have same guard timing bug

## Encrypted Backup (createSecureBackup)
- **Status:** Working
- **Format:** `.mshop` file with `{mshopBackup: true, meta: {...}, enc: {...}}` structure
- **Encryption:** AES-GCM-256 + PBKDF2 (150k iterations)
- **Flow:** `createSecureBackup(password)` → `gatherAllBackupData()` → encrypt → validate immediately → download
- **Known issues:** File picker `accept` attribute fixed (Issue 1, see above)

## Encrypted Restore (restoreSecureBackup) — THE ACTIVE BUG
- **Status:** BROKEN — drops today's sales
- **Flow:**
  1. `restoreSecureBackup(file, password)` called
  2. `validateBackupObject()` — decrypt + checksum + parse + migrate
  3. `lockAppForRestore(true)` — shows "جاري التحميل" overlay, sets `_restoringBackup=true`
  4. Emergency backup created via `createSecureBackup(null)` — stores in `mshop_emergency_backup`
  5. Snapshot taken: all `mshop_*` keys saved to `snapshot` object
  6. Write loop: `Object.entries(v.data).forEach(([k,val]) => Storage.saveRaw(k, payload))`
  7. `loadAll(); loadData()` — reloads data from localStorage into globals
  8. `showToast('تمت الاستعادة بنجاح — جاري إعادة التحميل...', 'ok')`
  9. `setTimeout(() => location.reload(), 1200)` — reload scheduled
  10. `return true`
  11. **`finally` block runs:** `lockAppForRestore(false)` → sets `_restoringBackup=false`, hides overlay
  12. Page reloads after 1200ms
  13. On reload: INIT sequence runs → `migrate()` → `loadAll()` → `loadData()` → etc.
- **Suspected bug:** Between steps 11 and 12, `_restoringBackup=false`. If `beforeunload` or `visibilitychange` fires, `save()` runs unguarded and writes whatever `data` is (potentially empty/overwritten by restore's loadData at step 7, or default if step 7 failed due to quota)
- **Diagnostic attempts:**
  - V1: Used `alert()` — failed because page reloads before user can see it
  - V2: Uses inline diagnostic panel — blocks `beforeunload`, overrides `save()`, shows results in-page (NOT yet tested)
- **Confidence:** SUSPECTED — NOT VERIFIED

---

# Diagnostic Tools

## mshop-diag.html (V2 — Current)
- **Purpose:** Investigate Issue 2 — encrypted restore drops today's sales
- **Location:** `C:\Users\PETER\Documents\سيستم\mshop-diag.html`
- **Production or temporary:** Temporary
- **Safe to delete:** Yes (after Issue 2 resolved)
- **Needed for next investigation:** YES — this is the primary diagnostic tool
- **How it works:**
  - Modified version of `restoreSecureBackup` that:
    1. Removes `beforeunload` listener
    2. Overrides `save()` to no-op
    3. Disables `location.reload()`
    4. Tracks every key write with success/failure + byte count
    5. Performs post-write verification (expected bytes vs actual stored bytes from localStorage)
    6. Captures TODAY key position, existence, transaction counts
    7. Captures runtime `data` object state after restore
    8. Shows all results in an inline diagnostic panel overlay (no alert, no reload)
  - File is a self-contained single HTML file (based on production build + modifications)

## mshop-regression-test.html
- **Purpose:** Regression testing after ADR-003 repository migration
- **Location:** `C:\Users\PETER\Documents\سيستم\mshop-regression-test.html`
- **Production or temporary:** Temporary
- **Safe to delete:** Yes (or keep for future regression tests)
- **Needed for next investigation:** Not directly (diag.html is the focus)

---

# Current Risks

1. **Issue 2 data loss:** Encrypted restore can silently destroy today's transaction data. User should NOT perform encrypted restores on production data until this is fixed.
2. **Emergency backup doubles storage:** During restore, `createSecureBackup(null)` is called, which creates a full backup stored in `mshop_emergency_backup` as a nested JSON string — potentially doubling localStorage usage. Users near the 5MB limit risk QuotaExceededError during restore.
3. **saveRaw has no UI feedback:** Storage.saveRaw fails silently (console.error + alert) — during restore when the UI is locked, the alert is invisible.
4. **FaultTypes migration risk:** ADR-00X involves one-time data migration. If interrupted, data could be inconsistent (mitigated by idempotency).
5. **Browser storage limit:** 5MB localStorage limit per origin. No monitoring or compression in place.

---

# Deferred Work

| Path | Location | Reason to Keep Legacy | Risk | Future Status |
|------|----------|-----------------------|------|---------------|
| `softDel()` | `ui.js:139` | Cross-cutting — dispatches across all entity types | Low — works correctly | Needs repo registry architecture |
| `rollbackTransaction()` / `finishRollback()` | `ui.js:196-248` | Cross-cutting — operates on arbitrary date partitions, includes phone inventory reversal | Low — works correctly | Needs rollback orchestrator |
| `restoreTrash()` | `ui.js:141` | Cross-cutting — operates on arbitrary date partitions | Low — works correctly | Same as above |
| `permDelTrash()` | `ui.js:143` | Infrastructure — trash management | Low — works correctly | When trash system is redesigned |
| `clearOldTrash()` | `ui.js:145` | Infrastructure — trash management | Low — works correctly | When trash system is redesigned |
| `markAllNotifsRead()` | `notifications.js:6` | Static collection (mshop_notifs) — not a partitioned transaction | Low — works correctly | When notifications get Repository |
| `calcHist.splice()` | `calculator.js:25` | Infrastructure — calc history | Low — works correctly | When calculator is refactored |
| `delCA/delCU/delCE/delCatDyn` | accessories/usedPhones/expenses/settings | Category management — not transactions | Low — works correctly | When category system is redesigned |
| FaultTypes normalization | `ADR-00X` | Polymorphic format | Medium — works, but architectural exception | Future implementation |
| Cloud sync | `sync.js` | Not implemented — documentation only | Low — no sync needed yet | Future implementation |

---

# Next Step

## Exact Starting Point for New Chat

### 1. First file to review:
`C:\Users\PETER\Documents\سيستم\mshop-diag.html`
- This IS the diagnostic V2 build
- Open in browser, navigate to Settings, perform encrypted restore
- View the inline diagnostic panel results

### 2. Second file to review:
`C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\backup.js`
- Specifically `restoreSecureBackup()` at line 333
- Understand the restore flow and guard timing issue

### 3. Third file to review:
`C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\storage.js`
- Specifically `saveRaw()` at line 25, `save()` at line 118, `loadData()` at line 110

### 4. Current problem to focus on:
**Issue 2 — Encrypted restore drops today's sales**
- User must run `mshop-diag.html` V2 diagnostic
- Report diagnostic panel results back
- Based on results, confirm root cause

### 5. Last completed phase:
**ADR-003 Phase 8.7** (Repair & Software Update/Delete)

### 6. Next natural phase after Issue 2:
- Fix Issue 2 root cause
- **Then** ADR-00X (Fault Types Normalization) — documented, deferred

### Files NOT to modify:
- `dev/js/db_foundation.js` — documentation only, NOT runtime
- `dev/js/sync.js` — documentation only, NOT implemented
- `dev/tests/` — test files for reference, NOT for production modification
- `dev/docs/` — documentation files

---

# Rules For Future Work

- **Audit before implementation.** Always understand the full context before changing anything.
- **Plan before editing.** Confirm the approach before writing code.
- **One task at a time.** Never mix unrelated bug fixes with feature work.
- **Never mix unrelated bug fixes with feature work.** If a new issue appears during feature work, document it but do NOT fix it in the same session.
- **Do not expand scope unnecessarily.** Stay focused on the current phase/issue.
- **Preserve existing functionality.** Never break what works.
- **Do not change architecture unless necessary.** The Repository pattern is recent — no more architectural changes until Issue 2 is resolved.
- **Verify before declaring PASS.** Nothing is "verified" without evidence.
- **Never assume a fix is verified without evidence.** Test results or user confirmation required.
- **Keep deferred/cross-cutting work deferred.** Do NOT start ADR-00X or any cross-cutting migration until Issue 2 is resolved.
- **Do not modify the approved plan unless genuinely necessary.**
- **If a new issue appears, audit it first.** Do not start debugging without understanding the full context.
- **Do not start implementation without explicit approval when the workflow requires approval.**
- **Read the project state and ADR documents before starting work in a new chat.** This handoff document is the primary reference.
- **Arabic comments and variable names** — the project uses mixed Arabic/English naming. Preserve both.
- **Do NOT convert the project to a framework** (React, Vue, etc.) — it must remain a single-file offline HTML application.
