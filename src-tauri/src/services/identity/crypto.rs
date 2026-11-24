//! Password hashing, token generation and token digesting.
//!
//! These are byte-level operations rather than business rules, so they live in
//! `services/` and not in `domain/`. `domain/` sees only the opaque
//! `CredentialVerifier` and `SessionToken` values they produce.
//!
//! Every algorithm parameter here is written out explicitly instead of relying
//! on a library default. A default that changes between versions would silently
//! alter security behaviour; an explicit constant is reviewable.

use argon2::{Algorithm, Argon2, Params, PasswordHasher, PasswordVerifier, Version};
use sha2::{Digest, Sha256};

use crate::domain::identity::{SessionToken, RECOVERY_CODE_ALPHABET, RECOVERY_CODE_LEN};

/// Argon2id memory cost in kibibytes: 19 MiB.
///
/// This is the OWASP-recommended floor for Argon2id. It is a deliberate floor,
/// not a ceiling: the cost is recorded inside every PHC string, so raising it
/// later is a rehash-on-next-login operation and does not invalidate stored
/// verifiers.
const ARGON2_MEMORY_KIB: u32 = 19 * 1024;

/// Passes over memory. Two is the recommended minimum.
const ARGON2_TIME_COST: u32 = 2;

/// Parallel lanes. One lane keeps memory cost honest on a phone.
const ARGON2_PARALLELISM: u32 = 1;

/// Derived key length in bytes.
const ARGON2_OUTPUT_LEN: usize = 32;

/// Bytes of entropy in a session token.
const TOKEN_BYTES: usize = 32;

#[derive(Debug)]
pub enum CryptoError {
    /// The hashing parameters were rejected by the library.
    BadParams,
    /// Hashing or verification failed for an unexpected reason.
    Hash(String),
    /// The operating system's CSPRNG was unavailable.
    NoRandomness,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::BadParams => f.write_str("invalid Argon2 parameters"),
            CryptoError::Hash(_) => f.write_str("password hashing failed"),
            CryptoError::NoRandomness => f.write_str("no secure random source available"),
        }
    }
}

impl std::error::Error for CryptoError {}

fn argon2() -> Result<Argon2<'static>, CryptoError> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_TIME_COST,
        ARGON2_PARALLELISM,
        Some(ARGON2_OUTPUT_LEN),
    )
    .map_err(|_| CryptoError::BadParams)?;

    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// Produce a PHC-format Argon2id verifier.
///
/// The salt is generated inside `hash_password`, from the library's own CSPRNG.
/// The cost parameters are embedded in the output, so a stored verifier records
/// how it was made.
pub fn hash_password(password: &str) -> Result<String, CryptoError> {
    let hash = argon2()?
        .hash_password(password.as_bytes())
        .map_err(|e| CryptoError::Hash(e.to_string()))?;
    Ok(hash.to_string())
}

/// Check a password against a stored verifier.
///
/// Returns `false` for a wrong password *and* for an unparseable verifier, so a
/// corrupt row denies access rather than granting it.
pub fn verify_password(password: &str, verifier: &str) -> bool {
    argon2()
        .map(|ctx| ctx.verify_password(password.as_bytes(), verifier).is_ok())
        .unwrap_or(false)
}

/// A verifier for a value nobody holds.
///
/// Used by the login path when the selected account does not exist, so that a
/// missing account and a wrong password cost the same time. Without this, the
/// response latency discloses which user ids are real.
pub fn dummy_verifier() -> &'static str {
    // Generated once from a throwaway random password. It is never assigned to
    // any account, so it can never authenticate anything; it exists purely to
    // be verified against.
    static ONCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        hash_password("no-account-uses-this-verifier").unwrap_or_else(|_| {
            "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000000000000".to_string()
        })
    })
}

/// 32 bytes from the OS CSPRNG, hex-encoded.
pub fn generate_token() -> Result<SessionToken, CryptoError> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| CryptoError::NoRandomness)?;

    // A token of all zeroes would indicate a broken RNG rather than entropy.
    if bytes.iter().all(|b| *b == 0) {
        return Err(CryptoError::NoRandomness);
    }

    Ok(SessionToken::new(bytes))
}

/// A fresh recovery code (ADR-017 §4): `RECOVERY_CODE_LEN` symbols drawn
/// uniformly from the recovery alphabet, from the same OS CSPRNG as the session
/// token.
///
/// The alphabet has 31 symbols, so a byte is used only below 248 — the largest
/// multiple of 31 that fits — and the rest are thrown away: `byte % 31` on the
/// whole byte range would favour the first eight symbols.
pub fn generate_recovery_code() -> Result<String, CryptoError> {
    let alphabet = RECOVERY_CODE_ALPHABET.as_bytes();
    let size = alphabet.len();
    let limit = 256 - (256 % size);
    let mut code = String::with_capacity(RECOVERY_CODE_LEN);
    let mut pool = [0u8; 64];
    while code.len() < RECOVERY_CODE_LEN {
        getrandom::fill(&mut pool).map_err(|_| CryptoError::NoRandomness)?;
        // All zeroes means a broken RNG, not entropy (the token's rule).
        if pool.iter().all(|byte| *byte == 0) {
            return Err(CryptoError::NoRandomness);
        }
        for byte in pool {
            let value = usize::from(byte);
            if value >= limit {
                continue;
            }
            code.push(char::from(alphabet[value % size]));
            if code.len() == RECOVERY_CODE_LEN {
                break;
            }
        }
    }
    Ok(code)
}

/// SHA-256 of the token, as stored in SQLite.
///
/// The digest is not a secret: it lives in the database, which the accepted
/// threat model already treats as readable (`ADR-003:27`, `spec:55`). Its
/// purpose is that possessing it does not let anyone authenticate, which is not
/// true of the token itself.
pub fn hash_token(token: &SessionToken) -> String {
    let digest = Sha256::digest(token.expose().as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(char::from_digit(u32::from(byte >> 4), 16).expect("nibble is < 16"));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).expect("nibble is < 16"));
    }
    out
}