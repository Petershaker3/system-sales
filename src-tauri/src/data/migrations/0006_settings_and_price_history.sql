-- Migration 0006: settings and price history
--
-- Forward-only per plan 143. No Down.
--
-- Purely additive: no product table modifications, no inventory-ledger
-- changes, no stock tables. References only `users` (attribution) and
-- `products` (price-history foreign key).
--
-- No PRAGMA, no -- no-transaction, no trigger.

CREATE TABLE app_settings (
    key        TEXT    PRIMARY KEY NOT NULL,
    value      TEXT    NOT NULL,
    updated_by TEXT    REFERENCES users (id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_app_settings_key ON app_settings (key);
CREATE INDEX idx_app_settings_updated ON app_settings (updated_at);

CREATE TABLE product_price_history (
    id              TEXT    PRIMARY KEY NOT NULL,
    product_id      TEXT    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    old_price_minor INTEGER          CHECK (old_price_minor IS NULL OR old_price_minor >= 0),
    new_price_minor INTEGER          CHECK (new_price_minor IS NULL OR new_price_minor >= 0),
    actor_id        TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    occurred_at     INTEGER NOT NULL,
    CHECK (old_price_minor IS NOT new_price_minor)
);

CREATE INDEX idx_price_history_product ON product_price_history (product_id, occurred_at, id);
