//! Device-level settings: the persisted half of the settings domain.
//!
//! One row per key, `value` is always TEXT. Reads tolerate a missing key —
//! that is what [`SettingsSnapshot`] defaults are for — but a *stored* value
//! that does not parse is a protocol error, not a default: the write path
//! validates before storing, so an unparseable value means something wrote
//! around the domain.

use sqlx::{Row, SqliteConnection};

use crate::domain::settings::{Appearance, SettingsSnapshot, APPEARANCE_PREFIX};

/// Read every stored row as `(key, value)` pairs.
///
/// Unordered: the snapshot applies them onto defaults, and application order
/// does not matter because each key is distinct (`PRIMARY KEY`).
pub async fn read_all(
    conn: &mut SqliteConnection,
) -> Result<Vec<(String, String)>, sqlx::Error> {
    let rows = sqlx::query("SELECT key, value FROM app_settings")
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.get("key"), row.get("value")))
        .collect())
}

/// Read one key, or `None` when the device has never set it.
pub async fn get(
    conn: &mut SqliteConnection,
    key: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(&mut *conn)
        .await
}

/// Insert or replace one setting.
///
/// `updated_by` and `updated_at` come from the service, which takes them from
/// the resolved session: attribution is a fact, never a parameter a caller
/// supplies.
pub async fn set(
    conn: &mut SqliteConnection,
    key: &str,
    value: &str,
    updated_by: &str,
    updated_at: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(value)
    .bind(updated_by)
    .bind(updated_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Build the snapshot from stored rows, applying defaults for absent keys.
///
/// A stored value that does not parse is reported, never silently defaulted:
/// the write path refuses such values, so reaching this branch means something
/// wrote around the domain and the corruption should be visible. The one row
/// the snapshot does not own is [`PATTERN_REQUIRED`], read by the pattern
/// slice; it is skipped by name rather than dropped with every unknown key,
/// because `update` already guarantees no other unknown key can exist.
pub async fn load_snapshot(
    conn: &mut SqliteConnection,
) -> Result<SettingsSnapshot, sqlx::Error> {
    let rows = read_all(conn).await?;
    let mut snapshot = SettingsSnapshot::default();
    for (key, value) in rows {
        // Rows another slice owns: the Pattern flag, and the display choices
        // (`ui.*`), which must never be able to fail a sale's snapshot read.
        if key == crate::domain::settings::PATTERN_REQUIRED || key.starts_with(APPEARANCE_PREFIX) {
            continue;
        }
        snapshot
            .set(&key, &value)
            .map_err(|error| sqlx::Error::Protocol(format!("bad setting `{key}`: {error}")))?;
    }
    Ok(snapshot)
}

/// Build the display choices from stored `ui.*` rows, defaults for the rest.
///
/// A stored value that does not parse is reported, exactly as for the
/// snapshot: the write path validates first, so it means something wrote
/// around the domain.
pub async fn load_appearance(conn: &mut SqliteConnection) -> Result<Appearance, sqlx::Error> {
    let rows = read_all(conn).await?;
    let mut appearance = Appearance::default();
    for (key, value) in rows {
        if !key.starts_with(APPEARANCE_PREFIX) {
            continue;
        }
        appearance
            .set(&key, &value)
            .map_err(|error| sqlx::Error::Protocol(format!("bad setting `{key}`: {error}")))?;
    }
    Ok(appearance)
}
