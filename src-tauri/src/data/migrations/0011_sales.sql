-- Migration 0011: cash sales, sale lines, the movement ledger, reversals.
--
-- WHAT THIS MAKES LIVE
--
-- The first transaction slice (`pos-sales`): a cash sale records the sale, its
-- lines, the stock deduction, the cost consumption, the movement rows and the
-- audit rows in one atomic transaction — or none of them. Cancellation arrives
-- as a separate reversal sale, never as an edit.
--
-- Purely additive. No table is rebuilt, no column is altered, no PRAGMA is used
-- and no `-- no-transaction` marker appears, so this runs inside the ordinary
-- SQLx migration transaction. Rollback is not a `Down` script: `plan:143` fixes
-- the recovery model as restore-a-backup then forward-fix.
--
-- Timestamps are INTEGER milliseconds since the Unix epoch, UTC, matching
-- migrations 0001 to 0010.
--
-- WHAT IS DELIBERATELY ABSENT
--
-- No VAT columns anywhere in these tables. V1 performs no VAT computation and
-- no extraction from price; a stored rate would imply a tax that was considered
-- and found to be zero, which is a commercial claim this software cannot make.
-- The existing tax configuration (`departments.vat_*`, `products.vat_rate_bp`,
-- `app_settings.default_vat_*`) is untouched and stays exactly as inert as it
-- is today.
--
-- No discount columns. Discounts are out of V1 scope; `max_discount_*` stays
-- inert as it is today.
--
-- No customer columns. The customers module is out of this slice, and a
-- foreign-key-less `customer_id` would be a relation that relates to nothing.
-- A later slice adds a nullable `customer_id` by additive migration without
-- rewriting any sale row.
--
-- No `updated_*` on `sales`. Every other table carries them because a balance
-- is mutable by nature; a sale is a document with no lifecycle state, so those
-- columns would falsely imply it can change. Cancellation is expressed solely
-- by `sale_reversals` plus the reversal sale's own rows.
--
-- AUTHORITY — WHAT THE LEDGER PROMISES
--
-- Within one stable cost-method epoch, for one product:
--   stock_levels.quantity = baseline + SUM(quantity_delta)
--   and under Moving Average, total_cost_minor = baseline + SUM(cost_delta_minor),
--   because receipts post the exact `quantity x unit_cost` and removals post the
--   exact computed removal — the same integers the balance rows carry. The
--   rounding lives inside the posted removal, so it cannot desynchronise the two
--   sides. Across a cost-method switch these identities do not transfer (the
--   conversion reseeds value); the switch point is the existing
--   `COST_METHOD_SWITCHED` audit event, not a movement row.

CREATE TABLE sales (
    -- UUID v7 (ADR-009), matching every other entity id in this schema.
    id               TEXT    PRIMARY KEY NOT NULL,

    -- Human invoice reference, `{invoice_prefix}-YYYYMMDD-NNNN` (bare
    -- `YYYYMMDD-NNNN` when no prefix is set). UNIQUE so a collision or an
    -- exhausted daily sequence refuses the sale rather than minting a second
    -- invoice for one transaction.
    reference        TEXT    NOT NULL UNIQUE,

    -- When the sale happened. The invoice day derives from this same instant.
    occurred_at      INTEGER NOT NULL,

    -- Responsible operator, from the resolved session, never from the caller.
    sold_by          TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

    -- A reversal is a sale-shaped record, so history is appended to, never
    -- rewritten. The only two kinds; anything else is a defect, not a feature.
    kind             TEXT    NOT NULL CHECK (kind IN ('sale', 'reversal')),

    -- For a reversal: the sale it reverses. Traceable link, not an edit.
    reverses_sale_id TEXT    REFERENCES sales (id) ON DELETE RESTRICT,

    -- Sum of the line totals. A snapshot of what the operator charged.
    total_minor      INTEGER NOT NULL CHECK (total_minor >= 0),

    -- Sum of the line costs. A snapshot of what the stock cost. Never
    -- recomputed: later receipts or a cost-method switch do not rewrite it.
    cost_total_minor INTEGER NOT NULL CHECK (cost_total_minor >= 0)
);

