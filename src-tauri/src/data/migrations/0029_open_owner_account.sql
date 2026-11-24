-- Migration 0029: the shop may run before it has an account (ADR-039).
--
-- One column. `users.provisional` marks the row that stands for the shop until
-- the owner makes the real account from الإعدادات ← المستخدمين والصلاحيات.
--
-- Why a row at all, if the shop has no account yet: every money and stock row
-- names who wrote it — `sales.sold_by` (`0011`), `stock_movements` (`0008`),
-- `shifts.opened_by` (`0023`), `products.created_by` (`0002`) — and the schema
-- enforces that with a foreign key to `users (id)`. A sale recorded in the first
-- hour on a new device therefore needs a real `users` row to point at. The row is
-- the bookkeeping anchor, not a login: it gets a verifier over a random secret
-- nobody is told, so there is no password to type, and `provisional = 1` is what
-- makes the application resolve its operator from that row instead of from a
-- session token (ADR-039).
--
-- Additive, like `0022`: a column with a constant default, so no rebuild of
-- `users` and no trigger. The CHECK keeps the flag a flag rather than a counter.
-- A database that already has accounts gets `0` on every existing row, which is
-- exactly right: those accounts are all claimed.

ALTER TABLE users
    ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0 CHECK (provisional IN (0, 1));
