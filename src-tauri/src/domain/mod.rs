//! Business rules and domain types.
//!
//! Depends on nothing from Tauri, SQLx, SQLite or any operating-system API
//! (`spec:99`, `ADR-008:121`). Sub-modules are added one per domain slice, and
//! the decomposition is decided by each slice rather than guessed up front.
//!
//! Slice couplings are deliberate and few, and each one names a reason:
//!
//! * `catalog → organisation`: a product carries a department and a VAT rate
//!   (`SP-1`, migrations `0004`/`0005`).
//! * `settings → organisation`: the device defaults reuse the same `CostMethod`
//!   and `VatRate` value types instead of defining a second spelling of the same
//!   vocabulary (`SP-1b`).
//! * `catalog → identity` and `organisation → identity`: attribution needs to
//!   name a user, and nothing more.
//! * `catalog → money`: amounts are integer piastres (`ADR-010`); `money` is the
//!   shared monetary vocabulary, not a slice.
//!
//! Any further slice-pairing import is a new architectural decision, not a
//! convenience.

pub mod backup;
pub mod catalog;
pub mod costing;
pub mod customer;
pub mod identity;
pub mod money;
pub mod organisation;
pub mod sales;
pub mod settings;
pub mod shift;
pub mod shortage;
pub mod supplier;
pub mod unit;
pub mod wallet;


