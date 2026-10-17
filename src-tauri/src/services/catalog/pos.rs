//! The sales screen's catalogue (plan item 1.6).
//!
//! `Permission::Sell`, so a seller can see what to sell. Before this, the
//! screen read `list_products`, which needs `ManageCatalog`: a seller could not
//! load the product list at all. The read carries no cost, so it needs no
//! fresh proof and opens nothing that `Sell` did not already imply — a sale
//! reads the same names, prices and stock inside its own transaction.

use sqlx::SqlitePool;

use crate::data::repositories::catalog::pos as repo;
use crate::domain::identity::{DomainError, Permission, Timestamp};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// How far back "sold recently" looks when ordering the tiles.
const RECENT_WINDOW_MILLIS: i64 = 30 * 24 * 60 * 60 * 1000;

/// What the sales screen needs, in one read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PosCatalog {
    pub products: Vec<repo::PosProductRow>,
    pub departments: Vec<repo::PosDepartmentRow>,
}

/// Read the sellable catalogue. No mutation, no transaction, no cost.
pub async fn read(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<PosCatalog, DomainError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let since = Timestamp::now().as_millis().saturating_sub(RECENT_WINDOW_MILLIS);
    let products = repo::list_sellable(&mut conn, since)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let departments = repo::list_departments(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(PosCatalog {
        products,
        departments,
    })
}
