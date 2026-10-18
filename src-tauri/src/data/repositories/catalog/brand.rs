//! Phone brands (ADR-018 §2), and a phone's details on its product row.
//!
//! Reading is defensive, as for departments: an unknown device type or a
//! malformed id is a row this build does not understand, reported as an error,
//! never turned into a default.

use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

use crate::domain::catalog::{
    Brand, BrandDeviceType, BrandId, BrandName, DeviceType, PhoneDetails, ProductId,
};
use crate::domain::identity::UserId;

fn encode_bool(value: bool) -> i64 {
    i64::from(value)
}

pub async fn insert(conn: &mut SqliteConnection, brand: &Brand) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO brands
           (id, name, device_type, sort_order, hidden, created_by, updated_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(brand.id.as_str())
    .bind(brand.name.as_str())
    .bind(brand.device_type.as_str())
    .bind(brand.sort_order)
    .bind(encode_bool(brand.hidden))
    .bind(brand.created_by.as_str())
    .bind(brand.updated_by.as_str())
    .bind(brand.created_at)
    .bind(brand.updated_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn find_by_id(
    conn: &mut SqliteConnection,
    id: BrandId,
) -> Result<Option<Brand>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, name, device_type, sort_order, hidden, created_by, updated_by,
                created_at, updated_at
         FROM brands WHERE id = ?1",
    )
    .bind(id.as_str())
    .fetch_optional(&mut *conn)
    .await?;
    row.map(row_to_brand).transpose()
}

/// Every brand, in the owner's order.
pub async fn list_all(conn: &mut SqliteConnection) -> Result<Vec<Brand>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, name, device_type, sort_order, hidden, created_by, updated_by,
                created_at, updated_at
         FROM brands
         ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC",
    )
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter().map(row_to_brand).collect()
}

/// Persist an edit: the name, the device type, the order and the hidden flag.
pub async fn update(conn: &mut SqliteConnection, brand: &Brand) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE brands
         SET name = ?2, device_type = ?3, sort_order = ?4, hidden = ?5,
             updated_by = ?6, updated_at = ?7
         WHERE id = ?1",
    )
    .bind(brand.id.as_str())
    .bind(brand.name.as_str())
    .bind(brand.device_type.as_str())
    .bind(brand.sort_order)
    .bind(encode_bool(brand.hidden))
    .bind(brand.updated_by.as_str())
    .bind(brand.updated_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Remove a brand the owner added and nothing names. `0` means no such row.
pub async fn delete(conn: &mut SqliteConnection, id: BrandId) -> Result<u64, sqlx::Error> {
    let done = sqlx::query("DELETE FROM brands WHERE id = ?1")
        .bind(id.as_str())
        .execute(&mut *conn)
        .await?;
    Ok(done.rows_affected())
}

/// Whether a brand other than `except` already has `name`, compared the way
/// the unique index compares (`COLLATE NOCASE`).
pub async fn name_taken(
    conn: &mut SqliteConnection,
    name: &BrandName,
    except: Option<BrandId>,
) -> Result<bool, sqlx::Error> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM brands
          WHERE name = ?1 COLLATE NOCASE AND id <> COALESCE(?2, '')
          LIMIT 1",
    )
    .bind(name.as_str())
    .bind(except.map(|id| id.as_str()))
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// How many products name `id` as their company, archived ones included.
pub async fn count_products(conn: &mut SqliteConnection, id: BrandId) -> Result<i64, sqlx::Error> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products WHERE brand_id = ?1")
        .bind(id.as_str())
        .fetch_one(&mut *conn)
        .await?;
    Ok(count)
}

/// Live products per brand: `(brand id, count)`; brands with none are absent.
pub async fn active_product_counts(
    conn: &mut SqliteConnection,
) -> Result<Vec<(String, i64)>, sqlx::Error> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT brand_id, COUNT(*) FROM products
          WHERE brand_id IS NOT NULL AND status = 'active'
          GROUP BY brand_id",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows)
}

