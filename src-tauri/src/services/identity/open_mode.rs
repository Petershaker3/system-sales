//! Running the shop before it has an account (`ADR-039`).
//!
//! First use must work. The old flow opened a device on a form that demanded an
//! owner account before anything else could happen, which meant the first hour in
//! a new shop was spent on setup screens instead of on the counter, and an
//! Android phone in the back room could not be used at all until somebody had
//! typed a password into it. The owner's decision (2026-10-19) inverts that: the
//! shop runs from the first launch, and the account is made afterwards, from
//! الإعدادات ← المستخدمين والصلاحيات, whenever the owner wants one.
//!
//! # Why there is still a `users` row
//!
//! "No account" cannot mean "no row": `sales.sold_by`, `products.created_by`,
//! `stock_movements` and `shifts.opened_by` are all `NOT NULL REFERENCES users
//! (id)`, so every sale and every stock movement written on a fresh device needs
//! something real to point at, and a shop that later makes its account must not
//! lose what it sold in the meantime. So the device holds exactly one row, marked
//! `provisional` (`0029`), whose verifier is the hash of a random secret nobody is
//! ever told. It has no password, no PIN and no way to sign in with it, and it is
//! not a seeded login: the owner's claim overwrites the verifier and clears the
//! flag in one UPDATE, so the history the shop already wrote stays attributed to
//! the person who is now holding the account.
//!
//! # What an open session is, and is not
//!
//! [`session`] hands services a `Session` built from that row instead of from a
//! token. It is a manager session with `Reauthenticated` assurance, which is the
//! level [`Permission::ViewCostAndProfit`], [`Permission::ManageSettings`] and
//! [`Permission::ManageUsers`] ask for — and in an open shop there is nobody to
//! keep those figures from, because there is no second account and no password to
//! prove. It is *not* a bypass: every command still runs through
//! `Session::authorize`, and the moment the account is claimed this function
//! returns `None` and the device is back under the ordinary rules, with the
//! lockout, the PIN and the owner approval all live again.

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::credentials as credential_repo;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::identity::{
    password_is_acceptable, Assurance, CredentialVerifier, DomainError, Role, Session,
    SessionFacts, Timestamp, UserId, User, Username, ABSOLUTE_LIFETIME_MS,
};
use crate::services::identity::auth::{self, AuthenticatedUser};
use crate::services::identity::crypto;
use crate::services::identity::secure_store::SecureTokenStore;

/// What the open row is called until the owner names it.
///
/// Arabic because it is shown: the top bar, the user chip and the settings card
/// all read the row's own name, and «حساب المالك» is the phrase the rest of the
/// identity screens use.
pub const OPEN_ACCOUNT_NAME: &str = "المالك";

/// The open owner row, as a use case sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAccount {
    pub id: UserId,
    pub display_name: String,
}