CREATE TABLE sale_lines (
    id                      TEXT    PRIMARY KEY NOT NULL,

    sale_id                 TEXT    NOT NULL
                                      REFERENCES sales (id) ON DELETE RESTRICT,

    -- 1-based position inside the sale. UNIQUE per sale so a line is stable.
    line_no                 INTEGER NOT NULL CHECK (line_no > 0),

    product_id              TEXT    NOT NULL
                                      REFERENCES products (id) ON DELETE RESTRICT,

    -- Immutable snapshots, taken at sale time and never recomputed: the name
    -- the operator saw, the price charged, and the cost consumed. A later
    -- rename, reprice or cost-method switch leaves these rows exactly as sold.
    product_name            TEXT    NOT NULL,
    disposition             TEXT    NOT NULL,
    quantity                INTEGER NOT NULL CHECK (quantity > 0),
    unit_selling_price_minor INTEGER NOT NULL CHECK (unit_selling_price_minor >= 0),
    line_total_minor        INTEGER NOT NULL CHECK (line_total_minor >= 0),

    -- The cost snapshot (ADR-013:83). NULLABLE on purpose: a FIFO line that
    -- spans layers with different unit costs has no single unit cost, and
    -- inventing an average would silently average FIFO costs. The exact
    -- `line_cost_minor` below is the authority for profit; the unit figure is
    -- a quoted reference that must never be used to derive totals.
    unit_cost_minor         INTEGER CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
    line_cost_minor         INTEGER NOT NULL CHECK (line_cost_minor >= 0),

    -- Snapshots of the costing context, because the department's method may
    -- change later and history must not follow it.
    department_id           TEXT,
    cost_method             TEXT    NOT NULL,

    UNIQUE (sale_id, line_no)
);

CREATE TABLE stock_movements (
    -- UUID v7 (ADR-009). The tiebreak for replay ordering with `occurred_at`.
    id                  TEXT    PRIMARY KEY NOT NULL,

    product_id          TEXT    NOT NULL
                                  REFERENCES products (id) ON DELETE RESTRICT,

    -- What moved the stock: a receipt, a manual adjustment, a sale, or the
    -- reversal of a sale. The set is closed on purpose — a new category is a
    -- decision, not a typo that slips through.
    kind                TEXT    NOT NULL
                                  CHECK (kind IN ('receipt', 'adjustment', 'sale', 'sale_reversal')),

    -- Signed: positive for receipts and restorations, negative for sales.
    quantity_delta      INTEGER NOT NULL CHECK (quantity_delta != 0),

    -- The unit cost attributed at the time. For a sale under FIFO this is the
    -- cost of the specific consumed layer(s), recorded per layer below.
    unit_cost_minor     INTEGER NOT NULL CHECK (unit_cost_minor >= 0),

    -- Signed mirror of the quantity move in money.
    cost_delta_minor    INTEGER NOT NULL,

    occurred_at         INTEGER NOT NULL,

    -- Who moved it, from the resolved session, never from the caller.
    actor_id            TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

    -- The sale this movement belongs to, if any. Receipts carry NULL here.
    sale_id             TEXT    REFERENCES sales (id) ON DELETE RESTRICT,
    sale_line_id        TEXT    REFERENCES sale_lines (id) ON DELETE RESTRICT,

    -- For a FIFO consumption: the exact layer touched, with its arrival time
    -- preserved, so a reversal can restore arrival order and history faithfully.
    fifo_layer_id       TEXT,
    fifo_received_at    INTEGER,

    -- For a reversal: the exact original movement it undoes. UNIQUE so one
    -- original movement can be reversed at most once; NULLs are distinct, so
    -- ordinary movements are unaffected.
    reverses_movement_id TEXT   REFERENCES stock_movements (id) ON DELETE RESTRICT,
    UNIQUE (reverses_movement_id)
);

CREATE TABLE sale_reversals (
    id                TEXT    PRIMARY KEY NOT NULL,

    -- The sale being cancelled. UNIQUE makes a second cancellation of the same
    -- sale structurally impossible, not merely refused.
    original_sale_id  TEXT    NOT NULL UNIQUE
                                REFERENCES sales (id) ON DELETE RESTRICT,

    -- The reversal sale that undoes it. UNIQUE so one reversal undoes exactly
    -- one sale.
    reversal_sale_id  TEXT    NOT NULL UNIQUE
                                REFERENCES sales (id) ON DELETE RESTRICT,

    occurred_at       INTEGER NOT NULL,
    actor_id          TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

    -- Why, in the operator's words. Free text, auditable, never parsed.
    reason            TEXT    NOT NULL
);

-- The movement ledger is append-only: its entire value is that it cannot be
-- rewritten. These two triggers are a deliberate, documented exception to the
-- "no trigger" convention stated in 0006 — a service rule alone would be
-- unenforced, and an unenforced ledger is a diary. They stop
-- application-level mutation; they do not stop someone editing the database
-- file, exactly like every other guarantee in this schema.
CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN
    SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN
    SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

CREATE INDEX idx_sales_occurred_at ON sales (occurred_at);
CREATE INDEX idx_sale_lines_sale ON sale_lines (sale_id);
CREATE INDEX idx_sale_lines_product ON sale_lines (product_id);
CREATE INDEX idx_movements_product_occurred ON stock_movements (product_id, occurred_at);
CREATE INDEX idx_movements_sale_line ON stock_movements (sale_line_id);
