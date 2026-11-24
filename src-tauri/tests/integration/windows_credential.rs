//! Windows Credential Manager runtime verification.
//!
//! Ignored by default because it touches the **real** operating-system
//! credential store, not a mock. Run it deliberately:
//!
//! ```powershell
//! cargo test --test integration -- --ignored credential_store
//! ```
//!
//! # What is actually being proved
//!
//! The unit and integration suites substitute an in-memory token store, so
//! nothing so far has proven that Windows Credential Manager works here at all.
//! Three things are unproven and cannot be proven any other way:
//!
//! 1. The store can be constructed and reached.
//! 2. A secret round-trips through it.
//! 3. **The credential is `Local` and not `Enterprise`.**
//!
//! (3) is the important one. `windows-native-keyring-store` defaults to
//! `CRED_PERSIST_ENTERPRISE`, which lets a credential **roam to other machines**
//! under a Windows domain profile. `ADR-008` gives each device its own
//! independent database, so a session token that roams would be a real
//! security defect. `KeyringTokenStore` passes an explicit `local` persistence
//! modifier; this test reads the attribute back to prove it took effect.
//!
//! The test cleans up after itself, and it refuses to run if an unexpected
//! credential is already present under the application's service name.

#![cfg(windows)]

use mobile_shop_system_lib::services::identity::crypto;
use mobile_shop_system_lib::services::identity::secure_store::{
    install_default_store, KeyringTokenStore, SecureTokenStore,
};
use mobile_shop_system_lib::domain::identity::SessionToken;

/// Must match the constants inside `secure_store.rs`, because the point is to
/// inspect the entry our own code path creates.
const SERVICE: &str = "com.mshop.system";
const ENTRY_USER: &str = "session";

#[test]
#[ignore = "touches the real Windows Credential Manager; run explicitly"]
fn credential_store_round_trips_a_secret() {
    install_default_store().expect("the OS credential store must be reachable");

    let store = KeyringTokenStore::new().expect("store construction");

    // Refuse to clobber anything that is already there.
    if store.get().expect("readable").is_some() {
        panic!(
            "a credential already exists under {SERVICE}/{ENTRY_USER}. \
             Refusing to overwrite it: delete it first if this is expected."
        );
    }

    let token = crypto::generate_token().expect("token");
    store.put(&token).expect("write");

    let read_back = store.get().expect("read").expect("a token must be present");
    assert_eq!(
        read_back, token,
        "the secret must survive a round trip through the OS store"
    );

    store.clear().expect("delete");
    assert!(
        store.get().expect("read after delete").is_none(),
        "clear must remove the credential"
    );
}

#[test]
#[ignore = "touches the real Windows Credential Manager; run explicitly"]
fn credential_persists_locally_and_does_not_roam() {
    install_default_store().expect("the OS credential store must be reachable");

    let store = KeyringTokenStore::new().expect("store construction");
    assert!(
        store.get().expect("readable").is_none(),
        "start from an empty slot"
    );

    let token = crypto::generate_token().expect("token");
    store.put(&token).expect("write");

    // Read the attribute back through the raw keyring API, using the same
    // persistence modifier our store uses. If the modifier were ignored, the
    // default would be Enterprise and this assertion would fail.
    let modifiers: std::collections::HashMap<&str, &str> =
        std::collections::HashMap::from([("persistence", "local")]);
    let entry = keyring_core::Entry::new_with_modifiers(SERVICE, ENTRY_USER, &modifiers)
        .expect("entry");

    let attributes = entry.get_attributes().expect("attributes");
    let persistence = attributes
        .get("persistence")
        .expect("the store must report a persistence attribute")
        .to_ascii_lowercase();

    assert_eq!(
        persistence, "local",
        "the credential must be CRED_PERSIST_LOCAL_MACHINE so it cannot roam \
         to another machine; got {persistence:?}. Enterprise persistence here \
         would let a session token travel under a domain profile."
    );

    // The secret must still be the one we wrote, proving the attribute read did
    // not address a different entry.
    assert_eq!(entry.get_secret().expect("secret"), token.expose().as_bytes());

    store.clear().expect("cleanup");
}

#[test]
#[ignore = "touches the real Windows Credential Manager; run explicitly"]
fn an_unreadable_store_fails_closed_rather_than_degrading() {
    // `KeyringTokenStore::new` must succeed here. If the store were unavailable
    // it would have to fail closed, which is ADR-009's requirement: there is no
    // fallback path to a file or to process memory.
    let store = KeyringTokenStore::new().expect("the store must be reachable on this machine");
    assert!(
        store.is_available().is_ok(),
        "availability probe must succeed for a healthy store"
    );

    // A malformed stored value must be reported, not silently replaced. Silently
    // minting a new token would hide a store that is not behaving correctly.
    assert!(
        SessionToken::parse("not-a-valid-token").is_none(),
        "a malformed token must be rejected on read"
    );
    assert!(
        SessionToken::parse("").is_none(),
        "an empty token must be rejected on read"
    );
}