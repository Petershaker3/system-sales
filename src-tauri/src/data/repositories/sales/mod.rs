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
    /// Total discount on this sale in piastres (`ADR-021`).
    pub discount_minor: i64,
    /// Manager who approved an above-limit discount (`ADR-021`), if any.
    pub approved_by: Option<String>,
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
    /// Line-level discount in piastres (`ADR-021`).
    pub discount_minor: i64,
    pub line_total_minor: i64,
    /// `None` for a FIFO line spanning layers of different unit cost; the exact
    /// `line_cost_minor` is the profit authority either way.
    pub unit_cost_minor: Option<i64>,
    pub line_cost_minor: i64,
    pub department_id: Option<String>,
    pub cost_method: String,
    /// The warranty the operator typed at sale time (D4/D8/D9): ISO calendar
    /// days, never recomputed and never inferred from a period.
    pub warranty_start: Option<String>,
    pub warranty_end: Option<String>,
    /// The serialized unit (`units.id`) sold on this line (`ADR-019`), if any.
    pub unit_id: Option<String>,
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
    /// The supplier label on a receipt (P4b, decision D1). NULL for everything
    /// that is not a purchase — a sale, a reversal, a removal, an adjustment.
    pub supplier_name: Option<String>,
    /// `"supplier"` or `"opening"` on a receipt (`ADR-019`); NULL otherwise.
    pub receipt_kind: Option<String>,
}

/// One payment row on a sale document (`ADR-020` §2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SalePaymentRecord {
    pub id: String,
    pub sale_id: String,
    pub payment_no: i64,
    pub method: String,
    pub amount_minor: i64,
    pub reference: Option<String>,
    pub occurred_at: i64,
}

pub async fn insert_sale(conn: &mut SqliteConnection, sale: &SaleRecord) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sales
             (id, reference, occurred_at, sold_by, kind, reverses_sale_id,
              total_minor, cost_total_minor, discount_minor, approved_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(&sale.id)
    .bind(&sale.reference)
    .bind(sale.occurred_at)
    .bind(&sale.sold_by)
    .bind(&sale.kind)
    .bind(sale.reverses_sale_id.as_deref())
    .bind(sale.total_minor)
    .bind(sale.cost_total_minor)
    .bind(sale.discount_minor)
    .bind(sale.approved_by.as_deref())
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
              quantity, unit_selling_price_minor, discount_minor, line_total_minor,
              unit_cost_minor, line_cost_minor, department_id, cost_method,
              warranty_start, warranty_end, unit_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
    )
    .bind(&line.id)
    .bind(&line.sale_id)
    .bind(line.line_no)
    .bind(&line.product_id)
    .bind(&line.product_name)
    .bind(&line.disposition)
    .bind(line.quantity)
    .bind(line.unit_selling_price_minor)
    .bind(line.discount_minor)
    .bind(line.line_total_minor)
    .bind(line.unit_cost_minor)
    .bind(line.line_cost_minor)
    .bind(line.department_id.as_deref())
    .bind(&line.cost_method)
    .bind(line.warranty_start.as_deref())
    .bind(line.warranty_end.as_deref())
    .bind(line.unit_id.as_deref())
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
              fifo_layer_id, fifo_received_at, reverses_movement_id, supplier_name, receipt_kind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
    .bind(movement.supplier_name.as_deref())
    .bind(movement.receipt_kind.as_deref())
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
                total_minor, cost_total_minor, discount_minor, approved_by
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
        discount_minor: row.get("discount_minor"),
        approved_by: row.get("approved_by"),
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
                quantity, unit_selling_price_minor, discount_minor, line_total_minor,
                unit_cost_minor, line_cost_minor, department_id, cost_method,
                warranty_start, warranty_end, unit_id
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
            discount_minor: row.get("discount_minor"),
            line_total_minor: row.get("line_total_minor"),
            unit_cost_minor: row.get("unit_cost_minor"),
            line_cost_minor: row.get("line_cost_minor"),
            department_id: row.get("department_id"),
            cost_method: row.get("cost_method"),
            warranty_start: row.get("warranty_start"),
            warranty_end: row.get("warranty_end"),
            unit_id: row.get("unit_id"),
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
                fifo_layer_id, fifo_received_at, reverses_movement_id, supplier_name, receipt_kind
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
                fifo_layer_id, fifo_received_at, reverses_movement_id, supplier_name, receipt_kind
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
        supplier_name: row.get("supplier_name"),
        receipt_kind: row.get("receipt_kind"),
    }
}

