//! Persistence for serialized device units (`units` table, `ADR-019`).
//!
//! Functions take `&mut SqliteConnection` so they compose inside the
//! transactions of `services::inventory::stock` and `services::sales`.

use sqlx::{Row, SqliteConnection};

use crate::domain::unit::TrackingMode;

/// One persisted device unit row from `units`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitRecord {
    pub id: String,
    pub product_id: String,
    pub imei: String,
    pub imei2: Option<String>,
    pub color: Option<String>,
    pub unit_cost_minor: i64,
    pub status: String,
    pub received_movement_id: Option<String>,
    pub sale_line_id: Option<String>,
    pub retired_reason: Option<String>,
    pub created_by: String,
    pub created_at: i64,
}

/// Read `products.tracking` for a product, or `None` if no such product exists.
pub async fn product_tracking(
    conn: &mut SqliteConnection,
    product_id: &str,
) -> Result<Option<TrackingMode>, sqlx::Error> {
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT tracking FROM products WHERE id = ?1",
    )
    .bind(product_id)
    .fetch_optional(&mut *conn)
    .await?;

    match raw {
        None => Ok(None),
        Some(raw) => TrackingMode::parse(&raw)
            .map(Some)
            .ok_or_else(|| sqlx::Error::Protocol(format!("unknown products.tracking `{raw}`"))),
    }
}

/// Update `products.tracking` for a product.
pub async fn set_product_tracking(
    conn: &mut SqliteConnection,
    product_id: &str,
    tracking: TrackingMode,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE products SET tracking = ?2 WHERE id = ?1")
        .bind(product_id)
        .bind(tracking.as_str())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Insert a new row in `units`.
pub async fn insert_unit(
    conn: &mut SqliteConnection,
    unit: &UnitRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO units
             (id, product_id, imei, imei2, color, unit_cost_minor, status,
              received_movement_id, sale_line_id, retired_reason, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    )
    .bind(&unit.id)
    .bind(&unit.product_id)
    .bind(&unit.imei)
    .bind(unit.imei2.as_deref())
    .bind(unit.color.as_deref())
    .bind(unit.unit_cost_minor)
    .bind(&unit.status)
    .bind(unit.received_movement_id.as_deref())
    .bind(unit.sale_line_id.as_deref())
    .bind(unit.retired_reason.as_deref())
    .bind(&unit.created_by)
    .bind(unit.created_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Find a unit by its primary or secondary IMEI (`imei = ?1 OR imei2 = ?1`).
pub async fn find_by_imei(
    conn: &mut SqliteConnection,
    imei: &str,
) -> Result<Option<UnitRecord>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, product_id, imei, imei2, color, unit_cost_minor, status,
                received_movement_id, sale_line_id, retired_reason, created_by, created_at
         FROM units
         WHERE imei = ?1 OR imei2 = ?1
         LIMIT 1",
    )
    .bind(imei)
    .fetch_optional(&mut *conn)
    .await?;

    Ok(row.map(row_to_unit))
}

/// List all `in_stock` units for a product, oldest first (`created_at ASC, id ASC`).
pub async fn list_in_stock_for_product(
    conn: &mut SqliteConnection,
    product_id: &str,
) -> Result<Vec<UnitRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, product_id, imei, imei2, color, unit_cost_minor, status,
                received_movement_id, sale_line_id, retired_reason, created_by, created_at
         FROM units
         WHERE product_id = ?1 AND status = 'in_stock'
         ORDER BY created_at ASC, id ASC",
    )
    .bind(product_id)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows.into_iter().map(row_to_unit).collect())
}

/// List all `in_stock` units for active products, oldest first.
pub async fn list_all_in_stock_for_active_products(
    conn: &mut SqliteConnection,
) -> Result<Vec<UnitRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT u.id, u.product_id, u.imei, u.imei2, u.color, u.unit_cost_minor, u.status,
                u.received_movement_id, u.sale_line_id, u.retired_reason, u.created_by, u.created_at
         FROM units u
         JOIN products p ON p.id = u.product_id
         WHERE u.status = 'in_stock' AND p.status = 'active'
         ORDER BY u.created_at ASC, u.id ASC",
    )
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows.into_iter().map(row_to_unit).collect())
}

