//! Migration `0004`: the `departments` table itself.
//!
//! Proves only what the migration claims, against real SQLite (`spec:138`). It
//! deliberately does **not** test department behaviour: the domain type, the
//! trimming rule and the CRUD services do not exist yet, so a test here could
//! only assert the database agrees with itself.
//!
//! Raw SQL is the correct tool for this file. The claim under test *is* the
//! schema, so writing through a service would test the service instead and could
//! pass while the constraint it depends on was absent.

use std::sync::Arc;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{bootstrap, IdentityContext};
use sqlx::SqlitePool;

const PASSWORD: &str = "correct horse battery";

/// A migrated database with one manager, so the attribution foreign keys have a
/// real parent row to point at.
async fn migrated() -> SqlitePool {
    let pool = db::open_in_memory().await.expect("in-memory database");
    bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    // Constructed so the token store import is exercised the same way a command
    // would, even though this file never resolves a session.
    let _ = IdentityContext::new(pool.clone(), Arc::new(InMemoryTokenStore::new()));
    pool
}

/// The single existing user, for attribution columns.
async fn manager_id(pool: &SqlitePool) -> String {
    sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(pool)
        .await
        .expect("a user exists")
}

/// Insert one department with every column supplied, so a test that changes one
/// column does not accidentally vary another.
async fn insert_department(pool: &SqlitePool, name: &str) {
    let manager = manager_id(pool).await;
    sqlx::query(
        "INSERT INTO departments
           (id, name, status, cost_method, sort_order,
            created_by, updated_by, created_at, updated_at)
         VALUES (?1, ?2, 'active', 'moving_average', 0, ?3, ?3, 1000, 1000)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(name)
    .bind(&manager)
    .execute(pool)
    .await
    .expect("insert department");
}

#[tokio::test]
async fn migration_0004_applies_after_0001_through_0003() {
    let pool = migrated().await;

    // `open_in_memory` runs the whole migration set, so reaching a query at all
    // proves none of them failed. The ledger then confirms they were applied in
    // sequence with none skipped.
    //
    // Asserting *ordering and contiguity* rather than an exact list: pinning the
    // total would make every future migration fail this test, which would be a
    // brittle test rather than a strict one.
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .expect("migration ledger");

    let expected: Vec<i64> = (1..=versions.len() as i64).collect();
    assert_eq!(
        versions, expected,
        "migrations must be recorded as a contiguous ascending sequence, and 0004 \
         must be among them"
    );
    assert!(
        versions.contains(&4),
        "migration 0004 must be applied; found {versions:?}"
    );
}

#[tokio::test]
async fn the_departments_table_exists_alongside_the_earlier_ones() {
    let pool = migrated().await;

    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .expect("table list");

    for expected in [
        "audit_events",
        "departments",
        "products",
        "sessions",
        "user_credentials",
        "users",
    ] {
        assert!(
            tables.contains(&expected.to_string()),
            "`{expected}` must exist; found {tables:?}"
        );
    }
}

#[tokio::test]
async fn the_departments_table_carries_every_approved_column() {
    let pool = migrated().await;

    // Selected by name, not by position: `pragma_table_info` leads with a `cid`
    // INTEGER, so a positional read decodes an integer column into a String.
    let columns: Vec<(String, i64)> = sqlx::query_as(
        "SELECT name, \"notnull\" AS is_not_null FROM pragma_table_info('departments')",
    )
    .fetch_all(&pool)
    .await
    .expect("column list");

    let named: Vec<&str> = columns.iter().map(|(name, _)| name.as_str()).collect();
    for expected in [
        "id",
        "name",
        "status",
        "cost_method",
        "vat_enabled",
        "vat_rate_bp",
        "vat_inclusive",
        "sort_order",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at",
        "archived_at",
    ] {
        assert!(
            named.contains(&expected),
            "`{expected}` must be a column; found {named:?}"
        );
    }

    let not_null = |column: &str| -> bool {
        columns
            .iter()
            .find(|(name, _)| name == column)
            .map(|(_, is_not_null)| *is_not_null == 1)
            .expect("column exists")
    };

    // The columns that must never be absent. `archived_at` is the deliberate
    // exception and is asserted separately below.
    for required in [
        "id",
        "name",
        "status",
        "cost_method",
        "vat_enabled",
        "vat_inclusive",
        "sort_order",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at",
    ] {
        assert!(not_null(required), "`{required}` must be NOT NULL");
    }

    assert!(
        !not_null("archived_at"),
        "archived_at must stay nullable so a live department needs no archive timestamp"
    );
}

#[tokio::test]
async fn a_department_references_its_users_and_its_parent_category_only() {
    let pool = migrated().await;

    // By name for the same reason: `pragma_foreign_key_list` leads with an integer
    // `id`. `table` and `from` are keywords, so both are quoted.
    let foreign_keys: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT \"table\", \"from\", on_delete FROM pragma_foreign_key_list('departments')",
    )
    .fetch_all(&pool)
    .await
    .expect("foreign key list");

    // Two to users for attribution (0004), and since 0016 the parent of a
    // sub-category (ADR-018 §1). Still no location, warehouse or stock table.
    assert_eq!(
        foreign_keys.len(),
        3,
        "exactly three foreign keys: two to users, one to the parent; found {foreign_keys:?}"
    );
    for (table, from, on_delete) in &foreign_keys {
        match from.as_str() {
            "created_by" | "updated_by" => assert_eq!(
                table, "users",
                "attribution must point at users; found `{table}`"
            ),
            "parent_id" => assert_eq!(
                table, "departments",
                "a sub-category's parent is a category; found `{table}`"
            ),
            other => panic!("unexpected foreign key column `{other}` to `{table}`"),
        }
        assert_eq!(
            on_delete, "RESTRICT",
            "nothing referenced may be deleted from under a category: `{from}`"
        );
    }
}

