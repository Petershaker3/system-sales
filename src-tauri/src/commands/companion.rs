//! Tauri commands for the LAN companion server & mobile helper (`ADR-037`,
//! `ADR-042`, Plan item 3.2).
//!
//! Transport boundary only: no SQL and no session construction appears here.
//!
//! Two of these commands open a socket to another machine (`companion_connect_host`,
//! `companion_push_captures`). They hand that work to a blocking thread: a laptop
//! asleep at the other end of the shop answers nothing, and a runtime worker parked
//! for seconds on a two-and-a-half second timeout is a way to stall the app.

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::domain::companion::{
    CompanionIntakeDraft, CompanionLinkError, CompanionProbe, CompanionScanItem, CompanionStatus,
};
use crate::domain::identity::DomainError;
use crate::services::catalog::CatalogContext;
use crate::services::companion as use_cases;
use crate::services::identity::IdentityContext;

type Ctx<'a> = State<'a, IdentityContext>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionCommandError {
    pub code: &'static str,
}

impl From<DomainError> for CompanionCommandError {
    fn from(error: DomainError) -> Self {
        Self { code: error.code() }
    }
}

impl From<CompanionLinkError> for CompanionCommandError {
    fn from(error: CompanionLinkError) -> Self {
        Self { code: error.code() }
    }
}

/// Where this phone's captures are going, and whether that machine answered.
///
/// The address is saved even when nothing answered: pairing happens in the morning
/// with the computer still switched off, and it is the push that has to wait
/// (`ADR-042`). What `detail` reports is the handshake, never a hope.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionLinkResult {
    pub ok: bool,
    pub detail: String,
    pub status: CompanionStatus,
}

/// An applied draft beside the inbox it left, so the panel can say what happened
/// to *this* capture rather than re-reading a list that no longer holds it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionIntakeApplied {
    pub status: CompanionStatus,
    pub draft: CompanionIntakeDraft,
}

/// The same local data directory the catalogue writes its thumbnails into.
fn resolve_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, CompanionCommandError> {
    app.path()
        .app_local_data_dir()
        .map_err(|_| CompanionCommandError {
            code: DomainError::StorageUnavailable.code(),
        })
}

#[tauri::command]
pub async fn companion_overview(ctx: Ctx<'_>) -> Result<CompanionStatus, CompanionCommandError> {
    Ok(use_cases::overview(&ctx.pool, ctx.tokens.as_ref()).await?)
}

#[tauri::command]
pub async fn pair_companion_device(
    ctx: Ctx<'_>,
    name: String,
    model: String,
) -> Result<CompanionStatus, CompanionCommandError> {
    Ok(use_cases::pair_device(&ctx.pool, ctx.tokens.as_ref(), &name, &model).await?)
}

#[tauri::command]
pub async fn unpair_companion_device(
    ctx: Ctx<'_>,
    device_id: String,
) -> Result<CompanionStatus, CompanionCommandError> {
    Ok(use_cases::unpair_device(&ctx.pool, ctx.tokens.as_ref(), &device_id).await?)
}

#[tauri::command]
pub async fn push_companion_scan(
    ctx: Ctx<'_>,
    target: String,
    code: String,
    product_id: Option<String>,
    product_name: Option<String>,
    device_name: String,
) -> Result<CompanionStatus, CompanionCommandError> {
    Ok(use_cases::push_scan(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &target,
        &code,
        product_id,
        product_name,
        &device_name,
    )
    .await?)
}

#[tauri::command]
pub async fn consume_companion_scans(
    ctx: Ctx<'_>,
    target: String,
) -> Result<Vec<CompanionScanItem>, CompanionCommandError> {
    Ok(use_cases::consume_scans(&ctx.pool, ctx.tokens.as_ref(), &target).await?)
}

#[tauri::command]
pub async fn set_companion_remote(
    ctx: Ctx<'_>,
    enabled: bool,
) -> Result<CompanionStatus, CompanionCommandError> {
    Ok(use_cases::set_remote_follow_up(&ctx.pool, ctx.tokens.as_ref(), enabled).await?)
}

/// Point this phone at a shop computer and complete the handshake (`ADR-042`).
///
/// The pairing QR is scanned on the phone; the desktop's list of connected handsets
/// grows from the hello sent here, which is the only reason a device appears in it.
#[tauri::command]
pub async fn companion_connect_host(
    ctx: Ctx<'_>,
    host: String,
    pair_code: String,
    device_name: String,
    device_model: String,
) -> Result<CompanionLinkResult, CompanionCommandError> {
    let status = use_cases::save_host(&ctx.pool, ctx.tokens.as_ref(), &host, &pair_code).await?;
    let probe = tauri::async_runtime::spawn_blocking(move || {
        use_cases::lan_introduce(&host, &pair_code, &device_name, &device_model)
    })
    .await
    .map_err(|_| CompanionCommandError {
        code: DomainError::StorageUnavailable.code(),
    })?;
    Ok(CompanionLinkResult {
        ok: probe.ok,
        detail: probe.detail,
        status,
    })
}

