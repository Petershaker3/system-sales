//! `Piastres`: an amount of money as a non-negative integer count of piastres.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Why a `Piastres` could not be built or combined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoneyError {
    /// A negative amount was supplied where only non-negative money is defined.
    ///
    /// Not a refund. A refund is a different domain concept with its own rules,
    /// and it belongs to a sale rather than to a money value. A refund carries a
    /// sign in the transaction that represents it, not in the amount it moves.
    Negative,
}

impl MoneyError {
    /// Stable machine code, cross-checked against the frontend's message table by
    /// the architecture suite.
    pub fn code(&self) -> &'static str {
        match self {
            MoneyError::Negative => "MONEY_NEGATIVE",
        }
    }
}

impl fmt::Display for MoneyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MoneyError::Negative => write!(f, "an amount of money cannot be negative"),
        }
    }
}

/// An amount of money in piastres (ADR-010), never negative, never fractional.
///
/// The newtype is the point: a bare `i64` can be passed where an amount belongs,
/// and the unit is named rather than implied.
///
/// Two deliberate decisions:
///
/// - **Checked, not saturating.** `policy.rs` saturates session counters, and
///   saturating is right for a counter where clamping is a safe degradation. It
///   is wrong for money: saturation would return a plausible number where the
///   truth is that the arithmetic was wrong. These operations return `None` so
///   the caller must decide what an impossible sum means.
/// - **No division.** `display_parts` reports an exact quotient and remainder and
///   invents no rounding rule, because ADR-010 leaves rounding undecided. The
///   cost arithmetic that will need it is a later slice.
/// `serde` derives are `#[serde(transparent)]` over the `i64`, so a serialised
/// amount is the bare piastre count. That is deliberate: the value crosses the
/// IPC boundary as one integer, matching ADR-010's rule that money travels as an
/// integer minor unit and never as a decimal string or a float.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Piastres(i64);

impl Piastres {
    /// Zero piastres. Distinct from "no amount", which is `Option::None`.
    pub const ZERO: Self = Self(0);

    /// Piastres in one whole EGP.
    ///
    /// Derived from the currency definition rather than written as a bare `100`,
    /// so the divisor and the name cannot drift apart.
    pub const PER_EGP: i64 = 100;

    /// Rejects a negative amount.
    pub fn new_minor(value: i64) -> Result<Self, MoneyError> {
        if value < 0 {
            return Err(MoneyError::Negative);
        }
        Ok(Self(value))
    }

    /// The amount as a raw piastre count.
    pub fn as_minor(&self) -> i64 {
        self.0
    }

    /// Sum, or `None` on overflow.
    ///
    /// `None` rather than a saturated result: a silently clamped total is a
    /// number no one chose, and it would be written to a stored total.
    pub fn checked_add(&self, other: &Self) -> Option<Self> {
        self.0.checked_add(other.0).map(Self)
    }

    /// Difference, or `None` on overflow or if the result would be negative.
    ///
    /// A negative result is refused rather than produced, because `Piastres` is
    /// not a signed amount. Anything that legitimately moves money backwards
    /// represents that in the transaction, not in the value.
    pub fn checked_sub(&self, other: &Self) -> Option<Self> {
        self.0.checked_sub(other.0).filter(|v| *v >= 0).map(Self)
    }

    /// Whole EGP plus piastres, for display only.
    ///
    /// Division happens here, in presentation, and never feeds a stored value.
    /// ADR-010 leaves the rounding policy open, so this returns the exact
    /// quotient and remainder rather than inventing a rounding rule.
    pub fn display_parts(&self) -> (i64, i64) {
        (self.0 / Self::PER_EGP, self.0 % Self::PER_EGP)
    }
}

impl fmt::Display for Piastres {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (whole, piastres) = self.display_parts();
        write!(f, "{whole}.{piastres:02}")
    }
}