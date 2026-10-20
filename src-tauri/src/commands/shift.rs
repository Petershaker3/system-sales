//! Tauri commands for shifts, drawer expenses, and cash movements (Plan item 1.9, `ADR-024`).
//!
//! Transport boundary only: no SQL and no session construction appears here.

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::domain::shift::{
    CashMovementRecord, ExpenseRecord, ShiftRecord, ShiftSummary, ShiftTotals,
};
use crate::services::identity::IdentityContext;
use crate::services::shift::{
    self as use_cases, CurrentShiftState, ExpenseOverview, ExpenseRow, ShiftServiceError,
};

type Ctx<'a> = State<'a, IdentityContext>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftCommandError {
    pub code: &'static str,
}

impl From<ShiftServiceError> for ShiftCommandError {
    fn from(error: ShiftServiceError) -> Self {
        Self { code: error.code() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftRecordDto {
    pub id: String,
    pub shift_number: u64,
    pub status: String,
    pub opening_cash_minor: i64,
    pub expected_cash_minor: Option<i64>,
    pub counted_cash_minor: Option<i64>,
    pub difference_minor: Option<i64>,
    pub close_note: Option<String>,
    pub opened_by: String,
    pub opened_at: i64,
    pub closed_by: Option<String>,
    pub closed_at: Option<i64>,
}

impl From<ShiftRecord> for ShiftRecordDto {
    fn from(s: ShiftRecord) -> Self {
        Self {
            id: s.id.as_str().to_owned(),
            shift_number: s.shift_number,
            status: s.status.as_str().to_owned(),
            opening_cash_minor: s.opening_cash.as_minor(),
            expected_cash_minor: s.expected_cash_minor,
            counted_cash_minor: s.counted_cash.map(|c| c.as_minor()),
            difference_minor: s.difference_minor,
            close_note: s.close_note.map(|n| n.as_str().to_owned()),
            opened_by: s.opened_by.as_str(),
            opened_at: s.opened_at.as_millis(),
            closed_by: s.closed_by.map(|u| u.as_str()),
            closed_at: s.closed_at.map(|ts| ts.as_millis()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftTotalsDto {
    pub opening_cash_minor: i64,
    pub cash_sales_minor: i64,
    pub vf_sales_minor: i64,
    pub instapay_sales_minor: i64,
    pub card_sales_minor: i64,
    pub install_sales_minor: i64,
    pub credit_sales_minor: i64,
    pub sales_total_minor: i64,
    pub sales_cost_minor: i64,
    pub sales_count: u64,
    pub customer_cash_in_minor: i64,
    pub services_count: u64,
    pub services_fee_minor: i64,
    pub services_cash_in_minor: i64,
    pub services_cash_out_minor: i64,
    pub wallet_drawer_net_minor: i64,
    pub cash_in_minor: i64,
    pub owner_draw_minor: i64,
    pub expenses_minor: i64,
    pub expected_cash_minor: i64,
    pub gross_profit_minor: i64,
    pub net_profit_minor: i64,
}

impl From<ShiftTotals> for ShiftTotalsDto {
    fn from(t: ShiftTotals) -> Self {
        Self {
            opening_cash_minor: t.opening_cash_minor,
            cash_sales_minor: t.cash_sales_minor,
            vf_sales_minor: t.vf_sales_minor,
            instapay_sales_minor: t.instapay_sales_minor,
            card_sales_minor: t.card_sales_minor,
            install_sales_minor: t.install_sales_minor,
            credit_sales_minor: t.credit_sales_minor,
            sales_total_minor: t.sales_total_minor,
            sales_cost_minor: t.sales_cost_minor,
            sales_count: t.sales_count,
            customer_cash_in_minor: t.customer_cash_in_minor,
            services_count: t.services_count,
            services_fee_minor: t.services_fee_minor,
            services_cash_in_minor: t.services_cash_in_minor,
            services_cash_out_minor: t.services_cash_out_minor,
            wallet_drawer_net_minor: t.wallet_drawer_net_minor,
            cash_in_minor: t.cash_in_minor,
            owner_draw_minor: t.owner_draw_minor,
            expenses_minor: t.expenses_minor,
            expected_cash_minor: t.expected_cash_minor,
            gross_profit_minor: t.gross_profit_minor,
            net_profit_minor: t.net_profit_minor,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseRecordDto {
    pub id: String,
    /// `null` when the money did not leave the drawer (`ADR-043`).
    pub shift_id: Option<String>,
    /// `"drawer"` or `"outside"` — where the money came from.
    pub paid_from: String,
    pub category: String,
    pub amount_minor: i64,
    pub note: Option<String>,
    pub created_by: String,
    pub created_at: i64,
}

impl From<ExpenseRecord> for ExpenseRecordDto {
    fn from(e: ExpenseRecord) -> Self {
        Self {
            id: e.id.as_str().to_owned(),
            shift_id: e.shift_id.map(|id| id.as_str().to_owned()),
            paid_from: e.paid_from.as_str().to_owned(),
            category: e.category.as_str().to_owned(),
            amount_minor: e.amount.as_minor(),
            note: e.note.map(|n| n.as_str().to_owned()),
            created_by: e.created_by.as_str(),
            created_at: e.created_at.as_millis(),
        }
    }
}

/// One row in the expenses section: the expense and who recorded it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseRowDto {
    #[serde(flatten)]
    pub expense: ExpenseRecordDto,
    pub created_by_name: String,
}

impl From<ExpenseRow> for ExpenseRowDto {
    fn from(row: ExpenseRow) -> Self {
        Self {
            expense: row.record.into(),
            created_by_name: row.created_by_name,
        }
    }
}

/// What one category cost in the window the section is showing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseCategoryTotalDto {
    pub category: String,
    pub total_minor: i64,
    pub count: u64,
}

/// The section's answer for one window (`ADR-043`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseOverviewDto {
    pub rows: Vec<ExpenseRowDto>,
    pub total_minor: i64,
    pub drawer_minor: i64,
    pub outside_minor: i64,
    pub count: u64,
    pub by_category: Vec<ExpenseCategoryTotalDto>,
    pub known_categories: Vec<String>,
    pub open_shift_id: Option<String>,
}

impl From<ExpenseOverview> for ExpenseOverviewDto {
    fn from(o: ExpenseOverview) -> Self {
        Self {
            rows: o.rows.into_iter().map(Into::into).collect(),
            total_minor: o.total_minor,
            drawer_minor: o.drawer_minor,
            outside_minor: o.outside_minor,
            count: o.count,
            by_category: o
                .by_category
                .into_iter()
                .map(|entry| ExpenseCategoryTotalDto {
                    category: entry.category,
                    total_minor: entry.total_minor,
                    count: entry.count,
                })
                .collect(),
            known_categories: o.known_categories,
            open_shift_id: o.open_shift_id,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashMovementRecordDto {
    pub id: String,
    pub shift_id: String,
    pub kind: String,
    pub amount_minor: i64,
    pub reason: String,
    pub created_by: String,
    pub created_at: i64,
}

impl From<CashMovementRecord> for CashMovementRecordDto {
    fn from(m: CashMovementRecord) -> Self {
        Self {
            id: m.id.as_str().to_owned(),
            shift_id: m.shift_id.as_str().to_owned(),
            kind: m.kind.as_str().to_owned(),
            amount_minor: m.amount.as_minor(),
            reason: m.reason.as_str().to_owned(),
            created_by: m.created_by.as_str(),
            created_at: m.created_at.as_millis(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSummaryDto {
    pub shift: ShiftRecordDto,
    pub totals: ShiftTotalsDto,
    pub expenses: Vec<ExpenseRecordDto>,
    pub cash_movements: Vec<CashMovementRecordDto>,
}

impl From<ShiftSummary> for ShiftSummaryDto {
    fn from(s: ShiftSummary) -> Self {
        Self {
            shift: s.shift.into(),
            totals: s.totals.into(),
            expenses: s.expenses.into_iter().map(Into::into).collect(),
            cash_movements: s.cash_movements.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentShiftStateDto {
    pub open_shift: Option<ShiftSummaryDto>,
    pub last_closed_shift: Option<ShiftRecordDto>,
    pub recent_closed_shifts: Vec<ShiftRecordDto>,
}

impl From<CurrentShiftState> for CurrentShiftStateDto {
    fn from(state: CurrentShiftState) -> Self {
        Self {
            open_shift: state.open_shift.map(Into::into),
            last_closed_shift: state.last_closed_shift.map(Into::into),
            recent_closed_shifts: state
                .recent_closed_shifts
                .into_iter()
                .map(Into::into)
                .collect(),
        }
    }
}

/// Read the currently open shift (with live totals, expenses, and cash movements),
/// plus the last closed shift and recent closed shifts.
#[tauri::command]
pub async fn current_shift_summary(
    ctx: Ctx<'_>,
) -> Result<CurrentShiftStateDto, ShiftCommandError> {
    let state = use_cases::current_shift_summary(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(state.into())
}

/// Open a new shift with an opening cash drawer balance in minor units (piastres).
#[tauri::command]
pub async fn open_shift(
    ctx: Ctx<'_>,
    app: AppHandle,
    opening_cash_minor: i64,
) -> Result<ShiftSummaryDto, ShiftCommandError> {
    let summary =
        use_cases::open_shift(&ctx.pool, ctx.tokens.as_ref(), opening_cash_minor).await?;
    if let Ok(data_dir) = app.path().app_local_data_dir() {
        let _ = crate::services::backup::auto::trigger_shift_backup(
            &ctx.pool,
            &data_dir,
            summary.shift.shift_number,
            true,
        )
        .await;
    }
    Ok(summary.into())
}

/// Record an expense that may have been paid from the drawer or from elsewhere
/// (`ADR-043`). Returns the row that was written, so the section can show it at once.
#[tauri::command]
pub async fn record_shop_expense(
    ctx: Ctx<'_>,
    category: String,
    amount_minor: i64,
    note: Option<String>,
    paid_from: String,
) -> Result<ExpenseRecordDto, ShiftCommandError> {
    let row = use_cases::record_shop_expense(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &category,
        amount_minor,
        note.as_deref(),
        &paid_from,
    )
    .await?;
    Ok(row.into())
}

/// The expenses section: one period's rows and the totals they add up to (`ADR-043`).
///
/// `from_ms`/`to_ms` are inclusive; both `None` is «الكل». The bounds are computed by
/// the screen, exactly as the repairs screen computes its own (`ADR-036`), so the
/// section and the ledger can never disagree about where a day starts.
#[tauri::command]
pub async fn expenses_overview(
    ctx: Ctx<'_>,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
) -> Result<ExpenseOverviewDto, ShiftCommandError> {
    let overview = use_cases::expenses_overview(&ctx.pool, ctx.tokens.as_ref(), from_ms, to_ms)
        .await?;
    Ok(overview.into())
}

/// Record a cash expense from the drawer during the currently open shift.
#[tauri::command]
pub async fn record_expense(
    ctx: Ctx<'_>,
    category: String,
    amount_minor: i64,
    note: Option<String>,
) -> Result<ShiftSummaryDto, ShiftCommandError> {
    let summary = use_cases::record_expense(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &category,
        amount_minor,
        note.as_deref(),
    )
    .await?;
    Ok(summary.into())
}

/// Record a non-sale cash movement (`cash_in` or `owner_draw`) on the currently open shift.
#[tauri::command]
pub async fn record_cash_movement(
    ctx: Ctx<'_>,
    kind: String,
    amount_minor: i64,
    reason: String,
) -> Result<ShiftSummaryDto, ShiftCommandError> {
    let summary = use_cases::record_cash_movement(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &kind,
        amount_minor,
        &reason,
    )
    .await?;
    Ok(summary.into())
}

/// Close the currently open shift with counted cash and an optional close note.
#[tauri::command]
pub async fn close_shift(
    ctx: Ctx<'_>,
    app: AppHandle,
    counted_cash_minor: i64,
    close_note: Option<String>,
) -> Result<ShiftSummaryDto, ShiftCommandError> {
    let summary = use_cases::close_shift(
        &ctx.pool,
        ctx.tokens.as_ref(),
        counted_cash_minor,
        close_note.as_deref(),
    )
    .await?;
    if let Ok(data_dir) = app.path().app_local_data_dir() {
        let _ = crate::services::backup::auto::trigger_shift_backup(
            &ctx.pool,
            &data_dir,
            summary.shift.shift_number,
            false,
        )
        .await;
    }
    Ok(summary.into())
}
