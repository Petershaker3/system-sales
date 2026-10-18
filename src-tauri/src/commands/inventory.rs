//! Tauri commands for stock and costing.
//!
//! Transport boundaries only. No SQL and no business rule appears here: the
//! arithmetic, the authority rule and the transaction all live in
//! `services::inventory`.
//!
//! # No session parameter, on purpose
//!
//! No command accepts a token, a user id, a role or an actor. Each resolves the
//! current operator from the OS credential store through the shared
//! `IdentityContext` and lets the service authorise. That is what makes
//! attribution a fact rather than a claim.
//!
//! # `Sensitivity` is the service's decision, not the caller's
//!
//! The movement commands do not take a sensitivity argument. Deciding how much
//! proof an operation needs is a domain judgement (`ADR-015`), and letting the
//! WebView pass it would let a caller downgrade a sensitive operation to a
//! routine one. The frontend chooses *which* use case to invoke; the service
//! decides what that use case costs.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::domain::identity::Sensitivity;
use crate::domain::supplier::SupplierName;
use crate::domain::unit::ReceiptKind;
use crate::services::identity::IdentityContext;
use crate::services::inventory::stock::{self as use_cases, StockServiceError};

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure crossing the boundary is a stable code, never prose.
/// `spec:127` keeps user-facing text in Arabic message files on the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCommandError {
    pub code: &'static str,
}

impl From<StockServiceError> for InventoryCommandError {
    fn from(error: StockServiceError) -> Self {
        Self {
            code: error.code(),
        }
    }
}

impl From<crate::services::inventory::stock::StockError> for InventoryCommandError {
    fn from(error: crate::services::inventory::stock::StockError) -> Self {
        Self {
            code: error.code(),
        }
    }
}

/// A stock position as the frontend sees it.
///
/// Every quantity product is costed by moving average (`ADR-016` #7).
/// `totalCostMinor` stays nullable and **that nullability is meaningful**:
/// `null` means the product was never stocked, and `0` would mean free stock.
/// The frontend must not collapse them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockPositionDto {
    pub product_id: String,
    pub quantity: i64,
    pub total_cost_minor: Option<i64>,
    pub effective_cost_minor: i64,
}

/// What one movement changed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockOutcomeDto {
    pub product_id: String,
    pub quantity: i64,
    pub cost_minor: i64,
}

/// One registered `in_stock` device unit (`ADR-019`, `ADR-032`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductUnitDto {
    pub id: String,
    pub product_id: String,
    pub imei: String,
    pub imei2: Option<String>,
    pub color: Option<String>,
    pub unit_cost_minor: i64,
    pub condition_grade: Option<String>,
    pub battery_health_pct: Option<i64>,
    pub accessories: Option<String>,
    pub intake_note: Option<String>,
    pub seller_name: Option<String>,
    pub seller_phone: Option<String>,
    pub seller_national_id: Option<String>,
    pub created_at: i64,
}

/// Receive stock at a known unit cost.
///
/// `Routine`: receiving a delivery is ordinary work (`ADR-015`).
///
/// `supplier_name` is the operator's own label for who delivered it (D1). It is
/// optional and blank means none: an empty supplier is refused by the domain
/// rather than stored, so the shop's supplier list never grows a blank entry.
#[tauri::command]
pub async fn receive_stock(
    ctx: Ctx<'_>,
    product_id: String,
    quantity: i64,
    unit_cost_minor: i64,
    supplier_name: Option<String>,
    imeis: Option<Vec<String>>,
) -> Result<StockOutcomeDto, InventoryCommandError> {
    let supplier = SupplierName::parse_optional(supplier_name.as_deref().unwrap_or(""))
        .map_err(|error| InventoryCommandError { code: error.code() })?;
    let imeis = imeis.unwrap_or_default();
    let outcome = use_cases::receive_with_units(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &product_id,
        quantity,
        unit_cost_minor,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        supplier,
        &imeis,
    )
    .await?;

    Ok(StockOutcomeDto {
        product_id,
        quantity: outcome.quantity,
        cost_minor: outcome.cost_minor,
    })
}

/// Receive first-time opening stock already on the shelf (`ADR-016` #30, `ADR-019`).
///
/// `Sensitive`: spends one owner PIN approval inside the transaction, and
/// takes no supplier name because opening stock is not a supplier purchase.
#[tauri::command]
pub async fn receive_opening_stock(
    ctx: Ctx<'_>,
    product_id: String,
    quantity: i64,
    unit_cost_minor: i64,
    imeis: Option<Vec<String>>,
) -> Result<StockOutcomeDto, InventoryCommandError> {
    let imeis = imeis.unwrap_or_default();
    let outcome = use_cases::receive_with_units(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &product_id,
        quantity,
        unit_cost_minor,
        ReceiptKind::Opening,
        Sensitivity::Sensitive,
        None,
        &imeis,
    )
    .await?;

    Ok(StockOutcomeDto {
        product_id,
        quantity: outcome.quantity,
        cost_minor: outcome.cost_minor,
    })
}

