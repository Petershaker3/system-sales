//! Repairs & Software service (`الصيانة والسوفت وير`, Plan item 2.1, `ADR-031`, `PLAN.md` §13).
//!
//! Orchestrates hardware repair tickets (`service_kind = "hardware"`) and software
//! operations (`service_kind = "software"`), keeping their financial buckets
//! strictly separable while sharing the 5-stage Kanban board.

use std::fmt;

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::repair::{
    self as repair_repo, DeliverRepairUpdate, NewRepairRow,
};
use crate::data::repositories::settings::app_settings;
use crate::domain::identity::{DomainError, Permission, Role, Timestamp};
use crate::domain::repair::{
    validate_customer, validate_default_text, validate_device_name, validate_issue,
    validate_money_minor, validate_optional_text, validate_warranty_days, RepairError, RepairId,
    RepairPayMethod, RepairServiceKind, RepairStatus, RepairTicket, RepairsOverview,
    MAX_REPAIR_ACCESSORIES_CHARS, MAX_REPAIR_DUE_CHARS, MAX_REPAIR_IMEI_CHARS,
    MAX_REPAIR_LOCK_CHARS, MAX_REPAIR_NOTE_CHARS, MAX_REPAIR_TECHNICIAN_CHARS,
};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;
use crate::services::wallet as wallet_service;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepairServiceError {
    Identity(DomainError),
    Repair(RepairError),
}

impl RepairServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            RepairServiceError::Identity(e) => e.code(),
            RepairServiceError::Repair(e) => e.code(),
        }
    }
}

impl fmt::Display for RepairServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl From<DomainError> for RepairServiceError {
    fn from(value: DomainError) -> Self {
        RepairServiceError::Identity(value)
    }
}

impl From<RepairError> for RepairServiceError {
    fn from(value: RepairError) -> Self {
        RepairServiceError::Repair(value)
    }
}

#[derive(Debug, Clone)]
pub struct CreateRepairInput {
    pub service_kind: String,
    pub customer_name: String,
    pub customer_phone: String,
    pub device_name: String,
    pub imei: Option<String>,
    pub device_lock: Option<String>,
    pub issue: String,
    pub accessories: Option<String>,
    pub due_label: Option<String>,
    pub estimated_price_minor: i64,
    pub parts_cost_minor: Option<i64>,
    pub deposit_minor: i64,
    pub pay_method: Option<String>,
    /// The shop wallet that took the deposit — or the settlement, when the ticket is delivered at
    /// intake (`ADR-041`).
    pub pay_wallet_id: Option<String>,
    pub technician_name: Option<String>,
    pub warranty_days: Option<i64>,
    pub note: Option<String>,
    pub deliver_now: bool,
}

#[derive(Debug, Clone)]
pub struct UpdateRepairStatusInput {
    pub id: String,
    pub status: String,
    pub technician_name: Option<String>,
    pub estimated_price_minor: Option<i64>,
    pub parts_cost_minor: Option<i64>,
    pub note: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DeliverRepairInput {
    pub id: String,
    pub final_price_minor: i64,
    pub parts_cost_minor: Option<i64>,
    pub pay_method: String,
    /// The shop wallet the remaining amount is collected into (`ADR-041`).
    pub pay_wallet_id: Option<String>,
    pub technician_name: Option<String>,
    pub warranty_days: Option<i64>,
    pub note: Option<String>,
}

async fn can_view_cost(
    conn: &mut sqlx::SqliteConnection,
    role: Role,
) -> Result<bool, DomainError> {
    if role == Role::Manager {
        return Ok(true);
    }
    let val = app_settings::get(conn, "ui.seller_can_view_cost")
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(val.as_deref() == Some("on") || val.as_deref() == Some("true"))
}

pub async fn repairs_overview(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    from_ts: Option<i64>,
    to_ts: Option<i64>,
) -> Result<RepairsOverview, RepairServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let include_cost = can_view_cost(&mut conn, session.role()).await?;

    let overview = repair_repo::build_overview(&mut conn, from_ts, to_ts, include_cost)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(overview)
}

