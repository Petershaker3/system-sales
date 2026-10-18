//! Shop wallets and services ledger domain (Plan item 1.10, `ADR-025`, `PLAN.md` §9, §12, §16, §19).
//!
//! Pure domain types and arithmetic. No SQL, Tauri, or operating-system API appears here.

use uuid::Uuid;

use crate::domain::identity::{Timestamp, UserId};

/// Maximum length in Unicode scalar values for a wallet display name.
pub const MAX_WALLET_NAME_CHARS: usize = 80;

/// Maximum length in Unicode scalar values for a wallet number or InstaPay address.
pub const MAX_WALLET_NUMBER_CHARS: usize = 80;

/// Maximum length in Unicode scalar values for a service sub-type or reference.
pub const MAX_SERVICE_TYPE_CHARS: usize = 80;
pub const MAX_SERVICE_REFERENCE_CHARS: usize = 120;

/// Maximum length in Unicode scalar values for an operation note or void reason.
pub const MAX_WALLET_NOTE_CHARS: usize = 300;

/// Stable identifier of a wallet row.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WalletId(String);

impl WalletId {
    pub fn generate() -> Self {
        Self(format!("wl-{}", Uuid::now_v7()))
    }

    pub fn new(raw: impl Into<String>) -> Option<Self> {
        let s = raw.into();
        let trimmed = s.trim();
        let count = trimmed.chars().count();
        if count == 0 || count > 64 || trimmed.chars().any(char::is_control) {
            return None;
        }
        Some(Self(trimmed.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Stable identifier of a `wallet_ops` row.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WalletOpId(String);

impl WalletOpId {
    pub fn generate() -> Self {
        Self(Uuid::now_v7().to_string())
    }

    pub fn new(raw: impl Into<String>) -> Option<Self> {
        let s = raw.into();
        let trimmed = s.trim();
        if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
            return None;
        }
        Some(Self(trimmed.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Validated non-empty wallet name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletName(String);

impl WalletName {
    pub fn new(raw: impl Into<String>) -> Result<Self, WalletError> {
        let s = raw.into();
        let trimmed = s.trim();
        let count = trimmed.chars().count();
        if count == 0
            || count > MAX_WALLET_NAME_CHARS
            || trimmed.chars().any(char::is_control)
        {
            return Err(WalletError::WalletNameInvalid);
        }
        Ok(Self(trimmed.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Validated `#RRGGBB` hex colour for a wallet.
pub fn validate_wallet_color(raw: &str) -> Result<String, WalletError> {
    let trimmed = raw.trim();
    if trimmed.len() != 7
        || !trimmed.starts_with('#')
        || !trimmed[1..].chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(WalletError::WalletColorInvalid);
    }
    Ok(trimmed.to_ascii_lowercase())
}

/// Validated optional wallet number or InstaPay handle (`0..=80` chars).
pub fn validate_wallet_number(raw: &str) -> Result<String, WalletError> {
    let trimmed = raw.trim();
    if trimmed.chars().count() > MAX_WALLET_NUMBER_CHARS
        || trimmed.chars().any(char::is_control)
    {
        return Err(WalletError::WalletNumberInvalid);
    }
    Ok(trimmed.to_owned())
}

/// Optional sale payment method (`vf` or `instapay`) whose sale payments flow into a wallet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalletPayMethod {
    Vf,
    Instapay,
}

impl WalletPayMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            WalletPayMethod::Vf => "vf",
            WalletPayMethod::Instapay => "instapay",
        }
    }

    pub fn parse_optional(raw: Option<&str>) -> Result<Option<Self>, WalletError> {
        let Some(text) = raw else {
            return Ok(None);
        };
        match text.trim() {
            "" => Ok(None),
            "vf" => Ok(Some(WalletPayMethod::Vf)),
            "instapay" => Ok(Some(WalletPayMethod::Instapay)),
            _ => Err(WalletError::WalletPayMethodInvalid),
        }
    }
}

/// Operation kind in `wallet_ops` (`ADR-025` §1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalletOpKind {
    /// Customer pays cash; shop sends from its wallet (`wallet - amount`, `drawer + amount + fee`).
    Deposit,
    /// Customer transfers to shop's wallet; shop pays cash (`wallet + amount`, `drawer - (amount - fee)`).
    Withdraw,
    /// Owner tops up wallet (`wallet + amount`; `drawer - amount` when `via = drawer`).
    Topup,
    /// Owner unloads wallet (`wallet - amount`; `drawer + amount` when `via = drawer`).
    Unload,
    /// Owner transfers between two shop wallets (`from - amount`, `to + amount`, `drawer 0`).
    Move,
    /// Owner reconciliation adjustment (`wallet + amount_minor` signed difference, `drawer 0`).
    Adjust,
    /// Utility/telecom bill payment (`drawer + amount + fee`, `revenue + fee`).
    Bill,
    /// Recharge card recorded in services ledger (`drawer + amount + fee`, `revenue + fee`).
    Card,
    /// Software service (`amount = 0`, `drawer + fee`, `revenue + fee`).
    Software,
}

impl WalletOpKind {
    pub fn as_str(self) -> &'static str {
        match self {
            WalletOpKind::Deposit => "deposit",
            WalletOpKind::Withdraw => "withdraw",
            WalletOpKind::Topup => "topup",
            WalletOpKind::Unload => "unload",
            WalletOpKind::Move => "move",
            WalletOpKind::Adjust => "adjust",
            WalletOpKind::Bill => "bill",
            WalletOpKind::Card => "card",
            WalletOpKind::Software => "software",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, WalletError> {
        match raw.trim() {
            "deposit" => Ok(WalletOpKind::Deposit),
            "withdraw" => Ok(WalletOpKind::Withdraw),
            "topup" => Ok(WalletOpKind::Topup),
            "unload" => Ok(WalletOpKind::Unload),
            "move" => Ok(WalletOpKind::Move),
            "adjust" => Ok(WalletOpKind::Adjust),
            "bill" => Ok(WalletOpKind::Bill),
            "card" => Ok(WalletOpKind::Card),
            "software" => Ok(WalletOpKind::Software),
            _ => Err(WalletError::WalletOpKindInvalid),
        }
    }

    /// Whether this operation is a customer service counted in `servicesOf` (`ADR-025` §3).
    pub fn is_customer_service(self) -> bool {
        matches!(
            self,
            WalletOpKind::Deposit
                | WalletOpKind::Withdraw
                | WalletOpKind::Bill
                | WalletOpKind::Card
                | WalletOpKind::Software
        )
    }
}

/// Source or destination for owner `topup` / `unload` movements.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalletVia {
    Drawer,
    Out,
}

impl WalletVia {
    pub fn as_str(self) -> &'static str {
        match self {
            WalletVia::Drawer => "drawer",
            WalletVia::Out => "out",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, WalletError> {
        match raw.trim() {
            "drawer" => Ok(WalletVia::Drawer),
            "out" => Ok(WalletVia::Out),
            _ => Err(WalletError::WalletOpKindInvalid),
        }
    }
}

/// Alert status of a wallet balance (`walletState` in `analytics.js`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalletAlertState {
    Ok,
    Low,
    Near,
    Over,
    Neg,
}

impl WalletAlertState {
    pub fn as_str(self) -> &'static str {
        match self {
            WalletAlertState::Ok => "ok",
            WalletAlertState::Low => "low",
            WalletAlertState::Near => "near",
            WalletAlertState::Over => "over",
            WalletAlertState::Neg => "neg",
        }
    }

    pub fn compute(balance_minor: i64, min_alert_minor: i64, max_limit_minor: i64) -> Self {
        if balance_minor < 0 {
            WalletAlertState::Neg
        } else if min_alert_minor > 0 && balance_minor < min_alert_minor {
            WalletAlertState::Low
        } else if max_limit_minor > 0 && balance_minor > max_limit_minor {
            WalletAlertState::Over
        } else if max_limit_minor > 0 && balance_minor.saturating_mul(10) >= max_limit_minor.saturating_mul(9) {
            WalletAlertState::Near
        } else {
            WalletAlertState::Ok
        }
    }
}

/// Stored shop wallet configuration (`wallets`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletRecord {
    pub id: WalletId,
    pub name: WalletName,
    pub number: String,
    pub color: String,
    pub opening_balance_minor: i64,
    pub min_alert_minor: i64,
    pub max_limit_minor: i64,
    pub daily_limit_minor: i64,
    pub pay_method: Option<WalletPayMethod>,
    pub sort: i64,
    pub hidden: bool,
    pub is_custom: bool,
    pub created_at: Timestamp,
}

/// Stored operation row in `wallet_ops`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletOpRecord {
    pub id: WalletOpId,
    pub wallet_id: Option<WalletId>,
    pub to_wallet_id: Option<WalletId>,
    pub kind: WalletOpKind,
    pub via: Option<WalletVia>,
    pub service_type: Option<String>,
    pub reference: Option<String>,
    pub amount_minor: i64,
    pub fee_minor: i64,
    pub note: Option<String>,
    pub created_by: UserId,
    pub created_at: Timestamp,
    pub voided_by: Option<UserId>,
    pub voided_at: Option<Timestamp>,
    pub void_reason: Option<String>,
}

impl WalletOpRecord {
    pub fn is_voided(&self) -> bool {
        self.voided_at.is_some()
    }

    /// Net effect of this operation on a specific wallet's balance (`walletDelta` in `analytics.js`).
    pub fn wallet_delta(&self, target_wallet_id: &str) -> i64 {
        if self.is_voided() {
            return 0;
        }
        if self.kind == WalletOpKind::Move {
            if self.wallet_id.as_ref().map(|w| w.as_str()) == Some(target_wallet_id) {
                return -self.amount_minor;
            }
            if self.to_wallet_id.as_ref().map(|w| w.as_str()) == Some(target_wallet_id) {
                return self.amount_minor;
            }
            return 0;
        }
        if self.wallet_id.as_ref().map(|w| w.as_str()) != Some(target_wallet_id) {
            return 0;
        }
        match self.kind {
            WalletOpKind::Deposit | WalletOpKind::Unload => -self.amount_minor,
            WalletOpKind::Withdraw | WalletOpKind::Topup | WalletOpKind::Adjust => self.amount_minor,
            WalletOpKind::Move
            | WalletOpKind::Bill
            | WalletOpKind::Card
            | WalletOpKind::Software => 0,
        }
    }

    /// Net effect of this operation on the cash drawer (`opCash` in `analytics.js`).
    pub fn drawer_delta(&self) -> i64 {
        if self.is_voided() {
            return 0;
        }
        match self.kind {
            WalletOpKind::Deposit => self.amount_minor + self.fee_minor,
            WalletOpKind::Withdraw => -(self.amount_minor - self.fee_minor),
            WalletOpKind::Topup => {
                if self.via == Some(WalletVia::Drawer) {
                    -self.amount_minor
                } else {
                    0
                }
            }
            WalletOpKind::Unload => {
                if self.via == Some(WalletVia::Drawer) {
                    self.amount_minor
                } else {
                    0
                }
            }
            WalletOpKind::Bill | WalletOpKind::Card => self.amount_minor + self.fee_minor,
            WalletOpKind::Software => self.fee_minor,
            WalletOpKind::Move | WalletOpKind::Adjust => 0,
        }
    }
}

/// Computed period statistics for one wallet (`walletStats` in `analytics.js`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletPeriodStats {
    pub wallet_id: WalletId,
    pub ops_count: u64,
    pub dep_count: u64,
    pub dep_minor: i64,
    pub wit_count: u64,
    pub wit_minor: i64,
    pub fees_minor: i64,
    pub used_minor: i64,
    pub sales_in_minor: i64,
}

/// Enriched wallet view with live computed balance and period stats.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletSummary {
    pub wallet: WalletRecord,
    pub balance_minor: i64,
    pub state: WalletAlertState,
    pub today: WalletPeriodStats,
    pub period: WalletPeriodStats,
}

