-- Migration 0031: every sum of money names the wallet number that took it (`ADR-041`).
--
-- `0030` gave a sale payment its wallet, because two numbers of one company could not share a
-- method without that. The owner then closed the question: «لما اجي اعمل عملية دفع او استلام
-- فلوس، سواء اكسسوار أو هواتف أو صيانة أو سوفت وير وغيرها، نختار رقم من المحفظة هو اللي
-- استقبل أو بعّت». Two flows were still naming a *method* only. They get the same column, and
-- the reading rule stops being three rules and becomes one:
--
--   a row's money belongs to the wallet the row names. A row that names none belongs to none.
--
-- Which is also why there is no "fall back to the primary wallet of the method" clause here:
-- deriving old money from whoever happens to be first in the order would let a sale's history
-- walk between two numbers because somebody dragged a row down a list. So the history is
-- named once, here, and never re-derived.
--
-- 1. `customer_ledger.wallet_id` — a customer settling a debt transfers to a number, not to
--    "Vodafone Cash". `credit_sale` and `sale_reversal` rows carry no money into a shop wallet
--    (`method` is NULL on them by their own CHECK) and stay NULL here.
-- 2. `repairs.pay_wallet_id` — the money of a settled repair (`final_price_minor -
--    deposit_minor`) and the deposit when the ticket was delivered on the spot. One column
--    beside the one `pay_method` the row already has: the repair table records how a ticket was
--    settled, it is not a ledger.
-- 3. Both histories are named by the same tie-break `0030` used for `sale_payments` — the wallet
--    that owned the method at that moment, which was unique until `0030` removed the index, so
--    the choice is a fact and not a preference.
--
-- `customer_ledger` is append-only like `sale_payments`, so its trigger comes down for the
-- backfill and goes back up, text unchanged, in this same file (`0030` set the precedent and
-- its test pins the order: drop < backfill < create). `repairs` has no such trigger.

ALTER TABLE customer_ledger ADD COLUMN wallet_id TEXT NULL REFERENCES wallets (id);

ALTER TABLE repairs ADD COLUMN pay_wallet_id TEXT NULL REFERENCES wallets (id);

DROP TRIGGER customer_ledger_no_update;

UPDATE customer_ledger
   SET wallet_id = (
       SELECT w.id
         FROM wallets w
        WHERE w.pay_method = customer_ledger.method
        ORDER BY w.sort ASC, w.id ASC
        LIMIT 1
   )
 WHERE wallet_id IS NULL
   AND kind = 'payment';

CREATE TRIGGER customer_ledger_no_update
BEFORE UPDATE ON customer_ledger
BEGIN
    SELECT RAISE(ABORT, 'customer_ledger is append-only');
END;

UPDATE repairs
   SET pay_wallet_id = (
       SELECT w.id
         FROM wallets w
        WHERE w.pay_method = repairs.pay_method
        ORDER BY w.sort ASC, w.id ASC
        LIMIT 1
   )
 WHERE pay_wallet_id IS NULL
   AND status = 'delivered';
