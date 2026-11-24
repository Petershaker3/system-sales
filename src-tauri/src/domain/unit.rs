//! Serialized device units (`units` table, `ADR-019`, `PLAN.md` §7 & §11).
//!
//! Pure domain rules for 15-digit Luhn-verified IMEIs, tracking modes
//! (`none | serial_optional | serial_required`), receipt kinds
//! (`supplier | opening`), and unit status transitions (`in_stock | sold | retired`).
//! Knows no SQLx, no SQLite, and no Tauri.

use std::collections::HashSet;
use std::fmt;

/// Maximum length for an optional unit colour label.
pub const UNIT_COLOR_MAX_CHARS: usize = 40;
/// Maximum length for included accessories on a used phone (`علبة، شاحن، فاتورة`).
pub const UNIT_ACCESSORIES_MAX_CHARS: usize = 240;
/// Maximum length for the seller's name on a used phone intake.
pub const UNIT_SELLER_NAME_MAX_CHARS: usize = 120;
/// Maximum length for the seller's phone on a used phone intake.
pub const UNIT_SELLER_PHONE_MAX_CHARS: usize = 40;
/// Maximum length for defects / inspection notes on a used phone intake.
pub const UNIT_INTAKE_NOTE_MAX_CHARS: usize = 400;

/// Domain refusals for IMEI units and stock receipts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnitError {
    /// An IMEI must be 15 digits after stripping whitespace and hyphens.
    ImeiLengthInvalid,
    /// The 15th digit does not match the Luhn check digit of the first 14.
    ImeiCheckDigitInvalid,
    /// This IMEI already exists in the shop (`in_stock` or previously `sold`).
    ImeiAlreadyRegistered,
    /// The same IMEI was scanned/entered twice in one receipt or sale request.
    ImeiDuplicateInBatch,
    /// Secondary IMEI (`imei2`) is identical to primary IMEI (`imei`).
    ImeiSecondaryMatchesPrimary,
    /// More IMEIs were provided on a receipt line than the line's quantity.
    ImeiCountExceedsQuantity,
    /// The product or global `ui.imei_mode = required` requires an IMEI for every unit.
    ImeiRequiredForAllUnits,
    /// Attempted to attach an IMEI to an item that is counted only (`tracking = none`).
    ProductNotSerialTracked,
    /// The unit with this IMEI is already sold or retired.
    UnitNotAvailable,
    /// The unit with this IMEI belongs to a different product.
    UnitProductMismatch,
    /// Tried to late-register a new IMEI at sale time, but every unit on hand is already registered.
    NoUnregisteredStockForLateImei,
    /// An opening-balance receipt (`opening`) may not carry a supplier name.
    OpeningReceiptHasSupplier,
    /// Unknown receipt kind string.
    ReceiptKindInvalid,
    /// Unit colour exceeds 40 characters.
    ColorTooLong,
    /// Used phone condition grade is not `A`, `B`, or `C`.
    GradeInvalid,
    /// Used phone battery health percentage is outside `1..=100`.
    BatteryHealthInvalid,
    /// Seller national ID must be 14 digits when provided.
    NationalIdInvalid,
    /// Used phone accessories, seller details, or intake note exceeds max length.
    NoteTooLong,
}

impl UnitError {
    /// Stable machine code, cross-checked against `src/api/errors.ts`.
    pub fn code(&self) -> &'static str {
        match self {
            UnitError::ImeiLengthInvalid => "IMEI_LENGTH_INVALID",
            UnitError::ImeiCheckDigitInvalid => "IMEI_CHECK_DIGIT_INVALID",
            UnitError::ImeiAlreadyRegistered => "IMEI_ALREADY_REGISTERED",
            UnitError::ImeiDuplicateInBatch => "IMEI_DUPLICATE_IN_BATCH",
            UnitError::ImeiSecondaryMatchesPrimary => "IMEI_SECONDARY_MATCHES_PRIMARY",
            UnitError::ImeiCountExceedsQuantity => "IMEI_COUNT_EXCEEDS_QUANTITY",
            UnitError::ImeiRequiredForAllUnits => "IMEI_REQUIRED_FOR_ALL_UNITS",
            UnitError::ProductNotSerialTracked => "IMEI_PRODUCT_NOT_SERIAL_TRACKED",
            UnitError::UnitNotAvailable => "IMEI_UNIT_NOT_AVAILABLE",
            UnitError::UnitProductMismatch => "IMEI_UNIT_PRODUCT_MISMATCH",
            UnitError::NoUnregisteredStockForLateImei => "IMEI_NO_UNREGISTERED_STOCK",
            UnitError::OpeningReceiptHasSupplier => "RECEIPT_OPENING_HAS_SUPPLIER",
            UnitError::ReceiptKindInvalid => "RECEIPT_KIND_INVALID",
            UnitError::ColorTooLong => "UNIT_COLOR_TOO_LONG",
            UnitError::GradeInvalid => "UNIT_GRADE_INVALID",
            UnitError::BatteryHealthInvalid => "UNIT_BATTERY_HEALTH_INVALID",
            UnitError::NationalIdInvalid => "UNIT_NATIONAL_ID_INVALID",
            UnitError::NoteTooLong => "UNIT_NOTE_TOO_LONG",
        }
    }
}

