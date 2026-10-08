//! Integration tests against real SQLite and the real service layer.
//!
//! `spec:138` requires atomicity to be proven against real SQLite/SQLx rather
//! than a mock, and `spec:139` requires the money and security boundaries to be
//! tested rather than assumed. No mock database appears here.
//!
//! The credential store is substituted with an in-memory double, because the
//! real OS keyring cannot be assumed present on a build machine and because a
//! test must never touch the developer's actual credential store. The
//! fail-closed behaviour when the store is unavailable is tested explicitly.

use std::sync::Arc;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::data::repositories::identity::audit;
use mobile_shop_system_lib::domain::identity::{
    DomainError, UserId, LOCKOUT_MS, MAX_FAILED_ATTEMPTS,
};
use mobile_shop_system_lib::services::identity::secure_store::{
    InMemoryTokenStore, SecureStoreError, SecureTokenStore,
};
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, IdentityContext};
use mobile_shop_system_lib::domain::identity::SessionToken;
use sqlx::SqlitePool;

const PASSWORD: &str = "correct horse battery";

async fn fresh() -> (SqlitePool, Arc<InMemoryTokenStore>) {
    let pool = db::open_in_memory().await.expect("in-memory database");
    (pool, Arc::new(InMemoryTokenStore::new()))
}

/// A store that always refuses, to prove the fail-closed path.
struct BrokenStore;

impl SecureTokenStore for BrokenStore {
    fn put(&self, _token: &SessionToken) -> Result<(), SecureStoreError> {
        Err(SecureStoreError::Unavailable("simulated keyring failure".into()))
    }
    fn get(&self) -> Result<Option<SessionToken>, SecureStoreError> {
        Err(SecureStoreError::Unavailable("simulated keyring failure".into()))
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        Err(SecureStoreError::Unavailable("simulated keyring failure".into()))
    }
    fn is_available(&self) -> Result<(), SecureStoreError> {
        Err(SecureStoreError::Unavailable("simulated keyring failure".into()))
    }
}

/// Row count for one of a fixed set of statements.
///
/// Takes `&'static str` rather than `String` on purpose: sqlx's query borrows
/// the SQL text, and building it at runtime would tie the statement's lifetime
/// to a local. Every caller passes a literal, so nothing is ever interpolated.
async fn count(pool: &SqlitePool, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(pool)
        .await
        .expect("count query")
}

async fn manager_of(pool: &SqlitePool) -> UserId {
    let id: String = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(pool)
        .await
        .expect("a user exists");
    UserId::from_uuid(id.parse().expect("uuid"))
}

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

#[tokio::test]
async fn database_starts_with_no_users() {
    let (pool, _tokens) = fresh().await;
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM users").await, 0);
    assert!(bootstrap::bootstrap_needed(&pool).await.expect("status"));
}

#[tokio::test]
async fn creating_the_first_manager_stores_a_verifier_not_the_password() {
    let (pool, _tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    let verifier: String = sqlx::query_scalar("SELECT verifier FROM users WHERE id = ?1")
        .bind(created.user_id.as_str())
        .fetch_one(&pool)
        .await
        .expect("verifier row");

    assert_ne!(verifier, PASSWORD, "the password must never be stored");
    assert!(
        !verifier.contains(PASSWORD),
        "the password must not appear anywhere inside the verifier"
    );
    assert!(
        verifier.starts_with("$argon2id$"),
        "expected an Argon2id PHC string, got {verifier}"
    );
}

#[tokio::test]
async fn first_run_setup_succeeds_exactly_once() {
    let (pool, _tokens) = fresh().await;
    bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    assert_eq!(count(&pool, "SELECT COUNT(*) FROM users").await, 1);

    // Every later attempt must fail, whoever asks and with what password.
    for (name, secret) in [("Ahmed", "another password"), ("Peter", PASSWORD)] {
        let attempt = bootstrap::create_first_manager(&pool, name, secret).await;
        assert_eq!(
            attempt,
            Err(DomainError::BootstrapAlreadyCompleted),
            "{name} must not be able to bootstrap"
        );
    }

    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM users").await,
        1,
        "the user table must still hold exactly one account"
    );
    assert!(!bootstrap::bootstrap_needed(&pool).await.expect("status"));
}

