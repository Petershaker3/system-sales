//! Department persistence integration tests, against real SQLite (`spec:138`).
//!
//! Scoped to the repository: it proves what was written comes back unchanged, and
//! that a malformed row is refused rather than repaired. The rules themselves are
//! unit-tested in `tests/unit/main.rs`; testing them again through SQL would prove
//! the database, not the boundary under test.

use std::sync::Arc;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::data::repositories::organisation::department as repo;
use mobile_shop_system_lib::domain::identity::{Role, UserId};
use mobile_shop_system_lib::domain::organisation::{
    CostMethod, Department, DepartmentError, DepartmentId, DepartmentName, DepartmentStatus,
    DepartmentVat, VatRate,
};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::users;
use mobile_shop_system_lib::services::identity::{
    auth, bootstrap, session as session_service, IdentityContext,
};
use sqlx::{Row, SqlitePool};

const PASSWORD: &str = "correct horse battery";

/// A migrated database with **two real accounts**.
///
/// Two, not one, because `departments.created_by` and `updated_by` are
/// `REFERENCES users (id) ON DELETE RESTRICT`. An edit or an archive attributed
/// to a freshly generated UUID is refused by the database — the schema working
/// correctly — so a test that needs a second actor needs a second account.
/// Creating one through the real user service keeps the row honest.
async fn shop() -> (SqlitePool, UserId, UserId) {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());

    let first = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), first.user_id, PASSWORD)
        .await
        .expect("login");

    session_service::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("re-authenticate the manager");
    let manager = session_service::resolve(&pool, tokens.as_ref())
        .await
        .expect("manager session");

    let identity = IdentityContext::new(pool.clone(), tokens);
    let second = users::create_user(
        &identity.pool,
        &manager,
        "Second Operator",
        "operator-2",
        Role::Sales,
        PASSWORD,
    )
    .await
    .expect("create a second real account through the real service");

    (pool, first.user_id, second)
}

/// A department with every field set to something recognisable, so a round trip
/// that moves one value is visible rather than plausible.
fn department(creator: UserId, name: &str) -> Department {
    let vat = DepartmentVat::new(true, Some(VatRate::new(1450).unwrap()), true).expect("valid vat");
    Department::new(
        DepartmentName::new(name).expect("a valid name"),
        CostMethod::Fifo,
        vat,
        7,
        creator,
        1000,
    )
}

#[tokio::test]
async fn a_department_survives_a_round_trip_with_every_field_intact() {
    let (pool, manager, _operator) = shop().await;
    let original = department(manager, "Phones");
    let mut conn = pool.acquire().await.expect("connection");

    repo::insert(&mut conn, &original).await.expect("insert");

    let loaded = repo::find_by_id(&mut conn, original.id)
        .await
        .expect("read")
        .expect("the department exists");

    // All thirteen columns, asserted individually. Comparing whole aggregates
    // would prove the same thing but would not name the field that moved.
    assert_eq!(loaded.id, original.id);
    assert_eq!(loaded.name.as_str(), "Phones");
    assert_eq!(loaded.status, DepartmentStatus::Active);
    assert_eq!(loaded.cost_method, CostMethod::Fifo);
    assert!(loaded.vat.is_enabled());
    assert_eq!(loaded.vat.rate().map(|r| r.as_basis_points()), Some(1450));
    assert!(loaded.vat.is_inclusive());
    assert_eq!(loaded.sort_order, 7);
    assert_eq!(loaded.created_by, manager);
    assert_eq!(loaded.updated_by, manager);
    assert_eq!(loaded.created_at, 1000);
    assert_eq!(loaded.updated_at, 1000);
    assert_eq!(loaded.archived_at, None);

    assert_eq!(
        loaded, original,
        "the aggregate must come back exactly, not merely plausibly"
    );
}

