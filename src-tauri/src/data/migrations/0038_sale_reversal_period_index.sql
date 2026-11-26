-- Period reporting reads cancellation events by their own timestamp, rather
-- than removing the original sale from its historical period. This is only an
-- index: no financial records or existing migration are rewritten.
CREATE INDEX idx_sale_reversals_occurred_at ON sale_reversals (occurred_at, id);
