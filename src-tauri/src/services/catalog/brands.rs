//! Phone brand use cases (ADR-018 §2): the companies the owner keeps in the
//! settings — list, add, rename, set touch/keypad/both, show or hide in
//! «موبايل جديد», move up or down, delete one he added that has no phone — and
//! the default companies a shop starts with.
//!
//! `Permission::ManageCatalog`, without a fresh password: a company is
//! catalogue reference data, edited as freely as a product. Each change is one
//! transaction with its audit row; the unique index and the foreign keys refuse
//! as well if a check here is ever wrong.

use std::collections::HashMap;

use sqlx::{SqliteConnection, SqlitePool};

use crate::data::repositories::catalog::brand as repo;
use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::catalog::{
    can_delete_brand, is_default_brand, Brand, BrandDeviceType, BrandError, BrandId, BrandName,
    CatalogError, DEFAULT_BRANDS,
};
use crate::domain::identity::{DomainError, Permission, Session, Timestamp, UserId};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// Everything a brand or phone use case can refuse, in three vocabularies the
/// command layer flattens into one stable code.
#[derive(Debug)]
pub enum BrandServiceError {
    Identity(DomainError),
    Brand(BrandError),
    Catalog(CatalogError),
}

impl From<DomainError> for BrandServiceError {
    fn from(error: DomainError) -> Self {
        Self::Identity(error)
    }
}

impl From<BrandError> for BrandServiceError {
    fn from(error: BrandError) -> Self {
        Self::Brand(error)
    }
}

impl From<CatalogError> for BrandServiceError {
    fn from(error: CatalogError) -> Self {
        Self::Catalog(error)
    }
}

impl BrandServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Identity(error) => error.code(),
            Self::Brand(error) => error.code(),
            Self::Catalog(error) => error.code(),
        }
    }
}

impl std::fmt::Display for BrandServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for BrandServiceError {}

/// One brand as the settings list shows it.
#[derive(Debug, Clone)]
pub struct BrandEntry {
    pub brand: Brand,
    /// Live phones of this company.
    pub products: i64,
    pub is_default: bool,
    /// Whether [`delete`] would accept it now.
    pub deletable: bool,
}

/// Up or down in the owner's list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrandStep {
    Up,
    Down,
}

pub(crate) fn storage(_: sqlx::Error) -> BrandServiceError {
    BrandServiceError::Identity(DomainError::StorageUnavailable)
}

/// SQLite's text for a broken UNIQUE constraint; on `brands` only the name has one.
fn is_unique_violation(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(e) => e.to_string().contains("UNIQUE constraint failed"),
        _ => false,
    }
}

/// Resolve the current operator and require catalogue management.
pub(crate) async fn authorize(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Session, BrandServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    Ok(session)
}

async fn load(conn: &mut SqliteConnection, id: BrandId) -> Result<Brand, BrandServiceError> {
    Ok(repo::find_by_id(conn, id)
        .await
        .map_err(storage)?
        .ok_or(BrandError::NotFound)?)
}

fn detail(value: serde_json::Value) -> Option<String> {
    Some(value.to_string())
}

/// Every brand in the owner's order, with its live phones and what may be done.
pub async fn list(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Vec<BrandEntry>, BrandServiceError> {
    authorize(pool, tokens).await?;
    let mut conn = pool.acquire().await.map_err(storage)?;
    let brands = repo::list_all(&mut conn).await.map_err(storage)?;
    let counts: HashMap<String, i64> = repo::active_product_counts(&mut conn)
        .await
        .map_err(storage)?
        .into_iter()
        .collect();
    let mut entries = Vec::with_capacity(brands.len());
    for brand in brands {
        let all_products = repo::count_products(&mut conn, brand.id).await.map_err(storage)?;
        entries.push(BrandEntry {
            products: counts.get(&brand.id.as_str()).copied().unwrap_or(0),
            is_default: is_default_brand(brand.id),
            deletable: can_delete_brand(brand.id, all_products).is_ok(),
            brand,
        });
    }
    Ok(entries)
}

/// Add a company at the end of the list.
pub async fn create(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    name: &str,
    device_type: BrandDeviceType,
) -> Result<Brand, BrandServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();
    let name = BrandName::new(name)?;

    let mut tx = pool.begin().await.map_err(storage)?;
    if repo::name_taken(&mut tx, &name, None).await.map_err(storage)? {
        return Err(BrandError::NameTaken.into());
    }
    let last = repo::list_all(&mut tx)
        .await
        .map_err(storage)?
        .iter()
        .map(|brand| brand.sort_order)
        .max()
        .unwrap_or(0);
    let brand = Brand::new(name, device_type, last + 10, actor, now.as_millis());
    if let Err(error) = repo::insert(&mut tx, &brand).await {
        return Err(if is_unique_violation(&error) {
            BrandError::NameTaken.into()
        } else {
            storage(error)
        });
    }
    audit::append(
        &mut tx,
        actor,
        audit::event::BRAND_CREATED,
        now,
        detail(serde_json::json!({
            "target": brand.id.as_str(),
            "name": brand.name.as_str(),
            "device_type": brand.device_type.as_str(),
        })),
    )
    .await
    .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(brand)
}

