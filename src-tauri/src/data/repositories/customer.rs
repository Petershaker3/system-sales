//! Customer file persistence.
//!
//! The only place SQL for customers may appear. Functions take
//! `&mut SqliteConnection` so the same code serves a pooled call and a call
//! inside a transaction, as in the catalogue repositories.
//!
//! There is deliberately no find-by-name: `spec:178` forbids merging similar
//! names, so name lookup must never become an implicit link.

use sqlx::{Row, SqliteConnection};

use crate::domain::customer::Customer;
use crate::domain::identity::{Timestamp, UserId};

pub async fn insert(
    conn: &mut SqliteConnection,
    customer: &Customer,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO customers
         (id, name, contact, archived, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(customer.id.as_str())
    .bind(customer.name.as_str())
    .bind(customer.contact.as_deref())
    .bind(i64::from(customer.archived))
    .bind(customer.created_by.to_string())
    .bind(customer.created_at.as_millis())
    .bind(customer.updated_at.as_millis())
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn find_by_id(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<Customer>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, name, contact, archived, created_by, created_at, updated_at
         FROM customers WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(row) => row_to_customer(row).map(Some),
        None => Ok(None),
    }
}

/// Live (unarchived) customers, browsable by a manager. Ordered by name for
/// a stable listing; names are not unique, so callers must not treat
/// position as identity.
pub async fn list_unarchived(
    conn: &mut SqliteConnection,
) -> Result<Vec<Customer>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, name, contact, archived, created_by, created_at, updated_at
         FROM customers WHERE archived = 0 ORDER BY name COLLATE NOCASE, id",
    )
    .fetch_all(&mut *conn)
    .await?;

    rows.into_iter().map(row_to_customer).collect()
}

/// Archive a customer by id, stamping the change. Returns the rows changed
/// (0 when the id does not exist); the caller maps that to `NotFound`.
pub async fn set_archived(
    conn: &mut SqliteConnection,
    id: &str,
    at: Timestamp,
) -> Result<u64, sqlx::Error> {
    let done = sqlx::query(
        "UPDATE customers SET archived = 1, updated_at = ?1
         WHERE id = ?2 AND archived = 0",
    )
    .bind(at.as_millis())
    .bind(id)
    .execute(&mut *conn)
    .await?;
    Ok(done.rows_affected())
}

fn row_to_customer(    row: sqlx::sqlite::SqliteRow,
) -> Result<Customer, sqlx::Error> {
    let created_by_raw: String = row.try_get("created_by")?;
    let archived_raw: i64 = row.try_get("archived")?;
    Ok(Customer {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        contact: row.try_get("contact")?,
        archived: archived_raw != 0,
        created_by: created_by_raw
            .parse()
            .map(UserId::from_uuid)
            .map_err(|_| sqlx::Error::Decode(
                "customers.created_by is not a UUID".into(),
            ))?,
        created_at: Timestamp::from_millis(row.try_get("created_at")?),
        updated_at: Timestamp::from_millis(row.try_get("updated_at")?),
    })
}
