//! Application services and use cases.
//!
//! Orchestration across repositories and infrastructure. No SQL here; queries
//! live under `data/repositories/`.

pub mod backup;
pub mod catalog;
pub mod customer;
pub mod identity;
pub mod inventory;
pub mod organisation;
pub mod sales;
pub mod settings;
pub mod shift;
pub mod wallet;