pub async fn insert_sale_payment(
    conn: &mut SqliteConnection,
    payment: &SalePaymentRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sale_payments
             (id, sale_id, payment_no, method, amount_minor, reference, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&payment.id)
    .bind(&payment.sale_id)
    .bind(payment.payment_no)
    .bind(&payment.method)
    .bind(payment.amount_minor)
    .bind(payment.reference.as_deref())
    .bind(payment.occurred_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn list_sale_payments(
    conn: &mut SqliteConnection,
    sale_id: &str,
) -> Result<Vec<SalePaymentRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, sale_id, payment_no, method, amount_minor, reference, occurred_at
         FROM sale_payments
         WHERE sale_id = ?1
         ORDER BY payment_no",
    )
    .bind(sale_id)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| SalePaymentRecord {
            id: row.get("id"),
            sale_id: row.get("sale_id"),
            payment_no: row.get("payment_no"),
            method: row.get("method"),
            amount_minor: row.get("amount_minor"),
            reference: row.get("reference"),
            occurred_at: row.get("occurred_at"),
        })
        .collect())
}

/// Net amount collected per payment method across all sales (`sale` minus `reversal`).
pub async fn net_paid_by_method(
    conn: &mut SqliteConnection,
) -> Result<Vec<(String, i64)>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT sp.method AS method,
                COALESCE(SUM(CASE WHEN s.kind = 'sale' THEN sp.amount_minor ELSE -sp.amount_minor END), 0) AS net_minor
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
         GROUP BY sp.method
         ORDER BY sp.method",
    )
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| (row.get("method"), row.get("net_minor")))
        .collect())
}

// ---------------------------------------------------------------------------
// Partial returns, exchanges, and damaged stock (`0025`, Plan item 1.11, ADR-026)
// ---------------------------------------------------------------------------

/// Cumulative return progress for one original `sale_line`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LineReturnProgress {
    pub returned_qty: i64,
    pub returned_discount_minor: i64,
    pub returned_total_minor: i64,
    pub returned_cost_minor: i64,
}

/// One row of `sale_returns` (`0025_partial_returns_and_damaged_stock.sql`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleReturnRecord {
    pub id: String,
    pub original_sale_id: String,
    pub return_sale_id: String,
    pub exchange_sale_id: Option<String>,
    pub refund_minor: i64,
    pub cost_returned_minor: i64,
    pub damaged_cost_minor: i64,
    pub reason: String,
    pub actor_id: String,
    pub approved_by: String,
    pub occurred_at: i64,
}

/// Enriched `sale_returns` row with human-facing invoice references.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleReturnSummaryRow {
    pub id: String,
    pub original_sale_id: String,
    pub return_sale_id: String,
    pub return_reference: String,
    pub exchange_sale_id: Option<String>,
    pub exchange_reference: Option<String>,
    pub refund_minor: i64,
    pub cost_returned_minor: i64,
    pub damaged_cost_minor: i64,
    pub reason: String,
    pub occurred_at: i64,
}

/// One row of `damaged_stock` (`0025_partial_returns_and_damaged_stock.sql`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DamagedStockRecord {
    pub id: String,
    pub product_id: String,
    pub sale_id: String,
    pub return_sale_id: String,
    pub sale_line_id: String,
    pub return_line_id: String,
    pub unit_id: Option<String>,
    pub quantity: i64,
    pub unit_cost_minor: i64,
    pub total_cost_minor: i64,
    pub reason: String,
    pub actor_id: String,
    pub approved_by: String,
    pub occurred_at: i64,
}

/// Enriched `damaged_stock` row for display in Store (`المخزن ← مخزون تالف`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DamagedStockViewRow {
    pub id: String,
    pub product_id: String,
    pub product_name: String,
    pub sale_id: String,
    pub sale_reference: String,
    pub return_sale_id: String,
    pub return_reference: String,
    pub sale_line_id: String,
    pub return_line_id: String,
    pub unit_id: Option<String>,
    pub imei: Option<String>,
    pub quantity: i64,
    pub unit_cost_minor: i64,
    pub total_cost_minor: i64,
    pub reason: String,
    pub occurred_at: i64,
}

