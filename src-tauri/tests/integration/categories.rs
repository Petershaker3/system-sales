//! The category tree (ADR-018 §1, plan item 1.2), against real SQLite.
//!
//! The claims under test:
//!
//! * the default tree is added once, attributed to the owner and audited once;
//!   nothing is added before there is a manager; a database made before the
//!   tree keeps its departments and gains only the defaults that do not clash;
//! * the owner adds main and sub-categories; a sub-category takes its main's
//!   kind; the tree is two levels deep; names are unique across the tree;
//! * renaming, hiding and moving are recorded; moving renumbers the siblings;
//! * only an empty category the owner made may be deleted;
//! * a seller can do none of it;
//! * the storage refuses a third level and a kind unlike the parent's, whatever
//!   the code above it does;
//! * a product goes in a live category and comes out of it; the sales
//!   catalogue carries the tree.

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::domain::catalog::{Disposition, ProductStatus};
use mobile_shop_system_lib::domain::identity::{Role, UserId};
use mobile_shop_system_lib::domain::organisation::{
    CategoryKind, DepartmentId, DEFAULT_CATEGORIES,
};
use mobile_shop_system_lib::services::catalog::product::{self as product, NewProduct, ProductPatch};
use mobile_shop_system_lib::services::catalog::{pos, CatalogContext};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, users};
use mobile_shop_system_lib::services::organisation::categories::{
    self, MoveStep, NewCategory,
};
use sqlx::SqlitePool;

struct Shop {
    pool: SqlitePool,
    tokens: Arc<InMemoryTokenStore>,
    owner: UserId,
}

/// A fresh shop whose owner is signed in, with no category yet.
async fn bare_shop() -> Shop {
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
    Shop {
        pool,
        tokens,
        owner: created.user_id,
    }
}

/// A fresh shop with the default tree, as setup leaves it.
async fn shop() -> Shop {
    let shop = bare_shop().await;
    let added = categories::add_default_categories(&shop.pool)
        .await
        .expect("defaults");
    assert_eq!(added, 11, "precondition: the whole default tree");
    shop
}

fn default_id(name: &str) -> DepartmentId {
    DEFAULT_CATEGORIES
        .iter()
        .find(|c| c.name == name)
        .map(|c| c.department_id())
        .expect("a default category")
}

async fn add(
    shop: &Shop,
    name: &str,
    parent: Option<DepartmentId>,
    kind: Option<CategoryKind>,
) -> Result<DepartmentId, &'static str> {
    categories::create(
        &shop.pool,
        shop.tokens.as_ref(),
        NewCategory {
            name: name.to_string(),
            parent,
            kind,
            icon: "tag".to_string(),
        },
    )
    .await
    .map(|category| category.id)
    .map_err(|error| error.code())
}

async fn count(shop: &Shop, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&shop.pool)
        .await
        .expect("count")
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

