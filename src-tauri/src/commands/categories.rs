//! Tauri commands for the category tree (ADR-018 §1).
//!
//! Transport boundaries only. No SQL and no business rule appears here. A
//! category is a `departments` row, so refusals carry the department
//! vocabulary's codes.
//!
//! # No session, token, role or actor parameter, on purpose
//!
//! Same discipline as every other command module: each command resolves the
//! operator from the OS credential store inside the use case, so a caller can
//! never assert who it is, and an architecture guard parses these signatures to
//! keep it that way.
//!
//! These replace the department commands of SP-1b (archived with their panel):
//! the costing method and VAT are inert since plan item 1.3, archiving gave way
//! to hiding and deleting an empty category, and a full re-order to moving one
//! place up or down.

use serde::Serialize;
use tauri::State;

use crate::domain::organisation::{CategoryKind, Department, DepartmentError, DepartmentId};
use crate::services::identity::IdentityContext;
use crate::services::organisation::categories::{
    self as use_cases, CategoryEntry, MoveStep, NewCategory,
};
use crate::services::organisation::departments::DepartmentServiceError;

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure crossing the boundary is a stable code, never prose.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryCommandError {
    pub code: &'static str,
}

impl From<DepartmentServiceError> for CategoryCommandError {
    fn from(error: DepartmentServiceError) -> Self {
        Self { code: error.code() }
    }
}

impl From<DepartmentError> for CategoryCommandError {
    fn from(error: DepartmentError) -> Self {
        Self { code: error.code() }
    }
}

/// A category as the screens see it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryDto {
    pub id: String,
    pub name: String,
    /// `null` for a main category.
    pub parent_id: Option<String>,
    /// `item`, `phone` or `used`.
    pub kind: &'static str,
    pub icon: String,
    pub hidden: bool,
    pub sort_order: i64,
}

impl From<&Department> for CategoryDto {
    fn from(category: &Department) -> Self {
        Self {
            id: category.id.as_str(),
            name: category.name.as_str().to_string(),
            parent_id: category.parent.map(|id| id.as_str()),
            kind: category.kind.as_str(),
            icon: category.icon.as_str().to_string(),
            hidden: category.hidden,
            sort_order: category.sort_order,
        }
    }
}

/// One row of the settings list: the category, its live products, and what may
/// be done to it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryEntryDto {
    #[serde(flatten)]
    pub category: CategoryDto,
    /// Live products directly in it (its sub-categories' not counted).
    pub products: i64,
    pub is_default: bool,
    pub deletable: bool,
}

impl From<&CategoryEntry> for CategoryEntryDto {
    fn from(entry: &CategoryEntry) -> Self {
        Self {
            category: CategoryDto::from(&entry.category),
            products: entry.products,
            is_default: entry.is_default,
            deletable: entry.deletable,
        }
    }
}

fn parse_id(raw: &str) -> Result<DepartmentId, CategoryCommandError> {
    uuid::Uuid::parse_str(raw)
        .map(DepartmentId::from_uuid)
        .map_err(|_| DepartmentError::NotFound.into())
}

/// Every live category in display order, with counts and what may be done.
#[tauri::command]
pub async fn list_categories(ctx: Ctx<'_>) -> Result<Vec<CategoryEntryDto>, CategoryCommandError> {
    let entries = use_cases::list(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(entries.iter().map(CategoryEntryDto::from).collect())
}

/// Add a category: a main one with its kind, or one under a main category.
#[tauri::command]
pub async fn create_category(
    ctx: Ctx<'_>,
    name: String,
    parent_id: Option<String>,
    kind: Option<String>,
    icon: String,
) -> Result<CategoryDto, CategoryCommandError> {
    let parent = match parent_id {
        Some(raw) => Some(parse_id(&raw)?),
        None => None,
    };
    let kind = match kind {
        Some(raw) => Some(CategoryKind::parse(&raw).ok_or(DepartmentError::KindMismatch)?),
        None => None,
    };
    let created = use_cases::create(
        &ctx.pool,
        ctx.tokens.as_ref(),
        NewCategory {
            name,
            parent,
            kind,
            icon,
        },
    )
    .await?;
    Ok(CategoryDto::from(&created))
}

#[tauri::command]
pub async fn rename_category(
    ctx: Ctx<'_>,
    id: String,
    name: String,
) -> Result<CategoryDto, CategoryCommandError> {
    let renamed = use_cases::rename(&ctx.pool, ctx.tokens.as_ref(), parse_id(&id)?, name).await?;
    Ok(CategoryDto::from(&renamed))
}

/// Show or hide a category's button on the sales screen.
#[tauri::command]
pub async fn set_category_hidden(
    ctx: Ctx<'_>,
    id: String,
    hidden: bool,
) -> Result<CategoryDto, CategoryCommandError> {
    let changed =
        use_cases::set_hidden(&ctx.pool, ctx.tokens.as_ref(), parse_id(&id)?, hidden).await?;
    Ok(CategoryDto::from(&changed))
}

/// Move a category one place among its siblings: `up` or `down`.
#[tauri::command]
pub async fn move_category(
    ctx: Ctx<'_>,
    id: String,
    direction: String,
) -> Result<CategoryDto, CategoryCommandError> {
    let step = match direction.as_str() {
        "up" => MoveStep::Up,
        "down" => MoveStep::Down,
        _ => return Err(DepartmentError::NotFound.into()),
    };
    let moved =
        use_cases::move_category(&ctx.pool, ctx.tokens.as_ref(), parse_id(&id)?, step).await?;
    Ok(CategoryDto::from(&moved))
}

/// Delete an empty category that is not a default.
#[tauri::command]
pub async fn delete_category(ctx: Ctx<'_>, id: String) -> Result<(), CategoryCommandError> {
    use_cases::delete(&ctx.pool, ctx.tokens.as_ref(), parse_id(&id)?).await?;
    Ok(())
}