#[tokio::test]
async fn a_rejected_bootstrap_leaves_no_partial_account() {
    let (pool, _tokens) = fresh().await;
    bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    let before_audit = count(&pool, "SELECT COUNT(*) FROM audit_events").await;
    let _ = bootstrap::create_first_manager(&pool, "Intruder", "hunter2hunter2").await;

    assert_eq!(count(&pool, "SELECT COUNT(*) FROM users").await, 1);
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM audit_events").await,
        before_audit,
        "a refused bootstrap must not record an account-creation event"
    );
}

#[tokio::test]
async fn first_run_setup_rejects_a_short_password() {
    let (pool, _tokens) = fresh().await;
    assert_eq!(
        bootstrap::create_first_manager(&pool, "Peter", "short").await,
        Err(DomainError::WeakPassword)
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM users").await,
        0,
        "no account may be created when the password is refused"
    );
}

#[tokio::test]
async fn first_run_setup_creates_a_manager_and_nothing_elser() {
    let (pool, _tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    assert_eq!(created.role.as_str(), "manager");
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM sessions").await, 0);
}

// ---------------------------------------------------------------------------
// Login and the token contract
// ---------------------------------------------------------------------------

#[tokio::test]
async fn login_succeeds_and_records_only_a_token_digest() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    let signed_in = auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    assert_eq!(signed_in.user_id, created.user_id);
    assert_eq!(signed_in.role.as_str(), "manager");

    // The token lives in the credential store...
    let stored = tokens.get().expect("store readable").expect("a token");
    // ...and only its digest is in the database.
    let digest: String = sqlx::query_scalar("SELECT token_hash FROM sessions")
        .fetch_one(&pool)
        .await
        .expect("session row");

    assert_ne!(
        digest,
        stored.expose(),
        "SQLite must never hold the session token itself (ADR-009)"
    );
    assert_eq!(digest.len(), 64, "expected a SHA-256 hex digest");
    assert!(digest
        .bytes()
        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
}

#[tokio::test]
async fn the_database_never_contains_the_token_or_the_password() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    let token = tokens.get().expect("store").expect("token").expose().to_string();

    // Sweep every text column in every table for either secret. The statements
    // are literals: nothing here is built from input.
    const DETAILS: [&str; 1] = ["SELECT COALESCE(detail, '') FROM audit_events"];
    for statement in DETAILS {
        let rows: Vec<String> = sqlx::query_scalar(statement)
            .fetch_all(&pool)
            .await
            .expect("details");
        for detail in rows {
            assert!(!detail.contains(&token), "audit detail leaked the token");
            assert!(!detail.contains(PASSWORD), "audit detail leaked the password");
        }
    }

    let verifiers: Vec<String> = sqlx::query_scalar("SELECT verifier FROM users")
        .fetch_all(&pool)
        .await
        .expect("verifiers");
    for verifier in verifiers {
        assert!(!verifier.contains(PASSWORD));
    }

    let hashes: Vec<String> = sqlx::query_scalar("SELECT token_hash FROM sessions")
        .fetch_all(&pool)
        .await
        .expect("hashes");
    for hash in hashes {
        assert_ne!(hash, token);
    }
}

#[tokio::test]
async fn an_unknown_account_is_indistinguishable_from_a_wrong_password() {
    let (pool, tokens) = fresh().await;
    bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    let wrong_password = auth::login(&pool, tokens.as_ref(), manager_of(&pool).await, "not it")
        .await
        .expect_err("wrong password");
    let no_such_user = auth::login(&pool, tokens.as_ref(), UserId::generate(), "not it")
        .await
        .expect_err("unknown account");

    assert_eq!(wrong_password, no_such_user);
    assert_eq!(wrong_password, DomainError::InvalidCredentials);
}

