//! Stock and costing use cases (SP-2): `receive`, `remove`,
//! `switch_cost_method`.
//!
//! # The one invariant everything serves
//!
//! Exactly one thing is authoritative for a product's cost, and which one is
//! decided by the costing method its department declares:
//!
//! | method         | cost authority            | the other representation |
//! |----------------|---------------------------|--------------------------|
//! | `moving_average` | `stock_levels.total_cost_minor` | `fifo_layers` must be empty |
//! | `fifo`           | `fifo_layers`                  | `total_cost_minor` must be `NULL` |
//!
//! Both methods agree on `stock_levels.quantity`. SQLite cannot enforce a rule
//! that spans two tables, so this module owns the invariant: it reads both sides,
//! refuses a position that contradicts itself, and never writes a row that would
//! create the contradiction.
//!
//! # Authorization
//!
//! `Permission::ManageInventory` for all three, and never more than the operation
//! needs. `role.rs` already draws this line: inventory is money rather than
//! identity, so it is not `ManageCatalog`; and it is deliberately *not* a blanket
//! re-authenticated permission, because receiving a carton is routine while
//! opening a balance declares what the shop is worth. The fourth axis is applied
//! per operation through [`Sensitivity`]:
//!
//! - receiving a delivery — `Routine`
//! - declaring an opening balance — `Sensitive`
//! - switching the costing method — `Sensitive`, per `ADR-013`
//!
//! # What is never done here
//!
//! No sale-line cost snapshot and no customer-return restoration. `ADR-013`
//! requires both, and both are properties of a *sale* rather than of a stock
//! balance, so they arrive with `pos-sales`. No movement ledger either: the
//! layers are the truth (`ADR-013`), and the ledger that could rebuild them
//! belongs with the sale lines.

use std::fmt;

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::inventory::stock as repo;
use crate::data::repositories::organisation::department as department_repo;
use crate::data::repositories::sales::{self as sales_repo, MovementRecord};
use crate::data::repositories::settings::app_settings as settings_repo;
use crate::domain::costing::fifo::{FifoLayer, FifoPosition};
use crate::domain::costing::moving_average::AveragePosition;
use crate::domain::costing::CostError;
use crate::domain::identity::{DomainError, Permission, Sensitivity, Session, Timestamp, UserId};
use crate::domain::organisation::{CostMethod, DepartmentError, DepartmentId};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;
use crate::services::pattern as pattern_service;

/// The costing method a device falls back to before anyone chooses one.
///
/// Written out rather than taken from a `Default` impl, because the value is a
/// financial decision rather than a trait detail: it is the same default the
/// `departments.cost_method` column declares, and the two must not drift.
const DEVICE_DEFAULT_COST_METHOD: CostMethod = CostMethod::MovingAverage;

/// The `app_settings` key holding the device-wide costing default.
const DEFAULT_COST_METHOD_KEY: &str = "default_cost_method";

/// No product matches the id a caller named.
///
/// Its own variant rather than a collapsed generic failure, matching
/// `NoProductWithThisId` in the catalogue: a missing product and a forbidden
/// action send an operator to different places.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StockError {
    /// No product carries this id.
    ProductNotFound,
    /// The stored position contradicts the costing method that should own it.
    ///
    /// Raised rather than repaired. A position with layers under a Moving Average
    /// department (or a `total_cost_minor` under FIFO) means something wrote
    /// outside this module, and quietly picking one side would pick a cost.
    CostAuthorityConflict {
        /// The product whose position is inconsistent.
        product_id: String,
    },
    /// A costing refusal from the arithmetic itself.
    Cost(CostError),
}

impl StockError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ProductNotFound => "STOCK_PRODUCT_NOT_FOUND",
            Self::CostAuthorityConflict { .. } => "STOCK_COST_AUTHORITY_CONFLICT",
            Self::Cost(error) => error.code(),
        }
    }
}

