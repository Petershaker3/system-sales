//! Errors the domain can raise on its own.
//!
//! Transport, storage and keyring failures are mapped onto `ServiceError` by
//! the service layer. Keeping this enum free of infrastructure types is what
//! lets `domain/` stay free of SQLx and Tauri (`spec:99`).

use std::fmt;

use crate::domain::identity::UserId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DomainError {
    /// The user table is not empty, so first-run setup may not run.
    ///
    /// The authoritative check is transactional and lives in the service layer;
    /// this variant reports its outcome.
    BootstrapAlreadyCompleted,
    /// No user exists with this identifier.
    UserNotFound,
    /// No account matches the supplied credential.
    InvalidCredentials,
    /// The account is locked out and the lock has not yet expired.
    AccountLocked,
    /// The account has been disabled by a manager.
    ///
    /// Deliberately distinct from [`DomainError::AccountLocked`]. A lockout is a
    /// fifteen-minute timer that expires on its own; a disable is an
    /// administrative decision with no expiry. Reporting one as the other would
    /// tell an operator to wait fifteen minutes for something that will never
    /// change on its own.
    AccountDisabled,
    /// The supplied password does not meet the policy in force.
    WeakPassword,
    /// The supplied PIN is not 4 to 6 digits (ADR-017 §1).
    WeakPin,
    /// The account has no PIN yet, so it cannot sign in or approve with one
    /// (ADR-017 §1–3). The password still works; a PIN is set from the session.
    PinNotSet,
    /// The session has passed its idle deadline.
    SessionIdleExpired,
    /// The session has passed its absolute lifetime.
    SessionAbsoluteExpired,
    /// No session matches the presented token.
    SessionNotFound,
    /// The session is valid but its role does not hold the permission.
    PermissionDenied,
    /// The permission needs a higher assurance level than the session has.
    ReauthenticationRequired,
    /// The account must change its password before any other operation.
    PasswordChangeRequired,
    /// A sensitive operation needs the owner's PIN approval, and this session
    /// holds none that may still be spent (ADR-017 §3).
    ///
    /// One code for "never approved", "the two minutes passed" and "already
    /// used by another operation": to the operator they all have the same
    /// remedy — the owner enters the PIN — and the audit log records which
    /// approvals were granted and which operation spent each one.
    OwnerApprovalRequired,
    /// The requested username is already taken.
    UsernameAlreadyExists,
    /// The requested username violates the format rules.
    UsernameInvalid,
    /// The requested display name is blank.
    DisplayNameRequired,
    /// A row the domain requires is missing or inconsistent.
    ///
    /// Deliberately its own code rather than [`DomainError::StorageUnavailable`],
    /// and emphatically not [`DomainError::InvalidCredentials`]:
    ///
    /// * The database is reachable and readable. Reporting an outage would send a
    ///   technician chasing a storage problem that does not exist.
    /// * The password may be perfectly correct. Reporting invalid credentials would
    ///   tell an operator their password is wrong when it is not.
    ///
    /// What it means in practice is that a `users` row has lost its
    /// `user_credentials` row, which migration `0003` guarantees for every account.
    /// It is an invariant violation, it is not transient, and retrying will not fix
    /// it — so it must surface as a defect rather than as a transient hiccup.
    AccountDataIntegrityError,
    /// The account has no recovery code to recover with (ADR-017 §4).
    ///
    /// Said plainly rather than as a wrong code: typing again cannot help, and
    /// the remedy — make a code from the settings while the password is still
    /// known — is different.
    RecoveryCodeNotSet,
    /// Refusing to disable the last active manager.
    ///
    /// There is no backdoor reset and no second device, because V1 has no server
    ///
    /// There is no backdoor reset and no second device, because V1 has no server
    /// (`ADR-008`). Disabling the only manager would leave a device that nobody
    /// can ever administer again, so this is refused rather than warned about.
    CannotDisableLastManager,
    /// Refusing to let an operator disable their own account.
    CannotDisableSelf,
    /// The local database could not be reached or read.
    ///
    /// Distinct from a business failure on purpose. Reporting a storage outage
    /// as "invalid credentials" would tell an operator their password is wrong
    /// when it is not, and would send the user round a retry loop that can never
    /// succeed. This is a technician-facing condition.
    ///
    /// It lives here rather than in a separate error enum only to avoid
    /// threading a second error type through every service signature while the
    /// shape of this problem is still being observed. If the identity slice
    /// grows, this is the variant to split out.
    StorageUnavailable,
    /// The operating-system credential store could not be reached.
    ///
    /// `ADR-009` requires failing closed rather than falling back, so this is a
    /// hard stop: there is no session, and nothing is reported as merely
    /// "signed out".
    SecureStorageUnavailable,
}

