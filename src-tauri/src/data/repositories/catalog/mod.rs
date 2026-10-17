//! Catalogue persistence. The only layer permitted to contain SQL for products.

/// Phone brands and a phone's details (ADR-018 §2).
pub mod brand;
pub mod pos;
pub mod product;
