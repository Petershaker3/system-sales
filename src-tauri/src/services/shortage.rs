//! Shortages service (`النواقص`, Plan item 1.15, `ADR-030`, `PLAN.md` §11).
//!
//! Orchestrates manual and system-suggested shortages:
//! - Anyone who holds `Permission::Sell` (both `Role::Manager` and `Role::Sales`)
//!   may list, add, change status (`open` <-> `ordered`), and mark arrived (`وصل`).
//! - Only the creator (`created_by == session.user_id`) or a manager (`Role::Manager`)
//!   may delete an entry (`شيله من النواقص`).

use std::fmt;

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::shortage::{self as shortage_repo, NewShortageRow};
use crate::domain::identity::{DomainError, Permission, Role, Timestamp};
use crate::domain::shortage::{
    normalize_shortage_name, validate_customer, validate_name, validate_note, validate_qty,
    ShortageEntry, ShortageError, ShortageId, ShortageStatus, ShortageSuggestion,
};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShortageServiceError {
    Identity(DomainError),
    Shortage(ShortageError),
}

impl ShortageServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            ShortageServiceError::Identity(e) => e.code(),
            ShortageServiceError::Shortage(e) => e.code(),
        }
    }
}

impl fmt::Display for ShortageServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl From<DomainError> for ShortageServiceError {
    fn from(value: DomainError) -> Self {
        ShortageServiceError::Identity(value)
    }
}

