//! Applies the versioned schema to a SQLite database.
//!
//! The crate owns no application logic. It owns the migrations directory, the
//! order they run in, and a helper that opens a database with foreign keys
//! enforced. SQLite disables foreign keys by default, so a schema whose
//! relationships are never enforced is decoration; every connection made here
//! turns them on.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// The schema version this crate migrates a database to. The migrations table
/// records this at runtime; this constant lets callers (the importer CLI) report
/// the version they produce without opening a connection just to read it back.
pub const VERSION: &str = "3";

/// Opens `url`, enforces foreign keys, and runs all pending migrations.
pub async fn open(url: &str) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

/// A fresh migrated database in the system temp dir, for tests.
pub async fn open_temp(tag: &str) -> Result<(std::path::PathBuf, SqlitePool), sqlx::Error> {
    let mut path = std::env::temp_dir();
    path.push(format!("mshop_schema_test_{tag}.db"));
    let _ = std::fs::remove_file(&path);
    let url = format!("sqlite://{}", path.display().to_string().replace('\\', "/"));
    let pool = self::open(&url).await?;
    Ok((path, pool))
}
