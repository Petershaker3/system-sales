# SP-1 — Schema Foundation Implementation Plan

> **For agentic workers:** this slice was executed task-by-task under the
> `Audit → Plan → Approval → Implement → Test → STOP` protocol in
> `docs/PROJECT_INSTRUCTIONS.md` §5. Every task below ran to a green suite before
> the next began. Execution outcomes and hardware evidence live in `README.md`;
> this file records what was decided and built.

**Goal:** establish the schema and domain foundation that the inventory ledger
depends on, with no costing arithmetic.

**Architecture:** `Vue → Tauri commands → Services → Domain → Repositories → SQLite`,
unchanged. This slice adds a new vertical (`organisation`) in each layer plus a
third product disposition, and rebuilds `products` atomically.

**Tech Stack:** Tauri 2.12 · Rust 1.98.1 · SQLx 0.9 · SQLite (3.51.3 bundled) · Vue 3 · TypeScript strict

**Spec:** `docs/superpowers/specs/2026-09-28-mobile-shop-system.md` ·
`docs/decisions/ADR-012-inventory-schema-foundation.md`

**Status:** delivered (desktop) · hardware migration verified · UI behaviour blocked

---

## Global Constraints

- Money is `INTEGER` piastres (EGP × 100). No `REAL`, `f64`, or decimal text — `ADR-010`.
- Quantity is a non-negative integer. No weights, fractions, or fixed-point scale.
- No `cost_remainder_minor`: mathematically unnecessary, proved in `ADR-013`.
- No division or rounding logic in this slice. `spec:239` remains open until the
  costing engine exists.
- Department is a **product classification**, never a location — `ADR-012`.
- Attribution comes from the resolved `Session`; no command accepts a token, role,
  or actor id.
- No `BEGIN IMMEDIATE` in this slice; every transaction stays deferred.
- Forward-only migrations; recovery is restore-then-forward-fix.

---

## Decisions of record

| ID | Decision |
|---|---|
| **D1** | `products` rebuilt atomically in `0005` — one column, three dispositions |
| **D2** | Department = product classification. Not a warehouse, branch, location, bin or shelf |
| **D3** | Program approved; mandatory STOP after every task and at the live-schema boundary |

Also locked during execution: `cost_method` is stored inert (option a); Android
snapshot is a separate approval gate.

---

## Task status

| # | Task | Scope | Result |
|---|---|---|---|
| 1 | Error-code scanner | `rust_error_codes()` discovers `src/domain/**` at run time instead of a hand-written source list, plus per-source non-vacuity assertions | **DONE.** `department.rs` does not exist yet; discovery avoids a registration step that fails silently |
| 2 | `busy_timeout` | 5 s on both pools via a shared `BUSY_TIMEOUT` constant | **DONE.** Deferred transactions were returning `SQLITE_BUSY` with no wait |
| 3 | `Piastres` | Single money type; `SalePrice` delegates instead of duplicating | **DONE.** `SalePrice::new_minor` still returns `PRICE_NEGATIVE`, so no operator-facing message changed |
| 4 | `0004_departments.sql` | `departments` table; partial unique index on active names | **DONE.** Purely additive; references only `users` |
| 5 | Department domain | `DepartmentId`, `DepartmentName`, `DepartmentStatus`, `CostMethod`, `VatRate`, `DepartmentVat`, `Department`, `DepartmentError` | **DONE.** VAT is a value object so "enabled with no rate" cannot be represented |
| 6 | Department repository | Row mapping through `rehydrate`; `insert`/`find_by_id`/`list_all`/`list_active`/`update`/`archive` | **DONE.** Reads never repair a corrupt row |
| 7 | `0005_products_inventory_profile.sql` | Atomic `products` rebuild; `Disposition::OneOff`; three nullable columns | **DONE.** Highest-risk task; reviewed separately and executed under the hardware gate |

Test totals: **239 passing** (43 architecture, 135 integration, 61 unit), 0 failed,
3 ignored — from a baseline of 154.

---

## Implementation notes worth keeping

**Task 1.** The bidirectional error-code guard only scanned
`[DOMAIN_ERROR, CATALOG_DOMAIN]`. A new `DepartmentError::code()` would have been
invisible, so adding its Arabic message later would fail
`the_frontend_declares_no_code_rust_cannot_emit`. Discovery at run time removes
the failure mode rather than documenting it. The guard fired for real on Task 5,
when a long code wrapped across two lines.

**Task 2.** `busy_timeout` is inert on the in-memory pool (one connection cannot
contend with itself). Applied anyway so the two pools cannot drift apart.

**Task 3.** `SalePrice` stayed a distinct type — a function taking a `SalePrice`
cannot be handed a purchase cost — but now shares one stored representation with
`Piastres`. Serde names were made equal to stored names so a DTO cannot disagree
with the column.

**Task 6.** `update` omits `id`, `created_by`, `created_at` from its `SET` list
rather than relying on a convention. `archive` is its own statement with no path
that writes `active`.

**Task 7.** The rebuild uses neither `PRAGMA foreign_keys=OFF` nor
`-- no-transaction`, because at that point in history nothing references
`products` and every FK points outward to `users`. That is why `DROP` and
`RENAME` can share the migration transaction. `tests/architecture/main.rs` asserts
both properties so the safety cannot become accidental.

---

## Acceptance criteria

| Criterion | Met |
|---|---|
| Existing 154 tests unmodified and green | ✅ |
| New tests added: 85 (43 arch, +48 integration, +24 unit) | ✅ |
| `npm run typecheck` and `npm run build` exit 0 | ✅ |
| Every pre-`0005` product row preserved with no invented data | ✅ desktop; ⚠ device had `products=0` |
| No `PRAGMA` / no `-- no-transaction` in `0005` | ✅ |
| No location, warehouse, branch or stock-location column | ✅ guarded |
| One money type; zero floating-point columns | ✅ |
| Every new error code has an Arabic message | ✅ both directions |
| `cost_method` stored and inert | ✅ no engine reads it |

---

## Deferred to later slices

Inventory ledger · cost layers · moving average · FIFO · serialized units ·
purchasing · suppliers · sales · returns · VAT arithmetic · reports.
`spec:239` (rounding) stays open until the costing engine lands.