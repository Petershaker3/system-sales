//! Catalogue use cases.
//!
//! Orchestration across the catalogue repository and the identity session. No
//! SQL here.

pub mod pos;
pub mod product;

use std::sync::Arc;

use crate::domain::identity::{DomainError, Session};
use crate::services::identity::secure_store::SecureTokenStore;
use sqlx::SqlitePool;

/// What a catalogue use case needs.
///
/// Carries the pool and the credential store together, so a command cannot be
/// given one without the other. Session resolution is therefore available to
/// every catalogue command without any of them accepting a session parameter —
/// which is what keeps `created_by` out of the caller's hands.
pub struct CatalogContext {
    pub pool: SqlitePool,
    pub tokens: Arc<dyn SecureTokenStore>,
}

impl CatalogContext {
    pub fn new(pool: SqlitePool, tokens: Arc<dyn SecureTokenStore>) -> Self {
        Self { pool, tokens }
    }
}

/// Resolve the current operator, or fail if there is none.
pub async fn require_session(ctx: &CatalogContext) -> Result<Session, DomainError> {
    crate::services::identity::session::resolve(&ctx.pool, ctx.tokens.as_ref()).await
}
