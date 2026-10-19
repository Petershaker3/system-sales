//! User persistence.
//!
//! Functions take `&mut SqliteConnection` rather than a pool, so the exact same
//! code serves both a pooled call and a call inside an open transaction. That is
//! what allows the first-run bootstrap to count and insert atomically.

use sqlx::{Row, SqliteConnection};

use crate::domain::identity::DomainError;
use crate::domain::identity::UserId;
use crate::domain::identity::Role;
use crate::domain::identity::Timestamp;
use crate::domain::identity::{CredentialVerifier, User, Username};

/// How many accounts exist. The first-run gate is `count == 0`.
///
/// The open owner row of `ADR-039` counts here, because it is a row; the gate
/// that asks "has anybody made an account" is [`count_claimed`].
pub async fn count_all(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(conn)
        .await?;
    Ok(count)
}

/// How many accounts can still sign in: enabled, and not inside a lockout.
///
/// This is what backs the last-manager guard. Counting only `role = 'manager'`
/// would be wrong, because a locked or disabled manager cannot administer the
/// device either.
pub async fn count_active_managers(
    conn: &mut SqliteConnection,
    now: Timestamp,
) -> Result<i64, sqlx::Error> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM users
         WHERE role = 'manager'
           AND disabled_at IS NULL
           AND (locked_until IS NULL OR locked_until <= ?1)",
    )
    .bind(now.as_millis())
    .fetch_one(conn)
    .await?;
    Ok(count)
}

/// The manager who has been here longest and is not disabled, if any: who the
/// default categories are attributed to when they are added at start-up for a
/// database made before them (ADR-018 §1).
pub async fn first_active_manager(
    conn: &mut SqliteConnection,
) -> Result<Option<UserId>, sqlx::Error> {
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT id FROM users
          WHERE role = 'manager' AND disabled_at IS NULL
          ORDER BY created_at ASC, id ASC
          LIMIT 1",
    )
    .fetch_optional(&mut *conn)
    .await?;
    match raw {
        Some(id) => id
            .parse::<uuid::Uuid>()
            .map(|uuid| Some(UserId::from_uuid(uuid)))
            .map_err(|_| sqlx::Error::Protocol("malformed user id in users".to_string())),
        None => Ok(None),
    }
}

/// The row that stands for a shop that is running before it has an account
/// (`ADR-039`, migration `0029`).
///
/// There is at most one: it is written only when `users` is empty, and
/// [`claim_open`] retires the flag for good. The display name travels with it so
/// the top bar and the banner can name the operator without a second query.
pub struct OpenRow {
    pub id: UserId,
    pub display_name: String,
}

/// The open account, or `None` once the shop has claimed it (or never had one).
///
/// `disabled_at IS NULL` belongs in the read rather than in the caller: a shop
/// that disabled the open row by hand made an administrative decision, and
/// answering "still open" would undo that decision on every later command.
pub async fn find_open(conn: &mut SqliteConnection) -> Result<Option<OpenRow>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, display_name FROM users
          WHERE provisional = 1 AND disabled_at IS NULL
          ORDER BY created_at ASC, id ASC
          LIMIT 1",
    )
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else { return Ok(None) };
    let raw_id: String = row.get("id");
    Ok(Some(OpenRow {
        id: UserId::from_uuid(
            raw_id
                .parse()
                .map_err(|_| sqlx::Error::Protocol("malformed user id in users".to_string()))?,
        ),
        display_name: row.get("display_name"),
    }))
}

/// How many accounts somebody can sign in to: every account but the open row.
///
/// [`count_all`] counts rows, and the open row is a row. This is the count the
/// lock screen and the setup gate ask about, because an account nobody can sign in
/// with is not an account to the person standing at the counter.
pub async fn count_claimed(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE provisional = 0")
            .fetch_one(conn)
            .await?;
    Ok(count)
}

