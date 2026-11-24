//! Department authority against real SQLite.
//!
//! The plan's authority guarantees: a CRUD lifecycle in which every state
//! change is audited, a Sales user refused every operation, and the assurance
//! mix made concrete — `ManageSettings` blanket re-authenticated while
//! `ManageInventory` and `ManageDepartments` are not.

use std::sync::Arc;

use super::{count, fresh, manager_of, PASSWORD};
use mobile_shop_system_lib::data::repositories::identity::audit;
use mobile_shop_system_lib::domain::identity::{DomainError, Permission, Role};
use mobile_shop_system_lib::domain::organisation::{CostMethod, DepartmentId, DepartmentStatus};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, users};
use mobile_shop_system_lib::services::organisation::departments::{
    self as departments, DepartmentInput, VatInput,
};
use sqlx::SqlitePool;

/// The first manager, signed in at Normal assurance — deliberately not
/// re-authenticated: department work must succeed without a step-up.
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

fn input(name: &str, sort_order: i64) -> DepartmentInput {
    DepartmentInput {
        name: name.to_string(),
        cost_method: CostMethod::MovingAverage,
        vat: VatInput {
            enabled: false,
            rate_bp: None,
            inclusive: false,
        },
        sort_order,
    }
}

// ---------------------------------------------------------------------------
// CRUD with an audit event for every state change
// ---------------------------------------------------------------------------

#[tokio::test]
async fn department_lifecycle_records_an_audit_event_for_every_state_change() {
    let (pool, tokens) = manager().await;
    let actor = manager_of(&pool).await;

    // Create, with no re-authentication: naming a classification is routine.
    let produce = departments::create(&pool, tokens.as_ref(), input("Produce", 10))
        .await
        .expect("create");
    assert_eq!(produce.name.as_str(), "Produce");
    assert!(matches!(produce.status, DepartmentStatus::Active));
    assert_eq!(produce.sort_order, 10);
    assert_eq!(
        produce.created_by, actor,
        "attribution comes from the session, not from the caller"
    );
    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::DEPARTMENT_CREATED)
                .await
                .expect("count"),
            1
        );
    }

    // Read back through the service.
    let fetched = departments::get(&pool, tokens.as_ref(), produce.id)
        .await
        .expect("get");
    assert_eq!(fetched.id, produce.id);
    let all = departments::list(&pool, tokens.as_ref()).await.expect("list");
    assert_eq!(all.len(), 1);

    // Rename.
    let updated = departments::update(&pool, tokens.as_ref(), produce.id, input("Fresh Produce", 10))
        .await
        .expect("update");
    assert_eq!(updated.name.as_str(), "Fresh Produce");
    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::DEPARTMENT_UPDATED)
                .await
                .expect("count"),
            1
        );
    }

    // Archive.
    let archived = departments::set_archived(&pool, tokens.as_ref(), produce.id, true)
        .await
        .expect("archive");
    assert!(matches!(archived.status, DepartmentStatus::Archived));
    assert!(archived.archived_at.is_some(), "the archive moment is recorded");
    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::DEPARTMENT_ARCHIVED)
                .await
                .expect("count"),
            1
        );
    }

    // An archived department accepts no edit and no second archive.
    let error = departments::update(&pool, tokens.as_ref(), produce.id, input("Sneaky", 10))
        .await
        .expect_err("an archived department must refuse the edit");
    assert_eq!(error.code(), "DEPARTMENT_IS_ARCHIVED");
    let error = departments::set_archived(&pool, tokens.as_ref(), produce.id, true)
        .await
        .expect_err("archiving twice must be refused");
    assert_eq!(error.code(), "DEPARTMENT_IS_ARCHIVED");

    // Restore is an `department_updated` whose detail names the restore;
    // `DEPARTMENT_RESTORED` is intentionally not an event.
    let restored = departments::set_archived(&pool, tokens.as_ref(), produce.id, false)
        .await
        .expect("restore");
    assert!(matches!(restored.status, DepartmentStatus::Active));
    assert!(restored.archived_at.is_none());
    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::DEPARTMENT_UPDATED)
                .await
                .expect("count"),
            2,
            "restore must be audited as an update"
        );
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::DEPARTMENT_ARCHIVED)
                .await
                .expect("count"),
            1
        );
    }

    // Reorder: a second department, then the manager re-decides the list.
    let drinks = departments::create(&pool, tokens.as_ref(), input("Drinks", 20))
        .await
        .expect("second department");
    let reordered = departments::reorder(&pool, tokens.as_ref(), vec![drinks.id, produce.id])
        .await
        .expect("reorder");
    assert_eq!(reordered[0].id, drinks.id);
    assert_eq!(reordered[1].id, produce.id);
    let listed = departments::list(&pool, tokens.as_ref()).await.expect("list");
    assert_eq!(listed[0].id, drinks.id, "the list must read in the new order");

    // A missing department reports its own code.
    let error = departments::get(&pool, tokens.as_ref(), DepartmentId::generate())
        .await
        .expect_err("no such department");
    assert_eq!(error.code(), "DEPARTMENT_NOT_FOUND");
}