/// The live categories under `parent` (or the mains), by name, in display order.
async fn names_under(shop: &Shop, parent: Option<DepartmentId>) -> Vec<String> {
    categories::list(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("list")
        .into_iter()
        .filter(|entry| entry.category.parent == parent)
        .map(|entry| entry.category.name.as_str().to_string())
        .collect()
}

fn catalog(shop: &Shop) -> CatalogContext {
    CatalogContext::new(shop.pool.clone(), shop.tokens.clone())
}

async fn new_product(shop: &Shop, name: &str, category: Option<DepartmentId>) -> Result<String, &'static str> {
    let ctx = catalog(shop);
    let current = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("session");
    product::create(
        &ctx,
        &current,
        NewProduct {
            name: name.to_string(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: Some(1000),
            category,
        },
    )
    .await
    .map(|created| created.id.as_str())
    .map_err(|error| error.code())
}

async fn category_of(shop: &Shop, product_id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT department_id FROM products WHERE id = ?1")
        .bind(product_id)
        .fetch_one(&shop.pool)
        .await
        .expect("product row")
}

// ---------------------------------------------------------------------------
// The default tree
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_default_tree_is_added_once_attributed_to_the_owner_and_audited_once() {
    let shop = shop().await;
    assert_eq!(count(&shop, "SELECT COUNT(*) FROM departments").await, 11);
    assert_eq!(
        names_under(&shop, None).await,
        vec!["موبايلات جديدة", "مستعمل", "إكسسوارات", "ساعات ذكية"]
    );
    assert_eq!(
        names_under(&shop, Some(default_id("إكسسوارات"))).await,
        vec!["جرابات", "اسكرينات", "شواحن", "كابلات ووصلات", "سماعات", "باور بانك وميموري", "حوامل"]
    );

    let owner_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM departments WHERE created_by = ?1")
        .bind(shop.owner.as_str())
        .fetch_one(&shop.pool)
        .await
        .expect("attribution");
    assert_eq!(owner_rows, 11, "attributed to the owner");
    let kinds: Vec<(String, String)> = sqlx::query_as(
        "SELECT name, kind FROM departments WHERE parent_id IS NULL ORDER BY sort_order",
    )
    .fetch_all(&shop.pool)
    .await
    .expect("kinds");
    assert_eq!(kinds[0], ("موبايلات جديدة".to_string(), "phone".to_string()));
    assert_eq!(kinds[1], ("مستعمل".to_string(), "used".to_string()));

    assert_eq!(
        categories::add_default_categories(&shop.pool).await.expect("again"),
        0,
        "added once: every start-up after this finds them"
    );
    assert_eq!(count(&shop, "SELECT COUNT(*) FROM departments").await, 11);
    assert_eq!(audit_count(&shop, "default_categories_added", r#"{"count":11}"#).await, 1);
}

#[tokio::test]
async fn nothing_is_added_before_there_is_a_manager() {
    let pool = mobile_shop_system_lib::data::db::open_in_memory()
        .await
        .expect("in-memory database");
    assert_eq!(categories::add_default_categories(&pool).await.expect("start-up"), 0);
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM departments")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(rows, 0, "setup adds them, attributed to the first manager");
}

#[tokio::test]
async fn a_database_made_before_the_tree_keeps_its_departments_and_gains_the_rest() {
    let shop = bare_shop().await;
    // A department of the old panel, with the name of a default main.
    sqlx::query(
        "INSERT INTO departments
           (id, name, status, cost_method, vat_enabled, vat_rate_bp, vat_inclusive,
            sort_order, created_by, updated_by, created_at, updated_at)
         VALUES (?1, 'إكسسوارات', 'active', 'moving_average', 0, NULL, 0, 0, ?2, ?2, 0, 0)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(shop.owner.as_str())
    .execute(&shop.pool)
    .await
    .expect("an old department");

    let added = categories::add_default_categories(&shop.pool).await.expect("start-up");
    assert_eq!(
        added, 3,
        "the three mains that do not clash; the default «إكسسوارات» and its subs are skipped"
    );
    let old: (Option<String>, String, String) = sqlx::query_as(
        "SELECT parent_id, kind, icon FROM departments WHERE name = 'إكسسوارات'",
    )
    .fetch_one(&shop.pool)
    .await
    .expect("the old department");
    assert_eq!(old, (None, "item".to_string(), "tag".to_string()), "a main «بالعدد» with the tag");
    assert_eq!(categories::add_default_categories(&shop.pool).await.expect("again"), 0);
}

// ---------------------------------------------------------------------------
// The owner's tree
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_sub_category_takes_its_mains_kind_and_goes_at_the_end() {
    let shop = shop().await;
    let tablets = add(&shop, "تابلت", None, Some(CategoryKind::Phone)).await.expect("a main");
    let covers = add(&shop, "جرابات تابلت", Some(tablets), None).await.expect("a sub");
    let stored: (String, Option<String>, i64) =
        sqlx::query_as("SELECT kind, parent_id, sort_order FROM departments WHERE id = ?1")
            .bind(covers.as_str())
            .fetch_one(&shop.pool)
            .await
            .expect("the sub");
    assert_eq!(stored, ("phone".to_string(), Some(tablets.as_str()), 10));
    assert_eq!(
        names_under(&shop, None).await.last().map(String::as_str),
        Some("تابلت"),
        "a new main goes after the others"
    );
    let main_without_kind = add(&shop, "خطوط", None, None).await.expect("a main");
    let kind: String = sqlx::query_scalar("SELECT kind FROM departments WHERE id = ?1")
        .bind(main_without_kind.as_str())
        .fetch_one(&shop.pool)
        .await
        .expect("kind");
    assert_eq!(kind, "item", "no kind chosen means counted goods");
    assert_eq!(audit_count(&shop, "department_created", r#"%"name":"جرابات تابلت"%"#).await, 1);
}

#[tokio::test]
async fn the_tree_is_two_levels_and_a_sub_keeps_its_mains_kind() {
    let shop = shop().await;
    let cases = default_id("جرابات");
    assert_eq!(add(&shop, "جرابات جلد", Some(cases), None).await, Err("CATEGORY_PARENT_NOT_MAIN"));
    assert_eq!(
        add(&shop, "شواحن موبايلات", Some(default_id("إكسسوارات")), Some(CategoryKind::Phone)).await,
        Err("CATEGORY_KIND_MISMATCH")
    );
    assert_eq!(
        add(&shop, "تحت حاجة مش موجودة", Some(DepartmentId::generate()), None).await,
        Err("DEPARTMENT_NOT_FOUND")
    );
}

#[tokio::test]
async fn names_are_unique_across_the_tree_whatever_the_case() {
    let shop = shop().await;
    add(&shop, "Spare parts", None, None).await.expect("first");
    assert_eq!(add(&shop, "spare PARTS", None, None).await, Err("CATEGORY_NAME_TAKEN"));
    assert_eq!(
        add(&shop, "شواحن", None, None).await,
        Err("CATEGORY_NAME_TAKEN"),
        "a main may not take a sub-category's name either"
    );
    assert_eq!(add(&shop, "   ", None, None).await, Err("DEPARTMENT_NAME_REQUIRED"));

    let renamed = categories::rename(
        &shop.pool,
        shop.tokens.as_ref(),
        default_id("حوامل"),
        "سماعات".to_string(),
    )
    .await
    .map_err(|error| error.code());
    assert_eq!(renamed.err(), Some("CATEGORY_NAME_TAKEN"));

    let unchanged = categories::rename(&shop.pool, shop.tokens.as_ref(), default_id("حوامل"), "حوامل".to_string())
        .await
        .expect("the same name");
    assert_eq!(unchanged.name.as_str(), "حوامل");
    assert_eq!(
        audit_count(&shop, "department_updated", "%renamed_from%").await,
        0,
        "the same name again records nothing"
    );
    categories::rename(&shop.pool, shop.tokens.as_ref(), default_id("حوامل"), "حوامل عربية".to_string())
        .await
        .expect("a default may be renamed");
    assert_eq!(audit_count(&shop, "department_updated", r#"%"renamed_from":"حوامل"%"#).await, 1);
}

#[tokio::test]
async fn an_icon_not_in_the_list_is_refused() {
    let shop = shop().await;
    let refused = categories::create(
        &shop.pool,
        shop.tokens.as_ref(),
        NewCategory {
            name: "صواريخ".to_string(),
            parent: None,
            kind: None,
            icon: "rocket".to_string(),
        },
    )
    .await
    .map_err(|error| error.code());
    assert_eq!(refused.err(), Some("CATEGORY_ICON_UNKNOWN"));
}

#[tokio::test]
async fn hiding_and_moving_are_recorded_and_moving_renumbers_the_siblings() {
    let shop = shop().await;
    let smart = default_id("ساعات ذكية");
    categories::set_hidden(&shop.pool, shop.tokens.as_ref(), smart, true)
        .await
        .expect("hide");
    categories::set_hidden(&shop.pool, shop.tokens.as_ref(), smart, true)
        .await
        .expect("hide again: nothing to do");
    assert_eq!(audit_count(&shop, "department_updated", r#"%"hidden":true%"#).await, 1);
    let hidden: i64 = sqlx::query_scalar("SELECT hidden FROM departments WHERE id = ?1")
        .bind(smart.as_str())
        .fetch_one(&shop.pool)
        .await
        .expect("hidden");
    assert_eq!(hidden, 1);

    categories::move_category(&shop.pool, shop.tokens.as_ref(), smart, MoveStep::Up)
        .await
        .expect("move up");
    assert_eq!(
        names_under(&shop, None).await,
        vec!["موبايلات جديدة", "مستعمل", "ساعات ذكية", "إكسسوارات"]
    );
    let first = default_id("موبايلات جديدة");
    categories::move_category(&shop.pool, shop.tokens.as_ref(), first, MoveStep::Up)
        .await
        .expect("already first: nothing to do");
    assert_eq!(names_under(&shop, None).await[0], "موبايلات جديدة");
    assert_eq!(audit_count(&shop, "department_updated", r#"%"moved":"up"%"#).await, 1);

    // Sub-categories move among themselves only.
    let cables = default_id("كابلات ووصلات");
    categories::move_category(&shop.pool, shop.tokens.as_ref(), cables, MoveStep::Down)
        .await
        .expect("move down");
    let subs = names_under(&shop, Some(default_id("إكسسوارات"))).await;
    assert_eq!(subs[3], "سماعات");
    assert_eq!(subs[4], "كابلات ووصلات");
    let orders: Vec<i64> = sqlx::query_scalar(
        "SELECT sort_order FROM departments WHERE parent_id = ?1 ORDER BY sort_order",
    )
    .bind(default_id("إكسسوارات").as_str())
    .fetch_all(&shop.pool)
    .await
    .expect("orders");
    assert_eq!(orders, vec![10, 20, 30, 40, 50, 60, 70], "numbered afresh, no ties");
}

#[tokio::test]
async fn only_an_empty_category_the_owner_made_may_be_deleted() {
    let shop = shop().await;
    let refused = |result: Result<(), mobile_shop_system_lib::services::organisation::departments::DepartmentServiceError>| {
        result.err().map(|error| error.code())
    };
    let empty_default = default_id("ساعات ذكية");
    assert_eq!(
        refused(categories::delete(&shop.pool, shop.tokens.as_ref(), empty_default).await),
        Some("CATEGORY_IS_DEFAULT")
    );

    let lines = add(&shop, "خطوط", None, None).await.expect("a main");
    let prepaid = add(&shop, "خطوط كارت", Some(lines), None).await.expect("a sub");
    assert_eq!(
        refused(categories::delete(&shop.pool, shop.tokens.as_ref(), lines).await),
        Some("CATEGORY_HAS_SUBCATEGORIES")
    );

    let sim = new_product(&shop, "خط فودافون", Some(prepaid)).await.expect("a product");
    let ctx = catalog(&shop);
    let current = session::resolve(&shop.pool, shop.tokens.as_ref()).await.expect("session");
    let sim_id = mobile_shop_system_lib::domain::catalog::ProductId::from_uuid(
        uuid::Uuid::parse_str(&sim).expect("id"),
    );
    product::set_status(&ctx, &current, sim_id, ProductStatus::Archived)
        .await
        .expect("archive it");
    assert_eq!(
        refused(categories::delete(&shop.pool, shop.tokens.as_ref(), prepaid).await),
        Some("CATEGORY_NOT_EMPTY"),
        "an archived product still names it"
    );
    let entries = categories::list(&shop.pool, shop.tokens.as_ref()).await.expect("list");
    let prepaid_entry = entries.iter().find(|e| e.category.id == prepaid).expect("listed");
    assert_eq!(prepaid_entry.products, 0, "the list counts live products only");
    assert!(!prepaid_entry.deletable);

    product::update(
        &ctx,
        &current,
        sim_id,
        ProductPatch {
            category: Some(None),
            ..ProductPatch::default()
        },
    )
    .await
    .err()
    .map(|error| error.code())
    .expect("an archived product is not edited");
    sqlx::query("UPDATE products SET department_id = NULL WHERE id = ?1")
        .bind(&sim)
        .execute(&shop.pool)
        .await
        .expect("empty it by hand");

    categories::delete(&shop.pool, shop.tokens.as_ref(), prepaid)
        .await
        .expect("now it is empty");
    categories::delete(&shop.pool, shop.tokens.as_ref(), lines)
        .await
        .expect("and so is its main");
    assert_eq!(count(&shop, "SELECT COUNT(*) FROM departments").await, 11);
    assert_eq!(audit_count(&shop, "department_deleted", r#"%"name":"خطوط كارت"%"#).await, 1);
}

#[tokio::test]
async fn a_seller_can_do_none_of_it() {
    let shop = shop().await;
    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("the owner re-authenticates");
    let owner = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("owner session");
    let seller = users::create_user(&shop.pool, &owner, "Youssef", "youssef", Role::Sales, PASSWORD)
        .await
        .expect("a seller");
    auth::login(&shop.pool, shop.tokens.as_ref(), seller, PASSWORD)
        .await
        .expect("the seller signs in");

    let any = default_id("شواحن");
    let tokens = shop.tokens.as_ref();
    assert_eq!(
        categories::list(&shop.pool, tokens).await.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );
    assert_eq!(add(&shop, "حاجة", None, None).await, Err("PERMISSION_DENIED"));
    assert_eq!(
        categories::rename(&shop.pool, tokens, any, "x".to_string()).await.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );
    assert_eq!(
        categories::set_hidden(&shop.pool, tokens, any, true).await.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );
    assert_eq!(
        categories::move_category(&shop.pool, tokens, any, MoveStep::Up).await.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );
    assert_eq!(
        categories::delete(&shop.pool, tokens, any).await.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );
    // The seller still reads the tree with the sales screen's catalogue.
    let read = pos::read(&shop.pool, tokens).await.expect("the sales catalogue");
    assert_eq!(read.categories.len(), 11);
}

// ---------------------------------------------------------------------------
// The storage's own refusals (migration 0016)
// ---------------------------------------------------------------------------

async fn raw_insert(
    shop: &Shop,
    name: &str,
    parent: Option<DepartmentId>,
    kind: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO departments
           (id, name, status, cost_method, vat_enabled, vat_rate_bp, vat_inclusive,
            sort_order, created_by, updated_by, created_at, updated_at,
            parent_id, kind, icon, hidden)
         VALUES (?1, ?2, 'active', 'moving_average', 0, NULL, 0, 0, ?3, ?3, 0, 0, ?4, ?5, 'tag', 0)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(name)
    .bind(shop.owner.as_str())
    .bind(parent.map(|id| id.as_str()))
    .bind(kind)
    .execute(&shop.pool)
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[tokio::test]
async fn the_storage_refuses_a_third_level_and_a_kind_unlike_the_parents() {
    let shop = shop().await;
    let third = raw_insert(&shop, "Third level", Some(default_id("جرابات")), "item").await;
    assert!(
        third.as_ref().is_err_and(|e| e.contains("the parent must be a main category")),
        "{third:?}"
    );
    let unlike = raw_insert(&shop, "Unlike", Some(default_id("إكسسوارات")), "phone").await;
    assert!(
        unlike.as_ref().is_err_and(|e| e.contains("takes its parent's kind")),
        "{unlike:?}"
    );
    let bad_kind = raw_insert(&shop, "Bad kind", None, "gadget").await;
    assert!(bad_kind.is_err(), "the CHECK refuses an unknown kind");
    raw_insert(&shop, "Fine", Some(default_id("إكسسوارات")), "item")
        .await
        .expect("a proper sub-category");

    // A main with sub-categories cannot move under another main.
    let moved = sqlx::query("UPDATE departments SET parent_id = ?1 WHERE id = ?2")
        .bind(default_id("موبايلات جديدة").as_str())
        .bind(default_id("إكسسوارات").as_str())
        .execute(&shop.pool)
        .await;
    assert!(moved.is_err(), "three levels by the back door");
    // Nor change kind away from its sub-categories'.
    let rekinded = sqlx::query("UPDATE departments SET kind = 'phone' WHERE id = ?1")
        .bind(default_id("إكسسوارات").as_str())
        .execute(&shop.pool)
        .await;
    assert!(rekinded.is_err(), "its sub-categories are «بالعدد»");
    // And a category with a product cannot be deleted from under it.
    let charger = new_product(&shop, "شاحن", Some(default_id("شواحن"))).await.expect("a product");
    let deleted = sqlx::query("DELETE FROM departments WHERE id = ?1")
        .bind(default_id("شواحن").as_str())
        .execute(&shop.pool)
        .await;
    assert!(deleted.is_err(), "the product's foreign key refuses: {charger}");
}

// ---------------------------------------------------------------------------
// Products and the sales screen
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_product_goes_in_a_live_category_and_comes_out_of_it() {
    let shop = shop().await;
    let chargers = default_id("شواحن");
    let charger = new_product(&shop, "شاحن 20 وات", Some(chargers)).await.expect("classified");
    assert_eq!(category_of(&shop, &charger).await, Some(chargers.as_str()));
    let loose = new_product(&shop, "حاجة", None).await.expect("unclassified");
    assert_eq!(category_of(&shop, &loose).await, None);
    assert_eq!(
        new_product(&shop, "في الهوا", Some(DepartmentId::generate())).await,
        Err("PRODUCT_CATEGORY_NOT_FOUND")
    );

    let ctx = catalog(&shop);
    let current = session::resolve(&shop.pool, shop.tokens.as_ref()).await.expect("session");
    let id = mobile_shop_system_lib::domain::catalog::ProductId::from_uuid(
        uuid::Uuid::parse_str(&charger).expect("id"),
    );
    let audio = default_id("سماعات");
    product::update(&ctx, &current, id, ProductPatch { category: Some(Some(audio)), ..ProductPatch::default() })
        .await
        .expect("moved to another category");
    assert_eq!(category_of(&shop, &charger).await, Some(audio.as_str()));
    product::update(&ctx, &current, id, ProductPatch { category: Some(None), ..ProductPatch::default() })
        .await
        .expect("taken out");
    assert_eq!(category_of(&shop, &charger).await, None);
    product::update(&ctx, &current, id, ProductPatch { name: Some("شاحن 25 وات".to_string()), ..ProductPatch::default() })
        .await
        .expect("an edit that leaves the category alone");
    assert_eq!(category_of(&shop, &charger).await, None);
}

#[tokio::test]
async fn the_sales_catalogue_carries_the_tree_and_the_list_counts_live_products() {
    let shop = shop().await;
    let cases = default_id("جرابات");
    new_product(&shop, "جراب 1", Some(cases)).await.expect("one");
    new_product(&shop, "جراب 2", Some(cases)).await.expect("two");
    categories::set_hidden(&shop.pool, shop.tokens.as_ref(), cases, true)
        .await
        .expect("hide");

    let read = pos::read(&shop.pool, shop.tokens.as_ref()).await.expect("read");
    let row = read
        .categories
        .iter()
        .find(|c| c.id == cases.as_str())
        .expect("hidden categories still come, so search finds them");
    assert_eq!(row.parent_id, Some(default_id("إكسسوارات").as_str()));
    assert_eq!(row.kind, "item");
    assert_eq!(row.icon, "shield");
    assert!(row.hidden);
    assert_eq!(
        read.products.iter().filter(|p| p.department_id == Some(cases.as_str())).count(),
        2
    );

    let entries = categories::list(&shop.pool, shop.tokens.as_ref()).await.expect("list");
    let entry = entries.iter().find(|e| e.category.id == cases).expect("listed");
    assert_eq!(entry.products, 2);
    assert!(entry.is_default);
    assert!(!entry.deletable);
}
