-- Migration 0030: numbers of one company, and the wallet a payment landed in (ADR-040).
--
-- The owner asked, on the night of 2026-10-19: «في المحافظ مافيش إعداد لإضافة كذا رقم
-- محفظة من نفس الشركة، يعني فودافون كاش يبقى تحته كذا نمرة محفظة». Each number is its own
-- wallet — its own balance, its own limits, its own reconciliation — which the table already
-- allowed. What stopped the shop was `idx_wallets_pay_method`: one wallet could own `vf`, so
-- a second number could never be where a sale's money is collected, and the ledger said
-- nothing about which wallet a payment went into. Both halves change here.
--
-- 1. `wallets.company`: the label a set of numbers is filed under. Presentation and grouping
--    only — no arithmetic reads it. A wallet whose `company` is NULL is its own group, so the
--    five seeded wallets keep standing alone. `length(trim(...)) > 0` keeps an empty string
--    from becoming a group of its own that no one can name.
-- 2. `sale_payments.wallet_id`: the shop wallet a payment was collected into. Until now a
--    payment pointed at a *method* and the wallet that owned that method took the money;
--    with two `vf` wallets, "the method" no longer answers the question, and a total that is
--    derived by matching `method` would count the same sale in both.
-- 3. The unique index goes. `wallets.pay_method` now means "this number receives sales paid
--    this way", and more than one row may say that. The service that moved the link to a new
--    wallet (clearing it from the others) is gone with it: silently re-pointing where tomorrow's
--    money lands, because someone edited a second number, is worse than no link at all.
-- 4. History is backfilled, not reinterpreted: each existing payment row is given the wallet
--    that owned its method at the time — which is exactly the wallet that took the money,
--    because there was only ever one. `ORDER BY sort, id` is the same tie-break the reader
--    uses; with the old invariant in force the choice was unique anyway.
--
-- The backfill is the only `UPDATE` `sale_payments` will ever see, so the append-only trigger
-- is taken down for its duration and put back, unchanged, in this same file. Applied
-- migrations never change: `0021` keeps its trigger as the record of the rule; the drop and
-- recreate here are the exception the rule allows, and the trigger is live again before the
-- migration ends.

ALTER TABLE wallets
    ADD COLUMN company TEXT NULL
    CHECK (company IS NULL OR (length(trim(company)) > 0 AND length(company) <= 80));

CREATE INDEX idx_wallets_company ON wallets (company, sort ASC, id ASC);

ALTER TABLE sale_payments ADD COLUMN wallet_id TEXT NULL REFERENCES wallets (id);

DROP INDEX idx_wallets_pay_method;

CREATE TRIGGER sale_payments_wallet_matches_method
BEFORE INSERT ON sale_payments
WHEN NEW.wallet_id IS NOT NULL
 AND COALESCE(
        (SELECT w.pay_method FROM wallets w WHERE w.id = NEW.wallet_id),
        ''
     ) <> NEW.method
BEGIN
    SELECT RAISE(ABORT, 'sale_payments.wallet_id must name a wallet that receives this method');
END;

DROP TRIGGER sale_payments_no_update;

UPDATE sale_payments
   SET wallet_id = (
       SELECT w.id
         FROM wallets w
        WHERE w.pay_method = sale_payments.method
        ORDER BY w.sort ASC, w.id ASC
        LIMIT 1
   )
 WHERE wallet_id IS NULL;

CREATE TRIGGER sale_payments_no_update
BEFORE UPDATE ON sale_payments
BEGIN
    SELECT RAISE(ABORT, 'sale_payments is append-only');
END;
