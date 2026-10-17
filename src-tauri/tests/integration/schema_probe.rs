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
async fn product_images_stores_a_bounded_file_reference_and_metadata_never_bytes() {
    // XC-10 (`spec:220`) and ADR-018 §5: `product_images` holds the product id,
    // the relative file path under `images/`, and the verified dimensions and
    // byte count — never the image payload.
    let pool = db::open_in_memory().await.expect("in-memory database");
    let columns = every_column(&pool).await;

    let image_table: Vec<(String, String)> = columns
        .iter()
        .filter(|(table, _, _)| table == "product_images")
        .map(|(_, name, declared)| (name.clone(), declared.to_ascii_uppercase()))
        .collect();
    assert_eq!(
        image_table,
        vec![
            ("product_id".to_string(), "TEXT".to_string()),
            ("file".to_string(), "TEXT".to_string()),
            ("w".to_string(), "INTEGER".to_string()),
            ("h".to_string(), "INTEGER".to_string()),
            ("bytes".to_string(), "INTEGER".to_string()),
        ]
    );

    let image_columns: Vec<String> = columns
        .into_iter()
        .filter(|(_, name, _)| {
            let lowered = name.to_ascii_lowercase();
            lowered.contains("image") || lowered.contains("photo") || lowered.contains("picture")
        })
        .map(|(table, name, _)| format!("{table}.{name}"))
        .collect();

    assert!(
        image_columns.is_empty(),
        "no column is named after an embedded image payload ({})",
        image_columns.join(", ")
    );
}
