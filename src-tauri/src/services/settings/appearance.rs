//! Display choices: read before sign-in, changed by the owner — except the
//! light/dark switch, which is for whoever works the counter.
//!
//! # Authorization
//!
//! - `read` needs no session. The sign-in screen is drawn in the shop's look,
//!   and nothing here is business data or secret.
//! - `update` of the theme needs `Permission::Sell`, which every role holds:
//!   it is the switch on the rail.
//! - `update` of anything else needs `Permission::ManageSettings`, with the
//!   same fresh password every other setting needs.
//!
//! Every change is validated before it is written and audited as
//! `setting_changed`, exactly like the other settings.

use sqlx::SqlitePool;

use super::SettingsServiceError;
use crate::data::repositories::identity::audit;
use crate::data::repositories::settings::app_settings as repo;
use crate::domain::identity::{DomainError, Permission, Timestamp};
use crate::domain::settings::{Appearance, AppearanceKey, SettingsError};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// The display choices, defaults applied for anything never set.
pub async fn read(pool: &SqlitePool) -> Result<Appearance, SettingsServiceError> {
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let appearance = repo::load_appearance(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(appearance)
}

/// Change one display choice and return all of them.
pub async fn update(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    key: &str,
    value: &str,
) -> Result<Appearance, SettingsServiceError> {
    let parsed = AppearanceKey::parse(key).ok_or_else(|| SettingsError::UnknownKey {
        key: key.to_owned(),
    })?;

    let session = identity_session::resolve(pool, tokens).await?;
    if parsed.is_for_everyone() {
        session.authorize(Permission::Sell)?;
    } else if parsed.is_catalog_choice() {
        session.authorize(Permission::ManageCatalog)?;
    } else {
        session.authorize(Permission::ManageSettings)?;
    }


    // Validation before storage, through the same `set` the read applies.
    let mut validated = Appearance::default();
    validated.set(key, value)?;
    let stored = match parsed {
        AppearanceKey::Look => validated.look,
        AppearanceKey::Theme => validated.theme,
        AppearanceKey::Accent => validated.accent,
        AppearanceKey::Font => validated.font,
        AppearanceKey::Scale => validated.scale,
        AppearanceKey::Digits => validated.digits,
        AppearanceKey::Images => validated.images,
        AppearanceKey::ImeiMode => validated.imei_mode,
        AppearanceKey::PayMethods => validated.pay_methods,
        AppearanceKey::DiscountLimitPct => validated.discount_limit_pct,
        AppearanceKey::ShopName => validated.shop_name,
        AppearanceKey::ShopPhone => validated.shop_phone,
        AppearanceKey::ShopAddress => validated.shop_address,
        AppearanceKey::ReceiptFooter => validated.receipt_footer,
        AppearanceKey::WaTemplate => validated.wa_template,
        AppearanceKey::ReceiptMode => validated.receipt_mode,
        AppearanceKey::PrinterEnabled => validated.printer_enabled,
        AppearanceKey::ReceiptPaper => validated.receipt_paper,
        AppearanceKey::WarrantyNew => validated.warranty_new,
        AppearanceKey::WarrantyUsed => validated.warranty_used,
        AppearanceKey::WarrantyItem => validated.warranty_item,
    };
    let now = Timestamp::now();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let actor = session.user_id();
    repo::set(&mut tx, parsed.as_str(), &stored, &actor.as_str(), now.as_millis())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        actor,
        audit::event::SETTING_CHANGED,
        now,
        Some(serde_json::json!({ "key": parsed.as_str(), "value": stored }).to_string()),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    let appearance = repo::load_appearance(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(appearance)
}
