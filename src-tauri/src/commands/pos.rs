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
    pub barcode: Option<String>,
    pub sale_price_minor: Option<i64>,
    /// The category it is in (ADR-018 §1), or `null`.
    pub category_id: Option<String>,
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

/// The sales screen's catalogue.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PosCatalogDto {
    pub products: Vec<PosProductDto>,
    pub categories: Vec<PosCategoryDto>,
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
                barcode: row.barcode,
                sale_price_minor: row.sale_price_minor,
                category_id: row.department_id,
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
    })
}