/// Map one `users` row onto the domain.
///
/// Extracted because `find_by_id` and `list` were duplicating this exact parsing,
/// and every new query would have added a third copy. A corrupt row is an error
/// rather than a default: defaulting an unparseable role to the lesser one would
/// quietly turn a manager into a sales account.
fn row_to_user(row: &sqlx::sqlite::SqliteRow) -> Result<User, sqlx::Error> {
    let raw_id: String = row.get("id");
    let role_raw: String = row.get("role");
    let verifier_raw: String = row.get("verifier");
    let locked: Option<i64> = row.get("locked_until");

    let role = Role::parse(&role_raw)
        .ok_or_else(|| sqlx::Error::Protocol("unknown role in users table".into()))?;
    let verifier = CredentialVerifier::from_phc(verifier_raw)
        .map_err(|_| sqlx::Error::Protocol("empty verifier in users table".into()))?;

    Ok(User {
        id: UserId::from_uuid(
            raw_id
                .parse()
                .map_err(|_| sqlx::Error::Protocol("malformed user id".into()))?,
        ),
        display_name: row.get("display_name"),
        role,
        verifier,
        failed_attempts: row.get("failed_attempts"),
        locked_until: locked.map(Timestamp::from_millis),
    })
}

// Written inline at each call site rather than interpolated: sqlx rejects a
// dynamically built statement when a bound parameter is involved, because it
// cannot prove the string is free of caller input.
pub async fn insert(
    conn: &mut SqliteConnection,
    user: &User,
    now: Timestamp,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO users (id, display_name, role, verifier, failed_attempts, locked_until, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
    )
    .bind(user.id.as_str())
    .bind(&user.display_name)
    .bind(user.role.as_str())
    .bind(user.verifier.expose())
    .bind(user.failed_attempts)
    .bind(user.locked_until.map(|t| t.as_millis()))
    .bind(now.as_millis())
    .execute(conn)
    .await?;
    Ok(())
}

/// Insert the open owner row (`ADR-039`).
///
/// Separate from [`insert`] because this is the only write permitted to set
/// `provisional`: an account a person made, with a password they chose, is never
/// open, and an open row is never anything else. Two INSERTs state that as a fact
/// of the code; one INSERT with a flag parameter leaves it as a convention that a
/// later caller can forget.
pub async fn insert_open(
    conn: &mut SqliteConnection,
    user: &User,
    now: Timestamp,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO users (id, display_name, role, verifier, failed_attempts, locked_until, created_at, updated_at, provisional)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 1)",
    )
    .bind(user.id.as_str())
    .bind(&user.display_name)
    .bind(user.role.as_str())
    .bind(user.verifier.expose())
    .bind(user.failed_attempts)
    .bind(user.locked_until.map(|t| t.as_millis()))
    .bind(now.as_millis())
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn find_by_id(
    conn: &mut SqliteConnection,
    id: UserId,
) -> Result<Option<User>, sqlx::Error> {
    // `format!` is avoided: sqlx rejects a dynamically built query string when a
    // bound parameter is involved, because it cannot prove the string is free of
    // caller input. The column list is a constant, but keeping it inline reads
    // better next to the statement anyway.
    let row = sqlx::query(
        "SELECT id, display_name, role, verifier, failed_attempts, locked_until, disabled_at
         FROM users WHERE id = ?1",
    )
    .bind(id.as_str())
    .fetch_optional(conn)
    .await?;

    match row {
        Some(row) => Ok(Some(row_to_user(&row)?)),
        None => Ok(None),
    }
}

/// When the account was disabled, or `None` while it is active.
///
/// Read separately from [`find_by_id`] because the `User` struct models who
/// someone is, not whether they may still sign in. Keeping the lifecycle state out
/// of `User` means a stale in-memory copy of a user cannot look active.
pub async fn find_disabled_at(
    conn: &mut SqliteConnection,
    id: UserId,
) -> Result<Option<Option<Timestamp>>, sqlx::Error> {
    let row = sqlx::query("SELECT disabled_at FROM users WHERE id = ?1")
        .bind(id.as_str())
        .fetch_optional(conn)
        .await?;
    Ok(row.map(|row| row.get::<Option<i64>, _>("disabled_at")).map(|v| v.map(Timestamp::from_millis)))
}

