//! The OS credential store, and the only component that ever holds the session
//! token.
//!
//! # Contract
//!
//! * The token is written here and read back here. It is never returned to the
//!   WebView, never logged, and never written to SQLite — only its SHA-256
//!   digest is (ADR-009).
//! * **Unavailability is not an error to be worked around.** If the platform
//!   store cannot be reached, every operation fails with
//!   [`SecureStoreError::Unavailable`]. There is deliberately no fallback to a
//!   file, to `localStorage`, or to process memory: a weaker fallback would
//!   silently reintroduce the exact exposure the keyring was chosen to remove.
//! * `keyring_core`'s own `mock` and `sample` stores are documented as "not
//!   warranted to be either secure or robust". They are never installed here.

use std::fmt;
use std::sync::OnceLock;

use crate::domain::identity::SessionToken;

/// Credential-store service name. Matches the application identifier so the
/// entry is namespaced to this app and cannot collide with another.
const SERVICE: &str = "com.mshop.system";

/// Entry user name. A POS terminal has one operator at a time, so there is a
/// single session entry rather than one per account.
const ENTRY_USER: &str = "session";

#[derive(Debug)]
pub enum SecureStoreError {
    /// The platform credential store could not be reached or used.
    ///
    /// This is the fail-closed path. Authentication cannot proceed, and the
    /// caller must surface the failure rather than degrade.
    Unavailable(String),
    /// The store rejected the value we tried to write.
    Rejected(String),
}

impl fmt::Display for SecureStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecureStoreError::Unavailable(detail) => {
                write!(f, "the operating system credential store is unavailable ({detail})")
            }
            SecureStoreError::Rejected(detail) => {
                write!(f, "the credential store rejected the value ({detail})")
            }
        }
    }
}

impl std::error::Error for SecureStoreError {}

/// Persistence boundary for the session token.
pub trait SecureTokenStore: Send + Sync {
    /// Write the token, replacing any previous one.
    fn put(&self, token: &SessionToken) -> Result<(), SecureStoreError>;
    /// Read the token, or `None` when there is none.
    fn get(&self) -> Result<Option<SessionToken>, SecureStoreError>;
    /// Remove the token. Absence is success.
    fn clear(&self) -> Result<(), SecureStoreError>;
    /// Whether the store is usable right now.
    fn is_available(&self) -> Result<(), SecureStoreError>;
}

/// Install the platform credential store as `keyring-core`'s default.
///
/// Process-wide and idempotent. `keyring-core` keeps the default store in a
/// global, and the Android store refuses to construct twice under one name, so
/// this must happen exactly once. Called from Tauri's `setup` hook.
pub fn install_default_store() -> Result<(), SecureStoreError> {
    static INSTALLED: OnceLock<Result<(), String>> = OnceLock::new();

    match INSTALLED.get_or_init(build_default_store) {
        Ok(()) => Ok(()),
        Err(detail) => Err(SecureStoreError::Unavailable(detail.clone())),
    }
}

#[cfg(target_os = "windows")]
fn build_default_store() -> Result<(), String> {
    let store = windows_native_keyring_store::Store::new().map_err(|e| e.to_string())?;
    keyring_core::set_default_store(store);
    Ok(())
}

#[cfg(target_os = "android")]
fn build_default_store() -> Result<(), String> {
    let store = android_native_keyring_store::Store::new().map_err(|e| e.to_string())?;
    keyring_core::set_default_store(store);
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
fn build_default_store() -> Result<(), String> {
    // V1 targets Windows and Android only (ADR-008). Refusing here rather than
    // silently degrading keeps the fail-closed guarantee honest on any platform
    // someone tries to build for.
    Err(format!(
        "no credential store is wired for target_os={}",
        std::env::consts::OS
    ))
}

/// The real store.
pub struct KeyringTokenStore {
    _private: (),
}

impl KeyringTokenStore {
    pub fn new() -> Result<Self, SecureStoreError> {
        install_default_store()?;
        Ok(Self { _private: () })
    }

    fn entry(&self) -> Result<keyring_core::Entry, SecureStoreError> {
        #[cfg(target_os = "windows")]
        {
            // Entries are created with an explicit persistence of `local`
            // (CRED_PERSIST_LOCAL_MACHINE). The store's own default is
            // `enterprise`, which would let the credential roam to other
            // machines under a Windows domain profile. That is wrong here:
            // ADR-008 gives every device its own independent database, so a
            // session token must never travel between them.
            let modifiers: std::collections::HashMap<&str, &str> =
                std::collections::HashMap::from([("persistence", "local")]);
            keyring_core::Entry::new_with_modifiers(SERVICE, ENTRY_USER, &modifiers)
                .map_err(|e| SecureStoreError::Unavailable(e.to_string()))
        }
        #[cfg(not(target_os = "windows"))]
        {
            keyring_core::Entry::new(SERVICE, ENTRY_USER)
                .map_err(|e| SecureStoreError::Unavailable(e.to_string()))
        }
    }
}

impl SecureTokenStore for KeyringTokenStore {
    fn put(&self, token: &SessionToken) -> Result<(), SecureStoreError> {
        self.entry()?
            .set_secret(token.expose().as_bytes())
            .map_err(|e| SecureStoreError::Rejected(e.to_string()))
    }

    fn get(&self) -> Result<Option<SessionToken>, SecureStoreError> {
        match self.entry()?.get_secret() {
            Ok(bytes) => {
                let text = String::from_utf8(bytes)
                    .map_err(|_| SecureStoreError::Unavailable("stored token was not UTF-8".into()))?;
                // A malformed entry is treated as unavailability rather than
                // being silently replaced: quietly minting a new token would
                // hide a store that is not behaving correctly.
                SessionToken::parse(&text)
                    .map(Some)
                    .ok_or_else(|| SecureStoreError::Unavailable("stored token was malformed".into()))
            }
            // No entry is the normal "nobody is signed in" case, not a failure.
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecureStoreError::Unavailable(e.to_string())),
        }
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        match self.entry()?.delete_credential() {
            Ok(()) => Ok(()),
            // Already gone is the desired end state.
            Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecureStoreError::Unavailable(e.to_string())),
        }
    }

    fn is_available(&self) -> Result<(), SecureStoreError> {
        install_default_store()?;
        // Probe by attempting a read. There is no separate capability query, and
        // a read is side-effect free.
        match self.get() {
            Ok(_) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// In-memory store for tests.
///
/// Explicitly not secure and not a substitute: it exists so service logic can be
/// tested without a platform keyring, and so a test cannot accidentally depend
/// on the developer's real credential store.
pub struct InMemoryTokenStore {
    slot: std::sync::Mutex<Option<SessionToken>>,
}

impl InMemoryTokenStore {
    pub fn new() -> Self {
        Self {
            slot: std::sync::Mutex::new(None),
        }
    }
}

impl Default for InMemoryTokenStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecureTokenStore for InMemoryTokenStore {
    fn put(&self, token: &SessionToken) -> Result<(), SecureStoreError> {
        *self.slot.lock().expect("poisoned") = Some(token.clone());
        Ok(())
    }

    fn get(&self) -> Result<Option<SessionToken>, SecureStoreError> {
        Ok(self.slot.lock().expect("poisoned").clone())
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        *self.slot.lock().expect("poisoned") = None;
        Ok(())
    }

    fn is_available(&self) -> Result<(), SecureStoreError> {
        Ok(())
    }
}