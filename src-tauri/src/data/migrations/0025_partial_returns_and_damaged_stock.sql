-- 0025_partial_returns_and_damaged_stock.sql
--
-- Partial or full line returns at original line cost, exchanges (return + sale
-- in one operation), and the damaged stock bucket (`damaged_stock`) that does
-- not return to sellable stock — Plan item 1.11 (`ADR-026`, `ADR-016` #9 & #31,
-- `PLAN.md` §10 & §19).

ALTER TABLE sale_lines
    ADD COLUMN reverses_line_id TEXT NULL REFERENCES sale_lines (id) ON DELETE RESTRICT;

ALTER TABLE sale_lines
    ADD COLUMN return_condition TEXT NULL CHECK (return_condition IS NULL OR return_condition IN ('intact', 'damaged'));

CREATE INDEX idx_sale_lines_reverses_line ON sale_lines (reverses_line_id);

CREATE TABLE sale_returns (
    id                  TEXT    PRIMARY KEY NOT NULL,
    original_sale_id    TEXT    NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
    return_sale_id      TEXT    NOT NULL UNIQUE REFERENCES sales (id) ON DELETE RESTRICT,
    exchange_sale_id    TEXT    NULL UNIQUE REFERENCES sales (id) ON DELETE RESTRICT,
    refund_minor        INTEGER NOT NULL CHECK (refund_minor >= 0),
    cost_returned_minor INTEGER NOT NULL CHECK (cost_returned_minor >= 0),
    damaged_cost_minor  INTEGER NOT NULL DEFAULT 0 CHECK (damaged_cost_minor >= 0),
    reason              TEXT    NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 200),
    actor_id            TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    approved_by         TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    occurred_at         INTEGER NOT NULL
);

CREATE INDEX idx_sale_returns_original_sale ON sale_returns (original_sale_id, occurred_at);
CREATE INDEX idx_sale_returns_occurred_at ON sale_returns (occurred_at DESC);

CREATE TRIGGER sale_returns_no_update
BEFORE UPDATE ON sale_returns
BEGIN
    SELECT RAISE(ABORT, 'sale_returns is append-only');
END;

CREATE TRIGGER sale_returns_no_delete
BEFORE DELETE ON sale_returns
BEGIN
    SELECT RAISE(ABORT, 'sale_returns is append-only');
END;

CREATE TABLE damaged_stock (
    id                TEXT    PRIMARY KEY NOT NULL,
    product_id        TEXT    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    sale_id           TEXT    NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
    return_sale_id    TEXT    NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
    sale_line_id      TEXT    NOT NULL REFERENCES sale_lines (id) ON DELETE RESTRICT,
    return_line_id    TEXT    NOT NULL REFERENCES sale_lines (id) ON DELETE RESTRICT,
    unit_id           TEXT    NULL REFERENCES units (id) ON DELETE RESTRICT,
    quantity          INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost_minor   INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
    total_cost_minor  INTEGER NOT NULL CHECK (total_cost_minor >= 0),
    reason            TEXT    NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 200),
    actor_id          TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    approved_by       TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    occurred_at       INTEGER NOT NULL
);

CREATE INDEX idx_damaged_stock_product ON damaged_stock (product_id, occurred_at DESC);
CREATE INDEX idx_damaged_stock_occurred_at ON damaged_stock (occurred_at DESC);

CREATE TRIGGER damaged_stock_no_update
BEFORE UPDATE ON damaged_stock
BEGIN
    SELECT RAISE(ABORT, 'damaged_stock is append-only');
END;

CREATE TRIGGER damaged_stock_no_delete
BEFORE DELETE ON damaged_stock
BEGIN
    SELECT RAISE(ABORT, 'damaged_stock is append-only');
END;
