//! Department use cases (SP-1b, `plan` Task 8): `create`, `get`, `list`,
//! `update`, `set_archived`, `reorder`.
//!
//! # Authorization
//!
//! Every use case requires `Permission::ManageDepartments` before any pool
//! acquisition: a Sales session is refused without touching storage. The
//! permission itself carries no re-authentication requirement (`plan` Task 5 —
//! creating a department is routine), so assurance is not re-checked here.
//!
//! # Attribution
//!
//! `created_by` / `updated_by` come from the resolved [`Session`] and can never
//! be supplied by a caller, exactly as in the catalogue. Each write opens one
//! transaction on the pool and commits the domain mutation, the repository
//! write and the audit event together.

use std::fmt;

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::organisation::department as repo;
use crate::domain::identity::{DomainError, Permission, Session, Timestamp};
use crate::domain::organisation::{
    CostMethod, Department, DepartmentError, DepartmentId, DepartmentName, DepartmentVat, VatRate,
};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// What a caller supplies to create or fully edit a department.
///
/// VAT crosses the boundary as three plain fields rather than as a domain
/// object: the WebView is a transport, and constructing [`DepartmentVat`] —
/// including its "enabled without a rate" refusal — stays in Rust.
#[derive(Debug, Clone)]
pub struct DepartmentInput {
    pub name: String,
    pub cost_method: CostMethod,
    pub vat: VatInput,
    pub sort_order: i64,
}

/// VAT as it arrives from the transport.
#[derive(Debug, Clone)]
pub struct VatInput {
    pub enabled: bool,
    pub rate_bp: Option<i64>,
    pub inclusive: bool,
}

impl VatInput {
    /// Build the domain value, letting both refusals surface: a negative rate
    /// from [`VatRate::new`], "enabled without a rate" from
    /// [`DepartmentVat::new`].
    fn into_domain(self) -> Result<DepartmentVat, DepartmentError> {
        let rate = match self.rate_bp {
            Some(basis_points) => Some(VatRate::new(basis_points)?),
            None => None,
        };
        DepartmentVat::new(self.enabled, rate, self.inclusive)
    }
}

/// Everything this service can refuse.
///
/// Two families with two vocabularies: identity refusals (no session, no
/// permission, storage down) and department refusals (name empty, archived,
/// missing). The command layer flattens them into a single stable code, so the
/// frontend sees one table while the Rust side keeps the distinction sharp.
#[derive(Debug)]
pub enum DepartmentServiceError {
    Identity(DomainError),
    Department(DepartmentError),
}

impl From<DomainError> for DepartmentServiceError {
    fn from(error: DomainError) -> Self {
        Self::Identity(error)
    }
}

impl From<DepartmentError> for DepartmentServiceError {
    fn from(error: DepartmentError) -> Self {
        Self::Department(error)
    }
}

impl DepartmentServiceError {
    /// Delegates to whichever domain enum produced it, so no code is invented
    /// at this layer and the drift guard keeps covering both tables.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Identity(error) => error.code(),
            Self::Department(error) => error.code(),
        }
    }
}

