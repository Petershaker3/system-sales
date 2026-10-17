//! Product images (`product_images`, ADR-018 §5, plan item 1.2 step 5).
//!
//! Proves against real SQLite and real files on disk that:
//! - the owner stores, replaces, and removes a product's 192×192 JPEG thumbnail,
//!   recording `product_image_set` and `product_image_removed` in `audit_events`
//!   while storing only the external file path and metadata in `product_images`;
//! - a seller may read product images (`list_images`) and is refused on setting,
//!   removing, or toggling `"ui.images"`;
//! - non-JPEG bytes, dimensions other than 192×192, and unknown products are
//!   refused with nothing written to disk or SQLite;
//! - a product's image row and its external JPEG file under `images/` are packed
//!   into the encrypted backup and restored intact after a wipe («الصورة تُستعاد
//!   من النسخة»).

use std::fs;
use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::catalog::{
    encode_jpeg_data_url, Disposition, ProductId, IMAGE_SIDE,
};
use mobile_shop_system_lib::domain::identity::Role;
use mobile_shop_system_lib::services::backup;
use mobile_shop_system_lib::services::catalog::images;
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, users};
use mobile_shop_system_lib::services::settings::appearance;
use sqlx::SqlitePool;
use tempfile::TempDir;

const BACKUP_PASSWORD: &str = "backup pass phrase";

fn sample_jpeg_data_url(w: u16, h: u16, extra_bytes: usize) -> String {
    let mut out = vec![0xFF, 0xD8];
    let app_len = u16::try_from(2 + extra_bytes).expect("app len");
    out.extend_from_slice(&[0xFF, 0xE0]);
    out.extend_from_slice(&app_len.to_be_bytes());
    out.extend(std::iter::repeat_n(0x5A, extra_bytes));
    out.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x0B, 0x08]);
    out.extend_from_slice(&h.to_be_bytes());
    out.extend_from_slice(&w.to_be_bytes());
    out.extend_from_slice(&[0x01, 0x01, 0x11, 0x00]);
    out.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x7F]);
    out.extend_from_slice(&[0xFF, 0xD9]);
    encode_jpeg_data_url(&out)
}

async fn signed_in_shop(dir: &std::path::Path) -> (SqlitePool, Arc<InMemoryTokenStore>, ProductId) {
    let pool = db::open(&dir.join("shop.db")).await.expect("open db");
    let tokens = Arc::new(InMemoryTokenStore::new());
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    let ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let current = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("session");
    let product = catalog::create(
        &ctx,
        &current,
        NewProduct {
            name: "شاحن أنكر 20W".to_string(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: Some(35000),
            category: None,
        },
    )
    .await
    .expect("create product");

    (pool, tokens, product.id)
}

#[tokio::test]
async fn the_owner_sets_replaces_and_removes_a_product_image_on_disk_and_in_sqlite() {
    let dir = TempDir::new().expect("tempdir");
    let (pool, tokens, product_id) = signed_in_shop(dir.path()).await;

    let first_url = sample_jpeg_data_url(IMAGE_SIDE, IMAGE_SIDE, 24);
    let saved = images::set_image(&pool, tokens.as_ref(), dir.path(), product_id, &first_url)
        .await
        .expect("set image");
    assert_eq!(saved.image.product_id, product_id);
    assert_eq!(saved.image.file, format!("images/{product_id}.jpg"));
    assert_eq!((saved.image.w, saved.image.h), (192, 192));
    assert_eq!(saved.data_url, first_url);
    assert!(
        dir.path().join(&saved.image.file).exists(),
        "external JPEG file must exist under images/"
    );

    // Replace the image for the same product.
    let second_url = sample_jpeg_data_url(IMAGE_SIDE, IMAGE_SIDE, 64);
    let replaced = images::set_image(&pool, tokens.as_ref(), dir.path(), product_id, &second_url)
        .await
        .expect("replace image");
    assert!(replaced.image.bytes > saved.image.bytes);
    assert_eq!(replaced.data_url, second_url);

    let listed = images::list_images(&pool, tokens.as_ref(), dir.path())
        .await
        .expect("list images");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].data_url, second_url);

    // Remove the image and verify both row and file are gone.
    images::remove_image(&pool, tokens.as_ref(), dir.path(), product_id)
        .await
        .expect("remove image");
    assert!(
        !dir.path().join(&saved.image.file).exists(),
        "removing the image deletes the file under images/"
    );
    assert!(
        images::list_images(&pool, tokens.as_ref(), dir.path())
            .await
            .expect("list after remove")
            .is_empty()
    );

    let remove_again =
        images::remove_image(&pool, tokens.as_ref(), dir.path(), product_id).await;
    assert_eq!(remove_again.err().map(|e| e.code()), Some("IMAGE_NOT_FOUND"));

    let set_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = 'product_image_set'",
    )
    .fetch_one(&pool)
    .await
    .expect("set events");
    let removed_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = 'product_image_removed'",
    )
    .fetch_one(&pool)
    .await
    .expect("removed events");
    assert_eq!(set_events, 2);
    assert_eq!(removed_events, 1);
}

