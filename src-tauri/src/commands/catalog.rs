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

use serde::Serialize;
use tauri::State;

use crate::domain::catalog::{CatalogError, Disposition, Product, ProductStatus};
use crate::services::catalog::product::{self as use_cases, NewProduct, ProductPatch};
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

#[tauri::command]
pub async fn create_product(
    ctx: Ctx<'_>,
    name: String,
    disposition: String,
    barcode: Option<String>,
    sale_price_minor: Option<i64>,
) -> Result<ProductDto, CatalogCommandError> {
    let session = require_session(&ctx)
        .await
        .map_err(|e| CatalogCommandError {
            code: e.code(),
        })?;

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
    };

    let updated = use_cases::update(&ctx, &session, parse_id(&id)?, patch).await?;
    Ok(to_dto(&updated))
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
