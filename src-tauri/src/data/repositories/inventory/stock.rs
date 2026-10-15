//! Stock positions and FIFO cost layers.
//!
//! # Reading is defensive, not repairing
//!
//! The convention of [`super::organisation::department`] applies unchanged: a
//! persisted row can be malformed, and this file reports that rather than
//! turning it into a plausible position. Specifically it never:
//!
//! - clamps a negative balance to zero — that would erase the evidence of the
//!   bug that produced it;
//! - invents a `total_cost_minor` for a position that has none;
//! - reorders layers silently — the consumption order is `(received_at, id)` and
//!   the query states it, so a row read out of order is a query bug to fix here
//!   rather than a value to fix in Rust.
//!
//! # One statement per shape
//!
//! A removal rewrites both the position and its layers, and a switch rewrites the
//! layers of every product in a department. Those are multi-row changes, so they
//! are expressed as explicit statements here and wrapped in a single transaction
//! by the service — never as a loop of callers' transactions.

use sqlx::{Row, SqliteConnection};

use crate::domain::costing::fifo::FifoLayer;
use crate::domain::identity::UserId;

/// The persisted stock position for one product.
///
/// `total_cost_minor: Option<i64>` because `NULL` is load-bearing: it means
/// "FIFO holds the cost", never "the cost is zero". A zero would be read as free
/// stock, which is a different and wrong claim.
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

/// Every product that currently holds stock in a department.
///
/// The switch operation needs the whole affected set, and reading it as one
/// query is what keeps the switch atomic: a per-product loop would leave the
/// department half-converted if any iteration failed.
pub async fn list_positions_in_department(
    conn: &mut SqliteConnection,
    department_id: &str,
) -> Result<Vec<StockPosition>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT s.product_id, s.quantity, s.total_cost_minor
         FROM stock_levels s
         JOIN products p ON p.id = s.product_id
         WHERE p.department_id = ?1",
    )
    .bind(department_id)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| StockPosition {
            product_id: row.get("product_id"),
            quantity: row.get("quantity"),
            total_cost_minor: row.get("total_cost_minor"),
        })
        .collect())
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

/// Insert one FIFO layer.
pub async fn insert_layer(
    conn: &mut SqliteConnection,
    id: &str,
    product_id: &str,
    layer: &FifoLayer,
    received_at: i64,
    updated_by: &UserId,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO fifo_layers
         (id, product_id, quantity, unit_cost_minor, received_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(id)
    .bind(product_id)
    .bind(layer.quantity)
    .bind(layer.unit_cost_minor)
    .bind(received_at)
    .bind(updated_by.as_str())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Read a product's layers in consumption order: oldest first.
///
/// The `ORDER BY` is not decoration. `ADR-013` defines FIFO consumption as
/// `ORDER BY created_at, id`, and the id tiebreak is what makes that order total
/// when two receipts share a millisecond.
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

/// A persisted FIFO layer with its identity, in consumption order.
///
/// The plain [`FifoLayer`] carries no `id` or `received_at` because the domain
/// arithmetic does not need them. A removal does: it must update the exact rows
/// it consumed rather than delete and re-insert the survivors, which would mint
/// new ids and reset arrival times and so destroy the very identity a reversal
/// relies on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayerRow {
    pub id: String,
    pub quantity: i64,
    pub unit_cost_minor: i64,
    pub received_at: i64,
}

/// Read a product's layers with their identity, oldest first.
pub async fn list_layer_rows(
    conn: &mut SqliteConnection,
    product_id: &str,
) -> Result<Vec<LayerRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, quantity, unit_cost_minor, received_at
         FROM fifo_layers
         WHERE product_id = ?1
         ORDER BY received_at, id",
    )
    .bind(product_id)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| LayerRow {
            id: row.get("id"),
            quantity: row.get("quantity"),
            unit_cost_minor: row.get("unit_cost_minor"),
            received_at: row.get("received_at"),
        })
        .collect())
}

/// Read one layer by its identity, if it still exists.
///
/// A reversal needs this: restocking a consumed layer either adds its quantity
/// back to the row that survived (an UPDATE) or, when the row was exhausted and
/// deleted at sale time, re-creates it at its original id and arrival time. That
/// is why the id is preserved rather than regenerated.
pub async fn find_layer_row(
    conn: &mut SqliteConnection,
    layer_id: &str,
) -> Result<Option<LayerRow>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, quantity, unit_cost_minor, received_at
         FROM fifo_layers
         WHERE id = ?1",
    )
    .bind(layer_id)
    .fetch_optional(&mut *conn)
    .await?;

    Ok(row.map(|row| LayerRow {
        id: row.get("id"),
        quantity: row.get("quantity"),
        unit_cost_minor: row.get("unit_cost_minor"),
        received_at: row.get("received_at"),
    }))
}

/// Reduce a layer to its remaining quantity, keeping its id, unit cost and
/// arrival time untouched.
pub async fn update_layer_quantity(
    conn: &mut SqliteConnection,
    layer_id: &str,
    quantity: i64,
    updated_by: &UserId,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE fifo_layers
         SET quantity = ?2, updated_by = ?3
         WHERE id = ?1",
    )
    .bind(layer_id)
    .bind(quantity)
    .bind(updated_by.as_str())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Delete one exhausted layer by id.
///
/// A layer is deleted only when its quantity reaches zero, which the schema
/// forbids storing (`quantity > 0`). Removing the exact row — never a
/// delete-everything-and-re-insert — is what preserves the ids of the layers
/// that survived.
pub async fn delete_layer(
    conn: &mut SqliteConnection,
    layer_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM fifo_layers WHERE id = ?1")
        .bind(layer_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Delete every layer of a product.
///
/// Used when FIFO is collapsed into a Moving Average total, and when a position
/// is emptied. Rows are removed rather than zeroed because the schema forbids a
/// zero-quantity layer: a spent layer carries no cost fact, and keeping it would
/// only make a replay longer.
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

/// How many layers a product holds.
///
/// Read by the costing service to state the authority invariant out loud in one
/// place: Moving Average requires zero layers, FIFO requires at least one layer
/// for every unit on hand.
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