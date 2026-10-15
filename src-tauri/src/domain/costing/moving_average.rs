//! Moving Average costing (`ADR-013`, spec §10).
//!
//! # The rule
//!
//! ```text
//! cost_removed = ceil( U · T / Q )
//! ```
//!
//! with `T` the total cost held (minor), `Q` the quantity on hand, and `U` the
//! units being removed. Ceiling only — the fraction is never kept.
//!
//! # Why no remainder column is needed
//!
//! The property that makes the rule safe is that the removed cost can never
//! exceed the total:
//!
//! 1. `U ≤ Q`, so `U · T / Q ≤ T`. `T` is a non-negative integer and the result
//!    is a ceiling of something at most `T`, so `cost_removed ≤ T`. Therefore
//!    `new_T = T − cost_removed ≥ 0` — the balance never goes negative.
//! 2. At `Q = 1`, `U = 1`: `cost_removed = ceil(T) = T` and `new_T = 0`.
//!    The sum of everything ever removed equals the original `T` exactly.
//!
//! Together these rule out cumulative drift, so a remainder column would carry no
//! information — which is why `ADR-013` rejects one.
//!
//! # The accepted cost of the ceiling
//!
//! Rounding up errs *against* profit by at most one piastre per line. That is the
//! intended direction: a phantom profit is worse than a piastre of missing
//! margin.

use crate::domain::costing::{ceil_div, CostError};

/// A stock position under Moving Average: how much it holds and what that
/// costs, in minor units.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AveragePosition {
    /// Total cost held, minor units.
    pub total_cost_minor: i64,
    /// Quantity on hand.
    pub on_hand: i64,
}

impl AveragePosition {
    /// An empty position.
    pub const EMPTY: Self = Self {
        total_cost_minor: 0,
        on_hand: 0,
    };

    /// Build a position, refusing negative inputs rather than normalising them.
    pub fn new(total_cost_minor: i64, on_hand: i64) -> Result<Self, CostError> {
        if total_cost_minor < 0 {
            return Err(CostError::NegativeTotal);
        }
        if on_hand < 0 {
            return Err(CostError::NegativeQuantity);
        }
        Ok(Self {
            total_cost_minor,
            on_hand,
        })
    }

    /// The average unit cost, ceilinged — the number a caller quotes.
    ///
    /// An empty position has no average cost, so it is `None` rather than zero.
    /// Zero would be a real price, and the panel must not show a free product
    /// that merely has no stock.
    pub fn unit_cost_minor(&self) -> Option<i64> {
        if self.on_hand == 0 {
            return None;
        }
        ceil_div(i128::from(self.total_cost_minor), self.on_hand).ok()
    }

    /// Remove `units`, returning what was removed and what remains.
    ///
    /// One transaction of arithmetic: both numbers come from the same call, so a
    /// caller cannot record the cost without recording the new balance, or the
    /// reverse.
    pub fn remove(&self, units: i64) -> Result<Removal, CostError> {
        if units == 0 {
            return Err(CostError::ZeroUnits);
        }
        if units < 0 {
            return Err(CostError::NegativeQuantity);
        }
        if units > self.on_hand {
            return Err(CostError::InsufficientStock {
                requested: units,
                available: self.on_hand,
            });
        }
        if self.on_hand == 0 {
            return Err(CostError::InsufficientStock {
                requested: units,
                available: 0,
            });
        }

        // i128 intermediate: `units * total_cost_minor` overflows i64 long
        // before the quantity itself does.
        let numerator = i128::from(units) * i128::from(self.total_cost_minor);
        let cost_removed_minor = ceil_div(numerator, self.on_hand)?;

        let remaining_minor = self
            .total_cost_minor
            .checked_sub(cost_removed_minor)
            .ok_or(CostError::Overflow)?;

        let remaining = Self {
            total_cost_minor: remaining_minor,
            on_hand: self.on_hand - units,
        };

        Ok(Removal {
            cost_removed_minor,
            remaining,
        })
    }

    /// Receive stock at a known unit cost, extending the position.
    ///
    /// Receiving is the one operation where the amount is known exactly, so it
    /// is added without rounding: there is no fraction to round.
    pub fn receive(&self, units: i64, unit_cost_minor: i64) -> Result<Self, CostError> {
        if units < 0 {
            return Err(CostError::NegativeQuantity);
        }
        if unit_cost_minor < 0 {
            return Err(CostError::NegativeTotal);
        }
        let added = units
            .checked_mul(unit_cost_minor)
            .ok_or(CostError::Overflow)?;
        let total = self
            .total_cost_minor
            .checked_add(added)
            .ok_or(CostError::Overflow)?;
        let on_hand = self.on_hand.checked_add(units).ok_or(CostError::Overflow)?;
        Ok(Self {
            total_cost_minor: total,
            on_hand,
        })
    }
}

