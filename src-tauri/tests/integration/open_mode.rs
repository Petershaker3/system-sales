//! Running the shop before it has an account (`ADR-039`, owner decision 2026-10-19).
//!
//! The behaviour under test is the first launch of a new device: no setup form, no
//! password to invent, no lock card — the shop opens on the sales screen and runs.
//! The tests below are therefore about the *open* state specifically: that the
//! open row exists so the shop's writes have something to point at, that resolving
//! an operator works with no token and no session row, that claiming the row ends
//! all of it and hands back a normal signed-in account, and that a shop which
//! already has accounts is untouched by any of this.

use std::sync::Arc;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::identity::{Assurance, DomainError, Permission, Role};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{
    auth, bootstrap, open_mode, session, users,
};
use mobile_shop_system_lib::services::settings;
use sqlx::SqlitePool;

const PASSWORD: &str = "correct horse battery";
const SELLER_PASSWORD: &str = "seller password 1";

async fn fresh() -> (SqlitePool, Arc<InMemoryTokenStore>) {
    let pool = db::open_in_memory().await.expect("in-memory database");
    (pool, Arc::new(InMemoryTokenStore::new()))
}

/// Row count for a fixed statement. `&'static str` because sqlx borrows the SQL.
async fn count(pool: &SqlitePool, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(pool)
        .await
        .expect("count")
}

/// A shop at first launch: the open row exists, nobody signed in.
async fn open_shop() -> (SqlitePool, Arc<InMemoryTokenStore>) {
    let (pool, tokens) = fresh().await;
    open_mode::ensure_open_account(&pool)
        .await
        .expect("the open owner row")
        .expect("a fresh database has one");
    (pool, tokens)
}

#[tokio::test]
async fn a_fresh_database_makes_one_open_row_and_nothing_else() {
    let (pool, _tokens) = open_shop().await;

    // One row, so attribution has a target — and one credentials row, because
    // `user_credentials.username` is `NOT NULL UNIQUE` for every account (`0003`).
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM users").await, 1);
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM user_credentials").await,
        1,
        "the open row needs its credentials row, or login and resolve refuse it"
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM users WHERE provisional = 1").await,
        1
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM users WHERE provisional = 0").await,
        0,
        "nobody has claimed an account yet"
    );

    // No session row and no token: an open shop is signed in by being the shop's
    // own device, which is a fact about the database, not a credential.
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM sessions").await, 0);

    let started: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE event_type = 'open_account_started'")
        .fetch_one(&pool)
        .await
        .expect("audit");
    assert_eq!(started, 1, "making the open row is a recorded event");
}

#[tokio::test]
async fn the_open_row_is_a_manager_that_nobody_can_sign_in_to() {
    let (pool, tokens) = open_shop().await;
    let open = open_mode::open_account(&pool).await.expect("read");
    let id = open.expect("the open row").id;

    assert_eq!(
        auth::login(&pool, tokens.as_ref(), id, "guess").await,
        Err(DomainError::InvalidCredentials),
        "the row's verifier is a random secret nobody is told, so it is not a login"
    );
    assert_eq!(
        auth::login_with_pin(&pool, tokens.as_ref(), id, "1111").await,
        Err(DomainError::PinNotSet),
        "and there is no PIN to type either"
    );
}

#[tokio::test]
async fn the_open_shop_resolves_its_operator_without_a_token() {
    let (pool, tokens) = open_shop().await;

    let resolved = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("a shop with no account has an operator");
    let open = open_mode::open_account(&pool)
        .await
        .expect("read")
        .expect("the open row");

    assert_eq!(resolved.user_id(), open.id, "the operator is the open row");
    assert_eq!(resolved.role(), Role::Manager);
    assert!(resolved.is_open_mode());
    assert!(
        !resolved.must_change_password(),
        "there is no password owed on a row that never had one"
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM sessions").await,
        0,
        "resolving the open operator writes nothing"
    );
}

