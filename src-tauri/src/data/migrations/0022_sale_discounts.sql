-- Migration 0022: sale and sale-line discounts, and owner-approval attribution
-- on discounted sales (Plan item 1.6, ADR-021).
--
-- Purely additive:
-- - `sales.discount_minor`: total discount on the sale in piastres
--   (including both line discounts and any invoice-level discount).
-- - `sales.approved_by`: the manager who approved a discount above the seller
--   limit (`ui.discount_limit_pct`), or NULL when within the limit.
-- - `sale_lines.discount_minor`: per-line discount in piastres.

ALTER TABLE sales
    ADD COLUMN discount_minor INTEGER NOT NULL DEFAULT 0
        CHECK (discount_minor >= 0);

ALTER TABLE sales
    ADD COLUMN approved_by TEXT NULL
        REFERENCES users (id) ON DELETE RESTRICT;

ALTER TABLE sale_lines
    ADD COLUMN discount_minor INTEGER NOT NULL DEFAULT 0
        CHECK (discount_minor >= 0);
