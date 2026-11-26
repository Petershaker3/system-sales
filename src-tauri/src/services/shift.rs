//! Shift, cash drawer, and expenses use cases (Plan item 1.9, `ADR-024`, `PLAN.md` §12).
//!
//! No SQL appears here; persistence queries live in `data/repositories/shift.rs`.

use std::fmt;

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::settings::app_settings as settings_repo;
use crate::data::repositories::shift as repo;
use crate::domain::identity::{DomainError, Permission, Role, Timestamp};
use crate::domain::shift::{
    validate_cash_movement_amount, validate_counted_cash, validate_expense_amount,
    validate_opening_cash, CashMovementId, CashMovementKind, CashMovementReason,
    CashMovementRecord, ExpenseCategory, ExpenseId, ExpenseNote, ExpenseRecord, PaidFrom,
    ShiftCloseNote, ShiftError, ShiftId, ShiftRecord, ShiftStatus, ShiftSummary,
};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// Combined state returned when querying the shop's current shift status.
#[derive(Debug, Clone)]
pub struct CurrentShiftState {
    pub open_shift: Option<ShiftSummary>,
    pub last_closed_shift: Option<ShiftRecord>,
    pub recent_closed_shifts: Vec<ShiftRecord>,
}

/// Service error combining identity/session errors and shift domain errors.
#[derive(Debug)]
pub enum ShiftServiceError {
    Identity(DomainError),
    Shift(ShiftError),
}

impl From<DomainError> for ShiftServiceError {
    fn from(error: DomainError) -> Self {
        Self::Identity(error)
    }
}

impl From<ShiftError> for ShiftServiceError {
    fn from(error: ShiftError) -> Self {
        Self::Shift(error)
    }
}

impl ShiftServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Identity(error) => error.code(),
            Self::Shift(error) => error.code(),
        }
    }
}

impl fmt::Display for ShiftServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Identity(error) => write!(f, "{error}"),
            Self::Shift(error) => write!(f, "{}", error.code()),
        }
    }
}

impl std::error::Error for ShiftServiceError {}

