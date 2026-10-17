//! Transport boundaries.
//!
//! Named commands only. There is deliberately no `execute_sql` or `select_sql`
//! command, so the WebView can never obtain general data access
//! (`spec:45`, `spec:148`, `plan:157`).

pub mod backup;
pub mod catalog;
pub mod customer;
pub mod departments;
pub mod identity;
pub mod identity_lifecycle;
pub mod inventory;
pub mod pattern;
pub mod pos;
/// One-time supervised manager-password recovery (plan R1, Design B).
///
/// Recovery builds only. Without `--features recovery` this module does not
/// exist.
#[cfg(feature = "recovery")]
pub mod recovery;
pub mod sales;
pub mod settings;
