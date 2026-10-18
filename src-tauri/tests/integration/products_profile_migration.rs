//! Migration `0005`: the product inventory profile rebuild.
//!
//! Proves the rebuild preserved everything `0002` created and added only the three
//! approved columns, against real SQLite (`spec:138`).
//!
//! The rows must exist *before* `0005` runs, so these tests build a database at the
//! `0004` state by hand and apply `0005` afterwards. `db::open_in_memory` cannot be
//! used here because it runs the whole migration set, including the rebuild, before
//! a test could seed anything.
//!
//! Users are inserted directly rather than through `bootstrap`, because nothing in
//! this file authenticates. Only the foreign keys matter, and they need a real row.

use mobile_shop_system_lib::domain::catalog::{Product, ProductName, ProductStatus};
use mobile_shop_system_lib::domain::identity::UserId;
use mobile_shop_system_lib::domain::money::Piastres;
use mobile_shop_system_lib::domain::organisation::DepartmentId;
use mobile_shop_system_lib::data::db;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

const M1: &str = include_str!("../../src/data/migrations/0001_identity.sql");
const M2: &str = include_str!("../../src/data/migrations/0002_catalog.sql");
const M4: &str = include_str!("../../src/data/migrations/0004_departments.sql");
const M5: &str = include_str!("../../src/data/migrations/0005_products_inventory_profile.sql");

const MANAGER: &str = "01920000-0000-7000-8000-00000000cafe";

/// A database at the `0004` state, holding three pre-rebuild products.
///
/// Mirrors `db::open_in_memory`'s pool configuration — single connection, foreign
/// keys enforced — but applies migrations by hand so `0005` is still pending.
async fn at_0004() -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .in_memory(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("in-memory database");

    for migration in [M1, M2, M4] {
        sqlx::raw_sql(migration)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("applying the pre-0005 schema failed: {e}"));
    }

    // A real user row: nothing logs in, but `products.created_by` is a foreign key.
    sqlx::query(
        "INSERT INTO users (id, display_name, role, verifier, created_at, updated_at)
         VALUES (?1, 'Peter', 'manager', 'not-a-real-verifier', 1000, 1000)",
    )
    .bind(MANAGER)
    .execute(&pool)
    .await
    .expect("a user to attribute products to");

    for (id, name, disposition, barcode, price) in [
        (
            "01920000-0000-7000-8000-000000000001",
            "Charger",
            "quantity",
            Some("1234567890123"),
            Some(5000),
        ),
        (
            "01920000-0000-7000-8000-000000000002",
            "Second Hand Phone",
            "serialized",
            None,
            None,
        ),
        (
            "01920000-0000-7000-8000-000000000003",
            "Archived Item",
            "quantity",
            None,
            None,
        ),
    ] {
        sqlx::query(
            "INSERT INTO products
               (id, name, disposition, barcode, sale_price_minor, status,
                created_by, updated_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6, 1000, 2000)",
        )
        .bind(id)
        .bind(name)
        .bind(disposition)
        .bind(barcode)
        .bind(price)
        .bind(MANAGER)
        .execute(&pool)
        .await
        .expect("seed a pre-rebuild product");
    }

    sqlx::query("UPDATE products SET status = 'archived' WHERE name = 'Archived Item'")
        .execute(&pool)
        .await
        .expect("archive one product");

    pool
}

/// Apply the rebuild, which is the step under test.
async fn apply_rebuild(pool: &SqlitePool) {
    sqlx::raw_sql(M5)
        .execute(pool)
        .await
        .expect("apply the products rebuild");
}

/// A database at the `0004` state with the rebuild applied.
async fn rebuilt() -> SqlitePool {
    let pool = at_0004().await;
    apply_rebuild(&pool).await;
    pool
}

async fn one(pool: &SqlitePool, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("query failed: {sql}\n{e}"))
}

