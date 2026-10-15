//! Sales domain (Sales V1): invoice references, sale failures, calendar math.
//!
//! Cash-only sales recorded atomically with stock deduction and cost
//! consumption. A sale is an immutable document: nothing here edits one, and
//! cancellation arrives as a separate reversal sale, never as a rewrite.
//!
//! Money stays integer piastres (`ADR-010`) with the same checked, never
//! clamped, arithmetic as `money::Piastres`.

use std::fmt;

/// What a sale operation can refuse, as its own vocabulary.
///
/// Kept apart from `DomainError` (identity) and `CostError` (costing) on
/// purpose, exactly as `StockServiceError` keeps its vocabularies apart: a
/// sale refusal is neither an authentication failure nor an arithmetic one,
/// and collapsing them would send an operator to the wrong place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaleError {
    /// The sale carries no lines.
    Empty,
    /// The product is archived and off sale.
    ProductArchived,
    /// No sale carries the id a caller named.
    NotFound,
    /// A confirmed total no longer matches the authoritative prices.
    ///
    /// Raised when the operator confirmed a total and, by the time the sale
    /// commits, a price on the same lines has changed. The sale is refused
    /// rather than silently committed at the new price: the operator must see
    /// the new figure and confirm again.
    PriceChanged,
    /// The product's disposition cannot be sold in V1 (`serialized`).
    DispositionNotSupported,
    /// The product has no selling price set.
    PriceNotSet,
    /// A line quantity is zero, negative, or otherwise unusable.
    InvalidQuantity,
    /// The invoice reference collided or the daily sequence is exhausted.
    ReferenceConflict,
    /// The sale was already cancelled.
    AlreadyCancelled,
    /// Restored stock disagrees with the original consumption basis.
    ReversalInconsistent,
    /// The database is busy; the attempt may be retried.
    ///
    /// Retryable, and deliberately distinct from every business refusal: a
    /// busy device is not a wrong request.
    Busy,
    /// The sale already carries a customer link or snapshot; linking again
    /// would rewrite which customer the document belongs to.
    CustomerAlreadyLinked,
    /// Only a live `sale` document takes a customer. Reversals mirror their
    /// original and take none.
    LinkNotAllowed,
    /// A warranty date is not a day that exists, or is not written as
    /// `YYYY-MM-DD`.
    WarrantyDateInvalid,
    /// A warranty range ends before it starts.
    WarrantyRangeInvalid,
}

impl SaleError {
    /// Stable machine code, cross-checked against the frontend's message table.
    pub fn code(&self) -> &'static str {
        match self {
            SaleError::Empty => "SALE_EMPTY",
            SaleError::ProductArchived => "SALE_PRODUCT_ARCHIVED",
            SaleError::NotFound => "SALE_NOT_FOUND",
            SaleError::PriceChanged => "SALE_PRICE_CHANGED",
            SaleError::DispositionNotSupported => "SALE_DISPOSITION_NOT_SUPPORTED",
            SaleError::PriceNotSet => "SALE_PRICE_NOT_SET",
            SaleError::InvalidQuantity => "SALE_INVALID_QUANTITY",
            SaleError::ReferenceConflict => "SALE_REFERENCE_CONFLICT",
            SaleError::AlreadyCancelled => "SALE_ALREADY_CANCELLED",
            SaleError::ReversalInconsistent => "SALE_REVERSAL_INCONSISTENT",
            SaleError::Busy => "SALE_BUSY",
            SaleError::CustomerAlreadyLinked => "SALE_CUSTOMER_ALREADY_LINKED",
            SaleError::LinkNotAllowed => "SALE_LINK_NOT_ALLOWED",
            SaleError::WarrantyDateInvalid => "SALE_WARRANTY_DATE_INVALID",
            SaleError::WarrantyRangeInvalid => "SALE_WARRANTY_RANGE_INVALID",
        }
    }
}

impl fmt::Display for SaleError {
    /// Developer-facing only; the operator reads the Arabic message the frontend
    /// holds, indexed by `code()`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SaleError::Empty => write!(f, "a sale must carry at least one line"),
            SaleError::ProductArchived => write!(f, "the product is archived and off sale"),
            SaleError::NotFound => write!(f, "no sale with this id"),
            SaleError::PriceChanged => {
                write!(f, "a confirmed price changed before the sale could commit")
            }
            SaleError::DispositionNotSupported => {
                write!(f, "this product disposition cannot be sold in V1")
            }
            SaleError::PriceNotSet => write!(f, "the product has no selling price set"),
            SaleError::InvalidQuantity => write!(f, "the line quantity is not usable"),
            SaleError::ReferenceConflict => {
                write!(f, "the invoice reference collided or the daily sequence is exhausted")
            }
            SaleError::AlreadyCancelled => write!(f, "the sale was already cancelled"),
            SaleError::ReversalInconsistent => {
                write!(f, "restored stock disagrees with the original consumption basis")
            }
            SaleError::Busy => write!(f, "the database is busy; the attempt may be retried"),
            SaleError::CustomerAlreadyLinked => {
                write!(f, "the sale already carries a customer")
            }
            SaleError::LinkNotAllowed => {
                write!(f, "only a live sale document takes a customer")
            }
            SaleError::WarrantyDateInvalid => {
                write!(f, "a warranty date must be a real day written as YYYY-MM-DD")
            }
            SaleError::WarrantyRangeInvalid => {
                write!(f, "a warranty cannot end before it starts")
            }
        }
    }
}

