//! The owner's PIN approval for one sensitive operation (ADR-017 §3, plan item
//! 1.1), against real SQLite.
//!
//! The claims under test:
//!
//! * a sensitive operation needs a fresh approval — even on the owner's own,
//!   freshly re-authenticated session — and spends it: one approval, one
//!   operation;
//! * routine work neither asks for an approval nor spends one;
//! * a refused operation leaves its approval for the retry;
//! * only an active manager holding a PIN can approve, from any signed-in
//!   session, and a wrong PIN counts against that manager's own lockout — the
//!   counter sign-in uses;
//! * an approval lapses after two minutes; a new PIN, a disable or a demotion
//!   leaves nothing to spend;
//! * the grant and the spend are both audited, and no audit row carries a PIN.

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::identity::{
    DomainError, Role, Sensitivity, UserId, MAX_FAILED_ATTEMPTS, OWNER_APPROVAL_TTL_MS,
};
use mobile_shop_system_lib::services::catalog::product::{self as catalogue, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{approval, auth, bootstrap, pin, session, users};
use mobile_shop_system_lib::services::inventory::stock as costing;
use mobile_shop_system_lib::services::sales as sales_use_cases;
use sqlx::SqlitePool;

/// Six digits, so no UUID in an audit row can contain a PIN by chance and the
/// "never in the audit trail" check cannot pass or fail by luck.
const OWNER_PIN: &str = "246810";
const SECOND_PIN: &str = "975319";
const WRONG_PIN: &str = "135791";
const SELLER_PASSWORD: &str = "seller password 1";
const MANAGER_PASSWORD: &str = "manager password 1";

struct Shop {
    pool: SqlitePool,
    tokens: Arc<InMemoryTokenStore>,
    owner: UserId,
}

/// A fresh shop whose owner is signed in (normal assurance) and holds a PIN.
async fn shop() -> Shop {
    let pool = mobile_shop_system_lib::data::db::open_in_memory()
        .await
        .expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("the owner signs in");
    let current = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("session");
    pin::set_own_pin(&pool, &current, None, OWNER_PIN)
        .await
        .expect("the owner sets a PIN");
    Shop {
        pool,
        tokens,
        owner: created.user_id,
    }
}

/// A product counted by quantity, never stocked.
async fn product(shop: &Shop) -> String {
    let ctx = CatalogContext::new(shop.pool.clone(), shop.tokens.clone());
    let current = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("session");
    let created = catalogue::create(
        &ctx,
        &current,
        NewProduct {
            name: "Charger".to_string(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: None,
            category: None,
        },
    )
    .await
    .expect("create product");
    created.id.as_str().to_string()
}

/// The owner, re-authenticated for user management, adds an account.
async fn add_account(shop: &Shop, name: &str, username: &str, role: Role) -> UserId {
    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("the owner re-authenticates");
    let owner = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("owner session");
    let password = match role {
        Role::Manager => MANAGER_PASSWORD,
        Role::Sales => SELLER_PASSWORD,
    };
    users::create_user(&shop.pool, &owner, name, username, role, password)
        .await
        .expect("the owner adds an account")
}

/// The owner, re-authenticated, sets another account's PIN.
async fn give_pin(shop: &Shop, target: UserId, new_pin: &str) {
    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("the owner re-authenticates");
    let owner = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("owner session");
    pin::manager_set_pin(&shop.pool, &owner, target, new_pin)
        .await
        .expect("the owner sets the PIN");
}

async fn approve(shop: &Shop, approver: UserId, entered: &str) -> Result<(), DomainError> {
    approval::approve_with_owner_pin(&shop.pool, shop.tokens.as_ref(), approver, entered).await
}

/// Declare ten units at 100 as an opening balance: the sensitive receipt.
async fn opening_balance(shop: &Shop, product: &str) -> Result<(), &'static str> {
    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        product,
        10,
        100,
        Sensitivity::Sensitive,
        None,
    )
    .await
    .map(|_| ())
    .map_err(|error| error.code())
}

/// Receive units at 100 as an ordinary delivery: the routine receipt.
async fn routine_receipt(shop: &Shop, product: &str, quantity: i64) {
    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        product,
        quantity,
        100,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("a routine receipt needs no approval");
}

/// Who approved the approval waiting on the device's one session, if any.
async fn pending_approver(shop: &Shop) -> Option<String> {
    let approver: Option<String> = sqlx::query_scalar("SELECT approved_by FROM sessions")
        .fetch_one(&shop.pool)
        .await
        .expect("exactly one session");
    approver
}

