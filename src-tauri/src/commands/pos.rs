//! Tauri commands for the sales screen (plan item 1.6).
//!
//! Transport boundaries only: no SQL, no business rule, and no session, token
//! or role parameter. The operator is resolved from the OS credential store
//! inside the use case, which also decides the permission (`Sell`).

use serde::Serialize;
use tauri::State;

use crate::domain::identity::DomainError;
use crate::services::catalog::pos as use_cases;
use crate::services::identity::IdentityContext;

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure crossing the boundary is a stable code, never prose.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PosCommandError {
    pub code: &'static str,
}

impl From<DomainError> for PosCommandError {
    fn from(error: DomainError) -> Self {
        Self { code: error.code() }
    }
}

/// One sellable product. Deliberately carries no cost.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PosProductDto {
    pub id: String,
    pub name: String,
    pub disposition: String,
    pub tracking: String,
    pub barcode: Option<String>,
    pub sale_price_minor: Option<i64>,
    /// The category it is in (ADR-018 §1), or `null`.
    pub category_id: Option<String>,
    /// The phone's company (ADR-018 §2), or `null`.
    pub brand_id: Option<String>,
    /// The variant parent this product belongs to (ADR-018 §4), or `null`.
    pub parent_id: Option<String>,
    /// The parent's base name («جراب سيليكون ملون») shown on the family tile.
    pub parent_name: Option<String>,
    /// The parent's first dimension («الموبايل»).
    pub dimension_1: Option<String>,
    /// The parent's second dimension («اللون»), if two-dimensional.
    pub dimension_2: Option<String>,
    /// This product's value on the first dimension («Galaxy A16»).
    pub variant_1: Option<String>,
    /// This product's value on the second dimension («أسود»).
    pub variant_2: Option<String>,
    /// Order of this variant inside its parent's picker.
    pub variant_order: Option<i64>,
    pub on_hand: i64,
    pub sold_recently: i64,
}


/// One category: a chip, unless hidden (ADR-018 §1).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PosCategoryDto {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub icon: String,
    pub hidden: bool,
    pub sort_order: i64,
}

/// One available serialized unit (`ADR-019`, `ADR-032`), carrying no cost figure.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PosUnitDto {
    pub id: String,
    pub product_id: String,
    pub imei: String,
    pub imei2: Option<String>,
    pub color: Option<String>,
    pub condition_grade: Option<String>,
    pub battery_health_pct: Option<i64>,
    pub accessories: Option<String>,
    pub intake_note: Option<String>,
    pub created_at: i64,
}

/// The sales screen's catalogue.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PosCatalogDto {
    pub products: Vec<PosProductDto>,
    pub categories: Vec<PosCategoryDto>,
    pub brands: Vec<PosBrandDto>,
    pub units: Vec<PosUnitDto>,
}

/// A phone company: a chip under a phone category, and words search matches.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PosBrandDto {
    pub id: String,
    pub name: String,
    pub aliases: &'static str,
    pub sort_order: i64,
}

/// Read what the sales screen shows: active products with stock on hand and
/// recent sales, and the live categories. `Sell`; no cost.
#[tauri::command]
pub async fn pos_catalog(ctx: Ctx<'_>) -> Result<PosCatalogDto, PosCommandError> {
    let catalog = use_cases::read(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(PosCatalogDto {
        products: catalog
            .products
            .into_iter()
            .map(|row| PosProductDto {
                id: row.id,
                name: row.name,
                disposition: row.disposition,
                tracking: row.tracking,
                barcode: row.barcode,
                sale_price_minor: row.sale_price_minor,
                category_id: row.department_id,
                brand_id: row.brand_id,
                parent_id: row.parent_id,
                parent_name: row.parent_name,
                dimension_1: row.dimension_1,
                dimension_2: row.dimension_2,
                variant_1: row.variant_1,
                variant_2: row.variant_2,
                variant_order: row.variant_order,
                on_hand: row.on_hand,
                sold_recently: row.sold_recently,
            })
            .collect(),

        categories: catalog
            .categories
            .into_iter()
            .map(|row| PosCategoryDto {
                id: row.id,
                name: row.name,
                parent_id: row.parent_id,
                kind: row.kind,
                icon: row.icon,
                hidden: row.hidden,
                sort_order: row.sort_order,
            })
            .collect(),
        brands: catalog
            .brands
            .into_iter()
            .map(|brand| PosBrandDto {
                id: brand.id,
                name: brand.name,
                aliases: brand.aliases,
                sort_order: brand.sort_order,
            })
            .collect(),
        units: catalog
            .units
            .into_iter()
            .map(|u| PosUnitDto {
                id: u.id,
                product_id: u.product_id,
                imei: u.imei,
                imei2: u.imei2,
                color: u.color,
                condition_grade: u.condition_grade,
                battery_health_pct: u.battery_health_pct,
                accessories: u.accessories,
                intake_note: u.intake_note,
                created_at: u.created_at,
            })
            .collect(),
    })
}
