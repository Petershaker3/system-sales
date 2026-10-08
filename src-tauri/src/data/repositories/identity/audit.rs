//! Audit trail.
//!
//! `spec:19` attributes every operation to the executing user, and Product Owner
//! decision 2026-10-03 records login, logout and lockout here as well.
//!
//! `user_id` is nullable on purpose: a failed login against an account that does
//! not exist is exactly the event worth keeping, and there is no user to
//! attribute it to.

use sqlx::SqliteConnection;

use crate::domain::identity::UserId;
use crate::domain::identity::Timestamp;

/// Event names. Kept as constants so a typo cannot silently create a new
/// category that no query ever matches.
pub mod event {
    pub const FIRST_MANAGER_CREATED: &str = "first_manager_created";
    pub const LOGIN_SUCCEEDED: &str = "login_succeeded";
    pub const LOGIN_FAILED: &str = "login_failed";
    pub const ACCOUNT_LOCKED: &str = "account_locked";
    pub const LOGOUT: &str = "logout";
    pub const REAUTHENTICATED: &str = "reauthenticated";

    // User lifecycle. All of these record *who did what to whom*, never a
    // credential: `spec:19` attributes every operation, and the schema forbids
    // storing anything secret in `detail`.
    pub const USER_CREATED: &str = "user_created";
    pub const PASSWORD_CHANGED: &str = "password_changed";
    /// A manager set someone else's password. Distinct from
    /// `PASSWORD_CHANGED` so a report can separate self-service from recovery.
    pub const PASSWORD_RESET: &str = "password_reset";
    pub const ROLE_CHANGED: &str = "role_changed";
    pub const USER_DISABLED: &str = "user_disabled";
    pub const USER_ENABLED: &str = "user_enabled";
    pub const USERNAME_CHANGED: &str = "username_changed";

/// Departments: the product classification.
///
/// `DEPARTMENT_RESTORED` is intentionally absent. Restoration clears `archived_at`
/// and returns the department to active, which is an `department_updated` whose
/// detail records the previous state — a separate event name would double the
/// vocabulary without adding a fact.
pub const DEPARTMENT_CREATED: &str = "department_created";
pub const DEPARTMENT_UPDATED: &str = "department_updated";
pub const DEPARTMENT_ARCHIVED: &str = "department_archived";

/// Settings and Pattern.
///
/// `PATTERN_VERIFIED` is intentionally **not** recorded. A successful Pattern
/// entry changes no state: it neither alters the Pattern nor grants a persistent
/// privilege, because the approval expires in five minutes. Logging every prompt
/// would fill the trail with entries that mean nothing, which trains a reader to
/// skip the ones that do. `PATTERN_SET` and `PATTERN_RESET` are recorded because
/// both change the stored verifier and advance the epoch.
pub const SETTING_CHANGED: &str = "setting_changed";
pub const PATTERN_SET: &str = "pattern_set";
pub const PATTERN_RESET: &str = "pattern_reset";
}

/// JSON detail attached to an event. Must never contain a secret.
pub type Detail = Option<String>;

pub async fn append(
    conn: &mut SqliteConnection,
    id: UserId,
    event_type: &str,
    occurred_at: Timestamp,
    detail: Detail,
) -> Result<(), sqlx::Error> {
    append_for(conn, Some(id), event_type, occurred_at, detail).await
}

/// Record an event that may have no attributable user.
pub async fn append_for(
    conn: &mut SqliteConnection,
    user_id: Option<UserId>,
    event_type: &str,
    occurred_at: Timestamp,
    detail: Detail,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO audit_events (id, user_id, event_type, occurred_at, detail)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    // A fresh UUID v7 per event keeps audit rows ordered by time and means an
    // event can never collide with, or overwrite, another.
    .bind(UserId::generate().as_str())
    .bind(user_id.map(|id| id.as_str()))
    .bind(event_type)
    .bind(occurred_at.as_millis())
    .bind(detail)
    .execute(conn)
    .await?;
    Ok(())
}

/// Count events of a type. Used by tests to assert that security-relevant
/// actions are actually recorded rather than assumed to be.
pub async fn count_by_type(
    conn: &mut SqliteConnection,
    event_type: &str,
) -> Result<i64, sqlx::Error> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE event_type = ?1")
        .bind(event_type)
        .fetch_one(conn)
        .await?;
    Ok(count)
}