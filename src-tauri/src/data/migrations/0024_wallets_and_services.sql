-- 0024_wallets_and_services.sql
-- Plan item 1.10 (ADR-025, PLAN.md §9, §12, §16, §19; ADR-016 #17, #27, #28, #31, #33):
--   1. `wallets`: shop electronic wallets and InstaPay accounts (sortable, hideable,
--      opening balance, low/max/daily limits, own number, and linked sale payment method).
--   2. `wallet_ops`: append-only ledger of customer wallet operations (`deposit`, `withdraw`),
--      owner wallet movements (`topup`, `unload`, `move`, `adjust`), and quick services (`bill`,
--      `card`, `software`), with per-transaction `fee_minor` and owner void-with-reason (`void_*`).

CREATE TABLE wallets (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0 AND length(id) <= 64),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 80),
    number TEXT NOT NULL DEFAULT '' CHECK (length(number) <= 80),
    color TEXT NOT NULL DEFAULT '#1d4f91' CHECK (color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
    opening_balance_minor INTEGER NOT NULL DEFAULT 0 CHECK (opening_balance_minor >= 0),
    min_alert_minor INTEGER NOT NULL DEFAULT 0 CHECK (min_alert_minor >= 0),
    max_limit_minor INTEGER NOT NULL DEFAULT 0 CHECK (max_limit_minor >= 0),
    daily_limit_minor INTEGER NOT NULL DEFAULT 0 CHECK (daily_limit_minor >= 0),
    pay_method TEXT NULL CHECK (pay_method IS NULL OR pay_method IN ('vf', 'instapay')),
    sort INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    is_custom INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

-- At most one wallet can receive sales paid via a given payment method ('vf' or 'instapay').
CREATE UNIQUE INDEX idx_wallets_pay_method ON wallets(pay_method) WHERE pay_method IS NOT NULL;
CREATE INDEX idx_wallets_sort ON wallets(sort ASC, id ASC);

-- Seed the 5 standard Egyptian shop wallets (ADR-025 §1).
INSERT INTO wallets (
    id, name, number, color,
    opening_balance_minor, min_alert_minor, max_limit_minor, daily_limit_minor,
    pay_method, sort, hidden, is_custom, created_at
) VALUES
    ('vf', 'فودافون كاش', '', '#e60000', 0, 300000, 9000000, 6000000, 'vf', 1, 0, 0, 0),
    ('et', 'اتصالات كاش', '', '#719e19', 0, 100000, 5000000, 0, NULL, 2, 0, 0, 0),
    ('or', 'أورنج كاش', '', '#ff7900', 0, 100000, 5000000, 0, NULL, 3, 0, 0, 0),
    ('we', 'وي باي', '', '#5c2d91', 0, 50000, 3000000, 0, NULL, 4, 0, 0, 0),
    ('ip', 'إنستاباي', '', '#3b2a85', 0, 200000, 15000000, 7000000, 'instapay', 5, 0, 0, 0);

CREATE TABLE wallet_ops (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
    wallet_id TEXT NULL REFERENCES wallets(id),
    to_wallet_id TEXT NULL REFERENCES wallets(id),
    kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdraw', 'topup', 'unload', 'move', 'adjust', 'bill', 'card', 'software')),
    via TEXT NULL CHECK (via IS NULL OR via IN ('drawer', 'out')),
    service_type TEXT NULL CHECK (service_type IS NULL OR (length(trim(service_type)) > 0 AND length(service_type) <= 80)),
    reference TEXT NULL CHECK (reference IS NULL OR length(reference) <= 120),
    amount_minor INTEGER NOT NULL,
    fee_minor INTEGER NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
    note TEXT NULL CHECK (note IS NULL OR length(note) <= 300),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    voided_by TEXT NULL REFERENCES users(id),
    voided_at INTEGER NULL CHECK (voided_at IS NULL OR voided_at >= created_at),
    void_reason TEXT NULL CHECK (void_reason IS NULL OR (length(trim(void_reason)) > 0 AND length(void_reason) <= 300)),
    CHECK (
        (kind IN ('deposit', 'withdraw', 'topup', 'unload', 'adjust') AND wallet_id IS NOT NULL AND to_wallet_id IS NULL)
        OR (kind = 'move' AND wallet_id IS NOT NULL AND to_wallet_id IS NOT NULL AND wallet_id <> to_wallet_id)
        OR (kind IN ('bill', 'card', 'software') AND wallet_id IS NULL AND to_wallet_id IS NULL)
    ),
    CHECK (
        (kind IN ('topup', 'unload') AND via IN ('drawer', 'out'))
        OR (kind NOT IN ('topup', 'unload') AND via IS NULL)
    ),
    CHECK (
        (kind = 'adjust' AND amount_minor <> 0 AND fee_minor = 0)
        OR (kind = 'software' AND amount_minor = 0 AND fee_minor > 0)
        OR (kind NOT IN ('adjust', 'software') AND amount_minor > 0)
    ),
    CHECK (kind <> 'withdraw' OR fee_minor <= amount_minor),
    CHECK (
        (voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL)
        OR (voided_by IS NOT NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL)
    )
) STRICT;

CREATE INDEX idx_wallet_ops_created_at ON wallet_ops(created_at DESC, id DESC);
CREATE INDEX idx_wallet_ops_wallet ON wallet_ops(wallet_id, created_at DESC);
CREATE INDEX idx_wallet_ops_to_wallet ON wallet_ops(to_wallet_id, created_at DESC);

-- Built-in wallets and wallets with recorded operations cannot be deleted.
CREATE TRIGGER wallets_no_delete_default_or_used
BEFORE DELETE ON wallets
BEGIN
    SELECT RAISE(ABORT, 'default wallets cannot be deleted; hide them instead')
    WHERE OLD.is_custom = 0;
    SELECT RAISE(ABORT, 'wallet with recorded operations cannot be deleted')
    WHERE EXISTS (
        SELECT 1 FROM wallet_ops WHERE wallet_id = OLD.id OR to_wallet_id = OLD.id
    );
END;

-- `wallet_ops` is append-only: rows are never deleted; voiding sets `void_*` columns.
CREATE TRIGGER wallet_ops_no_delete
BEFORE DELETE ON wallet_ops
BEGIN
    SELECT RAISE(ABORT, 'wallet_ops is append-only: rows cannot be deleted');
END;

-- Only a one-way transition from unvoided (`OLD.voided_at IS NULL`) to voided
-- (`NEW.voided_at IS NOT NULL`) is permitted; all original ledger columns are immutable.
CREATE TRIGGER wallet_ops_only_void_transition
BEFORE UPDATE ON wallet_ops
BEGIN
    SELECT RAISE(ABORT, 'voided wallet operation is immutable')
    WHERE OLD.voided_at IS NOT NULL;
    SELECT RAISE(ABORT, 'wallet operation core fields are immutable')
    WHERE NEW.id <> OLD.id
       OR COALESCE(NEW.wallet_id, '') <> COALESCE(OLD.wallet_id, '')
       OR COALESCE(NEW.to_wallet_id, '') <> COALESCE(OLD.to_wallet_id, '')
       OR NEW.kind <> OLD.kind
       OR COALESCE(NEW.via, '') <> COALESCE(OLD.via, '')
       OR COALESCE(NEW.service_type, '') <> COALESCE(OLD.service_type, '')
       OR COALESCE(NEW.reference, '') <> COALESCE(OLD.reference, '')
       OR NEW.amount_minor <> OLD.amount_minor
       OR NEW.fee_minor <> OLD.fee_minor
       OR COALESCE(NEW.note, '') <> COALESCE(OLD.note, '')
       OR NEW.created_by <> OLD.created_by
       OR NEW.created_at <> OLD.created_at
       OR NEW.voided_at IS NULL;
END;
