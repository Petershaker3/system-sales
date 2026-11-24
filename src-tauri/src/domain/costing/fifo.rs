//! FIFO costing (`ADR-013`, spec §10).
//!
//! # The rule
//!
//! Consume whole units from the oldest layer first. Because both the quantity
//! and the unit cost are integers, the removal is exact integer arithmetic:
//!
//! ```text
//! cost_removed = Σ (layer_remaining_quantity × layer_unit_cost_minor)
//! ```
//!
//! **FIFO needs no rounding at all** (`ADR-013` "FIFO لا يحتاج تقريبًا إطلاقًا").
//! That is the one asymmetry between the two approved methods: Moving Average
//! ceils a fraction every sale, FIFO never produces one.
//!
//! # Layers are truth, and are rebuildable
//!
//! A layer is not a stored average; it is a fact about when stock arrived and
//! what it cost then, and it is derivable from the movement ledger
//! (`ADR-013` "الطبقات حقيقة"). Partial consumption splits a layer rather than
//! rewriting it, so the remaining quantity keeps its original unit cost.
//!
//! # Ordering
//!
//! Layers arrive oldest-first, ordered by `(created_at, id)`. The id tiebreak
//! matters: two receipts in the same millisecond must still consume in a
//! deterministic order, or a replay would not reproduce the same costs.

use crate::domain::costing::CostError;

/// One FIFO layer: a quantity at a single unit cost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FifoLayer {
    /// Units in this layer.
    pub quantity: i64,
    /// Cost of one unit, minor units.
    pub unit_cost_minor: i64,
}

impl FifoLayer {
    /// Build a layer, refusing negatives and empties.
    ///
    /// A zero-quantity layer carries no cost fact and would only complicate the
    /// replay, so it is refused at construction rather than filtered later.
    pub fn new(quantity: i64, unit_cost_minor: i64) -> Result<Self, CostError> {
        if quantity <= 0 {
            return Err(CostError::NegativeQuantity);
        }
        if unit_cost_minor < 0 {
            return Err(CostError::NegativeTotal);
        }
        Ok(Self {
            quantity,
            unit_cost_minor,
        })
    }

    /// The full cost of this layer.
    fn value_minor(&self) -> Result<i64, CostError> {
        self.quantity
            .checked_mul(self.unit_cost_minor)
            .ok_or(CostError::Overflow)
    }
}

/// A FIFO stock position: layers oldest-first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FifoPosition {
    layers: Vec<FifoLayer>,
}

impl FifoPosition {
    /// An empty position.
    pub fn empty() -> Self {
        Self { layers: Vec::new() }
    }

    /// Build from layers that are already oldest-first.
    pub fn new(layers: Vec<FifoLayer>) -> Self {
        Self { layers }
    }

    /// The layers, oldest-first.
    pub fn layers(&self) -> &[FifoLayer] {
        &self.layers
    }

    /// Units on hand across all layers.
    pub fn on_hand(&self) -> i64 {
        self.layers.iter().map(|layer| layer.quantity).sum()
    }

    /// Total cost held, minor units.
    pub fn total_cost_minor(&self) -> Result<i64, CostError> {
        let mut total = 0i64;
        for layer in &self.layers {
            total = total
                .checked_add(layer.value_minor()?)
                .ok_or(CostError::Overflow)?;
        }
        Ok(total)
    }

    /// Receive stock as a new youngest layer.
    ///
    /// A receipt does not merge into an existing layer even at an identical
    /// price: keeping receipts separate is what makes the layer list a record
    /// rather than a summary, and it keeps consumption order obvious.
    pub fn receive(&self, units: i64, unit_cost_minor: i64) -> Result<Self, CostError> {
        let layer = FifoLayer::new(units, unit_cost_minor)?;
        let mut layers = self.layers.clone();
        layers.push(layer);
        Ok(Self { layers })
    }

    /// Remove `units`, oldest layer first, returning the cost and what remains.
    ///
    /// Consuming across a layer boundary costs each part at its own layer's
    /// price, which is the whole point of FIFO — a sale that straddles two
    /// receipts is costed at two different rates.
    pub fn remove(&self, units: i64) -> Result<FifoRemoval, CostError> {
        if units == 0 {
            return Err(CostError::ZeroUnits);
        }
        if units < 0 {
            return Err(CostError::NegativeQuantity);
        }
        let available = self.on_hand();
        if units > available {
            return Err(CostError::InsufficientStock {
                requested: units,
                available,
            });
        }

        let mut remaining_units = units;
        let mut cost_removed_minor = 0i64;
        let mut consumed: Vec<FifoConsumption> = Vec::new();
        let mut remaining_layers: Vec<FifoLayer> = Vec::with_capacity(self.layers.len());

        for (layer_index, layer) in self.layers.iter().enumerate() {
            if remaining_units == 0 {
                remaining_layers.push(*layer);
                continue;
            }
            if layer.quantity > remaining_units {
                // Partial: the layer keeps its unit cost, reduced in quantity.
                let left = layer.quantity - remaining_units;
                cost_removed_minor = cost_removed_minor
                    .checked_add(remaining_units * layer.unit_cost_minor)
                    .ok_or(CostError::Overflow)?;
                consumed.push(FifoConsumption {
                    layer_index,
                    quantity: remaining_units,
                    unit_cost_minor: layer.unit_cost_minor,
                });
                remaining_units = 0;
                remaining_layers.push(FifoLayer {
                    quantity: left,
                    unit_cost_minor: layer.unit_cost_minor,
                });
            } else {
                // Whole layer consumed: it disappears entirely.
                cost_removed_minor = cost_removed_minor
                    .checked_add(layer.value_minor()?)
                    .ok_or(CostError::Overflow)?;
                consumed.push(FifoConsumption {
                    layer_index,
                    quantity: layer.quantity,
                    unit_cost_minor: layer.unit_cost_minor,
                });
                remaining_units -= layer.quantity;
            }
        }

        debug_assert_eq!(remaining_units, 0, "stock check above must exhaust the request");

        Ok(FifoRemoval {
            cost_removed_minor,
            consumed,
            remaining: Self {
                layers: remaining_layers,
            },
        })
    }
}

