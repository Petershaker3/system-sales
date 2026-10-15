//! Sales persistence: sale documents, their lines, the movement ledger and the
//! reversal links.
//!
//! The only layer permitted to contain SQL for these tables. Functions take
//! `&mut SqliteConnection` so the same code serves a pooled call and a call
//! inside a transaction, matching the identity and catalogue repositories.
//!
//! Nothing here recomputes a snapshot. A sale line's name, price and cost are
//! written once and read back unchanged; the repository has no update or delete
//! for `sale_lines` at all, because a sale is a document and not a mutable row.

use sqlx::{Row, SqliteConnection};

use crate::domain::identity::UserId;

/// One sale-shaped document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleRecord {
    pub id: String,
    pub reference: String,
    pub occurred_at: i64,
    pub sold_by: String,
    /// `"sale"` or `"reversal"`.
    pub kind: String,
    pub reverses_sale_id: Option<String>,
    pub total_minor: i64,
    pub cost_total_minor: i64,
}

/// One immutable line of a sale.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleLineRecord {
    pub id: String,
    pub sale_id: String,
    pub line_no: i64,
    pub product_id: String,
    pub product_name: String,
    pub disposition: String,
    pub quantity: i64,
    pub unit_selling_price_minor: i64,
    pub line_total_minor: i64,
    /// `None` for a FIFO line spanning layers of different unit cost; the exact
    /// `line_cost_minor` is the profit authority either way.
    pub unit_cost_minor: Option<i64>,
    pub line_cost_minor: i64,
    pub department_id: Option<String>,
    pub cost_method: String,
}

/// One row of the append-only movement ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovementRecord {
    pub id: String,
    pub product_id: String,
    /// `"receipt"`, `"adjustment"`, `"sale"` or `"sale_reversal"`.
    pub kind: String,
    pub quantity_delta: i64,
    pub unit_cost_minor: i64,
    pub cost_delta_minor: i64,
    pub occurred_at: i64,
    pub actor_id: String,
    pub sale_id: Option<String>,
    pub sale_line_id: Option<String>,
    pub fifo_layer_id: Option<String>,
    pub fifo_received_at: Option<i64>,
    pub reverses_movement_id: Option<String>,
}

pub async fn insert_sale(conn: &mut SqliteConnection, sale: &SaleRecord) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sales
             (id, reference, occurred_at, sold_by, kind, reverses_sale_id,
              total_minor, cost_total_minor)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&sale.id)
    .bind(&sale.reference)
    .bind(sale.occurred_at)
    .bind(&sale.sold_by)
    .bind(&sale.kind)
    .bind(sale.reverses_sale_id.as_deref())
    .bind(sale.total_minor)
    .bind(sale.cost_total_minor)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn insert_sale_line(
    conn: &mut SqliteConnection,
    line: &SaleLineRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sale_lines
             (id, sale_id, line_no, product_id, product_name, disposition,
              quantity, unit_selling_price_minor, line_total_minor,
              unit_cost_minor, line_cost_minor, department_id, cost_method)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    )
    .bind(&line.id)
    .bind(&line.sale_id)
    .bind(line.line_no)
    .bind(&line.product_id)
    .bind(&line.product_name)
    .bind(&line.disposition)
    .bind(line.quantity)
    .bind(line.unit_selling_price_minor)
    .bind(line.line_total_minor)
    .bind(line.unit_cost_minor)
    .bind(line.line_cost_minor)
    .bind(line.department_id.as_deref())
    .bind(&line.cost_method)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn insert_movement(
    conn: &mut SqliteConnection,
    movement: &MovementRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO stock_movements
             (id, product_id, kind, quantity_delta, unit_cost_minor, cost_delta_minor,
              occurred_at, actor_id, sale_id, sale_line_id,
              fifo_layer_id, fifo_received_at, reverses_movement_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    )
    .bind(&movement.id)
    .bind(&movement.product_id)
    .bind(&movement.kind)
    .bind(movement.quantity_delta)
    .bind(movement.unit_cost_minor)
    .bind(movement.cost_delta_minor)
    .bind(movement.occurred_at)
    .bind(&movement.actor_id)
    .bind(movement.sale_id.as_deref())
    .bind(movement.sale_line_id.as_deref())
    .bind(movement.fifo_layer_id.as_deref())
    .bind(movement.fifo_received_at)
    .bind(movement.reverses_movement_id.as_deref())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn find_sale(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<SaleRecord>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, reference, occurred_at, sold_by, kind, reverses_sale_id,
                total_minor, cost_total_minor
         FROM sales WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;

    Ok(row.map(|row| SaleRecord {
        id: row.get("id"),
        reference: row.get("reference"),
        occurred_at: row.get("occurred_at"),
        sold_by: row.get("sold_by"),
        kind: row.get("kind"),
        reverses_sale_id: row.get("reverses_sale_id"),
        total_minor: row.get("total_minor"),
        cost_total_minor: row.get("cost_total_minor"),
    }))
}

/// A sale's link state: its document kind plus the linked customer, if any.
///
/// Read-only coupling to the customer slice (P4): the sales layer names a
/// customer row but owns none of its rules.
pub async fn link_state(
    conn: &mut SqliteConnection,
    sale_id: &str,
) -> Result<Option<(String, Option<String>)>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT kind, customer_id FROM sales WHERE id = ?1",
    )
    .bind(sale_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|row| {
        let kind: String = row.get("kind");
        let customer_id: Option<String> = row.get("customer_id");
        (kind, customer_id)
    }))
}

