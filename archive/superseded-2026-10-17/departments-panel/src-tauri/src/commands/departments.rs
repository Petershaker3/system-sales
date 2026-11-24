//! Tauri commands for departments (SP-1b, `plan` Task 8).
//!
//! Transport boundaries only. No SQL and no business rule appears here.
//!
//! # No session, token, role or actor parameter, on purpose
//!
//! Same discipline as the catalogue and lifecycle modules: each command
//! resolves the operator from the OS credential store inside the use case, so
//! a caller can never assert who it is, and an architecture guard parses these
//! signatures to keep it that way.

use serde::Serialize;
use tauri::State;

use crate::domain::organisation::{CostMethod, Department, DepartmentError, DepartmentId};
use crate::services::identity::IdentityContext;
use crate::services::organisation::departments::{
    self as use_cases, DepartmentInput, DepartmentServiceError, VatInput,
};

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure crossing the boundary is a stable code, never prose.
/// `spec:127` keeps user-facing text in Arabic message files on the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepartmentCommandError {
    pub code: &'static str,
}

impl From<DepartmentServiceError> for DepartmentCommandError {
    fn from(error: DepartmentServiceError) -> Self {
        Self { code: error.code() }
    }
}

/// VAT as the frontend sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepartmentVatDto {
    pub enabled: bool,
    pub rate_bp: Option<i64>,
    pub inclusive: bool,
}

/// A department as the frontend sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepartmentDto {
    pub id: String,
    pub name: String,
    pub status: String,
    pub cost_method: String,
    pub vat: DepartmentVatDto,
    pub sort_order: i64,
    pub created_by: String,
    pub updated_by: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

impl From<&Department> for DepartmentDto {
    fn from(department: &Department) -> Self {
        Self {
            id: department.id.as_str(),
            name: department.name.as_str().to_string(),
            status: department.status.as_str().to_string(),
            cost_method: department.cost_method.as_str().to_string(),
            vat: DepartmentVatDto {
                enabled: department.vat.is_enabled(),
                rate_bp: department.vat.rate().map(|rate| rate.as_basis_points()),
                inclusive: department.vat.is_inclusive(),
            },
            sort_order: department.sort_order,
            created_by: department.created_by.as_str(),
            updated_by: department.updated_by.as_str(),
            created_at: department.created_at,
            updated_at: department.updated_at,
            archived_at: department.archived_at,
        }
    }
}

fn parse_id(raw: &str) -> Result<DepartmentId, DepartmentCommandError> {
    uuid::Uuid::parse_str(raw).map(DepartmentId::from_uuid).map_err(|_| {
        DepartmentCommandError {
            code: DepartmentError::NotFound.code(),
        }
    })
}

/// Parse the cost-method enum at the boundary.
///
/// An unrecognised value is refused with the same code the catalogue gives an
/// unrecognised `Disposition`: unreachable from the real panel (its options are
/// fixed), and a fifth error code for a case no operator can hit would widen
/// the vocabulary for nothing.
fn parse_cost_method(raw: &str) -> Result<CostMethod, DepartmentCommandError> {
    CostMethod::parse(raw).ok_or(DepartmentCommandError {
        code: crate::domain::identity::DomainError::PermissionDenied.code(),
    })
}

#[tauri::command]
pub async fn create_department(
    ctx: Ctx<'_>,
    name: String,
    cost_method: String,
    vat_enabled: bool,
    vat_rate_bp: Option<i64>,
    vat_inclusive: bool,
    sort_order: i64,
) -> Result<DepartmentDto, DepartmentCommandError> {
    let input = DepartmentInput {
        name,
        cost_method: parse_cost_method(&cost_method)?,
        vat: VatInput {
            enabled: vat_enabled,
            rate_bp: vat_rate_bp,
            inclusive: vat_inclusive,
        },
        sort_order,
    };
    let created = use_cases::create(&ctx.pool, ctx.tokens.as_ref(), input).await?;
    Ok((&created).into())
}

#[tauri::command]
pub async fn get_department(
    ctx: Ctx<'_>,
    id: String,
) -> Result<DepartmentDto, DepartmentCommandError> {
    let department = use_cases::get(&ctx.pool, ctx.tokens.as_ref(), parse_id(&id)?).await?;
    Ok((&department).into())
}

/// Every department, active and archived — the panel badges the archived rows
/// and offers the restore.
#[tauri::command]
pub async fn list_departments(ctx: Ctx<'_>) -> Result<Vec<DepartmentDto>, DepartmentCommandError> {
    let departments = use_cases::list(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(departments.iter().map(DepartmentDto::from).collect())
}

#[tauri::command]
pub async fn update_department(
    ctx: Ctx<'_>,
    id: String,
    name: String,
    cost_method: String,
    vat_enabled: bool,
    vat_rate_bp: Option<i64>,
    vat_inclusive: bool,
    sort_order: i64,
) -> Result<DepartmentDto, DepartmentCommandError> {
    let input = DepartmentInput {
        name,
        cost_method: parse_cost_method(&cost_method)?,
        vat: VatInput {
            enabled: vat_enabled,
            rate_bp: vat_rate_bp,
            inclusive: vat_inclusive,
        },
        sort_order,
    };
    let updated = use_cases::update(&ctx.pool, ctx.tokens.as_ref(), parse_id(&id)?, input).await?;
    Ok((&updated).into())
}

/// Archive, or restore an archived department (`archived = false`).
///
/// Never a delete: `spec:221` keeps a department linked to history, and the
/// row stays.
#[tauri::command]
pub async fn set_department_archived(
    ctx: Ctx<'_>,
    id: String,
    archived: bool,
) -> Result<DepartmentDto, DepartmentCommandError> {
    let updated =
        use_cases::set_archived(&ctx.pool, ctx.tokens.as_ref(), parse_id(&id)?, archived).await?;
    Ok((&updated).into())
}

/// Apply the panel's displayed order: the full id sequence, positions 0..n.
#[tauri::command]
pub async fn reorder_departments(
    ctx: Ctx<'_>,
    ordered_ids: Vec<String>,
) -> Result<Vec<DepartmentDto>, DepartmentCommandError> {
    let mut parsed = Vec::with_capacity(ordered_ids.len());
    for raw in ordered_ids {
        parsed.push(parse_id(&raw)?);
    }
    let reordered = use_cases::reorder(&ctx.pool, ctx.tokens.as_ref(), parsed).await?;
    Ok(reordered.iter().map(DepartmentDto::from).collect())
}
