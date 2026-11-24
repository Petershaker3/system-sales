//! Password verifiers.
//!
//! `plan:151` requires a secure verifier and forbids storing a plaintext
//! password or PIN. This module holds the stored form as an opaque value: the
//! domain can tell a verifier from a non-verifier, but the Argon2 work itself
//! belongs to `services::identity::crypto`, because it is computation over
//! bytes rather than a business rule.
//!
//! The string is a PHC-format hash. It embeds the algorithm, version and cost
//! parameters, so raising the cost later does not invalidate existing verifiers
//! and does not require a migration.

use std::fmt;

use crate::domain::identity::{DomainError, UserId};

/// An Argon2id password verifier in PHC string format.
///
/// Opaque by construction: there is no accessor returning the inner hash, and
/// `Debug` prints only the fact that a verifier is present.
#[derive(Clone, PartialEq, Eq)]
pub struct CredentialVerifier(String);

impl CredentialVerifier {
    /// Wrap a PHC string produced by the service layer.
    pub fn from_phc(value: String) -> Result<Self, DomainError> {
        if value.is_empty() {
            return Err(DomainError::InvalidCredentials);
        }
        Ok(Self(value))
    }

    /// Borrow the PHC string for verification.
    ///
    /// `pub(crate)` rather than `pub`: verification is a service concern, and
    /// nothing in `domain` or `commands` should be able to read the stored hash.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for CredentialVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CredentialVerifier(<redacted>)")
    }
}

/// The login identifier for an account.
///
/// `display_name` is deliberately **not** unique: two operators may share a name,
/// and forcing uniqueness would invent a rule the shop never asked for. This type
/// is what makes an account distinguishable in the picker instead.
///
/// # Normalisation happens here, never at the call site
///
/// Every constructor lowercases and trims, and the uniqueness check in SQLite is
/// `COLLATE NOCASE`. If normalisation lived in the command layer instead, a future
/// caller could skip it and produce a row that the database treats as a duplicate
/// while the UI shows it as distinct. Normalising in one place means a username
/// read back from SQLite is always already normalised.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Username(String);

impl Username {
    /// Shortest accepted identifier.
    pub const MIN_LEN: usize = 3;
    /// Longest accepted identifier.
    pub const MAX_LEN: usize = 32;

    /// Build a username from raw input, normalising it.
    pub fn new(raw: &str) -> Result<Self, DomainError> {
        let normalised = Self::normalise(raw);

        if normalised.chars().count() < Self::MIN_LEN
            || normalised.chars().count() > Self::MAX_LEN
        {
            return Err(DomainError::UsernameInvalid);
        }

        // Restricted to characters that survive being typed on a phone keyboard,
        // read aloud, or written on paper. Spaces and punctuation that look
        // alike would defeat the point of having an identifier.
        if !normalised
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(DomainError::UsernameInvalid);
        }

        Ok(Self(normalised))
    }

    /// Parse a value previously produced by [`Username::new`].
    ///
    /// Used when reading a row back. Returns `None` for anything the constructor
    /// would have rejected, so a corrupt row is an error rather than a value that
    /// silently bypasses the invariants.
    pub fn parse(raw: &str) -> Option<Self> {
        Self::new(raw).ok()
    }

    /// The deterministic placeholder used when backfilling existing accounts.
    ///
    /// Derived from the user id rather than the display name so that a migration
    /// cannot fail on a name that is blank, duplicated, or written in a script
    /// this code does not handle. `substr(id, 1, 8)` of a UUID cannot collide.
    pub fn backfill_from(user_id: &UserId) -> Self {
        Self(format!("user-{}", &user_id.as_str()[..8]))
    }

    fn normalise(raw: &str) -> String {
        raw.trim().to_lowercase()
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Username {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::str::FromStr for Username {
    type Err = DomainError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

/// A user account as the domain understands it.
#[derive(Debug, Clone)]
pub struct User {
    pub id: crate::domain::identity::UserId,
    pub display_name: String,
    pub role: crate::domain::identity::Role,
    pub verifier: CredentialVerifier,
    pub failed_attempts: i32,
    pub locked_until: Option<crate::domain::identity::Timestamp>,
}

/// The projection safe to hand to the login picker.
///
/// `spec:18` lets a sales user operate without seeing wholesale or management
/// data. The picker therefore exposes an id, a display name, the login identifier,
/// a role and whether the account is disabled, and nothing else: no verifier, no
/// counters, no lock state. Selecting a user in a list is not authorisation; only
/// the password is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserSummary {
    pub id: crate::domain::identity::UserId,
    pub display_name: String,
    /// The login identifier, so two operators sharing a display name remain
    /// distinguishable in the picker.
    ///
    /// `None` when the account has lost its `user_credentials` row. Migration
    /// `0003` guarantees one per account, so this is a broken invariant rather than
    /// a legitimate state, and it is carried as far as the command layer precisely
    /// so the picker can refuse it explicitly instead of either hiding the account
    /// or displaying a fabricated identifier.
    pub username: Option<Username>,
    pub role: crate::domain::identity::Role,
    /// A disabled account is shown so the operator can see it exists rather than
    /// finding it silently missing. It cannot be signed in to.
    pub disabled: bool,
}

impl UserSummary {
    /// Build the picker projection.
    ///
    /// Explicit rather than `From<&User>` because the login identifier and the
    /// disabled flag are read from other tables. Keeping the construction here means
    /// the picker can never be built from a `User` alone and silently omit them.
    pub fn new(
        user: &User,
        username: Option<Username>,
        disabled: bool,
    ) -> Self {
        Self {
            id: user.id,
            display_name: user.display_name.clone(),
            username,
            role: user.role,
            disabled,
        }
    }
}