/// Mark a unit as sold and link it to its `sale_lines` row.
pub async fn mark_sold(
    conn: &mut SqliteConnection,
    unit_id: &str,
    sale_line_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE units
         SET status = 'sold', sale_line_id = ?2, retired_reason = NULL
         WHERE id = ?1",
    )
    .bind(unit_id)
    .bind(sale_line_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Retire an `in_stock` unit automatically when an unlinked sale reduces on-hand
/// quantity below the count of registered units (`PLAN.md` §7.3).
pub async fn mark_retired_for_sale_line(
    conn: &mut SqliteConnection,
    unit_id: &str,
    sale_line_id: &str,
    reason: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE units
         SET status = 'retired', sale_line_id = ?2, retired_reason = ?3
         WHERE id = ?1",
    )
    .bind(unit_id)
    .bind(sale_line_id)
    .bind(reason)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Retire an `in_stock` unit when a manual stock removal reduces on-hand
/// quantity below the count of registered units.
pub async fn mark_retired_manual(
    conn: &mut SqliteConnection,
    unit_id: &str,
    reason: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE units
         SET status = 'retired', sale_line_id = NULL, retired_reason = ?2
         WHERE id = ?1",
    )
    .bind(unit_id)
    .bind(reason)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Restore any unit sold or auto-retired by `sale_line_id` back to `in_stock`
/// when that sale is cancelled.
pub async fn restore_units_for_sale_line(
    conn: &mut SqliteConnection,
    sale_line_id: &str,
) -> Result<u64, sqlx::Error> {
    let done = sqlx::query(
        "UPDATE units
         SET status = 'in_stock', sale_line_id = NULL, retired_reason = NULL
         WHERE sale_line_id = ?1",
    )
    .bind(sale_line_id)
    .execute(&mut *conn)
    .await?;
    Ok(done.rows_affected())
}

/// Restore up to `max_count` units sold or auto-retired by `sale_line_id` back to `in_stock`
/// when an intact partial or full return is recorded (`ADR-026`).
pub async fn restore_units_for_sale_line_partial(
    conn: &mut SqliteConnection,
    sale_line_id: &str,
    max_count: i64,
) -> Result<u64, sqlx::Error> {
    if max_count <= 0 {
        return Ok(0);
    }
    let done = sqlx::query(
        "UPDATE units
         SET status = 'in_stock', sale_line_id = NULL, retired_reason = NULL
         WHERE id IN (
             SELECT id FROM units
             WHERE sale_line_id = ?1
             ORDER BY CASE WHEN status = 'sold' THEN 0 ELSE 1 END ASC, created_at DESC, id DESC
             LIMIT ?2
         )",
    )
    .bind(sale_line_id)
    .bind(max_count)
    .execute(&mut *conn)
    .await?;
    Ok(done.rows_affected())
}

/// Mark up to `max_count` units sold by `sale_line_id` as `retired` when returned
/// as damaged (`ADR-026`), so a damaged IMEI device never returns to `in_stock`.
pub async fn retire_units_for_damaged_return(
    conn: &mut SqliteConnection,
    sale_line_id: &str,
    max_count: i64,
    reason: &str,
) -> Result<u64, sqlx::Error> {
    if max_count <= 0 {
        return Ok(0);
    }
    let done = sqlx::query(
        "UPDATE units
         SET status = 'retired', retired_reason = ?3
         WHERE id IN (
             SELECT id FROM units
             WHERE sale_line_id = ?1 AND status = 'sold'
             ORDER BY created_at DESC, id DESC
             LIMIT ?2
         )",
    )
    .bind(sale_line_id)
    .bind(max_count)
    .bind(reason)
    .execute(&mut *conn)
    .await?;
    Ok(done.rows_affected())
}

/// Look up the primary IMEI for a `units.id`, if present.
pub async fn find_imei_by_unit_id(
    conn: &mut SqliteConnection,
    unit_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT imei FROM units WHERE id = ?1")
        .bind(unit_id)
        .fetch_optional(&mut *conn)
        .await
}

fn row_to_unit(row: sqlx::sqlite::SqliteRow) -> UnitRecord {
    UnitRecord {
        id: row.get("id"),
        product_id: row.get("product_id"),
        imei: row.get("imei"),
        imei2: row.get("imei2"),
        color: row.get("color"),
        unit_cost_minor: row.get("unit_cost_minor"),
        status: row.get("status"),
        received_movement_id: row.get("received_movement_id"),
        sale_line_id: row.get("sale_line_id"),
        retired_reason: row.get("retired_reason"),
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
    }
}
