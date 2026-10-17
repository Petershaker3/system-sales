//! Category use cases (ADR-018 §1): the two-level tree the owner manages from
//! the settings — list, add, rename, show or hide, move up or down, delete an
//! empty one — and the default tree a shop starts with.
//!
//! A category is a `departments` row, so refusals use the department
//! vocabulary ([`DepartmentServiceError`]) and the department audit events.
//!
//! # Authorization
//!
//! `Permission::ManageDepartments` before any pool acquisition, without a fresh
//! password: making a category is routine, as making a department always was.
//!
//! # One transaction per change
//!
//! Each change reads what it decides from, writes, and appends its audit event
//! in one transaction. The checks the domain makes from storage — a name taken,
//! sub-categories present, products present — are read inside that transaction,
//! and the unique index and the foreign keys refuse as well if a check is ever
//! wrong.

use std::collections::HashMap;

use sqlx::{SqliteConnection, SqlitePool};

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::user as user_repo;
use crate::data::repositories::organisation::department as repo;
use crate::domain::identity::{DomainError, Permission, Session, Timestamp, UserId};
use crate::domain::organisation::{
    can_delete, is_default_category, CategoryIcon, CategoryKind, CategoryPlacement, Department,
    DepartmentError, DepartmentId, DepartmentName, DEFAULT_CATEGORIES,
};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;
use crate::services::organisation::departments::DepartmentServiceError;

/// One category as the settings list shows it.
#[derive(Debug, Clone)]
pub struct CategoryEntry {
    pub category: Department,
    /// Live products directly in this category (not counting its
    /// sub-categories').
    pub products: i64,
    /// One of the default tree: renamed, moved and hidden, never deleted.
    pub is_default: bool,
    /// Whether [`delete`] would accept it now.
    pub deletable: bool,
}

/// A new category, as the settings form sends it.
#[derive(Debug, Clone)]
pub struct NewCategory {
    pub name: String,
    /// `None` for a main category.
    pub parent: Option<DepartmentId>,
    /// A main category's kind; `None` means counted goods (`item`), the form's
    /// first choice. A sub-category takes its parent's, and a different one is
    /// refused rather than ignored.
    pub kind: Option<CategoryKind>,
    pub icon: String,
}

/// Up or down among a category's siblings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveStep {
    Up,
    Down,
}

/// Resolve the current operator and require category management.
async fn authorize(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Session, DepartmentServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageDepartments)?;
    Ok(session)
}

fn storage(_: sqlx::Error) -> DepartmentServiceError {
    DepartmentServiceError::Identity(DomainError::StorageUnavailable)
}

/// SQLite reports a broken UNIQUE constraint with this text. The only unique
/// constraint a category write can break besides the id is the live name.
fn is_unique_violation(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(e) => e.to_string().contains("UNIQUE constraint failed"),
        _ => false,
    }
}

async fn load(
    conn: &mut SqliteConnection,
    id: DepartmentId,
) -> Result<Department, DepartmentServiceError> {
    Ok(repo::find_by_id(conn, id)
        .await
        .map_err(storage)?
        .ok_or(DepartmentError::NotFound)?)
}

/// The live categories that share a parent with `parent`, in display order.
async fn siblings(
    conn: &mut SqliteConnection,
    parent: Option<DepartmentId>,
) -> Result<Vec<Department>, DepartmentServiceError> {
    Ok(repo::list_active(conn)
        .await
        .map_err(storage)?
        .into_iter()
        .filter(|category| category.parent == parent)
        .collect())
}

