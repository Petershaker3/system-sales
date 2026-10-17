//! Registering a counted item with variants («الصنف ده ليه تفرعات», ADR-018 §4,
//! plan item 1.2 step 4).
//!
//! Creates the parent (`product_parents`), every combination's product row
//! (`products`) with its variant details (`parent_id`, `variant_1`,
//! `variant_2`, `variant_order`), and an audit event (`variants_created`) in
//! one transaction: all combinations commit together or none at all.

use sqlx::SqlitePool;

use crate::data::repositories::catalog::product as product_repo;
use crate::data::repositories::catalog::variant as variant_repo;
use crate::data::repositories::identity::audit;
use crate::data::repositories::organisation::department as category_repo;
use crate::domain::catalog::{
    variant_combos, variant_title, Barcode, CatalogError, Disposition, Product, ProductId,
    ProductName, ProductStatus, ProductVariant, SalePrice, VariantDimension, VariantError,
    VariantParent,
};
use crate::domain::identity::{DomainError, Permission, Session, Timestamp};
use crate::domain::organisation::{CategoryKind, DepartmentId};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;


/// Per-row override for one variant combination in `variant_combos` order.
#[derive(Debug, Clone, Default)]
pub struct NewVariantRow {
    pub barcode: Option<String>,
    /// When `None`, the parent's `sale_price_minor` is used («السعر الفاضي = اللي فوق»).
    pub sale_price_minor: Option<i64>,
}

/// What «صنف جديد» sends when «الصنف ده ليه تفرعات» is switched on.
#[derive(Debug, Clone)]
pub struct NewVariants {
    pub category: DepartmentId,
    pub name: String,
    pub dimension_1: String,
    pub values_1: Vec<String>,
    pub dimension_2: Option<String>,
    pub values_2: Vec<String>,
    pub sale_price_minor: i64,
    /// Optional per-combination overrides in `variant_combos` order; when
    /// empty, every combination uses no barcode and `sale_price_minor`.
    pub rows: Vec<NewVariantRow>,
}

/// What `create_variants` returns: the parent and each registered variant.
#[derive(Debug, Clone)]
pub struct RegisteredVariants {
    pub parent: VariantParent,
    pub variants: Vec<(Product, ProductVariant)>,
}

/// Every failure the variant use case can report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VariantServiceError {
    Identity(DomainError),
    Catalog(CatalogError),
    Variant(VariantError),
}

impl VariantServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            VariantServiceError::Identity(error) => error.code(),
            VariantServiceError::Catalog(error) => error.code(),
            VariantServiceError::Variant(error) => error.code(),
        }
    }
}

impl From<DomainError> for VariantServiceError {
    fn from(error: DomainError) -> Self {
        Self::Identity(error)
    }
}

impl From<CatalogError> for VariantServiceError {
    fn from(error: CatalogError) -> Self {
        Self::Catalog(error)
    }
}

impl From<VariantError> for VariantServiceError {
    fn from(error: VariantError) -> Self {
        Self::Variant(error)
    }
}

fn storage(_: sqlx::Error) -> VariantServiceError {
    VariantServiceError::Identity(DomainError::StorageUnavailable)
}

async fn authorize(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Session, VariantServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    Ok(session)
}

fn require_positive_price(minor: i64) -> Result<SalePrice, VariantServiceError> {

    let price = SalePrice::new_minor(minor)?;
    if price.as_minor() == 0 {
        return Err(VariantError::PriceRequired.into());
    }
    Ok(price)
}

fn is_unique_violation(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("unique constraint failed") || lower.contains("2067")
}

