//! SQLite repository for manual and system-suggested shortages (`النواقص`, Plan item 1.15, `ADR-030`).

use sqlx::{Row, SqliteConnection};

use crate::domain::shortage::{
    default_min_qty, suggested_qty, ShortageEntry, ShortageSuggestion,
};

#[derive(Debug, Clone)]
pub struct NewShortageRow {
    pub id: String,
    pub product_id: Option<String>,
    pub name: String,
    pub qty: i64,
    pub note: String,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub status: String,
    pub created_by: String,
    pub created_at: i64,
}

fn map_shortage_row(row: &sqlx::sqlite::SqliteRow) -> ShortageEntry {
    let product_id: Option<String> = row.get("product_id");
    let on_hand_raw: Option<i64> = row.get("on_hand");
    let disposition: Option<String> = row.get("disposition");
    let tracking: Option<String> = row.get("tracking");
    let category_kind: Option<String> = row.get("category_kind");

    let (on_hand, min_qty) = if product_id.is_some() {
        let is_serial = disposition.as_deref() == Some("serialized")
            || matches!(
                tracking.as_deref(),
                Some("serial_optional" | "serial_required")
            );
        let min = default_min_qty(is_serial, category_kind.as_deref());
        (Some(on_hand_raw.unwrap_or(0)), Some(min))
    } else {
        (None, None)
    };

    ShortageEntry {
        id: row.get("id"),
        product_id,
        name: row.get("name"),
        qty: row.get("qty"),
        note: row.get("note"),
        customer_name: row.get("customer_name"),
        customer_phone: row.get("customer_phone"),
        status: row.get("status"),
        created_by: row.get("created_by"),
        created_by_name: row.get("created_by_name"),
        created_at: row.get("created_at"),
        resolved_at: row.get("resolved_at"),
        on_hand,
        min_qty,
    }
}

pub async fn list_active_shortages(
    conn: &mut SqliteConnection,
) -> Result<Vec<ShortageEntry>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT s.id AS id,
                s.product_id AS product_id,
                s.name AS name,
                s.qty AS qty,
                s.note AS note,
                s.customer_name AS customer_name,
                s.customer_phone AS customer_phone,
                s.status AS status,
                s.created_by AS created_by,
                COALESCE(u.display_name, s.created_by) AS created_by_name,
                s.created_at AS created_at,
                s.resolved_at AS resolved_at,
                COALESCE(sl.quantity, 0) AS on_hand,
                p.disposition AS disposition,
                p.tracking AS tracking,
                COALESCE(d.kind, pd.kind) AS category_kind
         FROM shortages s
         LEFT JOIN users u ON u.id = s.created_by
         LEFT JOIN products p ON p.id = s.product_id
         LEFT JOIN departments d ON d.id = p.department_id
         LEFT JOIN departments pd ON pd.id = d.parent_id
         LEFT JOIN stock_levels sl ON sl.product_id = s.product_id
         WHERE s.resolved_at IS NULL
         ORDER BY s.created_at DESC, s.id DESC",
    )
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows.iter().map(map_shortage_row).collect())
}

pub async fn find_active_by_id(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<ShortageEntry>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT s.id AS id,
                s.product_id AS product_id,
                s.name AS name,
                s.qty AS qty,
                s.note AS note,
                s.customer_name AS customer_name,
                s.customer_phone AS customer_phone,
                s.status AS status,
                s.created_by AS created_by,
                COALESCE(u.display_name, s.created_by) AS created_by_name,
                s.created_at AS created_at,
                s.resolved_at AS resolved_at,
                COALESCE(sl.quantity, 0) AS on_hand,
                p.disposition AS disposition,
                p.tracking AS tracking,
                COALESCE(d.kind, pd.kind) AS category_kind
         FROM shortages s
         LEFT JOIN users u ON u.id = s.created_by
         LEFT JOIN products p ON p.id = s.product_id
         LEFT JOIN departments d ON d.id = p.department_id
         LEFT JOIN departments pd ON pd.id = d.parent_id
         LEFT JOIN stock_levels sl ON sl.product_id = s.product_id
         WHERE s.id = ?1 AND s.resolved_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;

    Ok(row.as_ref().map(map_shortage_row))
}

pub async fn find_active_by_product_id(
    conn: &mut SqliteConnection,
    product_id: &str,
) -> Result<Option<ShortageEntry>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT s.id AS id,
                s.product_id AS product_id,
                s.name AS name,
                s.qty AS qty,
                s.note AS note,
                s.customer_name AS customer_name,
                s.customer_phone AS customer_phone,
                s.status AS status,
                s.created_by AS created_by,
                COALESCE(u.display_name, s.created_by) AS created_by_name,
                s.created_at AS created_at,
                s.resolved_at AS resolved_at,
                COALESCE(sl.quantity, 0) AS on_hand,
                p.disposition AS disposition,
                p.tracking AS tracking,
                COALESCE(d.kind, pd.kind) AS category_kind
         FROM shortages s
         LEFT JOIN users u ON u.id = s.created_by
         LEFT JOIN products p ON p.id = s.product_id
         LEFT JOIN departments d ON d.id = p.department_id
         LEFT JOIN departments pd ON pd.id = d.parent_id
         LEFT JOIN stock_levels sl ON sl.product_id = s.product_id
         WHERE s.product_id = ?1 AND s.resolved_at IS NULL
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT 1",
    )
    .bind(product_id)
    .fetch_optional(&mut *conn)
    .await?;

    Ok(row.as_ref().map(map_shortage_row))
}