/// Summary row for picking an invoice to return/exchange in POS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReturnableSaleSummaryRow {
    pub sale_id: String,
    pub reference: String,
    pub occurred_at: i64,
    pub customer_id: Option<String>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub first_product_name: String,
    pub line_count: i64,
    pub total_minor: i64,
    pub already_refunded_minor: i64,
    pub is_cancelled: bool,
}

/// One sale line with category and IMEI metadata for the Sales history screen (`ADR-029`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleHistoryLineRow {
    pub line_id: String,
    pub line_no: i64,
    pub product_id: String,
    pub product_name: String,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub parent_category_id: Option<String>,
    pub quantity: i64,
    pub unit_selling_price_minor: i64,
    pub discount_minor: i64,
    pub line_total_minor: i64,
    pub unit_cost_minor: Option<i64>,
    pub line_cost_minor: Option<i64>,
    pub line_profit_minor: Option<i64>,
    pub warranty_start: Option<String>,
    pub warranty_end: Option<String>,
    pub unit_id: Option<String>,
    pub imei: Option<String>,
}

/// One payment row on a sale history entry (`ADR-029`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleHistoryPaymentRow {
    pub method: String,
    pub amount_minor: i64,
    pub reference: Option<String>,
}

/// One full sale entry for the Sales history & analytics screen (`ADR-029`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleHistoryRow {
    pub sale_id: String,
    pub reference: String,
    pub occurred_at: i64,
    pub sold_by: String,
    pub seller_name: String,
    pub customer_id: Option<String>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub lines_subtotal_minor: i64,
    pub discount_minor: i64,
    pub total_minor: i64,
    pub cost_total_minor: Option<i64>,
    pub profit_minor: Option<i64>,
    pub already_refunded_minor: i64,
    pub is_cancelled: bool,
    pub lines: Vec<SaleHistoryLineRow>,
    pub payments: Vec<SaleHistoryPaymentRow>,
}

/// Insert a `sale_lines` row on a reversal/return sale with `reverses_line_id` and `return_condition`.
pub async fn insert_return_sale_line(
    conn: &mut SqliteConnection,
    line: &SaleLineRecord,
    reverses_line_id: &str,
    return_condition: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sale_lines
             (id, sale_id, line_no, product_id, product_name, disposition,
              quantity, unit_selling_price_minor, discount_minor, line_total_minor,
              unit_cost_minor, line_cost_minor, department_id, cost_method,
              warranty_start, warranty_end, unit_id, reverses_line_id, return_condition)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
    )
    .bind(&line.id)
    .bind(&line.sale_id)
    .bind(line.line_no)
    .bind(&line.product_id)
    .bind(&line.product_name)
    .bind(&line.disposition)
    .bind(line.quantity)
    .bind(line.unit_selling_price_minor)
    .bind(line.discount_minor)
    .bind(line.line_total_minor)
    .bind(line.unit_cost_minor)
    .bind(line.line_cost_minor)
    .bind(line.department_id.as_deref())
    .bind(&line.cost_method)
    .bind(line.warranty_start.as_deref())
    .bind(line.warranty_end.as_deref())
    .bind(line.unit_id.as_deref())
    .bind(reverses_line_id)
    .bind(return_condition)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Cumulative returned quantities and amounts for one original `sale_line`.
pub async fn line_return_progress(
    conn: &mut SqliteConnection,
    original_line_id: &str,
) -> Result<LineReturnProgress, sqlx::Error> {
    let row = sqlx::query(
        "SELECT COALESCE(SUM(quantity), 0) AS returned_qty,
                COALESCE(SUM(discount_minor), 0) AS returned_discount_minor,
                COALESCE(SUM(line_total_minor), 0) AS returned_total_minor,
                COALESCE(SUM(line_cost_minor), 0) AS returned_cost_minor
         FROM sale_lines
         WHERE reverses_line_id = ?1",
    )
    .bind(original_line_id)
    .fetch_one(&mut *conn)
    .await?;

    Ok(LineReturnProgress {
        returned_qty: row.get("returned_qty"),
        returned_discount_minor: row.get("returned_discount_minor"),
        returned_total_minor: row.get("returned_total_minor"),
        returned_cost_minor: row.get("returned_cost_minor"),
    })
}