/// Every account, for the login picker.
///
/// Ordering is by display name so the picker is stable and predictable for the
/// operator; ids are UUID v7 but name order is what a human scans.
pub async fn list(conn: &mut SqliteConnection) -> Result<Vec<User>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, display_name, role, verifier, failed_attempts, locked_until
         FROM users ORDER BY display_name COLLATE NOCASE ASC",
    )
    .fetch_all(conn)
    .await?;

    let mut users = Vec::with_capacity(rows.len());
    for row in &rows {
        users.push(row_to_user(row)?);
    }
    Ok(users)
}

/// One account with its credential-side facts.
///
/// `username` and `must_change_password` are `Option` because the join is a `LEFT`
/// JOIN. A `users` row that has lost its `user_credentials` row is still an account,
/// and hiding it would make identity disappear silently. Carrying the absence
/// explicitly lets the caller report an integrity failure and name the account
/// instead of quietly shortening a list.
pub struct AccountWithCredentials {
    pub user: User,
    pub username: Option<Username>,
    pub must_change_password: Option<bool>,
    pub disabled_at: Option<Timestamp>,
    /// Whether this is the open owner row (`ADR-039`, migration `0029`) rather than
    /// an account somebody made. Carried here rather than filtered in SQL because
    /// both readers of this query decide differently — see the two services — and a
    /// repository that silently shortened the list would take that decision away.
    pub provisional: bool,
}

/// Whether this id is the shop's own open till rather than an account (`ADR-039`).
///
/// Separate from [`find_by_id`] on purpose: the manager commands read a row as a
/// `User` and must not have to learn about open mode to do it, while the column
/// belongs here and not in the domain type every rule reads. A missing id answers
/// `false` — the caller's own "no such user" is the better error for that.
pub async fn is_provisional(
    conn: &mut SqliteConnection,
    id: UserId,
) -> Result<bool, sqlx::Error> {
    let flag: Option<i64> = sqlx::query_scalar("SELECT provisional FROM users WHERE id = ?1")
        .bind(id.as_str())
        .fetch_optional(conn)
        .await?;
    Ok(flag.unwrap_or(0) != 0)
}

/// Every account with its login identifier, for the picker and user management.
///
/// `LEFT JOIN`, not `INNER JOIN`: an account missing its credentials row must still
/// come back. An inner join drops it silently, and an operator staring at a short
/// list has no way to know an account disappeared.
///
/// Ordering is by display name so the picker is stable and predictable for the
/// operator; ids are UUID v7 but name order is what a human scans.
pub async fn list_with_usernames(
    conn: &mut SqliteConnection,
) -> Result<Vec<AccountWithCredentials>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT u.id, u.display_name, u.role, u.verifier, u.failed_attempts,
                u.locked_until, u.disabled_at, u.provisional,
                c.username, c.must_change_password
         FROM users u
         LEFT JOIN user_credentials c ON c.user_id = u.id
         ORDER BY u.display_name COLLATE NOCASE ASC",
    )
    .fetch_all(conn)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let user = row_to_user(row)?;

        // Absent credentials yield `None`: no default, no fabricated username.
        // Inventing one here would hide the very corruption this shape exposes.
        let username = match row.get::<Option<String>, _>("username") {
            None => None,
            Some(raw) => Some(Username::parse(&raw).ok_or_else(|| {
                sqlx::Error::Protocol(format!("invalid username in user_credentials: {raw}"))
            })?),
        };

        let must_change_password = row
            .get::<Option<i64>, _>("must_change_password")
            .map(|v| v != 0);
        let disabled_at: Option<i64> = row.get("disabled_at");

        out.push(AccountWithCredentials {
            user,
            username,
            must_change_password,
            disabled_at: disabled_at.map(Timestamp::from_millis),
            provisional: row.get::<i64, _>("provisional") != 0,
        });
    }
    Ok(out)
}

/// Persist the counters produced by the lockout state machine.
pub async fn update_lockout(
    conn: &mut SqliteConnection,
    id: UserId,
    failed_attempts: i32,
    locked_until: Option<Timestamp>,
    now: Timestamp,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE users SET failed_attempts = ?2, locked_until = ?3, updated_at = ?4 WHERE id = ?1",
    )
    .bind(id.as_str())
    .bind(failed_attempts)
    .bind(locked_until.map(|t| t.as_millis()))
    .bind(now.as_millis())
    .execute(conn)
    .await?;
    Ok(())
}