impl DomainError {
    /// A stable, language-independent identifier for this failure.
    ///
    /// This is what crosses the IPC boundary. `Display` is for logs and for a
    /// developer reading stderr; it is never shown to an operator, because
    /// `spec:127` requires user-facing text to live in Arabic message files on
    /// the frontend. Keeping prose out of the transport also means tests assert
    /// on a value that cannot change when wording is improved.
    ///
    /// # Enumeration defence
    ///
    /// `UserNotFound` and `InvalidCredentials` deliberately return the **same**
    /// code. If they were distinguishable, the response would disclose which
    /// account identifiers exist. This is asserted by a test, because it is a
    /// security property rather than a detail.
    pub fn code(&self) -> &'static str {
        match self {
            DomainError::BootstrapAlreadyCompleted => "BOOTSTRAP_ALREADY_COMPLETED",
            // Both collapse to one code on purpose. See the note above.
            DomainError::UserNotFound | DomainError::InvalidCredentials => "INVALID_CREDENTIALS",
            DomainError::AccountLocked => "ACCOUNT_TEMPORARILY_LOCKED",
            DomainError::AccountDisabled => "ACCOUNT_DISABLED",
            DomainError::PasswordChangeRequired => "PASSWORD_CHANGE_REQUIRED",
            DomainError::OwnerApprovalRequired => "OWNER_APPROVAL_REQUIRED",
            DomainError::UsernameAlreadyExists => "USERNAME_ALREADY_EXISTS",
            DomainError::UsernameInvalid => "USERNAME_INVALID",
            DomainError::DisplayNameRequired => "DISPLAY_NAME_REQUIRED",
            DomainError::AccountDataIntegrityError => "ACCOUNT_DATA_INTEGRITY_ERROR",
            DomainError::CannotDisableLastManager => "CANNOT_DISABLE_LAST_MANAGER",
            DomainError::RecoveryCodeNotSet => "RECOVERY_CODE_NOT_SET",
            DomainError::CannotDisableSelf => "CANNOT_DISABLE_SELF",
            DomainError::WeakPassword => "PASSWORD_DOES_NOT_MEET_POLICY",
            DomainError::WeakPin => "PIN_DOES_NOT_MEET_POLICY",
            DomainError::PinNotSet => "PIN_NOT_SET",
            DomainError::SessionIdleExpired => "SESSION_IDLE_EXPIRED",
            DomainError::SessionAbsoluteExpired => "SESSION_LIFETIME_EXPIRED",
            DomainError::SessionNotFound => "NO_ACTIVE_SESSION",
            DomainError::PermissionDenied => "PERMISSION_DENIED",
            DomainError::ReauthenticationRequired => "REAUTHENTICATION_REQUIRED",
            DomainError::StorageUnavailable => "LOCAL_STORAGE_UNAVAILABLE",
            DomainError::SecureStorageUnavailable => "SECURE_STORAGE_UNAVAILABLE",
        }
    }
}

impl fmt::Display for DomainError {
    /// Developer-facing text for logs and test failures.
    ///
    /// Never sent to the frontend. Use [`DomainError::code`] for that.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            // Identical wording for both, so a log line cannot be mistaken for a
            // user-facing message.
            DomainError::InvalidCredentials | DomainError::UserNotFound => {
                write!(f, "invalid credentials [{}]", self.code())
            }
            DomainError::BootstrapAlreadyCompleted => {
                write!(f, "first-run setup has already been completed")
            }
            DomainError::AccountLocked => write!(f, "account is temporarily locked"),
            DomainError::WeakPassword => write!(f, "password does not meet the policy"),
            DomainError::WeakPin => write!(f, "PIN must be 4 to 6 digits"),
            DomainError::PinNotSet => write!(f, "this account has no PIN yet"),
            DomainError::SessionIdleExpired => write!(f, "session expired after inactivity"),
            DomainError::SessionAbsoluteExpired => {
                write!(f, "session reached its maximum lifetime")
            }
            DomainError::SessionNotFound => write!(f, "no active session"),
            DomainError::PermissionDenied => write!(f, "permission denied"),
            DomainError::ReauthenticationRequired => {
                write!(f, "re-authentication is required for this operation")
            }
            DomainError::AccountDisabled => write!(f, "account is disabled by a manager"),
            DomainError::PasswordChangeRequired => {
                write!(f, "password must be changed before continuing")
            }
            DomainError::OwnerApprovalRequired => {
                write!(f, "this operation needs the owner's PIN approval")
            }
            DomainError::UsernameAlreadyExists => write!(f, "username is already taken"),
            DomainError::UsernameInvalid => write!(f, "username is not valid"),
            DomainError::DisplayNameRequired => write!(f, "display name is required"),
            DomainError::AccountDataIntegrityError => {
                write!(f, "account data integrity error")
            }
            DomainError::CannotDisableLastManager => {
                write!(f, "cannot disable the last active manager")
            }
            DomainError::RecoveryCodeNotSet => {
                write!(f, "this account has no recovery code")
            }
            DomainError::CannotDisableSelf => write!(f, "cannot disable your own account"),
            DomainError::StorageUnavailable => write!(f, "the local database is unavailable"),
            DomainError::SecureStorageUnavailable => {
                write!(f, "secure session storage is unavailable")
            }
        }
    }
}

impl std::error::Error for DomainError {}

/// Convenience for attaching the offending user without leaking it further up.
impl DomainError {
    pub fn for_user(self, _id: UserId) -> Self {
        self
    }
}