//! Customer file use cases (P4, `spec:30`, `spec:178-179`).
//!
//! # Authorization split
//!
//! Creating a customer requires `Permission::Sell`: both roles hold it, so a
//! sales user can enter a new customer for an invoice (`spec:18`, CUST-02)
//! and a manager can too. Browsing (list/get) requires
//! `Permission::ManageCustomers`, which only managers hold, so a sales user
//! can never browse purchase history (`spec:18`, CUST-03). The frontend hides
//! browsing for sales as presentation; this gate is the enforcement.
//!
//! # No merge
//!
//! Creation never checks for a similar name. There is no find-by-name path
//! anywhere in the stack, so `spec:178` holds structurally rather than by a
//! comparison the code could forget.

use std::fmt;

use sqlx::SqlitePool;

use crate::data::repositories::customer as repo;
use crate::data::repositories::identity::audit;
use crate::domain::customer::{
    Customer, CustomerError, CustomerLedgerEntry, CustomerWithBalance, NewCustomer,
    NewCustomerPayment,
};
use crate::domain::identity::{DomainError, Permission, Sensitivity, Timestamp, UserId};
use crate::services::wallet as wallet_service;
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// Everything this service can refuse: identity failures (no session, no
/// permission, storage down) and customer failures (invalid input, unknown
/// id). Flattened to one stable code at the command boundary.
#[derive(Debug)]
pub enum CustomerServiceError {
    Identity(DomainError),
    Customer(CustomerError),
}

impl From<DomainError> for CustomerServiceError {
    fn from(error: DomainError) -> Self {
        Self::Identity(error)
    }
}

impl From<CustomerError> for CustomerServiceError {
    fn from(error: CustomerError) -> Self {
        Self::Customer(error)
    }
}

impl CustomerServiceError {
    /// Delegates to the two domain enums; this layer invents no codes, so the
    /// drift guard keeps covering everything the frontend can see.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Identity(error) => error.code(),
            Self::Customer(error) => error.code(),
        }
    }
}

