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
    /// The phone's company (ADR-018 §2), or `None` for anything but a phone.
    pub brand_id: Option<String>,
    /// The variant parent this product belongs to (ADR-018 §4), or `None`.
    pub parent_id: Option<String>,
    /// The parent's base name («جراب سيليكون ملون») shown on the family tile.
    pub parent_name: Option<String>,
    /// The parent's first dimension («الموبايل»).
    pub dimension_1: Option<String>,
    /// The parent's second dimension («اللون»), if two-dimensional.
    pub dimension_2: Option<String>,
    /// This product's value on the first dimension («Galaxy A16»).
    pub variant_1: Option<String>,
    /// This product's value on the second dimension («أسود»).
    pub variant_2: Option<String>,
    /// Order of this variant inside its parent's picker.
    pub variant_order: Option<i64>,
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
                p.brand_id,
                p.parent_id,
                vp.name AS parent_name,
                vp.dimension_1,
                vp.dimension_2,
                p.variant_1,
                p.variant_2,
                p.variant_order,
                COALESCE(s.quantity, 0) AS on_hand,
                COALESCE(r.sold, 0) AS sold_recently
         FROM products p
         LEFT JOIN product_parents vp ON vp.id = p.parent_id
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
            brand_id: row.get("brand_id"),
            parent_id: row.get("parent_id"),
            parent_name: row.get("parent_name"),
            dimension_1: row.get("dimension_1"),
            dimension_2: row.get("dimension_2"),
            variant_1: row.get("variant_1"),
            variant_2: row.get("variant_2"),
            variant_order: row.get("variant_order"),
            on_hand: row.get("on_hand"),
            sold_recently: row.get("sold_recently"),
        })
        .collect())
}


/// One live category, for the chips above the tiles (ADR-018 §1): the screen
/// builds the two rows from `parent_id`, and leaves out the hidden ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PosCategoryRow {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub icon: String,
    pub hidden: bool,
    pub sort_order: i64,
}

/// Live categories in the owner's order, hidden ones included: a hidden
/// category's products are still sold, and search still finds them by its name.
pub async fn list_categories(
    conn: &mut SqliteConnection,
) -> Result<Vec<PosCategoryRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, name, parent_id, kind, icon, hidden, sort_order
         FROM departments
         WHERE status = 'active'
         ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC",
    )
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| PosCategoryRow {
            id: row.get("id"),
            name: row.get("name"),
            parent_id: row.get("parent_id"),
            kind: row.get("kind"),
            icon: row.get("icon"),
            hidden: row.get::<i64, _>("hidden") != 0,
            sort_order: row.get("sort_order"),
        })
        .collect())
}
