//! Tauri commands for Repairs & Software (`الصيانة والسوفت وير`, Plan item 2.1, `ADR-031`).
//!
//! Transport boundary only: no SQL and no session construction appears here.

use serde::Serialize;
use tauri::State;

use crate::domain::repair::{
    RepairKindFinancialBucket, RepairTechnicianSummary, RepairTicket, RepairsOverview,
};
use crate::services::identity::IdentityContext;
use crate::services::repair::{
    self as use_cases, CreateRepairInput, DeliverRepairInput, RepairServiceError,
    UpdateRepairStatusInput,
};

type Ctx<'a> = State<'a, IdentityContext>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairCommandError {
    pub code: &'static str,
}

impl From<RepairServiceError> for RepairCommandError {
    fn from(error: RepairServiceError) -> Self {
        Self { code: error.code() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairTicketDto {
    pub id: String,
    pub ticket_no: String,
    pub service_kind: String,
    pub customer_name: String,
    pub customer_phone: String,
    pub device_name: String,
    pub imei: Option<String>,
    pub device_lock: String,
    pub issue: String,
    pub accessories: String,
    pub due_label: String,
    pub status: String,
    pub estimated_price_minor: i64,
    pub final_price_minor: i64,
    pub parts_cost_minor: Option<i64>,
    pub net_profit_minor: Option<i64>,
    pub deposit_minor: i64,
    pub collected_minor: i64,
    pub remaining_minor: i64,
    pub pay_method: String,
    pub technician_name: Option<String>,
    pub warranty_days: i64,
    pub note: String,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: i64,
    pub delivered_at: Option<i64>,
}

impl From<RepairTicket> for RepairTicketDto {
    fn from(t: RepairTicket) -> Self {
        Self {
            id: t.id,
            ticket_no: t.ticket_no,
            service_kind: t.service_kind,
            customer_name: t.customer_name,
            customer_phone: t.customer_phone,
            device_name: t.device_name,
            imei: t.imei,
            device_lock: t.device_lock,
            issue: t.issue,
            accessories: t.accessories,
            due_label: t.due_label,
            status: t.status,
            estimated_price_minor: t.estimated_price_minor,
            final_price_minor: t.final_price_minor,
            parts_cost_minor: t.parts_cost_minor,
            net_profit_minor: t.net_profit_minor,
            deposit_minor: t.deposit_minor,
            collected_minor: t.collected_minor,
            remaining_minor: t.remaining_minor,
            pay_method: t.pay_method,
            technician_name: t.technician_name,
            warranty_days: t.warranty_days,
            note: t.note,
            created_by: t.created_by,
            created_by_name: t.created_by_name,
            created_at: t.created_at,
            delivered_at: t.delivered_at,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairKindFinancialBucketDto {
    pub service_kind: String,
    pub tickets_count: i64,
    pub open_count: i64,
    pub ready_count: i64,
    pub delivered_count: i64,
    pub deposit_collected_minor: i64,
    pub delivery_collected_minor: i64,
    pub total_revenue_minor: i64,
    pub cash_collected_minor: i64,
    pub vf_collected_minor: i64,
    pub instapay_collected_minor: i64,
    pub card_collected_minor: i64,
    pub parts_cost_minor: Option<i64>,
    pub net_profit_minor: Option<i64>,
}

impl From<RepairKindFinancialBucket> for RepairKindFinancialBucketDto {
    fn from(b: RepairKindFinancialBucket) -> Self {
        Self {
            service_kind: b.service_kind,
            tickets_count: b.tickets_count,
            open_count: b.open_count,
            ready_count: b.ready_count,
            delivered_count: b.delivered_count,
            deposit_collected_minor: b.deposit_collected_minor,
            delivery_collected_minor: b.delivery_collected_minor,
            total_revenue_minor: b.total_revenue_minor,
            cash_collected_minor: b.cash_collected_minor,
            vf_collected_minor: b.vf_collected_minor,
            instapay_collected_minor: b.instapay_collected_minor,
            card_collected_minor: b.card_collected_minor,
            parts_cost_minor: b.parts_cost_minor,
            net_profit_minor: b.net_profit_minor,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairTechnicianSummaryDto {
    pub technician_name: String,
    pub hardware_count: i64,
    pub software_count: i64,
    pub delivered_count: i64,
    pub hardware_revenue_minor: i64,
    pub software_revenue_minor: i64,
    pub total_revenue_minor: i64,
    pub parts_cost_minor: Option<i64>,
    pub net_profit_minor: Option<i64>,
}

impl From<RepairTechnicianSummary> for RepairTechnicianSummaryDto {
    fn from(s: RepairTechnicianSummary) -> Self {
        Self {
            technician_name: s.technician_name,
            hardware_count: s.hardware_count,
            software_count: s.software_count,
            delivered_count: s.delivered_count,
            hardware_revenue_minor: s.hardware_revenue_minor,
            software_revenue_minor: s.software_revenue_minor,
            total_revenue_minor: s.total_revenue_minor,
            parts_cost_minor: s.parts_cost_minor,
            net_profit_minor: s.net_profit_minor,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairsOverviewDto {
    pub tickets: Vec<RepairTicketDto>,
    pub hardware: RepairKindFinancialBucketDto,
    pub software: RepairKindFinancialBucketDto,
    pub combined: RepairKindFinancialBucketDto,
    pub technicians: Vec<RepairTechnicianSummaryDto>,
}

impl From<RepairsOverview> for RepairsOverviewDto {
    fn from(o: RepairsOverview) -> Self {
        Self {
            tickets: o.tickets.into_iter().map(RepairTicketDto::from).collect(),
            hardware: RepairKindFinancialBucketDto::from(o.hardware),
            software: RepairKindFinancialBucketDto::from(o.software),
            combined: RepairKindFinancialBucketDto::from(o.combined),
            technicians: o
                .technicians
                .into_iter()
                .map(RepairTechnicianSummaryDto::from)
                .collect(),
        }
    }
}

#[tauri::command]
pub async fn repairs_overview(
    ctx: Ctx<'_>,
    from_ts: Option<i64>,
    to_ts: Option<i64>,
) -> Result<RepairsOverviewDto, RepairCommandError> {
    let overview =
        use_cases::repairs_overview(&ctx.pool, ctx.tokens.as_ref(), from_ts, to_ts).await?;
    Ok(RepairsOverviewDto::from(overview))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_repair(
    ctx: Ctx<'_>,
    service_kind: String,
    customer_name: String,
    customer_phone: String,
    device_name: String,
    imei: Option<String>,
    device_lock: Option<String>,
    issue: String,
    accessories: Option<String>,
    due_label: Option<String>,
    estimated_price_minor: i64,
    parts_cost_minor: Option<i64>,
    deposit_minor: i64,
    pay_method: Option<String>,
    pay_wallet_id: Option<String>,
    technician_name: Option<String>,
    warranty_days: Option<i64>,
    note: Option<String>,
    deliver_now: Option<bool>,
) -> Result<RepairTicketDto, RepairCommandError> {
    let ticket = use_cases::create_repair(
        &ctx.pool,
        ctx.tokens.as_ref(),
        CreateRepairInput {
            service_kind,
            customer_name,
            customer_phone,
            device_name,
            imei,
            device_lock,
            issue,
            accessories,
            due_label,
            estimated_price_minor,
            parts_cost_minor,
            deposit_minor,
            pay_method,
            pay_wallet_id,
            technician_name,
            warranty_days,
            note,
            deliver_now: deliver_now.unwrap_or(false),
        },
    )
    .await?;
    Ok(RepairTicketDto::from(ticket))
}

#[tauri::command]
pub async fn update_repair_status(
    ctx: Ctx<'_>,
    id: String,
    status: String,
    technician_name: Option<String>,
    estimated_price_minor: Option<i64>,
    parts_cost_minor: Option<i64>,
    note: Option<String>,
) -> Result<RepairTicketDto, RepairCommandError> {
    let ticket = use_cases::update_repair_status(
        &ctx.pool,
        ctx.tokens.as_ref(),
        UpdateRepairStatusInput {
            id,
            status,
            technician_name,
            estimated_price_minor,
            parts_cost_minor,
            note,
        },
    )
    .await?;
    Ok(RepairTicketDto::from(ticket))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn deliver_repair(
    ctx: Ctx<'_>,
    id: String,
    final_price_minor: i64,
    parts_cost_minor: Option<i64>,
    pay_method: String,
    pay_wallet_id: Option<String>,
    technician_name: Option<String>,
    warranty_days: Option<i64>,
    note: Option<String>,
) -> Result<RepairTicketDto, RepairCommandError> {
    let ticket = use_cases::deliver_repair(
        &ctx.pool,
        ctx.tokens.as_ref(),
        DeliverRepairInput {
            id,
            final_price_minor,
            parts_cost_minor,
            pay_method,
            pay_wallet_id,
            technician_name,
            warranty_days,
            note,
        },
    )
    .await?;
    Ok(RepairTicketDto::from(ticket))
}

#[tauri::command]
pub async fn cancel_repair(
    ctx: Ctx<'_>,
    id: String,
    note: Option<String>,
) -> Result<RepairTicketDto, RepairCommandError> {
    let ticket =
        use_cases::cancel_repair(&ctx.pool, ctx.tokens.as_ref(), &id, note.as_deref()).await?;
    Ok(RepairTicketDto::from(ticket))
}
