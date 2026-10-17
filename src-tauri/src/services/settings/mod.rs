//! Settings use cases (SP-1b, `plan` Task 9): `read_snapshot`, `update`.
//!
//! # Authorization
//!
//! Both require `Permission::ManageSettings`, whose blanket re-authentication
//! requirement (`plan` Task 5) means the session must have proved its password
//! freshly — reading the snapshot included, because the panel exists to change
//! it and half-opening it would be a distinction no operator will feel.
//!
//! # Validation before storage
//!
//! `update` validates through [`SettingsSnapshot::set`] — the same function the
//! read path uses — so a key or value one side would refuse, the other refuses
//! too. Nothing is written before validation passes.

pub mod appearance;

use std::fmt;

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::settings::app_settings as repo;
use crate::domain::identity::{DomainError, Permission, Session, Timestamp};
use crate::domain::settings::{SettingsError, SettingsSnapshot};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// Everything this service can refuse: identity failures (no session, no
/// permission, storage down) and settings failures (unknown key, malformed
/// value). Flattened to one stable code at the command boundary.
#[derive(Debug)]
pub enum SettingsServiceError {
    Identity(DomainError),
    Settings(SettingsError),
}

impl From<DomainError> for SettingsServiceError {
    fn from(error: DomainError) -> Self {
        Self::Identity(error)
    }
}

impl From<SettingsError> for SettingsServiceError {
    fn from(error: SettingsError) -> Self {
        Self::Settings(error)
    }
}

impl SettingsServiceError {
    /// Delegates to the two domain enums; this layer invents no codes, so the
    /// drift guard keeps covering everything the frontend can see.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Identity(error) => error.code(),
            Self::Settings(error) => error.code(),
        }
    }
}

impl fmt::Display for SettingsServiceError {
    /// Developer-facing only; the operator reads the Arabic message indexed by
    /// [`SettingsServiceError::code`].
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Identity(error) => write!(f, "{error}"),
            Self::Settings(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SettingsServiceError {}

/// Resolve the current operator and require settings management.
async fn authorize(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Session, SettingsServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageSettings)?;
    Ok(session)
}

/// The device's configuration with defaults applied for anything never set.
pub async fn read_snapshot(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<SettingsSnapshot, SettingsServiceError> {
    authorize(pool, tokens).await?;

    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let snapshot = repo::load_snapshot(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(snapshot)
}

/// Change one setting: validate, then write the row and its audit event in one
/// transaction.
///
/// The audit detail carries key and value as plain JSON — settings values are
/// configuration, never secrets — built with `serde_json` so a value containing
/// quotes cannot corrupt the record.
pub async fn update(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    key: &str,
    value: &str,
) -> Result<(), SettingsServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();

    // Validation before storage: an unknown key or a value this key cannot
    // hold is refused without a write, and the probe uses the same `set` the
    // read path will later apply to the stored row.
    SettingsSnapshot::default().set(key, value)?;

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let actor = session.user_id();
    repo::set(
        &mut tx,
        key,
        value,
        &actor.as_str(),
        now.as_millis(),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        actor,
        audit::event::SETTING_CHANGED,
        now,
        Some(
            serde_json::json!({ "key": key, "value": value }).to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}
