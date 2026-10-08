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