impl fmt::Display for StockError {
    /// Developer-facing only; the operator reads the Arabic message the frontend
    /// holds, indexed by `code()`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProductNotFound => write!(f, "no product with this id"),
            Self::CostAuthorityConflict { product_id } => write!(
                f,
                "product {product_id} stores a cost under the wrong costing method"
            ),
            Self::Cost(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for StockError {}

impl From<CostError> for StockError {
    fn from(error: CostError) -> Self {
        Self::Cost(error)
    }
}

/// Everything this service can refuse.
///
/// Two vocabularies kept apart on purpose, exactly as `DepartmentServiceError`
/// does: identity refusals (no session, no permission, stale approval) and
/// stock refusals (no such product, contradictory position, bad arithmetic).
#[derive(Debug)]
pub enum StockServiceError {
    Identity(DomainError),
    Stock(StockError),
    Department(DepartmentError),
}

impl From<DomainError> for StockServiceError {
    fn from(error: DomainError) -> Self {
        Self::Identity(error)
    }
}

impl From<StockError> for StockServiceError {
    fn from(error: StockError) -> Self {
        Self::Stock(error)
    }
}

impl From<CostError> for StockServiceError {
    fn from(error: CostError) -> Self {
        Self::Stock(StockError::Cost(error))
    }
}

impl From<DepartmentError> for StockServiceError {
    fn from(error: DepartmentError) -> Self {
        Self::Department(error)
    }
}

impl StockServiceError {
    /// Delegates to whichever domain enum produced it, so no code is invented at
    /// this layer and the drift guard keeps covering every table.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Identity(error) => error.code(),
            Self::Stock(error) => error.code(),
            Self::Department(error) => error.code(),
        }
    }
}

impl fmt::Display for StockServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Identity(error) => write!(f, "{error}"),
            Self::Stock(error) => write!(f, "{error}"),
            Self::Department(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for StockServiceError {}

/// What one stock operation changed, reported back rather than logged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StockOutcome {
    /// Units on hand afterwards.
    pub quantity: i64,
    /// Cost removed by this operation, in piastres. Zero for a receipt.
    ///
    /// Integer piastres because that is what `ADR-010` stores and what
    /// `ADR-013` returns; the ceiling happens inside the arithmetic, never here.
    pub cost_minor: i64,
}

/// Resolve the session, require inventory management, then apply the operation's
/// own sensitivity.
///
/// The order matters and is the same one every other service uses: role and
/// permission first, so a session that may not touch inventory never causes a
/// database read to decide whether it needs a Pattern.
async fn authorize(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    sensitivity: Sensitivity,
) -> Result<Session, StockServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageInventory)?;
    session.require_sensitivity(
        sensitivity,
        pattern_service::is_enabled(pool).await?,
        pattern_service::current_epoch(pool).await?,
        Timestamp::now(),
    )?;
    Ok(session)
}

/// Which costing method governs a product.
///
/// The department decides, per the delivery specification: "المتوسط المرجح يُضبط
/// على مستوى القسم، والمنتجات ترث طريقة التكلفة من القسم".
///
/// A product with **no** department is the one case the inheritance rule does not
/// cover — `0005` leaves `department_id` nullable and `spec:175` forbids
/// inventing a classification to fill the gap. Rather than refuse, which would
/// make every unclassified product uncostable, the device default from
/// `app_settings.default_cost_method` applies. That key already exists (SP-1b),
/// so this adds no new setting and no invented business data: it is the device's
/// own stated default, exactly as it is for the other defaults a product inherits.
async fn resolve_cost_method(
    conn: &mut sqlx::SqliteConnection,
    department_id: Option<&str>,
) -> Result<CostMethod, StockServiceError> {
    let Some(department_id) = department_id else {
        let stored = settings_repo::get(conn, DEFAULT_COST_METHOD_KEY)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        return Ok(match stored.as_deref() {
            // Never saved. `app_settings` holds only what an operator has
            // actually chosen, so an absent key is the ordinary state of a new
            // device — and the answer is the shipped default, the same one
            // `departments.cost_method` defaults to.
            None => DEVICE_DEFAULT_COST_METHOD,
            Some(value) => CostMethod::parse(value).ok_or_else(|| {
                // A stored value this build cannot parse is a defect, not a
                // default: falling back here would silently change how a shop's
                // stock is valued. Refuse instead.
                StockServiceError::from(DomainError::StorageUnavailable)
            })?,
        });
    };

    let row = sqlx::query("SELECT cost_method FROM departments WHERE id = ?1")
        .bind(department_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DepartmentError::NotFound)?;

    let stored: String = sqlx::Row::get(&row, "cost_method");
    CostMethod::parse(&stored).ok_or(StockServiceError::from(DomainError::StorageUnavailable))
}

