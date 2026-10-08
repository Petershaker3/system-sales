//! Product identity domain.
//!
//! Rules and types for the product catalogue. Depends on nothing from Tauri,
//! SQLx, SQLite or the operating system (`spec:99`, `ADR-008:121`), and nothing
//! from the identity slice's storage: `UserId` is borrowed as a plain identifier.

mod catalog;

pub use catalog::{
    Barcode, CatalogError, Disposition, Product, ProductId, ProductName, ProductStatus, SalePrice,
};
