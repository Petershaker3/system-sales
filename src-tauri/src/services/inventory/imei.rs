//! Giving a device its real IMEI after it was registered without one.
//!
//! The owner's rule for used handsets is «خلي الايمي مش اجباري»: a device with
//! no IMEI gets the shop's own stand-in number (`000000000000018`) and every
//! screen writes it «بدون IMEI». The stand-in is a placeholder, never a fact —
//! so it has to be replaceable with the number printed on the box, and only
//! while the piece is still on the shelf (a sold phone's IMEI is part of a
//! receipt and must not move afterwards).
//!
//! Authorisation: `Permission::ManageInventory`. Correcting a registered device
//! is inventory work, not a display choice.

use sqlx::SqlitePool;

use crate::data::repositories::inventory::unit as repo;
use crate::domain::identity::{DomainError, Permission};
use crate::domain::unit::{Imei, UnitError};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// Every failure crossing the boundary as a stable code, never prose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetImeiError {
    /// Not 15 digits after stripping spaces and dashes.
    LengthInvalid,
    /// The Luhn check digit does not match the first fourteen.
    CheckDigitInvalid,
    /// Another piece in the shop already carries this number.
    AlreadyRegistered,
    /// No such unit, or it has been sold or retired since it was listed.
    NotAvailable,
    /// The database refused the write.
    Storage,
    /// The operator may not change registered devices.
    PermissionDenied,
}

impl SetImeiError {
    pub fn code(&self) -> &'static str {
        match self {
            SetImeiError::LengthInvalid => "IMEI_LENGTH_INVALID",
            SetImeiError::CheckDigitInvalid => "IMEI_CHECK_DIGIT_INVALID",
            SetImeiError::AlreadyRegistered => "IMEI_ALREADY_REGISTERED",
            SetImeiError::NotAvailable => "IMEI_UNIT_NOT_AVAILABLE",
            SetImeiError::Storage => "STORAGE_UNAVAILABLE",
            SetImeiError::PermissionDenied => "PERMISSION_DENIED",
        }
    }

    fn from_domain(error: DomainError) -> Self {
        match error.code() {
            "PERMISSION_DENIED" => SetImeiError::PermissionDenied,
            _ => SetImeiError::Storage,
        }
    }
}

/// Replace a unit's IMEI with the real one, returning it as stored.
pub async fn set_imei(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    unit_id: &str,
    raw: &str,
) -> Result<String, SetImeiError> {
    let session = identity_session::resolve(pool, tokens)
        .await
        .map_err(SetImeiError::from_domain)?;
    session
        .authorize(Permission::ManageInventory)
        .map_err(SetImeiError::from_domain)?;

    let imei = Imei::parse(raw).map_err(|error| match error {
        UnitError::ImeiLengthInvalid => SetImeiError::LengthInvalid,
        UnitError::ImeiCheckDigitInvalid => SetImeiError::CheckDigitInvalid,
        _ => SetImeiError::LengthInvalid,
    })?;

    let mut tx = pool.begin().await.map_err(|_| SetImeiError::Storage)?;
    let unit = repo::find_by_id(&mut *tx, unit_id)
        .await
        .map_err(|_| SetImeiError::Storage)?
        .ok_or(SetImeiError::NotAvailable)?;

    if unit.status != "in_stock" {
        return Err(SetImeiError::NotAvailable);
    }
    if unit.imei == imei.as_str() {
        return Ok(imei.as_str().to_string());
    }
    if repo::find_by_imei(&mut *tx, imei.as_str())
        .await
        .map_err(|_| SetImeiError::Storage)?
        .is_some()
    {
        return Err(SetImeiError::AlreadyRegistered);
    }

    let changed = repo::update_imei(&mut *tx, unit_id, imei.as_str())
        .await
        .map_err(|_| SetImeiError::Storage)?;
    if changed == 0 {
        return Err(SetImeiError::NotAvailable);
    }
    tx.commit().await.map_err(|_| SetImeiError::Storage)?;
    Ok(imei.as_str().to_string())
}
