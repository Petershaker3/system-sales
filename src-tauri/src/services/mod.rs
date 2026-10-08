//! Application services and use cases.
//!
//! Orchestration across repositories and infrastructure. No SQL here; queries
//! live under `data/repositories/`.

pub mod catalog;
pub mod identity;
pub mod organisation;
pub mod pattern;
pub mod settings;