/// List registered `in_stock` device units for a product (`ADR-019`).
#[tauri::command]
pub async fn list_product_units(
    ctx: Ctx<'_>,
    product_id: String,
) -> Result<Vec<ProductUnitDto>, InventoryCommandError> {
    let units = use_cases::list_units_in_stock(&ctx.pool, ctx.tokens.as_ref(), &product_id).await?;
    Ok(units
        .into_iter()
        .map(|u| ProductUnitDto {
            id: u.id,
            product_id: u.product_id,
            imei: u.imei,
            imei2: u.imei2,
            color: u.color,
            unit_cost_minor: u.unit_cost_minor,
            condition_grade: u.condition_grade,
            battery_health_pct: u.battery_health_pct,
            accessories: u.accessories,
            intake_note: u.intake_note,
            seller_name: u.seller_name,
            seller_phone: u.seller_phone,
            seller_national_id: u.seller_national_id,
            created_at: u.created_at,
        })
        .collect())
}

/// Remove stock, reporting what the units cost at the moving average.
#[tauri::command]
pub async fn remove_stock(
    ctx: Ctx<'_>,
    product_id: String,
    quantity: i64,
) -> Result<StockOutcomeDto, InventoryCommandError> {
    let outcome = use_cases::remove(&ctx.pool, ctx.tokens.as_ref(), &product_id, quantity).await?;

    Ok(StockOutcomeDto {
        product_id,
        quantity: outcome.quantity,
        cost_minor: outcome.cost_minor,
    })
}

/// Read a product's position. No mutation.
#[tauri::command]
pub async fn get_position(
    ctx: Ctx<'_>,
    product_id: String,
) -> Result<StockPositionDto, InventoryCommandError> {
    let view = use_cases::position(&ctx.pool, ctx.tokens.as_ref(), &product_id).await?;

    Ok(StockPositionDto {
        product_id,
        quantity: view.quantity,
        total_cost_minor: view.total_cost_minor,
        // Zero for a product never stocked; the stored total otherwise.
        effective_cost_minor: view.effective_cost_minor().map_err(InventoryCommandError::from)?,
    })
}

/// List all registered `in_stock` device units across all active products (`ADR-034`, Plan item 2.4).
#[tauri::command]
pub async fn list_all_product_units(
    ctx: Ctx<'_>,
) -> Result<Vec<ProductUnitDto>, InventoryCommandError> {
    let units = use_cases::list_all_units_in_stock(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(units
        .into_iter()
        .map(|u| ProductUnitDto {
            id: u.id,
            product_id: u.product_id,
            imei: u.imei,
            imei2: u.imei2,
            color: u.color,
            unit_cost_minor: u.unit_cost_minor,
            condition_grade: u.condition_grade,
            battery_health_pct: u.battery_health_pct,
            accessories: u.accessories,
            intake_note: u.intake_note,
            seller_name: u.seller_name,
            seller_phone: u.seller_phone,
            seller_national_id: u.seller_national_id,
            created_at: u.created_at,
        })
        .collect())
}

/// One product's physical count input during a Stock Count reconciliation (`ADR-034`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockCountItemInputDto {
    pub product_id: String,
    pub counted_quantity: i64,
    pub missing_unit_ids: Option<Vec<String>>,
    pub unit_cost_minor: Option<i64>,
}

/// What a Stock Count reconciliation changed (`ADR-034`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockCountReconcileOutcomeDto {
    pub adjusted_products: usize,
    pub retired_units: usize,
    pub net_quantity_delta: i64,
    pub net_cost_delta_minor: i64,
}

/// Reconcile physical stock count discrepancies and missing IMEI units (`ADR-034`, Plan item 2.4).
///
/// `Sensitive`: requires `Permission::ManageInventory` and spends one Owner PIN approval.
#[tauri::command]
pub async fn reconcile_stock_count(
    ctx: Ctx<'_>,
    reason: String,
    items: Vec<StockCountItemInputDto>,
) -> Result<StockCountReconcileOutcomeDto, InventoryCommandError> {
    let inputs: Vec<use_cases::StockCountItemInput> = items
        .into_iter()
        .map(|item| use_cases::StockCountItemInput {
            product_id: item.product_id,
            counted_quantity: item.counted_quantity,
            missing_unit_ids: item.missing_unit_ids.unwrap_or_default(),
            unit_cost_minor: item.unit_cost_minor,
        })
        .collect();
    let outcome =
        use_cases::reconcile_stock_count(&ctx.pool, ctx.tokens.as_ref(), &reason, &inputs).await?;
    Ok(StockCountReconcileOutcomeDto {
        adjusted_products: outcome.adjusted_products,
        retired_units: outcome.retired_units,
        net_quantity_delta: outcome.net_quantity_delta,
        net_cost_delta_minor: outcome.net_cost_delta_minor,
    })
}

