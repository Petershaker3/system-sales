//! Application services and use cases.
//!
//! Orchestration across repositories and infrastructure. No SQL here; queries
//! live under `data/repositories/`.

pub mod auth;
pub mod bootstrap;
pub mod crypto;
pub mod password;
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
