//! Product variants (ADR-018 §4, plan item 1.2 step 4), against real SQLite.
//!
//! The claims under test:
//!
//! * a variant parent and all of its combination products are created together
//!   in one transaction, with full names, per-row barcode and price overrides,
//!   and one `variants_created` audit event;
//! * both two-dimensional («الموبايل» × «اللون») and one-dimensional («القوة»)
//!   parents work, and `pos::read` carries the parent and variant details for
//!   each sellable product while receiving and sales work on the variant row;
//! * duplicate parent names in the same category, phone categories, unknown
//!   dimensions, >60 combinations, duplicate barcodes, and seller calls are
//!   refused without leaving partial rows behind;
//! * the storage triggers in `0018` refuse half a variant whatever the code
//!   above them does.

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::data::repositories::catalog::variant as variant_repo;
use mobile_shop_system_lib::domain::catalog::{VariantDimension, DEFAULT_BRANDS};
use mobile_shop_system_lib::domain::identity::{Role, Sensitivity};
use mobile_shop_system_lib::domain::organisation::{DepartmentId, DEFAULT_CATEGORIES};
use mobile_shop_system_lib::services::catalog::brands;
use mobile_shop_system_lib::services::catalog::pos;
use mobile_shop_system_lib::services::catalog::variants::{
    self, NewVariantRow, NewVariants, RegisteredVariants,
};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, users};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::organisation::categories;
use mobile_shop_system_lib::services::sales::{self, SaleLineInput};
use sqlx::SqlitePool;

struct Shop {
    pool: SqlitePool,
    tokens: Arc<InMemoryTokenStore>,
}

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
    categories::add_default_categories(&pool)
        .await
        .expect("categories");
    brands::add_default_brands(&pool).await.expect("brands");
    Shop { pool, tokens }
}

fn category(name: &str) -> DepartmentId {
    DEFAULT_CATEGORIES
        .iter()
        .find(|c| c.name == name)
        .map(|c| c.department_id())
        .expect("a default category")
}

async fn register(shop: &Shop, input: NewVariants) -> Result<RegisteredVariants, &'static str> {
    variants::create_variants(&shop.pool, shop.tokens.as_ref(), input)
        .await
        .map_err(|e| e.code())
}

#[tokio::test]
async fn a_two_dimensional_variant_family_creates_the_parent_all_combinations_and_one_audit_row() {
    let shop = shop().await;
    let made = register(
        &shop,
        NewVariants {
            category: category("جرابات"),
            name: "  جراب   سيليكون ملون ".to_string(),
            dimension_1: "الموبايل".to_string(),
            values_1: vec!["Galaxy A16".to_string(), "iPhone 16".to_string()],
            dimension_2: Some("اللون".to_string()),
            values_2: vec!["أسود".to_string(), "بينك".to_string()],
            sale_price_minor: 7500,
            rows: vec![
                NewVariantRow {
                    barcode: Some("2000000000015".to_string()),
                    sale_price_minor: None,
                },
                NewVariantRow {
                    barcode: None,
                    sale_price_minor: None,
                },
                NewVariantRow {
                    barcode: Some("2000000000022".to_string()),
                    sale_price_minor: Some(9000),
                },
                NewVariantRow {
                    barcode: None,
                    sale_price_minor: Some(9000),
                },
            ],
        },
    )
    .await
    .expect("registered");

    assert_eq!(made.parent.name.as_str(), "جراب سيليكون ملون");
    assert_eq!(made.parent.dimension_1, VariantDimension::Phone);
    assert_eq!(made.parent.dimension_2, Some(VariantDimension::Color));
    assert_eq!(made.variants.len(), 4);

    let names: Vec<&str> = made
        .variants
        .iter()
        .map(|(p, _)| p.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec![
            "جراب سيليكون ملون Galaxy A16 أسود",
            "جراب سيليكون ملون Galaxy A16 بينك",
            "جراب سيليكون ملون iPhone 16 أسود",
            "جراب سيليكون ملون iPhone 16 بينك",
        ]
    );

    let prices: Vec<Option<i64>> = made
        .variants
        .iter()
        .map(|(p, _)| p.sale_price.map(|s| s.as_minor()))
        .collect();
    assert_eq!(prices, vec![Some(7500), Some(7500), Some(9000), Some(9000)]);

    let orders: Vec<i64> = made.variants.iter().map(|(_, d)| d.order).collect();
    assert_eq!(orders, vec![0, 1, 2, 3]);

    let mut conn = shop.pool.acquire().await.expect("conn");
    let loaded = variant_repo::find_parent_by_id(&mut conn, made.parent.id)
        .await
        .expect("query")
        .expect("parent stored");
    assert_eq!(loaded, made.parent);
    drop(conn);

    let audit_rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = 'variants_created' AND detail LIKE '%\"variants\":4%'",
    )
    .fetch_one(&shop.pool)
    .await
    .expect("audit");
    assert_eq!(audit_rows, 1);
}

