//! What the sales screen reads: the sellable catalogue with stock on hand.
//!
//! Read-only, two statements, no cost. A seller (`Permission::Sell`) may read
//! this; the full product list (`list_products`, `ManageCatalog`) and the
//! stock position (`get_position`, which reveals cost) stay manager-only.

use sqlx::{Row, SqliteConnection};

/// One active product as the sales screen shows it.
///
/// No cost column: neither `default_cost_minor` nor the moving-average total
/// is selected, so this read cannot leak what the stock cost even by mistake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PosProductRow {
    pub id: String,
    pub name: String,
    pub disposition: String,
    pub barcode: Option<String>,
    pub sale_price_minor: Option<i64>,
    pub department_id: Option<String>,
    /// Units on hand; zero for a product nobody has received yet.
    pub on_hand: i64,
    /// Units sold since `sold_since`, for ordering the tiles. Cancellations
    /// are not subtracted: the figure ranks, it does not account.
    pub sold_recently: i64,
}

/// Every active product, alphabetically, with its stock and recent sales.
pub async fn list_sellable(
    conn: &mut SqliteConnection,
    sold_since: i64,
) -> Result<Vec<PosProductRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT p.id, p.name, p.disposition, p.barcode, p.sale_price_minor, p.department_id,
                COALESCE(s.quantity, 0) AS on_hand,
                COALESCE(r.sold, 0) AS sold_recently
         FROM products p
         LEFT JOIN stock_levels s ON s.product_id = p.id
         LEFT JOIN (
             SELECT l.product_id, SUM(l.quantity) AS sold
             FROM sale_lines l
             JOIN sales v ON v.id = l.sale_id
             WHERE v.kind = 'sale' AND v.occurred_at >= ?1
             GROUP BY l.product_id
         ) r ON r.product_id = p.id
         WHERE p.status = 'active'
         ORDER BY p.name COLLATE NOCASE ASC",
    )
    .bind(sold_since)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| PosProductRow {
            id: row.get("id"),
            name: row.get("name"),
            disposition: row.get("disposition"),
            barcode: row.get("barcode"),
            sale_price_minor: row.get("sale_price_minor"),
            department_id: row.get("department_id"),
            on_hand: row.get("on_hand"),
            sold_recently: row.get("sold_recently"),
        })
        .collect())
}

/// One active department, for the chips above the tiles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PosDepartmentRow {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
}

/// Active departments in the owner's order.
pub async fn list_departments(
    conn: &mut SqliteConnection,
) -> Result<Vec<PosDepartmentRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, name, sort_order
         FROM departments
         WHERE status = 'active'
         ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
    )
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| PosDepartmentRow {
            id: row.get("id"),
            name: row.get("name"),
            sort_order: row.get("sort_order"),
        })
        .collect())
}
