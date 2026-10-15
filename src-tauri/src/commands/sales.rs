//! Safe Sales: `record_sale` and `cancel_sale` commands.
//!
//! This is the transport boundary only. It accepts whatever the frontend
//! sends and forwards it to `crate::services::sales`; it validates no
//! business rules here.
//!
//! No session parameter, on purpose. The caller passes values; the service
//! decides authority and sensitivity.
//!
//! `Sensitivity` is the service's decision, not the caller's. This layer
//! never names a `Permission` or `Sensitivity`.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::domain::identity::{DomainError, Permission};
use crate::services::identity::{session as identity_session};
use crate::services::identity::IdentityContext;
use crate::services::sales::{self as use_cases, SaleLineInput, SaleOutcome, SaleServiceError};

type Ctx<'a> = State<'a, IdentityContext>;

/// Transport error for the Sales commands.
#[derive(Debug, Serialize)]
pub struct SalesCommandError {
    pub code: &'static str,
}

impl From<SaleServiceError> for SalesCommandError {
    fn from(value: SaleServiceError) -> Self {
        Self { code: value.code() }
    }
}

/// One product line as sent by the frontend.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleLineInputDto {
    pub product_id: String,
    pub quantity: i64,
}

impl From<SaleLineInputDto> for SaleLineInput {
    fn from(value: SaleLineInputDto) -> Self {
        Self {
            product_id: value.product_id,
            quantity: value.quantity,
        }
    }
}

/// Success payload without cost/profit data — the approved public contract.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleOutcomePublicDto {
    pub sale_id: String,
    pub reference: String,
    pub total_minor: i64,
}

/// Success payload with cost/profit data — only for sessions that hold
/// `Permission::ViewCostAndProfit`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleOutcomeWithCostDto {
    pub sale_id: String,
    pub reference: String,
    pub total_minor: i64,
    pub cost_total_minor: i64,
}

impl From<SaleOutcome> for SaleOutcomePublicDto {
    fn from(value: SaleOutcome) -> Self {
        Self {
            sale_id: value.sale_id,
            reference: value.reference,
            total_minor: value.total_minor,
        }
    }
}

impl From<SaleOutcome> for SaleOutcomeWithCostDto {
    fn from(value: SaleOutcome) -> Self {
        Self {
            sale_id: value.sale_id,
            reference: value.reference,
            total_minor: value.total_minor,
            cost_total_minor: value.cost_total_minor,
        }
    }
}

/// Record one cash sale.
///
/// The service re-reads prices under a transaction and compares the total
/// against `confirmed_total_minor`. A mismatch aborts the sale with
/// `SALE_PRICE_CHANGED`; prices sent by the client are never trusted.
#[tauri::command]
pub async fn record_sale(
    ctx: Ctx<'_>,
    lines: Vec<SaleLineInputDto>,
    confirmed_total_minor: Option<i64>,
) -> Result<serde_json::Value, SalesCommandError> {
    let lines = lines.into_iter().map(SaleLineInput::from).collect::<Vec<_>>();
    let outcome = use_cases::record_sale(&ctx.pool, ctx.tokens.as_ref(), &lines, confirmed_total_minor)
        .await?;
    // Authorize cost visibility from the session, not from caller role alone.
    let session = identity_session::resolve(&ctx.pool, ctx.tokens.as_ref()).await
        .map_err(|_| SalesCommandError { code: "IDENTITY_RESOLUTION_FAILED" })?;
    if session.authorize(Permission::ViewCostAndProfit).is_ok() {
        Ok(serde_json::to_value(SaleOutcomeWithCostDto::from(outcome)).expect("json"))
    } else {
        Ok(serde_json::to_value(SaleOutcomePublicDto::from(outcome)).expect("json"))
    }
}

/// Cancel a previously recorded sale by reversing its effects.
///
/// The service writes an explicit cancellation audit trail. A sale that was
/// already cancelled is rejected with `SALE_ALREADY_CANCELLED`. Whether the
/// reversal requires `Permission::CancelTransaction` and marks the operation
/// `Sensitive` is the service's decision, not the caller's.
#[tauri::command]
pub async fn cancel_sale(
    ctx: Ctx<'_>,
    sale_id: String,
    reason: String,
) -> Result<serde_json::Value, SalesCommandError> {
    let outcome = use_cases::cancel_sale(&ctx.pool, ctx.tokens.as_ref(), &sale_id, &reason).await?;
    let session = identity_session::resolve(&ctx.pool, ctx.tokens.as_ref()).await
        .map_err(|_| SalesCommandError { code: "IDENTITY_RESOLUTION_FAILED" })?;
    if session.authorize(Permission::ViewCostAndProfit).is_ok() {
        Ok(serde_json::to_value(SaleOutcomeWithCostDto::from(outcome)).expect("json"))
    } else {
        Ok(serde_json::to_value(SaleOutcomePublicDto::from(outcome)).expect("json"))
    }
}

/// Attach an explicit customer link to a sale (`spec:178`, CUST-05).
///
/// One-time and seller-gated: a linked sale keeps its relation, and a second
/// link is refused with `SALE_CUSTOMER_ALREADY_LINKED` rather than rewriting
/// history. Registration in `lib.rs` arrives with the P4 command batch.
#[tauri::command]
pub async fn link_sale_customer(
    ctx: Ctx<'_>,
    sale_id: String,
    customer_id: String,
) -> Result<(), SalesCommandError> {
    use_cases::link_sale_customer(&ctx.pool, ctx.tokens.as_ref(), &sale_id, &customer_id).await?;
    Ok(())
}

/// Keep a free-text customer name on an unlinked sale (`spec:178`).
///
/// Only sales with no explicit link take a snapshot. Registration in `lib.rs`
/// arrives with the P4 command batch.
#[tauri::command]
pub async fn set_sale_customer_name(
    ctx: Ctx<'_>,
    sale_id: String,
    name: String,
) -> Result<(), SalesCommandError> {
    use_cases::set_sale_customer_name(&ctx.pool, ctx.tokens.as_ref(), &sale_id, &name).await?;
    Ok(())
}