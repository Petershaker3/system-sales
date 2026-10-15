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
