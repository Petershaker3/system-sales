//! Stock positions, and the FIFO layers a database written before plan item
//! 1.3 may still hold.
//!
//! # Reading is defensive, not repairing
//!
//! The convention of [`super::organisation::department`] applies unchanged: a
//! persisted row can be malformed, and this file reports that rather than
//! turning it into a plausible position. Specifically it never:
//!
//! - clamps a negative balance to zero — that would erase the evidence of the
//!   bug that produced it;
//! - invents a `total_cost_minor` for a position that has none.
//!
//! # Legacy layers: read and delete, never written
//!
//! Every quantity product is costed by moving average (`ADR-016` #7). Nothing
//! writes `fifo_layers` any more; the costing service reads a product's legacy
//! layers once, folds their cost into the moving-average total, and deletes
//! them in the same transaction.

use sqlx::{Row, SqliteConnection};

use crate::domain::costing::fifo::FifoLayer;
use crate::domain::identity::UserId;

/// The persisted stock position for one product.
///
/// `total_cost_minor: Option<i64>` because `NULL` is load-bearing: a position
/// with a `NULL` total was written by the retired FIFO method, and it is never
/// read as zero. A zero would be read as free stock, which is a different and
/// wrong claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StockPosition {
    pub product_id: String,
    pub quantity: i64,
    pub total_cost_minor: Option<i64>,
}

/// Read the position for a product, or `None` if the product has never been
/// stocked. A missing row is not an error: an unstocked product has a balance of
/// zero and no cost authority yet.
pub async fn find_position(
    conn: &mut SqliteConnection,
    product_id: &str,
) -> Result<Option<StockPosition>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT product_id, quantity, total_cost_minor
         FROM stock_levels
         WHERE product_id = ?1",
    )
    .bind(product_id)
    .fetch_optional(&mut *conn)
    .await?;

    Ok(row.map(|row| StockPosition {
        product_id: row.get("product_id"),
        quantity: row.get("quantity"),
        total_cost_minor: row.get("total_cost_minor"),
    }))
}

/// Create or replace the position for a product.
///
/// A single `INSERT ... ON CONFLICT DO UPDATE` rather than a read-then-write
/// pair: the service already holds the position it intends to store, and two
/// statements would leave a window where another writer could interleave.
pub async fn upsert_position(
    conn: &mut SqliteConnection,
    position: &StockPosition,
    updated_by: &UserId,
    updated_at: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO stock_levels
         (product_id, quantity, total_cost_minor, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (product_id) DO UPDATE SET
             quantity = excluded.quantity,
             total_cost_minor = excluded.total_cost_minor,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at",
    )
    .bind(&position.product_id)
    .bind(position.quantity)
    .bind(position.total_cost_minor)
    .bind(updated_by.as_str())
    .bind(updated_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Read a product's legacy layers, oldest first.
///
/// The order is kept stable (`received_at, id`) so a collapse and its audit
/// detail are reproducible, although summing them does not depend on it.
pub async fn list_layers(
    conn: &mut SqliteConnection,
    product_id: &str,
) -> Result<Vec<FifoLayer>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT quantity, unit_cost_minor
         FROM fifo_layers
         WHERE product_id = ?1
         ORDER BY received_at, id",
    )
    .bind(product_id)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| FifoLayer {
            quantity: row.get("quantity"),
            unit_cost_minor: row.get("unit_cost_minor"),
        })
        .collect())
}

/// Delete every layer of a product.
///
/// Used when a legacy FIFO position is collapsed into the moving average, in
/// the same transaction that writes the collapsed total.
pub async fn delete_layers(
    conn: &mut SqliteConnection,
    product_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM fifo_layers WHERE product_id = ?1")
        .bind(product_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// How many legacy layers a product holds. Zero for everything written since
/// plan item 1.3.
pub async fn count_layers(
    conn: &mut SqliteConnection,
    product_id: &str,
) -> Result<i64, sqlx::Error> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fifo_layers WHERE product_id = ?1")
        .bind(product_id)
        .fetch_one(&mut *conn)
        .await?;
    Ok(count)
}