pub async fn create_repair(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: CreateRepairInput,
) -> Result<RepairTicket, RepairServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let service_kind = RepairServiceKind::parse(&input.service_kind)?;
    let (customer_name, customer_phone) =
        validate_customer(&input.customer_name, &input.customer_phone)?;
    let device_name = validate_device_name(&input.device_name)?;
    let imei = validate_optional_text(input.imei.as_deref(), MAX_REPAIR_IMEI_CHARS)?;
    let device_lock = validate_default_text(input.device_lock.as_deref(), "", MAX_REPAIR_LOCK_CHARS)?;
    let issue = validate_issue(&input.issue)?;
    let accessories =
        validate_default_text(input.accessories.as_deref(), "", MAX_REPAIR_ACCESSORIES_CHARS)?;
    let due_label =
        validate_default_text(input.due_label.as_deref(), "بكره", MAX_REPAIR_DUE_CHARS)?;
    let estimated_price_minor = validate_money_minor(input.estimated_price_minor)?;
    let parts_cost_minor = validate_money_minor(input.parts_cost_minor.unwrap_or(0))?;
    let deposit_minor = validate_money_minor(input.deposit_minor)?;
    let pay_method = RepairPayMethod::parse(input.pay_method.as_deref().unwrap_or("cash"))?;
    let technician_name =
        validate_optional_text(input.technician_name.as_deref(), MAX_REPAIR_TECHNICIAN_CHARS)?;
    let warranty_days = validate_warranty_days(input.warranty_days.unwrap_or(0))?;
    let note = validate_default_text(input.note.as_deref(), "", MAX_REPAIR_NOTE_CHARS)?;

    let now = Timestamp::now();
    let actor = session.user_id();
    let id = RepairId::generate();

    let (status, final_price_minor, effective_deposit, delivered_at) = if input.deliver_now {
        (
            RepairStatus::Delivered,
            estimated_price_minor,
            0,
            Some(now.as_millis()),
        )
    } else {
        (RepairStatus::Received, 0, deposit_minor, None)
    };

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let include_cost = can_view_cost(&mut tx, session.role()).await?;
    let ticket_no = repair_repo::next_ticket_no(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    // Resolved inside the transaction, before anything is written: a number that does not take
    // this method aborts the ticket rather than moving its money somewhere else (`ADR-041`).
    let pay_wallet_id = wallet_service::resolve_payment_wallet_id(
        &mut tx,
        pay_method.as_str(),
        input.pay_wallet_id.as_deref(),
    )
    .await
    .map_err(|err| match err {
        wallet_service::PaymentWalletFailure::Storage(_) => {
            RepairServiceError::from(DomainError::StorageUnavailable)
        }
        wallet_service::PaymentWalletFailure::NotEligible(_) => {
            RepairError::PayWalletInvalid.into()
        }
    })?;

    let raw = repair_repo::insert(
        &mut tx,
        NewRepairRow {
            id: &id,
            ticket_no: &ticket_no,
            service_kind,
            customer_name: &customer_name,
            customer_phone: &customer_phone,
            device_name: &device_name,
            imei: imei.as_deref(),
            device_lock: &device_lock,
            issue: &issue,
            accessories: &accessories,
            due_label: &due_label,
            status,
            estimated_price_minor,
            final_price_minor,
            parts_cost_minor,
            deposit_minor: effective_deposit,
            pay_method,
            technician_name: technician_name.as_deref(),
            warranty_days,
            note: &note,
            created_by: &actor.as_str(),
            created_at: now.as_millis(),
            delivered_at,
        },
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    if let Some(wallet_id) = pay_wallet_id.as_deref() {
        repair_repo::set_pay_wallet(&mut tx, id.as_str(), Some(wallet_id))
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
    }

    let detail = serde_json::json!({
        "repair_id": id.as_str(),
        "ticket_no": ticket_no,
        "service_kind": service_kind.as_str(),
        "status": status.as_str(),
        "estimated_price_minor": estimated_price_minor,
        "deposit_minor": effective_deposit,
    })
    .to_string();
    audit::append(&mut tx, actor, audit::event::REPAIR_CREATED, now, Some(detail))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(raw.into_ticket(include_cost))
}

pub async fn update_repair_status(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: UpdateRepairStatusInput,
) -> Result<RepairTicket, RepairServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let rid = RepairId::new(&input.id).ok_or(RepairError::NotFound)?;
    let status = RepairStatus::parse(&input.status)?;
    if matches!(status, RepairStatus::Delivered | RepairStatus::Cancelled) {
        return Err(RepairError::StatusInvalid.into());
    }
    let technician_name =
        validate_optional_text(input.technician_name.as_deref(), MAX_REPAIR_TECHNICIAN_CHARS)?;
    let estimated_price_minor = match input.estimated_price_minor {
        Some(v) => Some(validate_money_minor(v)?),
        None => None,
    };
    let parts_cost_minor = match input.parts_cost_minor {
        Some(v) => Some(validate_money_minor(v)?),
        None => None,
    };
    let note = match input.note.as_deref() {
        Some(raw) => Some(validate_default_text(Some(raw), "", MAX_REPAIR_NOTE_CHARS)?),
        None => None,
    };

    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let include_cost = can_view_cost(&mut tx, session.role()).await?;

    let existing = repair_repo::find_raw_by_id(&mut tx, rid.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(RepairError::NotFound)?;
    if matches!(existing.status.as_str(), "delivered" | "cancelled") {
        return Err(RepairError::AlreadyDelivered.into());
    }

    let updated = repair_repo::update_status_and_details(
        &mut tx,
        rid.as_str(),
        status,
        technician_name.as_deref(),
        estimated_price_minor,
        parts_cost_minor,
        note.as_deref(),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    let detail = serde_json::json!({
        "repair_id": rid.as_str(),
        "ticket_no": updated.ticket_no,
        "status": status.as_str(),
    })
    .to_string();
    audit::append(&mut tx, actor, audit::event::REPAIR_UPDATED, now, Some(detail))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(updated.into_ticket(include_cost))
}

pub async fn deliver_repair(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: DeliverRepairInput,
) -> Result<RepairTicket, RepairServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let rid = RepairId::new(&input.id).ok_or(RepairError::NotFound)?;
    let final_price_minor = validate_money_minor(input.final_price_minor)?;
    let parts_cost_opt = match input.parts_cost_minor {
        Some(v) => Some(validate_money_minor(v)?),
        None => None,
    };
    let pay_method = RepairPayMethod::parse(&input.pay_method)?;
    let technician_name =
        validate_optional_text(input.technician_name.as_deref(), MAX_REPAIR_TECHNICIAN_CHARS)?;
    let warranty_days = match input.warranty_days {
        Some(d) => Some(validate_warranty_days(d)?),
        None => None,
    };
    let note = match input.note.as_deref() {
        Some(raw) => Some(validate_default_text(Some(raw), "", MAX_REPAIR_NOTE_CHARS)?),
        None => None,
    };

    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let include_cost = can_view_cost(&mut tx, session.role()).await?;

    let existing = repair_repo::find_raw_by_id(&mut tx, rid.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(RepairError::NotFound)?;
    if matches!(existing.status.as_str(), "delivered" | "cancelled") {
        return Err(RepairError::AlreadyDelivered.into());
    }

    let effective_parts_cost = parts_cost_opt.unwrap_or(existing.parts_cost_minor);
    let pay_wallet_id = wallet_service::resolve_payment_wallet_id(
        &mut tx,
        pay_method.as_str(),
        input.pay_wallet_id.as_deref(),
    )
    .await
    .map_err(|err| match err {
        wallet_service::PaymentWalletFailure::Storage(_) => {
            RepairServiceError::from(DomainError::StorageUnavailable)
        }
        wallet_service::PaymentWalletFailure::NotEligible(_) => {
            RepairError::PayWalletInvalid.into()
        }
    })?;
    let effective_warranty = warranty_days.unwrap_or(existing.warranty_days);

    let delivered = repair_repo::mark_delivered(
        &mut tx,
        DeliverRepairUpdate {
            id: rid.as_str(),
            final_price_minor,
            parts_cost_minor: effective_parts_cost,
            pay_method,
            technician_name: technician_name.as_deref(),
            warranty_days: effective_warranty,
            note: note.as_deref(),
            delivered_at: now.as_millis(),
        },
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    if let Some(wallet_id) = pay_wallet_id.as_deref() {
        repair_repo::set_pay_wallet(&mut tx, rid.as_str(), Some(wallet_id))
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
    }

    let detail = serde_json::json!({
        "repair_id": rid.as_str(),
        "ticket_no": delivered.ticket_no,
        "service_kind": delivered.service_kind,
        "final_price_minor": final_price_minor,
        "parts_cost_minor": effective_parts_cost,
        "pay_method": pay_method.as_str(),
    })
    .to_string();
    audit::append(&mut tx, actor, audit::event::REPAIR_DELIVERED, now, Some(detail))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(delivered.into_ticket(include_cost))
}

pub async fn cancel_repair(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    id: &str,
    note: Option<&str>,
) -> Result<RepairTicket, RepairServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let rid = RepairId::new(id).ok_or(RepairError::NotFound)?;
    let clean_note = match note {
        Some(raw) => Some(validate_default_text(Some(raw), "", MAX_REPAIR_NOTE_CHARS)?),
        None => None,
    };

    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let include_cost = can_view_cost(&mut tx, session.role()).await?;

    let existing = repair_repo::find_raw_by_id(&mut tx, rid.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(RepairError::NotFound)?;
    if matches!(existing.status.as_str(), "delivered" | "cancelled") {
        return Err(RepairError::AlreadyDelivered.into());
    }

    let cancelled = repair_repo::mark_cancelled(&mut tx, rid.as_str(), clean_note.as_deref())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let detail = serde_json::json!({
        "repair_id": rid.as_str(),
        "ticket_no": cancelled.ticket_no,
    })
    .to_string();
    audit::append(&mut tx, actor, audit::event::REPAIR_CANCELLED, now, Some(detail))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(cancelled.into_ticket(include_cost))
}
