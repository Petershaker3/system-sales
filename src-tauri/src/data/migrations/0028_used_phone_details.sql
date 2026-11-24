-- 0028_used_phone_details.sql
--
-- Used phone unit details (`ADR-032`, `ADR-016` #15-#16, #31, #34, `PLAN.md` §13):
-- Condition grade (`A` | `B` | `C`), battery health percentage (`1..100`),
-- accessories included with the device (`علبة`, `شاحن`, `فاتورة`, ...),
-- optional seller identity (`seller_name`, `seller_phone`, `seller_national_id`),
-- and inspection notes (`intake_note`).

ALTER TABLE units ADD COLUMN condition_grade TEXT NULL CHECK (condition_grade IS NULL OR condition_grade IN ('A', 'B', 'C'));

ALTER TABLE units ADD COLUMN battery_health_pct INTEGER NULL CHECK (battery_health_pct IS NULL OR (battery_health_pct BETWEEN 1 AND 100));

ALTER TABLE units ADD COLUMN accessories TEXT NULL CHECK (accessories IS NULL OR length(trim(accessories)) <= 240);

ALTER TABLE units ADD COLUMN seller_name TEXT NULL CHECK (seller_name IS NULL OR length(trim(seller_name)) <= 120);

ALTER TABLE units ADD COLUMN seller_phone TEXT NULL CHECK (seller_phone IS NULL OR length(trim(seller_phone)) <= 40);

ALTER TABLE units ADD COLUMN seller_national_id TEXT NULL CHECK (seller_national_id IS NULL OR (length(seller_national_id) = 14 AND seller_national_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'));

ALTER TABLE units ADD COLUMN intake_note TEXT NULL CHECK (intake_note IS NULL OR length(trim(intake_note)) <= 400);
