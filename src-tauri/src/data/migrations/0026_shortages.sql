-- 0026_shortages.sql
-- Plan item 1.15 (ADR-030, PLAN.md §11, §19; ADR-016 #20, #31; docs/ui/SALES-SHORTAGES.md):
--   Manual & system-suggested shortages list (`النواقص`).
--   Anyone who can sell may add or update status (`open` -> `ordered` -> resolved);
--   only the creator (`created_by`) or a manager may delete an entry.

CREATE TABLE shortages (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0 AND length(id) <= 64),
    product_id TEXT NULL REFERENCES products (id) ON DELETE SET NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 160),
    qty INTEGER NOT NULL CHECK (qty >= 1),
    note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 300),
    customer_name TEXT NULL CHECK (customer_name IS NULL OR (length(trim(customer_name)) > 0 AND length(customer_name) <= 120)),
    customer_phone TEXT NULL CHECK (customer_phone IS NULL OR (length(trim(customer_phone)) > 0 AND length(customer_phone) <= 64)),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ordered')),
    created_by TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    resolved_at INTEGER NULL CHECK (resolved_at IS NULL OR resolved_at >= created_at)
) STRICT;

CREATE INDEX idx_shortages_active ON shortages (resolved_at, created_at DESC);
CREATE INDEX idx_shortages_product ON shortages (product_id) WHERE resolved_at IS NULL;