#[tokio::test]
async fn a_failed_login_is_audited_even_for_an_unknown_account() {
    let (pool, tokens) = fresh().await;
    bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    auth::login(&pool, tokens.as_ref(), UserId::generate(), "guess")
        .await
        .expect_err("unknown account");

    {
        let mut conn = pool.acquire().await.expect("connection");
        // Exactly one failed-login event, on top of the one the bootstrap itself
        // recorded.
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::LOGIN_FAILED)
                .await
                .expect("count"),
            1
        );
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::FIRST_MANAGER_CREATED)
                .await
                .expect("count"),
            1
        );
    }
    // Connection released: the in-memory pool allows only one.

    // The event for an unknown account must still name the attempted id, so the
    // attempt is attributable even though no user row exists.
    let attributed: Option<String> = sqlx::query_scalar(
        "SELECT user_id FROM audit_events WHERE event_type = 'login_failed'",
    )
    .fetch_one(&pool)
    .await
    .expect("row");
    assert!(
        attributed.is_none(),
        "an unknown account has no user to attribute the attempt to"
    );
}

// ---------------------------------------------------------------------------
// Lockout
// ---------------------------------------------------------------------------

#[tokio::test]
async fn five_failures_lock_the_account_and_are_audited() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    for attempt in 1..=MAX_FAILED_ATTEMPTS {
        let outcome = auth::login(&pool, tokens.as_ref(), created.user_id, "wrong").await;
        assert_eq!(outcome, Err(DomainError::InvalidCredentials), "attempt {attempt}");
    }

    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::ACCOUNT_LOCKED)
                .await
                .expect("count"),
            1,
            "the lock itself must be recorded"
        );
    }
    // Released above: the in-memory pool holds a single connection, so it must
    // not be borrowed while the next call acquires one.

    // The correct password is refused while the lock holds.
    assert_eq!(
        auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
            .await,
        Err(DomainError::AccountLocked),
        "a locked account must refuse even the right password"
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM sessions").await,
        0,
        "a locked account must not obtain a session"
    );
}

#[tokio::test]
async fn the_lock_survives_closing_and_reopening_the_database() {
    // A lockout that vanishes on restart would not prevent anything.
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("shop.db");

    let user_id = {
        let pool = db::open(&path).await.expect("first open");
        let tokens = Arc::new(InMemoryTokenStore::new());
        let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
            .await
            .expect("first manager");
        for _ in 0..MAX_FAILED_ATTEMPTS {
            let _ = auth::login(&pool, tokens.as_ref(), created.user_id, "wrong").await;
        }
        created.user_id
    };

    let pool = db::open(&path).await.expect("reopen");
    let tokens = Arc::new(InMemoryTokenStore::new());
    assert_eq!(
        auth::login(&pool, tokens.as_ref(), user_id, PASSWORD).await,
        Err(DomainError::AccountLocked),
        "the lock must still be in force after reopening the database"
    );

    let locked_until: Option<i64> = sqlx::query_scalar("SELECT locked_until FROM users WHERE id = ?1")
        .bind(user_id.as_str())
        .fetch_one(&pool)
        .await
        .expect("row");
    let now = mobile_shop_system_lib::domain::identity::Timestamp::now().as_millis();
    let until = locked_until.expect("a lock deadline");
    assert!(
        until > now && until - now <= LOCKOUT_MS,
        "the recorded deadline must lie inside the lockout window"
    );
}

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_unavailable_credential_store_refuses_to_issue_a_session() {
    let (pool, _tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    let outcome = auth::login(&pool, &BrokenStore, created.user_id, PASSWORD).await;

    // `SecureStorageUnavailable`, not `SessionNotFound`: an operator needs to be
    // told the device's secure store is unreachable, otherwise they would think
    // they had merely been signed out and keep retrying a login that can never
    // work. ADR-009 still requires that no session is issued.
    assert_eq!(
        outcome,
        Err(DomainError::SecureStorageUnavailable),
        "with no secure store there must be no session (ADR-009)"
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM sessions").await,
        0,
        "no session row may exist that no token could ever reach"
    );
}

#[tokio::test]
async fn an_unavailable_credential_store_makes_session_resolution_fail() {
    let (pool, _tokens) = fresh().await;
    bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    assert_eq!(
        session::resolve(&pool, &BrokenStore).await,
        Err(DomainError::SecureStorageUnavailable),
        "an unreachable store must be reported as such, never as a plain sign-out"
    );
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_session_resolves_from_the_credential_store_alone() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    // No id, no token and no role are supplied: resolution is internal.
    let resolved = session::resolve(&pool, tokens.as_ref()).await.expect("resolve");
    assert_eq!(resolved.user_id(), created.user_id);
    assert_eq!(resolved.role().as_str(), "manager");
}

#[tokio::test]
async fn reauthentication_raises_the_assurance_level() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    let before = session::resolve(&pool, tokens.as_ref()).await.expect("resolve");
    assert_eq!(
        before.authorize(
            mobile_shop_system_lib::domain::identity::Permission::ViewCostAndProfit
        ),
        Err(DomainError::ReauthenticationRequired)
    );

    let raised = session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");

    assert_eq!(
        raised,
        mobile_shop_system_lib::domain::identity::Assurance::Reauthenticated
    );
    let after = session::resolve(&pool, tokens.as_ref()).await.expect("resolve");
    assert_eq!(
        after.authorize(mobile_shop_system_lib::domain::identity::Permission::ViewCostAndProfit),
        Ok(())
    );
}

