//! Tauri commands for the product catalogue.
//!
//! Transport boundaries only. No SQL and no business rule appears here.
//!
//! # No session parameter, on purpose
//!
//! No command accepts a token, a user id, a role, or a created_by value. Each
//! resolves the current operator from the OS credential store via
//! `require_session`, then authorises. That is what makes attribution a fact
//! rather than a claim, and it is enforced by an architecture test that already
//! covers every command module.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::domain::catalog::{
    CatalogError, Disposition, Product, ProductStatus, ProductVariant, VariantParent,
};
use crate::domain::identity::DomainError;
use crate::services::catalog::images::{
    self as image_use_cases, ImageServiceError, ProductImageEntry,
};
use crate::services::catalog::product::{self as use_cases, NewProduct, ProductPatch};
use crate::services::catalog::variants::{
    self as variant_use_cases, NewVariantRow, NewVariants, VariantServiceError,
};
use crate::services::catalog::{require_session, CatalogContext};



type Ctx<'a> = State<'a, CatalogContext>;

/// Every failure crossing the boundary is a stable code, never prose.
/// `spec:127` keeps user-facing text in Arabic message files on the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCommandError {
    pub code: &'static str,
}

impl From<CatalogError> for CatalogCommandError {
    fn from(error: CatalogError) -> Self {
        Self {
            code: error.code(),
        }
    }
}

impl From<VariantServiceError> for CatalogCommandError {
    fn from(error: VariantServiceError) -> Self {
        Self {
            code: error.code(),
        }
    }
}

impl From<ImageServiceError> for CatalogCommandError {
    fn from(error: ImageServiceError) -> Self {
        Self {
            code: error.code(),
        }
    }
}



/// A product as the frontend sees it.
///
/// `salePriceMinor` is nullable and **that nullability is meaningful**: null is
/// "not set", whereas 0 would be "free". The frontend must not collapse them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductDto {
    pub id: String,
    pub name: String,
    pub disposition: String,
    pub barcode: Option<String>,
    pub sale_price_minor: Option<i64>,
    /// The category it is in (ADR-018 §1), or `None` while unclassified.
    pub category_id: Option<String>,
    pub status: String,
    pub created_by: String,
    pub updated_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<&Product> for ProductDto {
    fn from(product: &Product) -> Self {
        Self {
            id: product.id.as_str(),
            name: product.name.as_str().to_string(),
            disposition: product.disposition.as_str().to_string(),
            barcode: product.barcode.as_ref().map(|b| b.as_str().to_string()),
            sale_price_minor: product.sale_price.map(|price| price.as_minor()),
            category_id: product.department.map(|id| id.as_str()),
            status: product.status.as_str().to_string(),
            created_by: product.created_by.as_str(),
            updated_by: product.updated_by.as_str(),
            created_at: product.created_at,
            updated_at: product.updated_at,
        }
    }
}

fn to_dto(product: &Product) -> ProductDto {
    ProductDto::from(product)
}

fn parse_id(raw: &str) -> Result<crate::domain::catalog::ProductId, CatalogCommandError> {
    uuid::Uuid::parse_str(raw)
        .map(crate::domain::catalog::ProductId::from_uuid)
        .map_err(|_| CatalogCommandError::from(CatalogError::NoProductWithThisId))
}