#[tokio::test]
async fn two_live_departments_may_not_share_a_name() {
    let pool = migrated().await;
    insert_department(&pool, "Phones").await;

    let manager = manager_id(&pool).await;
    let result = sqlx::query(
        "INSERT INTO departments
           (id, name, status, cost_method, sort_order,
            created_by, updated_by, created_at, updated_at)
         VALUES (?1, 'Phones', 'active', 'moving_average', 1, ?2, ?2, 1000, 1000)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(&manager)
    .execute(&pool)
    .await;

    assert!(
        result.is_err(),
        "two live departments sharing a name must be refused by the unique index"
    );
}

#[tokio::test]
async fn a_duplicate_live_name_is_refused_case_insensitively() {
    let pool = migrated().await;
    insert_department(&pool, "Phones").await;

    let manager = manager_id(&pool).await;
    let result = sqlx::query(
        "INSERT INTO departments
           (id, name, status, cost_method, sort_order,
            created_by, updated_by, created_at, updated_at)
         VALUES (?1, 'phones', 'active', 'moving_average', 1, ?2, ?2, 1000, 1000)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(&manager)
    .execute(&pool)
    .await;

    assert!(
        result.is_err(),
        "`Phones` and `phones` are one classification, not two"
    );
}

#[tokio::test]
async fn a_name_becomes_reusable_once_the_previous_department_is_archived() {
    let pool = migrated().await;
    insert_department(&pool, "Phones").await;

    sqlx::query("UPDATE departments SET status = 'archived', archived_at = 2000")
        .execute(&pool)
        .await
        .expect("archive");

    // The whole reason this is a partial unique index rather than a table-level
    // UNIQUE: a permanent constraint would make the name unreclaimable forever.
    insert_department(&pool, "Phones")
        .await;

    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM departments WHERE name = 'Phones' AND status = 'active'",
    )
    .fetch_one(&pool)
    .await
    .expect("count");

    assert_eq!(live, 1, "the reused name belongs to the newly created department");

    let archived: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM departments WHERE name = 'Phones' AND status = 'archived'",
    )
    .fetch_one(&pool)
    .await
    .expect("count");

    assert_eq!(
        archived, 1,
        "the archived department keeps its row and its history"
    );
}

