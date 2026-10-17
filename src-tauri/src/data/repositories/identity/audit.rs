//! Audit trail.
//!
//! `spec:19` attributes every operation to the executing user, and Product Owner
//! decision 2026-10-03 records login, logout and lockout here as well.
//!
//! `user_id` is nullable on purpose: a failed login against an account that does
//! not exist is exactly the event worth keeping, and there is no user to
//! attribute it to.

use sqlx::SqliteConnection;

use crate::domain::identity::UserId;
use crate::domain::identity::Timestamp;

/// Event names. Kept as constants so a typo cannot silently create a new
/// category that no query ever matches.
pub mod event {
    pub const FIRST_MANAGER_CREATED: &str = "first_manager_created";
    pub const LOGIN_SUCCEEDED: &str = "login_succeeded";
    pub const LOGIN_FAILED: &str = "login_failed";
    pub const ACCOUNT_LOCKED: &str = "account_locked";
    pub const LOGOUT: &str = "logout";
    pub const REAUTHENTICATED: &str = "reauthenticated";

    // User lifecycle. All of these record *who did what to whom*, never a
    // credential: `spec:19` attributes every operation, and the schema forbids
    // storing anything secret in `detail`.
    pub const USER_CREATED: &str = "user_created";
    pub const PASSWORD_CHANGED: &str = "password_changed";
    /// A manager set someone else's password. Distinct from
    /// `PASSWORD_CHANGED` so a report can separate self-service from recovery.
    pub const PASSWORD_RESET: &str = "password_reset";
    /// The retired single-use recovery of plan R1 (the `recovery` build,
    /// replaced by the recovery code, ADR-017 §4). Nothing writes these two any
    /// more; they stay so the rows written before keep a name.
    pub const RECOVERY_APPROVED: &str = "recovery_approved";
    pub const RECOVERY_EXECUTED: &str = "recovery_executed";
    /// The owner made a recovery code (ADR-017 §4), replacing any earlier one.
    /// Detail says whether it was the first; never the code or its verifier.
    pub const RECOVERY_CODE_CREATED: &str = "recovery_code_created";
    /// A recovery-code attempt was refused. Detail carries the reason —
    /// bad_code, no_code, disabled or no_such_user — and, for a wrong code,
    /// the failure count the sign-in lockout shares.
    pub const RECOVERY_CODE_FAILED: &str = "recovery_code_failed";
    /// A forgotten password was replaced with the recovery code. Every session
    /// on the device ended and the code was replaced by a new one, which the
    /// detail records; never the code, the password or a verifier.
    pub const PASSWORD_RECOVERED_WITH_CODE: &str = "password_recovered_with_code";
    pub const ROLE_CHANGED: &str = "role_changed";
    pub const USER_DISABLED: &str = "user_disabled";
    pub const USER_ENABLED: &str = "user_enabled";
    pub const USERNAME_CHANGED: &str = "username_changed";
    /// The daily PIN was set or changed by its owner (ADR-017 §1). Detail says
    /// whether it was the first PIN; it never carries the PIN or its verifier.
    pub const PIN_SET: &str = "pin_set";
    /// A manager set a seller's PIN (ADR-017 §1). Detail names the target and
    /// how many of the target's sessions were ended.
    pub const PIN_SET_BY_MANAGER: &str = "pin_set_by_manager";
    /// The owner entered the PIN to approve one sensitive operation on the
    /// current session (ADR-017 §3). Detail names the approver and the
    /// session's operator; never the PIN or its verifier. The operation that
    /// spends the approval names the approver again in its own detail.
    pub const OWNER_APPROVAL_GRANTED: &str = "owner_approval_granted";
    /// An approval attempt was refused. Detail carries the reason — bad_pin,
    /// no_pin, locked, disabled, not_a_manager or no_such_user — and, for a
    /// wrong PIN, the approver's failure count: the same counter a wrong
    /// sign-in advances.
    pub const OWNER_APPROVAL_FAILED: &str = "owner_approval_failed";

/// Departments: the product classification.
///
/// `DEPARTMENT_RESTORED` is intentionally absent. Restoration clears `archived_at`
/// and returns the department to active, which is an `department_updated` whose
/// detail records the previous state — a separate event name would double the
/// vocabulary without adding a fact.
pub const DEPARTMENT_CREATED: &str = "department_created";
pub const DEPARTMENT_UPDATED: &str = "department_updated";
pub const DEPARTMENT_ARCHIVED: &str = "department_archived";
/// An empty category was deleted (ADR-018 §1). Detail names it and its parent.
pub const DEPARTMENT_DELETED: &str = "department_deleted";
/// The missing part of the default category tree was added — with the first
/// manager, or at start-up for a database made before the tree. Detail carries
/// how many; one event for the whole tree, because nobody made them one by one.
pub const DEFAULT_CATEGORIES_ADDED: &str = "default_categories_added";

/// Phone brands (ADR-018 §2): added, changed (renamed, touch/keypad/both,
/// hidden, moved — the detail says which) and deleted, plus the default
/// companies added once, like the default categories.
pub const BRAND_CREATED: &str = "brand_created";
pub const BRAND_UPDATED: &str = "brand_updated";
pub const BRAND_DELETED: &str = "brand_deleted";
pub const DEFAULT_BRANDS_ADDED: &str = "default_brands_added";

/// Product variants (ADR-018 §4): a parent item and its variant products
/// registered together in one transaction.
pub const VARIANTS_CREATED: &str = "variants_created";

/// Product images (ADR-018 §5): a 192×192 JPEG thumbnail stored or removed for
/// one product.
pub const PRODUCT_IMAGE_SET: &str = "product_image_set";
pub const PRODUCT_IMAGE_REMOVED: &str = "product_image_removed";



/// Inventory and costing (SP-2).
///
/// `COST_METHOD_SWITCHED` is its own event rather than a
/// `department_updated`: the switch is the only operation that rewrites how
/// every existing unit of stock is valued, and a report on costing history has
/// to be able to find those moments without inferring them from a diff of two
/// department rows.
///
/// Detail carries amounts only, never a PIN: `spec:19` attributes every
/// operation, and the schema forbids storing anything secret in `detail`.
pub const STOCK_RECEIVED: &str = "stock_received";
pub const STOCK_REMOVED: &str = "stock_removed";
pub const COST_METHOD_SWITCHED: &str = "cost_method_switched";
/// A stock position left by the retired FIFO method was collapsed into the
/// moving average on first touch (plan item 1.3). Detail carries the product,
/// how many layers were folded, and the resulting quantity and total — the
/// value is unchanged, only its representation. `COST_METHOD_SWITCHED` stays
/// so the rows written before 1.3 keep a name; nothing writes it any more.
pub const COST_LAYERS_COLLAPSED: &str = "cost_layers_collapsed";

/// Sales (SP-5). Detail carries the reference and the money that moved, never a
/// customer or a credential: `spec:19` attributes the operation, the schema
/// forbids secrets in `detail`.
pub const SALE_RECORDED: &str = "sale_recorded";
pub const SALE_CANCELLED: &str = "sale_cancelled";
/// A customer link or name snapshot was attached to a sale (P4). Detail
/// carries the sale and either the customer id or a snapshot marker — never
/// contact data.
pub const SALE_CUSTOMER_LINKED: &str = "sale_customer_linked";

/// Customers (P4). Detail carries the customer id, never contact data:
/// `spec:19` attributes the operation, and contact details stay in the
/// customer row rather than duplicated into the trail.
pub const CUSTOMER_CREATED: &str = "customer_created";
pub const CUSTOMER_ARCHIVED: &str = "customer_archived";
pub const CUSTOMER_PAYMENT_RECORDED: &str = "customer_payment_recorded";

/// Settings, and the retired Pattern.
///
/// The Pattern was replaced by the owner's PIN approval (ADR-017 §3) and nothing
/// writes `PATTERN_SET` or `PATTERN_RESET` any more. Both names stay so the rows
/// written before that keep a meaning, and so the vocabulary never shrinks.
pub const SETTING_CHANGED: &str = "setting_changed";
pub const PATTERN_SET: &str = "pattern_set";
pub const PATTERN_RESET: &str = "pattern_reset";
}

