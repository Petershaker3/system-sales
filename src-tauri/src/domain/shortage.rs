//! Manual and system-suggested shortages domain (`النواقص`, Plan item 1.15, `ADR-030`, `PLAN.md` §11).
//!
//! Pure domain types, validation, Arabic normalization, and suggested reorder
//! quantity arithmetic. No SQL, Tauri, or operating-system API appears here.

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_SHORTAGE_NAME_CHARS: usize = 160;
pub const MAX_SHORTAGE_NOTE_CHARS: usize = 300;
pub const MAX_SHORTAGE_CUSTOMER_NAME_CHARS: usize = 120;
pub const MAX_SHORTAGE_CUSTOMER_PHONE_CHARS: usize = 64;

/// Stable identifier of a shortage row (`UUID v7`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ShortageId(String);

impl ShortageId {
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

/// Lifecycle state of an active shortage (`open` = `ناقص`, `ordered` = `اتطلب`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ShortageStatus {
    Open,
    Ordered,
}

impl ShortageStatus {
    pub fn parse(raw: &str) -> Result<Self, ShortageError> {
        match raw.trim() {
            "open" => Ok(ShortageStatus::Open),
            "ordered" => Ok(ShortageStatus::Ordered),
            _ => Err(ShortageError::StatusInvalid),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ShortageStatus::Open => "open",
            ShortageStatus::Ordered => "ordered",
        }
    }
}

/// One active or resolved shortage entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortageEntry {
    pub id: String,
    pub product_id: Option<String>,
    pub name: String,
    pub qty: i64,
    pub note: String,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub status: String,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    pub on_hand: Option<i64>,
    pub min_qty: Option<i64>,
}

/// One system-suggested shortage for a product at or below its minimum threshold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortageSuggestion {
    pub product_id: String,
    pub name: String,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub on_hand: i64,
    pub min_qty: i64,
    pub suggested_qty: i64,
}

/// Default minimum stock threshold by product category/tracking kind (`docs/ui/mockup-v1/data.js`).
///
/// - Used phones (`kind == "used"`): `1`
/// - New phones (`serial` / `kind == "phone"`): `2`
/// - Counted items (`item`): `5`
pub fn default_min_qty(is_serial: bool, category_kind: Option<&str>) -> i64 {
    if category_kind == Some("used") {
        1
    } else if is_serial || category_kind == Some("phone") {
        2
    } else {
        5
    }
}

/// Suggested reorder quantity to bring a product up to `2 × min_qty` (`suggestQty` in `views/shortages.js`).
pub fn suggested_qty(on_hand: i64, min_qty: i64) -> i64 {
    (min_qty.saturating_mul(2).saturating_sub(on_hand)).max(1)
}

/// Normalize an Arabic/Latin item name for case-insensitive, alef/ta-marbuta-insensitive matching.
pub fn normalize_shortage_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = true;
    for ch in raw.trim().chars() {
        let mapped = match ch {
            'أ' | 'إ' | 'آ' | 'ٱ' => 'ا',
            'ة' => 'ه',
            'ى' => 'ي',
            'ؤ' => 'و',
            'ئ' => 'ي',
            '٠'..='٩' => char::from_u32((ch as u32) - ('٠' as u32) + ('0' as u32)).unwrap_or(ch),
            '\u{0640}' | '\u{064B}'..='\u{065F}' => continue,
            c if c.is_whitespace() => ' ',
            c => c.to_ascii_lowercase(),
        };
        if mapped == ' ' {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(mapped);
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

pub fn validate_name(raw: &str) -> Result<String, ShortageError> {
    let trimmed = raw.trim();
    let count = trimmed.chars().count();
    if count == 0 || count > MAX_SHORTAGE_NAME_CHARS {
        return Err(ShortageError::NameRequired);
    }
    Ok(trimmed.to_owned())
}

pub fn validate_qty(qty: i64) -> Result<i64, ShortageError> {
    if qty < 1 || qty > 100_000 {
        return Err(ShortageError::QtyInvalid);
    }
    Ok(qty)
}

pub fn validate_note(raw: Option<&str>) -> Result<String, ShortageError> {
    let trimmed = raw.unwrap_or("").trim();
    if trimmed.chars().count() > MAX_SHORTAGE_NOTE_CHARS {
        return Err(ShortageError::NoteTooLong);
    }
    Ok(trimmed.to_owned())
}

pub fn validate_customer(
    customer_name: Option<&str>,
    customer_phone: Option<&str>,
) -> Result<(Option<String>, Option<String>), ShortageError> {
    let name = match customer_name.map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => {
            if n.chars().count() > MAX_SHORTAGE_CUSTOMER_NAME_CHARS {
                return Err(ShortageError::CustomerInvalid);
            }
            Some(n.to_owned())
        }
        None => None,
    };
    let phone = match customer_phone.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => {
            if p.chars().count() > MAX_SHORTAGE_CUSTOMER_PHONE_CHARS {
                return Err(ShortageError::CustomerInvalid);
            }
            Some(p.to_owned())
        }
        None => None,
    };
    Ok((name, phone))
}

/// Domain errors for the shortages slice (`ADR-030`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShortageError {
    NameRequired,
    QtyInvalid,
    NoteTooLong,
    CustomerInvalid,
    StatusInvalid,
    NotFound,
    DeleteForbidden,
}

impl ShortageError {
    pub fn code(&self) -> &'static str {
        match self {
            ShortageError::NameRequired => "SHORTAGE_NAME_REQUIRED",
            ShortageError::QtyInvalid => "SHORTAGE_QTY_INVALID",
            ShortageError::NoteTooLong => "SHORTAGE_NOTE_TOO_LONG",
            ShortageError::CustomerInvalid => "SHORTAGE_CUSTOMER_INVALID",
            ShortageError::StatusInvalid => "SHORTAGE_STATUS_INVALID",
            ShortageError::NotFound => "SHORTAGE_NOT_FOUND",
            ShortageError::DeleteForbidden => "SHORTAGE_DELETE_FORBIDDEN",
        }
    }
}

impl fmt::Display for ShortageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggested_qty_reaches_twice_min_or_at_least_one() {
        assert_eq!(default_min_qty(false, Some("item")), 5);
        assert_eq!(default_min_qty(true, Some("phone")), 2);
        assert_eq!(default_min_qty(true, Some("used")), 1);
        assert_eq!(suggested_qty(0, 5), 10);
        assert_eq!(suggested_qty(3, 5), 7);
        assert_eq!(suggested_qty(1, 2), 3);
    }

    #[test]
    fn normalize_shortage_name_unifies_arabic_variants() {
        assert_eq!(
            normalize_shortage_name("  اسكرينة آيفون ١٦  "),
            normalize_shortage_name("إسكرينه ايفون 16")
        );
    }
}