impl fmt::Display for DepartmentServiceError {
    /// Developer-facing only; the operator reads the Arabic message indexed by
    /// [`DepartmentServiceError::code`].
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Identity(error) => write!(f, "{error}"),
            Self::Department(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for DepartmentServiceError {}

/// Resolve the current operator and require department management.
async fn authorize(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Session, DepartmentServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageDepartments)?;
    Ok(session)
}

/// Create a department: active, never archived, with the manager's own order.
pub async fn create(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: DepartmentInput,
) -> Result<Department, DepartmentServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let name = DepartmentName::new(&input.name)?;
    let vat = input.vat.into_domain()?;
    let department = Department::new(
        name,
        input.cost_method,
        vat,
        input.sort_order,
        actor,
        now.as_millis(),
    );

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    repo::insert(&mut tx, &department)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        actor,
        audit::event::DEPARTMENT_CREATED,
        now,
        Some(format!(
            r#"{{"target":"{}","name":"{}"}}"#,
            department.id.as_str(),
            department.name.as_str()
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(department)
}

/// One department by id, or [`DepartmentError::NotFound`].
pub async fn get(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: DepartmentId,
) -> Result<Department, DepartmentServiceError> {
    authorize(pool, tokens).await?;

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let department = repo::find_by_id(&mut conn, id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DepartmentError::NotFound)?;
    Ok(department)
}

/// Every department, active and archived, in display order.
///
/// `list_all` rather than the active-only list: an archived department is a
/// record the manager may need to see (and restore), and hiding it would make
/// `set_archived(false)` unreachable from the panel.
pub async fn list(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Vec<Department>, DepartmentServiceError> {
    authorize(pool, tokens).await?;

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let departments = repo::list_all(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(departments)
}

/// Apply a full edit. The edit dialog round-trips every editable field, so the
/// replacement matches [`Department::update`]'s full-replacement signature and
/// there is no partial-update ambiguity about what "unchanged" means.
pub async fn update(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: DepartmentId,
    input: DepartmentInput,
) -> Result<Department, DepartmentServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let name = DepartmentName::new(&input.name)?;
    let vat = input.vat.into_domain()?;

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    let mut department = repo::find_by_id(&mut tx, id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DepartmentError::NotFound)?;

    department.update(
        name,
        input.cost_method,
        vat,
        input.sort_order,
        actor,
        now.as_millis(),
    )?;
    repo::update(&mut tx, &department)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        actor,
        audit::event::DEPARTMENT_UPDATED,
        now,
        Some(format!(r#"{{"target":"{}"}}"#, department.id.as_str())),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(department)
}

/// Archive, or restore an archived department back to active.
///
/// Two domain transitions with two dedicated repository statements and two
/// different audit facts: an archive is its own event, while a restore is an
/// `department_updated` whose detail names the previous state — a separate
/// event name would double the vocabulary without adding a fact
/// (`plan` Task 7).
pub async fn set_archived(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: DepartmentId,
    archived: bool,
) -> Result<Department, DepartmentServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    let mut department = repo::find_by_id(&mut tx, id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DepartmentError::NotFound)?;

    if archived {
        department.archive(actor, now.as_millis())?;
        repo::archive(&mut tx, &department)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        audit::append(
            &mut tx,
            actor,
            audit::event::DEPARTMENT_ARCHIVED,
            now,
            Some(format!(r#"{{"target":"{}"}}"#, department.id.as_str())),
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    } else {
        department.restore(actor, now.as_millis())?;
        repo::restore(&mut tx, &department)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        audit::append(
            &mut tx,
            actor,
            audit::event::DEPARTMENT_UPDATED,
            now,
            Some(format!(
                r#"{{"target":"{}","previous_status":"archived"}}"#,
                department.id.as_str()
            )),
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    }

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(department)
}

/// Apply a manager-chosen order: `position` becomes each department's
/// `sort_order`, in the given sequence.
///
/// The caller sends the complete ordered id list — the panel has it, having
/// just rendered it — and every id must resolve: an unknown id fails the whole
/// transaction rather than silently shifting the remaining positions. Each
/// department is pushed through the ordinary [`Department::update`] path, so an
/// archived id is refused by the domain exactly as an edit would be, and
/// attribution is stamped on every row whose order actually changed.
pub async fn reorder(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    ordered_ids: Vec<DepartmentId>,
) -> Result<Vec<Department>, DepartmentServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    let mut reordered = Vec::with_capacity(ordered_ids.len());

    for (position, id) in ordered_ids.iter().enumerate() {
        let mut department = repo::find_by_id(&mut tx, *id)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
            .ok_or(DepartmentError::NotFound)?;

        department.update(
            department.name.clone(),
            department.cost_method,
            department.vat.clone(),
            position as i64,
            actor,
            now.as_millis(),
        )?;
        repo::update(&mut tx, &department)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        reordered.push(department);
    }

    let ids_json = ordered_ids
        .iter()
        .map(|id| format!("\"{}\"", id.as_str()))
        .collect::<Vec<_>>()
        .join(",");
    audit::append(
        &mut tx,
        actor,
        audit::event::DEPARTMENT_UPDATED,
        now,
        Some(format!(r#"{{"reorder":[{ids_json}]}}"#)),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(reordered)
}