impl From<ShortageError> for ShortageServiceError {
    fn from(value: ShortageError) -> Self {
        ShortageServiceError::Shortage(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortagesOverview {
    pub items: Vec<ShortageEntry>,
    pub suggestions: Vec<ShortageSuggestion>,
}

#[derive(Debug, Clone)]
pub struct AddShortageInput {
    pub product_id: Option<String>,
    pub name: Option<String>,
    pub qty: i64,
    pub note: Option<String>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddShortageOutcome {
    pub entry: ShortageEntry,
    pub merged: bool,
}

pub async fn shortages_overview(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<ShortagesOverview, ShortageServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let items = shortage_repo::list_active_shortages(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let suggestions = shortage_repo::list_system_suggestions(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(ShortagesOverview { items, suggestions })
}

pub async fn add_shortage(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: AddShortageInput,
) -> Result<AddShortageOutcome, ShortageServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let qty = validate_qty(input.qty)?;
    let note = validate_note(input.note.as_deref())?;
    let (customer_name, customer_phone) = validate_customer(
        input.customer_name.as_deref(),
        input.customer_phone.as_deref(),
    )?;
    let clean_pid = input
        .product_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    if let Some(pid) = clean_pid {
        let product_name = shortage_repo::find_active_product_name(&mut tx, &pid)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
            .ok_or(ShortageError::NotFound)?;

        if let Some(existing) = shortage_repo::find_active_by_product_id(&mut tx, &pid)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
        {
            shortage_repo::increment_shortage_qty(
                &mut tx,
                &existing.id,
                qty,
                &note,
                customer_name.as_deref(),
                customer_phone.as_deref(),
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

            let updated = shortage_repo::find_active_by_id(&mut tx, &existing.id)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?
                .ok_or(ShortageError::NotFound)?;

            audit::append(
                &mut tx,
                actor,
                audit::event::SHORTAGE_UPDATED,
                now,
                Some(
                    serde_json::json!({
                        "shortage_id": updated.id,
                        "product_id": pid,
                        "added_qty": qty,
                        "new_qty": updated.qty,
                    })
                    .to_string(),
                ),
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

            tx.commit()
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
            return Ok(AddShortageOutcome {
                entry: updated,
                merged: true,
            });
        }

        let new_id = ShortageId::generate();
        shortage_repo::insert_shortage(
            &mut tx,
            &NewShortageRow {
                id: new_id.as_str().to_owned(),
                product_id: Some(pid.clone()),
                name: product_name,
                qty,
                note,
                customer_name,
                customer_phone,
                status: ShortageStatus::Open.as_str().to_owned(),
                created_by: actor.as_str(),
                created_at: now.as_millis(),
            },
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

        let created = shortage_repo::find_active_by_id(&mut tx, new_id.as_str())
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
            .ok_or(ShortageError::NotFound)?;

        audit::append(
            &mut tx,
            actor,
            audit::event::SHORTAGE_ADDED,
            now,
            Some(
                serde_json::json!({
                    "shortage_id": created.id,
                    "product_id": pid,
                    "qty": created.qty,
                })
                .to_string(),
            ),
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

        tx.commit()
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        return Ok(AddShortageOutcome {
            entry: created,
            merged: false,
        });
    }

    let name = validate_name(input.name.as_deref().unwrap_or(""))?;
    let norm = normalize_shortage_name(&name);
    let active = shortage_repo::list_active_shortages(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    if let Some(existing) = active
        .into_iter()
        .find(|x| x.product_id.is_none() && normalize_shortage_name(&x.name) == norm)
    {
        shortage_repo::increment_shortage_qty(
            &mut tx,
            &existing.id,
            qty,
            &note,
            customer_name.as_deref(),
            customer_phone.as_deref(),
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

        let updated = shortage_repo::find_active_by_id(&mut tx, &existing.id)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
            .ok_or(ShortageError::NotFound)?;

        audit::append(
            &mut tx,
            actor,
            audit::event::SHORTAGE_UPDATED,
            now,
            Some(
                serde_json::json!({
                    "shortage_id": updated.id,
                    "added_qty": qty,
                    "new_qty": updated.qty,
                })
                .to_string(),
            ),
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

        tx.commit()
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        return Ok(AddShortageOutcome {
            entry: updated,
            merged: true,
        });
    }

    let new_id = ShortageId::generate();
    shortage_repo::insert_shortage(
        &mut tx,
        &NewShortageRow {
            id: new_id.as_str().to_owned(),
            product_id: None,
            name,
            qty,
            note,
            customer_name,
            customer_phone,
            status: ShortageStatus::Open.as_str().to_owned(),
            created_by: actor.as_str(),
            created_at: now.as_millis(),
        },
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    let created = shortage_repo::find_active_by_id(&mut tx, new_id.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(ShortageError::NotFound)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::SHORTAGE_ADDED,
        now,
        Some(
            serde_json::json!({
                "shortage_id": created.id,
                "qty": created.qty,
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(AddShortageOutcome {
        entry: created,
        merged: false,
    })
}

pub async fn set_shortage_status(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: &str,
    status_raw: &str,
) -> Result<ShortageEntry, ShortageServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let status = ShortageStatus::parse(status_raw)?;

    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let affected = shortage_repo::update_status(&mut tx, id, status.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if affected == 0 {
        return Err(ShortageError::NotFound.into());
    }

    let updated = shortage_repo::find_active_by_id(&mut tx, id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(ShortageError::NotFound)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::SHORTAGE_UPDATED,
        now,
        Some(
            serde_json::json!({
                "shortage_id": id,
                "status": status.as_str(),
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(updated)
}

pub async fn resolve_shortage(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: &str,
) -> Result<ShortageEntry, ShortageServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let mut existing = shortage_repo::find_active_by_id(&mut tx, id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(ShortageError::NotFound)?;

    shortage_repo::resolve_shortage(&mut tx, id, now.as_millis())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    existing.resolved_at = Some(now.as_millis());

    audit::append(
        &mut tx,
        actor,
        audit::event::SHORTAGE_RESOLVED,
        now,
        Some(
            serde_json::json!({
                "shortage_id": id,
                "product_id": existing.product_id,
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(existing)
}

pub async fn delete_shortage(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: &str,
) -> Result<ShortageEntry, ShortageServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let existing = shortage_repo::find_active_by_id(&mut tx, id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(ShortageError::NotFound)?;

    let can_delete = session.role() == Role::Manager || existing.created_by == actor.as_str();
    if !can_delete {
        return Err(ShortageError::DeleteForbidden.into());
    }

    shortage_repo::delete_shortage(&mut tx, id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::SHORTAGE_DELETED,
        now,
        Some(
            serde_json::json!({
                "shortage_id": id,
                "product_id": existing.product_id,
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(existing)
}

pub async fn add_all_suggested_shortages(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Vec<ShortageEntry>, ShortageServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let suggestions = shortage_repo::list_system_suggestions(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let mut added_ids = Vec::with_capacity(suggestions.len());
    for sug in &suggestions {
        let new_id = ShortageId::generate();
        shortage_repo::insert_shortage(
            &mut tx,
            &NewShortageRow {
                id: new_id.as_str().to_owned(),
                product_id: Some(sug.product_id.clone()),
                name: sug.name.clone(),
                qty: sug.suggested_qty,
                note: String::new(),
                customer_name: None,
                customer_phone: None,
                status: ShortageStatus::Open.as_str().to_owned(),
                created_by: actor.as_str(),
                created_at: now.as_millis(),
            },
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
        added_ids.push(new_id.as_str().to_owned());
    }

    if !added_ids.is_empty() {
        audit::append(
            &mut tx,
            actor,
            audit::event::SHORTAGE_ADDED,
            now,
            Some(
                serde_json::json!({
                    "bulk_suggested_count": added_ids.len(),
                })
                .to_string(),
            ),
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    }

    let mut added = Vec::with_capacity(added_ids.len());
    for id in &added_ids {
        if let Some(entry) = shortage_repo::find_active_by_id(&mut tx, id)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
        {
            added.push(entry);
        }
    }

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(added)
}