/// A category id from the screen; text that is not an id names no category.
fn parse_category(
    raw: Option<String>,
) -> Result<Option<crate::domain::organisation::DepartmentId>, CatalogCommandError> {
    match raw {
        Some(raw) => uuid::Uuid::parse_str(&raw)
            .map(|uuid| Some(crate::domain::organisation::DepartmentId::from_uuid(uuid)))
            .map_err(|_| CatalogCommandError::from(CatalogError::CategoryNotFound)),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn create_product(
    ctx: Ctx<'_>,
    name: String,
    disposition: String,
    barcode: Option<String>,
    sale_price_minor: Option<i64>,
    category_id: Option<String>,
) -> Result<ProductDto, CatalogCommandError> {
    let session = require_session(&ctx)
        .await
        .map_err(|e| CatalogCommandError {
            code: e.code(),
        })?;
    let category = parse_category(category_id)?;

    let parsed = Disposition::parse(&disposition).ok_or(CatalogCommandError::from(
        CatalogError::PermissionDenied,
    ))?;

    let created = use_cases::create(
        &ctx,
        &session,
        NewProduct {
            name,
            disposition: parsed,
            barcode,
            sale_price_minor,
            category,
        },
    )
    .await?;

    Ok(to_dto(&created))
}

#[tauri::command]
pub async fn get_product(
    ctx: Ctx<'_>,
    id: String,
) -> Result<ProductDto, CatalogCommandError> {
    let session = require_session(&ctx)
        .await
        .map_err(|e| CatalogCommandError { code: e.code() })?;
    let product = use_cases::get(&ctx, &session, parse_id(&id)?).await?;
    Ok(to_dto(&product))
}

#[tauri::command]
pub async fn list_products(
    ctx: Ctx<'_>,
    status: Option<String>,
) -> Result<Vec<ProductDto>, CatalogCommandError> {
    let session = require_session(&ctx)
        .await
        .map_err(|e| CatalogCommandError { code: e.code() })?;

    // Defaults to the active catalogue, which is what an operator wants to see.
    let filter = match status.as_deref() {
        Some(raw) => ProductStatus::parse(raw)
            .ok_or(CatalogCommandError::from(CatalogError::PermissionDenied))?,
        None => ProductStatus::Active,
    };

    let products = use_cases::list(&ctx, &session, filter).await?;
    Ok(products.iter().map(to_dto).collect())
}

#[tauri::command]
pub async fn update_product(
    ctx: Ctx<'_>,
    id: String,
    name: Option<String>,
    disposition: Option<String>,
    barcode: Option<Option<String>>,
    sale_price_minor: Option<Option<i64>>,
) -> Result<ProductDto, CatalogCommandError> {
    let session = require_session(&ctx)
        .await
        .map_err(|e| CatalogCommandError { code: e.code() })?;

    let patch = ProductPatch {
        name,
        disposition: match disposition.as_deref() {
            Some(raw) => Some(Disposition::parse(raw).ok_or(CatalogCommandError::from(
                CatalogError::PermissionDenied,
            ))?),
            None => None,
        },
        barcode,
        sale_price_minor,
        category: None,
    };

    let updated = use_cases::update(&ctx, &session, parse_id(&id)?, patch).await?;
    Ok(to_dto(&updated))
}

/// Put a product in a category, or take it out with `null` (ADR-018 §1).
///
/// Its own command rather than a field of `update_product`: there, `null` and a
/// missing field arrive as the same `None`, so "take it out" could not be said.
/// Here the one argument is the whole answer.
#[tauri::command]
pub async fn set_product_category(
    ctx: Ctx<'_>,
    id: String,
    category_id: Option<String>,
) -> Result<ProductDto, CatalogCommandError> {
    let session = require_session(&ctx)
        .await
        .map_err(|e| CatalogCommandError { code: e.code() })?;
    let patch = ProductPatch {
        category: Some(parse_category(category_id)?),
        ..ProductPatch::default()
    };
    let updated = use_cases::update(&ctx, &session, parse_id(&id)?, patch).await?;
    Ok(to_dto(&updated))
}

/// The next free internal barcode for «اعمل كود للمحل» (`ADR-018` §3).
///
/// A read-only suggestion; the product is still created by `create_product`
/// with the code the operator kept.
#[tauri::command]
pub async fn next_shop_code(ctx: Ctx<'_>) -> Result<String, CatalogCommandError> {
    let session = require_session(&ctx)
        .await
        .map_err(|e| CatalogCommandError { code: e.code() })?;
    let code = use_cases::next_shop_code(&ctx, &session).await?;
    Ok(code)
}

/// The next `count` free internal barcodes for «اعمل أكواد للي من غير باركود»
/// (`ADR-018` §4), advancing past both stored codes and any `reserved` codes
/// already typed into the variant table.
#[tauri::command]
pub async fn next_shop_codes(
    ctx: Ctx<'_>,
    count: usize,
    reserved: Option<Vec<String>>,
) -> Result<Vec<String>, CatalogCommandError> {
    let session = require_session(&ctx)
        .await
        .map_err(|e| CatalogCommandError { code: e.code() })?;
    let reserved = reserved.unwrap_or_default();
    let codes = use_cases::next_shop_codes(&ctx, &session, count, &reserved).await?;
    Ok(codes)
}

/// One combination's barcode and price override from the variant table.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewVariantRowDto {
    pub barcode: Option<String>,
    pub sale_price_minor: Option<i64>,
}

/// The parent of a variant family, as returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariantParentDto {
    pub id: String,
    pub name: String,
    pub category_id: String,
    pub dimension_1: &'static str,
    pub dimension_2: Option<&'static str>,
}

