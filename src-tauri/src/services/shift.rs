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
    CashMovementRecord, ExpenseCategory, ExpenseId, ExpenseNote, ExpenseRecord, ShiftCloseNote,
    ShiftError, ShiftId, ShiftRecord, ShiftStatus, ShiftSummary,
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
        .begin()
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
        shift_id: open_shift.id.clone(),
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

/// Close the currently open shift, recording counted cash, expected cash, difference, and note.
pub async fn close_shift(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
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
        .begin()
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

    let closed_at = Timestamp::from_millis(now.as_millis().max(open_shift.opened_at.as_millis()));
    open_shift.closed_at = Some(closed_at);

    let totals = repo::compute_shift_totals(&mut tx, &open_shift)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let expected_cash_minor = totals.expected_cash_minor;
    let difference_minor = counted_cash.as_minor() - expected_cash_minor;

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
