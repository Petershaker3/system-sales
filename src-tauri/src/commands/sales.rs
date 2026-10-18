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
use crate::domain::sales::{SalePaymentInput, SaleReturnLineInput, WarrantyDate};
use crate::services::identity::{session as identity_session};
use crate::services::identity::IdentityContext;
use crate::services::sales::{
    self as use_cases, ReturnableSaleInspection, SaleExchangeOutcome, SaleLineWithUnitInput,
    SaleOutcome, SaleReturnOutcome, SaleServiceError,
};

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
    #[serde(default)]
    pub discount_minor: Option<i64>,
}

impl SaleLineInputDto {
    /// Validate one line's warranty text into the domain's calendar day.
    ///
    /// Falls rather than defaulting: a mistyped date is the operator's to see
    /// and fix, and inventing a coverage the shop never agreed to is exactly the
    /// claim this software must not make.
    fn into_input_and_discount(self) -> Result<(SaleLineWithUnitInput, i64), SalesCommandError> {
        let warranty_start = parse_warranty(self.warranty_start)?;
        let warranty_end = parse_warranty(self.warranty_end)?;
        Ok((
            SaleLineWithUnitInput {
                product_id: self.product_id,
                quantity: self.quantity,
                warranty_start,
                warranty_end,
                imei: self.imei,
            },
            self.discount_minor.unwrap_or(0),
        ))
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

/// Record one sale (single payment or split payments, with optional customer link
/// and optional line / invoice discounts).
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
    invoice_discount_minor: Option<i64>,
) -> Result<serde_json::Value, SalesCommandError> {
    let mut mapped_lines = Vec::with_capacity(lines.len());
    let mut line_discounts_minor = Vec::with_capacity(lines.len());
    for dto in lines {
        let (input, discount_minor) = dto.into_input_and_discount()?;
        mapped_lines.push(input);
        line_discounts_minor.push(discount_minor);
    }
    let mapped_payments: Option<Vec<SalePaymentInput>> =
        payments.map(|list| list.into_iter().map(SalePaymentInput::from).collect());
    let outcome = use_cases::record_sale_with_discounts(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &mapped_lines,
        confirmed_total_minor,
        mapped_payments.as_deref(),
        customer_id.as_deref(),
        invoice_discount_minor.unwrap_or(0),
        &line_discounts_minor,
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

// ---------------------------------------------------------------------------
// Plan item 1.11 — Partial returns, exchanges, and damaged stock (`ADR-026`)
// ---------------------------------------------------------------------------

/// Input DTO for one line in a partial or full return (`ADR-026`).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleReturnLineInputDto {
    pub sale_line_id: String,
    pub quantity: i64,
    pub condition: String,
}

impl From<SaleReturnLineInputDto> for SaleReturnLineInput {
    fn from(dto: SaleReturnLineInputDto) -> Self {
        Self {
            sale_line_id: dto.sale_line_id,
            quantity: dto.quantity,
            condition: dto.condition,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleReturnOutcomePublicDto {
    pub return_id: String,
    pub return_sale_id: String,
    pub return_reference: String,
    pub original_sale_id: String,
    pub original_reference: String,
    pub refund_minor: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleReturnOutcomeWithCostDto {
    pub return_id: String,
    pub return_sale_id: String,
    pub return_reference: String,
    pub original_sale_id: String,
    pub original_reference: String,
    pub refund_minor: i64,
    pub cost_returned_minor: i64,
    pub damaged_cost_minor: i64,
}

impl From<SaleReturnOutcome> for SaleReturnOutcomePublicDto {
    fn from(v: SaleReturnOutcome) -> Self {
        Self {
            return_id: v.return_id,
            return_sale_id: v.return_sale_id,
            return_reference: v.return_reference,
            original_sale_id: v.original_sale_id,
            original_reference: v.original_reference,
            refund_minor: v.refund_minor,
        }
    }
}

impl From<SaleReturnOutcome> for SaleReturnOutcomeWithCostDto {
    fn from(v: SaleReturnOutcome) -> Self {
        Self {
            return_id: v.return_id,
            return_sale_id: v.return_sale_id,
            return_reference: v.return_reference,
            original_sale_id: v.original_sale_id,
            original_reference: v.original_reference,
            refund_minor: v.refund_minor,
            cost_returned_minor: v.cost_returned_minor,
            damaged_cost_minor: v.damaged_cost_minor,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleExchangeOutcomePublicDto {
    pub return_outcome: SaleReturnOutcomePublicDto,
    pub sale_outcome: SaleOutcomePublicDto,
    pub net_difference_minor: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleExchangeOutcomeWithCostDto {
    pub return_outcome: SaleReturnOutcomeWithCostDto,
    pub sale_outcome: SaleOutcomeWithCostDto,
    pub net_difference_minor: i64,
}

impl From<SaleExchangeOutcome> for SaleExchangeOutcomePublicDto {
    fn from(v: SaleExchangeOutcome) -> Self {
        Self {
            return_outcome: SaleReturnOutcomePublicDto::from(v.return_outcome),
            sale_outcome: SaleOutcomePublicDto::from(v.sale_outcome),
            net_difference_minor: v.net_difference_minor,
        }
    }
}

impl From<SaleExchangeOutcome> for SaleExchangeOutcomeWithCostDto {
    fn from(v: SaleExchangeOutcome) -> Self {
        Self {
            return_outcome: SaleReturnOutcomeWithCostDto::from(v.return_outcome),
            sale_outcome: SaleOutcomeWithCostDto::from(v.sale_outcome),
            net_difference_minor: v.net_difference_minor,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnableSaleLineDto {
    pub line_id: String,
    pub line_no: i64,
    pub product_id: String,
    pub product_name: String,
    pub quantity: i64,
    pub already_returned_qty: i64,
    pub remaining_qty: i64,
    pub unit_selling_price_minor: i64,
    pub discount_minor: i64,
    pub line_total_minor: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_cost_minor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_cost_minor: Option<i64>,
    pub warranty_start: Option<String>,
    pub warranty_end: Option<String>,
    pub unit_id: Option<String>,
    pub imei: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnableSalePaymentDto {
    pub method: String,
    pub amount_minor: i64,
    pub reference: Option<String>,
    pub already_refunded_minor: i64,
    pub remaining_minor: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleReturnSummaryDto {
    pub id: String,
    pub original_sale_id: String,
    pub return_sale_id: String,
    pub return_reference: String,
    pub exchange_sale_id: Option<String>,
    pub exchange_reference: Option<String>,
    pub refund_minor: i64,
    pub reason: String,
    pub occurred_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnableSaleInspectionDto {
    pub sale_id: String,
    pub reference: String,
    pub occurred_at: i64,
    pub sold_by: String,
    pub customer_id: Option<String>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub total_minor: i64,
    pub discount_minor: i64,
    pub already_refunded_minor: i64,
    pub remaining_refundable_minor: i64,
    pub is_cancelled: bool,
    pub lines: Vec<ReturnableSaleLineDto>,
    pub payments: Vec<ReturnableSalePaymentDto>,
    pub returns: Vec<SaleReturnSummaryDto>,
}

impl From<ReturnableSaleInspection> for ReturnableSaleInspectionDto {
    fn from(v: ReturnableSaleInspection) -> Self {
        Self {
            sale_id: v.sale_id,
            reference: v.reference,
            occurred_at: v.occurred_at,
            sold_by: v.sold_by,
            customer_id: v.customer_id,
            customer_name: v.customer_name,
            customer_phone: v.customer_phone,
            total_minor: v.total_minor,
            discount_minor: v.discount_minor,
            already_refunded_minor: v.already_refunded_minor,
            remaining_refundable_minor: v.remaining_refundable_minor,
            is_cancelled: v.is_cancelled,
            lines: v
                .lines
                .into_iter()
                .map(|l| ReturnableSaleLineDto {
                    line_id: l.line_id,
                    line_no: l.line_no,
                    product_id: l.product_id,
                    product_name: l.product_name,
                    quantity: l.quantity,
                    already_returned_qty: l.already_returned_qty,
                    remaining_qty: l.remaining_qty,
                    unit_selling_price_minor: l.unit_selling_price_minor,
                    discount_minor: l.discount_minor,
                    line_total_minor: l.line_total_minor,
                    unit_cost_minor: l.unit_cost_minor,
                    line_cost_minor: l.line_cost_minor,
                    warranty_start: l.warranty_start,
                    warranty_end: l.warranty_end,
                    unit_id: l.unit_id,
                    imei: l.imei,
                })
                .collect(),
            payments: v
                .payments
                .into_iter()
                .map(|p| ReturnableSalePaymentDto {
                    method: p.method,
                    amount_minor: p.amount_minor,
                    reference: p.reference,
                    already_refunded_minor: p.already_refunded_minor,
                    remaining_minor: p.remaining_minor,
                })
                .collect(),
            returns: v
                .returns
                .into_iter()
                .map(|r| SaleReturnSummaryDto {
                    id: r.id,
                    original_sale_id: r.original_sale_id,
                    return_sale_id: r.return_sale_id,
                    return_reference: r.return_reference,
                    exchange_sale_id: r.exchange_sale_id,
                    exchange_reference: r.exchange_reference,
                    refund_minor: r.refund_minor,
                    reason: r.reason,
                    occurred_at: r.occurred_at,
                })
                .collect(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnableSaleSummaryDto {
    pub sale_id: String,
    pub reference: String,
    pub occurred_at: i64,
    pub customer_id: Option<String>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub first_product_name: String,
    pub line_count: i64,
    pub total_minor: i64,
    pub already_refunded_minor: i64,
    pub is_cancelled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DamagedStockRowDto {
    pub id: String,
    pub product_id: String,
    pub product_name: String,
    pub sale_id: String,
    pub sale_reference: String,
    pub return_sale_id: String,
    pub return_reference: String,
    pub sale_line_id: String,
    pub return_line_id: String,
    pub unit_id: Option<String>,
    pub imei: Option<String>,
    pub quantity: i64,
    pub unit_cost_minor: i64,
    pub total_cost_minor: i64,
    pub reason: String,
    pub occurred_at: i64,
}

/// Inspect a sale document by id or reference for partial/full return or exchange (`ADR-026`).
#[tauri::command]
pub async fn inspect_sale_for_return(
    ctx: Ctx<'_>,
    sale_id_or_reference: String,
) -> Result<ReturnableSaleInspectionDto, SalesCommandError> {
    let info =
        use_cases::inspect_sale_for_return(&ctx.pool, ctx.tokens.as_ref(), &sale_id_or_reference)
            .await?;
    Ok(ReturnableSaleInspectionDto::from(info))
}

/// List recent live sales matching an optional query for the return/exchange modal (`ADR-026`).
#[tauri::command]
pub async fn list_recent_sales_for_return(
    ctx: Ctx<'_>,
    query: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ReturnableSaleSummaryDto>, SalesCommandError> {
    let rows = use_cases::list_recent_sales_for_return(
        &ctx.pool,
        ctx.tokens.as_ref(),
        query.as_deref(),
        limit,
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ReturnableSaleSummaryDto {
            sale_id: r.sale_id,
            reference: r.reference,
            occurred_at: r.occurred_at,
            customer_id: r.customer_id,
            customer_name: r.customer_name,
            customer_phone: r.customer_phone,
            first_product_name: r.first_product_name,
            line_count: r.line_count,
            total_minor: r.total_minor,
            already_refunded_minor: r.already_refunded_minor,
            is_cancelled: r.is_cancelled,
        })
        .collect())
}

/// Record a partial or full return of invoice lines (`ADR-026`).
#[tauri::command]
pub async fn record_sale_return(
    ctx: Ctx<'_>,
    original_sale_id: String,
    return_lines: Vec<SaleReturnLineInputDto>,
    reason: String,
    refund_payments: Option<Vec<SalePaymentInputDto>>,
) -> Result<serde_json::Value, SalesCommandError> {
    let mapped_lines: Vec<SaleReturnLineInput> =
        return_lines.into_iter().map(SaleReturnLineInput::from).collect();
    let mapped_payments: Option<Vec<SalePaymentInput>> =
        refund_payments.map(|list| list.into_iter().map(SalePaymentInput::from).collect());

    let outcome = use_cases::record_sale_return(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &original_sale_id,
        &mapped_lines,
        &reason,
        mapped_payments.as_deref(),
    )
    .await?;

    let session = identity_session::resolve(&ctx.pool, ctx.tokens.as_ref())
        .await
        .map_err(|_| SalesCommandError {
            code: "IDENTITY_RESOLUTION_FAILED",
        })?;
    if session.authorize(Permission::ViewCostAndProfit).is_ok() {
        Ok(serde_json::to_value(SaleReturnOutcomeWithCostDto::from(outcome)).expect("json"))
    } else {
        Ok(serde_json::to_value(SaleReturnOutcomePublicDto::from(outcome)).expect("json"))
    }
}

/// Record an exchange (partial or full return + new replacement sale in one atomic operation, `ADR-026`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn record_sale_exchange(
    ctx: Ctx<'_>,
    original_sale_id: String,
    return_lines: Vec<SaleReturnLineInputDto>,
    reason: String,
    refund_payments: Option<Vec<SalePaymentInputDto>>,
    new_lines: Vec<SaleLineInputDto>,
    new_invoice_discount_minor: Option<i64>,
    new_payments: Option<Vec<SalePaymentInputDto>>,
    customer_id: Option<String>,
) -> Result<serde_json::Value, SalesCommandError> {
    let mapped_return_lines: Vec<SaleReturnLineInput> =
        return_lines.into_iter().map(SaleReturnLineInput::from).collect();
    let mapped_refund_payments: Option<Vec<SalePaymentInput>> =
        refund_payments.map(|list| list.into_iter().map(SalePaymentInput::from).collect());

    let mut mapped_new_lines = Vec::with_capacity(new_lines.len());
    let mut new_line_discounts_minor = Vec::with_capacity(new_lines.len());
    for dto in new_lines {
        let (input, discount_minor) = dto.into_input_and_discount()?;
        mapped_new_lines.push(input);
        new_line_discounts_minor.push(discount_minor);
    }
    let mapped_new_payments: Option<Vec<SalePaymentInput>> =
        new_payments.map(|list| list.into_iter().map(SalePaymentInput::from).collect());

    let outcome = use_cases::record_sale_exchange(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &original_sale_id,
        &mapped_return_lines,
        &reason,
        mapped_refund_payments.as_deref(),
        &mapped_new_lines,
        &new_line_discounts_minor,
        new_invoice_discount_minor.unwrap_or(0),
        mapped_new_payments.as_deref(),
        customer_id.as_deref(),
    )
    .await?;

    let session = identity_session::resolve(&ctx.pool, ctx.tokens.as_ref())
        .await
        .map_err(|_| SalesCommandError {
            code: "IDENTITY_RESOLUTION_FAILED",
        })?;
    if session.authorize(Permission::ViewCostAndProfit).is_ok() {
        Ok(serde_json::to_value(SaleExchangeOutcomeWithCostDto::from(outcome)).expect("json"))
    } else {
        Ok(serde_json::to_value(SaleExchangeOutcomePublicDto::from(outcome)).expect("json"))
    }
}

/// List rows from `damaged_stock` («مخزون تالف», `ADR-026`).
#[tauri::command]
pub async fn list_damaged_stock(
    ctx: Ctx<'_>,
    limit: Option<u32>,
) -> Result<Vec<DamagedStockRowDto>, SalesCommandError> {
    let rows = use_cases::list_damaged_stock(&ctx.pool, ctx.tokens.as_ref(), limit).await?;
    Ok(rows
        .into_iter()
        .map(|r| DamagedStockRowDto {
            id: r.id,
            product_id: r.product_id,
            product_name: r.product_name,
            sale_id: r.sale_id,
            sale_reference: r.sale_reference,
            return_sale_id: r.return_sale_id,
            return_reference: r.return_reference,
            sale_line_id: r.sale_line_id,
            return_line_id: r.return_line_id,
            unit_id: r.unit_id,
            imei: r.imei,
            quantity: r.quantity,
            unit_cost_minor: r.unit_cost_minor,
            total_cost_minor: r.total_cost_minor,
            reason: r.reason,
            occurred_at: r.occurred_at,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Plan item 1.14 — Sales history & analytics screen (`ADR-029`)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleHistoryLineDto {
    pub line_id: String,
    pub line_no: i64,
    pub product_id: String,
    pub product_name: String,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub parent_category_id: Option<String>,
    pub quantity: i64,
    pub unit_selling_price_minor: i64,
    pub discount_minor: i64,
    pub line_total_minor: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_cost_minor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_cost_minor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_profit_minor: Option<i64>,
    pub warranty_start: Option<String>,
    pub warranty_end: Option<String>,
    pub unit_id: Option<String>,
    pub imei: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleHistoryPaymentDto {
    pub method: String,
    pub amount_minor: i64,
    pub reference: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleHistoryEntryDto {
    pub sale_id: String,
    pub reference: String,
    pub occurred_at: i64,
    pub sold_by: String,
    pub seller_name: String,
    pub customer_id: Option<String>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub lines_subtotal_minor: i64,
    pub discount_minor: i64,
    pub total_minor: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_total_minor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profit_minor: Option<i64>,
    pub already_refunded_minor: i64,
    pub is_cancelled: bool,
    pub lines: Vec<SaleHistoryLineDto>,
    pub payments: Vec<SaleHistoryPaymentDto>,
}

/// List sales history for the Sales screen (`شاشة المبيعات`, `ADR-029`).
#[tauri::command]
pub async fn list_sales_history(
    ctx: Ctx<'_>,
    limit: Option<u32>,
) -> Result<Vec<SaleHistoryEntryDto>, SalesCommandError> {
    let rows = use_cases::list_sales_history(&ctx.pool, ctx.tokens.as_ref(), limit).await?;
    Ok(rows
        .into_iter()
        .map(|r| SaleHistoryEntryDto {
            sale_id: r.sale_id,
            reference: r.reference,
            occurred_at: r.occurred_at,
            sold_by: r.sold_by,
            seller_name: r.seller_name,
            customer_id: r.customer_id,
            customer_name: r.customer_name,
            customer_phone: r.customer_phone,
            lines_subtotal_minor: r.lines_subtotal_minor,
            discount_minor: r.discount_minor,
            total_minor: r.total_minor,
            cost_total_minor: r.cost_total_minor,
            profit_minor: r.profit_minor,
            already_refunded_minor: r.already_refunded_minor,
            is_cancelled: r.is_cancelled,
            lines: r
                .lines
                .into_iter()
                .map(|l| SaleHistoryLineDto {
                    line_id: l.line_id,
                    line_no: l.line_no,
                    product_id: l.product_id,
                    product_name: l.product_name,
                    category_id: l.category_id,
                    category_name: l.category_name,
                    parent_category_id: l.parent_category_id,
                    quantity: l.quantity,
                    unit_selling_price_minor: l.unit_selling_price_minor,
                    discount_minor: l.discount_minor,
                    line_total_minor: l.line_total_minor,
                    unit_cost_minor: l.unit_cost_minor,
                    line_cost_minor: l.line_cost_minor,
                    line_profit_minor: l.line_profit_minor,
                    warranty_start: l.warranty_start,
                    warranty_end: l.warranty_end,
                    unit_id: l.unit_id,
                    imei: l.imei,
                })
                .collect(),
            payments: r
                .payments
                .into_iter()
                .map(|p| SaleHistoryPaymentDto {
                    method: p.method,
                    amount_minor: p.amount_minor,
                    reference: p.reference,
                })
                .collect(),
        })
        .collect())
}