#[tokio::test]
async fn a_seller_may_read_product_images_and_not_set_remove_or_toggle_them() {
    let dir = TempDir::new().expect("tempdir");
    let (pool, tokens, product_id) = signed_in_shop(dir.path()).await;

    let url = sample_jpeg_data_url(IMAGE_SIDE, IMAGE_SIDE, 16);
    images::set_image(&pool, tokens.as_ref(), dir.path(), product_id, &url)
        .await
        .expect("owner sets image");

    // Owner toggles `ui.images` without needing a fresh password, under ManageCatalog.
    let off = appearance::update(&pool, tokens.as_ref(), "ui.images", "off")
        .await
        .expect("owner hides images");
    assert_eq!(off.images, "off");
    let on = appearance::update(&pool, tokens.as_ref(), "ui.images", "on")
        .await
        .expect("owner shows images");
    assert_eq!(on.images, "on");

    // Create and sign in as a seller.
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    let manager = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("manager");
    let seller = users::create_user(&pool, &manager, "Youssef", "youssef", Role::Sales, PASSWORD)
        .await
        .expect("create seller");
    auth::login(&pool, tokens.as_ref(), seller, PASSWORD)
        .await
        .expect("login seller");

    let readable = images::list_images(&pool, tokens.as_ref(), dir.path())
        .await
        .expect("seller reads images");
    assert_eq!(readable.len(), 1);

    let set_refused =
        images::set_image(&pool, tokens.as_ref(), dir.path(), product_id, &url).await;
    assert_eq!(set_refused.err().map(|e| e.code()), Some("PERMISSION_DENIED"));

    let remove_refused =
        images::remove_image(&pool, tokens.as_ref(), dir.path(), product_id).await;
    assert_eq!(
        remove_refused.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );

    let toggle_refused = appearance::update(&pool, tokens.as_ref(), "ui.images", "off").await;
    assert_eq!(
        toggle_refused.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );
}

#[tokio::test]
async fn non_192_or_non_jpeg_or_unknown_product_is_refused_with_nothing_written() {
    let dir = TempDir::new().expect("tempdir");
    let (pool, tokens, product_id) = signed_in_shop(dir.path()).await;

    let wrong_dim = sample_jpeg_data_url(128, 128, 8);
    assert_eq!(
        images::set_image(&pool, tokens.as_ref(), dir.path(), product_id, &wrong_dim)
            .await
            .err()
            .map(|e| e.code()),
        Some("IMAGE_DIMENSIONS_INVALID")
    );

    assert_eq!(
        images::set_image(
            &pool,
            tokens.as_ref(),
            dir.path(),
            product_id,
            "data:image/png;base64,AAAA"
        )
        .await
        .err()
        .map(|e| e.code()),
        Some("IMAGE_NOT_JPEG")
    );

    let valid = sample_jpeg_data_url(IMAGE_SIDE, IMAGE_SIDE, 8);
    assert_eq!(
        images::set_image(
            &pool,
            tokens.as_ref(),
            dir.path(),
            ProductId::generate(),
            &valid
        )
        .await
        .err()
        .map(|e| e.code()),
        Some("PRODUCT_NOT_FOUND")
    );

    let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM product_images")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(row_count, 0);
}

#[tokio::test]
async fn product_image_is_packed_into_the_encrypted_backup_and_restored_after_wipe() {
    let dir = TempDir::new().expect("tempdir");
    let (pool, tokens, product_id) = signed_in_shop(dir.path()).await;

    let url = sample_jpeg_data_url(IMAGE_SIDE, IMAGE_SIDE, 32);
    let saved = images::set_image(&pool, tokens.as_ref(), dir.path(), product_id, &url)
        .await
        .expect("set image");

    let backup_path = dir.path().join("with_image.msb");
    let report = backup::create_backup(&pool, dir.path(), &backup_path, BACKUP_PASSWORD)
        .await
        .expect("create backup");
    assert_eq!(
        report.image_count, 1,
        "backup must include the product JPEG under images/"
    );

    // Remove the image after the backup, then close the pool and restore.
    images::remove_image(&pool, tokens.as_ref(), dir.path(), product_id)
        .await
        .expect("remove image after backup");
    assert!(!dir.path().join(&saved.image.file).exists());
    pool.close().await;

    let restored =
        backup::restore_backup(dir.path(), &backup_path, BACKUP_PASSWORD).expect("restore backup");
    assert_eq!(restored.image_count, 1);
    assert!(
        dir.path().join(&saved.image.file).exists(),
        "the external 192x192 JPEG file must be restored under images/"
    );
    assert_eq!(
        fs::metadata(dir.path().join(&saved.image.file))
            .expect("restored file metadata")
            .len() as usize,
        saved.image.bytes
    );

    // Reopen the restored database and confirm `list_images` returns the restored image.
    let reopened = db::open(&dir.path().join("shop.db"))
        .await
        .expect("reopen restored db");
    let listed = images::list_images(&reopened, tokens.as_ref(), dir.path())
        .await
        .expect("list images after restore");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].image, saved.image);
    assert_eq!(listed[0].data_url, url);
}