#[tokio::test]
async fn reauthentication_with_a_wrong_password_does_not_lock_the_account() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    for _ in 0..(MAX_FAILED_ATTEMPTS + 2) {
        assert_eq!(
            session::reauthenticate(&pool, tokens.as_ref(), "wrong").await,
            Err(DomainError::InvalidCredentials)
        );
    }

    let failed_attempts: i64 =
        sqlx::query_scalar("SELECT failed_attempts FROM users WHERE id = ?1")
            .bind(created.user_id.as_str())
            .fetch_one(&pool)
            .await
            .expect("row");
    assert_eq!(
        failed_attempts, 0,
        "an authenticated operator must not be able to lock themselves out"
    );
}

#[tokio::test]
async fn signing_in_ends_the_previous_session() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("first login");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("second login");

    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM sessions").await,
        1,
        "a terminal has one operator, so signing in replaces the session"
    );
}

#[tokio::test]
async fn logout_removes_the_credential_and_the_row() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    auth::logout(&pool, tokens.as_ref()).await.expect("logout");

    assert!(tokens.get().expect("store").is_none(), "credential must be gone");
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM sessions").await, 0);
    assert_eq!(
        session::resolve(&pool, tokens.as_ref()).await,
        Err(DomainError::SessionNotFound)
    );

    let mut conn = pool.acquire().await.expect("connection");
    assert_eq!(
        audit::count_by_type(&mut conn, audit::event::LOGOUT)
            .await
            .expect("count"),
        1
    );
    drop(conn);
}

#[tokio::test]
async fn the_picker_exposes_no_secret_material() {
    let (pool, _tokens) = fresh().await;
    bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    let summaries = auth::list_users(&pool).await.expect("list");
    assert_eq!(summaries.len(), 1);
    let rendered = format!("{summaries:?}");
    assert!(rendered.contains("Peter"));
    for leak in ["verifier", "failed_attempts", "locked_until", "argon2"] {
        assert!(
            !rendered.contains(leak),
            "the picker must not expose {leak}"
        );
    }
}

// ---------------------------------------------------------------------------
// Context wiring
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_identity_context_carries_both_the_pool_and_the_store() {
    let (pool, tokens) = fresh().await;
    let ctx = IdentityContext::new(pool.clone(), tokens.clone());

    assert_eq!(bootstrap::bootstrap_needed(&ctx.pool).await.expect("status"), true);
    // The credential store is reachable through the context, which is what makes
    // it impossible to hand a command a pool without also handing it the store.
    assert!(ctx.tokens.get().expect("store").is_none());
}

