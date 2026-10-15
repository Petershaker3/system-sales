-- Migration 0010: recovery attempt throttling (R1 closure, B1).
--
-- Guards the single-use recovery staging path against unlimited rapid Pattern
-- guessing. Argon2 cost is deliberately not treated as an attempt limit.
--
-- One row per device. `failed_attempts` counts consecutive wrong Pattern
-- entries; `last_attempt_at` is stamped when an attempt is RESERVED, so the
-- cooldown is measured from the previous attempt rather than from the last
-- failure. `reservation` holds a per-attempt token while an attempt is in
-- flight, which is what makes the reservation mutually exclusive: two
-- simultaneous callers cannot both pass, and only the holder may record the
-- outcome.
--
-- A reservation left behind by a crash is taken over once it is older than
-- RECOVERY_MAX_DELAY_MS, so the throttle degrades to a delay and never to a
-- permanent lock. `users.failed_attempts` is deliberately untouched: that
-- counter would lock the very account this path exists to recover.

CREATE TABLE recovery_attempt (
    device_id       TEXT    PRIMARY KEY,
    failed_attempts INTEGER NOT NULL DEFAULT 0
                    CHECK (failed_attempts >= 0),
    last_attempt_at INTEGER,
    reservation     TEXT
);