/// A department row, so a product can be classified.
async fn create_department(pool: &SqlitePool, name: &str) -> String {
    sqlx::query_scalar(
        "INSERT INTO departments (id, name, status, cost_method, vat_enabled,
                                 vat_inclusive, sort_order, created_by, updated_by,
                                 created_at, updated_at)
         VALUES (?1, ?2, 'active', 'moving_average', 0, 0, 0, ?3, ?3, 1000, 1000)
         RETURNING id",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(name)
    .bind(MANAGER)
    .fetch_one(pool)
    .await
    .expect("create a department")
}

// ---------------------------------------------------------------------------
// The migration set
// ---------------------------------------------------------------------------

#[tokio::test]
async fn all_migrations_apply_in_order_on_a_fresh_database() {
    let pool = db::open_in_memory().await.expect("in-memory database");

    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .expect("migration ledger");

    assert_eq!(
        versions,
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
        "every migration must be recorded in order, with 0023 (shifts and expenses) last"
    );


}

#[tokio::test]
async fn the_rebuild_applies_inside_the_normal_ddl_transaction() {
    let pool = at_0004().await;
    // A pool that keeps `foreign_keys` on, exactly as the application does.
    let foreign_keys: i64 = one(&pool, "PRAGMA foreign_keys").await;
    assert_eq!(foreign_keys, 1, "foreign keys must be enforced");

    apply_rebuild(&pool).await;

    // Had the rebuild silently disabled them, a dangling reference would now be
    // accepted. It is not.
    let orphan = sqlx::query(
        "INSERT INTO products
           (id, name, disposition, department_id, status,
            created_by, updated_by, created_at, updated_at)
         VALUES (?1, 'Orphan', 'quantity', 'no-such-department', 'active',
                 ?2, ?2, 1000, 1000)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(MANAGER)
    .execute(&pool)
    .await;

    assert!(
        orphan.is_err(),
        "foreign keys must still be enforced after the rebuild, so the migration \
         cannot have relied on turning them off"
    );
}

// ---------------------------------------------------------------------------
// Data preservation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn every_pre_rebuild_product_row_survives_the_rebuild() {
    let pool = rebuilt().await;

    let count = one(&pool, "SELECT COUNT(*) FROM products").await;
    assert_eq!(
        count, 3,
        "no product may be lost or duplicated by the rebuild"
    );

    let distinct_ids =
        one(&pool, "SELECT COUNT(DISTINCT id) FROM products").await;
    assert_eq!(distinct_ids, 3, "and no id may be reused");
}