// ---------------------------------------------------------------------------
// Connection configuration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_pool_reaches_sqlite_with_the_configured_busy_timeout() {
    // Read the setting back out of the live connection rather than asserting that
    // the option appears in `db.rs`. A source-text guard would prove the call is
    // written; this proves SQLite actually received it, which is the claim that
    // matters. `PRAGMA busy_timeout` reports milliseconds.
    let (pool, _tokens) = fresh().await;

    let reported: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(&pool)
        .await
        .expect("read busy_timeout back from the connection");

    assert_eq!(
        reported,
        db::BUSY_TIMEOUT.as_millis() as i64,
        "the pool must apply the shared busy timeout, so a device pool and a test \
         pool cannot drift into different contention behaviour"
    );
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

#[test]
fn argon2id_round_trips_and_distinguishes_passwords() {
    use mobile_shop_system_lib::services::identity::crypto;

    let hash = crypto::hash_password(PASSWORD).expect("hash");
    assert!(hash.starts_with("$argon2id$"), "got {hash}");
    assert!(crypto::verify_password(PASSWORD, &hash), "the right password must verify");
    assert!(!crypto::verify_password("wrong", &hash), "a wrong password must not verify");
    assert!(!crypto::verify_password("", &hash));
}

#[test]
fn two_hashes_of_the_same_password_differ() {
    use mobile_shop_system_lib::services::identity::crypto;
    let a = crypto::hash_password(PASSWORD).expect("hash a");
    let b = crypto::hash_password(PASSWORD).expect("hash b");
    assert_ne!(a, b, "each verifier must use a fresh salt");
    assert!(crypto::verify_password(PASSWORD, &a));
    assert!(crypto::verify_password(PASSWORD, &b));
}

#[test]
fn a_malformed_verifier_denies_rather_than_grants() {
    use mobile_shop_system_lib::services::identity::crypto;
    assert!(!crypto::verify_password(PASSWORD, "not-a-phc-string"));
    assert!(!crypto::verify_password(PASSWORD, ""));
}

#[test]
fn the_dummy_verifier_verifies_nothing() {
    use mobile_shop_system_lib::services::identity::crypto;
    let dummy = crypto::dummy_verifier();
    for candidate in ["", "password", "password123", PASSWORD] {
        assert!(
            !crypto::verify_password(candidate, dummy),
            "the dummy verifier must not authenticate anything"
        );
    }
}

#[test]
fn tokens_are_unique_and_their_digests_are_stable() {
    use mobile_shop_system_lib::services::identity::crypto;
    let a = crypto::generate_token().expect("token a");
    let b = crypto::generate_token().expect("token b");
    assert_ne!(a, b, "each token must be freshly random");
    assert_eq!(crypto::hash_token(&a), crypto::hash_token(&a), "digest is stable");
    assert_ne!(crypto::hash_token(&a), crypto::hash_token(&b));
    assert_eq!(crypto::hash_token(&a).len(), 64);
}

// Product catalogue, against the same real SQLite.
mod catalog;

// User lifecycle: password management and user administration.
mod identity_lifecycle;

// A broken `user_credentials` invariant: the fault paths.
mod credentials_integrity;

// Migration `0004`: the `departments` table. Schema only; department behaviour
// arrives with its own slice.
mod departments_migration;

// Department persistence: row mapping and the write operations.
mod department_repository;

// Migration `0005`: the products rebuild and the new inventory-profile columns.
mod products_profile_migration;

// Real operating-system credential store checks. Ignored by default; see the
// module for how to run them deliberately.
mod windows_credential;

// Device settings: defaults, audit, blanket re-authentication (plan SP-1c).
mod settings;

// The Pattern lifecycle: set, verify, epoch, reset, disable (plan SP-1c).
mod pattern;

// Department authority: the audit trail, role refusals, the assurance mix
// (plan SP-1b).
mod authority;

// Price history: the edit and its transition row commit together (plan
// SP-1b).
mod price_history;