/// Whether `original_sale_id` has any recorded partial/full return in `sale_returns`.
pub async fn has_any_sale_return(
    conn: &mut SqliteConnection,
    original_sale_id: &str,
) -> Result<bool, sqlx::Error> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sale_returns WHERE original_sale_id = ?1",
    )
    .bind(original_sale_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(count > 0)
}

/// Total `refund_minor` already refunded across all `sale_returns` for `original_sale_id`.
pub async fn sum_refunded_for_sale(
    conn: &mut SqliteConnection,
    original_sale_id: &str,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(refund_minor), 0) FROM sale_returns WHERE original_sale_id = ?1",
    )
    .bind(original_sale_id)
    .fetch_one(&mut *conn)
    .await
}

/// Sum of already-refunded payment amounts per method for `original_sale_id`.
pub async fn refunded_by_method_for_sale(
    conn: &mut SqliteConnection,
    original_sale_id: &str,
) -> Result<Vec<(String, i64)>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT sp.method AS method,
                COALESCE(SUM(sp.amount_minor), 0) AS refunded_minor
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
         WHERE s.kind = 'reversal' AND s.reverses_sale_id = ?1
         GROUP BY sp.method",
    )
    .bind(original_sale_id)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| (row.get("method"), row.get("refunded_minor")))
        .collect())
}

/// Insert a `sale_returns` row.
pub async fn insert_sale_return(
    conn: &mut SqliteConnection,
    record: &SaleReturnRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sale_returns
             (id, original_sale_id, return_sale_id, exchange_sale_id,
              refund_minor, cost_returned_minor, damaged_cost_minor,
              reason, actor_id, approved_by, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )
    .bind(&record.id)
    .bind(&record.original_sale_id)
    .bind(&record.return_sale_id)
    .bind(record.exchange_sale_id.as_deref())
    .bind(record.refund_minor)
    .bind(record.cost_returned_minor)
    .bind(record.damaged_cost_minor)
    .bind(&record.reason)
    .bind(&record.actor_id)
    .bind(&record.approved_by)
    .bind(record.occurred_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// List recorded `sale_returns` for `original_sale_id`, oldest first.
pub async fn list_sale_returns_for_sale(
    conn: &mut SqliteConnection,
    original_sale_id: &str,
) -> Result<Vec<SaleReturnSummaryRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT sr.id, sr.original_sale_id, sr.return_sale_id, rs.reference AS return_reference,
                sr.exchange_sale_id, es.reference AS exchange_reference,
                sr.refund_minor, sr.cost_returned_minor, sr.damaged_cost_minor,
                sr.reason, sr.occurred_at
         FROM sale_returns sr
         JOIN sales rs ON rs.id = sr.return_sale_id
         LEFT JOIN sales es ON es.id = sr.exchange_sale_id
         WHERE sr.original_sale_id = ?1
         ORDER BY sr.occurred_at ASC, sr.id ASC",
    )
    .bind(original_sale_id)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| SaleReturnSummaryRow {
            id: row.get("id"),
            original_sale_id: row.get("original_sale_id"),
            return_sale_id: row.get("return_sale_id"),
            return_reference: row.get("return_reference"),
            exchange_sale_id: row.get("exchange_sale_id"),
            exchange_reference: row.get("exchange_reference"),
            refund_minor: row.get("refund_minor"),
            cost_returned_minor: row.get("cost_returned_minor"),
            damaged_cost_minor: row.get("damaged_cost_minor"),
            reason: row.get("reason"),
            occurred_at: row.get("occurred_at"),
        })
        .collect())
}

