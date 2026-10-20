//! Repairs & Software domain (`الصيانة والسوفت وير`, Plan item 2.1, `ADR-031`, `PLAN.md` §13).
//!
//! Tracks hardware maintenance tickets (`service_kind = "hardware"`) and software
//! operations (`service_kind = "software"`) across the 5-stage Kanban board
//! (`received`, `diagnosing`, `waiting`, `ready`, `delivered`, plus `cancelled`),
//! and computes separate financial buckets for hardware repairs vs software
//! operations (`ADR-016` #13-#14 & #35).

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_REPAIR_CUSTOMER_NAME_CHARS: usize = 120;
pub const MAX_REPAIR_CUSTOMER_PHONE_CHARS: usize = 64;
pub const MAX_REPAIR_DEVICE_NAME_CHARS: usize = 160;
pub const MAX_REPAIR_IMEI_CHARS: usize = 32;
pub const MAX_REPAIR_LOCK_CHARS: usize = 120;
pub const MAX_REPAIR_ISSUE_CHARS: usize = 300;
pub const MAX_REPAIR_ACCESSORIES_CHARS: usize = 240;
pub const MAX_REPAIR_DUE_CHARS: usize = 80;
pub const MAX_REPAIR_TECHNICIAN_CHARS: usize = 120;
pub const MAX_REPAIR_NOTE_CHARS: usize = 400;
pub const MAX_REPAIR_PRICE_MINOR: i64 = 100_000_000; // 1,000,000 EGP

/// Stable identifier of a repair/software ticket (`UUID v7`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RepairId(String);

impl RepairId {
    pub fn generate() -> Self {
        Self(Uuid::now_v7().to_string())
    }

    pub fn new(raw: impl Into<String>) -> Option<Self> {
        let s = raw.into();
        let trimmed = s.trim();
        if trimmed.is_empty() || trimmed.len() > 64 {
            return None;
        }
        Some(Self(trimmed.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Service track (`hardware` = صيانة هاردوير, `software` = سوفت وير).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RepairServiceKind {
    Hardware,
    Software,
}

impl RepairServiceKind {
    pub fn parse(raw: &str) -> Result<Self, RepairError> {
        match raw.trim() {
            "hardware" => Ok(Self::Hardware),
            "software" => Ok(Self::Software),
            _ => Err(RepairError::StatusInvalid),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Hardware => "hardware",
            Self::Software => "software",
        }
    }
}

/// Lifecycle stage of a repair or software ticket (`docs/ui/mockup-v1/data.js`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RepairStatus {
    Received,
    Diagnosing,
    Waiting,
    Ready,
    Delivered,
    Cancelled,
}

impl RepairStatus {
    pub fn parse(raw: &str) -> Result<Self, RepairError> {
        match raw.trim() {
            "received" => Ok(Self::Received),
            "diagnosing" => Ok(Self::Diagnosing),
            "waiting" => Ok(Self::Waiting),
            "ready" => Ok(Self::Ready),
            "delivered" => Ok(Self::Delivered),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(RepairError::StatusInvalid),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Received => "received",
            Self::Diagnosing => "diagnosing",
            Self::Waiting => "waiting",
            Self::Ready => "ready",
            Self::Delivered => "delivered",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Supported payment methods for repair/software collection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RepairPayMethod {
    Cash,
    Vf,
    Instapay,
    Card,
}

impl RepairPayMethod {
    pub fn parse(raw: &str) -> Result<Self, RepairError> {
        match raw.trim() {
            "cash" => Ok(Self::Cash),
            "vf" => Ok(Self::Vf),
            "instapay" => Ok(Self::Instapay),
            "card" => Ok(Self::Card),
            _ => Err(RepairError::PayMethodInvalid),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cash => "cash",
            Self::Vf => "vf",
            Self::Instapay => "instapay",
            Self::Card => "card",
        }
    }
}

/// One hardware repair or software ticket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepairTicket {
    pub id: String,
    pub ticket_no: String,
    pub service_kind: String,
    pub customer_name: String,
    pub customer_phone: String,
    pub device_name: String,
    pub imei: Option<String>,
    pub device_lock: String,
    pub issue: String,
    pub accessories: String,
    pub due_label: String,
    pub status: String,
    pub estimated_price_minor: i64,
    pub final_price_minor: i64,
    pub parts_cost_minor: Option<i64>,
    pub net_profit_minor: Option<i64>,
    pub deposit_minor: i64,
    pub collected_minor: i64,
    pub remaining_minor: i64,
    pub pay_method: String,
    pub technician_name: Option<String>,
    pub warranty_days: i64,
    pub note: String,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: i64,
    pub delivered_at: Option<i64>,
}

/// Separate financial accounting bucket (`hardware`, `software`, or `all`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepairKindFinancialBucket {
    pub service_kind: String,
    pub tickets_count: i64,
    pub open_count: i64,
    pub ready_count: i64,
    pub delivered_count: i64,
    pub deposit_collected_minor: i64,
    pub delivery_collected_minor: i64,
    pub total_revenue_minor: i64,
    pub cash_collected_minor: i64,
    pub vf_collected_minor: i64,
    pub instapay_collected_minor: i64,
    pub card_collected_minor: i64,
    pub parts_cost_minor: Option<i64>,
    pub net_profit_minor: Option<i64>,
}

impl RepairKindFinancialBucket {
    pub fn empty(service_kind: &str, include_cost: bool) -> Self {
        Self {
            service_kind: service_kind.to_owned(),
            tickets_count: 0,
            open_count: 0,
            ready_count: 0,
            delivered_count: 0,
            deposit_collected_minor: 0,
            delivery_collected_minor: 0,
            total_revenue_minor: 0,
            cash_collected_minor: 0,
            vf_collected_minor: 0,
            instapay_collected_minor: 0,
            card_collected_minor: 0,
            parts_cost_minor: include_cost.then_some(0),
            net_profit_minor: include_cost.then_some(0),
        }
    }
}

/// Per-technician summary so the owner can see each technician's hardware or software tally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepairTechnicianSummary {
    pub technician_name: String,
    pub hardware_count: i64,
    pub software_count: i64,
    pub delivered_count: i64,
    pub hardware_revenue_minor: i64,
    pub software_revenue_minor: i64,
    pub total_revenue_minor: i64,
    pub parts_cost_minor: Option<i64>,
    pub net_profit_minor: Option<i64>,
}

/// Complete overview returned to the Repairs & Software screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepairsOverview {
    pub tickets: Vec<RepairTicket>,
    pub hardware: RepairKindFinancialBucket,
    pub software: RepairKindFinancialBucket,
    pub combined: RepairKindFinancialBucket,
    pub technicians: Vec<RepairTechnicianSummary>,
}

pub fn validate_customer(
    customer_name: &str,
    customer_phone: &str,
) -> Result<(String, String), RepairError> {
    let name = customer_name.trim();
    let phone = customer_phone.trim();
    let name_len = name.chars().count();
    let phone_len = phone.chars().count();
    if name_len == 0 || name_len > MAX_REPAIR_CUSTOMER_NAME_CHARS {
        return Err(RepairError::CustomerRequired);
    }
    if phone_len == 0 || phone_len > MAX_REPAIR_CUSTOMER_PHONE_CHARS {
        return Err(RepairError::CustomerRequired);
    }
    Ok((name.to_owned(), phone.to_owned()))
}

pub fn validate_device_name(raw: &str) -> Result<String, RepairError> {
    let trimmed = raw.trim();
    let len = trimmed.chars().count();
    if len == 0 || len > MAX_REPAIR_DEVICE_NAME_CHARS {
        return Err(RepairError::DeviceRequired);
    }
    Ok(trimmed.to_owned())
}

pub fn validate_issue(raw: &str) -> Result<String, RepairError> {
    let trimmed = raw.trim();
    let len = trimmed.chars().count();
    if len == 0 || len > MAX_REPAIR_ISSUE_CHARS {
        return Err(RepairError::IssueRequired);
    }
    Ok(trimmed.to_owned())
}

pub fn validate_optional_text(
    raw: Option<&str>,
    max_chars: usize,
) -> Result<Option<String>, RepairError> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => {
            if text.chars().count() > max_chars {
                return Err(RepairError::AmountInvalid);
            }
            Ok(Some(text.to_owned()))
        }
        None => Ok(None),
    }
}

