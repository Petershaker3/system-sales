//! Transport boundaries.
//!
//! Named commands only. There is deliberately no `execute_sql` or `select_sql`
//! command, so the WebView can never obtain general data access
//! (`spec:45`, `spec:148`, `plan:157`).

pub mod backup;
/// Phone brands and registering a new phone (ADR-018 §2).
pub mod brands;
pub mod catalog;
/// The category tree (ADR-018 §1). Replaces the department commands of SP-1b.
pub mod categories;
pub mod companion;
pub mod customer;
pub mod identity;
pub mod identity_lifecycle;
pub mod inventory;
pub mod pos;
pub mod repair;
pub mod sales;
pub mod settings;
/// Restarting the running application (`commands/shell.rs`).
pub mod shell;
pub mod shift;
pub mod shortage;
pub mod wallet;