/// Insert a `damaged_stock` row.
pub async fn insert_damaged_stock(
    conn: &mut SqliteConnection,
    record: &DamagedStockRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO damaged_stock
             (id, product_id, sale_id, return_sale_id, sale_line_id, return_line_id,
              unit_id, quantity, unit_cost_minor, total_cost_minor,
              reason, actor_id, approved_by, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
    )
    .bind(&record.id)
    .bind(&record.product_id)
    .bind(&record.sale_id)
    .bind(&record.return_sale_id)
    .bind(&record.sale_line_id)
    .bind(&record.return_line_id)
    .bind(record.unit_id.as_deref())
    .bind(record.quantity)
    .bind(record.unit_cost_minor)
    .bind(record.total_cost_minor)
    .bind(&record.reason)
    .bind(&record.actor_id)
    .bind(&record.approved_by)
    .bind(record.occurred_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// List rows from `damaged_stock` newest first.
pub async fn list_damaged_stock(
    conn: &mut SqliteConnection,
    limit: u32,
) -> Result<Vec<DamagedStockViewRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT d.id, d.product_id, p.name AS product_name,
                d.sale_id, s.reference AS sale_reference,
                d.return_sale_id, rs.reference AS return_reference,
                d.sale_line_id, d.return_line_id,
                d.unit_id, u.imei AS imei,
                d.quantity, d.unit_cost_minor, d.total_cost_minor,
                d.reason, d.occurred_at
         FROM damaged_stock d
         JOIN products p ON p.id = d.product_id
         JOIN sales s ON s.id = d.sale_id
         JOIN sales rs ON rs.id = d.return_sale_id
         LEFT JOIN units u ON u.id = d.unit_id
         ORDER BY d.occurred_at DESC, d.id DESC
         LIMIT ?1",
    )
    .bind(i64::from(limit))
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| DamagedStockViewRow {
            id: row.get("id"),
            product_id: row.get("product_id"),
            product_name: row.get("product_name"),
            sale_id: row.get("sale_id"),
            sale_reference: row.get("sale_reference"),
            return_sale_id: row.get("return_sale_id"),
            return_reference: row.get("return_reference"),
            sale_line_id: row.get("sale_line_id"),
            return_line_id: row.get("return_line_id"),
            unit_id: row.get("unit_id"),
            imei: row.get("imei"),
            quantity: row.get("quantity"),
            unit_cost_minor: row.get("unit_cost_minor"),
            total_cost_minor: row.get("total_cost_minor"),
            reason: row.get("reason"),
            occurred_at: row.get("occurred_at"),
        })
        .collect())
}

/// Find a live `sale` document by exact `id`, exact `reference`, or trailing reference digits.
pub async fn find_sale_by_id_or_reference(
    conn: &mut SqliteConnection,
    id_or_ref: &str,
) -> Result<Option<SaleRecord>, sqlx::Error> {
    let trimmed = id_or_ref.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let row = sqlx::query(
        "SELECT id, reference, occurred_at, sold_by, kind, reverses_sale_id,
                total_minor, cost_total_minor, discount_minor, approved_by
         FROM sales
         WHERE kind = 'sale'
           AND (id = ?1 OR lower(reference) = lower(?1) OR reference LIKE '%' || ?1)
         ORDER BY CASE WHEN id = ?1 OR lower(reference) = lower(?1) THEN 0 ELSE 1 END ASC,
                  occurred_at DESC
         LIMIT 1",
    )
    .bind(trimmed)
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
        discount_minor: row.get("discount_minor"),
        approved_by: row.get("approved_by"),
    }))
}

/// Read customer info (`customer_id`, `customer_name`, `customer_phone`) for a sale.
pub async fn sale_customer_info(
    conn: &mut SqliteConnection,
    sale_id: &str,
) -> Result<(Option<String>, Option<String>, Option<String>), sqlx::Error> {
    let row = sqlx::query(
        "SELECT s.customer_id,
                COALESCE(c.name, s.customer_name_snapshot) AS customer_name,
                c.contact AS customer_phone
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.id = ?1",
    )
    .bind(sale_id)
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(r) => Ok((
            r.get("customer_id"),
            r.get("customer_name"),
            r.get("customer_phone"),
        )),
        None => Ok((None, None, None)),
    }
}

