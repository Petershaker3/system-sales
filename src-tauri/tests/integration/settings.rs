//! Device settings against real SQLite.
//!
//! The plan's settings guarantees, each proven against the live service layer:
//! defaults for anything never stored, a change audited inside the same
//! transaction, unknown keys refused without a write, blanket
//! re-authentication on `ManageSettings`, and the retired Pattern's key staying
//! out of the generic write path.

use std::sync::Arc;

use super::{count, fresh, PASSWORD};
use mobile_shop_system_lib::data::repositories::identity::audit;
use mobile_shop_system_lib::domain::settings::{SettingsSnapshot, PATTERN_REQUIRED};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session};
use mobile_shop_system_lib::services::settings;
use sqlx::SqlitePool;

/// The first manager, signed in at Normal assurance.
async fn manager() -> (SqlitePool, Arc<InMemoryTokenStore>) {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");
    (pool, tokens)
}

/// The same manager with the password freshly re-proved.
async fn reauthenticated_manager() -> (SqlitePool, Arc<InMemoryTokenStore>) {
    let (pool, tokens) = manager().await;
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("re-authenticate");
    (pool, tokens)
}

// ---------------------------------------------------------------------------
// ManageSettings is blanket re-authenticated
// ---------------------------------------------------------------------------

#[tokio::test]
async fn manage_settings_refuses_a_session_that_has_not_re_authenticated() {
    let (pool, tokens) = manager().await;

    let read = settings::read_snapshot(&pool, tokens.as_ref())
        .await
        .expect_err("a fresh login may not even read the settings");
    assert_eq!(read.code(), "REAUTHENTICATION_REQUIRED");

    let write = settings::update(&pool, tokens.as_ref(), "invoice_prefix", "2026-")
        .await
        .expect_err("a fresh login may not change the settings");
    assert_eq!(write.code(), "REAUTHENTICATION_REQUIRED");

    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM app_settings").await,
        0,
        "a refused call must not write a row"
    );
    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::SETTING_CHANGED)
                .await
                .expect("count"),
            0,
            "a refused call must not audit a change that never happened"
        );
    }
    // The connection is released: the in-memory pool allows only one.
}

// ---------------------------------------------------------------------------
// Defaults on a device that never configured anything
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_fresh_device_reads_every_default_back_with_no_rows_stored() {
    let (pool, tokens) = reauthenticated_manager().await;

    let snapshot = settings::read_snapshot(&pool, tokens.as_ref())
        .await
        .expect("read");
    assert_eq!(
        snapshot,
        SettingsSnapshot::default(),
        "an unconfigured device must read as its defaults"
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM app_settings").await,
        0,
        "defaults are applied at read time, not written out eagerly"
    );
}

// ---------------------------------------------------------------------------
// A change is stored and audited together
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_setting_change_is_stored_and_audited_in_one_transaction() {
    let (pool, tokens) = reauthenticated_manager().await;

    settings::update(&pool, tokens.as_ref(), "invoice_prefix", "2026-")
        .await
        .expect("update");

    let snapshot = settings::read_snapshot(&pool, tokens.as_ref())
        .await
        .expect("read back");
    assert_eq!(snapshot.invoice_prefix, "2026-");
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM app_settings").await,
        1
    );

    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::SETTING_CHANGED)
                .await
                .expect("count"),
            1
        );
    }

    let detail: Option<String> = sqlx::query_scalar(
        "SELECT detail FROM audit_events WHERE event_type = 'setting_changed'",
    )
    .fetch_one(&pool)
    .await
    .expect("the event exists, so its detail exists");
    let detail = detail.expect("a settings change must carry a detail");
    assert!(
        detail.contains("invoice_prefix"),
        "the detail must name the key that moved: {detail}"
    );
    assert!(
        detail.contains("2026-"),
        "the detail must record the value written: {detail}"
    );
}

// ---------------------------------------------------------------------------
// Unknown keys and the Pattern key are refused without a write
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_unknown_setting_key_is_refused_without_a_write() {
    let (pool, tokens) = reauthenticated_manager().await;

    let error = settings::update(&pool, tokens.as_ref(), "no_such_key", "1")
        .await
        .expect_err("an unknown key must be refused");
    assert_eq!(error.code(), "SETTING_UNKNOWN_KEY");

    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM app_settings").await,
        0,
        "the refusal must happen before any write"
    );
    assert_eq!(
        settings::read_snapshot(&pool, tokens.as_ref())
            .await
            .expect("read"),
        SettingsSnapshot::default(),
        "the snapshot must be untouched"
    );
    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::SETTING_CHANGED)
                .await
                .expect("count"),
            0,
            "nothing changed, so nothing is audited"
        );
    }
}

#[tokio::test]
async fn the_pattern_key_is_not_writable_through_the_generic_settings_api() {
    let (pool, tokens) = reauthenticated_manager().await;

    // `pattern_required` is deliberately not a `SettingKey`. The Pattern is
    // retired (ADR-017 §3) and nothing reads the flag any more, but an older
    // database may still hold it, so the name stays known — and stays outside
    // the generic writer, which must never be able to recreate it.
    let error = settings::update(&pool, tokens.as_ref(), PATTERN_REQUIRED, "1")
        .await
        .expect_err("the pattern flag must refuse the generic writer");
    assert_eq!(error.code(), "SETTING_UNKNOWN_KEY");

    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM app_settings").await,
        0,
        "no row may appear from a refused write"
    );
}