/// Aggregated service and wallet-drawer numbers for a time range (`servicesOf` in `analytics.js`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServicesWindowTotals {
    pub services_count: u64,
    pub services_fee_minor: i64,
    pub services_cash_in_minor: i64,
    pub services_cash_out_minor: i64,
    pub wallet_drawer_net_minor: i64,
}

/// Compute auto wallet commission (`max(fee_min_minor, round(amount_minor * fee_pct / 100))`).
pub fn compute_auto_wallet_fee_minor(amount_minor: i64, fee_pct: u8, fee_min_minor: i64) -> i64 {
    if amount_minor <= 0 {
        return 0;
    }
    let pct_fee = (amount_minor.saturating_mul(i64::from(fee_pct)) + 50) / 100;
    pct_fee.max(fee_min_minor.max(0))
}

/// Validate a non-negative wallet limit or opening balance in piastres.
pub fn validate_non_negative_minor(minor: i64) -> Result<i64, WalletError> {
    if minor < 0 {
        return Err(WalletError::WalletLimitInvalid);
    }
    Ok(minor)
}

/// Validate an optional note (`0..=300` chars, no control chars).
pub fn validate_optional_note(raw: Option<&str>) -> Result<Option<String>, WalletError> {
    let Some(text) = raw else {
        return Ok(None);
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_WALLET_NOTE_CHARS || trimmed.chars().any(char::is_control) {
        return Err(WalletError::WalletOpNoteInvalid);
    }
    Ok(Some(trimmed.to_owned()))
}

/// Validate a required void reason (`1..=300` chars, no control chars).
pub fn validate_void_reason(raw: &str) -> Result<String, WalletError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(WalletError::WalletVoidReasonRequired);
    }
    if trimmed.chars().count() > MAX_WALLET_NOTE_CHARS || trimmed.chars().any(char::is_control) {
        return Err(WalletError::WalletOpNoteInvalid);
    }
    Ok(trimmed.to_owned())
}

