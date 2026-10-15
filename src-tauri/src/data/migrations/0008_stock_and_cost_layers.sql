-- Migration 0008: stock positions and FIFO cost layers.
--
-- WHAT THIS MAKES LIVE
--
-- `departments.cost_method` was stored and inert through SP-1 (`ADR-012` §7:
-- "لا محرك تكلفة يقرأه حتى تصل الشريحة التي تنفّذه"). This migration is part of
-- that slice: it gives each product a stock position, gives FIFO somewhere to
-- keep its layers, and lets `moving_average` and `fifo` finally be arithmetic
-- rather than configuration.
--
-- Purely additive. No table is rebuilt, no column is altered, no PRAGMA is used
-- and no `-- no-transaction` marker appears, so this runs inside the ordinary
-- SQLx migration transaction.
--
-- `products` now has inbound foreign keys, so the `0005` rebuild pattern would
-- no longer be safe here. Nothing needs one: everything below is a new table.
--
-- THE TWO TABLES
--
-- `stock_levels` is one row per product — `product_id` alone, no location
-- dimension, exactly as `ADR-012` decided ("`stock_levels` مفتاحه `product_id`
-- وحده"). A department classifies a product; it does not partition its stock,
-- and there is nowhere in this schema for goods to be moved *to*.
--
-- `fifo_layers` is one row per receipt, oldest first. Layers are kept because
-- `ADR-013` calls them truth where FIFO applies ("الطبقات حقيقة حيث يلزم FIFO").
-- The id is a UUID v7 (`ADR-009`) so the `(received_at, id)` consumption order
-- stays total even when two receipts land in the same millisecond; without the
-- tiebreak a replay would not reproduce the same costs.
--
-- AUTHORITY — THE INVARIANT THIS MIGRATION CANNOT STATE
--
--     moving_average -> stock_levels.total_cost_minor is the cost authority
--                       and fifo_layers is empty
--     fifo           -> fifo_layers is the cost authority
--                       and stock_levels.total_cost_minor is NULL
--
-- Both agree on `stock_levels.quantity`, which is the on-hand count for either
-- method. SQLite cannot enforce a rule that spans two tables, so the invariant
-- lives in the costing service and is covered by integration tests; what this
-- migration *can* state is the one-sided half of it, per row:
--
--   * quantity is never negative;
--   * a stored total is never negative;
--   * a FIFO layer always has units and a non-negative unit cost.
--
-- `total_cost_minor` is NULLABLE precisely so that "FIFO is in charge" is a
-- value the schema can express rather than a 0 that a reader might mistake for
-- free stock. The same NULL-versus-zero distinction `0005` applies to
-- `sale_price_minor`.
--
-- WHAT IS DELIBERATELY ABSENT
--
-- No movement ledger. `ADR-013` describes the layers as rebuildable from one,
-- but that ledger belongs with the sale lines and the customer returns of
-- `pos-sales`, not with the position it would duplicate. It is a later
-- migration, and the layering means this one is not blocked by its absence.
--
-- No sale-line cost snapshot and no return restoration, for the same reason:
-- `ADR-013` requires both, and both are properties of a *sale*, not of a stock
-- balance.
--
-- No supplier, purchase order or payable. `spec` §231 defers them, and a receipt
-- in this slice is a unit cost and a quantity, not a procurement document.
--
-- Rollback is not a `Down` script: `plan:143` fixes the recovery model as
-- restore-a-backup then forward-fix.
--
-- Timestamps are INTEGER milliseconds since the Unix epoch, UTC, matching
-- migrations 0001 to 0007.

CREATE TABLE stock_levels (
    -- One counter per product and no more. `ON DELETE RESTRICT` matches every
    -- other inbound reference in this schema: a product that has been stocked
    -- keeps its history, and `spec:221` archives a product rather than
    -- deleting it.
    product_id       TEXT    PRIMARY KEY NOT NULL
                              REFERENCES products (id) ON DELETE RESTRICT,

    -- Units on hand. Authoritative under BOTH costing methods, because both
    -- answer "how many are left" with this number and neither derives it.
    --
    -- CHECK (not just a NOT NULL): a negative balance is the one state a costing
    -- bug could produce that must never reach disk, so the database refuses it
    -- even if some future caller forgets the domain check.
    quantity         INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),

    -- Moving Average's cost authority: the cost of the units in `quantity`.
    -- Stored as a TOTAL, never as a per-unit average, because `ADR-013` rejects
    -- a stored average ("القسمة عند كل استلام وب كل بيع تتراكم") and keeps the
    -- division at read time where it cannot drift.
    --
    -- NULL under FIFO, where the layers hold the cost instead. NULL means "the
    -- layers are in charge", never "zero": a 0 here would read as free stock.
    total_cost_minor INTEGER
                              CHECK (total_cost_minor IS NULL OR total_cost_minor >= 0),

    -- Attribution is mandatory (`plan:143`, `spec:177`) and comes from the
    -- resolved session. No `created_*` pair: a row is created by the same act
    -- that first moves the balance, so a separate creation stamp would have to
    -- be maintained to no purpose.
    updated_by       TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    updated_at       INTEGER NOT NULL
);

CREATE TABLE fifo_layers (
    -- UUID v7 (ADR-009), matching `products.id` and `users.id`. The tiebreak
    -- for `(received_at, id)` ordering has to be unique and stable, so a
    -- per-device counter would not do.
    id               TEXT    PRIMARY KEY NOT NULL,

    product_id       TEXT    NOT NULL
                              REFERENCES products (id) ON DELETE RESTRICT,

    -- STRICTLY positive. A spent layer is deleted rather than kept at zero, so
    -- a zero here would be a layer that carries no cost fact and only
    -- complicates the replay.
    quantity         INTEGER NOT NULL CHECK (quantity > 0),

    -- An integer count of piastres (`ADR-010`). No REAL, no floating point
    -- money (`spec:56`).
    unit_cost_minor  INTEGER NOT NULL CHECK (unit_cost_minor >= 0),

    -- When the stock arrived. Consumption order is `(received_at, id)`, the
    -- order `ADR-013` states.
    received_at      INTEGER NOT NULL,

    -- Who received it. Mandatory like every other attribution in this schema
    -- (`spec:177`) and taken from the resolved session, never from the caller.
    updated_by       TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT
);

-- The consumption scan, exactly as the engine asks for it: this product's
-- layers, oldest first. A FIFO removal walks it from the front, so making the
-- index cover the ordering turns the hottest query in the engine into a
-- contiguous read instead of a sort.
CREATE INDEX idx_fifo_layers_consumption
    ON fifo_layers (product_id, received_at, id);

-- Attribution lookups, for example "everything this operator received".
CREATE INDEX idx_fifo_layers_received_by ON fifo_layers (updated_by);