#[tokio::test]
async fn a_one_dimensional_variant_family_works_and_pos_reads_and_sells_its_variants() {
    let shop = shop().await;
    let made = register(
        &shop,
        NewVariants {
            category: category("شواحن"),
            name: "شاحن أنكر سريع".to_string(),
            dimension_1: "القوة".to_string(),
            values_1: vec!["20W".to_string(), "33W".to_string(), "65W".to_string()],
            // Even if the UI sends a second dimension label while its values
            // are empty, the parent is stored as one-dimensional.
            dimension_2: Some("اللون".to_string()),
            values_2: Vec::new(),
            sale_price_minor: 35000,
            rows: Vec::new(),
        },
    )
    .await
    .expect("1D variants");

    assert_eq!(made.parent.dimension_1, VariantDimension::Power);
    assert_eq!(made.parent.dimension_2, None);
    assert_eq!(made.variants.len(), 3);
    assert!(made.variants.iter().all(|(_, d)| d.value_2.is_none()));

    let first_id = made.variants[0].0.id.as_str();
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &first_id,
        5,
        22000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive stock for 20W variant");

    sales::record_sale(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineInput {
            product_id: first_id.clone(),
            quantity: 2,
            warranty_start: None,
            warranty_end: None,
        }],
        None,
    )
    .await
    .expect("sell two 20W chargers");

    let read = pos::read(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("pos catalog");
    let family: Vec<_> = read
        .products
        .iter()
        .filter(|p| p.parent_id.as_deref() == Some(&made.parent.id.as_str()))
        .collect();
    assert_eq!(family.len(), 3);

    let w20 = family
        .iter()
        .find(|p| p.variant_1.as_deref() == Some("20W"))
        .expect("20W row");
    assert_eq!(w20.parent_name.as_deref(), Some("شاحن أنكر سريع"));
    assert_eq!(w20.dimension_1.as_deref(), Some("القوة"));
    assert_eq!(w20.dimension_2, None);
    assert_eq!(w20.variant_2, None);
    assert_eq!(w20.variant_order, Some(0));
    assert_eq!(w20.on_hand, 3);
    assert_eq!(w20.sold_recently, 2);
}

#[tokio::test]
async fn duplicate_parent_names_and_invalid_inputs_roll_back_cleanly() {
    let shop = shop().await;
    let base = NewVariants {
        category: category("جرابات"),
        name: "Case Pro".to_string(),
        dimension_1: "الموبايل".to_string(),
        values_1: vec!["Galaxy A16".to_string()],
        dimension_2: None,
        values_2: Vec::new(),
        sale_price_minor: 5000,
        rows: Vec::new(),
    };
    register(&shop, base.clone()).await.expect("first");

    let mut same_name = base.clone();
    same_name.name = "case pro".to_string();
    assert_eq!(
        register(&shop, same_name).await.err(),
        Some("VARIANT_PARENT_ALREADY_EXISTS"),
        "same category and name (case-insensitive) is refused"
    );

    let mut other_category = base.clone();
    other_category.category = category("اسكرينات");
    register(&shop, other_category)
        .await
        .expect("another category may use the same base name");

    let mut phone_cat = base.clone();
    phone_cat.name = "جراب جديد".to_string();
    phone_cat.category = category("موبايلات جديدة");
    assert_eq!(
        register(&shop, phone_cat).await.err(),
        Some("VARIANT_CATEGORY_NOT_ITEM")
    );

    let mut missing_cat = base.clone();
    missing_cat.name = "جراب جديد".to_string();
    missing_cat.category = DepartmentId::generate();
    assert_eq!(
        register(&shop, missing_cat).await.err(),
        Some("PRODUCT_CATEGORY_NOT_FOUND")
    );

    let mut bad_dim = base.clone();
    bad_dim.name = "جراب جديد".to_string();
    bad_dim.dimension_1 = "الماركة".to_string();
    assert_eq!(
        register(&shop, bad_dim).await.err(),
        Some("VARIANT_DIMENSION_UNKNOWN")
    );

    let mut zero_price = base.clone();
    zero_price.name = "جراب جديد".to_string();
    zero_price.sale_price_minor = 0;
    assert_eq!(
        register(&shop, zero_price).await.err(),
        Some("VARIANT_PRICE_REQUIRED")
    );

    let mut dup_barcode = base.clone();
    dup_barcode.name = "جراب جديد".to_string();
    dup_barcode.values_1 = vec!["A16".to_string(), "A26".to_string()];
    dup_barcode.rows = vec![
        NewVariantRow {
            barcode: Some("2000000000015".to_string()),
            sale_price_minor: None,
        },
        NewVariantRow {
            barcode: Some("2000000000015".to_string()),
            sale_price_minor: None,
        },
    ];
    assert_eq!(
        register(&shop, dup_barcode).await.err(),
        Some("VARIANT_BARCODE_DUPLICATE")
    );

    let mut too_many = base.clone();
    too_many.name = "جراب كتير".to_string();
    too_many.values_1 = (1..=61).map(|i| format!("M{i}")).collect();
    assert_eq!(
        register(&shop, too_many).await.err(),
        Some("VARIANT_LIMIT_EXCEEDED")
    );

    // Only the two valid registrations (1 product each) are in the database.
    let parents: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM product_parents")
        .fetch_one(&shop.pool)
        .await
        .expect("parents");
    let products: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products")
        .fetch_one(&shop.pool)
        .await
        .expect("products");
    assert_eq!(parents, 2);
    assert_eq!(products, 2);

    // A seller is refused before any write.
    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("reauth");
    let owner = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("owner");
    let seller = users::create_user(&shop.pool, &owner, "Marina", "marina", Role::Sales, PASSWORD)
        .await
        .expect("seller");
    auth::login(&shop.pool, shop.tokens.as_ref(), seller, PASSWORD)
        .await
        .expect("seller login");
    let mut by_seller = base;
    by_seller.name = "جراب البائع".to_string();
    assert_eq!(
        register(&shop, by_seller).await.err(),
        Some("PERMISSION_DENIED")
    );
}