/// Register a variant parent and all of its combination products in one
/// transaction.
pub async fn create_variants(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: NewVariants,
) -> Result<RegisteredVariants, VariantServiceError> {
    let session = authorize(pool, tokens).await?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let clean_base = input
        .name
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let base_name = ProductName::new(&clean_base)?;

    let dim_1 =
        VariantDimension::parse(&input.dimension_1).ok_or(VariantError::DimensionUnknown)?;
    let combos = variant_combos(&input.values_1, &input.values_2)?;
    let dim_2 = if input.values_2.is_empty() {
        None
    } else {
        let raw = input
            .dimension_2
            .as_deref()
            .ok_or(VariantError::DimensionUnknown)?;
        Some(VariantDimension::parse(raw).ok_or(VariantError::DimensionUnknown)?)
    };

    let default_price = require_positive_price(input.sale_price_minor)?;

    if !input.rows.is_empty() && input.rows.len() != combos.len() {
        return Err(VariantError::RowMismatch.into());
    }

    let mut resolved_rows: Vec<(Option<Barcode>, SalePrice)> = Vec::with_capacity(combos.len());
    for index in 0..combos.len() {
        let row = input.rows.get(index);
        let barcode = match row.and_then(|r| r.barcode.as_deref()) {
            Some(raw) if !raw.trim().is_empty() => Some(Barcode::new(raw)?),
            _ => None,
        };
        if let Some(ref b) = barcode {
            let key = b.lookup_key();
            if resolved_rows
                .iter()
                .filter_map(|(existing, _)| existing.as_ref())
                .any(|existing| existing.lookup_key() == key)
            {
                return Err(VariantError::DuplicateBarcodeInBatch.into());
            }
        }
        let price = match row.and_then(|r| r.sale_price_minor) {
            Some(minor) => require_positive_price(minor)?,
            None => default_price,
        };
        resolved_rows.push((barcode, price));
    }

    let mut tx = pool.begin().await.map_err(storage)?;

    let category = category_repo::find_by_id(&mut tx, input.category)
        .await
        .map_err(storage)?
        .filter(|category| category.is_editable())
        .ok_or(CatalogError::CategoryNotFound)?;
    if category.kind != CategoryKind::Item {
        return Err(VariantError::CategoryNotItem.into());
    }

    if variant_repo::parent_name_taken(&mut tx, category.id, base_name.as_str())
        .await
        .map_err(storage)?
    {
        return Err(VariantError::ParentAlreadyExists.into());
    }

    for (barcode, _) in &resolved_rows {
        if let Some(ref b) = barcode {
            if product_repo::find_by_barcode(&mut tx, b)
                .await
                .map_err(storage)?
                .is_some()
            {
                return Err(CatalogError::BarcodeAlreadyExists.into());
            }
        }
    }

    let parent = VariantParent::new(base_name, category.id, dim_1, dim_2, actor, now.as_millis());
    variant_repo::insert_parent(&mut tx, &parent)
        .await
        .map_err(|error| match error {
            sqlx::Error::Database(ref db) if is_unique_violation(&db.to_string()) => {
                VariantServiceError::Variant(VariantError::ParentAlreadyExists)
            }
            other => storage(other),
        })?;


    let mut variants = Vec::with_capacity(combos.len());
    for (order, ((value_1, value_2), (barcode, sale_price))) in
        combos.into_iter().zip(resolved_rows).enumerate()
    {
        let title = variant_title(parent.name.as_str(), &value_1, value_2.as_ref());
        let product = Product {
            id: ProductId::generate(),
            name: ProductName::new(&title)?,
            disposition: Disposition::Quantity,
            barcode,
            sale_price: Some(sale_price),
            department: Some(category.id),
            default_cost: None,
            vat_rate_bp: None,
            status: ProductStatus::Active,
            created_by: actor,
            updated_by: actor,
            created_at: now.as_millis(),
            updated_at: now.as_millis(),
        };
        product_repo::insert(&mut tx, &product)
            .await
            .map_err(|error| match error {
                sqlx::Error::Database(ref db) if is_unique_violation(&db.to_string()) => {
                    VariantServiceError::Catalog(CatalogError::BarcodeAlreadyExists)
                }
                other => storage(other),
            })?;

        let details = ProductVariant {
            parent_id: parent.id,
            value_1,
            value_2,
            order: order as i64,
        };
        variant_repo::set_variant_details(&mut tx, product.id, &details)
            .await
            .map_err(storage)?;
        variants.push((product, details));
    }

    let detail = serde_json::json!({
        "parent_id": parent.id.as_str(),
        "name": parent.name.as_str(),
        "category_id": category.id.as_str(),
        "dimension_1": parent.dimension_1.as_str(),
        "dimension_2": parent.dimension_2.map(VariantDimension::as_str),
        "variants": variants.len(),
    })
    .to_string();
    audit::append(&mut tx, actor, audit::event::VARIANTS_CREATED, now, Some(detail))
        .await
        .map_err(storage)?;

    tx.commit().await.map_err(storage)?;
    Ok(RegisteredVariants { parent, variants })
}
