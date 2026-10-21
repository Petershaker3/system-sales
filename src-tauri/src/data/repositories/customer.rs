//! Customer file persistence.
//!
//! The only place SQL for customers may appear. Functions take
//! `&mut SqliteConnection` so the same code serves a pooled call and a call
//! inside a transaction, as in the catalogue repositories.
//!
//! There is deliberately no find-by-name: `spec:178` forbids merging similar
//! names, so name lookup must never become an implicit link.

use sqlx::{Row, SqliteConnection};

use crate::domain::customer::{Customer, CustomerLedgerEntry, CustomerWithBalance};
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

/// Live (unarchived) customers together with their current آجل balance (`ADR-020` §3).
pub async fn list_unarchived_with_balances(
    conn: &mut SqliteConnection,
) -> Result<Vec<CustomerWithBalance>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT c.id, c.name, c.contact, c.archived, c.created_by, c.created_at, c.updated_at,
                COALESCE((SELECT SUM(cl.amount_minor) FROM customer_ledger cl WHERE cl.customer_id = c.id), 0) AS balance_minor
         FROM customers c
         WHERE c.archived = 0
         ORDER BY c.name COLLATE NOCASE, c.id",
    )
    .fetch_all(&mut *conn)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let balance_minor: i64 = row.try_get("balance_minor")?;
        let customer = row_to_customer(row)?;
        out.push(CustomerWithBalance {
            customer,
            balance_minor,
        });
    }
    Ok(out)
}

/// Read the customer's current آجل balance in piastres (`ADR-020` §3).
pub async fn balance_minor(
    conn: &mut SqliteConnection,
    customer_id: &str,
) -> Result<i64, sqlx::Error> {
    let sum: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM customer_ledger WHERE customer_id = ?1",
    )
    .bind(customer_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(sum)
}

/// Append one entry to `customer_ledger` (`ADR-020` §3).
pub async fn insert_ledger_entry(
    conn: &mut SqliteConnection,
    entry: &CustomerLedgerEntry,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO customer_ledger
             (id, customer_id, kind, amount_minor, method, wallet_id, sale_id, note, actor_id,
              occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(&entry.id)
    .bind(&entry.customer_id)
    .bind(&entry.kind)
    .bind(entry.amount_minor)
    .bind(entry.method.as_deref())
    .bind(entry.wallet_id.as_deref())
    .bind(entry.sale_id.as_deref())
    .bind(entry.note.as_deref())
    .bind(entry.actor_id.as_str())
    .bind(entry.occurred_at.as_millis())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// List a customer's ledger entries, newest first (`ADR-020` §3).
pub async fn list_ledger_entries(
    conn: &mut SqliteConnection,
    customer_id: &str,
) -> Result<Vec<CustomerLedgerEntry>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, customer_id, kind, amount_minor, method, wallet_id, sale_id, note, actor_id,
                occurred_at
         FROM customer_ledger
         WHERE customer_id = ?1
         ORDER BY occurred_at DESC, id DESC",
    )
    .bind(customer_id)
    .fetch_all(&mut *conn)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let actor_raw: String = row.try_get("actor_id")?;
        let actor_id = actor_raw
            .parse()
            .map(UserId::from_uuid)
            .map_err(|_| sqlx::Error::Decode("customer_ledger.actor_id is not a UUID".into()))?;
        out.push(CustomerLedgerEntry {
            id: row.try_get("id")?,
            customer_id: row.try_get("customer_id")?,
            kind: row.try_get("kind")?,
            amount_minor: row.try_get("amount_minor")?,
            method: row.try_get("method")?,
            wallet_id: row.try_get("wallet_id")?,
            sale_id: row.try_get("sale_id")?,
            note: row.try_get("note")?,
            actor_id,
            occurred_at: Timestamp::from_millis(row.try_get("occurred_at")?),
        });
    }
    Ok(out)
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
