//! Tauri commands for device settings (SP-1b, `plan` Task 9).
//!
//! Transport boundaries only. No SQL and no business rule appears here, and no
//! command accepts a session, token or role: the operator is resolved from the
//! OS credential store inside the use case.

use serde::Serialize;
use tauri::State;

use crate::domain::settings::{Appearance, SettingsSnapshot};
use crate::services::identity::IdentityContext;
use crate::services::settings::{self as use_cases, SettingsServiceError};

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure crossing the boundary is a stable code, never prose.
/// `spec:127` keeps user-facing text in Arabic message files on the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsCommandError {
    pub code: &'static str,
}

impl From<SettingsServiceError> for SettingsCommandError {
    fn from(error: SettingsServiceError) -> Self {
        Self { code: error.code() }
    }
}

/// The snapshot as the frontend sees it.
///
/// `defaultVatRateBp` is nullable and the null is meaningful: never set, as
/// distinct from a recorded `0`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshotDto {
    pub default_cost_method: String,
    pub invoice_prefix: String,
    pub default_vat_enabled: bool,
    pub default_vat_rate_bp: Option<i64>,
    pub default_vat_inclusive: bool,
    pub max_discount_kind: String,
    pub max_discount_value: u64,
}

impl From<SettingsSnapshot> for SettingsSnapshotDto {
    fn from(snapshot: SettingsSnapshot) -> Self {
        Self {
            default_cost_method: snapshot.default_cost_method.as_str().to_string(),
            invoice_prefix: snapshot.invoice_prefix,
            default_vat_enabled: snapshot.default_vat_enabled,
            default_vat_rate_bp: snapshot
                .default_vat_rate_bp
                .map(|rate| rate.as_basis_points()),
            default_vat_inclusive: snapshot.default_vat_inclusive,
            max_discount_kind: snapshot.max_discount_kind.as_str().to_string(),
            max_discount_value: snapshot.max_discount_value,
        }
    }
}

/// The device's configuration, defaults applied for anything never set.
#[tauri::command]
pub async fn read_settings(
    ctx: Ctx<'_>,
) -> Result<SettingsSnapshotDto, SettingsCommandError> {
    let snapshot = use_cases::read_snapshot(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(snapshot.into())
}

/// Change one setting. Unknown keys and malformed values are refused by the
/// domain before anything is written.
#[tauri::command]
pub async fn update_setting(
    ctx: Ctx<'_>,
    key: String,
    value: String,
) -> Result<(), SettingsCommandError> {
    use_cases::update(&ctx.pool, ctx.tokens.as_ref(), &key, &value).await?;
    Ok(())
}

/// The display choices as the frontend sees them (DESIGN.md).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceDto {
    pub look: String,
    pub theme: String,
    pub accent: String,
    pub font: String,
    pub scale: String,
    pub digits: String,
    pub images: String,
    pub imei_mode: String,
    pub pay_methods: String,
    pub discount_limit_pct: String,
    pub shop_name: String,
    pub shop_phone: String,
    pub shop_address: String,
    pub receipt_footer: String,
    pub wa_template: String,
    pub receipt_mode: String,
    pub printer_enabled: String,
    pub receipt_paper: String,
    pub warranty_new: String,
    pub warranty_used: String,
    pub warranty_item: String,
}

impl From<Appearance> for AppearanceDto {
    fn from(a: Appearance) -> Self {
        Self {
            look: a.look,
            theme: a.theme,
            accent: a.accent,
            font: a.font,
            scale: a.scale,
            digits: a.digits,
            images: a.images,
            imei_mode: a.imei_mode,
            pay_methods: a.pay_methods,
            discount_limit_pct: a.discount_limit_pct,
            shop_name: a.shop_name,
            shop_phone: a.shop_phone,
            shop_address: a.shop_address,
            receipt_footer: a.receipt_footer,
            wa_template: a.wa_template,
            receipt_mode: a.receipt_mode,
            printer_enabled: a.printer_enabled,
            receipt_paper: a.receipt_paper,
            warranty_new: a.warranty_new,
            warranty_used: a.warranty_used,
            warranty_item: a.warranty_item,
        }
    }
}


/// The display choices. Needs no session: the sign-in screen is drawn in them,
/// and they are neither business data nor secret.
#[tauri::command]
pub async fn read_appearance(ctx: Ctx<'_>) -> Result<AppearanceDto, SettingsCommandError> {
    let appearance = use_cases::appearance::read(&ctx.pool).await?;
    Ok(appearance.into())
}

/// Change one display choice (`ui.look`, `ui.theme`, `ui.accent`, `ui.font`,
/// `ui.scale`, `ui.digits`). The theme is for everyone; the rest is the
/// owner's, with a fresh password. Returns every choice after the change.
#[tauri::command]
pub async fn update_appearance(
    ctx: Ctx<'_>,
    key: String,
    value: String,
) -> Result<AppearanceDto, SettingsCommandError> {
    let appearance =
        use_cases::appearance::update(&ctx.pool, ctx.tokens.as_ref(), &key, &value).await?;
    Ok(appearance.into())
}
