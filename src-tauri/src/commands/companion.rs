//! Tauri commands for the LAN companion server & mobile helper (`ADR-037`, Plan item 3.2).
//!
//! Transport boundary only: no SQL and no session construction appears here.

use serde::Serialize;
use tauri::State;

use crate::domain::companion::{CompanionScanItem, CompanionStatus};
use crate::domain::identity::DomainError;
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

#[tauri::command]
pub async fn companion_overview(ctx: Ctx<'_>) -> Result<CompanionStatus, CompanionCommandError> {
    Ok(use_cases::overview(ctx.pool(), ctx.tokens()).await?)
}

#[tauri::command]
pub async fn pair_companion_device(
    ctx: Ctx<'_>,
    name: String,
    model: String,
) -> Result<CompanionStatus, CompanionCommandError> {
    Ok(use_cases::pair_device(ctx.pool(), ctx.tokens(), &name, &model).await?)
}

#[tauri::command]
pub async fn unpair_companion_device(
    ctx: Ctx<'_>,
    device_id: String,
) -> Result<CompanionStatus, CompanionCommandError> {
    Ok(use_cases::unpair_device(ctx.pool(), ctx.tokens(), &device_id).await?)
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
        ctx.pool(),
        ctx.tokens(),
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
    Ok(use_cases::consume_scans(ctx.pool(), ctx.tokens(), &target).await?)
}
