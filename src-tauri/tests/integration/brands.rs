//! Phone brands and registering a new phone (ADR-018 §2, plan item 1.2), against
//! real SQLite.
//!
//! The claims under test:
//!
//! * the default companies are added once, attributed to the owner and audited
//!   once; nothing is added before there is a manager;
//! * the owner adds, renames, sets touch/keypad/both, hides, moves and deletes
//!   a company he added and that has no phone; a default is never deleted;
//! * a seller can do none of it, but reads the companies with the sales
//!   catalogue;
//! * a phone is registered with its name built from its details, in a phone
//!   category, from a company that makes its kind; the same phone twice is
//!   refused; a keypad phone has no storage or RAM;
//! * the storage refuses half a phone whatever the code above it does.

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::domain::catalog::{BrandDeviceType, BrandId, DeviceType, DEFAULT_BRANDS};
use mobile_shop_system_lib::domain::identity::{Role, UserId};
use mobile_shop_system_lib::domain::organisation::{DepartmentId, DEFAULT_CATEGORIES};
use mobile_shop_system_lib::services::catalog::brands::{self, BrandStep};
use mobile_shop_system_lib::services::catalog::phone::{self, NewPhone};
use mobile_shop_system_lib::services::catalog::pos;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, users};
use mobile_shop_system_lib::services::organisation::categories;
use sqlx::SqlitePool;

struct Shop {
    pool: SqlitePool,
    tokens: Arc<InMemoryTokenStore>,
    owner: UserId,
}

/// A fresh shop as setup leaves it: the owner signed in, the default
/// categories and companies added.
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
    categories::add_default_categories(&pool).await.expect("categories");
    assert_eq!(brands::add_default_brands(&pool).await.expect("brands"), 12);
    Shop {
        pool,
        tokens,
        owner: created.user_id,
    }
}

fn brand(name: &str) -> BrandId {
    DEFAULT_BRANDS
        .iter()
        .find(|b| b.name == name)
        .map(|b| b.brand_id())
        .expect("a default company")
}

fn category(name: &str) -> DepartmentId {
    DEFAULT_CATEGORIES
        .iter()
        .find(|c| c.name == name)
        .map(|c| c.department_id())
        .expect("a default category")
}

fn new_phone(brand_id: BrandId, model: &str, device: DeviceType, storage: Option<i64>, ram: Option<i64>) -> NewPhone {
    NewPhone {
        category: category("موبايلات جديدة"),
        brand: brand_id,
        model: model.to_string(),
        device_type: device,
        storage_gb: storage,
        ram_gb: ram,
        sale_price_minor: Some(925_000),
    }
}

async fn register(shop: &Shop, input: NewPhone) -> Result<String, &'static str> {
    phone::create_phone(&shop.pool, shop.tokens.as_ref(), input)
        .await
        .map(|registered| registered.product.name.as_str().to_string())
        .map_err(|error| error.code())
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

