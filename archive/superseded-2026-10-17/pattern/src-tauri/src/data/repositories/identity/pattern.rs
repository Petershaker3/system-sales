//! The single `manager_pattern` row: verifier and epoch.
//!
//! Exactly one row (`CHECK (id = 1)`), so every accessor takes no id argument —
//! there is nothing to look up. The raw Pattern is never stored: `verifier` is
//! an Argon2id PHC string produced by `services::identity::crypto`, the same
//! format a password uses.
//!
//! `epoch` is the invalidation mechanism (`ADR-014`): bumping it on every
//! set/change/reset makes every stored session approval compare unequal
//! without a sweep of open sessions.

use sqlx::{Row, SqliteConnection};

/// The stored pattern row as the service reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPattern {
    /// Argon2id verifier, PHC-formatted. Never crosses the command boundary.
    pub verifier: String,
    /// Current epoch; approvals are valid only while they match this.
    pub epoch: i64,
}

/// The pattern row, or `None` when no Pattern has ever been configured.
pub async fn find(conn: &mut SqliteConnection) -> Result<Option<StoredPattern>, sqlx::Error> {
    let row = sqlx::query("SELECT verifier, epoch FROM manager_pattern WHERE id = 1")
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.map(|row| StoredPattern {
        verifier: row.get("verifier"),
        epoch: row.get("epoch"),
    }))
}

/// Insert or replace the single row, advancing the epoch, and return the new one.
///
/// `epoch = epoch + 1` on conflict is what invalidates every outstanding
/// session approval the moment the Pattern changes: approvals store the epoch
/// they were granted under and compare unequal from here on. The first insert
/// starts at `1`, matching the column default and the `CHECK (epoch >= 1)`.
pub async fn set(
    conn: &mut SqliteConnection,
    verifier: &str,
    updated_by: &str,
    updated_at: i64,
) -> Result<i64, sqlx::Error> {
    let epoch: i64 = sqlx::query_scalar(
        "INSERT INTO manager_pattern (id, verifier, epoch, updated_by, created_at, updated_at)
         VALUES (1, ?1, 1, ?2, ?3, ?3)
         ON CONFLICT(id) DO UPDATE SET
             verifier = excluded.verifier,
             epoch = manager_pattern.epoch + 1,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at
         RETURNING epoch",
    )
    .bind(verifier)
    .bind(updated_by)
    .bind(updated_at)
    .fetch_one(&mut *conn)
    .await?;
    Ok(epoch)
}

/// Remove the row entirely: no Pattern exists any more.
///
/// After a clear, `find` returns `None` and the current epoch is unknown, so a
/// `require_sensitivity` check fails closed as `PatternNotConfigured` —
/// protection that is on but has no Pattern cannot perform sensitive work.
pub async fn clear(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM manager_pattern WHERE id = 1")
        .execute(&mut *conn)
        .await?;
    Ok(())
}