/// Every live category in display order (main and sub alike; the screen builds
/// the tree from `parent`), with its count of live products and whether it may
/// be deleted.
pub async fn list(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Vec<CategoryEntry>, DepartmentServiceError> {
    authorize(pool, tokens).await?;
    let mut conn = pool.acquire().await.map_err(storage)?;
    let categories = repo::list_active(&mut conn).await.map_err(storage)?;
    let counts: HashMap<String, i64> = repo::active_product_counts(&mut conn)
        .await
        .map_err(storage)?
        .into_iter()
        .collect();

    let mut entries = Vec::with_capacity(categories.len());
    for category in categories {
        let has_subcategories = repo::has_subcategories(&mut conn, category.id)
            .await
            .map_err(storage)?;
        let all_products = repo::count_products(&mut conn, category.id)
            .await
            .map_err(storage)?;
        entries.push(CategoryEntry {
            products: counts.get(&category.id.as_str()).copied().unwrap_or(0),
            is_default: is_default_category(category.id),
            deletable: can_delete(category.id, has_subcategories, all_products).is_ok(),
            category,
        });
    }
    Ok(entries)
}

/// Add a category at the end of its siblings.
pub async fn create(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: NewCategory,
) -> Result<Department, DepartmentServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();
    let name = DepartmentName::new(&input.name)?;
    let icon = CategoryIcon::new(&input.icon)?;

    let mut tx = pool.begin().await.map_err(storage)?;
    if repo::active_name_taken(&mut tx, &name, None).await.map_err(storage)? {
        return Err(DepartmentError::NameTaken.into());
    }
    let parent = match input.parent {
        Some(id) => Some(load(&mut tx, id).await?),
        None => None,
    };
    let placement = match &parent {
        Some(parent) => {
            if input.kind.is_some_and(|kind| kind != parent.kind) {
                return Err(DepartmentError::KindMismatch.into());
            }
            CategoryPlacement::Under(parent)
        }
        None => CategoryPlacement::Main(input.kind.unwrap_or(CategoryKind::Item)),
    };
    let last = siblings(&mut tx, input.parent)
        .await?
        .iter()
        .map(|sibling| sibling.sort_order)
        .max()
        .unwrap_or(0);
    let category =
        Department::new_category(name, placement, icon, last + 10, actor, now.as_millis())?;

    if let Err(error) = repo::insert(&mut tx, &category).await {
        return Err(if is_unique_violation(&error) {
            DepartmentError::NameTaken.into()
        } else {
            storage(error)
        });
    }
    audit::append(
        &mut tx,
        actor,
        audit::event::DEPARTMENT_CREATED,
        now,
        Some(
            serde_json::json!({
                "target": category.id.as_str(),
                "name": category.name.as_str(),
                "parent": category.parent.map(|id| id.as_str()),
                "kind": category.kind.as_str(),
                "icon": category.icon.as_str(),
            })
            .to_string(),
        ),
    )
    .await
    .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(category)
}

/// Give a category a new name. The same name again changes nothing and records
/// nothing.
pub async fn rename(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: DepartmentId,
    name: String,
) -> Result<Department, DepartmentServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();
    let name = DepartmentName::new(&name)?;

    let mut tx = pool.begin().await.map_err(storage)?;
    let mut category = load(&mut tx, id).await?;
    if category.name == name {
        return Ok(category);
    }
    if repo::active_name_taken(&mut tx, &name, Some(id)).await.map_err(storage)? {
        return Err(DepartmentError::NameTaken.into());
    }
    let previous = category.name.as_str().to_string();
    category.rename(name, actor, now.as_millis())?;
    if let Err(error) = repo::update(&mut tx, &category).await {
        return Err(if is_unique_violation(&error) {
            DepartmentError::NameTaken.into()
        } else {
            storage(error)
        });
    }
    audit::append(
        &mut tx,
        actor,
        audit::event::DEPARTMENT_UPDATED,
        now,
        Some(
            serde_json::json!({
                "target": category.id.as_str(),
                "renamed_from": previous,
                "name": category.name.as_str(),
            })
            .to_string(),
        ),
    )
    .await
    .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(category)
}

/// Show or hide a category's button on the sales screen. No change, no record.
pub async fn set_hidden(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: DepartmentId,
    hidden: bool,
) -> Result<Department, DepartmentServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin().await.map_err(storage)?;
    let mut category = load(&mut tx, id).await?;
    if category.hidden == hidden {
        return Ok(category);
    }
    category.set_hidden(hidden, actor, now.as_millis())?;
    repo::update(&mut tx, &category).await.map_err(storage)?;
    audit::append(
        &mut tx,
        actor,
        audit::event::DEPARTMENT_UPDATED,
        now,
        Some(serde_json::json!({ "target": category.id.as_str(), "hidden": hidden }).to_string()),
    )
    .await
    .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(category)
}

