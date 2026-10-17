//! Sales service (Sales V1).
//!
//! One place records a cash sale and one place cancels it. Both run inside a
//! single `BEGIN IMMEDIATE` transaction that takes the write lock up front, so a
//! second writer fails fast as [`SaleError::Busy`] rather than interleaving a
//! half-written document.
//!
//! A sale is a document, not a mutable row: it is written once with its lines,
//! its stock movements and its cost consumption, and it is never edited.
//! Cancellation is a second, mirroring document (`kind = "reversal"`) that
//! restores stock and is linked back to the original. Nothing here recomputes a
//! stored figure; every snapshot is captured as the sale is written.

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::data::repositories::catalog::product as product_repo;
use crate::data::repositories::customer as customer_repo;
use crate::data::repositories::identity::audit;
use crate::data::repositories::inventory::stock as stock_repo;
use crate::data::repositories::inventory::unit as unit_repo;
use crate::data::repositories::sales as sales_repo;
use crate::data::repositories::sales::{
    MovementRecord, SaleLineRecord, SalePaymentRecord, SaleRecord,
};
use crate::data::repositories::settings::app_settings as settings_repo;
use crate::domain::catalog::{CatalogError, Disposition, ProductId, ProductStatus};
use crate::domain::costing::CostError;
use crate::domain::customer::{CustomerError, CustomerLedgerEntry, NewCustomer};
use crate::domain::identity::{DomainError, Permission, Sensitivity, Timestamp, UserId};
use crate::domain::organisation::CostMethod;
use crate::domain::sales::{
    civil_ymd_from_millis, discount_exceeds_limit, format_invoice_reference,
    validate_invoice_discount, validate_line_discount, validate_sale_payments, PaymentMethod,
    SaleError, SalePaymentInput, WarrantyDate,
};
use crate::domain::unit::{Imei, UnitError};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;
use crate::services::identity::approval as approval_service;
use crate::services::inventory::stock as inventory;

/// What one line of a sale names: a product and how many of it.
///
/// The price is deliberately absent. Prices come from the catalogue, read inside
/// the transaction; a caller-supplied price would let a stale screen commit a
/// figure the catalogue no longer holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleLineInput {
    pub product_id: String,
    pub quantity: i64,
    /// The warranty the operator typed for this item, if any (D4). Already a
    /// validated [`WarrantyDate`], so the service never re-parses a string and
    /// never has to imagine a duration the operator did not state.
    pub warranty_start: Option<WarrantyDate>,
    pub warranty_end: Option<WarrantyDate>,
}

/// One line of a sale with an optional serialized device IMEI (`ADR-019`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleLineWithUnitInput {
    pub product_id: String,
    pub quantity: i64,
    pub warranty_start: Option<WarrantyDate>,
    pub warranty_end: Option<WarrantyDate>,
    pub imei: Option<String>,
}

impl From<&SaleLineInput> for SaleLineWithUnitInput {
    fn from(line: &SaleLineInput) -> Self {
        Self {
            product_id: line.product_id.clone(),
            quantity: line.quantity,
            warranty_start: line.warranty_start.clone(),
            warranty_end: line.warranty_end.clone(),
            imei: None,
        }
    }
}

/// What recording or cancelling a sale produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleOutcome {
    /// The document written: the sale's id, or the reversal's id on a cancel.
    pub sale_id: String,
    /// Its human-facing invoice reference.
    pub reference: String,
    /// Total money moved, in piastres.
    pub total_minor: i64,
    /// Total cost consumed, in piastres.
    pub cost_total_minor: i64,
}

/// Everything this service can refuse.
///
/// Four vocabularies kept apart, exactly as `StockServiceError` does: identity
/// refusals, sale refusals, the stock/catalogue refusals a sale inherits
/// because it consumes stock and reads products, and the customer refusals a
/// sale link inherits because it names a customer.
#[derive(Debug)]
pub enum SaleServiceError {
    Identity(DomainError),
    Sale(SaleError),
    Stock(inventory::StockServiceError),
    Catalog(CatalogError),
    Customer(CustomerError),
    Unit(UnitError),
}

impl From<DomainError> for SaleServiceError {
    fn from(error: DomainError) -> Self {
        Self::Identity(error)
    }
}

impl From<SaleError> for SaleServiceError {
    fn from(error: SaleError) -> Self {
        Self::Sale(error)
    }
}

impl From<inventory::StockServiceError> for SaleServiceError {
    fn from(error: inventory::StockServiceError) -> Self {
        Self::Stock(error)
    }
}