/// Ask the shop computer whether this program is the one answering (`ADR-042`).
#[tauri::command]
pub async fn companion_probe_host(
    ctx: Ctx<'_>,
    host: String,
    port: u16,
) -> Result<CompanionProbe, CompanionCommandError> {
    use_cases::authorize_probe(&ctx.pool, ctx.tokens.as_ref()).await?;
    let probe = tauri::async_runtime::spawn_blocking(move || use_cases::lan_probe(&host, port))
        .await
        .map_err(|_| CompanionCommandError {
            code: DomainError::StorageUnavailable.code(),
        })?;
    Ok(probe)
}

/// Keep a capture this phone made until the shop computer takes it (`ADR-042`).
#[tauri::command]
pub async fn companion_save_capture(
    ctx: Ctx<'_>,
    draft: CompanionIntakeDraft,
) -> Result<CompanionStatus, CompanionCommandError> {
    Ok(use_cases::save_capture(&ctx.pool, ctx.tokens.as_ref(), &draft).await?)
}

/// Send everything waiting on this phone to the shop computer (`ADR-042`).
#[tauri::command]
pub async fn companion_push_captures(
    ctx: Ctx<'_>,
) -> Result<CompanionLinkResult, CompanionCommandError> {
    let pending = use_cases::outbox_pending(&ctx.pool, ctx.tokens.as_ref()).await?;
    let Some(pending) = pending else {
        let status = use_cases::overview(&ctx.pool, ctx.tokens.as_ref()).await?;
        return Ok(CompanionLinkResult {
            ok: true,
            detail: "مفيش حاجة مستنية على الموبايل".to_string(),
            status,
        });
    };
    let results = tauri::async_runtime::spawn_blocking(move || use_cases::push_pending(pending))
        .await
        .map_err(|_| CompanionCommandError {
            code: DomainError::StorageUnavailable.code(),
        })?;
    let failed = results.iter().filter(|(_, done)| done.is_err()).count();
    // No count is quoted here: a Rust string that reaches a shop window carries no
    // western digits, and the panel below the toast lists the rows one by one anyway.
    let detail = if failed == 0 {
        "الكمبيوتر أخد كل المسودات — هو اللي بيقرر امتى ينزّلها في الاستلام".to_string()
    } else {
        match results.iter().find_map(|(_, done)| done.as_ref().err()) {
            Some(reason) => reason.clone(),
            None => "بعض المسودات وصلت وبعضها لسه مستني".to_string(),
        }
    };
    let status = use_cases::record_push_results(&ctx.pool, ctx.tokens.as_ref(), results).await?;
    Ok(CompanionLinkResult {
        ok: failed == 0,
        detail,
        status,
    })
}

/// Forget the captures this phone already sent (`ADR-042`).
#[tauri::command]
pub async fn companion_clear_outbox(
    ctx: Ctx<'_>,
) -> Result<CompanionStatus, CompanionCommandError> {
    Ok(use_cases::clear_outbox(&ctx.pool, ctx.tokens.as_ref()).await?)
}

/// Apply one captured draft, through the ordinary audited receipt (`ADR-042`).
#[tauri::command]
pub async fn companion_accept_intake(
    ctx: Ctx<'_>,
    catalog: State<'_, CatalogContext>,
    app: AppHandle,
    intake_id: String,
) -> Result<CompanionIntakeApplied, CompanionCommandError> {
    let data_dir = resolve_data_dir(&app)?;
    let (status, draft) = use_cases::accept_intake(
        &ctx.pool,
        ctx.tokens.as_ref(),
        catalog.inner(),
        &data_dir,
        &intake_id,
    )
    .await?;
    Ok(CompanionIntakeApplied { status, draft })
}

/// Refuse one captured draft without touching the ledger (`ADR-042`).
#[tauri::command]
pub async fn companion_reject_intake(
    ctx: Ctx<'_>,
    intake_id: String,
) -> Result<CompanionStatus, CompanionCommandError> {
    Ok(use_cases::reject_intake(&ctx.pool, ctx.tokens.as_ref(), &intake_id).await?)
}

/// A fresh pairing code, so a phone that left the shop cannot keep pushing (`ADR-042`).
#[tauri::command]
pub async fn companion_rotate_pair_code(
    ctx: Ctx<'_>,
) -> Result<CompanionStatus, CompanionCommandError> {
    Ok(use_cases::rotate_pair_code(&ctx.pool, ctx.tokens.as_ref()).await?)
}