/// Write a phone's details on its product, all five columns at once. The
/// triggers of `0017` refuse half a phone whatever this function is given.
pub async fn set_phone_details(
    conn: &mut SqliteConnection,
    product: ProductId,
    details: &PhoneDetails,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE products
         SET brand_id = ?2, model = ?3, device_type = ?4, storage_gb = ?5, ram_gb = ?6,
             tracking = 'serial_optional'
         WHERE id = ?1",
    )
    .bind(product.as_str())
    .bind(details.brand.as_str())
    .bind(details.model.as_str())
    .bind(details.device_type.as_str())
    .bind(details.storage_gb)
    .bind(details.ram_gb)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// A live product that is already this phone — the same company, model
/// (whatever the case), storage and RAM — as `(id, name)`.
pub async fn find_phone(
    conn: &mut SqliteConnection,
    details: &PhoneDetails,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let found: Option<(String, String)> = sqlx::query_as(
        "SELECT p.id, p.name FROM products p
         LEFT JOIN departments d ON d.id = p.department_id
         WHERE p.status = 'active'
           AND COALESCE(d.kind, 'phone') = 'phone'
           AND p.brand_id = ?1 AND lower(p.model) = lower(?2)
           AND p.storage_gb IS ?3 AND p.ram_gb IS ?4
         LIMIT 1",
    )
    .bind(details.brand.as_str())
    .bind(details.model.as_str())
    .bind(details.storage_gb)
    .bind(details.ram_gb)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found)
}

/// Find an active used-phone product in `department_id` matching the exact generated title (`ADR-032`).
pub async fn find_used_phone_by_name(
    conn: &mut SqliteConnection,
    department_id: &str,
    name: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT id FROM products
         WHERE status = 'active' AND department_id = ?1 AND lower(name) = lower(?2)
         LIMIT 1",
    )
    .bind(department_id)
    .bind(name)
    .fetch_optional(&mut *conn)
    .await
}

/// Update `sale_price_minor` on a product row inside a transaction.
pub async fn update_product_sale_price_minor(
    conn: &mut SqliteConnection,
    product_id: &str,
    sale_price_minor: i64,
    updated_by: &str,
    updated_at: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE products
         SET sale_price_minor = ?2, updated_by = ?3, updated_at = ?4
         WHERE id = ?1",
    )
    .bind(product_id)
    .bind(sale_price_minor)
    .bind(updated_by)
    .bind(updated_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

fn row_to_brand(row: sqlx::sqlite::SqliteRow) -> Result<Brand, sqlx::Error> {
    let raw_id: String = row.get("id");
    let name: String = row.get("name");
    let device_raw: String = row.get("device_type");
    let hidden: i64 = row.get("hidden");
    let created_by: String = row.get("created_by");
    let updated_by: String = row.get("updated_by");

    let parse_uuid = |raw: String, what: &str| -> Result<Uuid, sqlx::Error> {
        raw.parse()
            .map_err(|_| sqlx::Error::Protocol(format!("malformed {what} in brands")))
    };
    let device_type = BrandDeviceType::parse(&device_raw).ok_or_else(|| {
        sqlx::Error::Protocol(format!("unknown device_type in brands: {device_raw}"))
    })?;
    let hidden = match hidden {
        0 => false,
        1 => true,
        other => return Err(sqlx::Error::Protocol(format!("unexpected hidden in brands: {other}"))),
    };
    Ok(Brand {
        id: BrandId::from_uuid(parse_uuid(raw_id, "id")?),
        name: BrandName::new(&name)
            .map_err(|e| sqlx::Error::Protocol(format!("invalid brand name: {}", e.code())))?,
        device_type,
        sort_order: row.get("sort_order"),
        hidden,
        created_by: UserId::from_uuid(parse_uuid(created_by, "created_by")?),
        updated_by: UserId::from_uuid(parse_uuid(updated_by, "updated_by")?),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

/// A product's device type as stored, for readers that show it.
pub fn parse_device_type(raw: Option<String>) -> Option<DeviceType> {
    raw.as_deref().and_then(DeviceType::parse)
}
