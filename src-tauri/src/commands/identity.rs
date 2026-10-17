//! Tauri commands for identity.
//!
//! Transport boundaries only. Every command here does the same three things and
//! nothing else: take plain data from the transport, call a service, map the
//! result. No business rule and no SQL appears in this file (`spec:100`,
//! `plan:157`).
//!
//! # There is no session parameter
//!
//! A deliberate omission. `plan:151` requires Rust to resolve identity and role
//! from the database rather than trusting the frontend, and ADR-009 goes further:
//! the token never reaches JavaScript at all. So no command accepts a token, a
//! user id, or a role from the caller. The current operator is whatever the OS
//! credential store says it is.

use serde::Serialize;
use tauri::State;

use crate::domain::identity::DomainError;
use crate::services::identity::{auth, bootstrap, pin, session};
use crate::services::identity::IdentityContext;

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure that crosses the IPC boundary.
///
/// # Why a code and not a sentence
///
/// `spec:127` requires user-facing text to live in Arabic message files on the
/// frontend. Rust therefore emits a stable, language-independent code and the
/// frontend renders it. Two consequences worth stating:
///
/// * The domain stays independent of language, so the same backend could serve
///   another locale without changing Rust.
/// * Tests assert on codes, which cannot drift when wording is improved.
///
/// The enumeration defence depends on `INVALID_CREDENTIALS` being returned for
/// both an unknown account and a wrong password.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
}

impl CommandError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

impl From<DomainError> for CommandError {
    fn from(error: DomainError) -> Self {
        CommandError::new(error.code())
    }
}

/// The identity of the signed-in operator, as the frontend sees it.
///
/// No token field exists here, so there is nothing for the WebView to leak,
/// replay, or forge.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDto {
    user_id: String,
    display_name: String,
    role: String,
    assurance: String,
}

/// A login-picker row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSummaryDto {
    id: String,
    display_name: String,
    /// The login identifier.
    ///
    /// `display_name` is deliberately not unique, so the picker must carry the
    /// username or two operators sharing a name would be indistinguishable. Only
    /// id, name, username and role cross this boundary - never a verifier, a
    /// counter or lock state.
    username: String,
    role: String,
    disabled: bool,
    /// Whether the account has a daily PIN, so the lock screen offers the PIN
    /// pad or the password (ADR-017 §2). The fact only: never the PIN or its
    /// verifier.
    has_pin: bool,
}

fn to_session_dto(user: &auth::AuthenticatedUser) -> SessionDto {
    SessionDto {
        user_id: user.user_id.as_str(),
        display_name: user.display_name.clone(),
        role: user.role.as_str().to_string(),
        assurance: match user.assurance {
            crate::domain::identity::Assurance::Normal => "normal",
            crate::domain::identity::Assurance::Reauthenticated => "reauthenticated",
        }
        .to_string(),
    }
}

/// Whether first-run setup still has to happen.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStatusDto {
    needs_setup: bool,
}

/// Does the application need the first-run setup screen?
///
/// Advisory only. The real gate is the transactional check inside
/// `create_first_manager`, so hiding this screen cannot bypass it.
#[tauri::command]
pub async fn bootstrap_status(ctx: Ctx<'_>) -> Result<BootstrapStatusDto, CommandError> {
    let needs_setup = bootstrap::bootstrap_needed(&ctx.pool)
        .await
        .map_err(|_| CommandError::from(DomainError::StorageUnavailable))?;
    Ok(BootstrapStatusDto { needs_setup })
}

/// Create the first manager. Succeeds exactly once, ever.
#[tauri::command]
pub async fn create_first_manager(
    ctx: Ctx<'_>,
    display_name: String,
    password: String,
) -> Result<SessionDto, CommandError> {
    let created = bootstrap::create_first_manager(&ctx.pool, &display_name, &password)
        .await
        .map_err(CommandError::from)?;

    // The setup screen signs the new manager straight in, so the operator is not
    // asked to type the password twice on the one occasion the account is made.
    let signed_in = auth::login(
        &ctx.pool,
        ctx.tokens.as_ref(),
        created.user_id,
        &password,
    )
    .await
    .map_err(CommandError::from)?;

    Ok(to_session_dto(&signed_in))
}

