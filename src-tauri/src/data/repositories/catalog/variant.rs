//! Product variants persistence (ADR-018 §4, plan item 1.2 step 4).
//!
//! Stores the parent (`product_parents`) and writes each combination's
//! details (`parent_id`, `variant_1`, `variant_2`, `variant_order`) onto its
//! row in `products`.

use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

use crate::domain::catalog::{
    ProductId, ProductName, ProductVariant, VariantDimension, VariantParent, VariantParentId,
};
use crate::domain::identity::UserId;
use crate::domain::organisation::DepartmentId;

pub async fn insert_parent(
    conn: &mut SqliteConnection,
    parent: &VariantParent,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO product_parents
           (id, name, department_id, dimension_1, dimension_2, created_by, updated_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(parent.id.as_str())
    .bind(parent.name.as_str())
    .bind(parent.category.as_str())
    .bind(parent.dimension_1.as_str())
    .bind(parent.dimension_2.map(VariantDimension::as_str))
    .bind(parent.created_by.as_str())
    .bind(parent.updated_by.as_str())
    .bind(parent.created_at)
    .bind(parent.updated_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn find_parent_by_id(
    conn: &mut SqliteConnection,
    id: VariantParentId,
) -> Result<Option<VariantParent>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, name, department_id, dimension_1, dimension_2, created_by, updated_by,
                created_at, updated_at
         FROM product_parents WHERE id = ?1",
    )
    .bind(id.as_str())
    .fetch_optional(&mut *conn)
    .await?;
    row.map(row_to_parent).transpose()
}

/// Whether a variant parent in `category` already has `name`, compared the way
/// the unique index compares (`COLLATE NOCASE`).
pub async fn parent_name_taken(
    conn: &mut SqliteConnection,
    category: DepartmentId,
    name: &str,
) -> Result<bool, sqlx::Error> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM product_parents
          WHERE department_id = ?1 AND name = ?2 COLLATE NOCASE
          LIMIT 1",
    )
    .bind(category.as_str())
    .bind(name)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// Write a variant's parent, values and order onto its product row. The
/// triggers of `0018` refuse half a variant whatever this function is given.
pub async fn set_variant_details(
    conn: &mut SqliteConnection,
    product: ProductId,
    details: &ProductVariant,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE products
         SET parent_id = ?2, variant_1 = ?3, variant_2 = ?4, variant_order = ?5
         WHERE id = ?1",
    )
    .bind(product.as_str())
    .bind(details.parent_id.as_str())
    .bind(details.value_1.as_str())
    .bind(details.value_2.as_ref().map(|v| v.as_str()))
    .bind(details.order)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

fn row_to_parent(row: sqlx::sqlite::SqliteRow) -> Result<VariantParent, sqlx::Error> {
    let raw_id: String = row.get("id");
    let name: String = row.get("name");
    let department_id: String = row.get("department_id");
    let dim_1_raw: String = row.get("dimension_1");
    let dim_2_raw: Option<String> = row.get("dimension_2");
    let created_by: String = row.get("created_by");
    let updated_by: String = row.get("updated_by");

    let parse_uuid = |raw: String, what: &str| -> Result<Uuid, sqlx::Error> {
        raw.parse().map_err(|_| {
            sqlx::Error::Protocol(format!("malformed {what} in product_parents"))
        })
    };
    let dimension_1 = VariantDimension::parse(&dim_1_raw).ok_or_else(|| {
        sqlx::Error::Protocol(format!("unknown dimension_1 in product_parents: {dim_1_raw}"))
    })?;
    let dimension_2 = match dim_2_raw {
        None => None,
        Some(raw) => Some(VariantDimension::parse(&raw).ok_or_else(|| {
            sqlx::Error::Protocol(format!("unknown dimension_2 in product_parents: {raw}"))
        })?),
    };

    Ok(VariantParent {
        id: VariantParentId::from_uuid(parse_uuid(raw_id, "id")?),
        name: ProductName::new(&name)
            .map_err(|e| sqlx::Error::Protocol(format!("invalid parent name: {}", e.code())))?,
        category: DepartmentId::from_uuid(parse_uuid(department_id, "department_id")?),
        dimension_1,
        dimension_2,
        created_by: UserId::from_uuid(parse_uuid(created_by, "created_by")?),
        updated_by: UserId::from_uuid(parse_uuid(updated_by, "updated_by")?),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}
