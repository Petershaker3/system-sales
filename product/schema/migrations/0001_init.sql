-- mshop product schema, version 1.
--
-- What this is: the tables every later step (legacy import, sales, backup)
-- writes to. What it is not: application logic. All money is INTEGER minor
-- units, and the database itself rejects REAL, so no future writer can smuggle
-- in a float. Every CHECK below is load-bearing: the tests in tests/schema_v1.rs
-- prove each one fires, because an unenforced constraint is documentation, not
-- a constraint.
--
-- Conventions, applied everywhere without exception:
--   * *_minor columns are INTEGER and carry CHECK(typeof(col) = 'integer').
--   * Timestamps are TEXT in UTC ISO 8601, generated in one place by callers.
--   * origin is TEXT NOT NULL DEFAULT 'local'. Rows that came from the legacy
--     system carry origin = 'legacy-import', so their provenance is queryable.
--   * created_by is TEXT NULL. NULL means no trustworthy user exists for the
--     row (legacy rows, opening balances). It is never backfilled with a name.
--   * Snapshots on invoice lines are plain columns, never references. A later
--     price change must be physically unable to rewrite history.

-- Version marker. ADR-003 requires versioned backup packages, and the package
-- manifest reads this rather than sqlx internals. Migrations also track
-- themselves in _sqlx_migrations; this table is for the product, not the tool.
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Free-form settings with unique keys. Reference thresholds live here
-- (for example the stagnant-stock warning horizon), not in code.
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Reference lists. Each has a UNIQUE name because the legacy system treats
-- these as deduplicated vocabularies, and the new one must too.
CREATE TABLE categories (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE expense_categories (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE fault_types (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE brands (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

-- The sale catalog. cost handling differs by kind (ADR-002): quantity-managed
-- items carry a moving weighted average in avg_cost_minor, while individually
-- tracked units keep their own actual cost in product_units. avg_cost_minor is
-- NULL until the first reception: NULL means "unknown", and 0 would lie that
-- the stock was free.
CREATE TABLE products (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sku              TEXT    NOT NULL UNIQUE,
    name             TEXT    NOT NULL,
    kind             TEXT    NOT NULL CHECK (kind IN ('phone', 'accessory', 'used', 'part', 'service', 'other')),
    barcode          TEXT,
    price_minor      INTEGER NOT NULL CHECK (typeof(price_minor) = 'integer'),
    avg_cost_minor   INTEGER CHECK (avg_cost_minor IS NULL OR typeof(avg_cost_minor) = 'integer'),
    qty              INTEGER NOT NULL DEFAULT 0 CHECK (typeof(qty) = 'integer' AND qty >= 0),
    primary_photo_id INTEGER REFERENCES product_photos (id),
    origin           TEXT    NOT NULL DEFAULT 'local',
    created_by       TEXT,
    created_at       TEXT    NOT NULL
);

-- Individually tracked units (IMEI/Serial, ADR-002). The IMEI is globally
-- unique: one physical device cannot be two products, and in a single-shop
-- system that is exactly what "unique per item/shop" means. A duplicate is a
-- data error and must surface, never silently merge.
CREATE TABLE product_units (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES products (id),
    imei_serial TEXT    NOT NULL UNIQUE,
    cost_minor  INTEGER NOT NULL CHECK (typeof(cost_minor) = 'integer'),
    status      TEXT    NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'sold', 'returned')),
    origin      TEXT    NOT NULL DEFAULT 'local',
    created_by  TEXT,
    created_at  TEXT    NOT NULL
);

CREATE INDEX product_units_product ON product_units (product_id);

-- Goods receptions. ADR-002 computes the moving average from these rows, so
-- each one records quantity, unit cost, and total together, and the total must
-- equal quantity times unit cost: the rounding policy lives in the application,
-- and the application must hand over consistent numbers.
CREATE TABLE purchase_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id     INTEGER NOT NULL REFERENCES products (id),
    qty            INTEGER NOT NULL CHECK (typeof(qty) = 'integer' AND qty > 0),
    unit_cost_minor INTEGER NOT NULL CHECK (typeof(unit_cost_minor) = 'integer' AND unit_cost_minor >= 0),
    total_minor    INTEGER NOT NULL CHECK (typeof(total_minor) = 'integer' AND total_minor = qty * unit_cost_minor),
    supplier       TEXT,
    received_at    TEXT    NOT NULL,
    origin         TEXT    NOT NULL DEFAULT 'local',
    created_by     TEXT
);

CREATE INDEX purchase_history_product ON purchase_history (product_id);

-- Customers. Both name and phone are optional by decision: the shop records
-- whoever it needs, and no customer row is ever invented by merging similar
-- free-text names during import.
CREATE TABLE customers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT,
    phone          TEXT,
    warranty_start TEXT,
    warranty_end   TEXT,
    origin         TEXT    NOT NULL DEFAULT 'local',
    created_by     TEXT,
    created_at     TEXT    NOT NULL
);

-- Product photos. This is the model proven in Task 1.3, carried over unchanged
-- rather than reinvented: the file is named after its SHA-256, the reference is
-- relative, removal marks removed_at instead of deleting bytes, and the partial
-- unique index makes deduplication a schema property.
CREATE TABLE product_photos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id    INTEGER NOT NULL REFERENCES products (id),
    relative_path TEXT    NOT NULL,
    sha256        TEXT    NOT NULL,
    format        TEXT    NOT NULL,
    bytes         INTEGER NOT NULL CHECK (typeof(bytes) = 'integer' AND bytes > 0),
    created_at    TEXT    NOT NULL,
    removed_at    TEXT
);