impl fmt::Display for UnitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for UnitError {}

/// Compute the Luhn check digit (`0..=9`) for a 14-digit ASCII string.
pub fn luhn_check_digit(first_14: &str) -> Option<u8> {
    if first_14.len() != 14 || !first_14.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut sum: u32 = 0;
    for (idx, b) in first_14.bytes().enumerate() {
        let mut d = u32::from(b - b'0');
        if idx % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    Some(((10 - (sum % 10)) % 10) as u8)
}

/// Normalize Arabic-Indic digits (`٠`–`٩`, `۰`–`۹`) and strip spaces/dashes.
pub fn normalize_imei_digits(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_whitespace() || ch == '-' {
            continue;
        }
        if ('\u{0660}'..='\u{0669}').contains(&ch) {
            let digit = (ch as u32) - ('\u{0660}' as u32);
            out.push(char::from(b'0' + digit as u8));
        } else if ('\u{06F0}'..='\u{06F9}').contains(&ch) {
            let digit = (ch as u32) - ('\u{06F0}' as u32);
            out.push(char::from(b'0' + digit as u8));
        } else {
            out.push(ch);
        }
    }
    out
}

/// A validated 15-digit Luhn-checked IMEI.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Imei(String);

impl Imei {
    /// Validate a 15-digit IMEI and its Luhn check digit.
    pub fn parse(raw: &str) -> Result<Self, UnitError> {
        let normalized = normalize_imei_digits(raw);
        if normalized.len() != 15 || !normalized.bytes().all(|b| b.is_ascii_digit()) {
            return Err(UnitError::ImeiLengthInvalid);
        }
        let expected = luhn_check_digit(&normalized[..14]).ok_or(UnitError::ImeiLengthInvalid)?;
        let actual = normalized.as_bytes()[14] - b'0';
        if actual != expected {
            return Err(UnitError::ImeiCheckDigitInvalid);
        }
        Ok(Self(normalized))
    }

    /// Parse a batch of IMEI strings, refusing duplicates within the batch.
    pub fn parse_batch(raw_list: &[String]) -> Result<Vec<Self>, UnitError> {
        let mut out = Vec::with_capacity(raw_list.len());
        let mut seen = HashSet::with_capacity(raw_list.len());
        for raw in raw_list {
            let imei = Self::parse(raw)?;
            if !seen.insert(imei.0.clone()) {
                return Err(UnitError::ImeiDuplicateInBatch);
            }
            out.push(imei);
        }
        Ok(out)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Imei {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// How a product tracks individual units (`products.tracking`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackingMode {
    None,
    SerialOptional,
    SerialRequired,
}

impl TrackingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::SerialOptional => "serial_optional",
            Self::SerialRequired => "serial_required",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "none" => Some(Self::None),
            "serial_optional" => Some(Self::SerialOptional),
            "serial_required" => Some(Self::SerialRequired),
            _ => None,
        }
    }

    pub fn allows_imei(self) -> bool {
        !matches!(self, Self::None)
    }

    pub fn requires_imei(self, global_imei_mode: &str) -> bool {
        match self {
            Self::None => false,
            Self::SerialRequired => true,
            Self::SerialOptional => global_imei_mode == "required",
        }
    }
}

/// Whether a stock receipt is a supplier purchase or first-time opening stock (`ADR-016` #30).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptKind {
    Supplier,
    Opening,
}

impl ReceiptKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supplier => "supplier",
            Self::Opening => "opening",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, UnitError> {
        match raw.trim() {
            "supplier" => Ok(Self::Supplier),
            "opening" => Ok(Self::Opening),
            _ => Err(UnitError::ReceiptKindInvalid),
        }
    }
}

/// Lifecycle status of a registered device unit (`units.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitStatus {
    InStock,
    Sold,
    Retired,
}

impl UnitStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InStock => "in_stock",
            Self::Sold => "sold",
            Self::Retired => "retired",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "in_stock" => Some(Self::InStock),
            "sold" => Some(Self::Sold),
            "retired" => Some(Self::Retired),
            _ => None,
        }
    }
}

/// Optional unit colour label, trimmed and bounded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitColor(String);

