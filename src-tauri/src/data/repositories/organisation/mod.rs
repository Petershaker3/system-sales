//! Department persistence.
//!
//! The only place SQL for departments may appear. Functions take
//! `&mut SqliteConnection` so the same code serves a pooled call and a call
//! inside a transaction, as in the catalogue and identity repositories.
//!
//! Departments are a product classification. Nothing in this file references
//! stock, quantity, a warehouse, a branch or any other physical place: V1 has one
//! stock counter per product, so a department classifies rather than locates.

pub mod department;

pub use department::{archive, find_by_id, insert, list_active, list_all, update};