pub fn validate_default_text(
    raw: Option<&str>,
    default_val: &str,
    max_chars: usize,
) -> Result<String, RepairError> {
    let text = raw.unwrap_or(default_val).trim();
    if text.chars().count() > max_chars {
        return Err(RepairError::AmountInvalid);
    }
    Ok(text.to_owned())
}

pub fn validate_money_minor(amount_minor: i64) -> Result<i64, RepairError> {
    if !(0..=MAX_REPAIR_PRICE_MINOR).contains(&amount_minor) {
        return Err(RepairError::AmountInvalid);
    }
    Ok(amount_minor)
}

pub fn validate_warranty_days(days: i64) -> Result<i64, RepairError> {
    if !(0..=3650).contains(&days) {
        return Err(RepairError::AmountInvalid);
    }
    Ok(days)
}

/// Domain errors for Repairs & Software (`ADR-031`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepairError {
    CustomerRequired,
    DeviceRequired,
    IssueRequired,
    AmountInvalid,
    StatusInvalid,
    PayMethodInvalid,
    /// The named wallet does not receive that method (`ADR-041`).
    PayWalletInvalid,
    NotFound,
    AlreadyDelivered,
}

impl RepairError {
    pub fn code(&self) -> &'static str {
        match self {
            RepairError::CustomerRequired => "REPAIR_CUSTOMER_REQUIRED",
            RepairError::DeviceRequired => "REPAIR_DEVICE_REQUIRED",
            RepairError::IssueRequired => "REPAIR_ISSUE_REQUIRED",
            RepairError::AmountInvalid => "REPAIR_AMOUNT_INVALID",
            RepairError::StatusInvalid => "REPAIR_STATUS_INVALID",
            RepairError::PayMethodInvalid => "REPAIR_PAY_METHOD_INVALID",
            RepairError::PayWalletInvalid => "REPAIR_PAY_WALLET_INVALID",
            RepairError::NotFound => "REPAIR_NOT_FOUND",
            RepairError::AlreadyDelivered => "REPAIR_ALREADY_DELIVERED",
        }
    }
}

impl fmt::Display for RepairError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for RepairError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_kind_parses_hardware_and_software() {
        assert_eq!(
            RepairServiceKind::parse("hardware"),
            Ok(RepairServiceKind::Hardware)
        );
        assert_eq!(
            RepairServiceKind::parse("software"),
            Ok(RepairServiceKind::Software)
        );
        assert_eq!(
            RepairServiceKind::parse("unknown"),
            Err(RepairError::StatusInvalid)
        );
    }

    #[test]
    fn status_parses_all_kanban_stages() {
        for (raw, expected) in [
            ("received", RepairStatus::Received),
            ("diagnosing", RepairStatus::Diagnosing),
            ("waiting", RepairStatus::Waiting),
            ("ready", RepairStatus::Ready),
            ("delivered", RepairStatus::Delivered),
            ("cancelled", RepairStatus::Cancelled),
        ] {
            assert_eq!(RepairStatus::parse(raw), Ok(expected));
            assert_eq!(expected.as_str(), raw);
        }
    }
}