impl UnitColor {
    pub fn parse_optional(raw: Option<&str>) -> Result<Option<Self>, UnitError> {
        let Some(raw) = raw else {
            return Ok(None);
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        if trimmed.chars().count() > UNIT_COLOR_MAX_CHARS {
            return Err(UnitError::ColorTooLong);
        }
        Ok(Some(Self(trimmed.to_owned())))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Used phone condition grade (`A` = زي الجديد, `B` = خدوش خفيفة, `C` = عيوب واضحة).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionGrade {
    A,
    B,
    C,
}

impl ConditionGrade {
    pub fn parse(raw: &str) -> Result<Self, UnitError> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "A" | "فئة A" => Ok(Self::A),
            "B" | "فئة B" => Ok(Self::B),
            "C" | "فئة C" => Ok(Self::C),
            _ => Err(UnitError::GradeInvalid),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::B => "B",
            Self::C => "C",
        }
    }
}

/// Build the stored title of a used phone (`docs/ui/mockup-v1/views/catalog.js` `usedTitle`).
pub fn used_phone_title(base_phone_title: &str, grade: ConditionGrade) -> String {
    format!("{} مستعمل فئة {}", base_phone_title.trim(), grade.as_str())
}

/// Validate optional battery health percentage (`1..=100`).
pub fn validate_battery_health_pct(raw: Option<i64>) -> Result<Option<i64>, UnitError> {
    match raw {
        None | Some(0) => Ok(None),
        Some(v) if (1..=100).contains(&v) => Ok(Some(v)),
        Some(_) => Err(UnitError::BatteryHealthInvalid),
    }
}

/// Validate optional 14-digit Egyptian national ID (`رقم البطاقة`).
pub fn validate_national_id(raw: Option<&str>) -> Result<Option<String>, UnitError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let digits = normalize_imei_digits(trimmed);
    if digits.len() != 14 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(UnitError::NationalIdInvalid);
    }
    Ok(Some(digits))
}

/// Validate optional text bounded by `max_chars`.
pub fn validate_optional_bounded(
    raw: Option<&str>,
    max_chars: usize,
) -> Result<Option<String>, UnitError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > max_chars {
        return Err(UnitError::NoteTooLong);
    }
    Ok(Some(trimmed.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn used_phone_grade_battery_and_national_id_validate() {
        assert_eq!(ConditionGrade::parse("a"), Ok(ConditionGrade::A));
        assert_eq!(ConditionGrade::parse("فئة B"), Ok(ConditionGrade::B));
        assert_eq!(ConditionGrade::parse("X"), Err(UnitError::GradeInvalid));
        assert_eq!(
            used_phone_title("iPhone 13 128GB", ConditionGrade::A),
            "iPhone 13 128GB مستعمل فئة A"
        );
        assert_eq!(validate_battery_health_pct(Some(88)), Ok(Some(88)));
        assert_eq!(validate_battery_health_pct(Some(0)), Ok(None));
        assert_eq!(
            validate_battery_health_pct(Some(105)),
            Err(UnitError::BatteryHealthInvalid)
        );
        assert_eq!(
            validate_national_id(Some("٢٩٨٠١٠١١٢٣٤٥٦٧")),
            Ok(Some("29801011234567".to_owned()))
        );
        assert_eq!(
            validate_national_id(Some("12345")),
            Err(UnitError::NationalIdInvalid)
        );
    }

    #[test]
    fn luhn_accepts_valid_15_digit_imeis_and_rejects_bad_check_digits() {
        let valid = Imei::parse("356938035643809").expect("valid Luhn IMEI");
        assert_eq!(valid.as_str(), "356938035643809");

        let arabic_digits = Imei::parse("٣٥٦٩٣٨٠٣٥٦٤٣٨٠٩").expect("Arabic digits normalized");
        assert_eq!(arabic_digits.as_str(), "356938035643809");

        assert_eq!(
            Imei::parse("356938035643800"),
            Err(UnitError::ImeiCheckDigitInvalid)
        );
        assert_eq!(
            Imei::parse("35693803564380"),
            Err(UnitError::ImeiLengthInvalid)
        );
        assert_eq!(
            Imei::parse("3569380356438091"),
            Err(UnitError::ImeiLengthInvalid)
        );
    }

    #[test]
    fn batch_parser_rejects_duplicate_imeis_in_same_request() {
        let dup = vec![
            "356938035643809".to_string(),
            "356938035643809".to_string(),
        ];
        assert_eq!(Imei::parse_batch(&dup), Err(UnitError::ImeiDuplicateInBatch));
    }

    #[test]
    fn tracking_mode_respects_global_imei_setting() {
        assert!(!TrackingMode::None.allows_imei());
        assert!(!TrackingMode::None.requires_imei("required"));
        assert!(TrackingMode::SerialOptional.allows_imei());
        assert!(!TrackingMode::SerialOptional.requires_imei("optional"));
        assert!(TrackingMode::SerialOptional.requires_imei("required"));
        assert!(TrackingMode::SerialRequired.requires_imei("optional"));
    }
}
