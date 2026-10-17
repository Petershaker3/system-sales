-- Migration 0022: sale and sale-line discounts, and owner-approval attribution
-- on discounted sales (Plan item 1.6, ADR-021).
--
-- Purely additive:
-- - `sales.discount_minor`: total discount on the sale in piastres
--   (including both line discounts and any invoice-level discount).
-- - `sales.approved_by`: the manager who approved a discount above the seller
--   limit (`ui.discount_limit_pct`), or NULL when within the limit.
-- - `sale_lines.discount_minor`: per-line discount in piastres.
-- - `sale_lines_discount_within_gross`: ensures per-line discount never exceeds
--   the line's gross total and `line_total_minor` equals net line total.

ALTER TABLE sales
    ADD COLUMN discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0);

ALTER TABLE sales
    ADD COLUMN approved_by TEXT REFERENCES users (id) ON DELETE RESTRICT;

ALTER TABLE sale_lines
    ADD COLUMN discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0);

CREATE TRIGGER sale_lines_discount_within_gross
BEFORE INSERT ON sale_lines
FOR EACH ROW
WHEN NEW.discount_minor > (NEW.quantity * NEW.unit_selling_price_minor)
  OR NEW.line_total_minor != (NEW.quantity * NEW.unit_selling_price_minor) - NEW.discount_minor
BEGIN
    SELECT RAISE(ABORT, 'sale line discount must not exceed gross line total');
END;
