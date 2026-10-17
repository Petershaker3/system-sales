//! Tauri commands for user administration and password management.
//!
//! Transport boundaries only. No SQL and no business rule appears here.
//!
//! # No session, token, role or actor parameter, on purpose
//!
//! No command accepts a token, a user id, a role, or an actor id. Each resolves
//! the current operator from the OS credential store and authorises. That is what
//! makes attribution a fact rather than a claim, and the architecture test that
//! already covers every command module covers this one too.
//!
//! The *target* of an administrative action is a plain id chosen by the manager in
//! the UI. That is not an assertion of identity: the caller may legitimately act on
//! any account the permission permits, and the permission is checked before any
//! write happens.

use serde::Serialize;
use tauri::State;

use crate::domain::identity::{DomainError, Role, Session, UserId};
use crate::services::identity::password as password_use_cases;
use crate::services::identity::pin as pin_use_cases;
use crate::services::identity::session as session_service;
use crate::services::identity::users::{self as user_use_cases, ManagedUser};
use crate::services::identity::IdentityContext;

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure crossing the boundary is a stable code, never prose.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityCommandError {
    pub code: &'static str,
}

impl From<DomainError> for IdentityCommandError {
    fn from(error: DomainError) -> Self {
        Self {
            code: error.code(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedUserDto {
    pub user_id: String,
    pub display_name: String,
    pub username: String,
    pub role: String,
    pub disabled: bool,
    pub must_change_password: bool,
    /// The account has lost its credentials row.
    ///
    /// Carried so the management screen can show the fault and name the account,
    /// instead of the row silently disappearing and leaving an operator with a
    /// shorter list and no explanation.
    pub integrity_fault: bool,
}

impl From<ManagedUser> for ManagedUserDto {
    fn from(user: ManagedUser) -> Self {
        Self {
            user_id: user.user_id.as_str(),
            display_name: user.display_name,
            username: user.username.as_str().to_string(),
            role: user.role.as_str().to_string(),
            disabled: user.disabled,
            must_change_password: user.must_change_password,
            integrity_fault: user.integrity_fault,
        }
    }
}

/// Resolve the signed-in operator, or fail.
async fn require_session(ctx: &IdentityContext) -> Result<Session, DomainError> {
    session_service::resolve(&ctx.pool, ctx.tokens.as_ref()).await
}

fn parse_user_id(raw: &str) -> Result<UserId, DomainError> {
    uuid::Uuid::parse_str(raw)
        .map(UserId::from_uuid)
        .map_err(|_| DomainError::UserNotFound)
}

fn parse_role(raw: &str) -> Result<Role, DomainError> {
    Role::parse(raw).ok_or(DomainError::PermissionDenied)
}

// ---------------------------------------------------------------------------
// Self service
// ---------------------------------------------------------------------------

/// Change the signed-in operator's own password.
///
/// Permitted even while a forced change is pending: this is the one operation
/// such a session may perform.
#[tauri::command]
pub async fn change_own_password(
    ctx: Ctx<'_>,
    current_password: String,
    new_password: String,
) -> Result<(), IdentityCommandError> {
    let session = require_session(&ctx).await.map_err(IdentityCommandError::from)?;

    password_use_cases::change_own_password(
        &ctx.pool,
        &session,
        &current_password,
        &new_password,
    )
    .await
    .map_err(IdentityCommandError::from)?;

    // The in-memory session and the stored row are separate. Leaving the stored
    // assurance elevated would re-authorise the next command with an elevation
    // that was only ever meant to cover this one operation.
    password_use_cases::persist_downgraded_assurance(&ctx.pool, ctx.tokens.as_ref())
        .await
        .map_err(IdentityCommandError::from)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// User administration
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_users_for_management(
    ctx: Ctx<'_>,
) -> Result<Vec<ManagedUserDto>, IdentityCommandError> {
    let session = require_session(&ctx).await.map_err(IdentityCommandError::from)?;
    let users = user_use_cases::list_managed(&ctx.pool, &session)
        .await
        .map_err(IdentityCommandError::from)?;
    Ok(users.into_iter().map(ManagedUserDto::from).collect())
}

#[tauri::command]
pub async fn create_user(
    ctx: Ctx<'_>,
    display_name: String,
    username: String,
    role: String,
    password: String,
) -> Result<String, IdentityCommandError> {
    let session = require_session(&ctx).await.map_err(IdentityCommandError::from)?;
    let id = user_use_cases::create_user(
        &ctx.pool,
        &session,
        &display_name,
        &username,
        parse_role(&role)?,
        &password,
    )
    .await
    .map_err(IdentityCommandError::from)?;
    Ok(id.as_str())
}

/// A manager sets another account's password and forces a change at next sign-in.
#[tauri::command]
pub async fn reset_user_password(
    ctx: Ctx<'_>,
    user_id: String,
    temporary_password: String,
) -> Result<(), IdentityCommandError> {
    let session = require_session(&ctx).await.map_err(IdentityCommandError::from)?;
    password_use_cases::manager_reset_password(
        &ctx.pool,
        &session,
        parse_user_id(&user_id)?,
        &temporary_password,
    )
    .await
    .map_err(IdentityCommandError::from)?;
    Ok(())
}

/// Set or change the signed-in user's daily PIN (ADR-017 §1). The current
/// password is needed only when a PIN already exists.
#[tauri::command]
pub async fn set_my_pin(
    ctx: Ctx<'_>,
    current_password: Option<String>,
    pin: String,
) -> Result<(), IdentityCommandError> {
    let session = require_session(&ctx).await.map_err(IdentityCommandError::from)?;
    pin_use_cases::set_own_pin(&ctx.pool, &session, current_password.as_deref(), &pin)
        .await
        .map_err(IdentityCommandError::from)?;
    Ok(())
}

/// A manager sets an account's daily PIN (ADR-017 §1).
#[tauri::command]
pub async fn set_user_pin(
    ctx: Ctx<'_>,
    user_id: String,
    pin: String,
) -> Result<(), IdentityCommandError> {
    let session = require_session(&ctx).await.map_err(IdentityCommandError::from)?;
    pin_use_cases::manager_set_pin(&ctx.pool, &session, parse_user_id(&user_id)?, &pin)
        .await
        .map_err(IdentityCommandError::from)?;
    Ok(())
}

#[tauri::command]
pub async fn change_user_role(
    ctx: Ctx<'_>,
    user_id: String,
    role: String,
) -> Result<(), IdentityCommandError> {
    let session = require_session(&ctx).await.map_err(IdentityCommandError::from)?;
    user_use_cases::change_role(&ctx.pool, &session, parse_user_id(&user_id)?, parse_role(&role)?)
        .await
        .map_err(IdentityCommandError::from)?;
    Ok(())
}

#[tauri::command]
pub async fn disable_user(
    ctx: Ctx<'_>,
    user_id: String,
) -> Result<(), IdentityCommandError> {
    let session = require_session(&ctx).await.map_err(IdentityCommandError::from)?;
    user_use_cases::disable_user(&ctx.pool, &session, parse_user_id(&user_id)?)
        .await
        .map_err(IdentityCommandError::from)?;
    Ok(())
}

#[tauri::command]
pub async fn enable_user(
    ctx: Ctx<'_>,
    user_id: String,
) -> Result<(), IdentityCommandError> {
    let session = require_session(&ctx).await.map_err(IdentityCommandError::from)?;
    user_use_cases::enable_user(&ctx.pool, &session, parse_user_id(&user_id)?)
        .await
        .map_err(IdentityCommandError::from)?;
    Ok(())
}

/// Change a login identifier. Manager-only and re-authenticated.
#[tauri::command]
pub async fn set_username(
    ctx: Ctx<'_>,
    user_id: String,
    username: String,
) -> Result<(), IdentityCommandError> {
    let session = require_session(&ctx).await.map_err(IdentityCommandError::from)?;
    user_use_cases::set_username(&ctx.pool, &session, parse_user_id(&user_id)?, &username)
        .await
        .map_err(IdentityCommandError::from)?;
    Ok(())
}

/// Reported so the frontend knows whether to show the forced-change screen.
///
/// Derived from the resolved session, never from anything the caller sent.
#[tauri::command]
pub async fn password_change_required(
    ctx: Ctx<'_>,
) -> Result<bool, IdentityCommandError> {
    let session = require_session(&ctx).await.map_err(IdentityCommandError::from)?;
    Ok(session.must_change_password())
}
