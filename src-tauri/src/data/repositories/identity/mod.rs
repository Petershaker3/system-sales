//! Identity persistence.
//!
//! The only layer permitted to contain SQL for identity concerns. Repositories
//! translate rows into domain types and never return SQL errors as domain
//! errors; the service layer owns that mapping.

pub mod audit;
pub mod credentials;
pub mod pattern;
pub mod session;
pub mod user;
