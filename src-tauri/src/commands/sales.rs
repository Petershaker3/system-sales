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

use crate::domain::identity::Permission;
use crate::domain::sales::{SalePaymentInput, WarrantyDate};
use crate::services::identity::{session as identity_session};
use crate::services::identity::IdentityContext;
use crate::services::sales::{self as use_cases, SaleLineWithUnitInput, SaleOutcome, SaleServiceError};

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
///
/// `warrantyStart` / `warrantyEnd` are the operator's own typing (D4), so they
/// arrive as free text and are validated here into [`WarrantyDate`]. An absent or
/// empty field means "no warranty given" — never a default period.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleLineInputDto {
    pub product_id: String,
    pub quantity: i64,
    pub warranty_start: Option<String>,
    pub warranty_end: Option<String>,
    #[serde(default)]
    pub imei: Option<String>,
}

impl SaleLineInputDto {
    /// Validate one line's warranty text into the domain's calendar day.
    ///
    /// Falls rather than defaulting: a mistyped date is the operator's to see
    /// and fix, and inventing a coverage the shop never agreed to is exactly the
    /// claim this software must not make.
    fn into_input(self) -> Result<SaleLineWithUnitInput, SalesCommandError> {
        let warranty_start = parse_warranty(self.warranty_start)?;
        let warranty_end = parse_warranty(self.warranty_end)?;
        Ok(SaleLineWithUnitInput {
            product_id: self.product_id,
            quantity: self.quantity,
            warranty_start,
            warranty_end,
            imei: self.imei,
        })
    }
}

/// An absent or blank field is no warranty; anything else must be a real day.
fn parse_warranty(raw: Option<String>) -> Result<Option<WarrantyDate>, SalesCommandError> {
    match raw.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(day) => WarrantyDate::parse(day)
            .map(Some)
            .map_err(|error| SalesCommandError {
                code: error.code(),
            }),
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

/// One payment row as sent by the frontend (`ADR-020` §2).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalePaymentInputDto {
    pub method: String,
    pub amount_minor: i64,
    #[serde(default)]
    pub reference: Option<String>,
}

impl From<SalePaymentInputDto> for SalePaymentInput {
    fn from(dto: SalePaymentInputDto) -> Self {
        Self {
            method: dto.method,
            amount_minor: dto.amount_minor,
            reference: dto.reference,
        }
    }
}

/// Record one sale (single payment or split payments, with optional customer link).
///
/// The service re-reads prices under a transaction and compares the total
/// against `confirmed_total_minor`. A mismatch aborts the sale with
/// `SALE_PRICE_CHANGED`; prices sent by the client are never trusted.
#[tauri::command]
pub async fn record_sale(
    ctx: Ctx<'_>,
    lines: Vec<SaleLineInputDto>,
    confirmed_total_minor: Option<i64>,
    payments: Option<Vec<SalePaymentInputDto>>,
    customer_id: Option<String>,
) -> Result<serde_json::Value, SalesCommandError> {
    let lines = lines
        .into_iter()
        .map(SaleLineInputDto::into_input)
        .collect::<Result<Vec<SaleLineWithUnitInput>, SalesCommandError>>()?;
    let mapped_payments: Option<Vec<SalePaymentInput>> =
        payments.map(|list| list.into_iter().map(SalePaymentInput::from).collect());
    let outcome = use_cases::record_sale_with_payments(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &lines,
        confirmed_total_minor,
        mapped_payments.as_deref(),
        customer_id.as_deref(),
    )
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