#[tokio::test]
async fn pre_rebuild_identifiers_names_dispositions_and_timestamps_are_unchanged() {
    let pool = rebuilt().await;

    let rows: Vec<(String, String, String, Option<String>, Option<i64>, String, String, i64, i64)> =
        sqlx::query_as(
            "SELECT id, name, disposition, barcode, sale_price_minor, status,
                    created_by, created_at, updated_at
             FROM products ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .expect("read the rebuilt products");

    assert_eq!(rows.len(), 3);

    let archived = &rows[0];
    assert_eq!(archived.1, "Archived Item");
    assert_eq!(archived.5, "archived", "archive state preserved");
    assert_eq!(archived.3, None, "no barcode stays NULL, not an empty string");
    assert_eq!(archived.4, None, "an unset price stays NULL, not zero");
    assert_eq!(archived.6, MANAGER, "attribution preserved");
    assert_eq!(archived.7, 1000, "created_at preserved");
    assert_eq!(archived.8, 2000, "updated_at preserved");

    let charger = &rows[1];
    assert_eq!(charger.0, "01920000-0000-7000-8000-000000000001");
    assert_eq!(charger.1, "Charger");
    assert_eq!(charger.2, "quantity", "the pre-existing disposition is unchanged");
    assert_eq!(charger.3.as_deref(), Some("1234567890123"), "barcode preserved");
    assert_eq!(charger.4, Some(5000), "sale price preserved");
    assert_eq!(charger.5, "active");

    let phone = &rows[2];
    assert_eq!(phone.0, "01920000-0000-7000-8000-000000000002");
    assert_eq!(phone.2, "serialized", "the pre-existing disposition is unchanged");

    for row in &rows {
        assert_eq!(row.0.len(), 36, "every id is still a UUID");
    }
}

#[tokio::test]
async fn no_pre_rebuild_product_is_given_an_invented_department_cost_or_vat_rate() {
    let pool = at_0004().await;
    // One department exists before the rebuild, so the assertion below cannot pass
    // merely because the table was empty.
    create_department(&pool, "Phones").await;
    apply_rebuild(&pool).await;

    assert_eq!(
        one(
            &pool,
            "SELECT COUNT(*) FROM products WHERE department_id IS NOT NULL"
        )
        .await,
        0,
        "no product may be given a made-up department, even when one exists"
    );
    assert_eq!(
        one(
            &pool,
            "SELECT COUNT(*) FROM products WHERE default_cost_minor IS NOT NULL"
        )
        .await,
        0,
        "no product may be given an invented cost"
    );
    assert_eq!(
        one(
            &pool,
            "SELECT COUNT(*) FROM products WHERE vat_rate_bp IS NOT NULL"
        )
        .await,
        0,
        "no product may be given an invented VAT rate"
    );
}

#[tokio::test]
async fn the_rebuild_creates_no_placeholder_department_of_its_own() {
    let pool = at_0004().await;
    apply_rebuild(&pool).await;

    assert_eq!(
        one(&pool, "SELECT COUNT(*) FROM departments").await,
        0,
        "the rebuild must not fabricate a \"General\" department"
    );
}

// ---------------------------------------------------------------------------
// The new schema
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_rebuilt_products_table_carries_the_three_new_nullable_columns() {
    let pool = rebuilt().await;

    let columns: Vec<(String, i64)> =
        sqlx::query_as("SELECT name, \"notnull\" FROM pragma_table_info('products')")
            .fetch_all(&pool)
            .await
            .expect("column list");

    let named: Vec<&str> = columns.iter().map(|(name, _)| name.as_str()).collect();

    for added in ["department_id", "default_cost_minor", "vat_rate_bp"] {
        assert!(
            named.contains(&added),
            "`{added}` must exist after the rebuild; found {named:?}"
        );
        let is_not_null = columns
            .iter()
            .find(|(name, _)| name == added)
            .map(|(_, flag)| *flag == 1)
            .expect("column exists");
        assert!(
            !is_not_null,
            "`{added}` must stay nullable so a pre-existing product remains valid \
             without invented data"
        );
    }

    for original in [
        "id",
        "name",
        "disposition",
        "barcode",
        "sale_price_minor",
        "status",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at",
    ] {
        assert!(
            named.contains(&original),
            "`{original}` must survive the rebuild; found {named:?}"
        );
    }
}

#[tokio::test]
async fn department_id_references_departments_with_restrict() {
    let pool = rebuilt().await;

    let foreign_keys: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT \"table\", \"from\", on_delete FROM pragma_foreign_key_list('products')",
    )
    .fetch_all(&pool)
    .await
    .expect("foreign key list");

    let department_fk = foreign_keys
        .iter()
        .find(|(table, from, _)| table == "departments" && from == "department_id")
        .expect("`department_id` must reference `departments`");

    assert_eq!(
        department_fk.2, "RESTRICT",
        "a product's classification must not be lost by deleting a department, and \
         departments are archived rather than deleted"
    );

    // The attribution foreign keys must still be there too, pointing outward.
    for column in ["created_by", "updated_by"] {
        assert!(
            foreign_keys
                .iter()
                .any(|(_, from, on_delete)| from == column && on_delete == "RESTRICT"),
            "`{column}` must keep its ON DELETE RESTRICT reference to users"
        );
    }
}

#[tokio::test]
async fn a_product_can_be_classified_and_a_bogus_department_is_refused() {
    let pool = rebuilt().await;
    let phones = create_department(&pool, "Phones").await;

    sqlx::query("UPDATE products SET department_id = ?2 WHERE name = 'Charger'")
        .bind(&phones)
        .execute(&pool)
        .await
        .expect("classify a product");

    assert!(
        sqlx::query("UPDATE products SET department_id = 'no-such-department'")
            .execute(&pool)
            .await
            .is_err(),
        "a product may not be classified into a department that does not exist"
    );
}

