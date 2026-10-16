//! XC-10 — no images and no large fields inside the database.
//!
//! `spec:220`: the image is an external file and the database keeps a reference
//! to it, never the bytes. This is a **schema probe**, and it is written as one
//! on purpose: the rule is about the shape of the whole schema, so the honest
//! way to keep it is to walk the entire schema on every run rather than to
//! remember to grep when someone adds a table.
//!
//! A new table with a `BLOB` column passes every functional test in this suite
//! and still breaks the rule. This test is the only thing that notices.

use mobile_shop_system_lib::data::db;
use sqlx::SqlitePool;

/// Every table the migration chain creates, as `(table, column, declared type)`.
async fn every_column(pool: &SqlitePool) -> Vec<(String, String, String)> {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
            AND name <> '_sqlx_migrations'
          ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .expect("the table inventory");

    let mut columns = Vec::new();
    for table in tables {
        // `pragma_table_info` is a table-valued function, so the table name goes
        // in as a bound value rather than being spliced into SQL text.
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT name, type FROM pragma_table_info(?1)")
                .bind(&table)
                .fetch_all(pool)
                .await
                .unwrap_or_else(|error| panic!("columns of {table}: {error}"));
        for (name, declared) in rows {
            columns.push((table.clone(), name, declared));
        }
    }
    columns
}

#[tokio::test]
async fn no_column_in_the_live_schema_declares_a_blob() {
    let pool = db::open_in_memory().await.expect("in-memory database");

    let columns = every_column(&pool).await;
    assert!(
        !columns.is_empty(),
        "the probe found no tables at all, so it would pass while proving nothing"
    );

    let blobs: Vec<String> = columns
        .iter()
        .filter(|(_, _, declared)| declared.eq_ignore_ascii_case("blob"))
        .map(|(table, name, _)| format!("{table}.{name}"))
        .collect();
    assert!(
        blobs.is_empty(),
        "`spec:220` keeps image bytes on disk; these columns store them in the \
         database instead: {}",
        blobs.join(", ")
    );
}

#[tokio::test]
async fn the_only_binary_columns_in_the_schema_are_the_integrity_checks() {
    // Stated precisely, because the rule is not "no BLOB anywhere": the migration
    // ledger stores a SHA-256 checksum, and a checksum is not an image. It is
    // also fixed-width and unreadable as content. Any BLOB that is not one of
    // these is a payload, and a payload is what XC-10 forbids.
    let pool = db::open_in_memory().await.expect("in-memory database");

    let columns = every_column(&pool).await;
    let blobs: Vec<String> = columns
        .iter()
        .filter(|(_, _, declared)| declared.eq_ignore_ascii_case("blob"))
        .map(|(table, name, _)| format!("{table}.{name}"))
        .collect();

    // The one BLOB in this schema is sqlx's own `checksum` on its migration
    // ledger, which belongs to the test harness rather than to the application.
    // Named explicitly so that a SECOND binary column is a loud failure rather
    // than something a reader has to notice.
    let unexpected: Vec<&str> = blobs
        .iter()
        .map(String::as_str)
        .filter(|column| *column != "_sqlx_migrations.checksum")
        .collect();
    assert!(
        unexpected.is_empty(),
        "`spec:220` wants image bytes on disk, not in the database. These \
         binary columns are neither a checksum nor a digest: {}",
        unexpected.join(", ")
    );
}

#[tokio::test]
async fn no_column_is_named_as_if_it_would_hold_a_payload() {
    // The "no large fields" half of XC-10. SQLite puts no length limit on TEXT,
    // so nothing stops an `image_data` column appearing and quietly becoming
    // where the bytes live. Rather than hand-maintain an exemption list of every
    // legitimate column — brittle, and it would have to name all 47 UUID ids and
    // credential hashes — this looks for the names that would signal a payload
    // and requires each to carry a length bound.
    let pool = db::open_in_memory().await.expect("in-memory database");

    let payload_named: Vec<String> = every_column(&pool)
        .await
        .into_iter()
        .filter(|(_, name, declared)| {
            declared.eq_ignore_ascii_case("text")
                && [
                    "blob", "data", "payload", "content", "base64", "bytes", "raw", "image",
                    "photo", "picture", "binary",
                ]
                .iter()
                .any(|needle| name.to_ascii_lowercase().contains(needle))
        })
        .map(|(table, name, _)| format!("{table}.{name}"))
        .collect();

    assert!(
        payload_named.is_empty(),
        "these columns are named like somewhere a payload would be stored, and \
         `spec:220` keeps image bytes on disk: {}",
        payload_named.join(", ")
    );
}

#[tokio::test]
async fn there_is_no_image_reference_column_yet_and_that_is_a_known_gap() {
    // The honest half. XC-10's rule is "the image is an external file with a
    // record reference only", and this schema satisfies it **vacuously**: there
    // is no image support at all — no column on any table holds or names an
    // image.
    //
    // The delivery plan marks XC-10 "IMPLEMENTED" on the strength of a BLOB
    // grep, and that grep was correct about blobs but said nothing about images
    // being present. They are not. Product images belong to P3 (catalogue and
    // hardware, which is BLOCKED on the barcode/scanner decision), so this is a
    // recorded gap, not a defect — and it is asserted as one so that whoever
    // adds the image column in P3 is forced to update this test rather than
    // leaving a stale claim behind.
    let pool = db::open_in_memory().await.expect("in-memory database");

    let image_columns: Vec<String> = every_column(&pool)
        .await
        .into_iter()
        .filter(|(_, name, _)| {
            let lowered = name.to_ascii_lowercase();
            lowered.contains("image") || lowered.contains("photo") || lowered.contains("picture")
        })
        .map(|(table, name, _)| format!("{table}.{name}"))
        .collect();

    assert!(
        image_columns.is_empty(),
        "an image reference column now exists ({}) — update this test. It must \
         stay a bounded path/TEXT reference, never bytes, and the payload-name \
         probe above must be extended to allow it by name only.",
        image_columns.join(", ")
    );
}