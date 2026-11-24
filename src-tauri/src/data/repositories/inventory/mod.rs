//! Inventory persistence: stock positions and FIFO cost layers (SP-2).
//!
//! Introduced by migration `0008`, the slice `ADR-012` §7 was waiting for: the
//! point at which `departments.cost_method` stops being inert configuration and
//! becomes arithmetic.

pub mod stock;
pub mod unit;
