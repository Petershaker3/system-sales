//! Shift, cash drawer, and expenses domain (Plan item 1.9, `ADR-024`, `PLAN.md` §12).
//!
//! Pure domain types and arithmetic. No SQL, Tauri, or operating-system API appears here.

use uuid::Uuid;

use crate::domain::identity::{Timestamp, UserId};
use crate::domain::money::Piastres;

/// Maximum length in Unicode scalar values for an expense category label.
pub const MAX_EXPENSE_CATEGORY_CHARS: usize = 80;

/// Maximum length in Unicode scalar values for an optional expense note.
pub const MAX_EXPENSE_NOTE_CHARS: usize = 300;

/// Maximum length in Unicode scalar values for a cash-movement reason.
pub const MAX_CASH_MOVEMENT_REASON_CHARS: usize = 200;

/// Maximum length in Unicode scalar values for an optional shift close note.
pub const MAX_SHIFT_CLOSE_NOTE_CHARS: usize = 300;

/// Stable identifier of a shift row.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ShiftId(String);

impl ShiftId {
    pub fn generate() -> Self {
        Self(Uuid::now_v7().to_string())
    }

    pub fn new(raw: impl Into<String>) -> Option<Self> {
        let s = raw.into();
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        Some(Self(trimmed.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Stable identifier of an expense row.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ExpenseId(String);

impl ExpenseId {
    pub fn generate() -> Self {
        Self(Uuid::now_v7().to_string())
    }

    pub fn new(raw: impl Into<String>) -> Option<Self> {
        let s = raw.into();
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        Some(Self(trimmed.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Stable identifier of a cash-movement row.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CashMovementId(String);

impl CashMovementId {
    pub fn generate() -> Self {
        Self(Uuid::now_v7().to_string())
    }

    pub fn new(raw: impl Into<String>) -> Option<Self> {
        let s = raw.into();
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        Some(Self(trimmed.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Lifecycle state of a shift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShiftStatus {
    Open,
    Closed,
}

impl ShiftStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ShiftStatus::Open => "open",
            ShiftStatus::Closed => "closed",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "open" => Some(ShiftStatus::Open),
            "closed" => Some(ShiftStatus::Closed),
            _ => None,
        }
    }
}

/// Direction and reason category of a non-sale cash drawer movement (`ADR-024`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CashMovementKind {
    /// Cash added into the drawer (e.g. extra change / float).
    CashIn,
    /// Cash withdrawn from the drawer by or for the owner («سحب المالك»).
    OwnerDraw,
}

impl CashMovementKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CashMovementKind::CashIn => "cash_in",
            CashMovementKind::OwnerDraw => "owner_draw",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, ShiftError> {
        match raw.trim() {
            "cash_in" => Ok(CashMovementKind::CashIn),
            "owner_draw" => Ok(CashMovementKind::OwnerDraw),
            _ => Err(ShiftError::InvalidCashMovementKind),
        }
    }
}

/// Non-empty single-line expense category label (`شاي وضيافة`, `مواصلات وشحن`, etc.).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpenseCategory(String);

impl ExpenseCategory {
    pub fn new(raw: impl Into<String>) -> Result<Self, ShiftError> {
        let s = raw.into();
        let trimmed = s.trim();
        let count = trimmed.chars().count();
        if count == 0
            || count > MAX_EXPENSE_CATEGORY_CHARS
            || trimmed.chars().any(|c| c.is_control())
        {
            return Err(ShiftError::InvalidExpenseCategory);
        }
        Ok(Self(trimmed.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Optional single-line note attached to an expense.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpenseNote(String);

impl ExpenseNote {
    pub fn parse_optional(raw: Option<&str>) -> Result<Option<Self>, ShiftError> {
        let Some(text) = raw else {
            return Ok(None);
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let count = trimmed.chars().count();
        if count > MAX_EXPENSE_NOTE_CHARS || trimmed.chars().any(|c| c.is_control()) {
            return Err(ShiftError::InvalidExpenseNote);
        }
        Ok(Some(Self(trimmed.to_owned())))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Non-empty single-line reason attached to a cash movement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CashMovementReason(String);

impl CashMovementReason {
    pub fn new(raw: impl Into<String>) -> Result<Self, ShiftError> {
        let s = raw.into();
        let trimmed = s.trim();
        let count = trimmed.chars().count();
        if count == 0
            || count > MAX_CASH_MOVEMENT_REASON_CHARS
            || trimmed.chars().any(|c| c.is_control())
        {
            return Err(ShiftError::InvalidCashMovementReason);
        }
        Ok(Self(trimmed.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Optional single-line note recorded when closing a shift.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShiftCloseNote(String);

impl ShiftCloseNote {
    pub fn parse_optional(raw: Option<&str>) -> Result<Option<Self>, ShiftError> {
        let Some(text) = raw else {
            return Ok(None);
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let count = trimmed.chars().count();
        if count > MAX_SHIFT_CLOSE_NOTE_CHARS || trimmed.chars().any(|c| c.is_control()) {
            return Err(ShiftError::InvalidCloseNote);
        }
        Ok(Some(Self(trimmed.to_owned())))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Shift record as stored in `shifts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShiftRecord {
    pub id: ShiftId,
    pub shift_number: u64,
    pub status: ShiftStatus,
    pub opening_cash: Piastres,
    pub expected_cash_minor: Option<i64>,
    pub counted_cash: Option<Piastres>,
    pub difference_minor: Option<i64>,
    pub close_note: Option<ShiftCloseNote>,
    pub opened_by: UserId,
    pub opened_at: Timestamp,
    pub closed_by: Option<UserId>,
    pub closed_at: Option<Timestamp>,
}

/// Expense record as stored in `expenses`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpenseRecord {
    pub id: ExpenseId,
    pub shift_id: ShiftId,
    pub category: ExpenseCategory,
    pub amount: Piastres,
    pub note: Option<ExpenseNote>,
    pub created_by: UserId,
    pub created_at: Timestamp,
}

/// Cash drawer movement record as stored in `cash_movements`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CashMovementRecord {
    pub id: CashMovementId,
    pub shift_id: ShiftId,
    pub kind: CashMovementKind,
    pub amount: Piastres,
    pub reason: CashMovementReason,
    pub created_by: UserId,
    pub created_at: Timestamp,
}

/// Computed financial and drawer summary for a shift (`ADR-024`, `ADR-025`, `PLAN.md` §12).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShiftTotals {
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

impl ShiftTotals {
    /// Compute expected cash in drawer and gross/net profit from the shift's raw totals.
    #[allow(clippy::too_many_arguments)]
    pub fn compute(
        opening_cash_minor: i64,
        cash_sales_minor: i64,
        vf_sales_minor: i64,
        instapay_sales_minor: i64,
        card_sales_minor: i64,
        install_sales_minor: i64,
        credit_sales_minor: i64,
        sales_total_minor: i64,
        sales_cost_minor: i64,
        sales_count: u64,
        customer_cash_in_minor: i64,
        cash_in_minor: i64,
        owner_draw_minor: i64,
        expenses_minor: i64,
    ) -> Self {
        Self::compute_with_services(
            opening_cash_minor,
            cash_sales_minor,
            vf_sales_minor,
            instapay_sales_minor,
            card_sales_minor,
            install_sales_minor,
            credit_sales_minor,
            sales_total_minor,
            sales_cost_minor,
            sales_count,
            customer_cash_in_minor,
            0,
            0,
            0,
            0,
            0,
            cash_in_minor,
            owner_draw_minor,
            expenses_minor,
        )
    }

    /// Compute expected cash in drawer and gross/net profit including service and wallet-drawer figures.
    #[allow(clippy::too_many_arguments)]
    pub fn compute_with_services(
        opening_cash_minor: i64,
        cash_sales_minor: i64,
        vf_sales_minor: i64,
        instapay_sales_minor: i64,
        card_sales_minor: i64,
        install_sales_minor: i64,
        credit_sales_minor: i64,
        sales_total_minor: i64,
        sales_cost_minor: i64,
        sales_count: u64,
        customer_cash_in_minor: i64,
        services_count: u64,
        services_fee_minor: i64,
        services_cash_in_minor: i64,
        services_cash_out_minor: i64,
        wallet_drawer_net_minor: i64,
        cash_in_minor: i64,
        owner_draw_minor: i64,
        expenses_minor: i64,
    ) -> Self {
        let expected_cash_minor = opening_cash_minor
            + cash_sales_minor
            + customer_cash_in_minor
            + services_cash_in_minor
            - services_cash_out_minor
            + wallet_drawer_net_minor
            + cash_in_minor
            - expenses_minor
            - owner_draw_minor;
        let gross_profit_minor = sales_total_minor - sales_cost_minor;
        let net_profit_minor = gross_profit_minor + services_fee_minor - expenses_minor;
        Self {
            opening_cash_minor,
            cash_sales_minor,
            vf_sales_minor,
            instapay_sales_minor,
            card_sales_minor,
            install_sales_minor,
            credit_sales_minor,
            sales_total_minor,
            sales_cost_minor,
            sales_count,
            customer_cash_in_minor,
            services_count,
            services_fee_minor,
            services_cash_in_minor,
            services_cash_out_minor,
            wallet_drawer_net_minor,
            cash_in_minor,
            owner_draw_minor,
            expenses_minor,
            expected_cash_minor,
            gross_profit_minor,
            net_profit_minor,
        }
    }
}

/// Complete snapshot of a shift together with its computed totals, expenses, and cash movements.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShiftSummary {
    pub shift: ShiftRecord,
    pub totals: ShiftTotals,
    pub expenses: Vec<ExpenseRecord>,
    pub cash_movements: Vec<CashMovementRecord>,
}

/// Validate a non-negative opening cash balance in piastres.
pub fn validate_opening_cash(minor: i64) -> Result<Piastres, ShiftError> {
    Piastres::new_minor(minor).map_err(|_| ShiftError::InvalidOpeningCash)
}

/// Validate a non-negative counted cash balance in piastres.
pub fn validate_counted_cash(minor: i64) -> Result<Piastres, ShiftError> {
    Piastres::new_minor(minor).map_err(|_| ShiftError::InvalidCountedCash)
}

/// Validate a strictly positive expense amount in piastres.
pub fn validate_expense_amount(minor: i64) -> Result<Piastres, ShiftError> {
    if minor <= 0 {
        return Err(ShiftError::InvalidExpenseAmount);
    }
    Piastres::new_minor(minor).map_err(|_| ShiftError::InvalidExpenseAmount)
}

/// Validate a strictly positive cash movement amount in piastres.
pub fn validate_cash_movement_amount(minor: i64) -> Result<Piastres, ShiftError> {
    if minor <= 0 {
        return Err(ShiftError::InvalidCashMovementAmount);
    }
    Piastres::new_minor(minor).map_err(|_| ShiftError::InvalidCashMovementAmount)
}

/// Domain errors for shift, drawer, and expense operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShiftError {
    AlreadyOpen,
    NotOpen,
    InvalidOpeningCash,
    InvalidCountedCash,
    InvalidCloseNote,
    SellerCannotCloseShift,
    InvalidExpenseCategory,
    InvalidExpenseAmount,
    InvalidExpenseNote,
    InvalidCashMovementKind,
    InvalidCashMovementAmount,
    InvalidCashMovementReason,
}

impl ShiftError {
    pub fn code(&self) -> &'static str {
        match self {
            ShiftError::AlreadyOpen => "SHIFT_ALREADY_OPEN",
            ShiftError::NotOpen => "SHIFT_NOT_OPEN",
            ShiftError::InvalidOpeningCash => "SHIFT_OPENING_CASH_INVALID",
            ShiftError::InvalidCountedCash => "SHIFT_COUNTED_CASH_INVALID",
            ShiftError::InvalidCloseNote => "SHIFT_CLOSE_NOTE_INVALID",
            ShiftError::SellerCannotCloseShift => "SHIFT_CLOSE_FORBIDDEN_FOR_SELLER",
            ShiftError::InvalidExpenseCategory => "EXPENSE_CATEGORY_INVALID",
            ShiftError::InvalidExpenseAmount => "EXPENSE_AMOUNT_INVALID",
            ShiftError::InvalidExpenseNote => "EXPENSE_NOTE_INVALID",
            ShiftError::InvalidCashMovementKind => "CASH_MOVEMENT_KIND_INVALID",
            ShiftError::InvalidCashMovementAmount => "CASH_MOVEMENT_AMOUNT_INVALID",
            ShiftError::InvalidCashMovementReason => "CASH_MOVEMENT_REASON_INVALID",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shift_totals_compute_expected_drawer_and_net_profit() {
        let totals = ShiftTotals::compute(
            100_000, // opening: 1,000 EGP
            250_000, // cash sales: 2,500 EGP
            40_000,  // vf: 400 EGP
            60_000,  // instapay: 600 EGP
            0,       // card
            0,       // install
            50_000,  // credit: 500 EGP
            400_000, // total sales: 4,000 EGP
            300_000, // total cost: 3,000 EGP
            4,       // sales count
            20_000,  // customer cash debt payment: 200 EGP
            10_000,  // cash_in movement: 100 EGP
            30_000,  // owner_draw: 300 EGP
            5_000,   // expenses: 50 EGP
        );
        // Expected cash = 1000 + 2500 + 200 + 100 - 50 - 300 = 3,450 EGP (345,000 minor)
        assert_eq!(totals.expected_cash_minor, 345_000);
        // Gross profit = 4000 - 3000 = 1,000 EGP; net = 1,000 - 50 = 950 EGP
        assert_eq!(totals.gross_profit_minor, 100_000);
        assert_eq!(totals.net_profit_minor, 95_000);
    }

    #[test]
    fn validation_rejects_empty_or_negative_inputs() {
        assert_eq!(
            validate_opening_cash(-1),
            Err(ShiftError::InvalidOpeningCash)
        );
        assert!(validate_opening_cash(0).is_ok());
        assert_eq!(
            validate_expense_amount(0),
            Err(ShiftError::InvalidExpenseAmount)
        );
        assert_eq!(
            ExpenseCategory::new("   "),
            Err(ShiftError::InvalidExpenseCategory)
        );
        assert_eq!(
            CashMovementReason::new(""),
            Err(ShiftError::InvalidCashMovementReason)
        );
        assert_eq!(
            CashMovementKind::parse("unknown"),
            Err(ShiftError::InvalidCashMovementKind)
        );
    }
}
