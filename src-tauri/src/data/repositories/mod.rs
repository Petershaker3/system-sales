//! Persistence abstraction.
//!
//! Repositories isolate SQLite so that `domain/` never sees SQL and
//! `services/` never writes a query. Adding methods here as slices arrive is
//! expected; adding SQL above this directory is not.

pub mod catalog;
pub mod customer;
pub mod identity;
pub mod inventory;
pub mod organisation;
pub mod sales;
pub mod settings;
pub mod shift;
pub mod wallet;