/// Replace the stored verifier.
///
/// This function is why a forgotten password is recoverable. Without it a device
/// could only ever be recovered by discarding the database, which loses the audit
/// trail and every product attributed to the account.
pub async fn update_verifier(
    conn: &mut SqliteConnection,
    id: UserId,
    verifier: &CredentialVerifier,
    now: Timestamp,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE users SET verifier = ?2, updated_at = ?3 WHERE id = ?1")
        .bind(id.as_str())
        .bind(verifier.expose())
        .bind(now.as_millis())
        .execute(conn)
        .await?;
    Ok(())
}

/// Change the account role.
///
/// The role is the one field that decides what an operator may see, so this is
/// treated as a privileged write like the verifier.
pub async fn update_role(
    conn: &mut SqliteConnection,
    id: UserId,
    role: Role,
    now: Timestamp,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE users SET role = ?2, updated_at = ?3 WHERE id = ?1")
        .bind(id.as_str())
        .bind(role.as_str())
        .bind(now.as_millis())
        .execute(conn)
        .await?;
    Ok(())
}

pub async fn update_display_name(
    conn: &mut SqliteConnection,
    id: UserId,
    display_name: &str,
    now: Timestamp,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE users SET display_name = ?2, updated_at = ?3 WHERE id = ?1")
        .bind(id.as_str())
        .bind(display_name)
        .bind(now.as_millis())
        .execute(conn)
        .await?;
    Ok(())
}

/// Claim the open row (`ADR-039`): the name and password the owner typed, and
/// the flag off, in one UPDATE.
///
/// One statement rather than three, because the intermediate states are all
/// wrong: a row with a password that is still open could sign in *and* be treated
/// as the open operator; a row that stopped being open before its verifier landed
/// would leave the shop with an account nobody knows the password of.
///
/// `WHERE provisional = 1` is the gate. A second claim — another window, or a
/// restore that raced the first — matches no row, and the caller reports that
/// rather than overwriting an account that is already somebody's. The lockout
/// counters are cleared in the same statement: attempts recorded against an open
/// row were attempts at a password nobody could know, and carrying them into the
/// claimed account would let a stranger's guesses lock the owner out on day one.
pub async fn claim_open(
    conn: &mut SqliteConnection,
    id: UserId,
    display_name: &str,
    verifier: &CredentialVerifier,
    now: Timestamp,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE users
            SET display_name = ?2, verifier = ?3, provisional = 0,
                failed_attempts = 0, locked_until = NULL, updated_at = ?4
          WHERE id = ?1 AND provisional = 1",
    )
    .bind(id.as_str())
    .bind(display_name)
    .bind(verifier.expose())
    .bind(now.as_millis())
    .execute(conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Disable or re-enable an account.
///
/// `disabled_at` is a timestamp rather than a boolean so that "since when" is
/// answerable later, which a flag could not be.
pub async fn set_disabled(
    conn: &mut SqliteConnection,
    id: UserId,
    disabled_at: Option<Timestamp>,
    disabled_by: Option<UserId>,
    now: Timestamp,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE users SET disabled_at = ?2, disabled_by = ?3, updated_at = ?4 WHERE id = ?1",
    )
    .bind(id.as_str())
    .bind(disabled_at.map(|t| t.as_millis()))
    .bind(disabled_by.map(|b| b.as_str()))
    .bind(now.as_millis())
    .execute(conn)
    .await?;
    Ok(())
}

/// Map a "row not found" outcome onto the domain error.
pub fn missing_user() -> DomainError {
    DomainError::UserNotFound
}

/// Whether a driver error is a UNIQUE constraint violation.
///
/// SQLite reports both a named and a generic form depending on which constraint
/// was hit, so both are matched. Used to translate a username clash into
/// `UsernameAlreadyExists` rather than surfacing a driver string.
pub fn is_unique_violation(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(inner) => {
            let message = inner.to_string();
            message.contains("UNIQUE constraint failed")
                || message.contains("constraint failed: UNIQUE")
        }
        _ => false,
    }
}