/// Make the open owner row, if this database has no claimed account.
///
/// `Ok(Some(..))` is the account to run on — the one made now or the one an
/// earlier start-up made. `Ok(None)` means there is nothing to open: this shop has
/// claimed accounts, and the ordinary sign-in rules apply.
///
/// Called from `lib.rs` before the default categories and the default phone
/// companies, so those are attributed to this row exactly as they are attributed
/// to a manager (`ADR-018` §1). The gate is a count taken inside the same
/// transaction as the insert — the shape `bootstrap::create_first_manager` uses for
/// the same reason: two windows that open a fresh device together must not each
/// decide the table is empty.
pub async fn ensure_open_account(pool: &SqlitePool) -> Result<Option<OpenAccount>, DomainError> {
    {
        let mut conn = pool
            .acquire()
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

        if let Some(row) = user_repo::find_open(&mut conn)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
        {
            return Ok(Some(OpenAccount {
                id: row.id,
                display_name: row.display_name,
            }));
        }
        if user_repo::count_all(&mut conn)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
            > 0
        {
            return Ok(None);
        }
    }

    // Argon2 runs here rather than inside the transaction, and on a value that is
    // generated and then dropped without ever being returned. It is deliberately
    // slow work; holding the write lock through it is how a second window starts
    // failing on a busy database. The secret is the open row's password in every
    // technical sense — which is the point: an attempt to sign in with the open
    // row can only guess it.
    let secret = crypto::generate_token().map_err(|_| DomainError::StorageUnavailable)?;
    let verifier = CredentialVerifier::from_phc(
        crypto::hash_password(secret.expose())
            .map_err(|_| DomainError::StorageUnavailable)?,
    )?;

    let id = UserId::generate();
    let now = Timestamp::now();
    let user = User {
        id,
        // The role is Manager for the same reason `bootstrap` gives it: there is
        // nobody yet who could hold a lesser role, and a shop that cannot open its
        // own settings is not a shop that is running.
        role: Role::Manager,
        display_name: OPEN_ACCOUNT_NAME.to_string(),
        verifier,
        failed_attempts: 0,
        locked_until: None,
    };

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    // `count_claimed`, not `count_all`: the open row is made for a shop that has no
    // account *anybody signed in with*, and the row this function may have written a
    // moment ago (in a second window racing the same fresh device) must not talk it
    // out of the one answer that matters. `find_open` above already returned the open
    // row when it existed, so reaching here with a non-zero count means somebody
    // claimed a real account first.
    if user_repo::count_claimed(&mut *tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        > 0
    {
        // Another writer got in first. Whichever row it wrote — an open one or a
        // claimed account — is what the next read here will find, so this answer is
        // only "not mine to make".
        drop(tx);
        return Ok(None);
    }

    user_repo::insert_open(&mut tx, &user, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    // The placeholder identifier, the same deterministic `user-<8 hex>` the `0003`
    // backfill and `create_first_manager` use. Every account needs the
    // credentials row for the `NOT NULL UNIQUE` invariant; an open row is not an
    // exception, and a claim later renames it from user management if the owner
    // wants an identifier of their own.
    credential_repo::insert(&mut tx, id, &Username::backfill_from(&id))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        id,
        audit::event::OPEN_ACCOUNT_STARTED,
        now,
        Some(format!(r#"{{"role":"{}"}}"#, user.role.as_str())),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(Some(OpenAccount {
        id,
        display_name: user.display_name,
    }))
}

/// The open owner row, if this shop is running on one.
pub async fn open_account(pool: &SqlitePool) -> Result<Option<OpenAccount>, DomainError> {
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let row = user_repo::find_open(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(row.map(|row| OpenAccount {
        id: row.id,
        display_name: row.display_name,
    }))
}

/// Whether this device is running on the open owner row right now.
///
/// The yes/no the banner and the settings card ask, answered here so no caller has
/// to know that the answer happens to be a row in `users` — and so nobody reads the
/// row, decides for themselves what "open" means, and gets it subtly wrong at one
/// more call site than the last time (`ADR-039`).
pub async fn is_open(pool: &SqlitePool) -> Result<bool, DomainError> {
    Ok(open_account(pool).await?.is_some())
}

/// The open operator's session, or `None` when this shop has an account.
///
/// There is no session row and no token to look one up with: an open shop has
/// neither. The lifetime fields are therefore taken from `now` on every call,
/// which is also why the idle and absolute deadlines cannot strand a till — there
/// is no credential to re-prove, so expiring the session would only interrupt the
/// sale in progress for no protection at all.
///
/// The session is a manager's, and `Reauthenticated`. What it deliberately does
/// not widen is the *role*: the open row is a manager because the shop has no
/// other account, not because running open grants a seller anything. A seller
/// created before the owner claims their account still signs in with a password,
/// and still sees only what a seller may see.
pub async fn session(pool: &SqlitePool) -> Result<Option<Session>, DomainError> {
    let Some(open) = open_account(pool).await? else {
        return Ok(None);
    };

    let now = Timestamp::now();
    let session = Session::open(
        SessionFacts {
            user_id: open.id,
            role: Role::Manager,
            assurance: Assurance::Reauthenticated,
            issued_at: now,
            last_seen_at: now,
            absolute_expires_at: now.plus_millis(ABSOLUTE_LIFETIME_MS),
            // Neither flag can be true of a row nobody claimed: `must_change_password`
            // is only ever set by a manager's reset, and `disabled_at` only by an
            // administrative decision, which `find_open` already honoured.
            must_change_password: false,
            disabled_at: None,
            owner_approval: None,
            open_mode: true,
        },
        now,
    )?;

    Ok(Some(session))
}

/// Claim the open row: the owner's name and password, and from now on a sign-in
/// like any other account (`ADR-039`).
///
/// Refused with `BOOTSTRAP_ALREADY_COMPLETED` when there is no open row to claim,
/// which is also the answer a double submission gets: the second one finds the row
/// already claimed and writes nothing. That is the gate, not a check before the
/// write — `claim_open` matches only a row that is still open, so the name and the
/// verifier cannot land on an account somebody else already made.
///
/// The operator is handed a session for the password they just typed, exactly as
/// first-run setup did: the claim happens while the shop is open and the owner is
/// standing at the till, and stopping them at a lock card for having done the
/// setup correctly would be punishing the thing this flow exists to encourage.
pub async fn claim_open_account(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    display_name: &str,
    password: &str,
) -> Result<AuthenticatedUser, DomainError> {
    let display_name = display_name.trim();
    if display_name.is_empty() {
        return Err(DomainError::DisplayNameRequired);
    }
    if !password_is_acceptable(password) {
        return Err(DomainError::WeakPassword);
    }

    let verifier = CredentialVerifier::from_phc(
        crypto::hash_password(password).map_err(|_| DomainError::InvalidCredentials)?,
    )?;

    let open = {
        let mut conn = pool
            .acquire()
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        user_repo::find_open(&mut conn)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
            .ok_or(DomainError::BootstrapAlreadyCompleted)?
    };

    let now = Timestamp::now();
    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    if !user_repo::claim_open(&mut tx, open.id, display_name, &verifier, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        drop(tx);
        return Err(DomainError::BootstrapAlreadyCompleted);
    }

    // The row's secondary secrets go with the claim (`ADR-039`): see
    // [`credential_repo::clear_secondary_secrets`] for why an open till can have a
    // PIN at all. Their absence is not a failure of the claim — a row that had no
    // credentials row had nothing to clear — but it is recorded, because an account
    // whose credential row is missing is a broken database and someone should be
    // able to find that out afterwards.
    let cleared = credential_repo::clear_secondary_secrets(&mut tx, open.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        open.id,
        audit::event::OPEN_ACCOUNT_CLAIMED,
        now,
        Some(format!(
            r#"{{"role":"manager","secondary_secrets_cleared":{}}}"#,
            cleared == 1
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    auth::login(pool, tokens, open.id, password).await
}