pub async fn find_active_product_name(
    conn: &mut SqliteConnection,
    product_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT name FROM products WHERE id = ?1 AND status = 'active'",
    )
    .bind(product_id)
    .fetch_optional(&mut *conn)
    .await
}

pub async fn insert_shortage(
    conn: &mut SqliteConnection,
    entry: &NewShortageRow,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO shortages (
            id, product_id, name, qty, note,
            customer_name, customer_phone, status,
            created_by, created_at, resolved_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
    )
    .bind(&entry.id)
    .bind(&entry.product_id)
    .bind(&entry.name)
    .bind(entry.qty)
    .bind(&entry.note)
    .bind(&entry.customer_name)
    .bind(&entry.customer_phone)
    .bind(&entry.status)
    .bind(&entry.created_by)
    .bind(entry.created_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn increment_shortage_qty(
    conn: &mut SqliteConnection,
    id: &str,
    added_qty: i64,
    note: &str,
    customer_name: Option<&str>,
    customer_phone: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE shortages
         SET qty = qty + ?2,
             note = CASE WHEN length(trim(note)) = 0 AND length(trim(?3)) > 0 THEN ?3 ELSE note END,
             customer_name = COALESCE(customer_name, ?4),
             customer_phone = COALESCE(customer_phone, ?5)
         WHERE id = ?1 AND resolved_at IS NULL",
    )
    .bind(id)
    .bind(added_qty)
    .bind(note)
    .bind(customer_name)
    .bind(customer_phone)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn update_status(
    conn: &mut SqliteConnection,
    id: &str,
    status: &str,
) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE shortages SET status = ?2 WHERE id = ?1 AND resolved_at IS NULL",
    )
    .bind(id)
    .bind(status)
    .execute(&mut *conn)
    .await?;
    Ok(res.rows_affected())
}

pub async fn resolve_shortage(
    conn: &mut SqliteConnection,
    id: &str,
    resolved_at: i64,
) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE shortages SET resolved_at = ?2 WHERE id = ?1 AND resolved_at IS NULL",
    )
    .bind(id)
    .bind(resolved_at)
    .execute(&mut *conn)
    .await?;
    Ok(res.rows_affected())
}

pub async fn resolve_shortages_for_product(
    conn: &mut SqliteConnection,
    product_id: &str,
    resolved_at: i64,
) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE shortages SET resolved_at = ?2 WHERE product_id = ?1 AND resolved_at IS NULL",
    )
    .bind(product_id)
    .bind(resolved_at)
    .execute(&mut *conn)
    .await?;
    Ok(res.rows_affected())
}

pub async fn delete_shortage(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<u64, sqlx::Error> {
    let res = sqlx::query("DELETE FROM shortages WHERE id = ?1")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(res.rows_affected())
}

pub async fn list_system_suggestions(
    conn: &mut SqliteConnection,
) -> Result<Vec<ShortageSuggestion>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT p.id AS product_id,
                p.name AS name,
                p.disposition AS disposition,
                p.tracking AS tracking,
                p.department_id AS category_id,
                CASE
                    WHEN pd.name IS NOT NULL AND d.name IS NOT NULL THEN pd.name || ' › ' || d.name
                    ELSE d.name
                END AS category_name,
                COALESCE(d.kind, pd.kind) AS category_kind,
                COALESCE(sl.quantity, 0) AS on_hand
         FROM products p
         LEFT JOIN departments d ON d.id = p.department_id
         LEFT JOIN departments pd ON pd.id = d.parent_id
         LEFT JOIN stock_levels sl ON sl.product_id = p.id
         WHERE p.status = 'active'
           AND NOT EXISTS (
               SELECT 1 FROM shortages s
               WHERE s.product_id = p.id AND s.resolved_at IS NULL
           )
         ORDER BY COALESCE(sl.quantity, 0) ASC, p.name ASC",
    )
    .fetch_all(&mut *conn)
    .await?;

    let mut out = Vec::new();
    for r in rows {
        let on_hand: i64 = r.get("on_hand");
        let disposition: String = r.get("disposition");
        let tracking: String = r.get("tracking");
        let category_kind: Option<String> = r.get("category_kind");
        let is_serial = disposition == "serialized"
            || tracking == "serial_optional"
            || tracking == "serial_required";
        let min_qty = default_min_qty(is_serial, category_kind.as_deref());
        if on_hand <= min_qty {
            out.push(ShortageSuggestion {
                product_id: r.get("product_id"),
                name: r.get("name"),
                category_id: r.get("category_id"),
                category_name: r.get("category_name"),
                on_hand,
                min_qty,
                suggested_qty: suggested_qty(on_hand, min_qty),
            });
        }
    }

    Ok(out)
}
