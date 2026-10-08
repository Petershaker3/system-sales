//! Settings: device-level configuration (SP-1b).
//!
//! Not business history: a record that a manager changed the default cost
//! method is not a history of costing, but a history of who decided the method.
//! The audit trail records who changed what; `product_price_history` records
//! what the shop's prices were. This module records neither — it is only the
//! current configuration and the rules for changing it.
//!
//! No inventory arithmetic lives here.

use std::fmt;

use crate::domain::organisation::{CostMethod, VatRate};

/// The operational on/off flag for Pattern protection.
///
/// Deliberately **not** a [`SettingKey`]: the generic settings write path
/// refuses unknown keys, so leaving this one out is what guarantees only the
/// pattern slice (`set` / `disable`) can flip protection, never an arbitrary
/// `settings_update`. The snapshot skips the row when it loads (its value is
/// read by `services::pattern::is_enabled`), and since `update` refuses
/// unknown keys, every stored key other than this one is a snapshot key.
pub const PATTERN_REQUIRED: &str = "pattern_required";

/// A setting name the domain recognises.
///
/// An unrecognised key is refused rather than stored: a typo in a key would
/// otherwise create a row nothing ever reads, and the operator would believe
/// their change had taken effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SettingKey {
    DefaultCostMethod,
    InvoicePrefix,
    DefaultVatEnabled,
    DefaultVatRateBp,
    DefaultVatInclusive,
    MaxDiscountKind,
    MaxDiscountValue,
}

impl SettingKey {
    /// The stored key. The same string in `app_settings.key`.
    pub fn as_str(self) -> &'static str {
        match self {
            SettingKey::DefaultCostMethod => "default_cost_method",
            SettingKey::InvoicePrefix => "invoice_prefix",
            SettingKey::DefaultVatEnabled => "default_vat_enabled",
            SettingKey::DefaultVatRateBp => "default_vat_rate_bp",
            SettingKey::DefaultVatInclusive => "default_vat_inclusive",
            SettingKey::MaxDiscountKind => "max_discount_kind",
            SettingKey::MaxDiscountValue => "max_discount_value",
        }
    }

    /// Parse a stored or supplied key.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "default_cost_method" => Some(SettingKey::DefaultCostMethod),
            "invoice_prefix" => Some(SettingKey::InvoicePrefix),
            "default_vat_enabled" => Some(SettingKey::DefaultVatEnabled),
            "default_vat_rate_bp" => Some(SettingKey::DefaultVatRateBp),
            "default_vat_inclusive" => Some(SettingKey::DefaultVatInclusive),
            "max_discount_kind" => Some(SettingKey::MaxDiscountKind),
            "max_discount_value" => Some(SettingKey::MaxDiscountValue),
            _ => None,
        }
    }
}

/// Whether a maximum discount is a sum of money or a percentage.
///
/// Stored inertly: no discount is ever computed here. The pair
/// (`kind`, `value`) is read by the sales slice when it exists — `value` is
/// piastres when the kind is `Money`, basis points when it is `Percentage`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DiscountKind {
    #[default]
    Money,
    Percentage,
}

impl DiscountKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DiscountKind::Money => "money",
            DiscountKind::Percentage => "percentage",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "money" => Some(DiscountKind::Money),
            "percentage" => Some(DiscountKind::Percentage),
            _ => None,
        }
    }
}

impl fmt::Display for DiscountKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The device's current configuration, with defaults already applied.
///
/// Every field has a domain default, and a missing key reads as that default —
/// a setting is configuration, not an invariant, and a partially configured
/// device must still open (`plan` SP-1b, Assumption 4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsSnapshot {
    /// Cost method for a product whose department does not decide one, and the
    /// device-wide default for new departments.
    pub default_cost_method: CostMethod,
    /// Prefix for invoice references like `2026-10-07-001`. Empty by default:
    /// the prefix is an addition to the reference, not a replacement, and a
    /// device that never set one generates bare sequence numbers
    /// (`plan` SP-1b, Assumption 2).
    pub invoice_prefix: String,
    /// Whether VAT applies to a product by default. Off until switched on.
    pub default_vat_enabled: bool,
    /// Rate in basis points; `None` when the device has never set one.
    /// `Some(0)` is a legitimate recorded zero, distinct from never set.
    pub default_vat_rate_bp: Option<VatRate>,
    /// Whether the default price is understood to include VAT.
    pub default_vat_inclusive: bool,
    /// Unit of `max_discount_value`.
    pub max_discount_kind: DiscountKind,
    /// The limit in its unit: piastres if the kind is `Money`, basis points if
    /// `Percentage`. `0` means no discount allowed — the default fails closed
    /// (`plan` SP-1b, Assumption 3).
    pub max_discount_value: u64,
}