/// Domain errors for wallets and services ledger operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalletError {
    WalletNotFound,
    WalletNameInvalid,
    WalletNameDuplicate,
    WalletNumberInvalid,
    WalletColorInvalid,
    WalletLimitInvalid,
    WalletPayMethodInvalid,
    WalletDeleteForbidden,
    WalletInsufficientBalance,
    WalletOpKindInvalid,
    WalletOpAmountInvalid,
    WalletOpFeeInvalid,
    WalletOpFeeExceedsAmount,
    WalletOpNoteInvalid,
    WalletOpNotFound,
    WalletOpAlreadyVoided,
    WalletVoidReasonRequired,
}

impl WalletError {
    pub fn code(&self) -> &'static str {
        match self {
            WalletError::WalletNotFound => "WALLET_NOT_FOUND",
            WalletError::WalletNameInvalid => "WALLET_NAME_INVALID",
            WalletError::WalletNameDuplicate => "WALLET_NAME_DUPLICATE",
            WalletError::WalletNumberInvalid => "WALLET_NUMBER_INVALID",
            WalletError::WalletColorInvalid => "WALLET_COLOR_INVALID",
            WalletError::WalletLimitInvalid => "WALLET_LIMIT_INVALID",
            WalletError::WalletPayMethodInvalid => "WALLET_PAY_METHOD_INVALID",
            WalletError::WalletDeleteForbidden => "WALLET_DELETE_FORBIDDEN",
            WalletError::WalletInsufficientBalance => "WALLET_INSUFFICIENT_BALANCE",
            WalletError::WalletOpKindInvalid => "WALLET_OP_KIND_INVALID",
            WalletError::WalletOpAmountInvalid => "WALLET_OP_AMOUNT_INVALID",
            WalletError::WalletOpFeeInvalid => "WALLET_OP_FEE_INVALID",
            WalletError::WalletOpFeeExceedsAmount => "WALLET_OP_FEE_EXCEEDS_AMOUNT",
            WalletError::WalletOpNoteInvalid => "WALLET_OP_NOTE_INVALID",
            WalletError::WalletOpNotFound => "WALLET_OP_NOT_FOUND",
            WalletError::WalletOpAlreadyVoided => "WALLET_OP_ALREADY_VOIDED",
            WalletError::WalletVoidReasonRequired => "WALLET_VOID_REASON_REQUIRED",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallet_alert_state_matches_mockup_thresholds() {
        assert_eq!(WalletAlertState::compute(-100, 300_000, 9_000_000), WalletAlertState::Neg);
        assert_eq!(WalletAlertState::compute(200_000, 300_000, 9_000_000), WalletAlertState::Low);
        assert_eq!(WalletAlertState::compute(8_100_000, 300_000, 9_000_000), WalletAlertState::Near);
        assert_eq!(WalletAlertState::compute(9_100_000, 300_000, 9_000_000), WalletAlertState::Over);
        assert_eq!(WalletAlertState::compute(1_500_000, 300_000, 9_000_000), WalletAlertState::Ok);
    }

    #[test]
    fn auto_wallet_fee_uses_percent_with_minimum_floor() {
        // 200 EGP at 1% = 2 EGP < 5 EGP min -> 5 EGP (500 piastres)
        assert_eq!(compute_auto_wallet_fee_minor(20_000, 1, 500), 500);
        // 1,000 EGP at 1% = 10 EGP >= 5 EGP min -> 10 EGP (1,000 piastres)
        assert_eq!(compute_auto_wallet_fee_minor(100_000, 1, 500), 1_000);
    }
}