/// One layer's contribution to a removal.
///
/// Carries the position's own layer index rather than a copy of the layer, so a
/// caller holding the ordered rows can map each consumption back to the exact
/// persisted layer it came from — and, for a partial consumption, tell it apart
/// from a whole one by comparing quantities.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FifoConsumption {
    /// Index into the position's layer list, oldest-first.
    pub layer_index: usize,
    /// Units taken from that layer.
    pub quantity: i64,
    /// That layer's unit cost.
    pub unit_cost_minor: i64,
}

/// What one FIFO removal cost and what it left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FifoRemoval {
    /// Cost of the units removed, minor units — exact, never rounded.
    pub cost_removed_minor: i64,
    /// Per-layer consumption, oldest first, describing exactly which layers were
    /// touched and by how much.
    pub consumed: Vec<FifoConsumption>,
    /// The position afterwards.
    pub remaining: FifoPosition,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position() -> FifoPosition {
        // Oldest first: 5 @ 100, then 3 @ 120.
        FifoPosition::new(vec![
            FifoLayer::new(5, 100).unwrap(),
            FifoLayer::new(3, 120).unwrap(),
        ])
    }

    #[test]
    fn consumption_comes_from_the_oldest_layer_first() {
        let removal = position().remove(4).unwrap();
        assert_eq!(removal.cost_removed_minor, 400);
        // 1 unit survives in the first layer, and the second is untouched.
        assert_eq!(removal.remaining.layers().len(), 2);
        assert_eq!(removal.remaining.layers()[0].quantity, 1);
        assert_eq!(removal.remaining.layers()[0].unit_cost_minor, 100);
        assert_eq!(removal.remaining.layers()[1].quantity, 3);
        assert_eq!(removal.remaining.layers()[1].unit_cost_minor, 120);
    }

    #[test]
    fn a_sale_straddling_two_layers_uses_both_prices() {
        let removal = position().remove(6).unwrap();
        // 5 @ 100 plus 1 @ 120
        assert_eq!(removal.cost_removed_minor, 620);
        assert_eq!(removal.remaining.layers().len(), 1);
        assert_eq!(removal.remaining.layers()[0].quantity, 2);
        assert_eq!(removal.remaining.layers()[0].unit_cost_minor, 120);
    }

    #[test]
    fn consumption_names_the_exact_layer_and_units_it_took() {
        // 5 @ 100 (index 0, whole) then 1 @ 120 (index 1, partial).
        let removal = position().remove(6).unwrap();
        assert_eq!(
            removal.consumed,
            vec![
                FifoConsumption {
                    layer_index: 0,
                    quantity: 5,
                    unit_cost_minor: 100,
                },
                FifoConsumption {
                    layer_index: 1,
                    quantity: 1,
                    unit_cost_minor: 120,
                },
            ]
        );
    }

    #[test]
    fn partial_consumption_names_only_the_layer_it_touched() {
        let removal = position().remove(4).unwrap();
        assert_eq!(
            removal.consumed,
            vec![FifoConsumption {
                layer_index: 0,
                quantity: 4,
                unit_cost_minor: 100,
            }]
        );
    }

    #[test]
    fn consuming_everything_empties_the_position_exactly() {
        let original = position().total_cost_minor().unwrap();
        let removal = position().remove(8).unwrap();
        assert_eq!(removal.cost_removed_minor, original);
        assert_eq!(removal.remaining.layers().len(), 0);
        assert_eq!(removal.remaining.on_hand(), 0);
        assert_eq!(removal.remaining.total_cost_minor().unwrap(), 0);
    }

    #[test]
    fn no_rounding_is_ever_needed() {
        // A layer price that divides badly under Moving Average is still exact
        // here, because the quantity taken is whole.
        let position = FifoPosition::new(vec![FifoLayer::new(3, 34).unwrap()]);
        let removal = position.remove(1).unwrap();
        assert_eq!(removal.cost_removed_minor, 34);
    }

    #[test]
    fn insufficient_stock_is_refused_with_the_available_count() {
        let position = position();
        assert_eq!(
            position.remove(9),
            Err(CostError::InsufficientStock {
                requested: 9,
                available: 8
            })
        );
    }

    #[test]
    fn zero_and_negative_removals_are_refused() {
        let position = position();
        assert_eq!(position.remove(0), Err(CostError::ZeroUnits));
        assert_eq!(position.remove(-1), Err(CostError::NegativeQuantity));
    }

    #[test]
    fn receipts_never_merge() {
        let position = FifoPosition::empty()
            .receive(5, 100)
            .unwrap()
            .receive(5, 100)
            .unwrap();
        // Same price, still two layers: the list is a record, not a summary.
        assert_eq!(position.layers().len(), 2);
        assert_eq!(position.on_hand(), 10);
    }

    #[test]
    fn empty_layer_is_refused_at_construction() {
        assert_eq!(FifoLayer::new(0, 100), Err(CostError::NegativeQuantity));
        assert_eq!(FifoLayer::new(-1, 100), Err(CostError::NegativeQuantity));
        assert_eq!(FifoLayer::new(1, -1), Err(CostError::NegativeTotal));
    }
}