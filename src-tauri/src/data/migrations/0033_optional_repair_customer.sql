-- 0033_optional_repair_customer.sql
--
-- `ADR-045`: the customer is optional on a repair or software ticket.
-- The owner's decision (2026-10-20): «في الصيانة والسوفت وير مش عاوز اسم العميل
-- ورقم التليفون أساسي». A walk-in screen replacement is written down with the
-- device and the fault; the phone number is something the shop may want, not a
-- wall between the customer and the ticket.
--
-- The two columns were `NOT NULL CHECK (length(trim(...)) > 0)`. SQLite cannot
-- relax a CHECK in place, so the table is rebuilt the way `0005` rebuilt
-- `products` and `0032` rebuilt `expenses`: create the new shape, copy every row
-- with no transformation, drop the old table, rename inside the same transaction.
-- Every other rule in this table is kept exactly as it was, including the wallet
-- column `0031` added and the CHECK that ties `delivered_at` to `created_at`.
--
-- Empty now means «مش مسجّل», not «حاجة ناقصة»: the screen prints «بدون اسم» and
-- hides the call button instead of insisting on a number nobody gave.

CREATE TABLE repairs_rebuilt (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0 AND length(id) <= 64),
    ticket_no TEXT NOT NULL UNIQUE CHECK (length(trim(ticket_no)) > 0 AND length(ticket_no) <= 32),
    service_kind TEXT NOT NULL DEFAULT 'hardware' CHECK (service_kind IN ('hardware', 'software')),

    -- Optional, both of them. The length caps stay, so a stray paste cannot fill
    -- the row: an empty string is a fact, a 400-character name is a mistake.
    customer_name TEXT NOT NULL DEFAULT '' CHECK (length(customer_name) <= 120),
    customer_phone TEXT NOT NULL DEFAULT '' CHECK (length(customer_phone) <= 64),

    device_name TEXT NOT NULL CHECK (length(trim(device_name)) > 0 AND length(device_name) <= 160),
    imei TEXT NULL CHECK (imei IS NULL OR (length(trim(imei)) > 0 AND length(imei) <= 32)),
    device_lock TEXT NOT NULL DEFAULT '' CHECK (length(device_lock) <= 120),
    issue TEXT NOT NULL CHECK (length(trim(issue)) > 0 AND length(issue) <= 300),
    accessories TEXT NOT NULL DEFAULT '' CHECK (length(accessories) <= 240),
    due_label TEXT NOT NULL DEFAULT 'بكره' CHECK (length(due_label) <= 80),
    status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'diagnosing', 'waiting', 'ready', 'delivered', 'cancelled')),
    estimated_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (estimated_price_minor >= 0),
    final_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (final_price_minor >= 0),
    parts_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (parts_cost_minor >= 0),
    deposit_minor INTEGER NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0),
    pay_method TEXT NOT NULL DEFAULT 'cash' CHECK (pay_method IN ('cash', 'vf', 'instapay', 'card')),
    pay_wallet_id TEXT NULL REFERENCES wallets (id),
    technician_name TEXT NULL CHECK (technician_name IS NULL OR (length(trim(technician_name)) > 0 AND length(technician_name) <= 120)),
    warranty_days INTEGER NOT NULL DEFAULT 0 CHECK (warranty_days >= 0 AND warranty_days <= 3650),
    note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 400),
    created_by TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    delivered_at INTEGER NULL CHECK (delivered_at IS NULL OR delivered_at >= created_at)
) STRICT;

INSERT INTO repairs_rebuilt (
    id, ticket_no, service_kind, customer_name, customer_phone, device_name, imei,
    device_lock, issue, accessories, due_label, status, estimated_price_minor,
    final_price_minor, parts_cost_minor, deposit_minor, pay_method, pay_wallet_id,
    technician_name, warranty_days, note, created_by, created_at, delivered_at
)
SELECT
    id, ticket_no, service_kind, customer_name, customer_phone, device_name, imei,
    device_lock, issue, accessories, due_label, status, estimated_price_minor,
    final_price_minor, parts_cost_minor, deposit_minor, pay_method, pay_wallet_id,
    technician_name, warranty_days, note, created_by, created_at, delivered_at
FROM repairs;

DROP TABLE repairs;

ALTER TABLE repairs_rebuilt RENAME TO repairs;

CREATE INDEX idx_repairs_status_created ON repairs (status, created_at DESC);
CREATE INDEX idx_repairs_kind_created ON repairs (service_kind, created_at DESC);
CREATE INDEX idx_repairs_delivered_at ON repairs (delivered_at);