/// Rename a company. Its phones keep the names they were registered with.
pub async fn rename(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: BrandId,
    name: &str,
) -> Result<Brand, BrandServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();
    let name = BrandName::new(name)?;

    let mut tx = pool.begin().await.map_err(storage)?;
    let mut brand = load(&mut tx, id).await?;
    if brand.name == name {
        return Ok(brand);
    }
    if repo::name_taken(&mut tx, &name, Some(id)).await.map_err(storage)? {
        return Err(BrandError::NameTaken.into());
    }
    let previous = brand.name.as_str().to_string();
    brand.name = name;
    brand.touched(actor, now.as_millis());
    if let Err(error) = repo::update(&mut tx, &brand).await {
        return Err(if is_unique_violation(&error) {
            BrandError::NameTaken.into()
        } else {
            storage(error)
        });
    }
    audit::append(
        &mut tx,
        actor,
        audit::event::BRAND_UPDATED,
        now,
        detail(serde_json::json!({
            "target": id.as_str(),
            "renamed_from": previous,
            "name": brand.name.as_str(),
        })),
    )
    .await
    .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(brand)
}

/// Touch, keypad or both: which phones «موبايل جديد» offers it for. Phones
/// already registered keep their own device type.
pub async fn set_device_type(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: BrandId,
    device_type: BrandDeviceType,
) -> Result<Brand, BrandServiceError> {
    change(pool, tokens, id, |brand| {
        if brand.device_type == device_type {
            return None;
        }
        brand.device_type = device_type;
        Some(serde_json::json!({ "target": id.as_str(), "device_type": device_type.as_str() }))
    })
    .await
}

/// Show or hide a company in «موبايل جديد».
pub async fn set_hidden(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: BrandId,
    hidden: bool,
) -> Result<Brand, BrandServiceError> {
    change(pool, tokens, id, |brand| {
        if brand.hidden == hidden {
            return None;
        }
        brand.hidden = hidden;
        Some(serde_json::json!({ "target": id.as_str(), "hidden": hidden }))
    })
    .await
}

/// One small change on one brand: `apply` changes it and says what to record,
/// or `None` when there is nothing to change (and nothing is written).
async fn change(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: BrandId,
    apply: impl FnOnce(&mut Brand) -> Option<serde_json::Value>,
) -> Result<Brand, BrandServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();
    let mut tx = pool.begin().await.map_err(storage)?;
    let mut brand = load(&mut tx, id).await?;
    let Some(what) = apply(&mut brand) else {
        return Ok(brand);
    };
    brand.touched(actor, now.as_millis());
    repo::update(&mut tx, &brand).await.map_err(storage)?;
    audit::append(&mut tx, actor, audit::event::BRAND_UPDATED, now, detail(what))
        .await
        .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(brand)
}

/// Move a company one place; at either end nothing changes. The list is
/// numbered afresh (10, 20, 30…) so ties cannot make a move do nothing.
pub async fn move_brand(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: BrandId,
    step: BrandStep,
) -> Result<Brand, BrandServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();
    let mut tx = pool.begin().await.map_err(storage)?;
    let mut order = repo::list_all(&mut tx).await.map_err(storage)?;
    let Some(at) = order.iter().position(|brand| brand.id == id) else {
        return Err(BrandError::NotFound.into());
    };
    let to = match step {
        BrandStep::Up if at > 0 => at - 1,
        BrandStep::Down if at + 1 < order.len() => at + 1,
        _ => return Ok(order.swap_remove(at)),
    };
    order.swap(at, to);
    let mut moved = None;
    for (position, brand) in order.iter_mut().enumerate() {
        let wanted = (position as i64 + 1) * 10;
        if brand.sort_order != wanted {
            brand.sort_order = wanted;
            brand.touched(actor, now.as_millis());
            repo::update(&mut tx, brand).await.map_err(storage)?;
        }
        if brand.id == id {
            moved = Some(brand.clone());
        }
    }
    let direction = match step {
        BrandStep::Up => "up",
        BrandStep::Down => "down",
    };
    audit::append(
        &mut tx,
        actor,
        audit::event::BRAND_UPDATED,
        now,
        detail(serde_json::json!({ "target": id.as_str(), "moved": direction })),
    )
    .await
    .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    moved.ok_or_else(|| BrandError::NotFound.into())
}

/// Delete a company the owner added that has no phone, archived ones included.
pub async fn delete(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: BrandId,
) -> Result<(), BrandServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();
    let mut tx = pool.begin().await.map_err(storage)?;
    let brand = load(&mut tx, id).await?;
    let products = repo::count_products(&mut tx, id).await.map_err(storage)?;
    can_delete_brand(id, products)?;
    if repo::delete(&mut tx, id).await.map_err(storage)? != 1 {
        return Err(BrandError::NotFound.into());
    }
    audit::append(
        &mut tx,
        actor,
        audit::event::BRAND_DELETED,
        now,
        detail(serde_json::json!({ "target": id.as_str(), "name": brand.name.as_str() })),
    )
    .await
    .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(())
}

/// Add the missing default companies, attributed to `actor`; never over a
/// company that already has the name.
async fn add_missing_defaults(
    conn: &mut SqliteConnection,
    actor: UserId,
    now: Timestamp,
) -> Result<usize, sqlx::Error> {
    let mut added = 0usize;
    for default in DEFAULT_BRANDS.iter() {
        let id = default.brand_id();
        if repo::find_by_id(conn, id).await?.is_some() {
            continue;
        }
        let Ok(name) = BrandName::new(default.name) else {
            continue;
        };
        if repo::name_taken(conn, &name, None).await? {
            continue;
        }
        let mut brand = Brand::new(name, default.device_type, default.sort_order, actor, now.as_millis());
        brand.id = id;
        repo::insert(conn, &brand).await?;
        added += 1;
    }
    Ok(added)
}

/// Add the missing default companies, attributed to the longest-serving active
/// manager, in one transaction — right after setup and on every start-up, like
/// the default categories. With no manager yet nothing is added.
pub async fn add_default_brands(pool: &SqlitePool) -> Result<usize, DomainError> {
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
            audit::event::DEFAULT_BRANDS_ADDED,
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