async fn build_summary(
    conn: &mut sqlx::SqliteConnection,
    shift: ShiftRecord,
) -> Result<ShiftSummary, ShiftServiceError> {
    let totals = repo::compute_shift_totals(conn, &shift)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let expenses = repo::list_expenses_for_shift(conn, shift.id.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let cash_movements = repo::list_cash_movements_for_shift(conn, shift.id.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(ShiftSummary {
        shift,
        totals,
        expenses,
        cash_movements,
    })
}

/// Read the currently open shift (with live totals, expenses, and cash movements),
/// plus the last closed shift and recent closed shifts.
pub async fn current_shift_summary(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<CurrentShiftState, ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let open_shift = match repo::find_open_shift(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        Some(shift) => Some(build_summary(&mut conn, shift).await?),
        None => None,
    };

    let last_closed_shift = repo::find_last_closed_shift(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let recent_closed_shifts = repo::list_recent_closed_shifts(&mut conn, 10)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(CurrentShiftState {
        open_shift,
        last_closed_shift,
        recent_closed_shifts,
    })
}

/// Open a new shift with an opening cash drawer balance in minor units (piastres).
pub async fn open_shift(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    opening_cash_minor: i64,
) -> Result<ShiftSummary, ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let opening_cash = validate_opening_cash(opening_cash_minor)?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    if repo::find_open_shift(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .is_some()
    {
        return Err(ShiftError::AlreadyOpen.into());
    }

    let shift_number = repo::next_shift_number(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let shift = ShiftRecord {
        id: ShiftId::generate(),
        shift_number,
        status: ShiftStatus::Open,
        opening_cash,
        expected_cash_minor: None,
        counted_cash: None,
        difference_minor: None,
        close_note: None,
        opened_by: actor,
        opened_at: now,
        closed_by: None,
        closed_at: None,
    };

    repo::insert_open_shift(&mut tx, &shift)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    // The new opening is a fresh physical observation. A previous counted
    // close is retained for handover comparison, never silently inherited.
    let previous = repo::find_last_closed_shift(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?;
    repo::insert_opening_observation(&mut tx, &shift, previous.as_ref()).await.map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::SHIFT_OPENED,
        now,
        Some(
            serde_json::json!({
                "shift_id": shift.id.as_str(),
                "shift_number": shift.shift_number,
                "opening_cash_minor": shift.opening_cash.as_minor(),
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    let summary = build_summary(&mut tx, shift).await?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(summary)
}

/// One row of the expenses section: the stored expense and who recorded it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpenseRow {
    pub record: ExpenseRecord,
    pub created_by_name: String,
}

/// What one category cost inside the period the section is showing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpenseCategoryTotal {
    pub category: String,
    pub total_minor: i64,
    pub count: u64,
}

/// The expenses section's answer for one window (`ADR-043`).
///
/// The three totals are what a shopkeeper actually asks: how much left the shop, how
/// much of that came out of the till, and how much was paid from anywhere else. They
/// are computed from the same rows that are returned, so a total can never disagree
/// with the list underneath it.
#[derive(Debug, Clone)]
pub struct ExpenseOverview {
    pub rows: Vec<ExpenseRow>,
    pub total_minor: i64,
    pub drawer_minor: i64,
    pub outside_minor: i64,
    pub count: u64,
    pub by_category: Vec<ExpenseCategoryTotal>,
    /// Categories this shop has used before, for the quick buttons in the form.
    pub known_categories: Vec<String>,
    /// Set while a shift is open, so the form can offer «من الدرج» honestly.
    pub open_shift_id: Option<String>,
}

/// Record an expense that may or may not have left the drawer (`ADR-043`).
///
/// Owner-only, because this is the shop's money rather than a till action: a seller
/// still records drawer expenses from the shift screen, which stays on `Sell`.
///
/// `paid_from` is parsed rather than defaulted. A caller that says neither word is
/// refused, because the default would decide — silently — whether a bill reduced the
/// cash somebody is about to count.
pub async fn record_shop_expense(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    category: &str,
    amount_minor: i64,
    note: Option<&str>,
    paid_from: &str,
) -> Result<ExpenseRecord, ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;

    let paid_from = PaidFrom::parse(paid_from.trim()).ok_or(ShiftError::InvalidPaidFrom)?;
    let category = ExpenseCategory::new(category)?;
    let amount = validate_expense_amount(amount_minor)?;
    let note = ExpenseNote::parse_optional(note)?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let shift_id = match paid_from {
        PaidFrom::Drawer => Some(
            repo::find_open_shift(&mut tx)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?
                .ok_or(ShiftError::NotOpen)?
                .id,
        ),
        // An outside expense names no shift at all: attaching it to whatever happened
        // to be open would subtract it from a drawer it never left.
        PaidFrom::Outside => None,
    };

    let expense = ExpenseRecord {
        id: ExpenseId::generate(),
        shift_id: shift_id.clone(),
        paid_from,
        category,
        amount,
        note,
        created_by: actor,
        created_at: now,
    };

    repo::insert_expense(&mut tx, &expense)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::EXPENSE_RECORDED,
        now,
        Some(
            serde_json::json!({
                "shift_id": shift_id.as_ref().map(|id| id.as_str()),
                "paid_from": expense.paid_from.as_str(),
                "expense_id": expense.id.as_str(),
                "category": expense.category.as_str(),
                "amount_minor": expense.amount.as_minor(),
                "note": expense.note.as_ref().map(|n| n.as_str()),
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(expense)
}

/// The expenses section: one window, its rows, and the totals they add up to.
///
/// Owner-only for the same reason as recording: it is a view of the shop's spending,
/// not of one till's drawer.
pub async fn expenses_overview(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
) -> Result<ExpenseOverview, ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;

    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    // The repository returns the row with the recorder's name; the section speaks in
    // its own type so nothing above this layer depends on the repository's shape.
    let rows: Vec<ExpenseRow> = repo::list_expenses_between(&mut conn, from_ms, to_ms)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .into_iter()
        .map(|row| ExpenseRow {
            record: row.record,
            created_by_name: row.created_by_name,
        })
        .collect();
    let known = repo::expense_category_counts(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let open_shift_id = repo::open_shift_id(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let mut total_minor = 0i64;
    let mut drawer_minor = 0i64;
    let mut outside_minor = 0i64;
    let mut by_category: Vec<ExpenseCategoryTotal> = Vec::new();
    for row in &rows {
        let amount = row.record.amount.as_minor();
        total_minor += amount;
        match row.record.paid_from {
            PaidFrom::Drawer => drawer_minor += amount,
            PaidFrom::Outside => outside_minor += amount,
        }
        let label = row.record.category.as_str();
        match by_category
            .iter_mut()
            .find(|entry| entry.category == label)
        {
            Some(entry) => {
                entry.total_minor += amount;
                entry.count += 1;
            }
            None => by_category.push(ExpenseCategoryTotal {
                category: label.to_string(),
                total_minor: amount,
                count: 1,
            }),
        }
    }
    by_category.sort_by(|a, b| {
        b.total_minor
            .cmp(&a.total_minor)
            .then_with(|| a.category.cmp(&b.category))
    });

    Ok(ExpenseOverview {
        count: rows.len() as u64,
        rows,
        total_minor,
        drawer_minor,
        outside_minor,
        by_category,
        known_categories: known.into_iter().map(|(name, _)| name).collect(),
        open_shift_id,
    })
}

/// Record a cash expense from the drawer during the currently open shift.
pub async fn record_expense(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    category: &str,
    amount_minor: i64,
    note: Option<&str>,
) -> Result<ShiftSummary, ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let category = ExpenseCategory::new(category)?;
    let amount = validate_expense_amount(amount_minor)?;
    let note = ExpenseNote::parse_optional(note)?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let open_shift = repo::find_open_shift(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(ShiftError::NotOpen)?;

    let expense = ExpenseRecord {
        id: ExpenseId::generate(),
        shift_id: Some(open_shift.id.clone()),
        paid_from: PaidFrom::Drawer,
        category,
        amount,
        note,
        created_by: actor,
        created_at: now,
    };

    repo::insert_expense(&mut tx, &expense)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::EXPENSE_RECORDED,
        now,
        Some(
            serde_json::json!({
                "shift_id": open_shift.id.as_str(),
                "paid_from": expense.paid_from.as_str(),
                "expense_id": expense.id.as_str(),
                "category": expense.category.as_str(),
                "amount_minor": expense.amount.as_minor(),
                "note": expense.note.as_ref().map(|n| n.as_str()),
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    let summary = build_summary(&mut tx, open_shift).await?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(summary)
}

/// Record a non-sale cash movement (`cash_in` or `owner_draw`) on the currently open shift.
pub async fn record_cash_movement(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    kind: &str,
    amount_minor: i64,
    reason: &str,
) -> Result<ShiftSummary, ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let kind = CashMovementKind::parse(kind)?;
    let amount = validate_cash_movement_amount(amount_minor)?;
    let reason = CashMovementReason::new(reason)?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let open_shift = repo::find_open_shift(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(ShiftError::NotOpen)?;

    let movement = CashMovementRecord {
        id: CashMovementId::generate(),
        shift_id: open_shift.id.clone(),
        kind,
        amount,
        reason,
        created_by: actor,
        created_at: now,
    };

    repo::insert_cash_movement(&mut tx, &movement)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::CASH_MOVEMENT_RECORDED,
        now,
        Some(
            serde_json::json!({
                "shift_id": open_shift.id.as_str(),
                "movement_id": movement.id.as_str(),
                "kind": movement.kind.as_str(),
                "amount_minor": movement.amount.as_minor(),
                "reason": movement.reason.as_str(),
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    let summary = build_summary(&mut tx, open_shift).await?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(summary)
}

/// Record an observed physical count independently of reconciliation. The
/// transaction locks before inspecting the open shift, so the count cannot be
/// attached to a shift that closed concurrently. Counts never post money.
pub async fn record_shift_cash_count(
    pool: &SqlitePool, tokens: &dyn SecureTokenStore, amount_minor: i64,
) -> Result<repo::ShiftCashCount, ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let amount = validate_counted_cash(amount_minor)?;
    let actor = session.user_id();
    let now = Timestamp::now();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(|_| DomainError::StorageUnavailable)?;
    let shift = repo::find_open_shift(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(ShiftError::NotOpen)?;
    let count = repo::ShiftCashCount {
        id: uuid::Uuid::now_v7().to_string(), shift_id: shift.id.as_str().to_owned(),
        amount_minor: amount.as_minor(), counted_by: actor.as_str(), counted_at: now.as_millis(),
    };
    repo::insert_cash_count(&mut tx, &count).await.map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(&mut tx, actor, audit::event::SHIFT_CASH_COUNTED, now,
        Some(serde_json::json!({"shift_id": count.shift_id.as_str(), "count_id": count.id.as_str(), "amount_minor": count.amount_minor, "reconciled": false}).to_string()))
        .await.map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit().await.map_err(|_| DomainError::StorageUnavailable)?;
    Ok(count)
}

/// Latest physical observation for the open shift, never a reconciled balance.
pub async fn latest_shift_cash_count(
    pool: &SqlitePool, tokens: &dyn SecureTokenStore,
) -> Result<Option<repo::ShiftCashCount>, ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let Some(shift) = repo::find_open_shift(&mut conn).await.map_err(|_| DomainError::StorageUnavailable)? else { return Ok(None); };
    repo::latest_cash_count(&mut conn, shift.id.as_str()).await.map_err(|_| DomainError::StorageUnavailable.into())
}

/// Close operations with a physical observation, never a financial reconciliation.
/// The legacy schema requires an estimate and estimated difference; both remain
/// unverified and are never exposed as reconciled balances.
pub async fn close_shift(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    shift_id: &str,
    counted_cash_minor: i64,
    close_note: Option<&str>,
) -> Result<ShiftSummary, ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let counted_cash = validate_counted_cash(counted_cash_minor)?;
    let close_note = ShiftCloseNote::parse_optional(close_note)?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    if session.role() != Role::Manager {
        let appearance = settings_repo::load_appearance(&mut tx)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        if appearance.seller_can_close_shift != "on" {
            return Err(ShiftError::SellerCannotCloseShift.into());
        }
    }

    let mut open_shift = repo::find_open_shift(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(ShiftError::NotOpen)?;
    if open_shift.id.as_str() != shift_id { return Err(ShiftError::ShiftChanged.into()); }

    let closed_at = Timestamp::from_millis(now.as_millis().max(open_shift.opened_at.as_millis()));
    open_shift.closed_at = Some(closed_at);

    let totals = repo::compute_shift_totals(&mut tx, &open_shift)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let expected_cash_minor = totals.expected_cash_minor;
    let difference_minor = counted_cash.as_minor().checked_sub(expected_cash_minor)
        .ok_or(DomainError::StorageUnavailable)?;

    let count = repo::ShiftCashCount {
        id: uuid::Uuid::now_v7().to_string(), shift_id: open_shift.id.as_str().to_owned(),
        amount_minor: counted_cash.as_minor(), counted_by: actor.as_str(), counted_at: closed_at.as_millis(),
    };
    repo::insert_cash_count(&mut tx, &count).await.map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(&mut tx, actor, audit::event::SHIFT_CASH_COUNTED, closed_at,
        Some(serde_json::json!({"shift_id": count.shift_id.as_str(), "count_id": count.id.as_str(), "amount_minor": count.amount_minor, "reconciled": false}).to_string()))
        .await.map_err(|_| DomainError::StorageUnavailable)?;

    repo::close_shift_row(
        &mut tx,
        open_shift.id.as_str(),
        expected_cash_minor,
        counted_cash.as_minor(),
        difference_minor,
        close_note.as_ref().map(|n| n.as_str()),
        &actor,
        closed_at,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::SHIFT_CLOSED,
        closed_at,
        Some(
            serde_json::json!({
                "shift_id": open_shift.id.as_str(),
                "shift_number": open_shift.shift_number,
                "reconciliation_status": "unreconciled",
                "expected_cash_minor": expected_cash_minor,
                "counted_cash_minor": counted_cash.as_minor(),
                "difference_minor": difference_minor,
                "close_note": close_note.as_ref().map(|n| n.as_str()),
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    let closed_shift = repo::find_by_id(&mut tx, open_shift.id.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::StorageUnavailable)?;
    let expenses = repo::list_expenses_for_shift(&mut tx, closed_shift.id.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let cash_movements = repo::list_cash_movements_for_shift(&mut tx, closed_shift.id.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(ShiftSummary {
        shift: closed_shift,
        totals,
        expenses,
        cash_movements,
    })
}


#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashPostingPreview {
    pub drawers: Vec<repo::CashDrawerIdentity>,
    pub recent_postings: Vec<repo::CashSourcePosting>,
    pub recent_counts: Vec<repo::DrawerPhysicalCount>,
    pub uncertain_repair_refunds: Vec<repo::UncertainRepairRefund>,
    pub uncertain_repair_refund_count: i64,
    pub repair_cash_refund_reviews: Vec<repo::RepairCashRefundReview>,
    /// This is an incomplete source projection, not a drawer balance.
    pub complete: bool,
}

/// Owner-only preview. The projection is deliberately not reconciliation:
/// legacy sources, repairs and wallet services are not yet fully posted.
pub async fn cash_posting_preview(pool: &SqlitePool, tokens: &dyn SecureTokenStore) -> Result<CashPostingPreview, ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    if session.role() != Role::Manager { return Err(DomainError::PermissionDenied.into()); }
    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    let drawers = repo::list_cash_drawers(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?;
    let recent_postings = repo::recent_cash_source_postings(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?;
    let recent_counts = repo::recent_drawer_physical_counts(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?;
    let uncertain_repair_refunds = repo::recent_uncertain_repair_refunds(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?;
    let uncertain_repair_refund_count = repo::uncertain_repair_refund_count(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?;
    let repair_cash_refund_reviews = repo::recent_repair_cash_refund_reviews(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit().await.map_err(|_| DomainError::StorageUnavailable)?;
    Ok(CashPostingPreview { drawers, recent_postings, recent_counts, uncertain_repair_refunds, uncertain_repair_refund_count, repair_cash_refund_reviews, complete: false })
}

/// Create an immutable drawer identity if necessary and explicitly configure it
/// for future shifts. Existing shifts and historical entries are never relabelled.
/// Retry IDs are scoped to the manager and the requested drawer.
pub async fn configure_drawer(pool: &SqlitePool, tokens: &dyn SecureTokenStore, id: &str, name: &str, request_id: &str) -> Result<(), ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    if session.role() != Role::Manager { return Err(DomainError::PermissionDenied.into()); }
    let id=id.trim(); let name=name.trim(); let request_id=request_id.trim();
    if id.is_empty() || id.chars().count()>80 || name.is_empty() || name.chars().count()>80 || request_id.is_empty() || request_id.chars().count()>120 { return Err(ShiftError::InvalidDrawer.into()); }
    let actor=session.user_id(); let now=Timestamp::now();
    let mut tx=pool.begin_with("BEGIN IMMEDIATE").await.map_err(|_| DomainError::StorageUnavailable)?;
    match repo::drawer_config_request_matches(&mut tx,request_id,id,name,&actor.as_str()).await.map_err(|_| DomainError::StorageUnavailable)? {
        Some(true) => return Ok(()), Some(false) => return Err(ShiftError::InvalidDrawer.into()), None => {}
    }
    if repo::find_open_shift(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?.is_some() { return Err(ShiftError::AlreadyOpen.into()); }
    let existing = repo::list_cash_drawers(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?;
    if let Some(drawer) = existing.iter().find(|d| d.id==id) {
        if drawer.name != name { return Err(ShiftError::InvalidDrawer.into()); }
    } else if !repo::create_cash_drawer(&mut tx,id,name,&actor.as_str(),now.as_millis()).await.map_err(|_| DomainError::StorageUnavailable)? {
        return Err(ShiftError::InvalidDrawer.into());
    }
    repo::configure_cash_drawer(&mut tx,id,&actor.as_str(),now.as_millis(),request_id).await.map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(&mut tx,actor,audit::event::CASH_DRAWER_CONFIGURED,now,Some(serde_json::json!({"drawer_id":id,"request_id":request_id}).to_string())).await.map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit().await.map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}


/// Record a manager-confirmed physical transfer from the open shift's assigned
/// drawer to another explicit drawer. This does not assert a reconciled balance.
pub async fn transfer_drawer_cash(pool: &SqlitePool, tokens: &dyn SecureTokenStore, shift_id: &str, to_id: &str, amount_minor: i64, reason: &str, request_id: &str) -> Result<(), ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    if session.role() != Role::Manager { return Err(DomainError::PermissionDenied.into()); }
    let shift_id=shift_id.trim(); let to_id=to_id.trim(); let reason=reason.trim(); let request_id=request_id.trim();
    if shift_id.is_empty() || to_id.is_empty() || amount_minor<=0 || reason.is_empty() || reason.chars().count()>300 || request_id.is_empty() || request_id.chars().count()>120 { return Err(ShiftError::InvalidDrawer.into()); }
    let actor=session.user_id(); let now=Timestamp::now();
    let mut tx=pool.begin_with("BEGIN IMMEDIATE").await.map_err(|_| DomainError::StorageUnavailable)?;
    match repo::transfer_request_matches(&mut tx,request_id,shift_id,to_id,amount_minor,reason,&actor.as_str()).await.map_err(|_| DomainError::StorageUnavailable)? {
        Some(true) => return Ok(()), Some(false) => return Err(ShiftError::InvalidDrawer.into()), None => {}
    }
    let open=repo::find_open_shift(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?.ok_or(ShiftError::NotOpen)?;
    if open.id.as_str()!=shift_id { return Err(ShiftError::ShiftChanged.into()); }
    let from=repo::shift_drawer_id(&mut tx,shift_id).await.map_err(|_| DomainError::StorageUnavailable)?.ok_or(ShiftError::InvalidDrawer)?;
    if from==to_id { return Err(ShiftError::InvalidDrawer.into()); }
    repo::insert_drawer_transfer(&mut tx,request_id,shift_id,&from,to_id,amount_minor,reason,&actor.as_str(),now.as_millis()).await.map_err(|error| match error {
        sqlx::Error::Database(ref db) if db.code().and_then(|c| c.parse::<i32>().ok()).is_some_and(|code| code & 255 == 19) => ShiftServiceError::from(ShiftError::InvalidDrawer),
        _ => ShiftServiceError::from(DomainError::StorageUnavailable),
    })?;
    audit::append(&mut tx,actor,audit::event::CASH_DRAWER_TRANSFERRED,now,Some(serde_json::json!({"request_id":request_id,"shift_id":shift_id,"from_drawer_id":from,"to_drawer_id":to_id,"amount_minor":amount_minor}).to_string())).await.map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit().await.map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}


/// A manager records the cash physically counted in one named drawer. A retry
/// repeats the original observation; it never creates a posting or an adjustment.
pub async fn record_drawer_physical_count(pool: &SqlitePool, tokens: &dyn SecureTokenStore, drawer_id: &str, amount_minor: i64, request_id: &str) -> Result<repo::DrawerPhysicalCount, ShiftServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    if session.role()!=Role::Manager { return Err(DomainError::PermissionDenied.into()); }
    let drawer_id=drawer_id.trim(); let request_id=request_id.trim();
    if drawer_id.is_empty() || drawer_id.chars().count()>80 || request_id.is_empty() || request_id.chars().count()>120 { return Err(ShiftError::InvalidDrawer.into()); }
    let amount=validate_counted_cash(amount_minor)?;
    let actor=session.user_id();
    let mut tx=pool.begin_with("BEGIN IMMEDIATE").await.map_err(|_| DomainError::StorageUnavailable)?;
    if let Some(existing)=repo::drawer_physical_count_by_request(&mut tx,request_id).await.map_err(|_| DomainError::StorageUnavailable)? {
        if existing.drawer_id==drawer_id && existing.amount_minor==amount.as_minor() && existing.counted_by==actor.as_str() { return Ok(existing); }
        return Err(ShiftError::InvalidDrawer.into());
    }
    if !repo::list_cash_drawers(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?.iter().any(|d|d.id==drawer_id) { return Err(ShiftError::InvalidDrawer.into()); }
    let shift=repo::open_shift_id(&mut tx).await.map_err(|_| DomainError::StorageUnavailable)?;
    let now=Timestamp::now();
    let count=repo::DrawerPhysicalCount { request_id:request_id.to_owned(), drawer_id:drawer_id.to_owned(), shift_id:shift, amount_minor:amount.as_minor(), counted_by:actor.as_str(), counted_at:now.as_millis() };
    repo::insert_drawer_physical_count(&mut tx,&count).await.map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(&mut tx,actor,audit::event::CASH_DRAWER_PHYSICAL_COUNTED,now,Some(serde_json::json!({"request_id":request_id,"drawer_id":drawer_id,"shift_id":count.shift_id.as_deref(),"amount_minor":amount_minor,"reconciled":false}).to_string())).await.map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit().await.map_err(|_| DomainError::StorageUnavailable)?;
    Ok(count)
}


/// The manager asserts an actually paid wholly cash repair refund, its payout
/// time and drawer with evidence. Original uncertainty and receipts are never
/// changed; the database enforces source capacity and shift/drawer identity.
pub async fn review_repair_cash_refund(pool: &SqlitePool, tokens: &dyn SecureTokenStore, request: &str, repair_id: &str, shift_id: &str, drawer_id: &str, payout_at: i64, evidence: &str) -> Result<repo::RepairCashRefundReview, ShiftServiceError> {
    let session=identity_session::resolve(pool,tokens).await?;
    if session.role()!=Role::Manager { return Err(DomainError::PermissionDenied.into()); }
    let request=request.trim(); let repair_id=repair_id.trim(); let shift_id=shift_id.trim(); let drawer_id=drawer_id.trim(); let evidence=evidence.trim();
    if request.is_empty() || request.chars().count()>120 || repair_id.is_empty() || shift_id.is_empty() || drawer_id.is_empty() || evidence.is_empty() || evidence.chars().count()>1000 || payout_at<0 { return Err(ShiftError::RepairRefundEvidenceInvalid.into()); }
    let actor=session.user_id();
    let mut tx=pool.begin_with("BEGIN IMMEDIATE").await.map_err(|_| DomainError::StorageUnavailable)?;
    if let Some(old)=repo::repair_cash_refund_review_by_request(&mut tx,request).await.map_err(|_| DomainError::StorageUnavailable)? {
        if old.repair_id==repair_id && old.shift_id==shift_id && old.drawer_id==drawer_id && old.payout_at==payout_at && old.evidence==evidence && old.actor_id==actor.as_str() { return Ok(old); }
        return Err(ShiftError::RepairRefundEvidenceInvalid.into());
    }
    let now=Timestamp::now();
    let review=repo::RepairCashRefundReview { request_id:request.to_owned(), repair_id:repair_id.to_owned(), shift_id:shift_id.to_owned(), drawer_id:drawer_id.to_owned(), payout_at, evidence:evidence.to_owned(), actor_id:actor.as_str(), reviewed_at:now.as_millis() };
    repo::insert_repair_cash_refund_review(&mut tx,&review).await.map_err(|error| match error {
        sqlx::Error::Database(ref db) if db.code().and_then(|c|c.parse::<i32>().ok()).is_some_and(|code|code & 255==19) => ShiftServiceError::from(ShiftError::RepairRefundEvidenceInvalid),
        _ => ShiftServiceError::from(DomainError::StorageUnavailable),
    })?;
    audit::append(&mut tx,actor,audit::event::REPAIR_CASH_REFUND_REVIEWED,now,Some(serde_json::json!({"request_id":request,"repair_id":repair_id,"shift_id":shift_id,"drawer_id":drawer_id,"payout_at":payout_at}).to_string())).await.map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit().await.map_err(|_| DomainError::StorageUnavailable)?;
    Ok(review)
}
