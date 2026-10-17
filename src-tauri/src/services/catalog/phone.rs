//! Registering a new phone (ADR-018 §2; «موبايل جديد» in the mockup): its
//! company, model, touch or keypad, storage and RAM, its category and its sale
//! price. The name is built from them — «Samsung Galaxy A16 128GB», «iPhone 16
//! 128GB» — and the same phone twice is refused.
//!
//! The product is counted by quantity: the IMEI is optional (PLAN §7), and the
//! units table that records one device at a time comes with plan item 1.4. Its
//! stock and cost come from receiving, as for any product.

use sqlx::SqlitePool;

use crate::data::repositories::catalog::brand as brand_repo;
use crate::data::repositories::catalog::product as product_repo;
use crate::data::repositories::organisation::department as category_repo;
use crate::domain::catalog::{
    brand_lines, phone_title, BrandError, BrandId, CatalogError, DeviceType, Disposition,
    PhoneDetails, Product, ProductId, ProductName, ProductStatus, SalePrice,
};
use crate::domain::identity::Timestamp;
use crate::domain::organisation::{CategoryKind, DepartmentId};
use crate::services::catalog::brands::{authorize, storage, BrandServiceError};
use crate::services::identity::secure_store::SecureTokenStore;

/// A new phone, as «موبايل جديد» sends it.
#[derive(Debug, Clone)]
pub struct NewPhone {
    /// A category registered «جهاز جهاز بالـ IMEI» (or one under such a main).
    pub category: DepartmentId,
    pub brand: BrandId,
    pub model: String,
    pub device_type: DeviceType,
    pub storage_gb: Option<i64>,
    pub ram_gb: Option<i64>,
    /// `None` leaves the price unset, as for any product.
    pub sale_price_minor: Option<i64>,
}

/// The registered phone: the product, and what it was built from.
#[derive(Debug, Clone)]
pub struct RegisteredPhone {
    pub product: Product,
    pub details: PhoneDetails,
}

/// Register a phone in one transaction: the product row and its details, or
/// neither.
pub async fn create_phone(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: NewPhone,
) -> Result<RegisteredPhone, BrandServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now().as_millis();
    let actor = session.user_id();
    let sale_price = match input.sale_price_minor {
        Some(minor) => Some(SalePrice::new_minor(minor)?),
        None => None,
    };

    let mut tx = pool.begin().await.map_err(storage)?;

    let category = category_repo::find_by_id(&mut tx, input.category)
        .await
        .map_err(storage)?
        .filter(|category| category.is_editable())
        .ok_or(CatalogError::CategoryNotFound)?;
    if category.kind != CategoryKind::Phone {
        return Err(BrandError::CategoryNotPhone.into());
    }

    let brand = brand_repo::find_by_id(&mut tx, input.brand)
        .await
        .map_err(storage)?
        .ok_or(BrandError::NotFound)?;
    if !brand.device_type.allows(input.device_type) {
        return Err(BrandError::TypeMismatch.into());
    }

    let details = PhoneDetails::new(
        brand.id,
        &input.model,
        input.device_type,
        input.storage_gb,
        input.ram_gb,
    )?;
    if brand_repo::find_phone(&mut tx, &details)
        .await
        .map_err(storage)?
        .is_some()
    {
        return Err(BrandError::AlreadyRegistered.into());
    }

    let title = phone_title(
        brand.name.as_str(),
        brand_lines(brand.id),
        &details.model,
        details.storage_gb,
    );
    let product = Product {
        id: ProductId::generate(),
        name: ProductName::new(&title)?,
        disposition: Disposition::Quantity,
        barcode: None,
        sale_price,
        department: Some(category.id),
        default_cost: None,
        vat_rate_bp: None,
        status: ProductStatus::Active,
        created_by: actor,
        updated_by: actor,
        created_at: now,
        updated_at: now,
    };
    product_repo::insert(&mut tx, &product)
        .await
        .map_err(storage)?;
    brand_repo::set_phone_details(&mut tx, product.id, &details)
        .await
        .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(RegisteredPhone { product, details })
}
