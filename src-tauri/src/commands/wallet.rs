//! Tauri commands for shop wallets and the services ledger (Plan item 1.10, `ADR-025`).
//!
//! Transport boundaries only. No SQL or business rules appear here, and no
//! command accepts a session, token, role, or user id: the active operator is
//! resolved from the OS credential store inside the service layer.

use serde::Serialize;
use tauri::State;

use crate::domain::wallet::{
    ServicesWindowTotals, WalletOpRecord, WalletPeriodStats, WalletRecord, WalletSummary,
};
use crate::services::identity::IdentityContext;
use crate::services::wallet::{
    self as use_cases, UpdateWalletInput, WalletServiceError, WalletsOverview,
};

type Ctx<'a> = State<'a, IdentityContext>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletCommandError {
    pub code: &'static str,
}

impl From<WalletServiceError> for WalletCommandError {
    fn from(error: WalletServiceError) -> Self {
        Self { code: error.code() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletRecordDto {
    pub id: String,
    pub name: String,
    /// The company this number belongs to; `None` when the wallet stands on its own.
    pub company: Option<String>,
    pub number: String,
    pub color: String,
    pub opening_balance_minor: i64,
    pub min_alert_minor: i64,
    pub max_limit_minor: i64,
    pub daily_limit_minor: i64,
    pub pay_method: Option<String>,
    pub sort: i64,
    pub hidden: bool,
    pub is_custom: bool,
    pub created_at: i64,
}

impl From<WalletRecord> for WalletRecordDto {
    fn from(w: WalletRecord) -> Self {
        Self {
            id: w.id.as_str().to_owned(),
            name: w.name.as_str().to_owned(),
            company: w.company,
            number: w.number,
            color: w.color,
            opening_balance_minor: w.opening_balance_minor,
            min_alert_minor: w.min_alert_minor,
            max_limit_minor: w.max_limit_minor,
            daily_limit_minor: w.daily_limit_minor,
            pay_method: w.pay_method.map(|m| m.as_str().to_owned()),
            sort: w.sort,
            hidden: w.hidden,
            is_custom: w.is_custom,
            created_at: w.created_at.as_millis(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletPeriodStatsDto {
    pub wallet_id: String,
    pub ops_count: u64,
    pub dep_count: u64,
    pub dep_minor: i64,
    pub wit_count: u64,
    pub wit_minor: i64,
    pub fees_minor: i64,
    pub used_minor: i64,
    pub sales_in_minor: i64,
}

impl From<WalletPeriodStats> for WalletPeriodStatsDto {
    fn from(s: WalletPeriodStats) -> Self {
        Self {
            wallet_id: s.wallet_id.as_str().to_owned(),
            ops_count: s.ops_count,
            dep_count: s.dep_count,
            dep_minor: s.dep_minor,
            wit_count: s.wit_count,
            wit_minor: s.wit_minor,
            fees_minor: s.fees_minor,
            used_minor: s.used_minor,
            sales_in_minor: s.sales_in_minor,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletSummaryDto {
    pub wallet: WalletRecordDto,
    pub balance_minor: i64,
    pub state: String,
    pub today: WalletPeriodStatsDto,
    pub period: WalletPeriodStatsDto,
}

impl From<WalletSummary> for WalletSummaryDto {
    fn from(s: WalletSummary) -> Self {
        Self {
            wallet: s.wallet.into(),
            balance_minor: s.balance_minor,
            state: s.state.as_str().to_owned(),
            today: s.today.into(),
            period: s.period.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletOpDto {
    pub id: String,
    pub wallet_id: Option<String>,
    pub to_wallet_id: Option<String>,
    pub kind: String,
    pub via: Option<String>,
    pub service_type: Option<String>,
    pub reference: Option<String>,
    pub amount_minor: i64,
    pub fee_minor: i64,
    pub drawer_delta_minor: i64,
    pub note: Option<String>,
    pub created_by: String,
    pub created_at: i64,
    pub voided_by: Option<String>,
    pub voided_at: Option<i64>,
    pub void_reason: Option<String>,
}

impl From<WalletOpRecord> for WalletOpDto {
    fn from(op: WalletOpRecord) -> Self {
        let drawer_delta_minor = op.drawer_delta();
        Self {
            id: op.id.as_str().to_owned(),
            wallet_id: op.wallet_id.map(|w| w.as_str().to_owned()),
            to_wallet_id: op.to_wallet_id.map(|w| w.as_str().to_owned()),
            kind: op.kind.as_str().to_owned(),
            via: op.via.map(|v| v.as_str().to_owned()),
            service_type: op.service_type,
            reference: op.reference,
            amount_minor: op.amount_minor,
            fee_minor: op.fee_minor,
            drawer_delta_minor,
            note: op.note,
            created_by: op.created_by.as_str(),
            created_at: op.created_at.as_millis(),
            voided_by: op.voided_by.map(|u| u.as_str()),
            voided_at: op.voided_at.map(|ts| ts.as_millis()),
            void_reason: op.void_reason,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicesWindowTotalsDto {
    pub services_count: u64,
    pub services_fee_minor: i64,
    pub services_cash_in_minor: i64,
    pub services_cash_out_minor: i64,
    pub wallet_drawer_net_minor: i64,
}

impl From<ServicesWindowTotals> for ServicesWindowTotalsDto {
    fn from(s: ServicesWindowTotals) -> Self {
        Self {
            services_count: s.services_count,
            services_fee_minor: s.services_fee_minor,
            services_cash_in_minor: s.services_cash_in_minor,
            services_cash_out_minor: s.services_cash_out_minor,
            wallet_drawer_net_minor: s.wallet_drawer_net_minor,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletsOverviewDto {
    pub wallets: Vec<WalletSummaryDto>,
    pub ops: Vec<WalletOpDto>,
    pub services_window: ServicesWindowTotalsDto,
}

impl From<WalletsOverview> for WalletsOverviewDto {
    fn from(o: WalletsOverview) -> Self {
        Self {
            wallets: o.wallets.into_iter().map(Into::into).collect(),
            ops: o.ops.into_iter().map(Into::into).collect(),
            services_window: o.services_window.into(),
        }
    }
}

/// Read all wallets (with live balances and period stats), operations log, and services window summary.
#[tauri::command]
pub async fn wallets_overview(
    ctx: Ctx<'_>,
    today_from_ms: i64,
    period_from_ms: i64,
    period_to_ms: i64,
    wallet_id: Option<String>,
    limit: Option<u32>,
) -> Result<WalletsOverviewDto, WalletCommandError> {
    let overview = use_cases::wallets_overview(
        &ctx.pool,
        ctx.tokens.as_ref(),
        today_from_ms,
        period_from_ms,
        period_to_ms,
        wallet_id.as_deref(),
        limit.unwrap_or(100),
    )
    .await?;
    Ok(overview.into())
}

/// Record a customer wallet operation (`deposit` or `withdraw`) with a typed commission (`fee_minor`).
#[tauri::command]
pub async fn record_wallet_op(
    ctx: Ctx<'_>,
    wallet_id: String,
    kind: String,
    amount_minor: i64,
    fee_minor: i64,
    note: Option<String>,
) -> Result<WalletOpDto, WalletCommandError> {
    let op = use_cases::record_wallet_op(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &wallet_id,
        &kind,
        amount_minor,
        fee_minor,
        note.as_deref(),
    )
    .await?;
    Ok(op.into())
}

/// Record a quick service operation (`bill`, `card`, or `software`).
#[tauri::command]
pub async fn record_service_op(
    ctx: Ctx<'_>,
    kind: String,
    service_type: String,
    reference: Option<String>,
    amount_minor: i64,
    fee_minor: i64,
    note: Option<String>,
) -> Result<WalletOpDto, WalletCommandError> {
    let op = use_cases::record_service_op(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &kind,
        &service_type,
        reference.as_deref(),
        amount_minor,
        fee_minor,
        note.as_deref(),
    )
    .await?;
    Ok(op.into())
}

/// Record an owner wallet movement (`topup`, `unload`, or `move`).
#[tauri::command]
pub async fn record_wallet_movement(
    ctx: Ctx<'_>,
    kind: String,
    wallet_id: String,
    to_wallet_id: Option<String>,
    via: Option<String>,
    amount_minor: i64,
    note: Option<String>,
) -> Result<WalletOpDto, WalletCommandError> {
    let op = use_cases::record_wallet_movement(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &kind,
        &wallet_id,
        to_wallet_id.as_deref(),
        via.as_deref(),
        amount_minor,
        note.as_deref(),
    )
    .await?;
    Ok(op.into())
}

/// Reconcile a wallet's balance against its real app balance (`adjust`, owner only).
#[tauri::command]
pub async fn reconcile_wallet(
    ctx: Ctx<'_>,
    wallet_id: String,
    real_balance_minor: i64,
    reason: String,
    note: Option<String>,
) -> Result<Option<WalletOpDto>, WalletCommandError> {
    let op = use_cases::reconcile_wallet(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &wallet_id,
        real_balance_minor,
        &reason,
        note.as_deref(),
    )
    .await?;
    Ok(op.map(Into::into))
}

/// Void a recorded operation with a reason (owner only).
#[tauri::command]
pub async fn void_wallet_op(
    ctx: Ctx<'_>,
    op_id: String,
    reason: String,
) -> Result<WalletOpDto, WalletCommandError> {
    let op = use_cases::void_wallet_op(&ctx.pool, ctx.tokens.as_ref(), &op_id, &reason).await?;
    Ok(op.into())
}

/// Create a custom shop wallet (owner only).
#[tauri::command]
pub async fn create_wallet(
    ctx: Ctx<'_>,
    name: String,
    color: String,
    number: Option<String>,
    company: Option<String>,
) -> Result<WalletRecordDto, WalletCommandError> {
    let wallet = use_cases::create_wallet(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &name,
        &color,
        number.as_deref(),
        company.as_deref(),
    )
    .await?;
    Ok(wallet.into())
}

/// One wallet number the pay screen can choose to take a sale's money (`ADR-040`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentWalletDto {
    pub id: String,
    pub name: String,
    pub number: String,
}

impl From<WalletRecord> for PaymentWalletDto {
    fn from(w: WalletRecord) -> Self {
        Self {
            id: w.id.as_str().to_owned(),
            name: w.name.as_str().to_owned(),
            number: w.number,
        }
    }
}

/// The numbers that can receive a sale paid with this method. One entry means there is
/// nothing to choose, which is how every shop except a multi-number one sees it.
#[tauri::command]
pub async fn payment_wallet_candidates(
    ctx: Ctx<'_>,
    method: String,
) -> Result<Vec<PaymentWalletDto>, WalletCommandError> {
    let wallets =
        use_cases::payment_wallet_candidates(&ctx.pool, ctx.tokens.as_ref(), &method).await?;
    Ok(wallets.into_iter().map(PaymentWalletDto::from).collect())
}

/// Update an existing shop wallet's configuration (owner only).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_wallet(
    ctx: Ctx<'_>,
    wallet_id: String,
    name: String,
    number: String,
    color: String,
    opening_balance_minor: i64,
    min_alert_minor: i64,
    max_limit_minor: i64,
    daily_limit_minor: i64,
    pay_method: Option<String>,
    company: Option<String>,
    sort: i64,
    hidden: bool,
) -> Result<WalletRecordDto, WalletCommandError> {
    let wallet = use_cases::update_wallet(
        &ctx.pool,
        ctx.tokens.as_ref(),
        UpdateWalletInput {
            wallet_id,
            name,
            number,
            color,
            opening_balance_minor,
            min_alert_minor,
            max_limit_minor,
            daily_limit_minor,
            pay_method,
            company,
            sort,
            hidden,
        },
    )
    .await?;
    Ok(wallet.into())
}

/// Delete an unused custom shop wallet (owner only).
#[tauri::command]
pub async fn delete_wallet(ctx: Ctx<'_>, wallet_id: String) -> Result<(), WalletCommandError> {
    use_cases::delete_wallet(&ctx.pool, ctx.tokens.as_ref(), &wallet_id).await?;
    Ok(())
}
