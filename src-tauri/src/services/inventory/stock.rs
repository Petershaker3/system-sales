//! Stock and costing use cases: `receive`, `remove`, `position`.
//!
//! # One costing method for stock counted by quantity
//!
//! Every quantity product is costed by **moving average** (`ADR-016` #7, plan
//! item 1.3). The authority is `stock_levels.total_cost_minor`; the ceiling
//! rounding, the `i128` intermediates and the per-line cost snapshot of
//! `ADR-013` all stay. Units tracked one by one by IMEI carry their own actual
//! cost and arrive with plan item 1.4.
//!
//! # FIFO is retired, its data is not rewritten up front
//!
//! FIFO and switching the method per department were removed from the
//! services and the screens. Migrations are never edited, so a database written
//! before this change can still hold FIFO rows: `fifo_layers` with a `NULL`
//! total on the position. Such a position is **collapsed on first touch** —
//! inside the transaction of the receipt, removal, sale or reversal that touches
//! it, attributed to that operator and audited as `cost_layers_collapsed`. The
//! layers' summed cost becomes the moving-average total, so what the stock is
//! worth does not change. A read never writes: `position` reports the summed
//! total without collapsing anything.
//!
//! A position that contradicts itself — layers *and* a total, layers that do
//! not add up to the quantity on hand, or units on hand with no cost at all —
//! is refused, never repaired: quietly picking one side would pick a cost.
//!
//! `departments.cost_method` and the `default_cost_method` setting are no
//! longer read by costing. The columns stay because applied migrations are
//! never changed.
//!
//! # Authorization
//!
//! `Permission::ManageInventory` for every operation, and never more than the
//! operation needs. Inventory is money rather than identity, so it is not
//! `ManageCatalog`; and it is deliberately *not* a blanket re-authenticated
//! permission, because receiving a carton is routine while opening a balance
//! declares what the shop is worth. The fourth axis is applied per operation
//! through [`Sensitivity`]:
//!
//! - receiving a delivery — `Routine`
//! - declaring an opening balance — `Sensitive`

use std::fmt;

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::inventory::stock as repo;
use crate::data::repositories::inventory::unit::{self as unit_repo, UnitRecord};
use crate::data::repositories::sales::{self as sales_repo, MovementRecord};
use crate::data::repositories::settings::app_settings as settings_repo;
use crate::data::repositories::shortage as shortage_repo;
use crate::domain::costing::fifo::{FifoLayer, FifoPosition};
use crate::domain::costing::moving_average::AveragePosition;
use crate::domain::costing::CostError;
use crate::domain::identity::{
    DomainError, OwnerApproval, Permission, Sensitivity, Session, Timestamp, UserId,
};
use crate::domain::organisation::{CostMethod, DepartmentError};
use crate::domain::supplier::SupplierName;
use crate::domain::unit::{Imei, ReceiptKind, UnitError};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::approval as approval_service;
use crate::services::identity::session as identity_session;

/// The costing method of every product counted by quantity (`ADR-016` #7).
///
/// Recorded on each sale line as its cost snapshot, so a report can tell these
/// lines from the ones a pre-1.3 database sold under FIFO.
pub(crate) const QUANTITY_COST_METHOD: CostMethod = CostMethod::MovingAverage;

/// No product matches the id a caller named.
///
/// Its own variant rather than a collapsed generic failure, matching
/// `NoProductWithThisId` in the catalogue: a missing product and a forbidden
/// action send an operator to different places.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StockError {
    /// No product carries this id.
    ProductNotFound,
    /// The stored position contradicts itself.
    ///
    /// Raised rather than repaired: legacy layers beside a moving-average total,
    /// layers that do not add up to the quantity on hand, or units on hand with
    /// no cost at all. Each means something wrote outside this module, and
    /// quietly picking one side would pick a cost.
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
                "product {product_id} stores a stock position that contradicts itself"
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
    Unit(UnitError),
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

impl From<UnitError> for StockServiceError {
    fn from(error: UnitError) -> Self {
        Self::Unit(error)
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
            Self::Unit(error) => error.code(),
        }
    }
}

