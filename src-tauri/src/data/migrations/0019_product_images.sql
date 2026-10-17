-- 0019_product_images.sql
--
-- Product images («صور الأصناف», ADR-018 §5, plan item 1.2 step 5).
--
-- Each product may have one optional 192×192 JPEG thumbnail stored on disk
-- under `images/<product_id>.jpg` beside `shop.db`. In compliance with XC-10
-- (`spec:220`), the database stores only the relative file reference and its
-- verified dimensions and byte length — never the image bytes.
--
-- Because the file lives inside `images/`, the encrypted backup engine
-- (`services/backup`) packs it into the backup container with its SHA-256 and
-- restores it alongside `shop.db`.

CREATE TABLE product_images (
    product_id TEXT    PRIMARY KEY REFERENCES products (id) ON DELETE RESTRICT,
    file       TEXT    NOT NULL UNIQUE CHECK (
        length(trim(file)) > 0
        AND length(file) <= 128
        AND file GLOB 'images/[0-9a-fA-F-]*.jpg'
        AND file NOT LIKE '%..%'
        AND file NOT LIKE '%/%/%'
        AND file NOT LIKE '%\\%'
    ),
    w          INTEGER NOT NULL CHECK (w = 192),
    h          INTEGER NOT NULL CHECK (h = 192),
    bytes      INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 65536)
);
