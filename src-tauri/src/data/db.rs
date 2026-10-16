//! Database access.
//!
//! This module and everything under `repositories/` are the only places SQLx
//! and SQLite may appear (`spec:101`, `ADR-008:123`).

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::time::Duration;

/// How long SQLite waits on a locked database before returning `SQLITE_BUSY`.
///
/// Without this, SQLite returns `SQLITE_BUSY` the instant it cannot take the write
/// lock. WAL lets a reader proceed while a writer holds the lock, but it does not
/// let two writers overlap: the second writer fails immediately rather than
/// waiting for the first to commit. That makes a busy timeout a prerequisite for
/// any later transaction that reads, computes and writes.
///
/// Every transaction in this project is currently deferred (`pool.begin()`), so a
/// transaction that upgrades to a write lock mid-flight is a live failure mode.
/// This constant configures the wait only. It does not change which kind of
/// transaction begins, and it is not a substitute for choosing the right one.
pub const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Open the pool for the device's local database and apply migrations.
///
/// Each device owns its own file and its own data; there is no shared database
/// and no synchronisation in V1 (`ADR-008:12`).
pub async fn open(path: &std::path::Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        // sqlx defaults this to false, so without it the very first launch on a
        // fresh device fails with SQLITE_CANTOPEN: the file does not exist yet.
        // The database legitimately starts empty (`spec:175`), so creating it is
        // correct rather than a workaround.
        .create_if_missing(true)
        // SQLite does not enforce foreign keys unless asked, per connection.
        // Without this the `sessions -> users` cascade would silently do nothing.
        .foreign_keys(true)
        // WAL lets a reader run while a writer holds the lock, which matters
        // once a long transaction exists.
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        // Wait rather than fail when another connection holds the write lock. Set
        // per connection, like every other option here, so it must appear on both
        // pools; SQLite has no database-wide setting for it.
        .busy_timeout(BUSY_TIMEOUT);

    let pool = SqlitePoolOptions::new()
        // A POS device runs one operator at a time. A small pool avoids
        // `SQLITE_BUSY` between the write lock and the OS keyring call.
        .max_connections(4)
        .connect_with(options)
        .await?;

    migrate(&pool).await?;
    Ok(pool)
}

/// Apply pending migrations.
///
/// Forward-only. `plan:143` fixes rollback as restore-then-forward-fix, so no
/// `Down` script exists or should be added.
async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::migrate!("./src/data/migrations").run(pool).await?;
    Ok(())
}

/// Open an in-memory database for integration tests.
///
/// Real SQLite, not a mock (`spec:138`).
pub async fn open_in_memory() -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .in_memory(true)
        .foreign_keys(true)
        // The in-memory pool holds a single connection, so it cannot contend with
        // itself and this setting does nothing here today. It is applied anyway
        // so the two pools cannot drift apart: a later change that widens this one
        // must not silently produce a pool with a different contention policy than
        // the device pool.
        .busy_timeout(BUSY_TIMEOUT);

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;

    migrate(&pool).await?;
    Ok(pool)
}