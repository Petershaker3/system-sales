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

/// Warranty start/end per sold line (P4, decisions D4/D8/D9). Closes the gap
/// `0012` left open: two nullable `YYYY-MM-DD` columns on `sale_lines` (a
/// calendar day, not an instant), shape-checked by CHECK and range-checked by
/// trigger, with no default period and no backfill.
pub const WARRANTY: &str = include_str!("0013_warranty.sql");

/// The supplier label on receiving (P4b, decision D1). One nullable column on the
/// receipt's own movement row: the supplier list is derived from history rather
/// than stored twice, and there is no counterparty entity in V1.
pub const RECEIVING_SUPPLIER: &str = include_str!("0014_receiving_supplier.sql");
/// `0015`: the daily PIN, owner-PIN approvals and the recovery code (ADR-017).
pub const PIN_APPROVAL_RECOVERY: &str = include_str!("0015_pin_approval_recovery.sql");

/// `0016`: the two-level category tree (ADR-018 §1) — a parent, a kind, an icon
/// and a hidden flag on `departments`, with triggers that keep the tree two
/// levels deep and a sub-category on its parent's kind.
pub const CATEGORY_TREE: &str = include_str!("0016_category_tree.sql");

/// `0017`: phone brands, and a phone's company, model, device type, storage
/// and RAM on its product (ADR-018 §2), with triggers that keep the details
/// whole.
pub const BRANDS_AND_PHONE_DETAILS: &str = include_str!("0017_brands_and_phone_details.sql");

/// `0018`: product variants (`product_parents` and `parent_id`, `variant_1`,
/// `variant_2`, `variant_order` on `products`, ADR-018 §4), with triggers that
/// keep the details whole.
pub const PRODUCT_VARIANTS: &str = include_str!("0018_product_variants.sql");

/// `0019`: product images (`product_images(product_id, file, w, h, bytes)`,
/// ADR-018 §5), storing only the external file reference and verified metadata.
pub const PRODUCT_IMAGES: &str = include_str!("0019_product_images.sql");

/// `0020`: optional IMEI units, opening-stock receipts, and phone unit sales
/// (`units`, `products.tracking`, `stock_movements.receipt_kind`,
/// `sale_lines.unit_id`, ADR-019).
pub const IMEI_UNITS_AND_RECEIVING: &str = include_str!("0020_imei_units_and_receiving.sql");

/// `0021`: invoice payments (`sale_payments`) and customer credit ledger
/// (`customer_ledger`) for Plan item 1.5 (ADR-020).
pub const SALE_PAYMENTS_AND_CUSTOMER_LEDGER: &str =
    include_str!("0021_sale_payments_and_customer_ledger.sql");

/// `0022`: sale and sale-line discounts plus owner-approval attribution on
/// `sales` for Plan item 1.6 (ADR-021).
pub const SALE_DISCOUNTS: &str = include_str!("0022_sale_discounts.sql");

/// `0023`: shifts (`shifts`), drawer expenses (`expenses`), and cash movements
/// (`cash_movements`) for Plan item 1.9 (ADR-024).
pub const SHIFTS_AND_EXPENSES: &str = include_str!("0023_shifts_and_expenses.sql");

/// `0024`: shop wallets (`wallets`) and wallet/service operations ledger
/// (`wallet_ops`) for Plan item 1.10 (ADR-025).
pub const WALLETS_AND_SERVICES: &str = include_str!("0024_wallets_and_services.sql");

/// `0025`: partial line returns, exchanges, and damaged stock (`sale_returns`,
/// `damaged_stock`, `sale_lines.reverses_line_id`, `sale_lines.return_condition`)
/// for Plan item 1.11 (ADR-026).
pub const PARTIAL_RETURNS_AND_DAMAGED_STOCK: &str =
    include_str!("0025_partial_returns_and_damaged_stock.sql");

/// `0026`: manual and system-suggested shortages list (`shortages`)
/// for Plan item 1.15 (ADR-030).
pub const SHORTAGES: &str = include_str!("0026_shortages.sql");








