//! Product catalogue persistence.
//!
//! The only place SQL for the catalogue may appear. Functions take
//! `&mut SqliteConnection` so the same code serves a pooled call and a call
//! inside a transaction, as in the identity repositories.

use sqlx::{Row, SqliteConnection};

use crate::domain::catalog::{
    Barcode, Disposition, Product, ProductId, ProductName, ProductStatus, SalePrice,
};
use crate::domain::identity::{Timestamp, UserId};
use crate::domain::money::Piastres;
use crate::domain::organisation::DepartmentId;

pub async fn insert(
    conn: &mut SqliteConnection,
    product: &Product,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO products
         (id, name, disposition, barcode, sale_price_minor,
          department_id, default_cost_minor, vat_rate_bp, status,
          created_by, updated_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    )
    .bind(product.id.as_str())
    .bind(product.name.as_str())
    .bind(product.disposition.as_str())
    .bind(product.barcode.as_ref().map(|b| b.as_str().to_string()))
    // A genuine None. Binding zero here would turn "not set" into "free".
    .bind(product.sale_price.map(|p| p.as_minor()))
    // Three genuine Nones for a product that has never been classified, costed or
    // rated. Binding a zero here would invent a department, a zero cost and a zero
    // tax rate.
    .bind(product.department.map(|id| id.as_str()))
    .bind(product.default_cost.map(|amount| amount.as_minor()))
    .bind(product.vat_rate_bp)
    .bind(product.status.as_str())
    .bind(product.created_by.as_str())
    .bind(product.updated_by.as_str())
    .bind(product.created_at)
    .bind(product.updated_at)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn find_by_id(
    conn: &mut SqliteConnection,
    id: ProductId,
) -> Result<Option<Product>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, name, disposition, barcode, sale_price_minor,
                department_id, default_cost_minor, vat_rate_bp, status,
                created_by, updated_by, created_at, updated_at
         FROM products WHERE id = ?1",
    )
        .bind(id.as_str())
        .fetch_optional(&mut *conn)
        .await?;

    match row {
        Some(row) => row_to_product(row).map(Some),
        None => Ok(None),
    }
}

/// Look up by barcode, case-insensitively.
///
/// `LOWER()` on both sides rather than a `COLLATE NOCASE` column, so the
/// comparison rule is visible where it is used. An exact match is preferred
/// when one exists, so a product stored as `ABC123` wins over another stored as
/// `abc123` if both ever existed.
pub async fn find_by_barcode(
    conn: &mut SqliteConnection,
    barcode: &Barcode,
) -> Result<Option<Product>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, name, disposition, barcode, sale_price_minor,
                department_id, default_cost_minor, vat_rate_bp, status,
                created_by, updated_by, created_at, updated_at
         FROM products
         WHERE LOWER(barcode) = ?1
         ORDER BY barcode = ?2 DESC
         LIMIT 1",
    )
    .bind(barcode.lookup_key())
    .bind(barcode.as_str())
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(row) => row_to_product(row).map(Some),
        None => Ok(None),
    }
}

pub async fn list(
    conn: &mut SqliteConnection,
    status: ProductStatus,
) -> Result<Vec<Product>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, name, disposition, barcode, sale_price_minor,
                department_id, default_cost_minor, vat_rate_bp, status,
                created_by, updated_by, created_at, updated_at
         FROM products
         WHERE status = ?1
         ORDER BY name COLLATE NOCASE ASC",
    )
    .bind(status.as_str())
    .fetch_all(&mut *conn)
    .await?;

    let mut products = Vec::with_capacity(rows.len());
    for row in rows {
        products.push(row_to_product(row)?);
    }
    Ok(products)
}