/// Accounts to choose from on the login screen.
#[tauri::command]
pub async fn list_users_for_picker(ctx: Ctx<'_>) -> Result<Vec<UserSummaryDto>, CommandError> {
    let users = auth::list_users(&ctx.pool).await.map_err(CommandError::from)?;
    let pin_holders = pin::pin_holders(&ctx.pool).await.map_err(CommandError::from)?;

    // An account with no credentials row is reported as an integrity failure rather
    // than projected with an empty identifier. The alternative - hiding the account -
    // would let identity disappear from the login screen with no explanation, leaving
    // an operator unable to tell which account was missing or why.
    if users.iter().any(|user| user.username.is_none()) {
        return Err(CommandError::from(DomainError::AccountDataIntegrityError));
    }

    Ok(users
        .into_iter()
        .map(|user| UserSummaryDto {
            id: user.id.as_str(),
            display_name: user.display_name,
            username: user
                .username
                .as_ref()
                .expect("every account was checked for a credentials row above")
                .as_str()
                .to_string(),
            role: user.role.as_str().to_string(),
            disabled: user.disabled,
            has_pin: pin_holders.contains(&user.id.as_str()),
        })
        .collect())
}

/// Verify a credential and open a session.
#[tauri::command]
pub async fn login(
    ctx: Ctx<'_>,
    user_id: String,
    password: String,
) -> Result<SessionDto, CommandError> {
    let parsed = uuid::Uuid::parse_str(&user_id)
        .map_err(|_| CommandError::from(DomainError::InvalidCredentials))?;

    let signed_in = auth::login(
        &ctx.pool,
        ctx.tokens.as_ref(),
        crate::domain::identity::UserId::from_uuid(parsed),
        &password,
    )
    .await
    .map_err(CommandError::from)?;

    Ok(to_session_dto(&signed_in))
}

/// Sign in with the daily PIN and open a session (ADR-017 §2). The same session,
/// lockout and refusals as [`login`]; switching user is this, with the next
/// person's PIN.
#[tauri::command]
pub async fn login_with_pin(
    ctx: Ctx<'_>,
    user_id: String,
    pin: String,
) -> Result<SessionDto, CommandError> {
    let parsed = uuid::Uuid::parse_str(&user_id)
        .map_err(|_| CommandError::from(DomainError::InvalidCredentials))?;

    let signed_in = auth::login_with_pin(
        &ctx.pool,
        ctx.tokens.as_ref(),
        crate::domain::identity::UserId::from_uuid(parsed),
        &pin,
    )
    .await
    .map_err(CommandError::from)?;

    Ok(to_session_dto(&signed_in))
}

/// End the current session.
#[tauri::command]
pub async fn logout(ctx: Ctx<'_>) -> Result<(), CommandError> {
    auth::logout(&ctx.pool, ctx.tokens.as_ref())
        .await
        .map_err(CommandError::from)
}

/// The current operator, or `None` when nobody is signed in.
///
/// Resolution reads the token from the OS credential store, so this is also the
/// proof that a session survived an application restart.
#[tauri::command]
pub async fn whoami(ctx: Ctx<'_>) -> Result<Option<SessionDto>, CommandError> {
    match session::describe(&ctx.pool, ctx.tokens.as_ref()).await {
        Ok(maybe_user) => Ok(maybe_user.as_ref().map(to_session_dto)),
        // No session is the normal signed-out state, not a failure.
        Err(DomainError::SessionNotFound)
        | Err(DomainError::SessionIdleExpired)
        | Err(DomainError::SessionAbsoluteExpired) => Ok(None),
        // An unreachable credential store must surface as a real failure, never
        // as "nobody is signed in": degrading would hide a broken store.
        Err(error) => Err(CommandError::from(error)),
    }
}

/// Re-prove the password to raise the session to `reauthenticated`.
///
/// `plan:151` requires this before wholesale data is revealed; the catalog slice
/// will call `Session::authorize(Permission::ViewCostAndProfit)`.
#[tauri::command]
pub async fn reauthenticate(ctx: Ctx<'_>, password: String) -> Result<&'static str, CommandError> {
    let assurance = session::reauthenticate(&ctx.pool, ctx.tokens.as_ref(), &password)
        .await
        .map_err(CommandError::from)?;
    Ok(match assurance {
        crate::domain::identity::Assurance::Normal => "normal",
        crate::domain::identity::Assurance::Reauthenticated => "reauthenticated",
    })
}