/// List recent live `sale` documents matching an optional search query (by reference,
/// customer name/phone, product name, or IMEI) for the POS return/exchange modal.
pub async fn list_recent_sales_for_return(
    conn: &mut SqliteConnection,
    query: Option<&str>,
    limit: u32,
) -> Result<Vec<ReturnableSaleSummaryRow>, sqlx::Error> {
    let clean_q = query.map(str::trim).unwrap_or("");
    let rows = sqlx::query(
        "SELECT s.id AS sale_id,
                s.reference AS reference,
                s.occurred_at AS occurred_at,
                s.customer_id AS customer_id,
                COALESCE(c.name, s.customer_name_snapshot) AS customer_name,
                c.contact AS customer_phone,
                COALESCE((SELECT sl.product_name FROM sale_lines sl WHERE sl.sale_id = s.id ORDER BY sl.line_no LIMIT 1), '') AS first_product_name,
                (SELECT COUNT(*) FROM sale_lines sl WHERE sl.sale_id = s.id) AS line_count,
                s.total_minor AS total_minor,
                COALESCE((SELECT SUM(sr.refund_minor) FROM sale_returns sr WHERE sr.original_sale_id = s.id), 0) AS already_refunded_minor,
                CASE WHEN EXISTS (SELECT 1 FROM sale_reversals rev WHERE rev.original_sale_id = s.id) THEN 1 ELSE 0 END AS is_cancelled
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.kind = 'sale'
           AND (
               ?1 = ''
               OR lower(s.reference) LIKE '%' || lower(?1) || '%'
               OR lower(COALESCE(c.name, s.customer_name_snapshot, '')) LIKE '%' || lower(?1) || '%'
               OR COALESCE(c.contact, '') LIKE '%' || ?1 || '%'
               OR EXISTS (
                   SELECT 1 FROM sale_lines sl
                   LEFT JOIN units u ON u.id = sl.unit_id
                   WHERE sl.sale_id = s.id
                     AND (lower(sl.product_name) LIKE '%' || lower(?1) || '%' OR COALESCE(u.imei, '') LIKE '%' || ?1 || '%')
               )
           )
         ORDER BY s.occurred_at DESC, s.id DESC
         LIMIT ?2",
    )
    .bind(clean_q)
    .bind(i64::from(limit))
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let is_cancelled_raw: i64 = row.get("is_cancelled");
            ReturnableSaleSummaryRow {
                sale_id: row.get("sale_id"),
                reference: row.get("reference"),
                occurred_at: row.get("occurred_at"),
                customer_id: row.get("customer_id"),
                customer_name: row.get("customer_name"),
                customer_phone: row.get("customer_phone"),
                first_product_name: row.get("first_product_name"),
                line_count: row.get("line_count"),
                total_minor: row.get("total_minor"),
                already_refunded_minor: row.get("already_refunded_minor"),
                is_cancelled: is_cancelled_raw != 0,
            }
        })
        .collect())
}

