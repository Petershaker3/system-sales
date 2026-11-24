-- Invoice payments (`sale_payments`) and customer credit ledger (`customer_ledger`).
-- Plan item 1.5 (`ADR-020`, `ADR-016` #16 & #31, `HANDOFF_2026-10-17.md` §6).
--
-- Purely additive:
--   1. `sale_payments`: one or more payment rows per sale document (`sales.id`),
--      supporting single-method and split payments across `cash`, `vf`,
--      `instapay`, `card`, `install`, and `credit`.
--   2. `customer_ledger`: append-only ledger of customer credit (`آجل`) charges,
--      reversals on cancelled sales, and customer debt payments.

CREATE TABLE sale_payments (
    id            TEXT    PRIMARY KEY NOT NULL,
    sale_id       TEXT    NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
    payment_no    INTEGER NOT NULL CHECK (payment_no > 0),
    method        TEXT    NOT NULL
                    CHECK (method IN ('cash', 'vf', 'instapay', 'card', 'install', 'credit')),
    amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
    reference     TEXT    NULL
                    CHECK (reference IS NULL OR (length(trim(reference)) > 0 AND length(reference) <= 120)),
    occurred_at   INTEGER NOT NULL,
    UNIQUE (sale_id, payment_no)
);

CREATE INDEX idx_sale_payments_sale ON sale_payments (sale_id);
CREATE INDEX idx_sale_payments_method_occurred ON sale_payments (method, occurred_at);

-- Backfill pre-0021 sales (which were all cash-only) so every sale in the
-- database has matching `sale_payments` rows.
INSERT INTO sale_payments (id, sale_id, payment_no, method, amount_minor, reference, occurred_at)
SELECT 'sp-' || id, id, 1, 'cash', total_minor, NULL, occurred_at
FROM sales;

CREATE TRIGGER sale_payments_credit_requires_customer
BEFORE INSERT ON sale_payments
WHEN NEW.method = 'credit'
 AND (SELECT customer_id FROM sales WHERE id = NEW.sale_id) IS NULL
BEGIN
    SELECT RAISE(ABORT, 'credit payment requires a linked customer on the sale');
END;

CREATE TRIGGER sale_payments_no_update
BEFORE UPDATE ON sale_payments
BEGIN
    SELECT RAISE(ABORT, 'sale_payments is append-only');
END;

CREATE TRIGGER sale_payments_no_delete
BEFORE DELETE ON sale_payments
BEGIN
    SELECT RAISE(ABORT, 'sale_payments is append-only');
END;

CREATE TABLE customer_ledger (
    id            TEXT    PRIMARY KEY NOT NULL,
    customer_id   TEXT    NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
    kind          TEXT    NOT NULL
                    CHECK (kind IN ('credit_sale', 'payment', 'sale_reversal')),
    amount_minor  INTEGER NOT NULL CHECK (amount_minor != 0),
    method        TEXT    NULL
                    CHECK (method IS NULL OR method IN ('cash', 'vf', 'instapay', 'card')),
    sale_id       TEXT    NULL REFERENCES sales (id) ON DELETE RESTRICT,
    note          TEXT    NULL
                    CHECK (note IS NULL OR (length(trim(note)) > 0 AND length(note) <= 200)),
    actor_id      TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    occurred_at   INTEGER NOT NULL,
    CHECK (
        (kind = 'credit_sale' AND amount_minor > 0 AND method IS NULL AND sale_id IS NOT NULL)
        OR (kind = 'sale_reversal' AND amount_minor < 0 AND method IS NULL AND sale_id IS NOT NULL)
        OR (kind = 'payment' AND amount_minor < 0 AND method IS NOT NULL AND sale_id IS NULL)
    )
);

CREATE INDEX idx_customer_ledger_customer ON customer_ledger (customer_id, occurred_at);
CREATE INDEX idx_customer_ledger_sale ON customer_ledger (sale_id);

CREATE TRIGGER customer_ledger_no_update
BEFORE UPDATE ON customer_ledger
BEGIN
    SELECT RAISE(ABORT, 'customer_ledger is append-only');
END;

CREATE TRIGGER customer_ledger_no_delete
BEFORE DELETE ON customer_ledger
BEGIN
    SELECT RAISE(ABORT, 'customer_ledger is append-only');
END;
