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

use serde::Serialize;
use tauri::State;

use crate::domain::identity::Sensitivity;
use crate::domain::supplier::SupplierName;
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
) -> Result<StockOutcomeDto, InventoryCommandError> {
    let supplier = SupplierName::parse_optional(supplier_name.as_deref().unwrap_or(""))
        .map_err(|error| InventoryCommandError { code: error.code() })?;
    let outcome = use_cases::receive(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &product_id,
        quantity,
        unit_cost_minor,
        Sensitivity::Routine,
        supplier,
    )
    .await?;

    Ok(StockOutcomeDto {
        product_id,
        quantity: outcome.quantity,
        cost_minor: outcome.cost_minor,
    })
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
