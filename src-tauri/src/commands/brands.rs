//! Tauri commands for phone brands and registering a new phone (ADR-018 §2).
//!
//! Transport boundaries only: no SQL, no business rule. No command takes a
//! session, token, role or actor — the operator is resolved from the OS
//! credential store inside each use case, and an architecture guard parses
//! these signatures to keep it that way.

use serde::Serialize;
use tauri::State;

use crate::commands::catalog::ProductDto;
use crate::domain::catalog::{
    brand_lines, Brand, BrandDeviceType, BrandError, BrandId, DeviceType,
};
use crate::domain::organisation::DepartmentId;
use crate::services::catalog::brands::{self as use_cases, BrandEntry, BrandServiceError, BrandStep};
use crate::services::catalog::phone::{self, NewPhone};
use crate::services::catalog::CatalogContext;

type Ctx<'a> = State<'a, CatalogContext>;

/// Every failure crossing the boundary is a stable code, never prose.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandCommandError {
    pub code: &'static str,
}

impl From<BrandServiceError> for BrandCommandError {
    fn from(error: BrandServiceError) -> Self {
        Self { code: error.code() }
    }
}

impl From<BrandError> for BrandCommandError {
    fn from(error: BrandError) -> Self {
        Self { code: error.code() }
    }
}

/// A brand as the screens see it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandDto {
    pub id: String,
    pub name: String,
    /// `touch`, `keypad` or `both`.
    pub device_type: &'static str,
    pub sort_order: i64,
    pub hidden: bool,
    /// Model lines written without the company («iPhone»), for the name preview.
    pub lines: Vec<&'static str>,
}

impl From<&Brand> for BrandDto {
    fn from(brand: &Brand) -> Self {
        Self {
            id: brand.id.as_str(),
            name: brand.name.as_str().to_string(),
            device_type: brand.device_type.as_str(),
            sort_order: brand.sort_order,
            hidden: brand.hidden,
            lines: brand_lines(brand.id).to_vec(),
        }
    }
}

/// One row of the settings list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandEntryDto {
    #[serde(flatten)]
    pub brand: BrandDto,
    /// Live phones of this company.
    pub products: i64,
    pub is_default: bool,
    pub deletable: bool,
}

impl From<&BrandEntry> for BrandEntryDto {
    fn from(entry: &BrandEntry) -> Self {
        Self {
            brand: BrandDto::from(&entry.brand),
            products: entry.products,
            is_default: entry.is_default,
            deletable: entry.deletable,
        }
    }
}

/// A registered phone: the product, and the details its name was built from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredPhoneDto {
    pub product: ProductDto,
    pub brand_id: String,
    pub model: String,
    pub device_type: &'static str,
    pub storage_gb: Option<i64>,
    pub ram_gb: Option<i64>,
}

fn parse_brand(raw: &str) -> Result<BrandId, BrandCommandError> {
    uuid::Uuid::parse_str(raw)
        .map(BrandId::from_uuid)
        .map_err(|_| BrandError::NotFound.into())
}

fn parse_brand_type(raw: &str) -> Result<BrandDeviceType, BrandCommandError> {
    BrandDeviceType::parse(raw).ok_or_else(|| BrandError::TypeUnknown.into())
}

#[tauri::command]
pub async fn list_brands(ctx: Ctx<'_>) -> Result<Vec<BrandEntryDto>, BrandCommandError> {
    let entries = use_cases::list(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(entries.iter().map(BrandEntryDto::from).collect())
}

#[tauri::command]
pub async fn create_brand(
    ctx: Ctx<'_>,
    name: String,
    device_type: String,
) -> Result<BrandDto, BrandCommandError> {
    let device_type = parse_brand_type(&device_type)?;
    let brand = use_cases::create(&ctx.pool, ctx.tokens.as_ref(), &name, device_type).await?;
    Ok(BrandDto::from(&brand))
}

#[tauri::command]
pub async fn rename_brand(
    ctx: Ctx<'_>,
    id: String,
    name: String,
) -> Result<BrandDto, BrandCommandError> {
    let brand = use_cases::rename(&ctx.pool, ctx.tokens.as_ref(), parse_brand(&id)?, &name).await?;
    Ok(BrandDto::from(&brand))
}

#[tauri::command]
pub async fn set_brand_type(
    ctx: Ctx<'_>,
    id: String,
    device_type: String,
) -> Result<BrandDto, BrandCommandError> {
    let device_type = parse_brand_type(&device_type)?;
    let brand =
        use_cases::set_device_type(&ctx.pool, ctx.tokens.as_ref(), parse_brand(&id)?, device_type)
            .await?;
    Ok(BrandDto::from(&brand))
}

/// Show or hide a company in «موبايل جديد».
#[tauri::command]
pub async fn set_brand_hidden(
    ctx: Ctx<'_>,
    id: String,
    hidden: bool,
) -> Result<BrandDto, BrandCommandError> {
    let brand =
        use_cases::set_hidden(&ctx.pool, ctx.tokens.as_ref(), parse_brand(&id)?, hidden).await?;
    Ok(BrandDto::from(&brand))
}

/// Move a company one place in the list: `up` or `down`.
#[tauri::command]
pub async fn move_brand(
    ctx: Ctx<'_>,
    id: String,
    direction: String,
) -> Result<BrandDto, BrandCommandError> {
    let step = match direction.as_str() {
        "up" => BrandStep::Up,
        "down" => BrandStep::Down,
        _ => return Err(BrandError::NotFound.into()),
    };
    let brand = use_cases::move_brand(&ctx.pool, ctx.tokens.as_ref(), parse_brand(&id)?, step).await?;
    Ok(BrandDto::from(&brand))
}

#[tauri::command]
pub async fn delete_brand(ctx: Ctx<'_>, id: String) -> Result<(), BrandCommandError> {
    use_cases::delete(&ctx.pool, ctx.tokens.as_ref(), parse_brand(&id)?).await?;
    Ok(())
}

/// Register a new phone: the name is built from its details.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_phone(
    ctx: Ctx<'_>,
    category_id: String,
    brand_id: String,
    model: String,
    device_type: String,
    storage_gb: Option<i64>,
    ram_gb: Option<i64>,
    sale_price_minor: Option<i64>,
) -> Result<RegisteredPhoneDto, BrandCommandError> {
    let category = uuid::Uuid::parse_str(&category_id)
        .map(DepartmentId::from_uuid)
        .map_err(|_| BrandCommandError {
            code: crate::domain::catalog::CatalogError::CategoryNotFound.code(),
        })?;
    let device_type = DeviceType::parse(&device_type).ok_or(BrandError::TypeMismatch)?;
    let registered = phone::create_phone(
        &ctx.pool,
        ctx.tokens.as_ref(),
        NewPhone {
            category,
            brand: parse_brand(&brand_id)?,
            model,
            device_type,
            storage_gb,
            ram_gb,
            sale_price_minor,
        },
    )
    .await?;
    Ok(RegisteredPhoneDto {
        product: ProductDto::from(&registered.product),
        brand_id: registered.details.brand.as_str(),
        model: registered.details.model.as_str().to_string(),
        device_type: registered.details.device_type.as_str(),
        storage_gb: registered.details.storage_gb,
        ram_gb: registered.details.ram_gb,
    })
}