impl From<CostError> for SaleServiceError {
    fn from(error: CostError) -> Self {
        Self::Stock(inventory::StockServiceError::from(error))
    }
}

impl From<CatalogError> for SaleServiceError {
    fn from(error: CatalogError) -> Self {
        Self::Catalog(error)
    }
}

impl From<CustomerError> for SaleServiceError {
    fn from(error: CustomerError) -> Self {
        Self::Customer(error)
    }
}

impl From<UnitError> for SaleServiceError {
    fn from(error: UnitError) -> Self {
        Self::Unit(error)
    }
}

impl SaleServiceError {
    /// Delegates to whichever domain enum produced it, so no code is invented at
    /// this layer and the drift guard keeps covering every table.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Identity(error) => error.code(),
            Self::Sale(error) => error.code(),
            Self::Stock(error) => error.code(),
            Self::Catalog(error) => error.code(),
            Self::Customer(error) => error.code(),
            Self::Unit(error) => error.code(),
        }
    }
}

impl std::fmt::Display for SaleServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Identity(error) => write!(f, "{error}"),
            Self::Sale(error) => write!(f, "{error}"),
            Self::Stock(error) => write!(f, "{error}"),
            Self::Catalog(error) => write!(f, "{error}"),
            Self::Customer(error) => write!(f, "{error}"),
            Self::Unit(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SaleServiceError {}

/// Record a cash sale, atomically.
///
/// `confirmed_total_minor` is the total the operator saw on screen, if any. When
/// it is present and differs from the authoritative total computed here, the
/// sale is refused with [`SaleError::PriceChanged`] and nothing is written: a
/// price that moved since confirmation must be seen and confirmed again, never
/// committed silently.
pub async fn record_sale(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    lines: &[SaleLineInput],
    confirmed_total_minor: Option<i64>,
) -> Result<SaleOutcome, SaleServiceError> {
    let mapped: Vec<SaleLineWithUnitInput> = lines.iter().map(SaleLineWithUnitInput::from).collect();
    record_sale_with_units(pool, tokens, &mapped, confirmed_total_minor).await
}

/// Record a cash sale with optional serialized device IMEIs (`ADR-019`).
pub async fn record_sale_with_units(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    lines: &[SaleLineWithUnitInput],
    confirmed_total_minor: Option<i64>,
) -> Result<SaleOutcome, SaleServiceError> {
    record_sale_with_payments(pool, tokens, lines, confirmed_total_minor, None, None).await
}

/// Record a sale with optional serialized device IMEIs (`ADR-019`), single or
/// split payment rows (`ADR-020` §2), and an optional linked customer (`ADR-020` §3).
pub async fn record_sale_with_payments(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    lines: &[SaleLineWithUnitInput],
    confirmed_total_minor: Option<i64>,
    payments: Option<&[SalePaymentInput]>,
    customer_id: Option<&str>,
) -> Result<SaleOutcome, SaleServiceError> {
    record_sale_with_discounts(
        pool,
        tokens,
        lines,
        confirmed_total_minor,
        payments,
        customer_id,
        0,
        &[],
    )
    .await
}

/// Record a sale with optional line/invoice discounts (`ADR-021`), single or
/// split payment rows (`ADR-020` §2), and an optional linked customer (`ADR-020` §3).
///
/// When the total discount exceeds the shop's `ui.discount_limit_pct` setting
/// (`discount_exceeds_limit`), the sale becomes [`Sensitivity::Sensitive`] and
/// spends one owner PIN approval inside the sale transaction (`ADR-017` §3,
/// `ADR-021` §2.3).
pub async fn record_sale_with_discounts(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    lines: &[SaleLineWithUnitInput],
    confirmed_total_minor: Option<i64>,
    payments: Option<&[SalePaymentInput]>,
    customer_id: Option<&str>,
    invoice_discount_minor: i64,
    line_discounts_minor: &[i64],
) -> Result<SaleOutcome, SaleServiceError> {
    if lines.is_empty() {
        return Err(SaleError::Empty.into());
    }
    if line_discounts_minor.len() > lines.len() {
        return Err(SaleError::DiscountInvalid.into());
    }

    // Refuse duplicate IMEIs across lines in the same sale before touching the database.
    let provided_imeis: Vec<String> = lines
        .iter()
        .filter_map(|line| {
            line.imei
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)
        })
        .collect();
    if !provided_imeis.is_empty() {
        Imei::parse_batch(&provided_imeis)?;
    }

    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    // Routine baseline check; if the computed discount exceeds `ui.discount_limit_pct`,
    // `Sensitivity::Sensitive` and `consume_in_tx` are enforced below inside `tx`.
    session.require_sensitivity(Sensitivity::Routine, Timestamp::now())?;
    let now = Timestamp::now();
    let actor = session.user_id();

    // The write lock is taken before the first read. Nothing about a sale's
    // price, its stock or its sequence may change between the read that computes
    // it and the write that records it.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(map_busy)?;

    let snapshot = settings_repo::load_snapshot(&mut *tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let appearance = settings_repo::load_appearance(&mut *tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let prefix = snapshot.invoice_prefix.clone();

    let clean_customer_id = customer_id.map(str::trim).filter(|s| !s.is_empty());
    if let Some(cid) = clean_customer_id {
        let live = customer_repo::find_by_id(&mut *tx, cid)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
            .ok_or(CustomerError::NotFound)?;
        if live.archived {
            return Err(CustomerError::IsArchived.into());
        }
    }

    struct PendingLine {
        product_id: String,
        product_name: String,
        disposition: String,
        quantity: i64,
        unit_price_minor: i64,
        discount_minor: i64,
        line_total_minor: i64,
        unit_cost_minor: Option<i64>,
        line_cost_minor: i64,
        department_id: Option<String>,
        method: CostMethod,
        segments: Vec<inventory::ConsumedSegment>,
        warranty_start: Option<String>,
        warranty_end: Option<String>,
        unit_id: Option<String>,
        retired_unit_ids: Vec<String>,
    }

    let mut pending: Vec<PendingLine> = Vec::with_capacity(lines.len());
    let mut gross_subtotal_minor: i64 = 0;
    let mut lines_net_subtotal_minor: i64 = 0;
    let mut cost_total_minor: i64 = 0;

    for (line_idx, line) in lines.iter().enumerate() {
        if line.quantity <= 0 {
            return Err(SaleError::InvalidQuantity.into());
        }

        // The warranty range is checked before anything is consumed: a backwards
        // range is an operator typo, and discovering it must not cost a stock
        // movement. `checked_end` owns the other half of the rule too — an end
        // nobody stated stays absent rather than being filled in.
        let (warranty_start, warranty_end) = match &line.warranty_start {
            Some(start) => (
                Some(start.as_str().to_owned()),
                start.checked_end(line.warranty_end.clone())?,
            ),
            // With no start there is nothing to measure an end against, so the
            // end is kept exactly as typed instead of being completed with an
            // invented beginning. The table accepts this pair too: neither layer
            // manufactures the half the operator did not give.
            None => (
                None,
                line.warranty_end.as_ref().map(|end| end.as_str().to_owned()),
            ),
        };

        let id = Uuid::parse_str(&line.product_id).map_err(|_| SaleError::NotFound)?;
        let product = product_repo::find_by_id(&mut *tx, ProductId::from_uuid(id))
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
            .ok_or(CatalogError::NoProductWithThisId)?;

        if product.status == ProductStatus::Archived {
            return Err(SaleError::ProductArchived.into());
        }
        // V1 sells quantity-tracked products (including phones with optional or
        // required IMEIs, ADR-019). Legacy `serialized` / `one_off` dispositions
        // stay refused.
        if product.disposition != Disposition::Quantity {
            return Err(SaleError::DispositionNotSupported.into());
        }

        let tracking = unit_repo::product_tracking(&mut *tx, &line.product_id)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
            .ok_or(CatalogError::NoProductWithThisId)?;

        let price = product.sale_price.ok_or(SaleError::PriceNotSet)?;
        let unit_price_minor = price.as_minor();
        let gross_line_minor = unit_price_minor
            .checked_mul(line.quantity)
            .ok_or(CostError::Overflow)?;
        let line_discount_minor = line_discounts_minor.get(line_idx).copied().unwrap_or(0);
        let line_total_minor = validate_line_discount(gross_line_minor, line_discount_minor)?;

        let raw_imei = line
            .imei
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let (method, cost_removed_minor, segments, unit_id, retired_unit_ids) =
            if let Some(raw_imei) = raw_imei {
                if line.quantity != 1 {
                    return Err(UnitError::ImeiCountExceedsQuantity.into());
                }
                let unit_consumption = inventory::consume_unit_in_tx(
                    &mut tx,
                    &actor,
                    &line.product_id,
                    raw_imei,
                    now,
                )
                .await?;
                (
                    unit_consumption.method,
                    unit_consumption.cost_removed_minor,
                    unit_consumption.segments,
                    Some(unit_consumption.unit_id),
                    Vec::new(),
                )
            } else {
                if tracking.requires_imei(&appearance.imei_mode) {
                    return Err(UnitError::ImeiRequiredForAllUnits.into());
                }
                let removal = inventory::remove_in_tx(
                    &mut tx,
                    &actor,
                    &line.product_id,
                    line.quantity,
                    now,
                )
                .await?;
                (
                    removal.method,
                    removal.cost_removed_minor,
                    removal.segments,
                    None,
                    removal.retired_unit_ids,
                )
            };

        // The line's unit cost is a quoted reference: exact for a single layer,
        // and `None` when a FIFO line spans layers of different cost, because
        // there is then no single honest unit figure. `line_cost_minor` is the
        // profit authority either way.
        let unit_cost_minor = match segments.as_slice() {
            [single] => Some(single.unit_cost_minor),
            _ => None,
        };

        gross_subtotal_minor = gross_subtotal_minor
            .checked_add(gross_line_minor)
            .ok_or(CostError::Overflow)?;
        lines_net_subtotal_minor = lines_net_subtotal_minor
            .checked_add(line_total_minor)
            .ok_or(CostError::Overflow)?;
        cost_total_minor = cost_total_minor
            .checked_add(cost_removed_minor)
            .ok_or(CostError::Overflow)?;

        pending.push(PendingLine {
            product_id: line.product_id.clone(),
            product_name: product.name.as_str().to_owned(),
            disposition: product.disposition.as_str().to_owned(),
            quantity: line.quantity,
            unit_price_minor,
            discount_minor: line_discount_minor,
            line_total_minor,
            unit_cost_minor,
            line_cost_minor: cost_removed_minor,
            department_id: product.department.as_ref().map(|d| d.as_str()),
            method,
            segments,
            warranty_start,
            warranty_end,
            unit_id,
            retired_unit_ids,
        });
    }

    let total_minor =
        validate_invoice_discount(lines_net_subtotal_minor, invoice_discount_minor)?;
    let total_discount_minor = gross_subtotal_minor
        .checked_sub(total_minor)
        .ok_or(CostError::Overflow)?;

    // Confirmation gate. Checked after the arithmetic, before the write; an
    // early return drops the transaction and rolls the removals back.
    if let Some(confirmed) = confirmed_total_minor {
        if confirmed != total_minor {
            return Err(SaleError::PriceChanged.into());
        }
    }

    let default_cash = [SalePaymentInput {
        method: "cash".to_owned(),
        amount_minor: total_minor,
        reference: None,
    }];
    let validated_payments = validate_sale_payments(
        payments.unwrap_or(&default_cash),
        total_minor,
        &appearance.pay_methods,
        clean_customer_id.is_some(),
    )?;

    // Discount approval gate (`ADR-021` §2.3, `ADR-017` §3): if the total
    // discount exceeds `ui.discount_limit_pct`, spend one owner PIN approval
    // inside this transaction (after all business validations have passed so
    // a refused sale does not burn the approval).
    let approved_by = if discount_exceeds_limit(
        gross_subtotal_minor,
        total_discount_minor,
        appearance.discount_limit_pct_num(),
    ) {
        let approval = session.require_sensitivity(Sensitivity::Sensitive, now)?;
        Some(approval_service::consume_in_tx(&mut tx, &session, approval).await?)
    } else {
        None
    };

    let reference = next_reference(&mut tx, &prefix, now).await?;
    let sale_id = Uuid::now_v7().to_string();

    sales_repo::insert_sale(
        &mut *tx,
        &SaleRecord {
            id: sale_id.clone(),
            reference: reference.clone(),
            occurred_at: now.as_millis(),
            sold_by: actor.as_str().to_owned(),
            kind: "sale".to_owned(),
            reverses_sale_id: None,
            total_minor,
            cost_total_minor,
            discount_minor: total_discount_minor,
            approved_by: approved_by.map(|u| u.as_str().to_owned()),
        },
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    if let Some(cid) = clean_customer_id {
        sales_repo::set_sale_customer(&mut *tx, &sale_id, cid)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
    }

    let mut credit_minor: i64 = 0;
    for (idx, p) in validated_payments.iter().enumerate() {
        sales_repo::insert_sale_payment(
            &mut *tx,
            &SalePaymentRecord {
                id: Uuid::now_v7().to_string(),
                sale_id: sale_id.clone(),
                payment_no: idx as i64 + 1,
                method: p.method.as_str().to_owned(),
                amount_minor: p.amount_minor,
                reference: p.reference.clone(),
                occurred_at: now.as_millis(),
            },
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

        if p.method == PaymentMethod::Credit {
            credit_minor = credit_minor
                .checked_add(p.amount_minor)
                .ok_or(CostError::Overflow)?;
        }
    }

    if credit_minor > 0 {
        let cid = clean_customer_id.ok_or(SaleError::CreditRequiresCustomer)?;
        customer_repo::insert_ledger_entry(
            &mut *tx,
            &CustomerLedgerEntry {
                id: Uuid::now_v7().to_string(),
                customer_id: cid.to_owned(),
                kind: "credit_sale".to_owned(),
                amount_minor: credit_minor,
                method: None,
                sale_id: Some(sale_id.clone()),
                note: Some(format!("فاتورة {reference}")),
                actor_id: actor,
                occurred_at: now,
            },
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    }

    for (index, line) in pending.iter().enumerate() {
        let line_id = Uuid::now_v7().to_string();
        sales_repo::insert_sale_line(
            &mut *tx,
            &SaleLineRecord {
                id: line_id.clone(),
                sale_id: sale_id.clone(),
                line_no: index as i64 + 1,
                product_id: line.product_id.clone(),
                product_name: line.product_name.clone(),
                disposition: line.disposition.clone(),
                quantity: line.quantity,
                unit_selling_price_minor: line.unit_price_minor,
                discount_minor: line.discount_minor,
                line_total_minor: line.line_total_minor,
                unit_cost_minor: line.unit_cost_minor,
                line_cost_minor: line.line_cost_minor,
                department_id: line.department_id.clone(),
                cost_method: line.method.as_str().to_owned(),
                warranty_start: line.warranty_start.clone(),
                warranty_end: line.warranty_end.clone(),
                unit_id: line.unit_id.clone(),
            },
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

        if let Some(ref uid) = line.unit_id {
            unit_repo::mark_sold(&mut *tx, uid, &line_id)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
        }
        for uid in &line.retired_unit_ids {
            unit_repo::mark_retired_for_sale_line(&mut *tx, uid, &line_id, "untracked_sale_overflow")
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
        }

        // One movement per consumed layer, so the movement sums reconcile with
        // the position. A sale leaves stock, so every delta is negative.
        for segment in &line.segments {
            sales_repo::insert_movement(
                &mut *tx,
                &MovementRecord {
                    id: Uuid::now_v7().to_string(),
                    product_id: line.product_id.clone(),
                    kind: "sale".to_owned(),
                    quantity_delta: -segment.quantity,
                    unit_cost_minor: segment.unit_cost_minor,
                    cost_delta_minor: -segment.cost_minor,
                    occurred_at: now.as_millis(),
                    actor_id: actor.as_str().to_owned(),
                    sale_id: Some(sale_id.clone()),
                    sale_line_id: Some(line_id.clone()),
                    fifo_layer_id: segment.fifo_layer_id.clone(),
                    fifo_received_at: segment.fifo_received_at,
                    reverses_movement_id: None,
                    // A sale is not a purchase and names no supplier (D1).
                    supplier_name: None,
                    receipt_kind: None,
                },
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        }
    }

    audit::append(
        &mut tx,
        actor,
        audit::event::SALE_RECORDED,
        now,
        Some(format!(
            r#"{{"reference":"{}","total_minor":{},"cost_total_minor":{},"lines":{}}}"#,
            reference,
            total_minor,
            cost_total_minor,
            pending.len()
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit().await.map_err(map_busy)?;

    Ok(SaleOutcome {
        sale_id,
        reference,
        total_minor,
        cost_total_minor,
    })
}

/// Cancel a sale by recording a mirroring reversal document.
///
/// The original is never touched. A reversal sale is written, its lines mirror
/// the original, stock is restored, and every reversal movement points back at
/// the sale movement it undoes. A sale that is already cancelled, or has no such
/// document, is refused rather than acted on twice.
pub async fn cancel_sale(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    sale_id: &str,
    reason: &str,
) -> Result<SaleOutcome, SaleServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::CancelTransaction)?;
    // Cancellation restores inventory value, so it is Sensitive: it spends one
    // owner approval (ADR-017 §3), gated per operation rather than blanket.
    let approval = session.require_sensitivity(Sensitivity::Sensitive, Timestamp::now())?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(map_busy)?;
    // Spent inside the cancellation's transaction: if the cancellation is
    // refused below, the rollback leaves the approval for the retry.
    let approved_by = approval_service::consume_in_tx(&mut tx, &session, approval).await?;

    let original = sales_repo::find_sale(&mut *tx, sale_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(SaleError::NotFound)?;
    if original.kind != "sale" {
        return Err(SaleError::ReversalInconsistent.into());
    }
    if sales_repo::find_reversal_sale_id(&mut *tx, sale_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .is_some()
    {
        return Err(SaleError::AlreadyCancelled.into());
    }

    let lines = sales_repo::list_lines(&mut *tx, sale_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let (_, original_customer_id) = sales_repo::link_state(&mut *tx, sale_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(SaleError::NotFound)?;
    let original_payments = sales_repo::list_sale_payments(&mut *tx, sale_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let snapshot = settings_repo::load_snapshot(&mut *tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let prefix = snapshot.invoice_prefix.clone();
    let reference = next_reference(&mut tx, &prefix, now).await?;
    let reversal_id = Uuid::now_v7().to_string();

    sales_repo::insert_sale(
        &mut *tx,
        &SaleRecord {
            id: reversal_id.clone(),
            reference: reference.clone(),
            occurred_at: now.as_millis(),
            sold_by: actor.as_str().to_owned(),
            kind: "reversal".to_owned(),
            reverses_sale_id: Some(sale_id.to_owned()),
            // A reversal mirrors the original's money, so a report can subtract
            // the two and land on zero for a cancelled sale.
            total_minor: original.total_minor,
            cost_total_minor: original.cost_total_minor,
            discount_minor: original.discount_minor,
            approved_by: Some(approved_by.as_str().to_owned()),
        },
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    if let Some(ref cid) = original_customer_id {
        sales_repo::set_sale_customer(&mut *tx, &reversal_id, cid)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
    }

    let mut reversed_credit_minor: i64 = 0;
    for orig_p in &original_payments {
        sales_repo::insert_sale_payment(
            &mut *tx,
            &SalePaymentRecord {
                id: Uuid::now_v7().to_string(),
                sale_id: reversal_id.clone(),
                payment_no: orig_p.payment_no,
                method: orig_p.method.clone(),
                amount_minor: orig_p.amount_minor,
                reference: orig_p.reference.clone(),
                occurred_at: now.as_millis(),
            },
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

        if orig_p.method == "credit" {
            reversed_credit_minor = reversed_credit_minor
                .checked_add(orig_p.amount_minor)
                .ok_or(CostError::Overflow)?;
        }
    }

    if reversed_credit_minor > 0 {
        let cid = original_customer_id
            .as_deref()
            .ok_or(SaleError::ReversalInconsistent)?;
        customer_repo::insert_ledger_entry(
            &mut *tx,
            &CustomerLedgerEntry {
                id: Uuid::now_v7().to_string(),
                customer_id: cid.to_owned(),
                kind: "sale_reversal".to_owned(),
                amount_minor: -reversed_credit_minor,
                method: None,
                sale_id: Some(reversal_id.clone()),
                note: Some(format!("إلغاء فاتورة {}", original.reference)),
                actor_id: actor,
                occurred_at: now,
            },
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    }

    for line in &lines {
        // The method the line was sold under must be one this build knows; the
        // restore itself is always into the moving average (ADR-016 #7), at the
        // exact cost the sale removed.
        CostMethod::parse(&line.cost_method).ok_or(SaleError::ReversalInconsistent)?;

        let movements = sales_repo::list_movements_for_line(&mut *tx, &line.id)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

        let reversal_line_id = Uuid::now_v7().to_string();
        sales_repo::insert_sale_line(
            &mut *tx,
            &SaleLineRecord {
                id: reversal_line_id.clone(),
                sale_id: reversal_id.clone(),
                line_no: line.line_no,
                product_id: line.product_id.clone(),
                product_name: line.product_name.clone(),
                disposition: line.disposition.clone(),
                quantity: line.quantity,
                unit_selling_price_minor: line.unit_selling_price_minor,
                discount_minor: line.discount_minor,
                line_total_minor: line.line_total_minor,
                unit_cost_minor: line.unit_cost_minor,
                line_cost_minor: line.line_cost_minor,
                department_id: line.department_id.clone(),
                cost_method: line.cost_method.clone(),
                // The reversal mirrors every other snapshot on the line, and the
                // warranty is one of them: a pair of documents that disagree
                // about what was sold is worse than no reversal at all.
                warranty_start: line.warranty_start.clone(),
                warranty_end: line.warranty_end.clone(),
                unit_id: line.unit_id.clone(),
            },
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

        restore_line(
            &mut tx,
            &actor,
            line,
            &movements,
            &reversal_id,
            &reversal_line_id,
            now,
        )
        .await?;
    }

    sales_repo::insert_reversal(
        &mut tx,
        &Uuid::now_v7().to_string(),
        sale_id,
        &reversal_id,
        now.as_millis(),
        &actor,
        reason,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::SALE_CANCELLED,
        now,
        Some(format!(
            r#"{{"reference":"{}","reverses":"{}","total_minor":{},"lines":{},"approved_by":{}}}"#,
            reference,
            original.reference,
            original.total_minor,
            lines.len(),
            approved_by.map_or("null".to_owned(), |id| format!("\"{id}\""))
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit().await.map_err(map_busy)?;

    Ok(SaleOutcome {
        sale_id: reversal_id,
        reference,
        total_minor: original.total_minor,
        cost_total_minor: original.cost_total_minor,
    })
}

/// Restore one sold line's stock and write its reversal movements.
///
/// The quantity and cost restored are read from what the sale actually
/// recorded — the movement deltas — never recomputed from a current price, so a
/// return goes back at the line's own cost (`ADR-016` #7, `D7`). The stock goes
/// back into the moving average whichever method the line was sold under: a
/// line sold under FIFO before 1.3 has one movement per layer it consumed, and
/// their exact costs are summed. A legacy FIFO position on the product is
/// collapsed first, in this same transaction.
#[allow(clippy::too_many_arguments)]
async fn restore_line(
    tx: &mut sqlx::SqliteConnection,
    actor: &UserId,
    line: &SaleLineRecord,
    movements: &[MovementRecord],
    reversal_id: &str,
    reversal_line_id: &str,
    now: Timestamp,
) -> Result<(), SaleServiceError> {
    let sold: Vec<&MovementRecord> = movements
        .iter()
        .filter(|movement| movement.kind == "sale")
        .collect();
    if sold.is_empty() {
        return Err(SaleError::ReversalInconsistent.into());
    }

    inventory::collapse_legacy_in_tx(tx, actor, &line.product_id, now).await?;

    let mut restored_quantity: i64 = 0;
    let mut restored_cost: i64 = 0;
    for movement in &sold {
        let quantity = -movement.quantity_delta;
        let cost = -movement.cost_delta_minor;
        restored_quantity = restored_quantity
            .checked_add(quantity)
            .ok_or(CostError::Overflow)?;
        restored_cost = restored_cost.checked_add(cost).ok_or(CostError::Overflow)?;

        write_reversal_movement(
            tx,
            actor,
            line,
            reversal_id,
            reversal_line_id,
            quantity,
            movement.unit_cost_minor,
            cost,
            movement.id.clone(),
            now,
        )
        .await?;
    }

    let position = stock_repo::find_position(tx, &line.product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let (current_quantity, current_total) = match &position {
        Some(position) => (
            position.quantity,
            position
                .total_cost_minor
                .ok_or(SaleError::ReversalInconsistent)?,
        ),
        None => (0, 0),
    };
    let quantity_after = current_quantity
        .checked_add(restored_quantity)
        .ok_or(CostError::Overflow)?;
    let total_after = current_total
        .checked_add(restored_cost)
        .ok_or(CostError::Overflow)?;

    stock_repo::upsert_position(
        tx,
        &stock_repo::StockPosition {
            product_id: line.product_id.clone(),
            quantity: quantity_after,
            total_cost_minor: Some(total_after),
        },
        actor,
        now.as_millis(),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    // Restore any serialized unit (`sold` or auto-`retired` by this line) back to `in_stock`.
    unit_repo::restore_units_for_sale_line(tx, &line.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(())
}

/// Write one `sale_reversal` ledger row.
#[allow(clippy::too_many_arguments)]
async fn write_reversal_movement(
    tx: &mut sqlx::SqliteConnection,
    actor: &UserId,
    line: &SaleLineRecord,
    reversal_id: &str,
    reversal_line_id: &str,
    quantity: i64,
    unit_cost_minor: i64,
    cost_delta_minor: i64,
    reverses_movement_id: String,
    now: Timestamp,
) -> Result<(), SaleServiceError> {
    sales_repo::insert_movement(
        tx,
        &MovementRecord {
            id: Uuid::now_v7().to_string(),
            product_id: line.product_id.clone(),
            kind: "sale_reversal".to_owned(),
            quantity_delta: quantity,
            unit_cost_minor,
            cost_delta_minor,
            occurred_at: now.as_millis(),
            actor_id: actor.as_str().to_owned(),
            sale_id: Some(reversal_id.to_owned()),
            sale_line_id: Some(reversal_line_id.to_owned()),
            // Stock goes back into the moving average, which has no layers.
            fifo_layer_id: None,
            fifo_received_at: None,
            reverses_movement_id: Some(reverses_movement_id),
            // Undoing a sale is not a purchase, so it names no supplier (D1).
            supplier_name: None,
            receipt_kind: None,
        },
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}

/// Build the next invoice reference for `now`, under `prefix`.
///
/// The daily counter is read from the `sales` table inside the caller's
/// transaction, so two sales racing for the same slot serialise on the write
/// lock rather than minting the same reference.
async fn next_reference(
    tx: &mut sqlx::SqliteConnection,
    prefix: &str,
    now: Timestamp,
) -> Result<String, SaleServiceError> {
    let (year, month, day) = civil_ymd_from_millis(now.as_millis());
    let day_key = format!("{year:04}{month:02}{day:02}");
    let prefix_and_date = if prefix.is_empty() {
        format!("{day_key}-")
    } else {
        format!("{prefix}-{day_key}-")
    };

    let sequence = sales_repo::next_sequence(tx, &prefix_and_date)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        + 1;
    if sequence > 9999 {
        return Err(SaleError::ReferenceConflict.into());
    }

    Ok(format_invoice_reference(prefix, year, month, day, sequence))
}

/// Translate a SQLite failure into a sale refusal, keeping `Busy` retryable.
///
/// A locked database is the one failure a caller may simply retry, so it is not
/// flattened into a generic storage error with the rest.
fn map_busy(error: sqlx::Error) -> SaleServiceError {
    if let sqlx::Error::Database(database_error) = &error {
        if database_error.code().as_deref() == Some("5") {
            return SaleServiceError::Sale(SaleError::Busy);
        }
        let message = database_error.message().to_ascii_lowercase();
        if message.contains("locked") || message.contains("busy") {
            return SaleServiceError::Sale(SaleError::Busy);
        }
    }
    SaleServiceError::Identity(DomainError::StorageUnavailable)
}

/// Attach an explicit customer link to a sale (`spec:178`, CUST-05).
///
/// Linking is one-time and seller-gated (both roles, invoice-time): a linked
/// sale keeps its relation, and a second link is refused rather than
/// rewriting history. Only live `sale` documents link; reversals mirror
/// their original. The named customer must exist and be live — checked here
/// by read-only existence, with all customer rules staying in the customer
/// slice (P4 authorizes this coupling).
pub async fn link_sale_customer(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    sale_id: &str,
    customer_id: &str,
) -> Result<(), SaleServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let now = Timestamp::now();

    let mut tx = pool.begin().await.map_err(map_busy)?;
    let (kind, current) = sales_repo::link_state(&mut tx, sale_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(SaleError::NotFound)?;
    if kind != "sale" {
        return Err(SaleError::LinkNotAllowed.into());
    }
    if current.is_some() {
        return Err(SaleError::CustomerAlreadyLinked.into());
    }
    let live = customer_repo::find_by_id(&mut tx, customer_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(CustomerError::NotFound)?;
    if live.archived {
        return Err(CustomerError::IsArchived.into());
    }
    sales_repo::set_sale_customer(&mut tx, sale_id, customer_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        session.user_id(),
        audit::event::SALE_CUSTOMER_LINKED,
        now,
        Some(
            serde_json::json!({ "sale_id": sale_id, "customer_id": customer_id })
                .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}

/// Keep a free-text customer name on an unlinked sale (`spec:178`).
///
/// Only sales with no explicit link take a snapshot: once linked, the
/// relation is the record and a typed name must not shadow it. The name is
/// validated with the customer slice's own rule; an empty name is refused.
pub async fn set_sale_customer_name(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    sale_id: &str,
    name: &str,
) -> Result<(), SaleServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let (clean, _) = NewCustomer {
        name: name.to_string(),
        contact: None,
    }
    .cleaned()?;
    let now = Timestamp::now();

    let mut tx = pool.begin().await.map_err(map_busy)?;
    let (kind, current) = sales_repo::link_state(&mut tx, sale_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(SaleError::NotFound)?;
    if kind != "sale" {
        return Err(SaleError::LinkNotAllowed.into());
    }
    if current.is_some() {
        return Err(SaleError::CustomerAlreadyLinked.into());
    }
    sales_repo::set_sale_customer_snapshot(&mut tx, sale_id, &clean)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        session.user_id(),
        audit::event::SALE_CUSTOMER_LINKED,
        now,
        Some(serde_json::json!({ "sale_id": sale_id, "snapshot": true }).to_string()),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}
