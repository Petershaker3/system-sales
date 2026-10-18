-- 0027_repairs_and_software.sql
--
-- Plan item 2.1 (ADR-031): Repairs & Software (`الصيانة والسوفت وير`).
--
-- Tracks hardware repair tickets (`service_kind = 'hardware'`) and software
-- operations (`service_kind = 'software'`) through the 5-stage Kanban board
-- (`received`, `diagnosing`, `waiting`, `ready`, `delivered`, plus `cancelled`)
-- while keeping hardware revenue/parts/net-profit and software revenue/cost/
-- net-profit strictly separable (`ADR-016` #13-#14 & #35).

CREATE TABLE repairs (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0 AND length(id) <= 64),
    ticket_no TEXT NOT NULL UNIQUE CHECK (length(trim(ticket_no)) > 0 AND length(ticket_no) <= 32),
    service_kind TEXT NOT NULL DEFAULT 'hardware' CHECK (service_kind IN ('hardware', 'software')),
    customer_name TEXT NOT NULL CHECK (length(trim(customer_name)) > 0 AND length(customer_name) <= 120),
    customer_phone TEXT NOT NULL CHECK (length(trim(customer_phone)) > 0 AND length(customer_phone) <= 64),
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
    technician_name TEXT NULL CHECK (technician_name IS NULL OR (length(trim(technician_name)) > 0 AND length(technician_name) <= 120)),
    warranty_days INTEGER NOT NULL DEFAULT 0 CHECK (warranty_days >= 0 AND warranty_days <= 3650),
    note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 400),
    created_by TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    delivered_at INTEGER NULL CHECK (delivered_at IS NULL OR delivered_at >= created_at)
) STRICT;

CREATE INDEX idx_repairs_status_created ON repairs (status, created_at DESC);
CREATE INDEX idx_repairs_kind_created ON repairs (service_kind, created_at DESC);
CREATE INDEX idx_repairs_delivered_at ON repairs (delivered_at);
