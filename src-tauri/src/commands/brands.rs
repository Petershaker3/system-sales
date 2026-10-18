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
use crate::services::catalog::phone::{self, NewPhone, NewUsedPhone};
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

/// Result of registering a used phone (`ADR-032`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredUsedPhoneDto {
    pub product: ProductDto,
    pub brand_id: String,
    pub model: String,
    pub device_type: &'static str,
    pub storage_gb: Option<i64>,
    pub ram_gb: Option<i64>,
    pub unit_id: String,
    pub imei: String,
    pub imei2: Option<String>,
    pub condition_grade: String,
    pub battery_health_pct: Option<i64>,
    pub cost_minor: i64,
    pub sale_price_minor: i64,
    pub on_hand: i64,
}

/// Register a used phone unit into stock (`ADR-032`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_used_phone(
    ctx: Ctx<'_>,
    category_id: String,
    brand_id: String,
    model: String,
    device_type: String,
    storage_gb: Option<i64>,
    ram_gb: Option<i64>,
    color: Option<String>,
    imei: String,
    imei2: Option<String>,
    condition_grade: String,
    battery_health_pct: Option<i64>,
    accessories: Option<String>,
    intake_note: Option<String>,
    cost_minor: i64,
    sale_price_minor: i64,
    seller_name: Option<String>,
    seller_phone: Option<String>,
    seller_national_id: Option<String>,
    is_opening_stock: Option<bool>,
    payout_from_drawer: Option<bool>,
) -> Result<RegisteredUsedPhoneDto, BrandCommandError> {
    let category = uuid::Uuid::parse_str(&category_id)
        .map(DepartmentId::from_uuid)
        .map_err(|_| BrandCommandError {
            code: crate::domain::catalog::CatalogError::CategoryNotFound.code(),
        })?;
    let device_type = DeviceType::parse(&device_type).ok_or(BrandError::TypeMismatch)?;
    let registered = phone::create_used_phone(
        &ctx.pool,
        ctx.tokens.as_ref(),
        NewUsedPhone {
            category,
            brand: parse_brand(&brand_id)?,
            model,
            device_type,
            storage_gb,
            ram_gb,
            color,
            imei,
            imei2,
            condition_grade,
            battery_health_pct,
            accessories,
            intake_note,
            cost_minor,
            sale_price_minor,
            seller_name,
            seller_phone,
            seller_national_id,
            is_opening_stock: is_opening_stock.unwrap_or(false),
            payout_from_drawer: payout_from_drawer.unwrap_or(false),
        },
    )
    .await?;
    Ok(RegisteredUsedPhoneDto {
        product: ProductDto::from(&registered.product),
        brand_id: registered.details.brand.as_str(),
        model: registered.details.model.as_str().to_string(),
        device_type: registered.details.device_type.as_str(),
        storage_gb: registered.details.storage_gb,
        ram_gb: registered.details.ram_gb,
        unit_id: registered.unit_id,
        imei: registered.imei,
        imei2: registered.imei2,
        condition_grade: registered.condition_grade,
        battery_health_pct: registered.battery_health_pct,
        cost_minor: registered.cost_minor,
        sale_price_minor: registered.sale_price_minor,
        on_hand: registered.on_hand,
    })
}

/// Local unit match returned by [`check_imei`] (`ADR-032`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImeiLocalUnitMatchDto {
    pub unit_id: String,
    pub product_id: String,
    pub product_name: String,
    pub imei: String,
    pub imei2: Option<String>,
    pub status: String,
    pub color: Option<String>,
    pub condition_grade: Option<String>,
    pub battery_health_pct: Option<i64>,
    pub accessories: Option<String>,
    pub intake_note: Option<String>,
    pub unit_cost_minor: Option<i64>,
    pub seller_name: Option<String>,
    pub seller_phone: Option<String>,
    pub seller_national_id: Option<String>,
    pub created_at: i64,
}

/// Repair ticket match returned by [`check_imei`] (`ADR-032`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImeiRepairMatchDto {
    pub ticket_no: String,
    pub device_name: String,
    pub issue: String,
    pub status: String,
    pub customer_name: String,
    pub created_at: i64,
}

/// Complete IMEI inspection report DTO (`ADR-032`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImeiCheckResultDto {
    pub normalized: String,
    pub digit_count: usize,
    pub format_valid: bool,
    pub luhn_valid: bool,
    pub tac: Option<String>,
    pub local_unit: Option<ImeiLocalUnitMatchDto>,
    pub repairs: Vec<ImeiRepairMatchDto>,
}

/// Inspect an IMEI for Luhn validity, TAC prefix, and local unit/repair history (`ADR-032`).
#[tauri::command]
pub async fn check_imei(
    ctx: Ctx<'_>,
    imei: String,
) -> Result<ImeiCheckResultDto, BrandCommandError> {
    let report = phone::check_imei(&ctx.pool, ctx.tokens.as_ref(), &imei).await?;
    Ok(ImeiCheckResultDto {
        normalized: report.normalized,
        digit_count: report.digit_count,
        format_valid: report.format_valid,
        luhn_valid: report.luhn_valid,
        tac: report.tac,
        local_unit: report.local_unit.map(|u| ImeiLocalUnitMatchDto {
            unit_id: u.unit_id,
            product_id: u.product_id,
            product_name: u.product_name,
            imei: u.imei,
            imei2: u.imei2,
            status: u.status,
            color: u.color,
            condition_grade: u.condition_grade,
            battery_health_pct: u.battery_health_pct,
            accessories: u.accessories,
            intake_note: u.intake_note,
            unit_cost_minor: u.unit_cost_minor,
            seller_name: u.seller_name,
            seller_phone: u.seller_phone,
            seller_national_id: u.seller_national_id,
            created_at: u.created_at,
        }),
        repairs: report
            .repairs
            .into_iter()
            .map(|r| ImeiRepairMatchDto {
                ticket_no: r.ticket_no,
                device_name: r.device_name,
                issue: r.issue,
                status: r.status,
                customer_name: r.customer_name,
                created_at: r.created_at,
            })
            .collect(),
    })
}

