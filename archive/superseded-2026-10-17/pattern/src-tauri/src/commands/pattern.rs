//! Tauri commands for Pattern approval (SP-1b, `plan` Task 9).
//!
//! Transport boundaries only. No SQL and no business rule appears here, and no
//! command accepts a session, token, role or actor: the operator is resolved
//! from the OS credential store inside the use case. The entered Pattern or
//! password travels as a parameter because that is precisely what the operator
//! typed at this moment — it is verified and discarded, never stored or logged.

use tauri::State;

use crate::commands::identity::CommandError;
use crate::services::identity::IdentityContext;
use crate::services::pattern::{self as use_cases, PatternStatus};

type Ctx<'a> = State<'a, IdentityContext>;

/// Whether protection is on and whether a Pattern exists to check against.
#[tauri::command]
pub async fn get_pattern_status(ctx: Ctx<'_>) -> Result<PatternStatus, CommandError> {
    Ok(use_cases::status(&ctx.pool, ctx.tokens.as_ref()).await?)
}

/// Check the entered Pattern and stamp this session's five-minute approval.
///
/// A wrong Pattern is `INVALID_CREDENTIALS`; an unconfigured one is
/// `PATTERN_NOT_CONFIGURED`. No audit event either way (`plan` Task 7).
#[tauri::command]
pub async fn verify_pattern(ctx: Ctx<'_>, pattern: String) -> Result<(), CommandError> {
    Ok(use_cases::verify(&ctx.pool, ctx.tokens.as_ref(), &pattern).await?)
}

/// Set (or replace) the Pattern and switch protection on.
///
/// Requires `ManageSettings`, whose blanket rule means the session must have
/// re-authenticated freshly; the Pattern must satisfy the password policy.
#[tauri::command]
pub async fn set_pattern(ctx: Ctx<'_>, pattern: String) -> Result<(), CommandError> {
    Ok(use_cases::set(&ctx.pool, ctx.tokens.as_ref(), &pattern).await?)
}

/// Clear the Pattern after re-proving the Manager password — the recovery
/// path for a forgotten Pattern (`plan` Task 9).
#[tauri::command]
pub async fn reset_pattern(ctx: Ctx<'_>, password: String) -> Result<(), CommandError> {
    Ok(use_cases::reset(&ctx.pool, ctx.tokens.as_ref(), &password).await?)
}

/// Switch protection off, keeping the stored Pattern.
#[tauri::command]
pub async fn disable_pattern(ctx: Ctx<'_>) -> Result<(), CommandError> {
    Ok(use_cases::disable(&ctx.pool, ctx.tokens.as_ref()).await?)
}
