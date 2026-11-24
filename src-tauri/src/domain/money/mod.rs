//! Money as integer minor units.
//!
//! ADR-010 fixes the currency to EGP and the minor unit to the piastre, so every
//! amount in this system is an `i64` count of piastres. `1 EGP = 100 piastres`
//! and two decimal places follow from that single definition rather than from a
//! per-field one.
//!
//! This module owns that representation. It exists so there is exactly one money
//! type in the domain: a second type carrying the same number is a second place
//! for the unit to be misread, and ADR-002 already forbids reusing one name for
//! two meanings.
//!
//! **No arithmetic beyond addition and subtraction lives here yet.** Division and
//! the rounding policy are deliberately absent. ADR-010 left rounding open and the
//! inventory delivery specification has not yet closed it in a form this codebase
//! has implemented, so there is no `div`, no rounding helper and no VAT. Adding
//! one before that decision would encode a guess as though it were a rule.

pub mod minor;

pub use minor::{MoneyError, Piastres};