/// Move a category one place up or down among its siblings. At either end
/// there is nowhere to go, and nothing changes.
///
/// The siblings are numbered afresh (10, 20, 30…) in their new order, so ties
/// left by older rows — every department made before the tree had its own
/// order, often 0 — cannot make a move do nothing.
pub async fn move_category(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: DepartmentId,
    step: MoveStep,
) -> Result<Department, DepartmentServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin().await.map_err(storage)?;
    let category = load(&mut tx, id).await?;
    if !category.is_editable() {
        return Err(DepartmentError::IsArchived.into());
    }
    let mut order = siblings(&mut tx, category.parent).await?;
    let Some(at) = order.iter().position(|sibling| sibling.id == id) else {
        return Err(DepartmentError::NotFound.into());
    };
    let to = match step {
        MoveStep::Up if at > 0 => at - 1,
        MoveStep::Down if at + 1 < order.len() => at + 1,
        _ => return Ok(category),
    };
    order.swap(at, to);

    let mut moved = category;
    for (position, sibling) in order.iter_mut().enumerate() {
        let wanted = (position as i64 + 1) * 10;
        if sibling.sort_order != wanted {
            sibling.set_sort_order(wanted, actor, now.as_millis())?;
            repo::update(&mut tx, sibling).await.map_err(storage)?;
        }
        if sibling.id == id {
            moved = sibling.clone();
        }
    }
    let direction = match step {
        MoveStep::Up => "up",
        MoveStep::Down => "down",
    };
    audit::append(
        &mut tx,
        actor,
        audit::event::DEPARTMENT_UPDATED,
        now,
        Some(serde_json::json!({ "target": id.as_str(), "moved": direction }).to_string()),
    )
    .await
    .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(moved)
}

/// Delete an empty category: not a default, no sub-category, no product
/// (archived ones included).
pub async fn delete(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: DepartmentId,
) -> Result<(), DepartmentServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin().await.map_err(storage)?;
    let category = load(&mut tx, id).await?;
    let has_subcategories = repo::has_subcategories(&mut tx, id).await.map_err(storage)?;
    let products = repo::count_products(&mut tx, id).await.map_err(storage)?;
    can_delete(id, has_subcategories, products)?;
    if repo::delete(&mut tx, id).await.map_err(storage)? != 1 {
        return Err(DepartmentError::NotFound.into());
    }
    audit::append(
        &mut tx,
        actor,
        audit::event::DEPARTMENT_DELETED,
        now,
        Some(
            serde_json::json!({
                "target": id.as_str(),
                "name": category.name.as_str(),
                "parent": category.parent.map(|parent| parent.as_str()),
            })
            .to_string(),
        ),
    )
    .await
    .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(())
}

/// Add whatever of the default tree is missing, attributed to `actor`, and say
/// how many categories were added.
///
/// A default is added once — its id is fixed — and never over a live category
/// that already has its name; a sub-category whose default parent is not there
/// is skipped with it. So a database made before the tree keeps the
/// departments it had, and gains the defaults that do not clash with them.
async fn add_missing_defaults(
    conn: &mut SqliteConnection,
    actor: UserId,
    now: Timestamp,
) -> Result<usize, sqlx::Error> {
    let mut added = 0usize;
    for default in DEFAULT_CATEGORIES.iter() {
        let id = default.department_id();
        if repo::find_by_id(conn, id).await?.is_some() {
            continue;
        }
        let parent = match default.parent_id() {
            Some(parent_id) => match repo::find_by_id(conn, parent_id).await? {
                Some(parent) => Some(parent),
                None => continue,
            },
            None => None,
        };
        let Ok(name) = DepartmentName::new(default.name) else {
            continue;
        };
        if repo::active_name_taken(conn, &name, None).await? {
            continue;
        }
        let Ok(icon) = CategoryIcon::new(default.icon) else {
            continue;
        };
        let placement = match &parent {
            Some(parent) => CategoryPlacement::Under(parent),
            None => CategoryPlacement::Main(default.kind),
        };
        let Ok(mut category) = Department::new_category(
            name,
            placement,
            icon,
            default.sort_order,
            actor,
            now.as_millis(),
        ) else {
            continue;
        };
        category.id = id;
        repo::insert(conn, &category).await?;
        added += 1;
    }
    Ok(added)
}

/// Add the missing default categories, attributed to the longest-serving
/// active manager, in one transaction, and say how many were added.
///
/// Called right after the first manager is created, and on every start-up so a
/// database made before the tree gains them (ADR-018 §1). With no manager yet
/// there is nobody to attribute them to, and nothing is added: setup will.
pub async fn add_default_categories(pool: &SqlitePool) -> Result<usize, DomainError> {
    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    let Some(actor) = user_repo::first_active_manager(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    else {
        return Ok(0);
    };
    let now = Timestamp::now();
    let added = add_missing_defaults(&mut tx, actor, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if added > 0 {
        audit::append(
            &mut tx,
            actor,
            audit::event::DEFAULT_CATEGORIES_ADDED,
            now,
            Some(serde_json::json!({ "count": added }).to_string()),
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    }
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(added)
}
