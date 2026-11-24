# HANDOFF INDEX — File Reference for Next Chat

## Project Source Files

| File | Purpose | Importance | Last Change | Why Next Chat May Need It |
|------|---------|------------|-------------|--------------------------|
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\build.py` | Build script (Python) | Medium | Never modified | Understand build process |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\index.html` | Dev HTML entry point | High | Never modified | Script load order, HTML structure |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\css\style.css` | All styles (350 lines) | Medium | Never modified | Styling reference |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\helpers.js` | DOM utils, showToast, date | Medium | Never modified | Utility functions |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\storage.js` | Storage API + save/load | **CRITICAL** | Never modified | `saveRaw()`, `save()`, `loadData()` — Issue 2 core |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\db_integration.js` | Repository pattern (1184 lines) | **CRITICAL** | ADR-003 (Phases 8.3-8.7) | Repository classes, adapter, entity maps |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\entity_mappers.js` | Mappers (522 lines) | High | ADR-003 (Phases 8.3-8.7) | Mapper validate/toDB/fromDB methods |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\backup.js` | **Backup/restore system (495 lines)** | **CRITICAL** | Never modified (ADR-003 skipped this) | `restoreSecureBackup()` — Issue 2 target |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\app.js` | Init, globals, event handlers | High | Never modified | `beforeunload` handler, init sequence, `_restoringBackup` |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\ui.js` | Rendering, navigation, rollback | Medium | Never modified (kept legacy) | `softDel()`, `rollbackTransaction()` — legacy patterns |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\security.js` | PIN lock, admin unlock | Low | Never modified | `tryUnlock()` — auth flow |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\settings.js` | Settings page UI | Medium | ADR-003 (Phase 8.3) | Restore UI, fault types, repair parts |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\reports.js` | Monthly reports | **High** | Never modified | `getMonthData()` — reads Storage.search directly (key to Issue 2) |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\accessories.js` | Accessory transactions | Medium | ADR-003 (Phase 8.4) | Repository usage example |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\phones.js` | Phone inventory (largest file) | Medium | ADR-003 (Phase 8.5) | Inventory CRUD |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\repair.js` | Repair management | Medium | ADR-003 (Phase 8.6-8.7) | Repository update/delete patterns |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\software.js` | Software transactions | Medium | ADR-003 (Phase 8.5-8.7) | Repository update pattern |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\cash.js` | Wallet/cash transactions | Medium | ADR-003 (Phase 8.5) | Repository create example |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\usedPhones.js` | Used phone transactions | Medium | ADR-003 (Phase 8.5) | Repository create example |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\expenses.js` | Expense transactions | Medium | ADR-003 (Phase 8.4) | Repository create example |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\notes.js` | Notes system | Medium | ADR-003 (Phase 8.3) | Repository CRUD example |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\notifications.js` | Notification system | Medium | ADR-003 (Phase 8.3) | Repository update example |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\analytics.js` | Analytics dashboard | Low | Never modified | Financial analysis |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\db_foundation.js` | Entity schema (DOCS ONLY) | Low | Never modified | NOT runtime code |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\sync.js` | Sync architecture (DOCS ONLY) | Low | Never modified | NOT implemented |
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dev\js\calculator.js` | Calculator utility | Low | Never modified | Calc history |

## Production Build

| File | Purpose | Importance | Last Change |
|------|---------|------------|-------------|
| `C:\Users\PETER\.gemini\antigravity\scratch\ai-studio-import\dist\index.html` | Production single-file app (466,661 bytes) | **CRITICAL** | Last ADR-003 build |

## Documentation & ADRs

| File | Purpose | Importance | Last Change |
|------|---------|------------|-------------|
| `dev/docs/ADR-003-repository-migration.md` | ADR-003 full documentation | **CRITICAL** | 2026-07-26 |
| `dev/docs/ADR-00X-fault-types-normalization.md` | ADR-00X proposal (future) | Medium | 2026-07-25 |
| `PROJECT_HANDOFF.md` | This handoff document | **CRITICAL** | 2026-07-28 |
| `HANDOFF_INDEX.md` | This file index | **CRITICAL** | 2026-07-28 |

## Diagnostic / Temporary Files

| File | Purpose | Importance | Safe to Delete? |
|------|---------|------------|-----------------|
| `C:\Users\PETER\Documents\سيستم\mshop-diag.html` | Issue 2 diagnostic V2 (479,383 bytes) | **CRITICAL — NOT YET USED** | After Issue 2 resolved |
| `C:\Users\PETER\Documents\سيستم\mshop-regression-test.html` | Regression test after ADR-003 (465,948 bytes) | Medium | Yes |

## Original/Archive Files

| File | Purpose | Size |
|------|---------|------|
| `..ai-studio-import\محل_الموبايلات-61-39-27.html` | Original pre-refactor app | 422,348 bytes |
| `..ai-studio-import\محل_الموبايلات_نسخة_تطوير_معيارية.zip` | Development archive | Unknown |
| `..ai-studio-import\README.md` | Auto-generated import instructions | 8 lines |
| `..ai-studio-import\المحادثة.txt` | Conversation transcript | 145,068 bytes |

## Tests

| Directory | Contents | Purpose |
|-----------|----------|---------|
| `dev/tests/` | 15 JS test files | Phase-specific tests (phases 2B-6.5, backup, stress, regression, perf) |

## How to Find the Right File

### For Issue 2 (Encrypted Restore Bug):
1. `dev/js/backup.js` → `restoreSecureBackup()` at line 333
2. `dev/js/storage.js` → `saveRaw()` at line 25, `save()` at line 118, `loadData()` at line 110
3. `dev/js/app.js` → `beforeunload` handler at line 312, `_restoringBackup` guard, init sequence at lines 316-335
4. `dev/js/reports.js` → `getMonthData()` at line 12 (reads Storage.search directly)
5. `C:\Users\PETER\Documents\سيستم\mshop-diag.html` → diagnostic V2 (run this first)

### For ADR-003 Architecture Reference:
1. `dev/js/db_integration.js` → Repository base class, LocalAdapter, entity repos at lines 1166-1176
2. `dev/js/entity_mappers.js` → BaseMapper + entity mappers
3. `dev/docs/ADR-003-repository-migration.md` → full documentation

### For ADR-00X (Future):
1. `dev/docs/ADR-00X-fault-types-normalization.md`
2. `dev/js/db_integration.js` → `FaultTypeRepository` class (standalone, NOT extending Repository)
3. `dev/js/settings.js` → fault type UI functions