async fn position(shop: &Shop, product_id: &str) -> Option<(i64, Option<i64>)> {
    sqlx::query_as("SELECT quantity, total_cost_minor FROM stock_levels WHERE product_id = ?1")
        .bind(product_id)
        .fetch_optional(&shop.pool)
        .await
        .expect("position row")
}

async fn failed_attempts(shop: &Shop, user: UserId) -> i64 {
    sqlx::query_scalar("SELECT failed_attempts FROM users WHERE id = ?1")
        .bind(user.as_str())
        .fetch_one(&shop.pool)
        .await
        .expect("user row")
}

async fn audit_count(shop: &Shop, event: &str, detail_like: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = ?1 AND COALESCE(detail, '') LIKE ?2",
    )
    .bind(event)
    .bind(detail_like)
    .fetch_one(&shop.pool)
    .await
    .expect("audit count")
}

async fn latest_detail(shop: &Shop, event: &str) -> Option<String> {
    let detail: Option<Option<String>> = sqlx::query_scalar(
        "SELECT detail FROM audit_events WHERE event_type = ?1
          ORDER BY occurred_at DESC, rowid DESC LIMIT 1",
    )
    .bind(event)
    .fetch_optional(&shop.pool)
    .await
    .expect("audit read");
    detail.flatten()
}

