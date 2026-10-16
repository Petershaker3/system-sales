//! Login-identifier and forced-password-change persistence.
//!
//! Separate from `user.rs` because these columns live in `user_credentials`,
//! which exists to carry a `NOT NULL UNIQUE` constraint that SQLite cannot add to
//! an existing table. See migration `0003` for the full reasoning.

use sqlx::{Row, SqliteConnection};

use crate::domain::identity::{UserId, Username};

/// The credential-side facts about one account.
pub struct Credentials {
    pub user_id: UserId,
    pub username: Username,
    pub must_change_password: bool,
}

fn row_to_credentials(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<Credentials, sqlx::Error> {
    let raw_id: String = row.get("user_id");
    let raw_username: String = row.get("username");
    let must_change: i64 = row.get("must_change_password");

    let username = Username::parse(&raw_username).ok_or_else(|| {
        sqlx::Error::Protocol(format!("invalid username in user_credentials: {raw_username}"))
    })?;

    Ok(Credentials {
        user_id: UserId::from_uuid(
            raw_id
                .parse()
                .map_err(|_| sqlx::Error::Protocol("malformed user_id".into()))?,
        ),
        username,
        // The CHECK constraint restricts this to 0 or 1, so any non-zero value
        // means "must change" rather than being silently treated as false.
        must_change_password: must_change != 0,
    })
}

pub async fn insert(
    conn: &mut SqliteConnection,
    user_id: UserId,
    username: &Username,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO user_credentials (user_id, username, must_change_password)
         VALUES (?1, ?2, 0)",
    )
    .bind(user_id.as_str())
    .bind(username.as_str())
    .execute(conn)
    .await?;
    Ok(())
}

/// Look up an account's credentials.
///
/// `Ok(None)` means the row is absent. Migration `0003` guarantees one per account,
/// so callers must treat that as [`crate::domain::identity::DomainError::AccountDataIntegrityError`] rather
/// than inventing a username or defaulting the forced-change flag.
pub async fn find_by_user(
    conn: &mut SqliteConnection,
    user_id: UserId,
) -> Result<Option<Credentials>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT user_id, username, must_change_password FROM user_credentials WHERE user_id = ?1",
    )
    .bind(user_id.as_str())
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(row) => Ok(Some(row_to_credentials(&row)?)),
        None => Ok(None),
    }
}

pub async fn find_by_username(
    conn: &mut SqliteConnection,
    username: &Username,
) -> Result<Option<Credentials>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT user_id, username, must_change_password FROM user_credentials WHERE username = ?1",
    )
    .bind(username.as_str())
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(row) => Ok(Some(row_to_credentials(&row)?)),
        None => Ok(None),
    }
}

/// Whether an account must change its password before doing anything else.
///
/// Returns `None` when the account has **no** credentials row.
///
/// That `None` is not to be read as "no change needed". Migration `0003` gives
/// every account a credentials row, so a missing one means the invariant has been
/// broken — by a manual edit, a partial restore, or corruption. Treating it as
/// `false` would hand out a session that bypasses the forced-change gate, which is
/// exactly the protection that stops a manager-reset account from reaching the
/// shop. Callers must map `None` onto
/// [`crate::domain::identity::DomainError::AccountDataIntegrityError`] rather than defaulting.
pub async fn must_change_password(
    conn: &mut SqliteConnection,
    user_id: UserId,
) -> Result<Option<bool>, sqlx::Error> {
    let value: Option<i64> =
        sqlx::query_scalar("SELECT must_change_password FROM user_credentials WHERE user_id = ?1")
            .bind(user_id.as_str())
            .fetch_optional(&mut *conn)
            .await?;
    // `Some(_)` only. A missing row stays `None` rather than becoming `false`.
    Ok(value.map(|v| v != 0))
}

pub async fn set_must_change_password(
    conn: &mut SqliteConnection,
    user_id: UserId,
    must_change: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE user_credentials SET must_change_password = ?2 WHERE user_id = ?1",
    )
    .bind(user_id.as_str())
    .bind(if must_change { 1i64 } else { 0i64 })
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn update_username(
    conn: &mut SqliteConnection,
    user_id: UserId,
    username: &Username,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE user_credentials SET username = ?2 WHERE user_id = ?1")
        .bind(user_id.as_str())
        .bind(username.as_str())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Count accounts, used by tests to prove a refusal wrote nothing.
pub async fn count_all(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_credentials")
        .fetch_one(&mut *conn)
        .await?;
    Ok(count)
}