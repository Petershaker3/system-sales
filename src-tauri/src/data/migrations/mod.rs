//! Versioned SQLite migrations, applied forward only.
//!
//! `plan:143` fixes the recovery model as restore-a-backup then forward-fix, so
//! there is deliberately no `Down` script and none should be added.
//!
//! No synchronisation table belongs here. ADR-008 places all sync outside V1.

/// Identity: accounts, sessions and the audit trail.
pub const IDENTITY: &str = include_str!("0001_identity.sql");

/// Product identity catalogue.
pub const CATALOG: &str = include_str!("0002_catalog.sql");

/// User lifecycle: login identifier, forced password change, disable/enable.
pub const IDENTITY_LIFECYCLE: &str = include_str!("0003_identity_lifecycle.sql");

/// Departments: product classification, plus its costing and VAT defaults.
///
/// Stored here but inert: no costing engine or VAT arithmetic reads these columns
/// yet. A department is a classification, not a physical location.
pub const DEPARTMENTS: &str = include_str!("0004_departments.sql");

/// The product inventory profile: the third disposition class, a department
/// classification, a default unit cost and a VAT rate.
///
/// Rebuilds `products` atomically. That is safe only while nothing references
/// `products`; see the migration's own header.
pub const PRODUCTS_INVENTORY_PROFILE: &str =
    include_str!("0005_products_inventory_profile.sql");

/// Device settings, and the product price-change history (SP-1b).
pub const SETTINGS_AND_PRICE_HISTORY: &str =
    include_str!("0006_settings_and_price_history.sql");

/// The Pattern step-up approval mechanism (SP-1c). `ADR-014`.
pub const PATTERN: &str = include_str!("0007_pattern.sql");

/// Stock positions and FIFO cost layers (SP-2).
///
/// This is the slice `ADR-012` §7 was waiting for: `departments.cost_method`
/// stops being inert configuration here and becomes arithmetic. One stock
/// counter per product (`product_id` alone, no location), plus the FIFO layers
/// that make first-in-first-out exact rather than rounded.
pub const STOCK_AND_COST_LAYERS: &str = include_str!("0008_stock_and_cost_layers.sql");

/// Single-use recovery approvals (R1). Applied by the migration runner like
/// every other file in this directory; the constant keeps the inventory of
/// migrations reviewable in one place.
pub const RECOVERY_APPROVAL: &str = include_str!("0009_recovery_approval.sql");

/// Recovery attempt throttling (R1 closure, B1). Present in every build: the
/// table is inert unless the recovery feature is on, and shipping it in
/// production keeps the migration chain identical across builds.
pub const RECOVERY_ATTEMPT: &str = include_str!("0010_recovery_attempt.sql");

/// Cash sales, sale lines, the movement ledger and reversals (Sales V1).
/// Purely additive: sale documents, per-line immutable snapshots, one movement
/// row per stock change, and a reversal link that makes double cancellation
/// structurally impossible.
pub const SALES: &str = include_str!("0011_sales.sql");

/// Customer file core + sale link columns (P4).
/// Purely additive: one table plus two nullable columns on `sales`.
/// Warranty columns are deliberately absent (decision D4 pending).
pub const CUSTOMERS: &str = include_str!("0012_customers.sql");