// ---------------------------------------------------------------------------
// One approval, one sensitive operation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn one_approval_lets_exactly_one_opening_balance_through() {
    let shop = shop().await;
    let product = product(&shop).await;

    assert_eq!(
        opening_balance(&shop, &product).await,
        Err("OWNER_APPROVAL_REQUIRED"),
        "an opening balance declares what the shop is worth"
    );
    assert_eq!(position(&shop, &product).await, None);

    approve(&shop, shop.owner, OWNER_PIN)
        .await
        .expect("the owner approves");
    assert_eq!(pending_approver(&shop).await, Some(shop.owner.as_str()));
    opening_balance(&shop, &product)
        .await
        .expect("the approved opening balance");
    assert_eq!(position(&shop, &product).await, Some((10, Some(1000))));
    assert_eq!(
        pending_approver(&shop).await,
        None,
        "the operation spent the approval"
    );

    assert_eq!(
        opening_balance(&shop, &product).await,
        Err("OWNER_APPROVAL_REQUIRED"),
        "one approval, one operation"
    );
    assert_eq!(position(&shop, &product).await, Some((10, Some(1000))));

    let detail = latest_detail(&shop, "stock_received")
        .await
        .expect("the receipt is audited");
    assert!(
        detail.contains(&format!(r#""approved_by":"{}""#, shop.owner)),
        "the receipt names who approved it: {detail}"
    );
}

#[tokio::test]
async fn routine_work_neither_asks_for_nor_spends_an_approval() {
    let shop = shop().await;
    let product = product(&shop).await;
    routine_receipt(&shop, &product, 3).await;

    approve(&shop, shop.owner, OWNER_PIN)
        .await
        .expect("the owner approves");
    routine_receipt(&shop, &product, 2).await;
    assert_eq!(
        pending_approver(&shop).await,
        Some(shop.owner.as_str()),
        "routine work leaves the approval where it is"
    );
    let detail = latest_detail(&shop, "stock_received")
        .await
        .expect("the receipt is audited");
    assert!(
        !detail.contains("approved_by"),
        "a routine receipt names no approver: {detail}"
    );
}

#[tokio::test]
async fn the_owners_own_session_needs_the_pin_even_after_the_password() {
    // ADR-017 §3: no password path. A signed-in session left unattended must not
    // be a standing approval, and neither is a freshly re-proven password.
    let shop = shop().await;
    let product = product(&shop).await;
    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("the owner re-authenticates");

    assert_eq!(
        opening_balance(&shop, &product).await,
        Err("OWNER_APPROVAL_REQUIRED")
    );
    assert_eq!(position(&shop, &product).await, None);
}

#[tokio::test]
async fn a_refused_operation_leaves_the_approval_for_the_retry() {
    let shop = shop().await;
    approve(&shop, shop.owner, OWNER_PIN)
        .await
        .expect("the owner approves");

    let refused =
        sales_use_cases::cancel_sale(&shop.pool, shop.tokens.as_ref(), "no-such-sale", "typo")
            .await
            .expect_err("there is no such sale");
    assert_eq!(refused.code(), "SALE_NOT_FOUND");
    assert_eq!(
        pending_approver(&shop).await,
        Some(shop.owner.as_str()),
        "the rolled-back cancellation spent nothing"
    );

    let product = product(&shop).await;
    opening_balance(&shop, &product)
        .await
        .expect("the same approval serves the next sensitive operation");
    assert_eq!(pending_approver(&shop).await, None);
}

// ---------------------------------------------------------------------------
// Who may approve, and the lockout
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_wrong_pin_counts_against_the_approver_and_is_audited() {
    let shop = shop().await;

    let refused = approve(&shop, shop.owner, WRONG_PIN)
        .await
        .expect_err("a wrong PIN");
    assert_eq!(refused.code(), "INVALID_CREDENTIALS");
    assert_eq!(
        failed_attempts(&shop, shop.owner).await,
        1,
        "the approver's own counter, the one sign-in uses"
    );
    assert_eq!(
        audit_count(&shop, "owner_approval_failed", r#"%"reason":"bad_pin"%"#).await,
        1
    );
    assert_eq!(pending_approver(&shop).await, None, "nothing was stamped");

    approve(&shop, shop.owner, OWNER_PIN)
        .await
        .expect("the right PIN");
    assert_eq!(
        failed_attempts(&shop, shop.owner).await,
        0,
        "success clears the counter"
    );
    assert_eq!(
        latest_detail(&shop, "owner_approval_granted").await,
        Some(format!(r#"{{"approver":"{0}","for":"{0}"}}"#, shop.owner))
    );
}

#[tokio::test]
async fn five_wrong_pins_lock_the_approver_out_of_approving_and_signing_in() {
    let shop = shop().await;
    for _ in 0..MAX_FAILED_ATTEMPTS {
        let refused = approve(&shop, shop.owner, WRONG_PIN)
            .await
            .expect_err("a wrong PIN");
        assert_eq!(refused.code(), "INVALID_CREDENTIALS");
    }

    let locked = approve(&shop, shop.owner, OWNER_PIN)
        .await
        .expect_err("locked, even with the right PIN");
    assert_eq!(locked.code(), "ACCOUNT_TEMPORARILY_LOCKED");
    assert_eq!(audit_count(&shop, "account_locked", "%").await, 1);

    let signing_in = auth::login(&shop.pool, shop.tokens.as_ref(), shop.owner, PASSWORD)
        .await
        .expect_err("the approval prompt is no side door around the lockout");
    assert_eq!(signing_in.code(), "ACCOUNT_TEMPORARILY_LOCKED");
}

#[tokio::test]
async fn only_an_active_manager_holding_a_pin_can_approve() {
    let shop = shop().await;

    let nobody = approve(&shop, UserId::generate(), OWNER_PIN)
        .await
        .expect_err("an id that names nobody");
    assert_eq!(nobody.code(), "INVALID_CREDENTIALS");

    let seller = add_account(&shop, "Youssef", "youssef", Role::Sales).await;
    give_pin(&shop, seller, SECOND_PIN).await;
    let seller_refused = approve(&shop, seller, SECOND_PIN)
        .await
        .expect_err("a seller, even with the right PIN");
    assert_eq!(seller_refused.code(), "PERMISSION_DENIED");

    let second = add_account(&shop, "Mina", "mina", Role::Manager).await;
    let no_pin = approve(&shop, second, SECOND_PIN)
        .await
        .expect_err("a manager with no PIN has nothing to type");
    assert_eq!(no_pin.code(), "PIN_NOT_SET");

    give_pin(&shop, second, SECOND_PIN).await;
    let owner = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("owner session");
    users::disable_user(&shop.pool, &owner, second)
        .await
        .expect("the owner disables the second manager");
    let disabled = approve(&shop, second, SECOND_PIN)
        .await
        .expect_err("a disabled manager, even with the right PIN");
    assert_eq!(disabled.code(), "ACCOUNT_DISABLED");

    assert_eq!(pending_approver(&shop).await, None, "no refusal stamped anything");
    assert_eq!(audit_count(&shop, "owner_approval_failed", "%").await, 4);
}

#[tokio::test]
async fn a_sellers_session_carries_the_owners_approval() {
    let shop = shop().await;
    let seller = add_account(&shop, "Youssef", "youssef", Role::Sales).await;
    auth::login(&shop.pool, shop.tokens.as_ref(), seller, SELLER_PASSWORD)
        .await
        .expect("the seller signs in");

    approve(&shop, shop.owner, OWNER_PIN)
        .await
        .expect("the owner approves at the seller's counter");
    assert_eq!(pending_approver(&shop).await, Some(shop.owner.as_str()));
    assert_eq!(
        latest_detail(&shop, "owner_approval_granted").await,
        Some(format!(
            r#"{{"approver":"{}","for":"{}"}}"#,
            shop.owner, seller
        ))
    );
}

// ---------------------------------------------------------------------------
// What ends an approval nobody used
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_approval_lapses_after_two_minutes() {
    let shop = shop().await;
    let product = product(&shop).await;
    approve(&shop, shop.owner, OWNER_PIN)
        .await
        .expect("the owner approves");

    // Aged by exactly the window: the boundary itself is already stale.
    sqlx::query("UPDATE sessions SET approved_at = approved_at - ?1")
        .bind(OWNER_APPROVAL_TTL_MS)
        .execute(&shop.pool)
        .await
        .expect("age the approval");

    assert_eq!(
        opening_balance(&shop, &product).await,
        Err("OWNER_APPROVAL_REQUIRED")
    );
    assert_eq!(position(&shop, &product).await, None);
}

#[tokio::test]
async fn a_new_pin_withdraws_an_approval_nobody_used() {
    let shop = shop().await;
    let product = product(&shop).await;
    approve(&shop, shop.owner, OWNER_PIN)
        .await
        .expect("the owner approves");

    let current = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("session");
    pin::set_own_pin(&shop.pool, &current, Some(PASSWORD), SECOND_PIN)
        .await
        .expect("the owner changes the PIN");

    assert_eq!(pending_approver(&shop).await, None);
    assert_eq!(
        opening_balance(&shop, &product).await,
        Err("OWNER_APPROVAL_REQUIRED")
    );
}

#[tokio::test]
async fn any_active_manager_may_approve_and_a_disable_withdraws_the_approval() {
    let shop = shop().await;
    let product = product(&shop).await;
    let second = add_account(&shop, "Mina", "mina", Role::Manager).await;
    give_pin(&shop, second, SECOND_PIN).await;

    approve(&shop, second, SECOND_PIN)
        .await
        .expect("the second manager approves on the owner's session");
    opening_balance(&shop, &product)
        .await
        .expect("approved by the second manager");
    let detail = latest_detail(&shop, "stock_received")
        .await
        .expect("the receipt is audited");
    assert!(
        detail.contains(&format!(r#""approved_by":"{second}""#)),
        "the receipt names the manager who approved it: {detail}"
    );

    approve(&shop, second, SECOND_PIN)
        .await
        .expect("another approval");
    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("the owner re-authenticates");
    let owner = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("owner session");
    users::disable_user(&shop.pool, &owner, second)
        .await
        .expect("the owner disables the second manager");

    assert_eq!(
        pending_approver(&shop).await,
        None,
        "a disable withdraws the approval"
    );
    assert_eq!(
        opening_balance(&shop, &product).await,
        Err("OWNER_APPROVAL_REQUIRED")
    );
}

#[tokio::test]
async fn an_approval_from_a_manager_since_demoted_cannot_be_spent() {
    let shop = shop().await;
    let product = product(&shop).await;
    let second = add_account(&shop, "Mina", "mina", Role::Manager).await;
    give_pin(&shop, second, SECOND_PIN).await;

    approve(&shop, second, SECOND_PIN)
        .await
        .expect("the second manager approves");
    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("the owner re-authenticates");
    let owner = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("owner session");
    users::change_role(&shop.pool, &owner, second, Role::Sales)
        .await
        .expect("the owner demotes the second manager");

    // The approval is still fresh on the row, but the spend re-checks the
    // approver in the same statement, and a seller's approval is worth nothing.
    assert_eq!(
        opening_balance(&shop, &product).await,
        Err("OWNER_APPROVAL_REQUIRED")
    );
    assert_eq!(position(&shop, &product).await, None);
}

#[tokio::test]
async fn no_audit_row_ever_carries_a_pin() {
    let shop = shop().await;
    let _ = approve(&shop, shop.owner, WRONG_PIN).await;
    approve(&shop, shop.owner, OWNER_PIN)
        .await
        .expect("the owner approves");
    let product = product(&shop).await;
    opening_balance(&shop, &product)
        .await
        .expect("the approved opening balance");

    for secret in [OWNER_PIN, WRONG_PIN] {
        let carrying: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE detail LIKE ?1")
                .bind(format!("%{secret}%"))
                .fetch_one(&shop.pool)
                .await
                .expect("audit scan");
        assert_eq!(carrying, 0, "an audit row carries the PIN `{secret}`");
    }
}