#[tokio::test]
async fn all_three_dispositions_are_accepted_and_a_fourth_is_not() {
    let pool = rebuilt().await;

    for disposition in ["quantity", "serialized", "one_off"] {
        sqlx::query(
            "INSERT INTO products
               (id, name, disposition, status, created_by, updated_by,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, 'active', ?4, ?4, 1000, 1000)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(format!("Product {disposition}"))
        .bind(disposition)
        .bind(MANAGER)
        .execute(&pool)
        .await
        .unwrap_or_else(|e| panic!("`{disposition}` must be accepted: {e}"));
    }

    let rejected = sqlx::query(
        "INSERT INTO products
           (id, name, disposition, status, created_by, updated_by,
            created_at, updated_at)
         VALUES (?1, 'Bogus', 'consignment', 'active', ?2, ?2, 1000, 1000)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(MANAGER)
    .execute(&pool)
    .await;

    assert!(
        rejected.is_err(),
        "the disposition domain is exactly three values"
    );
}

#[tokio::test]
async fn the_rebuilt_table_still_enforces_its_barcode_uniqueness() {
    let pool = rebuilt().await;

    // `barcode TEXT UNIQUE` was declared inline in `0002`, so it lived in the table
    // definition rather than in a named index. Dropping the table drops it, which
    // is exactly why the rebuild has to redeclare it.
    let clash = sqlx::query(
        "INSERT INTO products
           (id, name, disposition, barcode, status, created_by, updated_by,
            created_at, updated_at)
         VALUES (?1, 'Clashing Barcode', 'quantity', '1234567890123', 'active',
                 ?2, ?2, 1000, 1000)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(MANAGER)
    .execute(&pool)
    .await;

    assert!(
        clash.is_err(),
        "the inline UNIQUE on `barcode` must survive the rebuild"
    );

    // And many products may still have no barcode at all.
    assert_eq!(
        one(
            &pool,
            "SELECT COUNT(*) FROM products WHERE barcode IS NULL"
        )
        .await,
        2,
        "the UNIQUE must permit any number of NULLs, which is what makes the column optional"
    );
}

#[tokio::test]
async fn the_rebuilt_table_refuses_a_deletion_of_a_referenced_user() {
    let pool = rebuilt().await;

    sqlx::query("DELETE FROM users WHERE id = ?1")
        .bind(MANAGER)
        .execute(&pool)
        .await
        .expect_err("ON DELETE RESTRICT must still refuse removing a referenced user");
}

#[tokio::test]
async fn money_columns_are_integers_and_the_table_has_no_floating_point_column() {
    let pool = rebuilt().await;

    let types: Vec<(String, String)> =
        sqlx::query_as("SELECT name, type FROM pragma_table_info('products')")
            .fetch_all(&pool)
            .await
            .expect("column types");

    for column in ["sale_price_minor", "default_cost_minor", "vat_rate_bp"] {
        let declared = types
            .iter()
            .find(|(name, _)| name == column)
            .map(|(_, kind)| kind.as_str())
            .unwrap_or_else(|| panic!("`{column}` must exist"));
        assert_eq!(
            declared.to_ascii_uppercase(),
            "INTEGER",
            "`{column}` must be an INTEGER count of minor units / basis points"
        );
    }

    for (name, kind) in &types {
        let upper = kind.to_ascii_uppercase();
        assert!(
            !matches!(
                upper.as_str(),
                "REAL" | "FLOAT" | "NUMERIC" | "DECIMAL" | "DOUBLE"
            ),
            "`{name}` is declared `{kind}`; the products schema must contain no \
             floating-point column (spec:56, ADR-010)"
        );
    }
}

#[tokio::test]
async fn the_products_indexes_are_recreated_after_the_rebuild() {
    let pool = rebuilt().await;

    let indexes: Vec<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'index'")
            .fetch_all(&pool)
            .await
            .expect("index list");

    for expected in [
        "idx_products_status",
        "idx_products_disposition",
        "idx_products_department",
        "idx_products_created_by",
    ] {
        assert!(
            indexes.iter().any(|name| name == expected),
            "`{expected}` must be recreated by the rebuild; found {indexes:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// The repository reads and writes the new columns
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_repository_reads_the_new_columns_after_the_rebuild() {
    use mobile_shop_system_lib::data::repositories::catalog::product as product_repo;
    use mobile_shop_system_lib::domain::catalog::{Disposition, ProductId};

    let pool = at_0004().await;
    apply_rebuild(&pool).await;

    let id: String = sqlx::query_scalar("SELECT id FROM products WHERE name = 'Charger'")
        .fetch_one(&pool)
        .await
        .expect("the seeded product survives");
    let product_id = ProductId::from_uuid(id.parse().expect("uuid"));

    let mut conn = pool.acquire().await.expect("connection");
    let loaded = product_repo::find_by_id(&mut conn, product_id)
        .await
        .expect("read")
        .expect("the product exists");

    assert_eq!(loaded.name.as_str(), "Charger");
    assert_eq!(loaded.disposition, Disposition::Quantity);
    assert_eq!(loaded.sale_price.map(|p| p.as_minor()), Some(5000));
    assert_eq!(loaded.barcode.as_ref().map(|b| b.as_str()), Some("1234567890123"));
    assert_eq!(
        (loaded.department, loaded.default_cost, loaded.vat_rate_bp),
        (None, None, None),
        "the rebuild left the three new columns NULL, and the repository must \
         report them as absent rather than as zeros"
    );
    drop(conn);
}

#[tokio::test]
async fn the_repository_writes_and_reloads_the_new_columns() {
    use mobile_shop_system_lib::data::repositories::catalog::product as product_repo;
    use mobile_shop_system_lib::domain::catalog::Disposition;

    let pool = at_0004().await;
    apply_rebuild(&pool).await;
    let phones = create_department(&pool, "Phones").await;

    let new_id = mobile_shop_system_lib::domain::catalog::ProductId::from_uuid(uuid::Uuid::now_v7());
    let actor = UserId::from_uuid(MANAGER.parse().expect("uuid"));

    let product = Product {
        id: new_id,
        name: ProductName::new("New Phone").expect("valid"),
        disposition: Disposition::OneOff,
        barcode: None,
        sale_price: None,
        department: Some(DepartmentId::from_uuid(phones.parse().expect("uuid"))),
        // Zero is a real cost, not an absent one: the same distinction the sale
        // price makes between "not set" and "free".
        default_cost: Some(Piastres::new_minor(0).expect("valid")),
        vat_rate_bp: Some(1450),
        status: ProductStatus::Active,
        created_by: actor,
        updated_by: actor,
        created_at: 5000,
        updated_at: 5000,
    };

    let mut conn = pool.acquire().await.expect("connection");
    product_repo::insert(&mut conn, &product)
        .await
        .expect("insert a product carrying the new columns");

    let reloaded = product_repo::find_by_id(&mut conn, new_id)
        .await
        .expect("read")
        .expect("the product exists");

    assert_eq!(reloaded.disposition, Disposition::OneOff);
    assert_eq!(reloaded.department.map(|d| d.as_str()).as_deref(), Some(phones.as_str()));
    assert_eq!(reloaded.default_cost.map(|c| c.as_minor()), Some(0));
    assert_eq!(reloaded.vat_rate_bp, Some(1450));

    // And an update round-trips them.
    let mut edited = reloaded;
    edited
        .update(
            ProductName::new("Used Phone").expect("valid"),
            Disposition::Serialized,
            None,
            None,
            None,
            Some(Piastres::new_minor(45000).expect("valid")),
            None,
            actor,
            9000,
        )
        .expect("edit");
    product_repo::update(&mut conn, &edited)
        .await
        .expect("persist the edit");

    let after = product_repo::find_by_id(&mut conn, new_id)
        .await
        .expect("read")
        .expect("the product still exists");

    assert_eq!(after.disposition, Disposition::Serialized);
    assert_eq!(after.name.as_str(), "Used Phone");
    assert_eq!(after.department, None, "None clears the classification");
    assert_eq!(after.default_cost.map(|c| c.as_minor()), Some(45000));
    assert_eq!(after.vat_rate_bp, None, "None clears the rate");
    assert_eq!(after.created_at, 5000, "creation is unchanged by an edit");
}