async fn names(shop: &Shop) -> Vec<String> {
    brands::list(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("list")
        .into_iter()
        .map(|entry| entry.brand.name.as_str().to_string())
        .collect()
}

#[tokio::test]
async fn the_default_companies_are_added_once_and_audited_once() {
    let shop = shop().await;
    assert_eq!(
        names(&shop).await,
        vec!["Samsung", "Apple", "Xiaomi", "OPPO", "realme", "Honor", "Infinix", "Tecno", "vivo", "Huawei", "Nokia", "itel"]
    );
    let owned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM brands WHERE created_by = ?1")
        .bind(shop.owner.as_str())
        .fetch_one(&shop.pool)
        .await
        .expect("attribution");
    assert_eq!(owned, 12);
    assert_eq!(brands::add_default_brands(&shop.pool).await.expect("again"), 0);
    assert_eq!(audit_count(&shop, "default_brands_added", r#"{"count":12}"#).await, 1);

    let pool = mobile_shop_system_lib::data::db::open_in_memory()
        .await
        .expect("a fresh device");
    assert_eq!(brands::add_default_brands(&pool).await.expect("no manager yet"), 0);
}

#[tokio::test]
async fn the_owner_manages_the_companies_and_a_default_is_never_deleted() {
    let shop = shop().await;
    let tokens = shop.tokens.as_ref();
    let motorola = brands::create(&shop.pool, tokens, "Motorola", BrandDeviceType::Touch)
        .await
        .expect("a company");
    assert_eq!(motorola.sort_order, 130, "at the end");
    assert_eq!(
        brands::create(&shop.pool, tokens, "motorola", BrandDeviceType::Both).await.err().map(|e| e.code()),
        Some("BRAND_NAME_TAKEN")
    );
    assert_eq!(
        brands::create(&shop.pool, tokens, "  ", BrandDeviceType::Both).await.err().map(|e| e.code()),
        Some("BRAND_NAME_REQUIRED")
    );

    brands::rename(&shop.pool, tokens, brand("Samsung"), "Samsung").await.expect("the same name");
    assert_eq!(audit_count(&shop, "brand_updated", "%renamed_from%").await, 0);
    assert_eq!(
        brands::rename(&shop.pool, tokens, brand("Samsung"), "oppo").await.err().map(|e| e.code()),
        Some("BRAND_NAME_TAKEN")
    );
    brands::rename(&shop.pool, tokens, brand("Honor"), "HONOR").await.expect("a default may be renamed");
    assert_eq!(audit_count(&shop, "brand_updated", r#"%"renamed_from":"Honor"%"#).await, 1);

    let typed = brands::set_device_type(&shop.pool, tokens, motorola.id, BrandDeviceType::Both)
        .await
        .expect("both");
    assert_eq!(typed.device_type, BrandDeviceType::Both);
    brands::set_hidden(&shop.pool, tokens, brand("vivo"), true).await.expect("hide");
    brands::set_hidden(&shop.pool, tokens, brand("vivo"), true).await.expect("again: nothing");
    assert_eq!(audit_count(&shop, "brand_updated", r#"%"hidden":true%"#).await, 1);

    brands::move_brand(&shop.pool, tokens, motorola.id, BrandStep::Up).await.expect("up");
    let order = names(&shop).await;
    assert_eq!(&order[order.len() - 2..], &["Motorola".to_string(), "itel".to_string()]);
    brands::move_brand(&shop.pool, tokens, brand("Samsung"), BrandStep::Up)
        .await
        .expect("already first: nothing");
    assert_eq!(names(&shop).await[0], "Samsung");

    assert_eq!(
        brands::delete(&shop.pool, tokens, brand("itel")).await.err().map(|e| e.code()),
        Some("BRAND_IS_DEFAULT")
    );
    brands::delete(&shop.pool, tokens, motorola.id).await.expect("empty, and his own");
    assert_eq!(audit_count(&shop, "brand_deleted", r#"%"name":"Motorola"%"#).await, 1);
    assert_eq!(names(&shop).await.len(), 12);
}

#[tokio::test]
async fn a_company_with_a_phone_is_not_deleted() {
    let shop = shop().await;
    let tokens = shop.tokens.as_ref();
    let lava = brands::create(&shop.pool, tokens, "Lava", BrandDeviceType::Keypad)
        .await
        .expect("a company");
    register(&shop, new_phone(lava.id, "A1", DeviceType::Keypad, None, None))
        .await
        .expect("a phone");
    assert_eq!(
        brands::delete(&shop.pool, tokens, lava.id).await.err().map(|e| e.code()),
        Some("BRAND_NOT_EMPTY")
    );
    let entries = brands::list(&shop.pool, tokens).await.expect("list");
    let entry = entries.iter().find(|e| e.brand.id == lava.id).expect("listed");
    assert_eq!(entry.products, 1);
    assert!(!entry.deletable && !entry.is_default);
}

#[tokio::test]
async fn a_seller_manages_no_company_but_reads_them_with_the_sales_catalogue() {
    let shop = shop().await;
    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("re-authenticate");
    let owner = session::resolve(&shop.pool, shop.tokens.as_ref()).await.expect("owner");
    let seller = users::create_user(&shop.pool, &owner, "Youssef", "youssef", Role::Sales, PASSWORD)
        .await
        .expect("a seller");
    auth::login(&shop.pool, shop.tokens.as_ref(), seller, PASSWORD)
        .await
        .expect("the seller signs in");
    let tokens = shop.tokens.as_ref();
    assert_eq!(brands::list(&shop.pool, tokens).await.err().map(|e| e.code()), Some("PERMISSION_DENIED"));
    assert_eq!(
        brands::create(&shop.pool, tokens, "X", BrandDeviceType::Touch).await.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );
    assert_eq!(
        brands::delete(&shop.pool, tokens, brand("itel")).await.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );
    assert_eq!(
        register(&shop, new_phone(brand("Samsung"), "Galaxy A16", DeviceType::Touch, Some(128), None)).await,
        Err("PERMISSION_DENIED")
    );
    let read = pos::read(&shop.pool, tokens).await.expect("the sales catalogue");
    assert_eq!(read.brands.len(), 12);
    let samsung = read.brands.iter().find(|b| b.name == "Samsung").expect("Samsung");
    assert!(samsung.aliases.contains("سامسونج"), "search finds it in Arabic");
}

#[tokio::test]
async fn a_phone_is_registered_with_its_name_built_from_its_details() {
    let shop = shop().await;
    let name = register(&shop, new_phone(brand("Samsung"), "  Galaxy   A16 ", DeviceType::Touch, Some(128), Some(6)))
        .await
        .expect("registered");
    assert_eq!(name, "Samsung Galaxy A16 128GB");
    let stored: (String, String, String, Option<i64>, Option<i64>, Option<String>, String, Option<i64>) = sqlx::query_as(
        "SELECT brand_id, model, device_type, storage_gb, ram_gb, department_id, disposition, sale_price_minor
           FROM products WHERE name = ?1",
    )
    .bind(&name)
    .fetch_one(&shop.pool)
    .await
    .expect("the product row");
    assert_eq!(
        stored,
        (
            brand("Samsung").as_str(),
            "Galaxy A16".to_string(),
            "touch".to_string(),
            Some(128),
            Some(6),
            Some(category("موبايلات جديدة").as_str()),
            "quantity".to_string(),
            Some(925_000),
        )
    );
    assert_eq!(
        register(&shop, new_phone(brand("Apple"), "iPhone 16", DeviceType::Touch, Some(1024), None)).await,
        Ok("iPhone 16 1TB".to_string()),
        "a line drops the company"
    );
    assert_eq!(
        register(&shop, new_phone(brand("Nokia"), "105", DeviceType::Keypad, None, None)).await,
        Ok("Nokia 105".to_string())
    );
}

#[tokio::test]
async fn the_same_phone_twice_is_refused_and_another_ram_is_another_phone() {
    let shop = shop().await;
    let samsung = brand("Samsung");
    register(&shop, new_phone(samsung, "Galaxy A26", DeviceType::Touch, Some(256), Some(8)))
        .await
        .expect("first");
    assert_eq!(
        register(&shop, new_phone(samsung, "galaxy a26", DeviceType::Touch, Some(256), Some(8))).await,
        Err("PHONE_ALREADY_REGISTERED"),
        "whatever the case"
    );
    register(&shop, new_phone(samsung, "Galaxy A26", DeviceType::Touch, Some(256), Some(6)))
        .await
        .expect("6GB of RAM is another phone");
    register(&shop, new_phone(samsung, "Galaxy A26", DeviceType::Touch, Some(128), Some(8)))
        .await
        .expect("128GB is another phone");
}

#[tokio::test]
async fn a_phone_goes_in_a_phone_category_from_a_company_that_makes_its_kind() {
    let shop = shop().await;
    let mut in_accessories = new_phone(brand("Samsung"), "Galaxy A16", DeviceType::Touch, Some(128), None);
    in_accessories.category = category("إكسسوارات");
    assert_eq!(register(&shop, in_accessories).await, Err("PHONE_CATEGORY_NOT_PHONE"));
    let mut nowhere = new_phone(brand("Samsung"), "Galaxy A16", DeviceType::Touch, Some(128), None);
    nowhere.category = DepartmentId::generate();
    assert_eq!(register(&shop, nowhere).await, Err("PRODUCT_CATEGORY_NOT_FOUND"));
    assert_eq!(
        register(&shop, new_phone(brand("itel"), "S23", DeviceType::Touch, Some(64), None)).await,
        Err("PHONE_BRAND_TYPE_MISMATCH"),
        "itel makes keypad phones only, as the owner set it"
    );
    assert_eq!(
        register(&shop, new_phone(brand("Nokia"), "105", DeviceType::Keypad, Some(32), None)).await,
        Err("PHONE_KEYPAD_HAS_NO_SPECS")
    );
    assert_eq!(
        register(&shop, new_phone(brand("Samsung"), "Galaxy A16", DeviceType::Touch, None, Some(6))).await,
        Err("PHONE_STORAGE_REQUIRED")
    );
    assert_eq!(
        register(&shop, new_phone(brand("Samsung"), "   ", DeviceType::Touch, Some(128), None)).await,
        Err("PHONE_MODEL_REQUIRED")
    );
    assert_eq!(
        register(&shop, new_phone(BrandId::generate(), "X1", DeviceType::Touch, Some(128), None)).await,
        Err("BRAND_NOT_FOUND")
    );
    let mut negative = new_phone(brand("Samsung"), "Galaxy A16", DeviceType::Touch, Some(128), None);
    negative.sale_price_minor = Some(-1);
    assert_eq!(register(&shop, negative).await, Err("PRICE_NEGATIVE"));
    let phones: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products")
        .fetch_one(&shop.pool)
        .await
        .expect("count");
    assert_eq!(phones, 0, "nothing half-made is left behind");
}

#[tokio::test]
async fn the_storage_refuses_half_a_phone() {
    let shop = shop().await;
    let name = register(&shop, new_phone(brand("Samsung"), "Galaxy A16", DeviceType::Touch, Some(128), None))
        .await
        .expect("a phone");
    let id: String = sqlx::query_scalar("SELECT id FROM products WHERE name = ?1")
        .bind(&name)
        .fetch_one(&shop.pool)
        .await
        .expect("id");
    let without_model = sqlx::query("UPDATE products SET model = NULL WHERE id = ?1")
        .bind(&id)
        .execute(&shop.pool)
        .await;
    assert!(without_model.is_err(), "a company without a model is half a phone");
    let keypad_with_storage = sqlx::query("UPDATE products SET device_type = 'keypad' WHERE id = ?1")
        .bind(&id)
        .execute(&shop.pool)
        .await;
    assert!(keypad_with_storage.is_err(), "a keypad phone has no storage");
    let cleared = sqlx::query(
        "UPDATE products SET brand_id = NULL, model = NULL, device_type = NULL, storage_gb = NULL, ram_gb = NULL WHERE id = ?1",
    )
    .bind(&id)
    .execute(&shop.pool)
    .await;
    assert!(cleared.is_ok(), "all five gone is no phone at all, which is allowed");
    register(&shop, new_phone(brand("Apple"), "iPhone 16", DeviceType::Touch, Some(128), None))
        .await
        .expect("another phone");
    let gone = sqlx::query("DELETE FROM brands WHERE id = ?1")
        .bind(brand("Apple").as_str())
        .execute(&shop.pool)
        .await;
    assert!(gone.is_err(), "a company with a phone stays (ON DELETE RESTRICT)");
}

#[tokio::test]
async fn the_sales_catalogue_carries_each_phones_company() {
    let shop = shop().await;
    register(&shop, new_phone(brand("Xiaomi"), "Redmi 14C", DeviceType::Touch, Some(128), Some(4)))
        .await
        .expect("a phone");
    let read = pos::read(&shop.pool, shop.tokens.as_ref()).await.expect("read");
    let redmi = read
        .products
        .iter()
        .find(|p| p.name == "Redmi 14C 128GB")
        .expect("a line drops the company from the name");
    assert_eq!(redmi.brand_id, Some(brand("Xiaomi").as_str()));
    assert_eq!(redmi.department_id, Some(category("موبايلات جديدة").as_str()));
    let names: Vec<&str> = read.brands.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names[0], "Samsung", "in the owner's order");
}
