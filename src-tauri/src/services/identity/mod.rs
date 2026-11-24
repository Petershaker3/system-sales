//! Application services and use cases.
//!
//! Orchestration across repositories and infrastructure. No SQL here; queries
//! live under `data/repositories/`.

pub mod approval;
pub mod auth;
pub mod bootstrap;
pub mod crypto;
/// Running the shop before it has an account: the open owner row, its session,
/// and the claim that turns it into the owner's account (`ADR-039`).
pub mod open_mode;
pub mod password;
pub mod pin;
/// The owner's recovery code (ADR-017 §4): make one, and replace a forgotten
/// password with it.
pub mod recovery_code;
pub mod secure_store;
pub mod session;
pub mod users;

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::services::identity::secure_store::SecureTokenStore;

/// What an identity use case needs.
///
/// Carries the pool and the credential store together, so a command cannot be given
/// one without the other.
pub struct IdentityContext {
    pub pool: SqlitePool,
    pub tokens: Arc<dyn SecureTokenStore>,
}

impl IdentityContext {
    pub fn new(pool: SqlitePool, tokens: Arc<dyn SecureTokenStore>) -> Self {
        Self { pool, tokens }
    }
}
