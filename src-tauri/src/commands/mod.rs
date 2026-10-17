//! Transport boundaries.
//!
//! Named commands only. There is deliberately no `execute_sql` or `select_sql`
//! command, so the WebView can never obtain general data access
//! (`spec:45`, `spec:148`, `plan:157`).

pub mod backup;
pub mod catalog;
/// The category tree (ADR-018 §1). Replaces the department commands of SP-1b.
pub mod categories;
pub mod customer;
pub mod identity;
pub mod identity_lifecycle;
pub mod inventory;
pub mod pos;
pub mod sales;
pub mod settings;
