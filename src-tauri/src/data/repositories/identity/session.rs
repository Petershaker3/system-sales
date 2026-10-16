//! Session persistence.
//!
//! Stores only `SHA-256(token)`. The token itself lives in the OS credential
//! store and never reaches SQLite, the WebView, or a log line (ADR-009).

use sqlx::{Row, SqliteConnection};

use crate::domain::identity::UserId;
use crate::domain::identity::Role;
use crate::domain::identity::{Assurance, SessionFacts, Timestamp};

/// The digest that stands in for a token in the database.
pub type TokenHash = String;

/// Persistence shape of one session row.
pub struct SessionRow {
    pub token_hash: TokenHash,
    pub facts: SessionFacts,
}

fn parse_assurance(raw: &str) -> Result<Assurance, sqlx::Error> {
    match raw {
        "normal" => Ok(Assurance::Normal),
        "reauthenticated" => Ok(Assurance::Reauthenticated),
        other => Err(sqlx::Error::Protocol(format!(
            "unknown assurance level in sessions table: {other}"
        ))),
    }
}

pub async fn insert(
    conn: &mut SqliteConnection,
    token_hash: &str,
    facts: &SessionFacts,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, assurance, issued_at, last_seen_at, absolute_expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(token_hash)
    .bind(facts.user_id.as_str())
    .bind(match facts.assurance {
        Assurance::Normal => "normal",
        Assurance::Reauthenticated => "reauthenticated",
    })
    .bind(facts.issued_at.as_millis())
    .bind(facts.last_seen_at.as_millis())
    .bind(facts.absolute_expires_at.as_millis())
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn find_by_token_hash(
    conn: &mut SqliteConnection,
    token_hash: &str,
) -> Result<Option<SessionRow>, sqlx::Error> {
let row = sqlx::query(
        "SELECT token_hash, user_id, assurance, issued_at, last_seen_at, absolute_expires_at,
                pattern_approved_at, pattern_epoch
         FROM sessions WHERE token_hash = ?1",
    )
    .bind(token_hash)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else { return Ok(None) };

    let raw_user: String = row.get("user_id");
    let assurance_raw: String = row.get("assurance");
    let issued: i64 = row.get("issued_at");
    let last_seen: i64 = row.get("last_seen_at");
    let absolute: i64 = row.get("absolute_expires_at");

    // Pattern approval is read from the session row, unlike role and forced-change.
    //
    // That is a deliberate difference. Role and `must_change_password` are read
    // from `users` and `user_credentials` so a change takes effect on the very next
    // command. Pattern approval is different in kind: it is a *record of an event*
    // ("this session passed the Pattern at this moment"), not a state that another
    // table can contradict. Its validity is decided by comparing the stored epoch
    // against `manager_pattern.epoch` at check time, so a Pattern change
    // invalidates it immediately without touching any session row.
    let pattern_approved_at: Option<i64> = row.get("pattern_approved_at");
    let pattern_epoch: Option<i64> = row.get("pattern_epoch");

    // Account state is resolved from `users` and `user_credentials`, never from
    // the session row: `plan:151` requires Rust to read authority from the
    // database, and caching any of it in the session row would let a role change,
    // a disable, or a forced password change linger until the session expired.
    let role_raw: String =
        sqlx::query_scalar("SELECT role FROM users WHERE id = ?1")
            .bind(&raw_user)
            .fetch_optional(&mut *conn)
            .await?
            .ok_or_else(|| sqlx::Error::Protocol("session references a missing user".into()))?;

    // `disabled_at` is a column on the `users` row, and that row was just proven to
    // exist by the role read above, so the query always yields a row. It is written
    // out rather than `.flatten()`ed so that "no row" cannot silently become
    // "not disabled" if this ever moves to a joined or optional source.
    let disabled_raw: Option<i64> =
        sqlx::query_scalar("SELECT disabled_at FROM users WHERE id = ?1")
            .bind(&raw_user)
            .fetch_optional(&mut *conn)
            .await?
            .ok_or_else(|| sqlx::Error::Protocol("session references a missing user".into()))?;

    // `Option<Option<i64>>`, not a flattened `Option<i64>`. Three distinct states:
    //
    //   Some(Some(1))  must change
    //   Some(Some(0))  no change pending
    //   None           the credentials row is absent
    //
    // The absent case is an integrity failure and must not collapse into "no change
    // pending": defaulting it would hand out a session that walks straight past the
    // forced-change gate, which is the control that confines a manager-reset account
    // to a single operation.
    let must_change_raw: Option<i64> =
        sqlx::query_scalar("SELECT must_change_password FROM user_credentials WHERE user_id = ?1")
            .bind(&raw_user)
            .fetch_optional(&mut *conn)
            .await?;

    let must_change_password = match must_change_raw {
        Some(value) => value != 0,
        None => {
            return Err(sqlx::Error::Protocol(format!(
                "session user {raw_user} has no user_credentials row"
            )))
        }
    };

    let role = Role::parse(&role_raw)
        .ok_or_else(|| sqlx::Error::Protocol("unknown role in users table".into()))?;

    Ok(Some(SessionRow {
        token_hash: row.get("token_hash"),
        facts: SessionFacts {
            user_id: UserId::from_uuid(
                raw_user
                    .parse()
                    .map_err(|_| sqlx::Error::Protocol("malformed user id".into()))?,
            ),
            role,
            assurance: parse_assurance(&assurance_raw)?,
            issued_at: Timestamp::from_millis(issued),
            last_seen_at: Timestamp::from_millis(last_seen),
            absolute_expires_at: Timestamp::from_millis(absolute),
            must_change_password,
            disabled_at: disabled_raw.map(Timestamp::from_millis),
            pattern_approved_at: pattern_approved_at.map(Timestamp::from_millis),
            // `pattern_epoch` is NOT NULL with default 0, so a session that never
            // approved reads as `Some(0)`. Paired with `pattern_approved_at: None`
            // that means "no approval", which is what `require_sensitivity` checks
            // first. Mapping 0 to `None` here would lose the distinction between
            // "never approved" and "approved under epoch zero", and no real
            // approval ever carries epoch 0 — `manager_pattern.epoch` starts at 1.
            pattern_epoch: match (pattern_epoch, pattern_approved_at) {
                (Some(epoch), Some(_)) => Some(epoch),
                _ => None,
            },
        },
    }))
}

/// Revoke every session belonging to one user, and report how many went.
///
/// Scoped to `user_id` deliberately. `delete_all` exists for signing in, where a
/// terminal has one operator at a time. Reusing it here would be wrong: a manager
/// resetting another operator's password is signed in themselves, and wiping every
/// session would sign the manager out during their own operation.
pub async fn delete_by_user(
    conn: &mut SqliteConnection,
    user_id: UserId,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query("DELETE FROM sessions WHERE user_id = ?1")
        .bind(user_id.as_str())
        .execute(conn)
        .await?;
    Ok(result.rows_affected())
}

pub async fn delete_by_token_hash(
    conn: &mut SqliteConnection,
    token_hash: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?1")
        .bind(token_hash)
        .execute(conn)
        .await?;
    Ok(())
}

/// Drop every session.
///
/// A POS terminal has one operator at a time, so signing in as a different user
/// ends the previous session rather than running two in parallel. That also
/// bounds the table and removes any ambiguity about which session the token in
/// the OS store refers to.
pub async fn delete_all(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sessions")
        .execute(conn)
        .await?;
    Ok(())
}

/// Restart the idle timer. The absolute deadline is deliberately not touched.
pub async fn touch(
    conn: &mut SqliteConnection,
    token_hash: &str,
    now: Timestamp,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE sessions SET last_seen_at = ?2 WHERE token_hash = ?1")
        .bind(token_hash)
        .bind(now.as_millis())
        .execute(conn)
        .await?;
    Ok(())
}

pub async fn set_assurance(
    conn: &mut SqliteConnection,
    token_hash: &str,
    assurance: Assurance,
) -> Result<(), sqlx::Error> {
    let value = match assurance {
        Assurance::Normal => "normal",
        Assurance::Reauthenticated => "reauthenticated",
    };
    sqlx::query("UPDATE sessions SET assurance = ?2 WHERE token_hash = ?1")
        .bind(token_hash)
        .bind(value)
        .execute(conn)
        .await?;
    Ok(())
}

/// Record that this session passed the Pattern, under the given epoch.
///
/// Both values live on the session row rather than being derived, because the
/// five-minute window is measured from the moment of verification and must not
/// restart on every command (`plan` SP-1b, Task 4).
pub async fn set_pattern_approval(
    conn: &mut SqliteConnection,
    token_hash: &str,
    approved_at: Timestamp,
    epoch: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE sessions SET pattern_approved_at = ?2, pattern_epoch = ?3 WHERE token_hash = ?1")
        .bind(token_hash)
        .bind(approved_at.as_millis())
        .bind(epoch)
        .execute(conn)
        .await?;
    Ok(())
}

/// Housekeeping: remove sessions that can no longer be used.
pub async fn delete_expired(
    conn: &mut SqliteConnection,
    now: Timestamp,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query("DELETE FROM sessions WHERE absolute_expires_at <= ?1")
        .bind(now.as_millis())
        .execute(conn)
        .await?;
    Ok(result.rows_affected())
}