/// JSON detail attached to an event. Must never contain a secret.
pub type Detail = Option<String>;

pub async fn append(
    conn: &mut SqliteConnection,
    id: UserId,
    event_type: &str,
    occurred_at: Timestamp,
    detail: Detail,
) -> Result<(), sqlx::Error> {
    append_for(conn, Some(id), event_type, occurred_at, detail).await
}

/// Record an event that may have no attributable user.
pub async fn append_for(
    conn: &mut SqliteConnection,
    user_id: Option<UserId>,
    event_type: &str,
    occurred_at: Timestamp,
    detail: Detail,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO audit_events (id, user_id, event_type, occurred_at, detail)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    // A fresh UUID v7 per event keeps audit rows ordered by time and means an
    // event can never collide with, or overwrite, another.
    .bind(UserId::generate().as_str())
    .bind(user_id.map(|id| id.as_str()))
    .bind(event_type)
    .bind(occurred_at.as_millis())
    .bind(detail)
    .execute(conn)
    .await?;
    Ok(())
}

/// Count events of a type. Used by tests to assert that security-relevant
/// actions are actually recorded rather than assumed to be.
pub async fn count_by_type(
    conn: &mut SqliteConnection,
    event_type: &str,
) -> Result<i64, sqlx::Error> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE event_type = ?1")
        .bind(event_type)
        .fetch_one(conn)
        .await?;
    Ok(count)
}