#[tokio::test]
async fn the_storage_refuses_half_a_variant_and_protects_parents_with_products() {
    let shop = shop().await;
    let made = register(
        &shop,
        NewVariants {
            category: category("جرابات"),
            name: "جراب ضد الصدمات".to_string(),
            dimension_1: "الموبايل".to_string(),
            values_1: vec!["Galaxy A16".to_string(), "Galaxy A26".to_string()],
            dimension_2: Some("اللون".to_string()),
            values_2: vec!["أسود".to_string()],
            sale_price_minor: 8500,
            rows: Vec::new(),
        },
    )
    .await
    .expect("2D variants");

    let first_id = made.variants[0].0.id.as_str();
    let second_id = made.variants[1].0.id.as_str();

    // Missing `variant_1` while `parent_id` is set.
    assert!(
        sqlx::query("UPDATE products SET variant_1 = NULL WHERE id = ?1")
            .bind(&first_id)
            .execute(&shop.pool)
            .await
            .is_err(),
        "a variant must keep variant_1"
    );

    // Missing `variant_2` on a 2D parent.
    assert!(
        sqlx::query("UPDATE products SET variant_2 = NULL WHERE id = ?1")
            .bind(&first_id)
            .execute(&shop.pool)
            .await
            .is_err(),
        "a 2D parent requires variant_2 on its products"
    );

    // Duplicate (variant_1, variant_2) under the same parent (case-insensitive).
    assert!(
        sqlx::query("UPDATE products SET variant_1 = 'galaxy a16' WHERE id = ?1")
            .bind(&second_id)
            .execute(&shop.pool)
            .await
            .is_err(),
        "two variants of the same parent cannot share the same values"
    );

    // A variant cannot also be a phone (`brand_id IS NOT NULL`).
    let samsung = DEFAULT_BRANDS[0].id;
    assert!(
        sqlx::query(
            "UPDATE products SET brand_id = ?2, model = 'A16', device_type = 'touch', storage_gb = 128 WHERE id = ?1",
        )
        .bind(&first_id)
        .bind(samsung)
        .execute(&shop.pool)
        .await
        .is_err(),
        "a variant product cannot carry phone details"
    );

    // Deleting a parent that still has variant products is refused (`ON DELETE RESTRICT`).
    assert!(
        sqlx::query("DELETE FROM product_parents WHERE id = ?1")
            .bind(made.parent.id.as_str())
            .execute(&shop.pool)
            .await
            .is_err(),
        "product_parents with products cannot be deleted"
    );

    // Clearing all four variant columns turns the row back into a standalone product.
    assert!(
        sqlx::query(
            "UPDATE products SET parent_id = NULL, variant_1 = NULL, variant_2 = NULL, variant_order = NULL WHERE id = ?1",
        )
        .bind(&first_id)
        .execute(&shop.pool)
        .await
        .is_ok(),
        "clearing all four variant columns is valid"
    );
}