/// Persist an edited product.
///
/// The archived-state refusal lives in the domain (`Product::update`), not here:
/// a second copy of the rule in SQL would be a second thing to keep in step.
pub async fn update(
    conn: &mut SqliteConnection,
    product: &Product,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE products
         SET name = ?2, disposition = ?3, barcode = ?4, sale_price_minor = ?5,
             department_id = ?6, default_cost_minor = ?7, vat_rate_bp = ?8,
             status = ?9, updated_by = ?10, updated_at = ?11
         WHERE id = ?1",
    )
    .bind(product.id.as_str())
    .bind(product.name.as_str())
    .bind(product.disposition.as_str())
    .bind(product.barcode.as_ref().map(|b| b.as_str().to_string()))
    .bind(product.sale_price.map(|p| p.as_minor()))
    .bind(product.department.map(|id| id.as_str()))
    .bind(product.default_cost.map(|amount| amount.as_minor()))
    .bind(product.vat_rate_bp)
    .bind(product.status.as_str())
    .bind(product.updated_by.as_str())
    .bind(product.updated_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Record one price transition, inside the caller's transaction.
///
/// Called only when the price actually moved; the schema's
/// `CHECK (old_price_minor IS NOT new_price_minor)` is the backstop that
/// refuses an unchanged pair even if a future caller forgets that test.
/// NULL is preserved rather than collapsed: a product can go from unset to
/// priced and back, and history that cannot record "unset" lies about it
/// (`plan` Task 1, migration `0006`).
pub async fn insert_price_history(
    conn: &mut SqliteConnection,
    product_id: ProductId,
    old_price_minor: Option<i64>,
    new_price_minor: Option<i64>,
    actor_id: UserId,
    occurred_at: Timestamp,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO product_price_history
             (id, product_id, old_price_minor, new_price_minor, actor_id, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(Uuid::now_v7().to_string())
    .bind(product_id.as_str())
    .bind(old_price_minor)
    .bind(new_price_minor)
    .bind(actor_id.as_str())
    .bind(occurred_at.as_millis())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

fn row_to_product(row: sqlx::sqlite::SqliteRow) -> Result<Product, sqlx::Error> {
    let raw_id: String = row.get("id");
    let name: String = row.get("name");
    let disposition_raw: String = row.get("disposition");
    let barcode: Option<String> = row.get("barcode");
    // `Option<i64>` on a NULL column yields None, which is exactly the
    // "price not set" state. A stored 0 yields Some(0).
    let price: Option<i64> = row.get("sale_price_minor");
    let department: Option<String> = row.get("department_id");
    let default_cost: Option<i64> = row.get("default_cost_minor");
    let vat_rate_bp: Option<i64> = row.get("vat_rate_bp");
    let status_raw: String = row.get("status");
    let created_by: String = row.get("created_by");
    let updated_by: String = row.get("updated_by");
    let created_at: i64 = row.get("created_at");
    let updated_at: i64 = row.get("updated_at");

    // A corrupt row is an error rather than a default. Defaulting an unknown
    // role to the lesser one, or an unparseable price to zero, would quietly
    // invent data.
    let disposition = Disposition::parse(&disposition_raw).ok_or_else(|| {
        sqlx::Error::Protocol(format!("unknown disposition in products: {disposition_raw}"))
    })?;
    let status = ProductStatus::parse(&status_raw)
        .ok_or_else(|| sqlx::Error::Protocol(format!("unknown status in products: {status_raw}")))?;

    let parse_uuid = |raw: String, what: &str| -> Result<Uuid, sqlx::Error> {
        raw.parse()
            .map_err(|_| sqlx::Error::Protocol(format!("malformed {what} in products")))
    };

    Ok(Product {
        id: ProductId::from_uuid(parse_uuid(raw_id, "product id")?),
        name: ProductName::new(&name)
            .map_err(|_| sqlx::Error::Protocol("empty product name in database".into()))?,
        disposition,
        barcode: match barcode {
            Some(raw) => Some(
                Barcode::new(&raw)
                    .map_err(|_| sqlx::Error::Protocol("empty barcode in database".into()))?,
            ),
            None => None,
        },
        sale_price: match price {
            Some(value) => Some(
                SalePrice::new_minor(value)
                    .map_err(|_| sqlx::Error::Protocol("negative price in database".into()))?,
            ),
            None => None,
        },
        department: match department {
            Some(raw) => Some(DepartmentId::from_uuid(parse_uuid(
                raw,
                "department_id",
            )?)),
            None => None,
        },
        default_cost: match default_cost {
            Some(value) => Some(Piastres::new_minor(value).map_err(|_| {
                sqlx::Error::Protocol("negative default_cost_minor in database".into())
            })?),
            None => None,
        },
        // A raw `i64`, not a rate type. The catalogue stores the number; what a
        // basis-point value means is the VAT slice's business. A negative value
        // would already have been refused by the schema CHECK.
        vat_rate_bp,
        status,
        created_by: UserId::from_uuid(parse_uuid(created_by, "created_by")?),
        updated_by: UserId::from_uuid(parse_uuid(updated_by, "updated_by")?),
        created_at,
        updated_at,
    })
}

use uuid::Uuid;
