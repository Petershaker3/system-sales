//! Product image use cases («صور الأصناف», ADR-018 §5, plan item 1.2 step 5).
//!
//! Stores a product's 192×192 JPEG thumbnail as a file under
//! `<data_dir>/images/<product_id>.jpg` and records only its path, dimensions,
//! and byte length in `product_images` (`0019_product_images.sql`, XC-10).
//! Because the file lives inside `<data_dir>/images/`, the encrypted backup
//! engine (`services/backup`) packs and restores it automatically alongside
//! `shop.db`.

use std::fmt;
use std::fs;
use std::io::Write;
use std::path::Path;

use sqlx::SqlitePool;

use crate::data::repositories::catalog::{image as image_repo, product as product_repo};
use crate::data::repositories::identity::audit;
use crate::domain::catalog::{
    encode_jpeg_data_url, CatalogError, ImageError, ProductId, ProductImage,
};
use crate::domain::identity::{DomainError, Permission, Session, Timestamp};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// A product's stored image metadata paired with its `data:image/jpeg;base64,...`
/// representation for the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductImageEntry {
    pub image: ProductImage,
    pub data_url: String,
}

/// Errors produced when reading, setting, or removing a product image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageServiceError {
    Identity(DomainError),
    Catalog(CatalogError),
    Image(ImageError),
}

impl ImageServiceError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Identity(e) => e.code(),
            Self::Catalog(e) => e.code(),
            Self::Image(e) => e.code(),
        }
    }
}


impl fmt::Display for ImageServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for ImageServiceError {}

impl From<DomainError> for ImageServiceError {
    fn from(value: DomainError) -> Self {
        Self::Identity(value)
    }
}

impl From<CatalogError> for ImageServiceError {
    fn from(value: CatalogError) -> Self {
        Self::Catalog(value)
    }
}

impl From<ImageError> for ImageServiceError {
    fn from(value: ImageError) -> Self {
        Self::Image(value)
    }
}

async fn authorize_manage(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Session, ImageServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    Ok(session)
}

async fn authorize_sell(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Session, ImageServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    Ok(session)
}

/// Store or replace a product's 192×192 JPEG thumbnail on disk and in
/// `product_images`, recording `product_image_set` in the audit log.
pub async fn set_image(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    data_dir: &Path,
    product_id: ProductId,
    data_url: &str,
) -> Result<ProductImageEntry, ImageServiceError> {
    let session = authorize_manage(pool, tokens).await?;
    let (image, raw_bytes) = ProductImage::from_data_url(product_id, data_url)?;

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let _product = product_repo::find_by_id(&mut tx, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(CatalogError::NoProductWithThisId)?;


    write_image_file_atomically(data_dir, &image.file, &raw_bytes)
        .map_err(|_| DomainError::StorageUnavailable)?;

    image_repo::upsert(&mut tx, &image)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let now = Timestamp::now();
    let detail = serde_json::json!({
        "product_id": product_id.as_str(),
        "file": &image.file,
        "w": image.w,
        "h": image.h,
        "bytes": image.bytes,
    })
    .to_string();
    audit::append(
        &mut tx,
        session.user_id(),
        audit::event::PRODUCT_IMAGE_SET,
        now,
        Some(detail),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(ProductImageEntry {
        data_url: encode_jpeg_data_url(&raw_bytes),
        image,
    })
}

/// Remove a product's stored image row and external JPEG file, recording
/// `product_image_removed` in the audit log.
pub async fn remove_image(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    data_dir: &Path,
    product_id: ProductId,
) -> Result<(), ImageServiceError> {
    let session = authorize_manage(pool, tokens).await?;

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let existing = image_repo::find_by_product(&mut tx, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(ImageError::NotFound)?;

    image_repo::delete(&mut tx, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let now = Timestamp::now();
    let detail = serde_json::json!({
        "product_id": product_id.as_str(),
        "file": &existing.file,
    })
    .to_string();
    audit::append(
        &mut tx,
        session.user_id(),
        audit::event::PRODUCT_IMAGE_REMOVED,
        now,
        Some(detail),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let file_path = data_dir.join(&existing.file);
    match fs::remove_file(&file_path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(DomainError::StorageUnavailable.into()),
    }

    Ok(())
}

/// List all stored product images whose external JPEG file is readable under
/// `<data_dir>/images/`.
pub async fn list_images(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    data_dir: &Path,
) -> Result<Vec<ProductImageEntry>, ImageServiceError> {
    let _session = authorize_sell(pool, tokens).await?;
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let rows = image_repo::list_all(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let mut entries = Vec::with_capacity(rows.len());
    for image in rows {
        let full_path = data_dir.join(&image.file);
        if let Ok(bytes) = fs::read(&full_path) {
            if ProductImage::from_jpeg_bytes(image.product_id, &bytes).is_ok() {
                entries.push(ProductImageEntry {
                    data_url: encode_jpeg_data_url(&bytes),
                    image,
                });
            }
        }
    }

    Ok(entries)
}

fn write_image_file_atomically(
    data_dir: &Path,
    relative_file: &str,
    bytes: &[u8],
) -> std::io::Result<()> {
    let target = data_dir.join(relative_file);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let partial = target.with_extension("jpg.partial");
    {
        let mut f = fs::File::create(&partial)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&partial, &target)?;
    Ok(())
}
