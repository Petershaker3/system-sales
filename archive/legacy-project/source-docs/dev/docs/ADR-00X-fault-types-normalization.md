# ADR-00X — Fault Types Normalization

**Status:** Proposed (Future)
**Blocked by:** ADR-003 Phase 8.3 completion (done)
**Depends on:** None currently
**Created:** 2026-07-25

---

## Context

`FaultTypeRepository` is currently a standalone class that does not extend `Repository` (`db_integration.js:815-872`). This is an intentional architectural exception, documented in ADR-003, caused by three layer-level incompatibilities:

1. `FaultTypeMapper` cannot handle the polymorphic data format
2. The adapter's `idField: 'id'` is incompatible with string primitives
3. The UI uses array-index identity instead of stable IDs

This ADR proposes resolving all three incompatibilities in a single coordinated change.

## Decision

Normalize `faultTypes` from a polymorphic array of mixed strings and `{name, hidden}` objects into a uniform array of objects with stable IDs.

### Goals

1. **Introduce stable IDs** — every fault type gets a unique, persistent identifier
2. **Normalize data format** — all items become `{ id, name, hidden }` objects; no more plain strings
3. **Remove polymorphic storage** — eliminate `typeof` checks in rendering and repository code
4. **Remove index-based identity** — UI passes stable IDs instead of array indices
5. **Allow `FaultTypeRepository` to inherit from `Repository`** — use the standard `Repository → Mapper → Adapter → Storage` pipeline
6. **Eliminate the architectural exception** — `FaultTypeRepository` becomes a standard repository like `NoteRepository` and `RepairPartRepository`

### Scope of Changes

| Area | Current | After Normalization |
|---|---|---|
| Data format | `["Short Circuit", { name: "Screen Crash", hidden: true }]` | `[{ id: "ft_...", name: "Short Circuit", hidden: false }, { id: "ft_...", name: "Screen Crash", hidden: true }]` |
| Storage schema | Mixed strings/objects in `mshop_fault_types` | Uniform objects with `id` field in `mshop_fault_types` |
| FaultTypeMapper | Handles strings only | Handles `{ id, name, hidden }` objects |
| FaultTypeRepository | Standalone, direct Storage access | Extends Repository, standard pipeline |
| UI identity | `deleteFaultType(i)` — array index | `deleteFaultType(id)` — stable ID |
| `typeof` checks | Required everywhere (`typeof f === 'string'`) | Eliminated |
| Migration | N/A | One-time migration of existing data on load |

### Migration Strategy

On application load, before `initCache()`:
1. Read raw `mshop_fault_types` array from Storage
2. For each item: if string → convert to `{ id: generateId(), name: string, hidden: false }`
3. If object without `id` → add `id: generateId()`
4. Save normalized array back to Storage
5. Subsequent loads find already-normalized data (idempotent)

### Out of Scope

- This ADR does NOT change the domain model beyond fault types
- This ADR does NOT modify any other repository or mapper
- This ADR does NOT affect the adapter layer (the adapter already supports `idField: 'id'`)

## Consequences

### Positive
- `FaultTypeRepository` joins the standard Repository pipeline
- Consistent architecture across all static collection repositories
- Eliminates `typeof` branching in rendering and repository code
- Enables future features that require fault type IDs (e.g., linking repairs to specific fault types)
- Simplifies the codebase by removing the documented exception

### Negative
- One-time migration of existing user data
- If migration fails or is interrupted, data could be inconsistent (mitigated by idempotent migration)
- Slight increase in storage size (IDs + object overhead vs. plain strings)

### Risks
- **Data loss during migration**: Mitigated by reading before normalizing and writing back only on success
- **ID collisions**: Mitigated by using timestamp-based IDs (same pattern as `repairParts`: `'rp_' + Date.now()`)
- **Rollback complexity**: If the user needs to revert, the old format is lost after migration (mitigated by keeping a backup key)

## Prerequisites

- ADR-003 Phase 8.3 must be complete (done)
- No other phase depends on the current polymorphic format
- All UI call sites for fault types must be identified and updated

## Timeline

TBD — this is a future ADR. Implementation should be scheduled as a standalone phase after Phase 8.6 completion.