#[tokio::test]
async fn an_open_shop_reaches_the_screens_that_ask_for_a_fresh_password() {
    // `ManageSettings` and `ViewCostAndProfit` are gated on re-authentication
    // (`plan:151`). In an open shop that gate has nothing to check against, so the
    // settings service must accept the open session — otherwise the owner could not
    // name the shop or set the shop colour before setting up an account, which is
    // the opposite of why the open state exists.
    let (pool, tokens) = open_shop().await;
    let operator = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("the open operator");
    for permission in [Permission::ManageSettings, Permission::ManageUsers] {
        assert_eq!(operator.authorize(permission), Ok(()));
    }

    settings::read_snapshot(&pool, tokens.as_ref())
        .await
        .expect("the open shop reads its settings");
    settings::update(&pool, tokens.as_ref(), "invoice_prefix", "INV-2-")
        .await
        .expect("and changes one");

    let attributed: Option<String> = sqlx::query_scalar(
        "SELECT updated_by FROM app_settings WHERE key = 'invoice_prefix'",
    )
    .fetch_one(&pool)
    .await
    .expect("the row the settings service wrote");
    assert_eq!(
        attributed.as_deref(),
        Some(operator.user_id().as_str()),
        "the write is attributed to the open row, so the audit trail stays complete"
    );
}

#[tokio::test]
async fn a_shop_with_accounts_is_left_alone() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    let made = open_mode::ensure_open_account(&pool)
        .await
        .expect("read the table");
    assert_eq!(made, None, "the shop already has an account to run on");
    assert!(
        !open_mode::is_open(&pool).await.expect("ask"),
        "and it is not open"
    );
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM users").await, 1);

    // The account that exists is still the ordinary kind, and still locked behind
    // its password: `resolve` has no open answer to fall back to.
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM users WHERE provisional = 1").await,
        0
    );
    assert_eq!(
        session::resolve(&pool, tokens.as_ref()).await,
        Err(DomainError::SessionNotFound),
        "a shop with accounts and no session is signed out, not open"
    );
    assert_eq!(created.role, Role::Manager);
}

#[tokio::test]
async fn claiming_the_open_row_ends_open_mode_and_keeps_the_operator_signed_in() {
    let (pool, tokens) = open_shop().await;
    let open = open_mode::open_account(&pool)
        .await
        .expect("read")
        .expect("the open row");

    let claimed = open_mode::claim_open_account(&pool, tokens.as_ref(), "Peter", PASSWORD)
        .await
        .expect("the owner claims the account");

    assert_eq!(claimed.user_id, open.id, "the same row, now the owner's");
    assert_eq!(claimed.display_name, "Peter");
    assert_eq!(claimed.role, Role::Manager);
    assert_eq!(
        claimed.assurance,
        Assurance::Normal,
        "and from here the session is an ordinary sign-in: elevation is earned again"
    );

    assert!(!open_mode::is_open(&pool).await.expect("ask"));
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM users").await, 1);
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM sessions").await,
        1,
        "the claim opened a real session, so the till did not stop"
    );

    let resolved = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("the claimed session resolves the ordinary way");
    assert!(
        !resolved.is_open_mode(),
        "the flag is off, so the open answer is gone for good"
    );

    // The password the owner typed is now the only way back in, and it works.
    auth::logout(&pool, tokens.as_ref()).await.expect("sign out");
    assert_eq!(
        session::resolve(&pool, tokens.as_ref()).await,
        Err(DomainError::SessionNotFound),
        "signed out means signed out: there is no open fallback any more"
    );
    auth::login(&pool, tokens.as_ref(), open.id, PASSWORD)
        .await
        .expect("the new password opens the shop");
    assert_eq!(
        auth::login(&pool, tokens.as_ref(), open.id, "old guess")
            .await,
        Err(DomainError::InvalidCredentials)
    );
}