impl fmt::Display for CustomerServiceError {
    /// Developer-facing only; the operator reads the Arabic message indexed by
    /// [`CustomerServiceError::code`].
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Identity(error) => write!(f, "{error}"),
            Self::Customer(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for CustomerServiceError {}

/// Resolve the current operator. Creation is open to sellers (both roles).
async fn authorize_seller(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<crate::domain::identity::Session, CustomerServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    Ok(session)
}

/// Resolve the current operator. Browsing is manager-only.
async fn authorize_manager(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<crate::domain::identity::Session, CustomerServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCustomers)?;
    Ok(session)
}

/// Create a customer for an invoice. Never dedups: similar names coexist.
pub async fn create(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: NewCustomer,
) -> Result<Customer, CustomerServiceError> {
    let session = authorize_seller(pool, tokens).await?;
    let (name, contact) = input.cleaned()?;
    let now = Timestamp::now();
    let customer = Customer {
        id: UserId::generate().as_str().to_string(),
        name,
        contact,
        archived: false,
        created_by: session.user_id(),
        created_at: now,
        updated_at: now,
    };

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    repo::insert(&mut tx, &customer)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        customer.created_by,
        audit::event::CUSTOMER_CREATED,
        now,
        Some(serde_json::json!({ "customer_id": customer.id }).to_string()),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(customer)
}

/// Read one customer. Manager-only.
pub async fn get(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: &str,
) -> Result<Customer, CustomerServiceError> {
    authorize_manager(pool, tokens).await?;
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    repo::find_by_id(&mut conn, id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(CustomerError::NotFound.into())
}

/// List live customers for a manager. Never for sales: the gate above runs
/// before any row is read.
pub async fn list(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Vec<Customer>, CustomerServiceError> {
    authorize_manager(pool, tokens).await?;
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(repo::list_unarchived(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?)
}

/// Archive a customer. History keeps its references (ID-04); nothing is
/// deleted and nothing is merged.
pub async fn archive(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: &str,
) -> Result<Customer, CustomerServiceError> {
    let session = authorize_manager(pool, tokens).await?;
    let now = Timestamp::now();
    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let mut customer = repo::find_by_id(&mut tx, id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(CustomerError::NotFound)?;
    if customer.archived {
        return Err(CustomerError::IsArchived.into());
    }
    customer.archived = true;
    customer.updated_at = now;
    repo::set_archived(&mut tx, id, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        session.user_id(),
        audit::event::CUSTOMER_ARCHIVED,
        now,
        Some(serde_json::json!({ "customer_id": id }).to_string()),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(customer)
}

/// Read one customer together with their current آجل balance (`ADR-020` §3).
pub async fn get_with_balance(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: &str,
) -> Result<CustomerWithBalance, CustomerServiceError> {
    authorize_seller(pool, tokens).await?;
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let customer = repo::find_by_id(&mut conn, id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(CustomerError::NotFound)?;
    let balance_minor = repo::balance_minor(&mut conn, id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(CustomerWithBalance {
        customer,
        balance_minor,
    })
}

/// List live customers together with their current آجل balance (`ADR-020` §3).
/// Open to `Permission::Sell` so POS operators can pick a customer for an آجل
/// invoice and see their balance.
pub async fn list_with_balances(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Vec<CustomerWithBalance>, CustomerServiceError> {
    authorize_seller(pool, tokens).await?;
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(repo::list_unarchived_with_balances(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?)
}

/// Record a customer payment against their آجل balance (`ADR-020` §3).
pub async fn record_payment(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: NewCustomerPayment,
) -> Result<CustomerWithBalance, CustomerServiceError> {
    let session = authorize_seller(pool, tokens).await?;
    session.require_sensitivity(Sensitivity::Routine, Timestamp::now())?;
    let (amount_minor, method, note, chosen_wallet) = input.cleaned()?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let customer = repo::find_by_id(&mut tx, &input.customer_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(CustomerError::NotFound)?;
    if customer.archived {
        return Err(CustomerError::IsArchived.into());
    }
    let current_balance = repo::balance_minor(&mut tx, &customer.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if amount_minor > current_balance {
        return Err(CustomerError::PaymentExceedsBalance.into());
    }

    // Which number of the shop the customer sent the money to — named at the counter, or the
    // primary for the method when nobody looked at the list (`ADR-041`).
    let wallet_id = wallet_service::resolve_payment_wallet_id(
        &mut tx,
        &method,
        chosen_wallet.as_deref(),
    )
    .await
    .map_err(|err| match err {
        wallet_service::PaymentWalletFailure::NotEligible(_) => {
            CustomerError::PaymentWalletInvalid.into()
        }
        wallet_service::PaymentWalletFailure::Storage(_) => DomainError::StorageUnavailable.into(),
    })?;

    let entry = CustomerLedgerEntry {
        id: UserId::generate().as_str().to_string(),
        customer_id: customer.id.clone(),
        kind: "payment".to_owned(),
        amount_minor: -amount_minor,
        method: Some(method.clone()),
        wallet_id,
        sale_id: None,
        note,
        actor_id: actor,
        occurred_at: now,
    };
    repo::insert_ledger_entry(&mut tx, &entry)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        actor,
        audit::event::CUSTOMER_PAYMENT_RECORDED,
        now,
        Some(
            serde_json::json!({
                "customer_id": customer.id,
                "amount_minor": amount_minor,
                "method": method,
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(CustomerWithBalance {
        customer,
        balance_minor: current_balance - amount_minor,
    })
}

/// List a customer's credit ledger entries, newest first (`ADR-020` §3).
pub async fn list_ledger(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    customer_id: &str,
) -> Result<Vec<CustomerLedgerEntry>, CustomerServiceError> {
    authorize_seller(pool, tokens).await?;
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let _ = repo::find_by_id(&mut conn, customer_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(CustomerError::NotFound)?;
    Ok(repo::list_ledger_entries(&mut conn, customer_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?)
}