#[tokio::test]
async fn a_department_without_vat_stores_a_real_null_rather_than_a_zero() {
    let (pool, manager, _operator) = shop().await;
    let original = Department::new(
        DepartmentName::new("Accessories").expect("valid"),
        CostMethod::MovingAverage,
        DepartmentVat::disabled(),
        0,
        manager,
        1000,
    );
    let mut conn = pool.acquire().await.expect("connection");
    repo::insert(&mut conn, &original).await.expect("insert");

    // The raw column, not the domain value: the claim is that NULL was stored,
    // which a domain round trip alone would not distinguish from a zero.
    let rate: Option<i64> =
        sqlx::query_scalar("SELECT vat_rate_bp FROM departments WHERE id = ?1")
            .bind(original.id.as_str())
            .fetch_one(&mut *conn)
            .await
            .expect("read raw column");

    assert_eq!(rate, None, "`vat_rate_bp` must be NULL, not zero");
}

#[tokio::test]
async fn an_unknown_id_is_absent_rather_than_an_error() {
    let (pool, _manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");

    let found = repo::find_by_id(&mut conn, DepartmentId::generate())
        .await
        .expect("a missing row is not a database failure");

    assert!(found.is_none(), "a missing department must read as None");
}

#[tokio::test]
async fn listing_returns_active_and_archived_in_the_approved_order() {
    let (pool, manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");

    // Inserted deliberately out of order, so the result cannot be an accident of
    // insertion order.
    let mut spare_parts = department(manager, "Spare Parts");
    spare_parts.sort_order = 2;
    repo::insert(&mut conn, &spare_parts).await.expect("insert");

    let mut phones = department(manager, "Phones");
    phones.sort_order = 0;
    repo::insert(&mut conn, &phones).await.expect("insert");

    let mut accessories = department(manager, "Accessories");
    accessories.sort_order = 1;
    repo::insert(&mut conn, &accessories).await.expect("insert");

    // Archiving one must not remove it from the full listing.
    let mut old_stock = department(manager, "Old Stock");
    old_stock.sort_order = 3;
    repo::insert(&mut conn, &old_stock).await.expect("insert");
    old_stock.archive(manager, 5000).expect("archive in the domain");
    repo::archive(&mut conn, &old_stock).await.expect("persist the archive");

    let all = repo::list_all(&mut conn).await.expect("list all");
    let names: Vec<&str> = all.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["Phones", "Accessories", "Spare Parts", "Old Stock"],
        "ordering is by sort_order first, and archived rows are included"
    );

    let active = repo::list_active(&mut conn).await.expect("list active");
    let active_names: Vec<&str> = active.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(
        active_names,
        vec!["Phones", "Accessories", "Spare Parts"],
        "an archived department is excluded only from the active listing"
    );
}

#[tokio::test]
async fn listing_breaks_a_sort_order_tie_deterministically_by_name() {
    let (pool, manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");

    for name in ["Screens", "Chargers", "Batteries"] {
        let mut dept = department(manager, name);
        dept.sort_order = 5; // every row ties
        repo::insert(&mut conn, &dept).await.expect("insert");
    }

    let names: Vec<String> = repo::list_all(&mut conn)
        .await
        .expect("list")
        .iter()
        .map(|d| d.name.as_str().to_string())
        .collect();

    assert_eq!(
        names,
        vec!["Batteries", "Chargers", "Screens"],
        "a tie must resolve by name, not by insertion order"
    );
}

#[tokio::test]
async fn an_edit_persists_and_survives_a_reload() {
    let (pool, manager, operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    let mut dept = department(manager, "Phones");
    repo::insert(&mut conn, &dept).await.expect("insert");

    dept.update(
        DepartmentName::new("  Mobile Phones  ").expect("valid"),
        CostMethod::MovingAverage,
        DepartmentVat::new(false, Some(VatRate::new(700).unwrap()), false).expect("valid"),
        3,
        operator,
        9000,
    )
    .expect("an active department accepts an edit");
    repo::update(&mut conn, &dept).await.expect("persist the edit");

    let loaded = repo::find_by_id(&mut conn, dept.id).await.unwrap().unwrap();
    assert_eq!(loaded.name.as_str(), "Mobile Phones", "the domain trimmed it");
    assert_eq!(loaded.cost_method, CostMethod::MovingAverage);
    assert!(!loaded.vat.is_enabled());
    assert_eq!(
        loaded.vat.rate().map(|r| r.as_basis_points()),
        Some(700),
        "switching VAT off must keep the recorded rate"
    );
    assert_eq!(loaded.sort_order, 3);
    assert_eq!(loaded.updated_by, operator);
    assert_eq!(loaded.updated_at, 9000);
    assert_eq!(loaded.created_by, manager, "the creator is unchanged");
}

#[tokio::test]
async fn an_update_cannot_reach_identity_or_provenance_columns() {
    let (pool, manager, operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    let mut dept = department(manager, "Phones");
    repo::insert(&mut conn, &dept).await.expect("insert");

    dept.update(
        DepartmentName::new("Phones").expect("valid"),
        CostMethod::MovingAverage,
        DepartmentVat::disabled(),
        5,
        operator,
        9000,
    )
    .expect("edit");
    repo::update(&mut conn, &dept).await.expect("persist");

    // The raw row: the claim is which columns the statement touched, which a
    // domain-level assertion could not see.
    let row = sqlx::query("SELECT created_by, created_at FROM departments WHERE id = ?1")
        .bind(dept.id.as_str())
        .fetch_one(&mut *conn)
        .await
        .expect("read raw row");

    assert_eq!(
        row.get::<String, _>("created_by"),
        manager.as_str(),
        "an ordinary update must not rewrite who created the department"
    );
    assert_eq!(
        row.get::<i64, _>("created_at"),
        1000,
        "an ordinary update must not rewrite when it was created"
    );
}

#[tokio::test]
async fn archiving_persists_the_status_and_the_recorded_moment() {
    let (pool, manager, operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    let mut dept = department(manager, "Phones");
    repo::insert(&mut conn, &dept).await.expect("insert");

    dept.archive(operator, 5000).expect("archive in the domain");
    repo::archive(&mut conn, &dept).await.expect("persist the archive");

    let loaded = repo::find_by_id(&mut conn, dept.id).await.unwrap().unwrap();
    assert_eq!(loaded.status, DepartmentStatus::Archived);
    assert_eq!(
        loaded.archived_at,
        Some(5000),
        "the archive moment the domain recorded is the moment stored"
    );
    assert_eq!(loaded.updated_by, operator);
    assert_eq!(loaded.updated_at, 5000);
    assert!(!loaded.is_editable());
}

#[tokio::test]
async fn archiving_preserves_the_business_fields() {
    let (pool, manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    let mut dept = department(manager, "Phones");
    repo::insert(&mut conn, &dept).await.expect("insert");

    dept.archive(manager, 5000).expect("archive");
    repo::archive(&mut conn, &dept).await.expect("persist");

    let loaded = repo::find_by_id(&mut conn, dept.id).await.unwrap().unwrap();
    assert_eq!(loaded.name.as_str(), "Phones");
    assert_eq!(loaded.cost_method, CostMethod::Fifo);
    assert!(loaded.vat.is_enabled());
    assert_eq!(loaded.vat.rate().map(|r| r.as_basis_points()), Some(1450));
    assert_eq!(loaded.sort_order, 7);
    assert_eq!(loaded.created_at, 1000);
    assert_eq!(loaded.created_by, manager);
}

#[tokio::test]
async fn an_archived_department_cannot_be_archived_again() {
    let (pool, manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    let mut dept = department(manager, "Phones");
    repo::insert(&mut conn, &dept).await.expect("insert");
    dept.archive(manager, 5000).expect("first archive");
    repo::archive(&mut conn, &dept).await.expect("persist");

    // The domain is the authority on transitions, so a second archive never
    // reaches a statement: it is refused before persistence is attempted.
    assert_eq!(
        dept.archive(manager, 9000),
        Err(DepartmentError::IsArchived)
    );

    let loaded = repo::find_by_id(&mut conn, dept.id).await.unwrap().unwrap();
    assert_eq!(
        loaded.archived_at,
        Some(5000),
        "the original archive moment must not be restamped"
    );
}

#[tokio::test]
async fn the_archive_statement_cannot_reopen_a_department() {
    let (pool, manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    let mut dept = department(manager, "Phones");
    repo::insert(&mut conn, &dept).await.expect("insert");
    dept.archive(manager, 5000).expect("archive");
    repo::archive(&mut conn, &dept).await.expect("persist");

    // Re-persisting the archived aggregate must leave it archived. No version of
    // the archive statement writes `active`.
    repo::archive(&mut conn, &dept)
        .await
        .expect("idempotent at the storage layer");

    let status: String = sqlx::query_scalar("SELECT status FROM departments WHERE id = ?1")
        .bind(dept.id.as_str())
        .fetch_one(&mut *conn)
        .await
        .expect("read raw status");

    assert_eq!(status, "archived");
}

// ---------------------------------------------------------------------------
// Defensive reads
// ---------------------------------------------------------------------------

/// Write a row that the domain would never produce.
///
/// `PRAGMA ignore_check_constraints` exists precisely so a test can prove the
/// reader defends itself. It is per-connection, applies only to this test's
/// connection, and no schema constraint is altered anywhere.
async fn bypass_checks(conn: &mut sqlx::SqliteConnection) {
    sqlx::query("PRAGMA ignore_check_constraints = ON")
        .execute(&mut *conn)
        .await
        .expect("bypass the CHECK constraints for this row only");
}

#[tokio::test]
async fn an_unrecognised_cost_method_in_storage_is_refused_rather_than_defaulted() {
    let (pool, manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    bypass_checks(&mut conn).await;

    sqlx::query(
        "INSERT INTO departments
           (id, name, status, cost_method, vat_enabled, vat_rate_bp, vat_inclusive,
            sort_order, created_by, updated_by, created_at, updated_at, archived_at)
         VALUES (?1, 'Mystery', 'active', 'weighted_average', 0, NULL, 0, 0,
                 ?2, ?2, 1000, 1000, NULL)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(manager.as_str())
    .execute(&mut *conn)
    .await
    .expect("insert a deliberately malformed row");

    let err = repo::list_all(&mut conn)
        .await
        .expect_err("an unknown cost method must not become moving_average by default");

    let message = err.to_string();
    assert!(
        message.contains("unknown cost_method in departments"),
        "the failure must name the column; got: {message}"
    );
}

#[tokio::test]
async fn an_unrecognised_status_in_storage_is_refused_rather_than_defaulted() {
    let (pool, manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    bypass_checks(&mut conn).await;

    sqlx::query(
        "INSERT INTO departments
           (id, name, status, cost_method, vat_enabled, vat_rate_bp, vat_inclusive,
            sort_order, created_by, updated_by, created_at, updated_at, archived_at)
         VALUES (?1, 'Vanished', 'deleted', 'moving_average', 0, NULL, 0, 0,
                 ?2, ?2, 1000, 1000, NULL)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(manager.as_str())
    .execute(&mut *conn)
    .await
    .expect("insert a status outside the approved domain");

    let err = repo::list_all(&mut conn)
        .await
        .expect_err("an unknown status must not be read as active");

    assert!(
        err.to_string().contains("unknown status in departments"),
        "the failure must name the column; got: {err}"
    );
}

#[tokio::test]
async fn a_status_and_archive_moment_that_disagree_is_refused() {
    let (pool, manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    let dept = department(manager, "Phones");
    repo::insert(&mut conn, &dept).await.expect("insert");

    // Force the impossible combination past the schema. SQLite cannot CHECK it —
    // it spans two columns — which is exactly why the domain has to.
    bypass_checks(&mut conn).await;
    sqlx::query("UPDATE departments SET archived_at = 1234 WHERE id = ?1")
        .bind(dept.id.as_str())
        .execute(&mut *conn)
        .await
        .expect("write the contradiction directly");

    let err = repo::find_by_id(&mut conn, dept.id)
        .await
        .expect_err("active with an archive moment must be refused");

    assert!(
        err.to_string()
            .contains(DepartmentError::ArchiveStateInconsistent.code()),
        "the failure must carry the domain's own stable code; got: {err}"
    );
}

#[tokio::test]
async fn vat_enabled_without_a_rate_in_storage_is_refused() {
    let (pool, manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    bypass_checks(&mut conn).await;

    sqlx::query(
        "INSERT INTO departments
           (id, name, status, cost_method, vat_enabled, vat_rate_bp, vat_inclusive,
            sort_order, created_by, updated_by, created_at, updated_at, archived_at)
         VALUES (?1, 'Broken Vat', 'active', 'moving_average', 1, NULL, 0, 0,
                 ?2, ?2, 1000, 1000, NULL)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(manager.as_str())
    .execute(&mut *conn)
    .await
    .expect("insert a VAT state the schema would otherwise refuse");

    // Read the id before any further pool use: this pool holds one connection,
    // so acquiring one and then querying the pool would deadlock.
    let raw: String = sqlx::query_scalar("SELECT id FROM departments WHERE name = 'Broken Vat'")
        .fetch_one(&mut *conn)
        .await
        .expect("the row exists");

    let err = repo::find_by_id(&mut conn, DepartmentId::from_uuid(raw.parse().expect("uuid")))
        .await
        .expect_err("VAT on with no rate must be refused");

    assert!(
        err.to_string().contains(DepartmentError::VatRateRequired.code()),
        "the failure must name the VAT rule that was broken; got: {err}"
    );
}

#[tokio::test]
async fn an_empty_stored_name_is_refused_rather_than_trimmed_into_shape() {
    let (pool, manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    bypass_checks(&mut conn).await;

    sqlx::query(
        "INSERT INTO departments
           (id, name, status, cost_method, vat_enabled, vat_rate_bp, vat_inclusive,
            sort_order, created_by, updated_by, created_at, updated_at, archived_at)
         VALUES (?1, '   ', 'active', 'moving_average', 0, NULL, 0, 0,
                 ?2, ?2, 1000, 1000, NULL)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(manager.as_str())
    .execute(&mut *conn)
    .await
    .expect("insert a name the domain would refuse");

    let err = repo::list_all(&mut conn)
        .await
        .expect_err("a whitespace-only stored name must not become a department");

    assert!(
        err.to_string().contains(DepartmentError::NameRequired.code()),
        "the failure must name the name rule; got: {err}"
    );
}

#[tokio::test]
async fn a_database_failure_is_distinguishable_from_a_malformed_row() {
    let (pool, manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    let dept = department(manager, "Phones");
    repo::insert(&mut conn, &dept).await.expect("insert");

    // Two live departments cannot share a name, so the second insert is refused
    // by the unique index. That is a database failure, not a malformed read: the
    // error is a sqlx constraint error rather than `Error::Protocol`.
    let clash = repo::insert(&mut conn, &department(manager, "Phones"))
        .await
        .expect_err("the partial unique index must refuse a duplicate live name");

    assert!(
        !matches!(clash, sqlx::Error::Protocol(_)),
        "a constraint violation is not a malformed-row protocol failure; got: {clash}"
    );
}

#[tokio::test]
async fn an_actor_that_is_not_a_real_user_is_refused_by_the_schema() {
    let (pool, _manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");

    // A generated UUID that is not an account. Attribution is mandatory and the
    // foreign key is `ON DELETE RESTRICT`, so the database refuses rather than
    // storing a department attributed to nobody.
    let orphan = Department::new(
        DepartmentName::new("Orphan").expect("valid"),
        CostMethod::MovingAverage,
        DepartmentVat::disabled(),
        0,
        UserId::generate(),
        1000,
    );

    assert!(
        repo::insert(&mut conn, &orphan).await.is_err(),
        "attribution must point at a real account"
    );
}

#[tokio::test]
async fn a_user_referenced_by_a_department_may_not_be_deleted() {
    let (pool, manager, _operator) = shop().await;
    let mut conn = pool.acquire().await.expect("connection");
    let dept = department(manager, "Phones");
    repo::insert(&mut conn, &dept).await.expect("insert");

    sqlx::query("DELETE FROM users WHERE id = ?1")
        .bind(manager.as_str())
        .execute(&mut *conn)
        .await
        .expect_err("ON DELETE RESTRICT must refuse removing a referenced user");
}