impl Default for SettingsSnapshot {
    fn default() -> Self {
        Self {
            // Moving average is the shop's ordinary default; FIFO is chosen
            // deliberately per department by a manager.
            default_cost_method: CostMethod::MovingAverage,
            invoice_prefix: String::new(),
            default_vat_enabled: false,
            default_vat_rate_bp: None,
            default_vat_inclusive: false,
            max_discount_kind: DiscountKind::Money,
            max_discount_value: 0,
        }
    }
}

impl SettingsSnapshot {
    /// Apply one stored or supplied `(key, value)` pair.
    ///
    /// The single validation path: the write service calls it before storing,
    /// and the read path calls it on every stored row. A key the domain does
    /// not know is [`SettingsError::UnknownKey`]; a value the key cannot hold
    /// is [`SettingsError::MalformedValue`]. Neither is ever silently
    /// defaulted — a malformed *stored* value means something wrote around
    /// this function, and hiding that would keep it writing around it.
    pub fn set(&mut self, key: &str, value: &str) -> Result<(), SettingsError> {
        let malformed = |reason: &'static str| SettingsError::MalformedValue {
            key: key.to_string(),
            reason,
        };

        match SettingKey::parse(key) {
            None => Err(SettingsError::UnknownKey {
                key: key.to_string(),
            }),
            Some(SettingKey::DefaultCostMethod) => {
                self.default_cost_method =
                    CostMethod::parse(value).ok_or(malformed("expected moving_average|fifo"))?;
                Ok(())
            }
            Some(SettingKey::InvoicePrefix) => {
                self.invoice_prefix = value.to_string();
                Ok(())
            }
            Some(SettingKey::DefaultVatEnabled) => {
                self.default_vat_enabled = parse_bool(value).ok_or(malformed("expected 0|1"))?;
                Ok(())
            }
            Some(SettingKey::DefaultVatRateBp) => {
                // Empty clears the rate back to "never set"; a recorded zero
                // is written as "0". Clearing rather than overloading `0` is
                // what keeps "never set" distinct from "set to zero".
                if value.is_empty() {
                    self.default_vat_rate_bp = None;
                    return Ok(());
                }
                let basis_points: i64 = match value.parse() {
                    Ok(parsed) => parsed,
                    Err(_) => return Err(malformed("expected integer bp")),
                };
                self.default_vat_rate_bp =
                    Some(VatRate::new(basis_points).map_err(|_| malformed("negative"))?);
                Ok(())
            }
            Some(SettingKey::DefaultVatInclusive) => {
                self.default_vat_inclusive = parse_bool(value).ok_or(malformed("expected 0|1"))?;
                Ok(())
            }
            Some(SettingKey::MaxDiscountKind) => {
                self.max_discount_kind =
                    DiscountKind::parse(value).ok_or(malformed("expected money|percentage"))?;
                Ok(())
            }
            Some(SettingKey::MaxDiscountValue) => {
                self.max_discount_value = match value.parse() {
                    Ok(parsed) => parsed,
                    Err(_) => return Err(malformed("expected non-negative integer")),
                };
                Ok(())
            }
        }
    }
}

/// SQLite stores booleans as `0`/`1`, and so do the settings.
fn parse_bool(value: &str) -> Option<bool> {
    match value {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    }
}

/// Why a settings write was refused.
///
/// Carries its own stable codes, cross-checked against the frontend's Arabic
/// message table by the architecture suite in both directions — the same
/// defence the other domain error enums have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsError {
    /// The key is not one this domain recognises. Refused rather than stored:
    /// an unknown row is a row nothing reads while the operator believes their
    /// change took effect.
    UnknownKey { key: String },
    /// The value cannot be held by this key: wrong shape, wrong range.
    MalformedValue {
        key: String,
        reason: &'static str,
    },
}

impl SettingsError {
    /// Stable machine code, cross-checked against `src/api/errors.ts` by the
    /// architecture suite in both directions.
    pub fn code(&self) -> &'static str {
        match self {
            SettingsError::UnknownKey { .. } => "SETTING_UNKNOWN_KEY",
            SettingsError::MalformedValue { .. } => "SETTING_VALUE_INVALID",
        }
    }
}

impl fmt::Display for SettingsError {
    /// Developer-facing only; the operator reads the Arabic message indexed by
    /// [`SettingsError::code`].
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SettingsError::UnknownKey { key } => write!(f, "unknown setting key: {key}"),
            SettingsError::MalformedValue { key, reason } => {
                write!(f, "invalid value for `{key}`: {reason}")
            }
        }
    }
}

impl std::error::Error for SettingsError {}
