//! Transport boundaries.
//!
//! Named commands only. There is deliberately no `execute_sql` or `select_sql`
//! command, so the WebView can never obtain general data access
//! (`spec:45`, `spec:148`, `plan:157`).

pub mod catalog;
pub mod departments;
pub mod identity;
pub mod identity_lifecycle;
pub mod pattern;
pub mod settings;