#[tokio::test]
async fn a_second_claim_is_refused_and_writes_nothing() {
    let (pool, tokens) = open_shop().await;
    open_mode::claim_open_account(&pool, tokens.as_ref(), "Peter", PASSWORD)
        .await
        .expect("the first claim");

    let second = open_mode::claim_open_account(&pool, tokens.as_ref(), "Someone Else", PASSWORD)
        .await;
    assert_eq!(second.err(), Some(DomainError::BootstrapAlreadyCompleted));

    let name: String =
        sqlx::query_scalar("SELECT display_name FROM users WHERE provisional = 0")
            .fetch_one(&pool)
            .await
            .expect("the claimed row");
    assert_eq!(name, "Peter", "a refused claim must not rename anything");
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM audit_events WHERE event_type = 'open_account_claimed'")
            .await,
        1
    );
}

#[tokio::test]
async fn a_claim_needs_a_real_name_and_a_real_password() {
    let (pool, tokens) = open_shop().await;

    assert_eq!(
        open_mode::claim_open_account(&pool, tokens.as_ref(), "   ", PASSWORD)
            .await
            .err(),
        Some(DomainError::DisplayNameRequired)
    );
    assert_eq!(
        open_mode::claim_open_account(&pool, tokens.as_ref(), "Peter", "short")
            .await
            .err(),
        Some(DomainError::WeakPassword)
    );
    assert!(
        open_mode::is_open(&pool).await.expect("ask"),
        "a refused claim leaves the shop open rather than half-claimed"
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM users WHERE provisional = 1").await,
        1
    );
}

#[tokio::test]
async fn an_open_shop_can_still_hire_a_seller_and_stays_open() {
    // Adding a seller is a manager action, and the open row is a manager: the shop
    // may staff up before it decides to have an account. This pins that the open
    // state is defined by its own row and not by "there is exactly one account".
    let (pool, tokens) = open_shop().await;
    let operator = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("the open operator");

    let open_id = operator.user_id();
    let seller = users::create_user(
        &pool,
        &operator,
        "Youssef",
        "youssef",
        Role::Sales,
        SELLER_PASSWORD,
    )
    .await
    .expect("the open shop creates a seller");

    // The audit row names the open row as the actor. That is the whole reason the
    // row exists rather than a synthetic id: `audit_events.user_id`, like
    // `sales.sold_by`, is a foreign key to `users (id)`, and a fabricated operator
    // would have been refused at the database.
    let actor: Option<String> =
        sqlx::query_scalar("SELECT user_id FROM audit_events WHERE event_type = 'user_created'")
            .fetch_one(&pool)
            .await
            .expect("the audit row");
    assert_eq!(
        actor.as_deref(),
        Some(open_id.as_str()),
        "the open row is the actor the trail records"
    );

    assert!(
        open_mode::is_open(&pool).await.expect("ask"),
        "the owner still has no account, so the shop is still open"
    );
    // The seller is a claimed account, so they sign in the ordinary way and get
    // none of the open session's breadth.
    let signed_in = auth::login(&pool, tokens.as_ref(), seller, SELLER_PASSWORD)
        .await
        .expect("the seller signs in");
    assert_eq!(signed_in.role, Role::Sales);
    let seller_session = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("the seller's session");
    assert!(
        !seller_session.is_open_mode(),
        "the token path wins over the open answer"
    );
    assert_eq!(
        seller_session.authorize(Permission::ManageSettings),
        Err(DomainError::ReauthenticationRequired),
        "a seller is still a seller: no open-mode breadth leaks through their session"
    );
}

#[tokio::test]
async fn the_setup_gate_off_is_the_open_row_not_a_forgotten_form() {
    let (pool, _tokens) = fresh().await;
    assert!(
        bootstrap::bootstrap_needed(&pool).await.expect("ask"),
        "before the open row is made, the database is empty and the fallback form \
         is what a broken start-up shows"
    );

    open_mode::ensure_open_account(&pool)
        .await
        .expect("open the shop");
    assert!(
        !bootstrap::bootstrap_needed(&pool).await.expect("ask"),
        "and once the shop is open the gate is off: `ADR-039` replaced the form"
    );
}