impl fmt::Display for StockServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Identity(error) => write!(f, "{error}"),
            Self::Stock(error) => write!(f, "{error}"),
            Self::Department(error) => write!(f, "{error}"),
            Self::Unit(error) => write!(f, "{error}"),
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
/// own sensitivity — returning the owner approval a sensitive operation will
/// spend, or `None` for routine work.
///
/// The order matters and is the same one every other service uses: role and
/// permission first, so a session that may not touch inventory is refused
/// before anything asks whether it holds the owner's approval.
async fn authorize(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    sensitivity: Sensitivity,
) -> Result<(Session, Option<OwnerApproval>), StockServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageInventory)?;
    let approval = session.require_sensitivity(sensitivity, Timestamp::now())?;
    Ok((session, approval))
}

/// Refuse an unknown product before anything is read or written for it.
///
/// Its own query rather than a side effect of another one, so a missing product
/// is always `STOCK_PRODUCT_NOT_FOUND` and never a confusing empty position.
async fn ensure_product(
    conn: &mut sqlx::SqliteConnection,
    product_id: &str,
) -> Result<(), StockServiceError> {
    sqlx::query("SELECT 1 FROM products WHERE id = ?1")
        .bind(product_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(StockError::ProductNotFound)?;
    Ok(())
}

/// Load a position, or `None` if the product has never been stocked.
async fn load_position(
    conn: &mut sqlx::SqliteConnection,
    product_id: &str,
) -> Result<Option<repo::StockPosition>, StockServiceError> {
    Ok(repo::find_position(conn, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?)
}

/// What a position left behind by the retired FIFO method is worth under the
/// moving average, or `None` when the position is not a legacy one.
///
/// Pure: it decides, the caller writes (or, for a read, does not). Two legacy
/// shapes exist, both written only by the FIFO code that 1.3 removed:
///
/// * layers on disk, with a position whose quantity they add up to and whose
///   total is `NULL` — collapsed into the layers' summed cost;
/// * no layers and an emptied position with a `NULL` total — FIFO wrote that
///   when its last layer was consumed, and it is worth exactly zero.
///
/// Everything else that mixes the two representations is a contradiction and
/// is refused, so a collapse can never invent or lose a piastre.
fn legacy_average(
    product_id: &str,
    position: Option<&repo::StockPosition>,
    layers: Vec<FifoLayer>,
) -> Result<Option<AveragePosition>, StockServiceError> {
    let conflict = || -> StockServiceError {
        StockError::CostAuthorityConflict {
            product_id: product_id.to_owned(),
        }
        .into()
    };

    if layers.is_empty() {
        return match position {
            Some(position) if position.total_cost_minor.is_none() && position.quantity == 0 => {
                Ok(Some(AveragePosition::EMPTY))
            }
            _ => Ok(None),
        };
    }

    // Layers exist, so the position must be FIFO's: present, with no total, and
    // holding exactly the units the layers hold.
    let Some(position) = position else {
        return Err(conflict());
    };
    if position.total_cost_minor.is_some() {
        return Err(conflict());
    }
    let fifo = FifoPosition::new(layers);
    if fifo.on_hand() != position.quantity {
        return Err(conflict());
    }
    let total = fifo.total_cost_minor()?;
    Ok(Some(AveragePosition::new(total, position.quantity)?))
}

/// Collapse a legacy FIFO position into the moving average, inside the
/// caller's transaction. A no-op for every position written since 1.3.
///
/// Run first by every operation that writes stock, so the arithmetic after it
/// only ever sees one representation. The layers' summed cost becomes the
/// total, the layers are deleted, and the change is audited once, attributed to
/// the operator whose operation touched the product.
pub(crate) async fn collapse_legacy_in_tx(
    conn: &mut sqlx::SqliteConnection,
    acting_user: &UserId,
    product_id: &str,
    now: Timestamp,
) -> Result<(), StockServiceError> {
    let position = load_position(conn, product_id).await?;
    let layers = repo::list_layers(conn, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let layer_count = layers.len();

    let Some(average) = legacy_average(product_id, position.as_ref(), layers)? else {
        return Ok(());
    };

    if layer_count > 0 {
        repo::delete_layers(conn, product_id)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
    }
    repo::upsert_position(
        conn,
        &repo::StockPosition {
            product_id: product_id.to_owned(),
            quantity: average.on_hand,
            total_cost_minor: Some(average.total_cost_minor),
        },
        acting_user,
        now.as_millis(),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        conn,
        acting_user.clone(),
        audit::event::COST_LAYERS_COLLAPSED,
        now,
        Some(format!(
            r#"{{"product":"{}","layers":{},"on_hand":{},"total_cost_minor":{}}}"#,
            product_id, layer_count, average.on_hand, average.total_cost_minor
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}

/// The moving-average position for a product, refusing a position with no cost.
///
/// Called after [`collapse_legacy_in_tx`], so a `NULL` total here is never a
/// legacy FIFO row: it means units are on hand with no cost recorded anywhere,
/// and the cost is genuinely unknown rather than zero.
fn average_position(
    product_id: &str,
    position: Option<&repo::StockPosition>,
) -> Result<AveragePosition, StockServiceError> {
    let Some(position) = position else {
        return Ok(AveragePosition::EMPTY);
    };
    let Some(total) = position.total_cost_minor else {
        return Err(StockError::CostAuthorityConflict {
            product_id: product_id.to_owned(),
        }
        .into());
    };
    AveragePosition::new(total, position.quantity).map_err(StockServiceError::from)
}

/// One consumption, as the movement ledger records it.
///
/// Under the moving average there is exactly one segment per removal and the
/// layer fields are `None`: there are no layers to name. The fields stay
/// because the ledger columns do, and sales recorded before 1.3 under FIFO
/// still carry them.
///
/// `cost_minor` is the *exact* cost this segment removed, which is deliberately
/// not always `quantity × unit_cost_minor`: the removal is `ceil(U·T/Q)` while
/// the quoted unit cost is `ceil(T/Q)`, and the two need not agree. Summing
/// `cost_minor` is what reconciles the ledger with the position; the unit cost
/// is a quoted reference only.
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
    /// Oldest `in_stock` units retired because an unlinked removal reduced
    /// `remaining_quantity` below the number of registered IMEIs (`PLAN.md` §7.3).
    pub retired_unit_ids: Vec<String>,
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
    ensure_product(conn, product_id).await?;
    // A position left by the retired FIFO method becomes a moving-average one
    // first, in this same transaction, so the arithmetic below sees only one
    // representation.
    collapse_legacy_in_tx(conn, acting_user, product_id, now).await?;
    let position = load_position(conn, product_id).await?;

    let current = average_position(product_id, position.as_ref())?;
    let in_stock_units = unit_repo::list_in_stock_for_product(conn, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let (cost_removed_minor, remaining_on_hand, remaining_total_cost, quoted, retired_unit_ids) =
        if in_stock_units.is_empty() {
            // The quoted average, read before the removal, is the per-unit figure a
            // screen shows for this line. The exact `cost_removed_minor` stays the
            // authority; this is a reference, not a base for totals.
            let quoted = current.unit_cost_minor().unwrap_or(0);
            let removal = current.remove(quantity)?;
            (
                removal.cost_removed_minor,
                removal.remaining.on_hand,
                removal.remaining.total_cost_minor,
                quoted,
                Vec::new(),
            )
        } else {
            // Ensure overall quantity is sufficient (`CostError::InsufficientStock`
            // or `ZeroUnits` / `NegativeQuantity` is produced by `current.remove`).
            let _ = current.remove(quantity)?;

            let registered_count = in_stock_units.len() as i64;
            let registered_cost: i64 = in_stock_units.iter().map(|u| u.unit_cost_minor).sum();
            let unregistered_qty = (current.on_hand - registered_count).max(0);
            let unregistered_cost = (current.total_cost_minor - registered_cost).max(0);

            if quantity <= unregistered_qty {
                let unreg_pos = AveragePosition::new(unregistered_cost, unregistered_qty)?;
                let quoted = unreg_pos.unit_cost_minor().unwrap_or(0);
                let unreg_removal = unreg_pos.remove(quantity)?;
                let remaining_on_hand = current.on_hand - quantity;
                let remaining_total = registered_cost
                    .checked_add(unreg_removal.remaining.total_cost_minor)
                    .ok_or(CostError::Overflow)?;
                (
                    unreg_removal.cost_removed_minor,
                    remaining_on_hand,
                    remaining_total,
                    quoted,
                    Vec::new(),
                )
            } else {
                // `quantity > unregistered_qty`: consume all `unregistered_qty`
                // plus the `overflow` oldest registered units (`PLAN.md` §7.3).
                let overflow = (quantity - unregistered_qty) as usize;
                let retired_slice = &in_stock_units[..overflow];
                let retired_cost: i64 = retired_slice.iter().map(|u| u.unit_cost_minor).sum();
                let cost_removed = unregistered_cost
                    .checked_add(retired_cost)
                    .ok_or(CostError::Overflow)?;
                let remaining_on_hand = current.on_hand - quantity;
                let remaining_total = (current.total_cost_minor - cost_removed).max(0);
                let quoted = AveragePosition::new(cost_removed, quantity)?
                    .unit_cost_minor()
                    .unwrap_or(0);
                let retired_ids = retired_slice.iter().map(|u| u.id.clone()).collect();
                (
                    cost_removed,
                    remaining_on_hand,
                    remaining_total,
                    quoted,
                    retired_ids,
                )
            }
        };

    repo::upsert_position(
        conn,
        &repo::StockPosition {
            product_id: product_id.to_owned(),
            quantity: remaining_on_hand,
            total_cost_minor: Some(remaining_total_cost),
        },
        acting_user,
        now.as_millis(),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(RemovalInTx {
        method: QUANTITY_COST_METHOD,
        cost_removed_minor,
        remaining_quantity: remaining_on_hand,
        segments: vec![ConsumedSegment {
            fifo_layer_id: None,
            fifo_received_at: None,
            quantity,
            unit_cost_minor: quoted,
            // The exact removal, not `quantity × quoted`: `ceil` makes the two
            // differ, and the ledger must carry the exact one.
            cost_minor: cost_removed_minor,
        }],
        retired_unit_ids,
    })
}

/// What consuming a single IMEI unit inside a sale transaction returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitSaleConsumption {
    pub unit_id: String,
    pub method: CostMethod,
    pub cost_removed_minor: i64,
    pub remaining_quantity: i64,
    pub segments: Vec<ConsumedSegment>,
}

/// Consume one specific device by IMEI inside the caller's sale transaction (`ADR-019`).
///
/// - If the IMEI is already registered (`status = 'in_stock'`) for this product,
///   consumes that unit at its exact `unit_cost_minor`.
/// - If the IMEI is not yet registered, and the product has unregistered stock
///   on hand (`on_hand > in_stock_units.len()`), late-registers the unit at the
///   unregistered pool's moving average and consumes it (`PLAN.md` §7.2).
/// - The returned `unit_id` is still `status = 'in_stock'` so the caller can
///   insert `sale_lines` referencing `unit_id` first and then call
///   `unit_repo::mark_sold`.
pub(crate) async fn consume_unit_in_tx(
    conn: &mut sqlx::SqliteConnection,
    acting_user: &UserId,
    product_id: &str,
    raw_imei: &str,
    now: Timestamp,
) -> Result<UnitSaleConsumption, StockServiceError> {
    ensure_product(conn, product_id).await?;
    let tracking = unit_repo::product_tracking(conn, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(StockError::ProductNotFound)?;
    if !tracking.allows_imei() {
        return Err(UnitError::ProductNotSerialTracked.into());
    }

    let imei = Imei::parse(raw_imei)?;

    collapse_legacy_in_tx(conn, acting_user, product_id, now).await?;
    let position = load_position(conn, product_id).await?;
    let current = average_position(product_id, position.as_ref())?;
    // Ensure at least 1 unit is on hand.
    let _ = current.remove(1)?;

    let existing = unit_repo::find_by_imei(conn, imei.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let (unit_id, cost_removed) = match existing {
        Some(unit) => {
            if unit.product_id != product_id {
                return Err(UnitError::UnitProductMismatch.into());
            }
            if unit.status != "in_stock" {
                return Err(UnitError::UnitNotAvailable.into());
            }
            let cost = unit.unit_cost_minor.min(current.total_cost_minor);
            (unit.id, cost)
        }
        None => {
            // Late registration from an unrecorded box on the shelf (`PLAN.md` §7.2).
            let in_stock_units = unit_repo::list_in_stock_for_product(conn, product_id)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
            let registered_count = in_stock_units.len() as i64;
            if current.on_hand <= registered_count {
                return Err(UnitError::NoUnregisteredStockForLateImei.into());
            }
            let registered_cost: i64 = in_stock_units.iter().map(|u| u.unit_cost_minor).sum();
            let unregistered_qty = current.on_hand - registered_count;
            let unregistered_cost = (current.total_cost_minor - registered_cost).max(0);
            let unreg_pos = AveragePosition::new(unregistered_cost, unregistered_qty)?;
            let removal = unreg_pos.remove(1)?;
            let cost = removal.cost_removed_minor;
            let new_unit_id = uuid::Uuid::now_v7().to_string();
            unit_repo::insert_unit(
                conn,
                &UnitRecord {
                    id: new_unit_id.clone(),
                    product_id: product_id.to_owned(),
                    imei: imei.as_str().to_owned(),
                    imei2: None,
                    color: None,
                    unit_cost_minor: cost,
                    status: "in_stock".to_owned(),
                    received_movement_id: None,
                    sale_line_id: None,
                    retired_reason: None,
                    created_by: acting_user.as_str().to_owned(),
                    created_at: now.as_millis(),
                    condition_grade: None,
                    battery_health_pct: None,
                    accessories: None,
                    seller_name: None,
                    seller_phone: None,
                    seller_national_id: None,
                    intake_note: None,
                },
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
            (new_unit_id, cost)
        }
    };

    let remaining_on_hand = current.on_hand - 1;
    let remaining_total_cost = (current.total_cost_minor - cost_removed).max(0);

    repo::upsert_position(
        conn,
        &repo::StockPosition {
            product_id: product_id.to_owned(),
            quantity: remaining_on_hand,
            total_cost_minor: Some(remaining_total_cost),
        },
        acting_user,
        now.as_millis(),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(UnitSaleConsumption {
        unit_id,
        method: QUANTITY_COST_METHOD,
        cost_removed_minor: cost_removed,
        remaining_quantity: remaining_on_hand,
        segments: vec![ConsumedSegment {
            fifo_layer_id: None,
            fifo_received_at: None,
            quantity: 1,
            unit_cost_minor: cost_removed,
            cost_minor: cost_removed,
        }],
    })
}

/// Receive stock: add units at a known unit cost.
///
/// `Routine` by default. An opening balance is the same arithmetic with a
/// different `Sensitivity`, so the caller chooses rather than this function
/// guessing what a receipt means. A `Sensitive` receipt spends the session's
/// owner approval in its own transaction and names the approver in its audit
/// row (ADR-017 §3).
///
/// `supplier` is the label the operator typed on the delivery (D1). It is
/// recorded on the receipt movement and nowhere else: a sale, a reversal, a
/// removal and an adjustment never carry one, and the table enforces that too.
/// `None` means nobody named a supplier, which the column stores as NULL so the
/// derived supplier list never shows a blank.
pub async fn receive(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    product_id: &str,
    quantity: i64,
    unit_cost_minor: i64,
    sensitivity: Sensitivity,
    supplier: Option<SupplierName>,
) -> Result<StockOutcome, StockServiceError> {
    let receipt_kind = match sensitivity {
        Sensitivity::Routine => ReceiptKind::Supplier,
        Sensitivity::Sensitive => ReceiptKind::Opening,
    };
    receive_with_units(
        pool,
        tokens,
        product_id,
        quantity,
        unit_cost_minor,
        receipt_kind,
        sensitivity,
        supplier,
        &[],
    )
    .await
}

/// Receive stock with optional IMEI units and an explicit receipt kind (`ADR-019`).
///
/// - `ReceiptKind::Supplier` is a normal purchase (`Sensitivity::Routine`), and
///   may carry an optional supplier name.
/// - `ReceiptKind::Opening` is first-time stock already on the shelf (`ADR-016` #30,
///   `Sensitivity::Sensitive`), spends one owner PIN approval inside the
///   transaction, and refuses any supplier name (`UnitError::OpeningReceiptHasSupplier`).
/// - Each IMEI in `imeis` is validated (15 digits + Luhn + unique in batch and
///   in the shop) and recorded in `units` with its actual `unit_cost_minor`.
#[allow(clippy::too_many_arguments)]
pub async fn receive_with_units(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    product_id: &str,
    quantity: i64,
    unit_cost_minor: i64,
    receipt_kind: ReceiptKind,
    sensitivity: Sensitivity,
    supplier: Option<SupplierName>,
    imeis: &[String],
) -> Result<StockOutcome, StockServiceError> {
    if receipt_kind == ReceiptKind::Opening && supplier.is_some() {
        return Err(UnitError::OpeningReceiptHasSupplier.into());
    }
    let parsed_imeis = Imei::parse_batch(imeis)?;

    let (session, approval) = authorize(pool, tokens, sensitivity).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    // Spent here, inside the receipt's transaction, so the approval and the
    // receipt commit together or not at all. `None` for a routine receipt.
    let approved_by = approval_service::consume_in_tx(&mut tx, &session, approval).await?;

    ensure_product(&mut *tx, product_id).await?;
    let tracking = unit_repo::product_tracking(&mut *tx, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(StockError::ProductNotFound)?;
    let appearance = settings_repo::load_appearance(&mut *tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    if !parsed_imeis.is_empty() && !tracking.allows_imei() {
        return Err(UnitError::ProductNotSerialTracked.into());
    }
    if (parsed_imeis.len() as i64) > quantity {
        return Err(UnitError::ImeiCountExceedsQuantity.into());
    }
    if tracking.requires_imei(&appearance.imei_mode) && (parsed_imeis.len() as i64) != quantity {
        return Err(UnitError::ImeiRequiredForAllUnits.into());
    }
    for imei in &parsed_imeis {
        if unit_repo::find_by_imei(&mut *tx, imei.as_str())
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
            .is_some()
        {
            return Err(UnitError::ImeiAlreadyRegistered.into());
        }
    }

    collapse_legacy_in_tx(&mut *tx, &actor, product_id, now).await?;
    let position = load_position(&mut *tx, product_id).await?;

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
    let outcome = StockOutcome {
        quantity: updated.on_hand,
        cost_minor: 0,
    };

    // The ledger row for this receipt. A receipt is a movement in, at the stated
    // unit cost; the same integers the position received are recorded here, so
    // the position and the ledger cannot disagrees about what arrived.
    let receipt_cost = quantity
        .checked_mul(unit_cost_minor)
        .ok_or(CostError::Overflow)?;
    let movement_id = uuid::Uuid::now_v7().to_string();
    sales_repo::insert_movement(
        &mut tx,
        &MovementRecord {
            id: movement_id.clone(),
            product_id: product_id.to_owned(),
            kind: "receipt".to_owned(),
            quantity_delta: quantity,
            unit_cost_minor,
            cost_delta_minor: receipt_cost,
            occurred_at: now.as_millis(),
            actor_id: actor.as_str().to_owned(),
            sale_id: None,
            sale_line_id: None,
            fifo_layer_id: None,
            fifo_received_at: None,
            reverses_movement_id: None,
            // The one movement that is a purchase, so the one that may name a
            // supplier (D1). Trimmed once here; the column stores it verbatim.
            supplier_name: supplier.as_ref().map(|name| name.as_str().to_owned()),
            receipt_kind: Some(receipt_kind.as_str().to_owned()),
        },
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    for imei in &parsed_imeis {
        unit_repo::insert_unit(
            &mut tx,
            &UnitRecord {
                id: uuid::Uuid::now_v7().to_string(),
                product_id: product_id.to_owned(),
                imei: imei.as_str().to_owned(),
                imei2: None,
                color: None,
                unit_cost_minor,
                status: "in_stock".to_owned(),
                received_movement_id: Some(movement_id.clone()),
                sale_line_id: None,
                retired_reason: None,
                created_by: actor.as_str().to_owned(),
                created_at: now.as_millis(),
                condition_grade: None,
                battery_health_pct: None,
                accessories: None,
                seller_name: None,
                seller_phone: None,
                seller_national_id: None,
                intake_note: None,
            },
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    }

    audit::append(
        &mut tx,
        actor,
        audit::event::STOCK_RECEIVED,
        now,
        Some(format!(
            r#"{{"product":"{}","quantity":{},"unit_cost_minor":{},"method":"{}","on_hand":{},"supplier":{}{}}}"#,
            product_id,
            quantity,
            unit_cost_minor,
            QUANTITY_COST_METHOD,
            outcome.quantity,
            // `null` rather than `""`, so the audit row distinguishes "nobody
            // named a supplier" from an empty label.
            supplier.as_ref().map_or("null".to_owned(), |name| {
                format!("\"{}\"", name.as_str().replace('"', "\\\""))
            }),
            // Only a sensitive receipt carries an approver, so a routine
            // receipt's detail is exactly what it always was.
            approved_by.map_or(String::new(), |id| format!(r#","approved_by":"{id}""#))
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    // Plan item 1.15 (`ADR-030`): receiving stock for a product automatically
    // resolves any active shortage for that product inside the same transaction.
    shortage_repo::resolve_shortages_for_product(&mut tx, product_id, now.as_millis())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(outcome)
}

/// Remove stock: consume units and report what they cost at the average.
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
    let (session, _) = authorize(pool, tokens, Sensitivity::Routine).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    let removal = remove_in_tx(&mut tx, &actor, product_id, quantity, now).await?;
    for uid in &removal.retired_unit_ids {
        unit_repo::mark_retired_manual(&mut tx, uid, "manual_stock_removal")
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
    }

    // Manual removal is a stock adjustment, not a sale: one ledger row per
    // segment, so the movement sums still reconcile with the position.
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
                // A manual removal corrects stock; it is not a purchase and names
                // no supplier. The table refuses one here, and rightly so.
                supplier_name: None,
                receipt_kind: None,
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StockPositionView {
    /// Units on hand.
    pub quantity: i64,
    /// The moving-average total, or `None` when the product was never stocked.
    ///
    /// A legacy FIFO position reads as its summed layers here, without being
    /// collapsed: a read never writes.
    pub total_cost_minor: Option<i64>,
    /// Whether a `stock_levels` row exists for this product at all.
    ///
    /// This is what separates **"never stocked"** from **"stocked, but the cost
    /// is missing"**, and the two must never be collapsed:
    ///
    /// - no row — the ordinary state of a product nobody has received yet. Zero
    ///   balance, zero cost, no error.
    /// - a row holding units with `total_cost_minor = NULL` and no legacy layers
    ///   — nothing in this module writes that, so it means a write came from
    ///   outside and the cost is genuinely unknown. Refused.
    ///
    /// The device found this: `get_position` reported
    /// `STOCK_COST_AUTHORITY_CONFLICT` for a brand-new product simply because it
    /// had never been received, which blocked the natural path for any new item.
    pub row_exists: bool,
}

impl StockPositionView {
    /// The cost the operator should think of: the moving-average total, or zero
    /// for a product that was never stocked.
    pub fn effective_cost_minor(&self) -> Result<i64, StockError> {
        match self.total_cost_minor {
            Some(total) => Ok(total),
            // A product that has never been received holds nothing, so it costs
            // nothing. That is a fact about the world, not a defect.
            None if !self.row_exists => Ok(0),
            // A row exists but carries no cost. Nothing writes this, so
            // reporting it as free stock would invent a value; it is refused
            // and surfaced instead.
            None => Err(StockError::CostAuthorityConflict {
                product_id: String::from("<position>"),
            }),
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

    ensure_product(&mut conn, product_id).await?;
    let stored = load_position(&mut conn, product_id).await?;
    let layers = repo::list_layers(&mut conn, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    // A legacy FIFO position is reported at its summed layers — the value a
    // collapse would write — while the rows themselves stay untouched.
    let view = match legacy_average(product_id, stored.as_ref(), layers)? {
        Some(average) => StockPositionView {
            quantity: average.on_hand,
            total_cost_minor: Some(average.total_cost_minor),
            row_exists: true,
        },
        None => StockPositionView {
            quantity: stored.as_ref().map(|position| position.quantity).unwrap_or(0),
            total_cost_minor: stored.as_ref().and_then(|position| position.total_cost_minor),
            row_exists: stored.is_some(),
        },
    };

    // Validate before returning, so a contradiction is reported by the read
    // itself rather than surfacing later as a bad number.
    view.effective_cost_minor()?;

    Ok(view)
}

/// Read the registered `in_stock` units for a product, oldest first (`ADR-019`).
///
/// Requires `Permission::ManageInventory`.
pub async fn list_units_in_stock(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    product_id: &str,
) -> Result<Vec<UnitRecord>, StockServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageInventory)?;

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    ensure_product(&mut conn, product_id).await?;
    let units = unit_repo::list_in_stock_for_product(&mut conn, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(units)
}