impl From<&VariantParent> for VariantParentDto {
    fn from(parent: &VariantParent) -> Self {
        Self {
            id: parent.id.as_str(),
            name: parent.name.as_str().to_string(),
            category_id: parent.category.as_str(),
            dimension_1: parent.dimension_1.as_str(),
            dimension_2: parent.dimension_2.map(|d| d.as_str()),
        }
    }
}

/// One registered variant product, with its values and order inside the parent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredVariantDto {
    pub product: ProductDto,
    pub parent_id: String,
    pub variant_1: String,
    pub variant_2: Option<String>,
    pub variant_order: i64,
}

impl From<&(Product, ProductVariant)> for RegisteredVariantDto {
    fn from((product, details): &(Product, ProductVariant)) -> Self {
        Self {
            product: ProductDto::from(product),
            parent_id: details.parent_id.as_str(),
            variant_1: details.value_1.as_str().to_string(),
            variant_2: details.value_2.as_ref().map(|v| v.as_str().to_string()),
            variant_order: details.order,
        }
    }
}

/// What `create_variants` returns to «صنف جديد».
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredVariantsDto {
    pub parent: VariantParentDto,
    pub variants: Vec<RegisteredVariantDto>,
}

/// Register a counted item with variants («الصنف ده ليه تفرعات», ADR-018 §4).
#[tauri::command]
pub async fn create_variants(
    ctx: Ctx<'_>,
    category_id: String,
    name: String,
    dimension_1: String,
    values_1: Vec<String>,
    dimension_2: Option<String>,
    values_2: Option<Vec<String>>,
    sale_price_minor: i64,
    rows: Option<Vec<NewVariantRowDto>>,
) -> Result<RegisteredVariantsDto, CatalogCommandError> {
    let category = uuid::Uuid::parse_str(&category_id)
        .map(crate::domain::organisation::DepartmentId::from_uuid)
        .map_err(|_| CatalogCommandError::from(CatalogError::CategoryNotFound))?;
    let registered = variant_use_cases::create_variants(
        &ctx.pool,
        ctx.tokens.as_ref(),
        NewVariants {
            category,
            name,
            dimension_1,
            values_1,
            dimension_2,
            values_2: values_2.unwrap_or_default(),
            sale_price_minor,
            rows: rows
                .unwrap_or_default()
                .into_iter()
                .map(|r| NewVariantRow {
                    barcode: r.barcode,
                    sale_price_minor: r.sale_price_minor,
                })
                .collect(),
        },
    )
    .await?;
    Ok(RegisteredVariantsDto {
        parent: VariantParentDto::from(&registered.parent),
        variants: registered
            .variants
            .iter()
            .map(RegisteredVariantDto::from)
            .collect(),
    })
}


#[tauri::command]
pub async fn set_product_archived(
    ctx: Ctx<'_>,
    id: String,
    archived: bool,
) -> Result<ProductDto, CatalogCommandError> {
    let session = require_session(&ctx)
        .await
        .map_err(|e| CatalogCommandError { code: e.code() })?;

    // Archive is never a delete: `spec:221` keeps a product linked to history,
    // and the row stays.
    let status = if archived {
        ProductStatus::Archived
    } else {
        ProductStatus::Active
    };

    let updated = use_cases::set_status(&ctx, &session, parse_id(&id)?, status).await?;
    Ok(to_dto(&updated))
}

/// Typed or pasted barcode lookup. Needs no scanner, so the blocked barcode
/// decision is not reopened.
#[tauri::command]
pub async fn find_product_by_barcode(
    ctx: Ctx<'_>,
    barcode: String,
) -> Result<ProductDto, CatalogCommandError> {
    let session = require_session(&ctx)
        .await
        .map_err(|e| CatalogCommandError { code: e.code() })?;
    let found = use_cases::find_by_barcode(&ctx, &session, &barcode).await?;
    Ok(to_dto(&found))
}

