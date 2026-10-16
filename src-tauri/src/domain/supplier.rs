//! The supplier label on receiving (P4b, decision D1).
//!
//! `spec:29` and `§231` keep simplified receiving to a supplier NAME, a quantity
//! and a unit cost: no purchase orders, no payables, no counterparty entity. This
//! module is deliberately only that — a bounded, trimmed piece of the operator's
//! own text.
//!
//! What it is NOT, and why the distinction matters:
//!
//! * Not an identity. There is no supplier id, no registry, no `suppliers` table.
//!   The list the shop needs is derived from the ledger
//!   (`SELECT DISTINCT supplier_name … WHERE kind = 'receipt'`), so there is one
//!   place for the fact to live and nothing to keep in step with it.
//! * Not a payable. Nothing here is money and nothing here is owed.
//!
//! The bound is the input field's, not the storage layer's appetite for long
//! text: this is a label typed on a phone by someone receiving a delivery.

use std::fmt;

/// Longest supplier name accepted, matching the operator's field.
pub const SUPPLIER_NAME_MAX_CHARS: usize = 120;

/// What a supplier name can be refused for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupplierError {
    /// The operator typed nothing, or only spaces.
    ///
    /// Refused rather than trimmed into an empty string: an empty supplier is a
    /// supplier the shop can neither search for nor tell apart from "none given".
    NameRequired,
    /// Longer than the operator's field.
    NameTooLong,
}

impl SupplierError {
    /// Stable machine code, cross-checked against the frontend's message table.
    pub fn code(&self) -> &'static str {
        match self {
            SupplierError::NameRequired => "SUPPLIER_NAME_REQUIRED",
            SupplierError::NameTooLong => "SUPPLIER_NAME_TOO_LONG",
        }
    }
}

impl fmt::Display for SupplierError {
    /// Developer-facing only; the operator reads the Arabic message the frontend
    /// holds, indexed by [`SupplierError::code`].
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SupplierError::NameRequired => write!(f, "a supplier name is required"),
            SupplierError::NameTooLong => {
                write!(f, "a supplier name must be at most {SUPPLIER_NAME_MAX_CHARS} characters")
            }
        }
    }
}

impl std::error::Error for SupplierError {}

/// A supplier label, trimmed and bounded.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SupplierName(String);

impl SupplierName {
    /// Validate and trim what the operator typed.
    ///
    /// Trimming is a normalisation of one value, not a repair of an invalid one:
    /// a field that is *only* spaces is refused ([`SupplierError::NameRequired`])
    /// rather than quietly becoming a supplier with no name. Case and digits are
    /// left exactly as typed — folding them is a comparison rule for the storage
    /// index, never a transformation of the operator's text.
    pub fn parse(raw: &str) -> Result<Self, SupplierError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(SupplierError::NameRequired);
        }
        if trimmed.chars().count() > SUPPLIER_NAME_MAX_CHARS {
            return Err(SupplierError::NameTooLong);
        }
        Ok(Self(trimmed.to_owned()))
    }

    /// What an untouched optional field means.
    ///
    /// Blank means *no supplier* (`None`), which the column stores as NULL — the
    /// one spelling of "nobody named a supplier". This is why the two are not
    /// interchangeable: `Some("")` would be a blank row in the derived list.
    pub fn parse_optional(raw: &str) -> Result<Option<Self>, SupplierError> {
        if raw.trim().is_empty() {
            return Ok(None);
        }
        Self::parse(raw).map(Some)
    }

    /// The stored text, exactly as it will be written to the column.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SupplierName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}