impl std::error::Error for SaleError {}

/// Split Unix-epoch milliseconds into `(year, month, day)`, UTC.
///
/// Integer arithmetic only (Howard Hinnant's civil-from-days): no date library
/// exists in this crate, and adding one for a single conversion would be a new
/// dependency on an offline POS for no reason. `div_euclid` keeps pre-epoch
/// values correct rather than implementation-defined.
pub fn civil_ymd_from_millis(millis: i64) -> (i32, u32, u32) {
    let days = millis.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m as u32, d as u32)
}

/// Build an invoice reference from its parts.
///
/// An empty prefix is the documented device default
/// (`domain::settings`, "bare sequence numbers"), so it yields no leading
/// dash: `20261012-0001` rather than `-20261012-0001`. The prefix is used
/// verbatim — it is the operator's identifier, and inventing a normal form
/// for it would change what the shop recognises.
pub fn format_invoice_reference(prefix: &str, year: i32, month: u32, day: u32, seq: u32) -> String {
    let date = format!("{year:04}{month:02}{day:02}");
    if prefix.is_empty() {
        format!("{date}-{seq:04}")
    } else {
        format!("{prefix}-{date}-{seq:04}")
    }
}

/// A calendar day an operator entered as a warranty boundary (decisions D4, D8).
///
/// Ten ASCII characters, `YYYY-MM-DD`, and nothing else. This is the one date in
/// the schema that is deliberately NOT epoch milliseconds: "covered until 15
/// March" must mean the same day on every device, in every timezone, whatever the
/// clock says — and an instant would make the last day of a warranty depend on
/// both.
///
/// # Why the text is the value
///
/// ISO days sort lexicographically in chronological order, which is what lets the
/// table enforce `warranty_end >= warranty_start` with a plain comparison and no
/// date arithmetic. `Ord` is therefore derived and means what it looks like it
/// means; `tests/unit` proves text order and date order agree.
///
/// The day is computed rather than accepted, so 30 February is refused instead of
/// stored.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WarrantyDate(String);

impl WarrantyDate {
    /// Parse and validate `YYYY-MM-DD`.
    ///
    /// Exactly ten ASCII characters with dashes in the fourth and seventh
    /// positions, digits elsewhere, a month of 1..=12 and a day that exists in
    /// that month of that year. Everything else — an unpadded `2026-3-5`,
    /// `15-03-2026`, a full ISO instant, a localised digit, surrounding spaces —
    /// is [`SaleError::WarrantyDateInvalid`].
    pub fn parse(raw: &str) -> Result<Self, SaleError> {
        let bytes = raw.as_bytes();
        let shaped = bytes.len() == 10
            && bytes[4] == b'-'
            && bytes[7] == b'-'
            && [0, 1, 2, 3, 5, 6, 8, 9]
                .iter()
                .all(|index| bytes[*index].is_ascii_digit());
        if !shaped {
            return Err(SaleError::WarrantyDateInvalid);
        }
        // Safe to slice: the shape check proved bytes 0-3, 5-6 and 8-9 are ASCII,
        // so every boundary below falls on a character boundary.
        let year: u32 = raw[0..4].parse().map_err(|_| SaleError::WarrantyDateInvalid)?;
        let month: u32 = raw[5..7].parse().map_err(|_| SaleError::WarrantyDateInvalid)?;
        let day: u32 = raw[8..10].parse().map_err(|_| SaleError::WarrantyDateInvalid)?;
        if year == 0 || !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
            return Err(SaleError::WarrantyDateInvalid);
        }
        Ok(Self(raw.to_owned()))
    }

    /// The stored text, exactly as the operator's day is written.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// This date's text together with the end the operator gave, checked against
    /// each other.
    ///
    /// The same day is a valid one-day warranty; an end nobody stated stays `None`
    /// rather than being filled in. A range that runs backwards is
    /// [`SaleError::WarrantyRangeInvalid`] — the operator must see and fix it, not
    /// have it stored as written.
    pub fn checked_end(&self, end: Option<WarrantyDate>) -> Result<Option<String>, SaleError> {
        match end {
            Some(end) if end.0 < self.0 => Err(SaleError::WarrantyRangeInvalid),
            Some(end) => Ok(Some(end.0)),
            None => Ok(None),
        }
    }
}

impl fmt::Display for WarrantyDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Days in a month, with the full Gregorian leap rule: divisible by 4, except
/// centuries, except every 400th year.
fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}