/// A product's stored 192×192 JPEG thumbnail metadata and data URL (`ADR-018` §5).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductImageDto {
    pub product_id: String,
    pub file: String,
    pub w: u16,
    pub h: u16,
    pub bytes: usize,
    pub data_url: String,
}

impl From<ProductImageEntry> for ProductImageDto {
    fn from(entry: ProductImageEntry) -> Self {
        Self {
            product_id: entry.image.product_id.as_str(),
            file: entry.image.file,
            w: entry.image.w,
            h: entry.image.h,
            bytes: entry.image.bytes,
            data_url: entry.data_url,
        }
    }
}

fn resolve_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, CatalogCommandError> {
    app.path()
        .app_local_data_dir()
        .map_err(|_| CatalogCommandError {
            code: DomainError::StorageUnavailable.code(),
        })
}

/// List all stored product images for the store, sales screen, and settings.
#[tauri::command]
pub async fn list_product_images(
    ctx: Ctx<'_>,
    app: AppHandle,
) -> Result<Vec<ProductImageDto>, CatalogCommandError> {
    let data_dir = resolve_data_dir(&app)?;
    let entries =
        image_use_cases::list_images(&ctx.pool, ctx.tokens.as_ref(), &data_dir).await?;
    Ok(entries.into_iter().map(ProductImageDto::from).collect())
}

/// Store or replace a product's 192×192 JPEG thumbnail (`ADR-018` §5).
#[tauri::command]
pub async fn set_product_image(
    ctx: Ctx<'_>,
    app: AppHandle,
    product_id: String,
    data_url: String,
) -> Result<ProductImageDto, CatalogCommandError> {
    let data_dir = resolve_data_dir(&app)?;
    let id = parse_id(&product_id)?;
    let entry =
        image_use_cases::set_image(&ctx.pool, ctx.tokens.as_ref(), &data_dir, id, &data_url)
            .await?;
    Ok(ProductImageDto::from(entry))
}

/// Remove a product's stored 192×192 JPEG thumbnail (`ADR-018` §5).
#[tauri::command]
pub async fn remove_product_image(
    ctx: Ctx<'_>,
    app: AppHandle,
    product_id: String,
) -> Result<(), CatalogCommandError> {
    let data_dir = resolve_data_dir(&app)?;
    let id = parse_id(&product_id)?;
    image_use_cases::remove_image(&ctx.pool, ctx.tokens.as_ref(), &data_dir, id).await?;
    Ok(())
}

/// Read the optional 192×192 JPEG shop logo as a `data:image/jpeg;base64,...`
/// string, or `None` when no logo file is stored (`ADR-022` §2.2).
#[tauri::command]
pub async fn get_shop_logo(
    ctx: Ctx<'_>,
    app: AppHandle,
) -> Result<Option<String>, CatalogCommandError> {
    let data_dir = resolve_data_dir(&app)?;
    let logo =
        image_use_cases::get_shop_logo(&ctx.pool, ctx.tokens.as_ref(), &data_dir).await?;
    Ok(logo)
}

/// Store or replace the shop's 192×192 JPEG logo on disk (`ADR-022` §2.2).
#[tauri::command]
pub async fn set_shop_logo(
    ctx: Ctx<'_>,
    app: AppHandle,
    data_url: String,
) -> Result<String, CatalogCommandError> {
    let data_dir = resolve_data_dir(&app)?;
    let stored =
        image_use_cases::set_shop_logo(&ctx.pool, ctx.tokens.as_ref(), &data_dir, &data_url)
            .await?;
    Ok(stored)
}

/// Remove the shop's stored 192×192 JPEG logo (`ADR-022` §2.2).
#[tauri::command]
pub async fn remove_shop_logo(
    ctx: Ctx<'_>,
    app: AppHandle,
) -> Result<(), CatalogCommandError> {
    let data_dir = resolve_data_dir(&app)?;
    image_use_cases::remove_shop_logo(&ctx.pool, ctx.tokens.as_ref(), &data_dir).await?;
    Ok(())
}

