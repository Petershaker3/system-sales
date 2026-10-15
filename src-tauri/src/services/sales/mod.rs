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
use crate::data::repositories::sales as sales_repo;
use crate::data::repositories::sales::{MovementRecord, SaleLineRecord, SaleRecord};
use crate::data::repositories::settings::app_settings as settings_repo;
use crate::domain::catalog::{CatalogError, Disposition, ProductId, ProductStatus};
use crate::domain::costing::fifo::FifoLayer;
use crate::domain::costing::CostError;
use crate::domain::customer::{CustomerError, NewCustomer};
use crate::domain::identity::{DomainError, Permission, Sensitivity, Timestamp, UserId};
use crate::domain::organisation::CostMethod;
use crate::domain::sales::{civil_ymd_from_millis, format_invoice_reference, SaleError};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;
use crate::services::inventory::stock as inventory;
use crate::services::pattern as pattern_service;

/// What one line of a sale names: a product and how many of it.
///
/// The price is deliberately absent. Prices come from the catalogue, read inside
/// the transaction; a caller-supplied price would let a stale screen commit a
/// figure the catalogue no longer holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleLineInput {
    pub product_id: String,
    pub quantity: i64,
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
    if lines.is_empty() {
        return Err(SaleError::Empty.into());
    }

    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    session.require_sensitivity(
        Sensitivity::Routine,
        pattern_service::is_enabled(pool).await?,
        pattern_service::current_epoch(pool).await?,
        Timestamp::now(),
    )?;
    let now = Timestamp::now();
    let actor = session.user_id();

    // The write lock is taken before the first read. Nothing about a sale's
    // price, its stock or its sequence may change between the read that computes
    // it and the write that records it.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(map_busy)?;

    let snapshot = settings_repo::load_snapshot(&mut *tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let prefix = snapshot.invoice_prefix.clone();

    struct PendingLine {
        product_id: String,
        product_name: String,
        disposition: String,
        quantity: i64,
        unit_price_minor: i64,
        line_total_minor: i64,
        unit_cost_minor: Option<i64>,
        line_cost_minor: i64,
        department_id: Option<String>,
        method: CostMethod,
        segments: Vec<inventory::ConsumedSegment>,
    }

    let mut pending: Vec<PendingLine> = Vec::with_capacity(lines.len());
    let mut total_minor: i64 = 0;
    let mut cost_total_minor: i64 = 0;

    for line in lines {
        if line.quantity <= 0 {
            return Err(SaleError::InvalidQuantity.into());
        }

        let id = Uuid::parse_str(&line.product_id).map_err(|_| SaleError::NotFound)?;
        let product = product_repo::find_by_id(&mut *tx, ProductId::from_uuid(id))
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
            .ok_or(CatalogError::NoProductWithThisId)?;

        if product.status == ProductStatus::Archived {
            return Err(SaleError::ProductArchived.into());
        }
        // V1 sells quantity-tracked products only. A `serialized` product needs
        // per-piece identity and a `one_off` keeps no balance; both are refused
        // rather than approximated, so no sale is recorded the ledger cannot cost.
        if product.disposition != Disposition::Quantity {
            return Err(SaleError::DispositionNotSupported.into());
        }

        let price = product.sale_price.ok_or(SaleError::PriceNotSet)?;
        let unit_price_minor = price.as_minor();
        let line_total_minor = unit_price_minor
            .checked_mul(line.quantity)
            .ok_or(CostError::Overflow)?;

        // Consume the stock first: it settles the authority check, the cost
        // method and the exact cost this line removes, all inside this
        // transaction and so all abandoned together if any line refuses.
        let removal =
            inventory::remove_in_tx(&mut tx, &actor, &line.product_id, line.quantity, now).await?;

        // The line's unit cost is a quoted reference: exact for a single layer,
        // and `None` when a FIFO line spans layers of different cost, because
        // there is then no single honest unit figure. `line_cost_minor` is the
        // profit authority either way.
        let unit_cost_minor = match removal.segments.as_slice() {
            [single] => Some(single.unit_cost_minor),
            _ => None,
        };

        total_minor = total_minor
            .checked_add(line_total_minor)
            .ok_or(CostError::Overflow)?;
        cost_total_minor = cost_total_minor
            .checked_add(removal.cost_removed_minor)
            .ok_or(CostError::Overflow)?;

        pending.push(PendingLine {
            product_id: line.product_id.clone(),
            product_name: product.name.as_str().to_owned(),
            disposition: product.disposition.as_str().to_owned(),
            quantity: line.quantity,
            unit_price_minor,
            line_total_minor,
            unit_cost_minor,
            line_cost_minor: removal.cost_removed_minor,
            department_id: product.department.as_ref().map(|d| d.as_str()),
            method: removal.method,
            segments: removal.segments,
        });
    }

    // Confirmation gate. Checked after the arithmetic, before the write; an
    // early return drops the transaction and rolls the removals back.
    if let Some(confirmed) = confirmed_total_minor {
        if confirmed != total_minor {
            return Err(SaleError::PriceChanged.into());
        }
    }

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
        },
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

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
                line_total_minor: line.line_total_minor,
                unit_cost_minor: line.unit_cost_minor,
                line_cost_minor: line.line_cost_minor,
                department_id: line.department_id.clone(),
                cost_method: line.method.as_str().to_owned(),
            },
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

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
    // Cancellation restores inventory value, so it is Sensitive: the Pattern is
    // required when one is configured, gated per operation rather than blanket.
    session.require_sensitivity(
        Sensitivity::Sensitive,
        pattern_service::is_enabled(pool).await?,
        pattern_service::current_epoch(pool).await?,
        Timestamp::now(),
    )?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(map_busy)?;

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
        },
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    for line in &lines {
        // Restore under the method the sale consumed under. A method switch
        // since the sale moved the cost basis, and restoring against a
        // different one would invent a figure: refuse instead.
        let recorded =
            CostMethod::parse(&line.cost_method).ok_or(SaleError::ReversalInconsistent)?;
        let current = inventory::method_for_product(&mut *tx, &line.product_id).await?;
        if current != recorded {
            return Err(SaleError::ReversalInconsistent.into());
        }

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
                line_total_minor: line.line_total_minor,
                unit_cost_minor: line.unit_cost_minor,
                line_cost_minor: line.line_cost_minor,
                department_id: line.department_id.clone(),
                cost_method: line.cost_method.clone(),
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
            r#"{{"reference":"{}","reverses":"{}","total_minor":{},"lines":{}}}"#,
            reference,
            original.reference,
            original.total_minor,
            lines.len()
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
/// recorded — the movement deltas — never recomputed from a current price. FIFO
/// restores each layer at its original identity and arrival time (adding to a
/// surviving row, or re-creating an exhausted one at the same id); Moving
/// Average adds the exact removed cost back to the position total.
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
    let method = CostMethod::parse(&line.cost_method).ok_or(SaleError::ReversalInconsistent)?;

    match method {
        CostMethod::MovingAverage => {
            let movement = movements
                .iter()
                .find(|movement| movement.kind == "sale")
                .ok_or(SaleError::ReversalInconsistent)?;
            let quantity = -movement.quantity_delta;
            let cost = -movement.cost_delta_minor;

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
                .checked_add(quantity)
                .ok_or(CostError::Overflow)?;
            let total_after = current_total.checked_add(cost).ok_or(CostError::Overflow)?;

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

            write_reversal_movement(
                tx,
                actor,
                line,
                reversal_id,
                reversal_line_id,
                quantity,
                movement.unit_cost_minor,
                cost,
                None,
                None,
                movement.id.clone(),
                now,
            )
            .await?;
        }
        CostMethod::Fifo => {
            let sold: Vec<&MovementRecord> = movements
                .iter()
                .filter(|movement| movement.kind == "sale")
                .collect();
            if sold.is_empty() {
                return Err(SaleError::ReversalInconsistent.into());
            }

            let mut restored_quantity: i64 = 0;
            for movement in sold {
                let quantity = -movement.quantity_delta;
                let layer_id = movement
                    .fifo_layer_id
                    .as_deref()
                    .ok_or(SaleError::ReversalInconsistent)?;
                let received_at = movement
                    .fifo_received_at
                    .ok_or(SaleError::ReversalInconsistent)?;

                match stock_repo::find_layer_row(tx, layer_id)
                    .await
                    .map_err(|_| DomainError::StorageUnavailable)?
                {
                    // The layer survived the sale: add the sold units back to it.
                    Some(row) => {
                        let quantity_after = row
                            .quantity
                            .checked_add(quantity)
                            .ok_or(CostError::Overflow)?;
                        stock_repo::update_layer_quantity(tx, layer_id, quantity_after, actor)
                            .await
                            .map_err(|_| DomainError::StorageUnavailable)?;
                    }
                    // It was exhausted and deleted: re-create it at its original
                    // id and arrival time, so consumption order is unchanged.
                    None => {
                        stock_repo::insert_layer(
                            tx,
                            layer_id,
                            &line.product_id,
                            &FifoLayer {
                                quantity,
                                unit_cost_minor: movement.unit_cost_minor,
                            },
                            received_at,
                            actor,
                        )
                        .await
                        .map_err(|_| DomainError::StorageUnavailable)?;
                    }
                }

                restored_quantity = restored_quantity
                    .checked_add(quantity)
                    .ok_or(CostError::Overflow)?;

                write_reversal_movement(
                    tx,
                    actor,
                    line,
                    reversal_id,
                    reversal_line_id,
                    quantity,
                    movement.unit_cost_minor,
                    -movement.cost_delta_minor,
                    Some(layer_id.to_owned()),
                    Some(received_at),
                    movement.id.clone(),
                    now,
                )
                .await?;
            }

            let position = stock_repo::find_position(tx, &line.product_id)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
            let current_quantity = position.map(|position| position.quantity).unwrap_or(0);
            let quantity_after = current_quantity
                .checked_add(restored_quantity)
                .ok_or(CostError::Overflow)?;
            stock_repo::upsert_position(
                tx,
                &stock_repo::StockPosition {
                    product_id: line.product_id.clone(),
                    quantity: quantity_after,
                    // FIFO keeps its value in the layers, not the position.
                    total_cost_minor: None,
                },
                actor,
                now.as_millis(),
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        }
    }

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
    fifo_layer_id: Option<String>,
    fifo_received_at: Option<i64>,
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
            fifo_layer_id,
            fifo_received_at,
            reverses_movement_id: Some(reverses_movement_id),
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