/// List `sale` documents with their lines, category metadata, IMEIs, customer info,
/// seller name, and payment breakdown for the Sales history & analytics screen (`ADR-029`).
///
/// When `only_seller_id` is `Some(uid)`, only sales recorded by `uid` are returned.
pub async fn list_sales_history(
    conn: &mut SqliteConnection,
    only_seller_id: Option<&str>,
    limit: u32,
) -> Result<Vec<SaleHistoryRow>, sqlx::Error> {
    let sale_rows = sqlx::query(
        "SELECT s.id AS sale_id,
                s.reference AS reference,
                s.occurred_at AS occurred_at,
                s.sold_by AS sold_by,
                COALESCE(usr.display_name, s.sold_by) AS seller_name,
                s.customer_id AS customer_id,
                COALESCE(c.name, s.customer_name_snapshot) AS customer_name,
                c.contact AS customer_phone,
                s.total_minor AS total_minor,
                s.cost_total_minor AS cost_total_minor,
                s.discount_minor AS discount_minor,
                COALESCE((SELECT SUM(sr.refund_minor) FROM sale_returns sr WHERE sr.original_sale_id = s.id), 0) AS already_refunded_minor,
                CASE WHEN EXISTS (SELECT 1 FROM sale_reversals rev WHERE rev.original_sale_id = s.id) THEN 1 ELSE 0 END AS is_cancelled
         FROM sales s
         LEFT JOIN users usr ON usr.id = s.sold_by
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.kind = 'sale'
           AND (?1 IS NULL OR s.sold_by = ?1)
         ORDER BY s.occurred_at ASC, s.id ASC
         LIMIT ?2",
    )
    .bind(only_seller_id)
    .bind(i64::from(limit))
    .fetch_all(&mut *conn)
    .await?;

    let mut out = Vec::with_capacity(sale_rows.len());
    for srow in sale_rows {
        let sale_id: String = srow.get("sale_id");
        let total_minor: i64 = srow.get("total_minor");
        let cost_total_minor: i64 = srow.get("cost_total_minor");
        let discount_minor: i64 = srow.get("discount_minor");
        let raw_refunded: i64 = srow.get("already_refunded_minor");
        let is_cancelled_raw: i64 = srow.get("is_cancelled");
        let is_cancelled = is_cancelled_raw != 0;

        let line_rows = sqlx::query(
            "SELECT sl.id AS line_id,
                    sl.line_no AS line_no,
                    sl.product_id AS product_id,
                    sl.product_name AS product_name,
                    COALESCE(sl.department_id, p.department_id) AS category_id,
                    d.name AS category_name,
                    d.parent_id AS parent_category_id,
                    sl.quantity AS quantity,
                    sl.unit_selling_price_minor AS unit_selling_price_minor,
                    sl.discount_minor AS discount_minor,
                    sl.line_total_minor AS line_total_minor,
                    sl.unit_cost_minor AS unit_cost_minor,
                    sl.line_cost_minor AS line_cost_minor,
                    sl.warranty_start AS warranty_start,
                    sl.warranty_end AS warranty_end,
                    sl.unit_id AS unit_id,
                    u.imei AS imei
             FROM sale_lines sl
             LEFT JOIN products p ON p.id = sl.product_id
             LEFT JOIN departments d ON d.id = COALESCE(sl.department_id, p.department_id)
             LEFT JOIN units u ON u.id = sl.unit_id
             WHERE sl.sale_id = ?1
             ORDER BY sl.line_no ASC",
        )
        .bind(&sale_id)
        .fetch_all(&mut *conn)
        .await?;

        let mut lines = Vec::with_capacity(line_rows.len());
        let mut lines_subtotal_minor = 0i64;
        for lrow in line_rows {
            let line_total_minor: i64 = lrow.get("line_total_minor");
            let line_cost_minor: i64 = lrow.get("line_cost_minor");
            lines_subtotal_minor = lines_subtotal_minor.saturating_add(line_total_minor);
            lines.push(SaleHistoryLineRow {
                line_id: lrow.get("line_id"),
                line_no: lrow.get("line_no"),
                product_id: lrow.get("product_id"),
                product_name: lrow.get("product_name"),
                category_id: lrow.get("category_id"),
                category_name: lrow.get("category_name"),
                parent_category_id: lrow.get("parent_category_id"),
                quantity: lrow.get("quantity"),
                unit_selling_price_minor: lrow.get("unit_selling_price_minor"),
                discount_minor: lrow.get("discount_minor"),
                line_total_minor,
                unit_cost_minor: lrow.get("unit_cost_minor"),
                line_cost_minor: Some(line_cost_minor),
                line_profit_minor: Some(line_total_minor - line_cost_minor),
                warranty_start: lrow.get("warranty_start"),
                warranty_end: lrow.get("warranty_end"),
                unit_id: lrow.get("unit_id"),
                imei: lrow.get("imei"),
            });
        }

        let raw_payments = list_sale_payments(&mut *conn, &sale_id).await?;
        let payments = if raw_payments.is_empty() {
            vec![SaleHistoryPaymentRow {
                method: "cash".to_owned(),
                amount_minor: total_minor,
                reference: None,
            }]
        } else {
            raw_payments
                .into_iter()
                .map(|p| SaleHistoryPaymentRow {
                    method: p.method,
                    amount_minor: p.amount_minor,
                    reference: p.reference,
                })
                .collect()
        };

        let already_refunded_minor = if is_cancelled {
            total_minor
        } else {
            raw_refunded.min(total_minor)
        };

        out.push(SaleHistoryRow {
            sale_id,
            reference: srow.get("reference"),
            occurred_at: srow.get("occurred_at"),
            sold_by: srow.get("sold_by"),
            seller_name: srow.get("seller_name"),
            customer_id: srow.get("customer_id"),
            customer_name: srow.get("customer_name"),
            customer_phone: srow.get("customer_phone"),
            lines_subtotal_minor,
            discount_minor,
            total_minor,
            cost_total_minor: Some(cost_total_minor),
            profit_minor: Some(total_minor - cost_total_minor),
            already_refunded_minor,
            is_cancelled,
            lines,
            payments,
        });
    }

    Ok(out)
}
