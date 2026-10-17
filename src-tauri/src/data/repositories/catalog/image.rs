//! Product image persistence (`product_images`, ADR-018 §5).
//!
//! Stores only the relative file reference (`images/<product_id>.jpg`), width,
//! height, and byte length — never the JPEG bytes themselves (XC-10).

use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

use crate::domain::catalog::{ProductId, ProductImage};

/// Insert or replace the external image reference for a product.
pub async fn upsert(
    conn: &mut SqliteConnection,
    image: &ProductImage,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO product_images (product_id, file, w, h, bytes)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(product_id) DO UPDATE SET
             file  = excluded.file,
             w     = excluded.w,
             h     = excluded.h,
             bytes = excluded.bytes",
    )
    .bind(image.product_id.as_str())
    .bind(&image.file)
    .bind(i64::from(image.w))
    .bind(i64::from(image.h))
    .bind(i64::try_from(image.bytes).unwrap_or(i64::MAX))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Find the stored image metadata for one product, if any.
pub async fn find_by_product(
    conn: &mut SqliteConnection,
    product_id: ProductId,
) -> Result<Option<ProductImage>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT product_id, file, w, h, bytes
         FROM product_images
         WHERE product_id = ?1",
    )
    .bind(product_id.as_str())
    .fetch_optional(&mut *conn)
    .await?;

    row.map(decode_row).transpose()
}

/// List all stored product image metadata rows, ordered by `product_id`.
pub async fn list_all(conn: &mut SqliteConnection) -> Result<Vec<ProductImage>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT product_id, file, w, h, bytes
         FROM product_images
         ORDER BY product_id ASC",
    )
    .fetch_all(&mut *conn)
    .await?;

    rows.into_iter().map(decode_row).collect()
}

/// Remove the stored image reference for one product. Returns `true` when a
/// row existed.
pub async fn delete(
    conn: &mut SqliteConnection,
    product_id: ProductId,
) -> Result<bool, sqlx::Error> {
    let done = sqlx::query("DELETE FROM product_images WHERE product_id = ?1")
        .bind(product_id.as_str())
        .execute(&mut *conn)
        .await?;
    Ok(done.rows_affected() > 0)
}

fn decode_row(row: SqliteRow) -> Result<ProductImage, sqlx::Error> {
    let id_raw: String = row.try_get("product_id")?;
    let uuid = Uuid::parse_str(&id_raw)
        .map_err(|err| sqlx::Error::Protocol(format!("invalid product_id UUID `{id_raw}`: {err}")))?;
    let product_id = ProductId::from_uuid(uuid);
    let file: String = row.try_get("file")?;
    let w: i64 = row.try_get("w")?;
    let h: i64 = row.try_get("h")?;
    let bytes: i64 = row.try_get("bytes")?;

    ProductImage::from_row(product_id, file, w, h, bytes)
        .map_err(|err| sqlx::Error::Protocol(format!("invalid product_images row: {err}")))
}