/// Attach an explicit customer link. The text snapshot, if one was typed, is
/// left untouched: it records what the operator saw, the link records whom
/// the document belongs to.
pub async fn set_sale_customer(
    conn: &mut SqliteConnection,
    sale_id: &str,
    customer_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE sales SET customer_id = ?1 WHERE id = ?2")
        .bind(customer_id)
        .bind(sale_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Keep a free-text customer name on an unlinked sale (`spec:178`).
pub async fn set_sale_customer_snapshot(
    conn: &mut SqliteConnection,
    sale_id: &str,
    name: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE sales SET customer_name_snapshot = ?1 WHERE id = ?2")
        .bind(name)
        .bind(sale_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

pub async fn list_lines(
    conn: &mut SqliteConnection,
    sale_id: &str,
) -> Result<Vec<SaleLineRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, sale_id, line_no, product_id, product_name, disposition,
                quantity, unit_selling_price_minor, line_total_minor,
                unit_cost_minor, line_cost_minor, department_id, cost_method
         FROM sale_lines
         WHERE sale_id = ?1
         ORDER BY line_no",
    )
    .bind(sale_id)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| SaleLineRecord {
            id: row.get("id"),
            sale_id: row.get("sale_id"),
            line_no: row.get("line_no"),
            product_id: row.get("product_id"),
            product_name: row.get("product_name"),
            disposition: row.get("disposition"),
            quantity: row.get("quantity"),
            unit_selling_price_minor: row.get("unit_selling_price_minor"),
            line_total_minor: row.get("line_total_minor"),
            unit_cost_minor: row.get("unit_cost_minor"),
            line_cost_minor: row.get("line_cost_minor"),
            department_id: row.get("department_id"),
            cost_method: row.get("cost_method"),
        })
        .collect())
}

/// The movements a sale wrote, oldest first.
pub async fn list_movements_for_sale(
    conn: &mut SqliteConnection,
    sale_id: &str,
) -> Result<Vec<MovementRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, product_id, kind, quantity_delta, unit_cost_minor, cost_delta_minor,
                occurred_at, actor_id, sale_id, sale_line_id,
                fifo_layer_id, fifo_received_at, reverses_movement_id
         FROM stock_movements
         WHERE sale_id = ?1
         ORDER BY occurred_at, id",
    )
    .bind(sale_id)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows.into_iter().map(row_to_movement).collect())
}

/// The movements a sale line wrote, oldest first.
pub async fn list_movements_for_line(
    conn: &mut SqliteConnection,
    sale_line_id: &str,
) -> Result<Vec<MovementRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, product_id, kind, quantity_delta, unit_cost_minor, cost_delta_minor,
                occurred_at, actor_id, sale_id, sale_line_id,
                fifo_layer_id, fifo_received_at, reverses_movement_id
         FROM stock_movements
         WHERE sale_line_id = ?1
         ORDER BY occurred_at, id",
    )
    .bind(sale_line_id)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows.into_iter().map(row_to_movement).collect())
}

/// The reversal sale that cancelled `original_sale_id`, if any.
pub async fn find_reversal_sale_id(
    conn: &mut SqliteConnection,
    original_sale_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query("SELECT reversal_sale_id FROM sale_reversals WHERE original_sale_id = ?1")
        .bind(original_sale_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.map(|row| row.get("reversal_sale_id")))
}

pub async fn insert_reversal(
    conn: &mut SqliteConnection,
    id: &str,
    original_sale_id: &str,
    reversal_sale_id: &str,
    occurred_at: i64,
    actor_id: &UserId,
    reason: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sale_reversals
             (id, original_sale_id, reversal_sale_id, occurred_at, actor_id, reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(id)
    .bind(original_sale_id)
    .bind(reversal_sale_id)
    .bind(occurred_at)
    .bind(actor_id.as_str())
    .bind(reason)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The next sequence number for a daily invoice run.
///
/// Scoped by a literal prefix match rather than `LIKE`, so a prefix that happens
/// to contain a `%` or `_` cannot widen the day. `substr(reference, -4)` reads
/// the four-digit counter the format guarantees.
pub async fn next_sequence(
    conn: &mut SqliteConnection,
    prefix_and_date: &str,
) -> Result<u32, sqlx::Error> {
    let row = sqlx::query(
        "SELECT COALESCE(MAX(CAST(substr(reference, -4) AS INTEGER)), 0) AS max_seq
         FROM sales
         WHERE substr(reference, 1, length(?1)) = ?1",
    )
    .bind(prefix_and_date)
    .fetch_one(&mut *conn)
    .await?;
    let max_seq: i64 = row.get("max_seq");
    Ok(max_seq.max(0) as u32)
}

/// The sum of every signed quantity delta for a product.
///
/// A test and audit aid: within one costing epoch it must equal the position's
/// quantity, and stating that as a query keeps the invariant checkable from
/// outside the service that maintains it.
pub async fn sum_quantity_delta(
    conn: &mut SqliteConnection,
    product_id: &str,
) -> Result<i64, sqlx::Error> {
    let total: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(quantity_delta), 0) FROM stock_movements WHERE product_id = ?1",
    )
    .bind(product_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(total)
}

fn row_to_movement(row: sqlx::sqlite::SqliteRow) -> MovementRecord {
    MovementRecord {
        id: row.get("id"),
        product_id: row.get("product_id"),
        kind: row.get("kind"),
        quantity_delta: row.get("quantity_delta"),
        unit_cost_minor: row.get("unit_cost_minor"),
        cost_delta_minor: row.get("cost_delta_minor"),
        occurred_at: row.get("occurred_at"),
        actor_id: row.get("actor_id"),
        sale_id: row.get("sale_id"),
        sale_line_id: row.get("sale_line_id"),
        fifo_layer_id: row.get("fifo_layer_id"),
        fifo_received_at: row.get("fifo_received_at"),
        reverses_movement_id: row.get("reverses_movement_id"),
    }
}