/// Which costing method currently governs a product, by identity.
///
/// A `pub(crate)` doorway so a sale's reversal can prove it is restoring under
/// the same method the sale consumed under. It resolves the product's
/// department first, then defers to [`resolve_cost_method`]; it is deliberately
/// the *current* method, which a reversal compares against the method recorded
/// on the original line.
pub(crate) async fn method_for_product(
    conn: &mut sqlx::SqliteConnection,
    product_id: &str,
) -> Result<CostMethod, StockServiceError> {
    let department_id = product_department(conn, product_id).await?;
    resolve_cost_method(conn, department_id.as_deref()).await
}

/// Read a product's department, refusing an unknown product.
async fn product_department(
    conn: &mut sqlx::SqliteConnection,
    product_id: &str,
) -> Result<Option<String>, StockServiceError> {
    let row = sqlx::query("SELECT department_id FROM products WHERE id = ?1")
        .bind(product_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(StockError::ProductNotFound)?;
    Ok(sqlx::Row::get(&row, "department_id"))
}

/// Load a position, or the empty one if the product has never been stocked.
async fn load_position(
    conn: &mut sqlx::SqliteConnection,
    product_id: &str,
) -> Result<Option<repo::StockPosition>, StockServiceError> {
    Ok(repo::find_position(conn, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?)
}

/// Load the layers and check them against the method that claims them.
///
/// This is the invariant check. Reading the layers unconditionally, rather than
/// only under FIFO, is deliberate: a Moving Average product that has layers is a
/// contradiction, and it is only visible if something looks.
async fn load_layers_under(
    conn: &mut sqlx::SqliteConnection,
    product_id: &str,
    method: CostMethod,
) -> Result<Vec<FifoLayer>, StockServiceError> {
    let layers = repo::list_layers(conn, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    match method {
        CostMethod::MovingAverage if !layers.is_empty() => {
            Err(StockError::CostAuthorityConflict {
                product_id: product_id.to_owned(),
            }
            .into())
        }
        _ => Ok(layers),
    }
}

/// The Moving Average position for a product, refusing a FIFO-owned total.
fn average_position(
    product_id: &str,
    position: Option<&repo::StockPosition>,
) -> Result<AveragePosition, StockServiceError> {
    let Some(position) = position else {
        return Ok(AveragePosition::EMPTY);
    };
    let Some(total) = position.total_cost_minor else {
        // No total recorded. Under Moving Average that means the position was
        // written by FIFO and never converted, so the cost is genuinely unknown
        // rather than zero.
        return Err(StockError::CostAuthorityConflict {
            product_id: product_id.to_owned(),
        }
        .into());
    };
    AveragePosition::new(total, position.quantity).map_err(StockServiceError::from)
}

/// One layer's consumption, as the movement ledger records it.
///
/// Under FIFO there is one segment per layer touched, carrying the exact layer
/// id and arrival time so a reversal can restore arrival order. Under Moving
/// Average there is exactly one segment and the layer fields are `None`: there
/// are no layers to name.
///
/// `cost_minor` is the *exact* cost this segment removed, which is deliberately
/// not always `quantity × unit_cost_minor`: under Moving Average the removal is
/// `ceil(U·T/Q)` while the quoted unit cost is `ceil(T/Q)`, and the two need not
/// agree. Summing `cost_minor` is what reconciles the ledger with the position;
/// the unit cost is a quoted reference only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumedSegment {
    pub fifo_layer_id: Option<String>,
    pub fifo_received_at: Option<i64>,
    pub quantity: i64,
    pub unit_cost_minor: i64,
    pub cost_minor: i64,
}

/// What consuming stock inside a transaction returned, before any ledger rows
/// are written.
///
/// Returned rather than only applied so a caller — a sale — can attach its own
/// sale and line ids to the movement rows it writes from these segments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovalInTx {
    pub method: CostMethod,
    pub cost_removed_minor: i64,
    pub remaining_quantity: i64,
    pub segments: Vec<ConsumedSegment>,
}

/// Consume stock inside the caller's transaction, returning what it cost.
///
/// The arithmetic, the authority check and the position/layer rewrite all live
/// here so a sale and a manual removal consume stock by exactly the same rules.
/// This function changes no ledger and writes no audit row: the caller owns the
/// transaction and supplies the surrounding facts.
pub(crate) async fn remove_in_tx(
    conn: &mut sqlx::SqliteConnection,
    acting_user: &UserId,
    product_id: &str,
    quantity: i64,
    now: Timestamp,
) -> Result<RemovalInTx, StockServiceError> {
    let department_id = product_department(conn, product_id).await?;
    let method = resolve_cost_method(conn, department_id.as_deref()).await?;
    let position = load_position(conn, product_id).await?;

    // Authority is settled before any arithmetic runs, for both methods. Under
    // Moving Average it proves there is a total to divide by; under FIFO it
    // refuses to consume layers the method does not own.
    load_layers_under(conn, product_id, method).await?;

    match method {
        CostMethod::MovingAverage => {
            let current = average_position(product_id, position.as_ref())?;
            // The quoted average, read before the removal, is the per-unit figure
            // a screen shows for this line. The exact `cost_removed_minor` stays
            // the authority; this is a reference, not a base for totals.
            let quoted = current.unit_cost_minor().unwrap_or(0);
            let removal = current.remove(quantity)?;
            repo::upsert_position(
                conn,
                &repo::StockPosition {
                    product_id: product_id.to_owned(),
                    quantity: removal.remaining.on_hand,
                    total_cost_minor: Some(removal.remaining.total_cost_minor),
                },
                acting_user,
                now.as_millis(),
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

            Ok(RemovalInTx {
                method,
                cost_removed_minor: removal.cost_removed_minor,
                remaining_quantity: removal.remaining.on_hand,
                segments: vec![ConsumedSegment {
                    fifo_layer_id: None,
                    fifo_received_at: None,
                    quantity,
                    unit_cost_minor: quoted,
                    // The exact removal, not `quantity × quoted`: `ceil` makes
                    // the two differ, and the ledger must carry the exact one.
                    cost_minor: removal.cost_removed_minor,
                }],
            })
        }
        CostMethod::Fifo => {
            let rows = repo::list_layer_rows(conn, product_id)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
            let layers = rows
                .iter()
                .map(|row| FifoLayer {
                    quantity: row.quantity,
                    unit_cost_minor: row.unit_cost_minor,
                })
                .collect();
            let removal = FifoPosition::new(layers).remove(quantity)?;

            // Rewrite only the layers that were touched, by identity: a partial
            // consumption is an UPDATE that keeps the id, arrival time and unit
            // cost; a whole one is a DELETE of that exact row. The survivors are
            // never re-inserted, so their ids — the basis a reversal restores
            // against — never change.
            let mut segments = Vec::with_capacity(removal.consumed.len());
            for consumption in &removal.consumed {
                let row = &rows[consumption.layer_index];
                if consumption.quantity == row.quantity {
                    repo::delete_layer(conn, &row.id)
                        .await
                        .map_err(|_| DomainError::StorageUnavailable)?;
                } else {
                    repo::update_layer_quantity(
                        conn,
                        &row.id,
                        row.quantity - consumption.quantity,
                        acting_user,
                    )
                    .await
                    .map_err(|_| DomainError::StorageUnavailable)?;
                }
                segments.push(ConsumedSegment {
                    fifo_layer_id: Some(row.id.clone()),
                    fifo_received_at: Some(row.received_at),
                    quantity: consumption.quantity,
                    unit_cost_minor: consumption.unit_cost_minor,
                    // FIFO removes whole units at their layer cost, so this is
                    // exact and sums to `cost_removed_minor` with no remainder.
                    cost_minor: consumption.quantity * consumption.unit_cost_minor,
                });
            }

            let remaining_quantity = removal.remaining.on_hand();
            repo::upsert_position(
                conn,
                &repo::StockPosition {
                    product_id: product_id.to_owned(),
                    quantity: remaining_quantity,
                    total_cost_minor: None,
                },
                acting_user,
                now.as_millis(),
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

            Ok(RemovalInTx {
                method,
                cost_removed_minor: removal.cost_removed_minor,
                remaining_quantity,
                segments,
            })
        }
    }
}

/// Receive stock: add units at a known unit cost.
///
/// `Routine` by default. An opening balance is the same arithmetic with a
/// different `Sensitivity`, so the caller chooses rather than this function
/// guessing what a receipt means.
pub async fn receive(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    product_id: &str,
    quantity: i64,
    unit_cost_minor: i64,
    sensitivity: Sensitivity,
) -> Result<StockOutcome, StockServiceError> {
    let session = authorize(pool, tokens, sensitivity).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    let department_id = product_department(&mut *tx, product_id).await?;
    let method = resolve_cost_method(&mut *tx, department_id.as_deref()).await?;
    let position = load_position(&mut *tx, product_id).await?;

    // The layer this receipt created, when FIFO owns the cost, so the ledger row
    // can name the exact layer it deposited into.
    let mut receipt_layer_id: Option<String> = None;

    let outcome = match method {
        CostMethod::MovingAverage => {
            let current = average_position(product_id, position.as_ref())?;
            let updated = current.receive(quantity, unit_cost_minor)?;
            repo::upsert_position(
                &mut tx,
                &repo::StockPosition {
                    product_id: product_id.to_owned(),
                    quantity: updated.on_hand,
                    total_cost_minor: Some(updated.total_cost_minor),
                },
                &actor,
                now.as_millis(),
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
            StockOutcome {
                quantity: updated.on_hand,
                cost_minor: 0,
            }
        }
        CostMethod::Fifo => {
            // A receipt never merges into an existing layer: the layer list is a
            // record of when stock arrived, not a summary of prices.
            let layer_id = uuid::Uuid::now_v7().to_string();
            let layer = FifoLayer::new(quantity, unit_cost_minor)?;
            repo::insert_layer(
                &mut tx,
                &layer_id,
                product_id,
                &layer,
                now.as_millis(),
                &actor,
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
            receipt_layer_id = Some(layer_id);

            let previous = position
                .as_ref()
                .map(|position| position.quantity)
                .unwrap_or(0);
            let updated = previous
                .checked_add(quantity)
                .ok_or(CostError::Overflow)?;
            repo::upsert_position(
                &mut tx,
                &repo::StockPosition {
                    product_id: product_id.to_owned(),
                    quantity: updated,
                    total_cost_minor: None,
                },
                &actor,
                now.as_millis(),
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
            StockOutcome {
                quantity: updated,
                cost_minor: 0,
            }
        }
    };

    // The ledger row for this receipt. A receipt is a movement in, at the stated
    // unit cost; the same integers the position received are recorded here, so
    // the position and the ledger cannot disagrees about what arrived.
    let receipt_cost = quantity
        .checked_mul(unit_cost_minor)
        .ok_or(CostError::Overflow)?;
    sales_repo::insert_movement(
        &mut tx,
        &MovementRecord {
            id: uuid::Uuid::now_v7().to_string(),
            product_id: product_id.to_owned(),
            kind: "receipt".to_owned(),
            quantity_delta: quantity,
            unit_cost_minor,
            cost_delta_minor: receipt_cost,
            occurred_at: now.as_millis(),
            actor_id: actor.as_str().to_owned(),
            sale_id: None,
            sale_line_id: None,
            fifo_layer_id: receipt_layer_id.clone(),
            fifo_received_at: receipt_layer_id.as_ref().map(|_| now.as_millis()),
            reverses_movement_id: None,
        },
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::STOCK_RECEIVED,
        now,
        Some(format!(
            r#"{{"product":"{}","quantity":{},"unit_cost_minor":{},"method":"{}","on_hand":{}}}"#,
            product_id, quantity, unit_cost_minor, method, outcome.quantity
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(outcome)
}

/// Remove stock: consume units and report what they cost.
///
/// The whole operation is refused when there is not enough on hand — no partial
/// consumption, no clamped result. `CostError::InsufficientStock` carries both
/// counts so the operator is told what is actually available.
pub async fn remove(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    product_id: &str,
    quantity: i64,
) -> Result<StockOutcome, StockServiceError> {
    let session = authorize(pool, tokens, Sensitivity::Routine).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    let removal = remove_in_tx(&mut tx, &actor, product_id, quantity, now).await?;

    // Manual removal is a stock adjustment, not a sale: one ledger row per layer
    // consumed, so the movement sums still reconcile with the position.
    for segment in &removal.segments {
        sales_repo::insert_movement(
            &mut tx,
            &MovementRecord {
                id: uuid::Uuid::now_v7().to_string(),
                product_id: product_id.to_owned(),
                kind: "adjustment".to_owned(),
                quantity_delta: -segment.quantity,
                unit_cost_minor: segment.unit_cost_minor,
                cost_delta_minor: -segment.cost_minor,
                occurred_at: now.as_millis(),
                actor_id: actor.as_str().to_owned(),
                sale_id: None,
                sale_line_id: None,
                fifo_layer_id: segment.fifo_layer_id.clone(),
                fifo_received_at: segment.fifo_received_at,
                reverses_movement_id: None,
            },
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    }

    audit::append(
        &mut tx,
        actor,
        audit::event::STOCK_REMOVED,
        now,
        Some(format!(
            r#"{{"product":"{}","quantity":{},"cost_minor":{},"method":"{}","on_hand":{}}}"#,
            product_id, quantity, removal.cost_removed_minor, removal.method, removal.remaining_quantity
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(StockOutcome {
        quantity: removal.remaining_quantity,
        cost_minor: removal.cost_removed_minor,
    })
}

/// What a read-only position looks like to a caller.
///
/// `layers` is empty under Moving Average and populated under FIFO, which is the
/// authority rule made visible: a manager can see which representation is in
/// charge without inferring it from a missing column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StockPositionView {
    /// Units on hand, authoritative under either method.
    pub quantity: i64,
    /// The Moving Average total, or `None` when the layers hold the cost.
    pub total_cost_minor: Option<i64>,
    /// The method that governs this product.
    pub cost_method: CostMethod,
    /// FIFO layers, oldest first. Empty unless the method is FIFO.
    pub layers: Vec<FifoLayer>,
    /// Whether a `stock_levels` row exists for this product at all.
    ///
    /// This is what separates **"never stocked"** from **"stocked, but the cost
    /// authority is missing"**, and the two must never be collapsed:
    ///
    /// - no row — the ordinary state of a product nobody has received yet. Zero
    ///   balance, zero cost, no error.
    /// - a row with `total_cost_minor = NULL` under Moving Average — nothing in
    ///   this module ever writes that, so it means a write came from outside and
    ///   the cost is genuinely unknown. Refused.
    ///
    /// The device found this: `get_position` reported
    /// `STOCK_COST_AUTHORITY_CONFLICT` for a brand-new product simply because it
    /// had never been received, which blocked the natural path for any new item.
    pub row_exists: bool,
}

impl StockPositionView {
    /// The cost the operator should think of: the stored total under Moving
    /// Average, and the summed layers under FIFO.
    ///
    /// Derived, never stored. `ADR-013` rejects a stored average because it
    /// drifts; the same reasoning applies to a stored FIFO total.
    pub fn effective_cost_minor(&self) -> Result<i64, StockError> {
        match self.cost_method {
            CostMethod::MovingAverage => match self.total_cost_minor {
                Some(total) => Ok(total),
                // A product that has never been received holds nothing, so it
                // costs nothing. That is a fact about the world, not a defect.
                None if !self.row_exists => Ok(0),
                // A row exists but carries no cost under the method that claims
                // it. Nothing writes this, so reporting it as free stock would
                // invent a value; it is refused and surfaced instead.
                None => Err(StockError::CostAuthorityConflict {
                    product_id: String::from("<position>"),
                }),
            },
            CostMethod::Fifo => FifoPosition::new(self.layers.clone())
                .total_cost_minor()
                .map_err(StockError::from),
        }
    }
}

/// Read a product's stock position. No mutation, no transaction.
///
/// `ManageInventory` for the stock itself, plus `ViewCostAndProfit` because this
/// returns money: `role.rs` gates cost figures by role *and* assurance, so a
/// manager who has only just signed in is refused until the password is proven
/// again. Reading stock and reading its cost are deliberately not the same
/// permission.
pub async fn position(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    product_id: &str,
) -> Result<StockPositionView, StockServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageInventory)?;
    session.authorize(Permission::ViewCostAndProfit)?;

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;

    let department_id = product_department(&mut conn, product_id).await?;
    let method = resolve_cost_method(&mut conn, department_id.as_deref()).await?;
    let stored = load_position(&mut conn, product_id).await?;
    let layers = load_layers_under(&mut conn, product_id, method).await?;

    let view = StockPositionView {
        quantity: stored.as_ref().map(|position| position.quantity).unwrap_or(0),
        total_cost_minor: stored.as_ref().and_then(|position| position.total_cost_minor),
        cost_method: method,
        layers,
        // Carried explicitly so `effective_cost_minor` can tell "never stocked"
        // from "stocked with a missing cost" — see the field's documentation.
        row_exists: stored.is_some(),
    };

    // Validate before returning, so a contradiction is reported by the read
    // itself rather than surfacing later as a bad number. `load_layers_under`
    // has already refused layers the method does not own; this catches the
    // remaining half — a row holding stock with no cost under the method that
    // claims it.
    view.effective_cost_minor()?;

    Ok(view)
}

/// Switch a department between `moving_average` and `fifo`.
///
/// `Sensitive`, always: `ADR-013` makes the switch manager-only, re-authenticated
/// and Pattern-gated, because it changes what every existing unit is worth.
///
/// The conversions, per `ADR-013`:
///
/// * **MA → FIFO** seeds one layer holding the current on-hand quantity at the
///   current average cost. Nothing is seeded when nothing is on hand — an empty
///   layer would carry no cost fact.
/// * **FIFO → MA** collapses the layers into their summed total.
///
/// A switch to the method already in force is a no-op that still records the
/// event: the manager asked, and an audit that quietly ignored a request is
/// worse than one that records a decision that changed nothing.
pub async fn switch_cost_method(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    department_id: DepartmentId,
    target: CostMethod,
) -> Result<(), StockServiceError> {
    let session = authorize(pool, tokens, Sensitivity::Sensitive).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    let mut department = department_repo::find_by_id(&mut tx, department_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DepartmentError::NotFound)?;

    let previous = department.cost_method;
    let positions =
        repo::list_positions_in_department(&mut *tx, &department_id.as_str())
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

    let mut converted = 0i64;
    for position in &positions {
        match (previous, target) {
            // Nothing to do: the value already reads as the target claims.
            (CostMethod::MovingAverage, CostMethod::MovingAverage)
            | (CostMethod::Fifo, CostMethod::Fifo) => {}

            // Seed one layer at the current average. The average is ceilinged,
            // because that is the only rounding rule money has here — and it is
            // the same figure `AveragePosition::unit_cost_minor` quotes, so the
            // seeded layer and the value a screen shows cannot disagree.
            (CostMethod::MovingAverage, CostMethod::Fifo) => {
                if position.quantity == 0 {
                    repo::upsert_position(
                        &mut tx,
                        &repo::StockPosition {
                            product_id: position.product_id.clone(),
                            quantity: 0,
                            total_cost_minor: None,
                        },
                        &actor,
                        now.as_millis(),
                    )
                    .await
                    .map_err(|_| DomainError::StorageUnavailable)?;
                    continue;
                }

                let average = average_position(&position.product_id, Some(position))?
                    .unit_cost_minor()
                    .ok_or(CostError::ZeroUnits)?;
                let layer = FifoLayer::new(position.quantity, average)?;
                repo::insert_layer(
                    &mut tx,
                    &uuid::Uuid::now_v7().to_string(),
                    &position.product_id,
                    &layer,
                    now.as_millis(),
                    &actor,
                )
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
                repo::upsert_position(
                    &mut tx,
                    &repo::StockPosition {
                        product_id: position.product_id.clone(),
                        quantity: position.quantity,
                        total_cost_minor: None,
                    },
                    &actor,
                    now.as_millis(),
                )
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
                converted += 1;
            }

            // Collapse the layers into their summed total. `Total_cost_minor()`
            // is checked rather than unwrapped: an overflow here is a refusal,
            // and the transaction rolls back so no product is left half
            // converted.
            (CostMethod::Fifo, CostMethod::MovingAverage) => {
                let layers = load_layers_under(&mut *tx, &position.product_id, previous).await?;
                let total = FifoPosition::new(layers).total_cost_minor()?;
                repo::delete_layers(&mut tx, &position.product_id)
                    .await
                    .map_err(|_| DomainError::StorageUnavailable)?;
                repo::upsert_position(
                    &mut tx,
                    &repo::StockPosition {
                        product_id: position.product_id.clone(),
                        quantity: position.quantity,
                        total_cost_minor: Some(total),
                    },
                    &actor,
                    now.as_millis(),
                )
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
                converted += 1;
            }
        }
    }

    // The department row itself. `Department::update` now refuses a costing-method
    // change (it would relabel the stock without converting it), so the value is
    // written directly and the conversion above is what makes it honest.
    sqlx::query(
        "UPDATE departments
         SET cost_method = ?1, updated_by = ?2, updated_at = ?3
         WHERE id = ?4",
    )
    .bind(target.as_str())
    .bind(actor.as_str())
    .bind(now.as_millis())
    .bind(department_id.as_str())
    .execute(&mut *tx)
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    // Keep the in-memory copy truthful for the caller; nothing reads it below.
    department.cost_method = target;

    audit::append(
        &mut tx,
        actor,
        audit::event::COST_METHOD_SWITCHED,
        now,
        Some(format!(
            r#"{{"department":"{}","from":"{}","to":"{}","products_converted":{}}}"#,
            department_id.as_str(),
            previous,
            target,
            converted
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}