CREATE UNIQUE INDEX product_photos_live
    ON product_photos (product_id, sha256)
    WHERE removed_at IS NULL;

CREATE INDEX product_photos_path
    ON product_photos (relative_path);

-- Invoices. The total is stored, not derived, because a stored total that
-- disagrees with its lines is itself evidence worth keeping.
CREATE TABLE invoices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER REFERENCES customers (id),
    total_minor INTEGER NOT NULL CHECK (typeof(total_minor) = 'integer'),
    created_at  TEXT    NOT NULL,
    origin      TEXT    NOT NULL DEFAULT 'local',
    created_by  TEXT
);

CREATE INDEX invoices_created ON invoices (created_at);

-- Invoice lines. product_id is NULLABLE on purpose: accessory and used-item
-- sales in the legacy system carry a free name with no fixed product, and the
-- schema must hold those rows without inventing a product for them. Whatever
-- the product, the snapshot columns are what the line means: name, barcode,
-- price, cost, and profit as they were at the moment of sale. The profit CHECK
-- makes the snapshot self-consistent, and nothing may recompute history.
CREATE TABLE invoice_lines (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id       INTEGER NOT NULL REFERENCES invoices (id),
    product_id       INTEGER REFERENCES products (id),
    unit_id          INTEGER REFERENCES product_units (id),
    snapshot_name    TEXT    NOT NULL,
    snapshot_barcode TEXT,
    qty              INTEGER NOT NULL CHECK (typeof(qty) = 'integer' AND qty > 0),
    unit_price_minor INTEGER NOT NULL CHECK (typeof(unit_price_minor) = 'integer'),
    unit_cost_minor  INTEGER NOT NULL CHECK (typeof(unit_cost_minor) = 'integer'),
    profit_minor     INTEGER NOT NULL CHECK (
        typeof(profit_minor) = 'integer'
        AND profit_minor = (unit_price_minor - unit_cost_minor) * qty
    )
);

CREATE INDEX invoice_lines_invoice ON invoice_lines (invoice_id);
CREATE INDEX invoice_lines_product ON invoice_lines (product_id);

-- Repairs. Legacy repairs carry a free-text client name and may be cancelled;
-- cancelled repairs stay in the record but leave the profit sums, which is why
-- cancellation is a column rather than deletion. Status changes accumulate in
-- repair_status_history so the trail survives.
CREATE TABLE repairs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id        INTEGER REFERENCES customers (id),
    client_name        TEXT,
    device_brand       TEXT,
    device_model       TEXT,
    device_serial      TEXT,
    status             TEXT    NOT NULL DEFAULT 'open' CHECK (
        status IN ('open', 'in_progress', 'done', 'delivered', 'cancelled')
    ),
    service_price_minor INTEGER NOT NULL CHECK (typeof(service_price_minor) = 'integer'),
    profit_minor       INTEGER CHECK (
        profit_minor IS NULL OR typeof(profit_minor) = 'integer'
    ),
    cancelled          INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
    created_at         TEXT    NOT NULL,
    origin             TEXT    NOT NULL DEFAULT 'local',
    created_by         TEXT
);

CREATE INDEX repairs_customer ON repairs (customer_id);
CREATE INDEX repairs_status ON repairs (status);

CREATE TABLE repair_status_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    repair_id  INTEGER NOT NULL REFERENCES repairs (id),
    status     TEXT    NOT NULL,
    created_at TEXT    NOT NULL
);

CREATE INDEX repair_status_history_repair ON repair_status_history (repair_id);

-- Repair parts inventory (mshop_repair_parts: id, name, compatible, qty,
-- buyPrice, supplier). Quantities are real stock here, unlike accessories.
CREATE TABLE repair_parts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    compatible    TEXT,
    qty           INTEGER NOT NULL DEFAULT 0 CHECK (typeof(qty) = 'integer' AND qty >= 0),
    buy_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (typeof(buy_price_minor) = 'integer'),
    supplier      TEXT,
    origin        TEXT    NOT NULL DEFAULT 'local',
    created_by    TEXT,
    created_at    TEXT    NOT NULL
);

-- Wallets. Balances are never stored: they are the sum of movements, so a
-- balance can never disagree with its history. Amounts are signed, matching the
-- legacy cT behavior of summing deposits and withdrawals together as recorded.
CREATE TABLE wallets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    origin     TEXT    NOT NULL DEFAULT 'local',
    created_by TEXT,
    created_at TEXT    NOT NULL
);

CREATE TABLE wallet_movements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id   INTEGER NOT NULL REFERENCES wallets (id),
    amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer'),
    service     TEXT,
    note        TEXT,
    created_at  TEXT    NOT NULL,
    origin      TEXT    NOT NULL DEFAULT 'local',
    created_by  TEXT
);

CREATE INDEX wallet_movements_wallet ON wallet_movements (wallet_id);
CREATE INDEX wallet_movements_created ON wallet_movements (created_at);

-- Expenses. Outflows only: a negative expense is meaningless, so the schema
-- says so.
CREATE TABLE expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT    NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor >= 0),
    note        TEXT,
    created_at  TEXT    NOT NULL,
    origin      TEXT    NOT NULL DEFAULT 'local',
    created_by  TEXT
);

CREATE INDEX expenses_created ON expenses (created_at);
CREATE INDEX expenses_category ON expenses (category);
