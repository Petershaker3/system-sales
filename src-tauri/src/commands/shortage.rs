//! Tauri commands for manual and system-suggested shortages (`النواقص`, Plan item 1.15, `ADR-030`).
//!
//! Transport boundary only: no SQL and no session construction appears here.

use serde::Serialize;
use tauri::State;

use crate::domain::shortage::{ShortageEntry, ShortageSuggestion};
use crate::services::identity::IdentityContext;
use crate::services::shortage::{
    self as use_cases, AddShortageInput, AddShortageOutcome, ShortageServiceError,
};

type Ctx<'a> = State<'a, IdentityContext>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortageCommandError {
    pub code: &'static str,
}

impl From<ShortageServiceError> for ShortageCommandError {
    fn from(error: ShortageServiceError) -> Self {
        Self { code: error.code() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortageEntryDto {
    pub id: String,
    pub product_id: Option<String>,
    pub name: String,
    pub qty: i64,
    pub note: String,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub status: String,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    pub on_hand: Option<i64>,
    pub min_qty: Option<i64>,
}

impl From<ShortageEntry> for ShortageEntryDto {
    fn from(e: ShortageEntry) -> Self {
        Self {
            id: e.id,
            product_id: e.product_id,
            name: e.name,
            qty: e.qty,
            note: e.note,
            customer_name: e.customer_name,
            customer_phone: e.customer_phone,
            status: e.status,
            created_by: e.created_by,
            created_by_name: e.created_by_name,
            created_at: e.created_at,
            resolved_at: e.resolved_at,
            on_hand: e.on_hand,
            min_qty: e.min_qty,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortageSuggestionDto {
    pub product_id: String,
    pub name: String,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub on_hand: i64,
    pub min_qty: i64,
    pub suggested_qty: i64,
}

impl From<ShortageSuggestion> for ShortageSuggestionDto {
    fn from(s: ShortageSuggestion) -> Self {
        Self {
            product_id: s.product_id,
            name: s.name,
            category_id: s.category_id,
            category_name: s.category_name,
            on_hand: s.on_hand,
            min_qty: s.min_qty,
            suggested_qty: s.suggested_qty,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortagesOverviewDto {
    pub items: Vec<ShortageEntryDto>,
    pub suggestions: Vec<ShortageSuggestionDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddShortageOutcomeDto {
    pub entry: ShortageEntryDto,
    pub merged: bool,
}

impl From<AddShortageOutcome> for AddShortageOutcomeDto {
    fn from(o: AddShortageOutcome) -> Self {
        Self {
            entry: ShortageEntryDto::from(o.entry),
            merged: o.merged,
        }
    }
}

#[tauri::command]
pub async fn shortages_overview(
    ctx: Ctx<'_>,
) -> Result<ShortagesOverviewDto, ShortageCommandError> {
    let overview = use_cases::shortages_overview(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(ShortagesOverviewDto {
        items: overview
            .items
            .into_iter()
            .map(ShortageEntryDto::from)
            .collect(),
        suggestions: overview
            .suggestions
            .into_iter()
            .map(ShortageSuggestionDto::from)
            .collect(),
    })
}

#[tauri::command]
pub async fn add_shortage(
    ctx: Ctx<'_>,
    product_id: Option<String>,
    name: Option<String>,
    qty: i64,
    note: Option<String>,
    customer_name: Option<String>,
    customer_phone: Option<String>,
) -> Result<AddShortageOutcomeDto, ShortageCommandError> {
    let outcome = use_cases::add_shortage(
        &ctx.pool,
        ctx.tokens.as_ref(),
        AddShortageInput {
            product_id,
            name,
            qty,
            note,
            customer_name,
            customer_phone,
        },
    )
    .await?;
    Ok(AddShortageOutcomeDto::from(outcome))
}

#[tauri::command]
pub async fn set_shortage_status(
    ctx: Ctx<'_>,
    shortage_id: String,
    status: String,
) -> Result<ShortageEntryDto, ShortageCommandError> {
    let entry =
        use_cases::set_shortage_status(&ctx.pool, ctx.tokens.as_ref(), &shortage_id, &status)
            .await?;
    Ok(ShortageEntryDto::from(entry))
}

#[tauri::command]
pub async fn resolve_shortage(
    ctx: Ctx<'_>,
    shortage_id: String,
) -> Result<ShortageEntryDto, ShortageCommandError> {
    let entry = use_cases::resolve_shortage(&ctx.pool, ctx.tokens.as_ref(), &shortage_id).await?;
    Ok(ShortageEntryDto::from(entry))
}

#[tauri::command]
pub async fn delete_shortage(
    ctx: Ctx<'_>,
    shortage_id: String,
) -> Result<ShortageEntryDto, ShortageCommandError> {
    let entry = use_cases::delete_shortage(&ctx.pool, ctx.tokens.as_ref(), &shortage_id).await?;
    Ok(ShortageEntryDto::from(entry))
}

#[tauri::command]
pub async fn add_all_suggested_shortages(
    ctx: Ctx<'_>,
) -> Result<Vec<ShortageEntryDto>, ShortageCommandError> {
    let added = use_cases::add_all_suggested_shortages(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(added.into_iter().map(ShortageEntryDto::from).collect())
}