// ---------------------------------------------------------------------------
// Role refusal
// ---------------------------------------------------------------------------

#[tokio::test]
async fn every_department_operation_refuses_a_sales_user() {
    let (pool, tokens) = manager().await;

    // Account creation is ManageUsers, which is blanket re-authenticated.
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("re-authenticate to create the account");
    let manager = session::resolve(&pool, tokens.as_ref()).await.expect("resolve");
    let sales_id = users::create_user(&pool, &manager, "Sara", "sara", Role::Sales, PASSWORD)
        .await
        .expect("create the sales account");
    auth::login(&pool, tokens.as_ref(), sales_id, PASSWORD)
        .await
        .expect("sign in as sales");

    let create = departments::create(&pool, tokens.as_ref(), input("Sneaky", 1))
        .await
        .expect_err("sales may not create departments");
    assert_eq!(create.code(), "PERMISSION_DENIED");

    let get = departments::get(&pool, tokens.as_ref(), DepartmentId::generate())
        .await
        .expect_err("sales may not read one department");
    assert_eq!(get.code(), "PERMISSION_DENIED");

    let list = departments::list(&pool, tokens.as_ref())
        .await
        .expect_err("sales may not list departments");
    assert_eq!(list.code(), "PERMISSION_DENIED");

    let update = departments::update(
        &pool,
        tokens.as_ref(),
        DepartmentId::generate(),
        input("Sneaky", 1),
    )
    .await
    .expect_err("sales may not edit departments");
    assert_eq!(update.code(), "PERMISSION_DENIED");

    let archive = departments::set_archived(&pool, tokens.as_ref(), DepartmentId::generate(), true)
        .await
        .expect_err("sales may not archive departments");
    assert_eq!(archive.code(), "PERMISSION_DENIED");

    let reorder = departments::reorder(&pool, tokens.as_ref(), Vec::new())
        .await
        .expect_err("sales may not reorder departments");
    assert_eq!(reorder.code(), "PERMISSION_DENIED");

    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM departments").await,
        0,
        "every refused operation must have written nothing"
    );
}

// ---------------------------------------------------------------------------
// The assurance mix, on the real session
// ---------------------------------------------------------------------------

#[tokio::test]
async fn manage_settings_is_blanket_re_authenticated_while_inventory_and_departments_are_not() {
    let (pool, tokens) = manager().await;
    let resolved = session::resolve(&pool, tokens.as_ref()).await.expect("resolve");
    assert_eq!(
        resolved.assurance(),
        mobile_shop_system_lib::domain::identity::Assurance::Normal,
        "precondition: a fresh login is at Normal assurance"
    );

    assert_eq!(
        resolved.authorize(Permission::ManageInventory),
        Ok(()),
        "inventory is a mix of routine and sensitive, so it is not blanket re-authenticated"
    );
    assert_eq!(
        resolved.authorize(Permission::ManageDepartments),
        Ok(()),
        "naming a classification is routine work"
    );
    assert_eq!(
        resolved.authorize(Permission::ManageSettings),
        Err(DomainError::ReauthenticationRequired),
        "every settings change is sensitive, so it is blanket re-authenticated"
    );

    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("re-authenticate");
    let raised = session::resolve(&pool, tokens.as_ref()).await.expect("resolve");
    assert_eq!(raised.authorize(Permission::ManageSettings), Ok(()));
}