/// What one removal cost and what it left behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Removal {
    /// Cost attributed to the units removed, minor units.
    pub cost_removed_minor: i64,
    /// The position afterwards.
    pub remaining: AveragePosition,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removal_is_ceiling_of_the_average() {
        // 10 units costing 1500 total → 150 each; sell 3 → exactly 450.
        let position = AveragePosition::new(1500, 10).unwrap();
        let removal = position.remove(3).unwrap();
        assert_eq!(removal.cost_removed_minor, 450);
        assert_eq!(removal.remaining.total_cost_minor, 1050);
        assert_eq!(removal.remaining.on_hand, 7);
    }

    #[test]
    fn fraction_rounds_up_never_down() {
        // 100 over 3 → 33.33 each; selling 1 costs 34, not 33.
        let position = AveragePosition::new(100, 3).unwrap();
        assert_eq!(position.unit_cost_minor(), Some(34));
        assert_eq!(position.remove(1).unwrap().cost_removed_minor, 34);
    }

    #[test]
    fn selling_the_last_unit_empties_the_balance_exactly() {
        // ADR-013 claim 2: at Q=1 the removal is exactly T and nothing is left.
        let position = AveragePosition::new(1234, 1).unwrap();
        let removal = position.remove(1).unwrap();
        assert_eq!(removal.cost_removed_minor, 1234);
        assert_eq!(removal.remaining.total_cost_minor, 0);
        assert_eq!(removal.remaining.on_hand, 0);
    }

    #[test]
    fn cost_removed_never_exceeds_the_total() {
        // ADR-013 claim 1, swept over quantities that divide unevenly.
        for on_hand in 1..=17i64 {
            for units in 1..=on_hand {
                let position = AveragePosition::new(1000, on_hand).unwrap();
                let removal = position.remove(units).unwrap();
                assert!(
                    removal.cost_removed_minor <= position.total_cost_minor,
                    "removal {removal:?} exceeded total on_hand={on_hand} units={units}"
                );
                assert!(removal.remaining.total_cost_minor >= 0);
            }
        }
    }

    #[test]
    fn everything_ever_sold_sums_to_the_original_total() {
        // No cumulative drift: selling one unit at a time, until empty, must
        // consume the total exactly.
        let mut position = AveragePosition::new(1000, 7).unwrap();
        let original = position.total_cost_minor;
        let mut spent = 0i64;
        while position.on_hand > 0 {
            let removal = position.remove(1).unwrap();
            spent += removal.cost_removed_minor;
            position = removal.remaining;
        }
        assert_eq!(spent, original);
    }

    #[test]
    fn empty_position_has_no_average_not_a_free_one() {
        let position = AveragePosition::EMPTY;
        assert_eq!(position.unit_cost_minor(), None);
    }

    #[test]
    fn removing_more_than_held_is_refused() {
        let position = AveragePosition::new(500, 3).unwrap();
        assert_eq!(
            position.remove(4),
            Err(CostError::InsufficientStock {
                requested: 4,
                available: 3
            })
        );
    }

    #[test]
    fn removing_zero_units_is_not_a_costing_operation() {
        let position = AveragePosition::new(500, 3).unwrap();
        assert_eq!(position.remove(0), Err(CostError::ZeroUnits));
    }

    #[test]
    fn negative_inputs_are_refused() {
        assert_eq!(AveragePosition::new(-1, 5), Err(CostError::NegativeTotal));
        assert_eq!(AveragePosition::new(100, -1), Err(CostError::NegativeQuantity));
    }

    #[test]
    fn receiving_adds_exactly_without_rounding() {
        let position = AveragePosition::new(300, 3).unwrap();
        let after = position.receive(5, 120).unwrap();
        assert_eq!(after.total_cost_minor, 900);
        assert_eq!(after.on_hand, 8);
    }

    #[test]
    fn large_intermediate_does_not_overflow_i64() {
        // The stored total fits comfortably in i64, but the intermediate
        // `units × total_cost_minor` does not: 3_000_000_000 units out of
        // 3_000_000_000 held, at 8_000_000_000 minor total, is 2.4e19 — well past
        // i64::MAX (~9.22e18). A naive i64 multiply would wrap negative and
        // produce a nonsense cost; the i128 intermediate keeps it exact.
        let position = AveragePosition::new(8_000_000_000, 3_000_000_000).unwrap();
        let removal = position.remove(3_000_000_000).unwrap();
        assert_eq!(removal.cost_removed_minor, 8_000_000_000);
        assert_eq!(removal.remaining.total_cost_minor, 0);
        assert_eq!(removal.remaining.on_hand, 0);
    }
}