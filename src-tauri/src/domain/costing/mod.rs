//! Inventory cost arithmetic — Moving Average + FIFO (`ADR-013`, spec §10).
//!
//! # What this module owns
//!
//! The arithmetic, and nothing else. Storage, permissions, auditing and
//! transaction boundaries live in the service and repository layers; this module
//! knows no SQLx, no pool and no session.
//!
//! # The contract, as enforced here
//!
//! * **Rounding.** Any fractional piastre rounds *up*, at computation only
//!   (`spec` §10, `ADR-013` "التقريب"). `10.01 → 11`, `10.99 → 11`, `10.00 → 10`.
//!   Nearest, half-up and banker's rounding are all wrong and are not offered.
//! * **No stored fraction.** Rounding produces an integer minor-unit count. There
//!   is no remainder column and no persisted fractional state (`ADR-013` §"لا
//!   يحتاج عمود remainder" — the proof makes the remainder carry no information).
//! * **`i128` intermediates.** `units × total_cost_minor` overflows `i64` at
//!   plausible volumes, so every product is computed in `i128` and narrowed once,
//!   under an explicit check.
//! * **No float.** No `f32`, `f64`, `REAL`, or decimal string anywhere in this
//!   module (`spec:56`, `ADR-010`).
//!
//! # Shared vocabulary
//!
//! [`CostMethod`] is **not** defined here. It already lives in
//! [`crate::domain::organisation`] beside the department that owns the setting,
//! and a second spelling of the same enum is exactly the drift `domain/mod.rs`
//! forbids; this module imports that one.

pub mod fifo;
pub mod moving_average;

pub use crate::domain::organisation::CostMethod;

/// Why a costing operation could not be completed.
///
/// Every variant is a refusal that must stop the caller: a costing engine that
/// guessed past an impossible input would write a number nobody chose into a
/// stored total.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CostError {
    /// A negative quantity reached the arithmetic.
    NegativeQuantity,
    /// A total cost reached the arithmetic that was already negative.
    NegativeTotal,
    /// More units were removed than the item holds.
    InsufficientStock {
        /// Units the caller asked to remove.
        requested: i64,
        /// Units actually available.
        available: i64,
    },
    /// A single removal was requested for zero units, which is not a costing
    /// operation.
    ZeroUnits,
    /// The result did not fit in `i64` minor units.
    Overflow,
}

impl CostError {
    /// Stable machine code, indexed by the frontend's message table and covered
    /// by the architecture suite's drift guard.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NegativeQuantity => "COST_NEGATIVE_QUANTITY",
            Self::NegativeTotal => "COST_NEGATIVE_TOTAL",
            Self::InsufficientStock { .. } => "COST_INSUFFICIENT_STOCK",
            Self::ZeroUnits => "COST_ZERO_UNITS",
            Self::Overflow => "COST_OVERFLOW",
        }
    }
}

impl std::fmt::Display for CostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NegativeQuantity => write!(f, "a quantity cannot be negative"),
            Self::NegativeTotal => write!(f, "a total cost cannot be negative"),
            Self::InsufficientStock {
                requested,
                available,
            } => write!(
                f,
                "cannot remove {requested} units: only {available} are held"
            ),
            Self::ZeroUnits => write!(f, "removing zero units is not a costing operation"),
            Self::Overflow => write!(f, "the costing result does not fit in an integer amount"),
        }
    }
}

impl std::error::Error for CostError {}

/// Integer ceiling division — the single place the rounding rule is implemented.
///
/// `numerator / denominator` truncated, then +1 when a remainder survives. The
/// denominator is a quantity and is required to be positive; a non-positive one
/// is a caller bug, not a rounding question, and is refused rather than folded
/// into a wrong answer.
pub fn ceil_div(numerator: i128, denominator: i64) -> Result<i64, CostError> {
    if denominator <= 0 {
        return Err(CostError::NegativeQuantity);
    }
    let divisor = i128::from(denominator);
    let quotient = numerator / divisor;
    let rounded = if numerator % divisor > 0 {
        quotient + 1
    } else {
        quotient
    };
    if rounded > i128::from(i64::MAX) || rounded < 0 {
        return Err(CostError::Overflow);
    }
    Ok(rounded as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_division_is_unchanged() {
        assert_eq!(ceil_div(450, 10), Ok(45));
        assert_eq!(ceil_div(0, 10), Ok(0));
    }

    #[test]
    fn any_fraction_rounds_up() {
        // 100/3 = 33.33 → 34, not 33
        assert_eq!(ceil_div(100, 3), Ok(34));
        // 101/100 = 1.01 → 2, not 1
        assert_eq!(ceil_div(101, 100), Ok(2));
        // 199/100 = 1.99 → 2
        assert_eq!(ceil_div(199, 100), Ok(2));
    }

    #[test]
    fn zero_remainder_does_not_rise() {
        // 200/100 = 2 exactly; a banker's/half-up bug would show up here as 2
        assert_eq!(ceil_div(200, 100), Ok(2));
        assert_eq!(ceil_div(100, 100), Ok(1));
    }

    #[test]
    fn non_positive_denominator_is_refused() {
        assert_eq!(ceil_div(10, 0), Err(CostError::NegativeQuantity));
        assert_eq!(ceil_div(10, -5), Err(CostError::NegativeQuantity));
    }

    #[test]
    fn overflow_is_refused_not_saturated() {
        // A value one past i64::MAX must refuse rather than clamp to i64::MAX.
        let too_big = i128::from(i64::MAX) + 1;
        assert_eq!(ceil_div(too_big * 10, 1), Err(CostError::Overflow));
    }

    #[test]
    fn intermediate_uses_i128_beyond_i64() {
        // 4e9 × 4e9 = 1.6e19, past i64::MAX (9.22e18). Computed in i128 it is
        // exact; an i64 multiply would wrap negative.
        let product = i128::from(4_000_000_000i64) * i128::from(4_000_000_000i64);
        assert!(product > i128::from(i64::MAX));
        assert_eq!(ceil_div(product, 4_000_000_000), Ok(4_000_000_000));
    }
}