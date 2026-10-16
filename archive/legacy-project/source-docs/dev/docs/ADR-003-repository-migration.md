# ADR-003: Repository Migration

**Status:** Complete
**Completed:** 2026-07-26

---

## Overview

Migrate all direct `Storage.save()` calls from UI/business code into Repository classes, establishing a single persistence entry point for every entity. Repositories own the in-memory cache, provide optimistic write-through, and roll back on failure.

---

## Completed Phases

### Phase 8.3 — Static Repositories (Notes, Repair Parts, Fault Types)

**Completed:** 2026-07-25
**Verified:** Yes
**Architecturally Approved:** Yes

**Entities migrated:**
- `NoteRepository` — extends `Repository`, adapter-based CRUD, optimistic cache on `data.notes`
- `RepairPartRepository` — extends `Repository`, adapter-based CRUD, optimistic cache on `data.repairParts`
- `FaultTypeRepository` — standalone (see Architectural Exception below)

**Call sites migrated:**
- `notes.js`: `saveNote()`, `toggleNotesDone()`, `deleteNote()` → `noteRepo.*`
- `notifications.js`: `npAction()` → `noteRepo.update()`
- `settings.js`: `addFaultType()`, `deleteFaultType()`, `toggleFaultType()` → `faultTypeRepo.*`; `addRepairPart()`, inline delete → `repairPartRepo.*`
- `repair.js`: `saveRepair()` part qty decrement → `repairPartRepo.update()`

**Centralized instances:** `db_integration.js:1100-1102`
```js
const noteRepo = new NoteRepository();
const repairPartRepo = new RepairPartRepository();
const faultTypeRepo = new FaultTypeRepository();
```

---

### Phase 8.4 — Accessory & Expense Transaction Repositories

**Completed:** 2026-07-26
**Verified:** Yes

**Entities migrated:**
- `AccessoryTransactionRepository` — enhanced with `initCache()` + `create()`, optimistic cache on `data.acc`
- `ExpenseTransactionRepository` — enhanced with `initCache()` + `create()`, optimistic cache on `data.exp`

**Mapper fixes:**
- `AccessoryTransactionMapper.validate()`: `['snapshotName']` → `['name']`
- `ExpenseMapper.validate()`: `['snapshotCategory','amount']` → `['category','amount']`

**Call sites migrated:**
- `accessories.js`: `addAcc()` → `accTransRepo.create()`
- `expenses.js`: `addExp()` → `expTransRepo.create()`

---

### Phase 8.5 — Phone, Used Phone, Software & Wallet Transaction Repositories

**Completed:** 2026-07-26
**Verified:** Yes

**Entities migrated:**
- `PhoneTransactionRepository` — created with `initCache()` + `create()`, optimistic cache on `data.phones`
- `UsedPhoneTransactionRepository` — enhanced with `initCache()` + `create()`, optimistic cache on `data.used`
- `SoftwareTransactionRepository` — enhanced with `initCache()` + `create()`, optimistic cache on `data.sw`
- `WalletTransactionRepository` — enhanced with `initCache()` + `create()`, optimistic cache on `data.cash`

**Mapper fixes:**
- `PhoneTransactionMapper.validate()`: `['phoneId','snapshotModelName']` → `['modelId','modelName']`
- `UsedPhoneTransactionMapper.validate()`: `['snapshotName']` → `['name']`
- `SoftwareTransactionMapper.validate()`: `['snapshotName']` → `['name']`
- `WalletTransactionMapper.validate()`: `['walletName','cashType']` → `['service','cashType']`

**Call sites migrated:**
- `cash.js`: `addCash()` → `walletTransRepo.create()`
- `software.js`: `addSw()` → `softwareTransactionRepo.create()`
- `usedPhones.js`: `addUsed()` → `usedPhoneTransactionRepo.create()`
- `phones.js`: `confirmSell()` → `phoneTransactionRepo.create()` (transaction recording only, NOT inventory)

---

### Phase 8.6 — Repair Transaction Repository (CREATE)

**Completed:** 2026-07-26
**Verified:** Yes

**Entities migrated:**
- `RepairTransactionRepository` — created with `initCache()` + `create()`, optimistic cache on `data.repairs`

**Mapper fixes:**
- `RepairMapper.validate()`: `['snapshotBrand','snapshotModel']` → `['brand','model']`
- Removed `_validateUUIDIfPresent` (repair IDs use `rep_<timestamp>`, not UUIDs)

**Call sites migrated:**
- `repair.js`: `saveRepair()` CREATE path → `repairTransactionRepo.create()`

---

### Phase 8.7 — Repair & Software Update/Delete + Base Class Options

**Completed:** 2026-07-26
**Verified:** Yes

