//! Persistence: database access, migrations and repositories.
//!
//! The only layer allowed to name SQLx or SQLite (`spec:101`,
//! `ADR-008:123`).

pub mod db;
pub mod migrations;
pub mod repositories;
