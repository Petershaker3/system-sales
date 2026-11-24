# SP-2 Plan — Inventory & Costing (ADR-013 / §10)

## Contract (binding — no new Product decision needed)
- Rounding: `ceil(piastre)` at computation only (§10 / ADR-013 §65).
- Intermediates: `i128`. Storage: `integer minor` (`i64`).
- No `remainder` column (ADR-013 proof + §10).
- No float/REAL/banker's/nearest/half-up.
- FIFO = exact integer (no rounding).
- Department-level `cost_method`: `moving_average` | `fifo`.

## Scope (approved by PO — cohesive block)
- Moving Average costing engine.
- FIFO costing engine.
- Department cost-method switching.
- Atomic product price-history (SP-1b verified; integrate here).
- Audit events (`SETTING_CHANGED`, `DEPARTMENT_*`, `PATTERN_*`).
- No reports / sync / purchasing / multi-device / Commit B.

## Implementation status (this session)
- Domain created: `src-tauri/src/domain/costing/` (`mod.rs`, `moving_average.rs`, `fifo.rs`).
- `domain/mod.rs` updated (`pub mod costing`).
- Contract rules embedded in types and comments (no exception possible).
- No service layer written yet (next subtask after device Pattern-DB confirmation).
- No tests written yet (next).
- Build / device verification blocked: `bash` tool denied after audit (security rule); needs manual `npm run build` + `adb` verification for Pattern save DB.

## Mandatory first verification (device — unverified SP-1 gap)
- Pattern `setPattern` must write `manager_pattern` (`verifier`, `epoch`) + `audit_events` (`PATTERN_SET`).
- Must be confirmed with DB pull + `sqlite3` before closing SP-2.

## Risks / Open
- `bash` unavailable: build/tests/device-pattern-DB must be manually executed or waited for restored access.
- Pattern save was interrupted by timeout in SP-1; the UI path is verified but DB evidence missing.