**Base class changes:**
- `Repository.update(id, changes, options = {})` — extended signature, `options` forwarded to `LocalAdapter.update()`
- `Repository.delete(id, options = {})` — extended signature, `options` forwarded to `LocalAdapter.delete()`

**Repository methods added:**
- `RepairTransactionRepository.update(id, changes, options)` — optimistic cache update + adapter update + sync result
- `RepairTransactionRepository.delete(id, options)` — optimistic splice from `data.repairs` + adapter delete + rollback on failure
- `SoftwareTransactionRepository.update(id, changes, options)` — optimistic cache update + adapter update + sync result

**Call sites migrated:**
- `repair.js`: `saveRepair()` EDIT path → `repairTransactionRepo.update()` with legacy fallback
- `repair.js`: `updateRepairStatus()` → `repairTransactionRepo.update()` with legacy fallback
- `repair.js`: `toggleRepairField()` → `repairTransactionRepo.update()` with legacy fallback
- `repair.js`: `deleteRepair()` → `repairTransactionRepo.delete()` with legacy fallback
- `software.js`: `toggleSwField()` → `softwareTransactionRepo.update()` with legacy fallback

**Shared `save()` removed:**
- `saveRepair()` line 64: removed trailing `save()` (both CREATE and EDIT now go through repos)

**Legacy fallback pattern (all 5 migrated functions):**
```js
if (entity.id) {
  repo.update(entity.id, changes, { date: sel });
} else {
  // original direct mutation + save()
}
```

---

## Architectural Exception — FaultTypeRepository

**Status:** Intentional exception — not technical debt
**Approved:** 2026-07-25

`FaultTypeRepository` intentionally does NOT inherit from `Repository`. This is required by the current domain model. See ADR-00X for the planned normalization.

---

## Centralized Repository Instances

All at `db_integration.js:1100-1109`:

```js
const noteRepo           = new NoteRepository();
const repairPartRepo     = new RepairPartRepository();
const faultTypeRepo      = new FaultTypeRepository();
const phoneRepo          = new PhoneRepository();
const accTransRepo       = new AccessoryTransactionRepository();
const expTransRepo       = new ExpenseTransactionRepository();
const phoneTransactionRepo    = new PhoneTransactionRepository();
const usedPhoneTransactionRepo = new UsedPhoneTransactionRepository();
const softwareTransactionRepo  = new SoftwareTransactionRepository();
const walletTransactionRepo    = new WalletTransactionRepository();
const repairTransactionRepo    = new RepairTransactionRepository();
const repairRepo          = new RepairRepository();
```

---

## Remaining Legacy Paths (Intentional)

These paths remain as direct `data.*` + `save()` mutations. They are cross-cutting concerns that dispatch across all entity types and require new architecture (repo registry, rollback orchestrator) to migrate:

| Path | Location | Reason |
|------|----------|--------|
| `softDel()` | `ui.js:139` | Cross-cutting generic — dispatches across all entity types |
| `rollbackTransaction()` / `finishRollback()` | `ui.js:196-248` | Cross-cutting — operates on arbitrary date partitions, includes phone inventory reversal |
| `restoreTrash()` | `ui.js:141` | Cross-cutting — operates on arbitrary date partitions |
| `permDelTrash()` | `ui.js:143` | Infrastructure — trash management |
| `clearOldTrash()` | `ui.js:145` | Infrastructure — trash management |
| `markAllNotifsRead()` | `notifications.js:6` | Static collection (`mshop_notifs`) — not a partitioned transaction |
| `calcHist.splice()` | `calculator.js:25` | Infrastructure — calc history |
| `delCA/delCU/delCE/delCatDyn` | `accessories/usedPhones/expenses/settings` | Category management — not transactions |

---

## Verification Summary

| Category | Migrated | Legacy (Intentional) |
|----------|----------|---------------------|
| Transaction CREATE | `addAcc`, `addExp`, `addCash`, `addSw`, `addUsed`, `confirmSell`, `saveRepair` (CREATE) | — |
| Transaction UPDATE | `saveRepair` (EDIT), `updateRepairStatus`, `toggleRepairField`, `toggleSwField` | `toggleAccField`, `toggleExpField`, `toggleRepairPaid`, `toggleRepairDelivered` (out of scope) |
| Transaction DELETE | `deleteRepair` | — |
| Static collections | `saveNote`, `toggleNotesDone`, `deleteNote`, `addFaultType`, `deleteFaultType`, `toggleFaultType`, `addRepairPart` | — |
| Cross-cutting | — | `softDel`, `rollback*`, `restoreTrash` |

All migrated paths verified: zero direct `Storage.save()` calls for migrated entities in any UI/business file.
