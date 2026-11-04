-- Migration 0034: a wallet can carry a monthly ceiling.
--
-- `max_limit_minor` is a ceiling on the balance itself, and `daily_limit_minor` is
-- a ceiling on how much moves in one day. Neither answers the question a shop with
-- a Vodafone Cash or InstaPay account actually asks: how much of this month's
-- allowance is already used? A monthly limit is a third, separate number — the
-- wallet's own agreement with the provider — and 0 keeps meaning "no limit", the
-- same convention the other two columns use.
--
-- Additive: no table is rebuilt, no row is rewritten. Every existing wallet starts
-- at 0, which is exactly the behaviour it had before this migration.

ALTER TABLE wallets ADD COLUMN monthly_limit_minor INTEGER NOT NULL DEFAULT 0
    CHECK (monthly_limit_minor >= 0);
