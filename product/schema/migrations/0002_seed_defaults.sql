-- Seed defaults, version 1.
--
-- These are data, not structure: the legacy system ships the same reference
-- vocabularies and the same warning horizon, so a fresh database starts with
-- them rather than with empty dropdowns. Nothing here is business state, and a
-- shop that renames or deletes any of these rows loses nothing.
INSERT INTO meta (key, value) VALUES ('schema_version', '1');

INSERT INTO settings (key, value) VALUES ('stagnant_days', '30');

INSERT INTO fault_types (name) VALUES
    ('شاشة'),
    ('بطارية'),
    ('سوفت وير'),
    ('شحن'),
    ('صوت'),
    ('كاميرا');