#[tokio::test]
async fn both_approved_cost_methods_are_accepted_and_anything_else_is_not() {
    let pool = migrated().await;
    let manager = manager_id(&pool).await;

    // `fifo` is accepted as configuration only. No costing engine exists, so this
    // asserts the column stores the value and nothing more.
    for method in ["moving_average", "fifo"] {
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO departments
               (id, name, status, cost_method, sort_order,
                created_by, updated_by, created_at, updated_at)
             VALUES (?1, ?2, 'active', ?3, 0, ?4, ?4, 1000, 1000)",
        )
        .bind(&id)
        .bind(format!("Department for {method}"))
        .bind(method)
        .bind(&manager)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("`{method}` must be accepted as a cost method: {e}"));

        let stored: String = sqlx::query_scalar("SELECT cost_method FROM departments WHERE id = ?1")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .expect("read back");

        assert_eq!(stored, method, "`{method}` must round-trip unchanged");
    }

    let result = sqlx::query(
        "INSERT INTO departments
           (id, name, status, cost_method, sort_order,
            created_by, updated_by, created_at, updated_at)
         VALUES (?1, 'Weighted', 'active', 'weighted_average', 0, ?2, ?2, 1000, 1000)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(&manager)
    .execute(&pool)
    .await;

    assert!(
        result.is_err(),
        "an unrecognised cost method must be refused by the CHECK constraint"
    );
}

#[tokio::test]
async fn the_status_domain_is_exactly_active_and_archived() {
    let pool = migrated().await;
    let manager = manager_id(&pool).await;

    for status in ["active", "archived"] {
        sqlx::query(
            "INSERT INTO departments
               (id, name, status, cost_method, sort_order,
                created_by, updated_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'moving_average', 0, ?4, ?4, 1000, 1000)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(format!("Department {status}"))
        .bind(status)
        .bind(&manager)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("`{status}` must be accepted: {e}"));
    }

    let result = sqlx::query(
        "INSERT INTO departments
           (id, name, status, cost_method, sort_order,
            created_by, updated_by, created_at, updated_at)
         VALUES (?1, 'Deleted', 'deleted', 'moving_average', 0, ?2, ?2, 1000, 1000)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(&manager)
    .execute(&pool)
    .await;

    assert!(
        result.is_err(),
        "a lifecycle state beyond active and archived must be refused"
    );
}

#[tokio::test]
async fn vat_enabled_without_a_rate_is_refused_and_the_reverse_is_allowed() {
    let pool = migrated().await;
    let manager = manager_id(&pool).await;

    let base = |id: &str, name: &str, enabled: i64, rate: Option<i64>| {
        sqlx::query(
            "INSERT INTO departments
               (id, name, status, cost_method, vat_enabled, vat_rate_bp, vat_inclusive,
                sort_order, created_by, updated_by, created_at, updated_at)
             VALUES (?1, ?2, 'active', 'moving_average', ?3, ?4, 0, 0, ?5, ?5, 1000, 1000)",
        )
        .bind(id)
        .bind(name)
        .bind(enabled)
        .bind(rate)
        .bind(&manager)
    };

    base(&uuid::Uuid::now_v7().to_string(), "No rate", 1, None)
        .execute(&pool)
        .await
        .expect_err("VAT enabled with no rate is meaningless and must be refused");

    base(&uuid::Uuid::now_v7().to_string(), "Has rate", 1, Some(1450))
        .execute(&pool)
        .await
        .expect("VAT enabled with a rate is valid");

    // Deliberately allowed: switching VAT off is a business decision, and forcing
    // the operator to erase the rate as well would lose it for no benefit.
    base(&uuid::Uuid::now_v7().to_string(), "Disabled with rate", 0, Some(1450))
        .execute(&pool)
        .await
        .expect("a recorded rate may outlive the VAT switch");
}

#[tokio::test]
async fn a_department_refuses_an_unknown_author() {
    let pool = migrated().await;

    let result = sqlx::query(
        "INSERT INTO departments
           (id, name, status, cost_method, sort_order,
            created_by, updated_by, created_at, updated_at)
         VALUES (?1, 'Orphan', 'active', 'moving_average', 0,
                 '00000000-0000-0000-0000-000000000000',
                 '00000000-0000-0000-0000-000000000000', 1000, 1000)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .execute(&pool)
    .await;

    assert!(
        result.is_err(),
        "attribution must point at a real user; foreign keys are enforced per \
         connection (`db.rs`), so this must fail rather than be accepted"
    );
}

#[tokio::test]
async fn a_user_referenced_by_a_department_may_not_be_deleted() {
    let pool = migrated().await;
    insert_department(&pool, "Phones").await;
    let manager = manager_id(&pool).await;

    sqlx::query("DELETE FROM users WHERE id = ?1")
        .bind(&manager)
        .execute(&pool)
        .await
        .expect_err("ON DELETE RESTRICT must refuse removing a referenced user");
}