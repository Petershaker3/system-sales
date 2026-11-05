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
use crate::domain::catalog::{BrandId, CatalogError, DeviceType, Disposition};
use crate::domain::costing::fifo::{FifoLayer, FifoPosition};
use crate::domain::costing::moving_average::AveragePosition;
use crate::domain::costing::CostError;
use crate::domain::identity::{
    DomainError, OwnerApproval, Permission, Sensitivity, Session, Timestamp, UserId,
};
use crate::domain::organisation::{CostMethod, DepartmentError, DepartmentId};
use crate::domain::supplier::SupplierName;
use crate::domain::unit::{
    validate_optional_bounded, Imei, ReceiptKind, UnitError, UNIT_COLOR_MAX_CHARS,
};
use crate::services::catalog::brands::BrandServiceError;
use crate::services::catalog::phone::{self as phone_use_cases, NewPhone};
use crate::services::catalog::product as catalog_product;
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
    /// A delivery document arrived with no lines (`0035`).
    ReceiptEmpty,
    /// A delivery line names neither an existing product nor a new one, or names
    /// both (`0035`).
    ReceiptLineEmpty,
    /// A line asked for zero or a negative number of pieces (`0035`).
    ReceiptQuantityInvalid,
    /// The supplier's invoice reference is blank or longer than the column allows.
    ReceiptReferenceInvalid,
    /// The purchase day is not a real `YYYY-MM-DD` calendar day.
    ReceiptDateInvalid,
    /// The delivery note is blank or longer than the column allows.
    ReceiptNoteInvalid,
    /// Every piece on the shelf already carries a serial number, so registering
    /// one more would claim a device the shop does not have (`0035`).
    NoUntrackedPieces,
}

impl StockError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ProductNotFound => "STOCK_PRODUCT_NOT_FOUND",
            Self::CostAuthorityConflict { .. } => "STOCK_COST_AUTHORITY_CONFLICT",
            Self::Cost(error) => error.code(),
            Self::ReceiptEmpty => "RECEIPT_EMPTY",
            Self::ReceiptLineEmpty => "RECEIPT_LINE_EMPTY",
            Self::ReceiptQuantityInvalid => "RECEIPT_QUANTITY_INVALID",
            Self::ReceiptReferenceInvalid => "RECEIPT_REFERENCE_INVALID",
            Self::ReceiptDateInvalid => "RECEIPT_DATE_INVALID",
            Self::ReceiptNoteInvalid => "RECEIPT_NOTE_INVALID",
            Self::NoUntrackedPieces => "RECEIPT_NO_UNTRACKED_PIECES",
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
            Self::ReceiptEmpty => write!(f, "a delivery document needs at least one line"),
            Self::ReceiptLineEmpty => {
                write!(f, "a delivery line names neither an existing product nor a new one")
            }
            Self::ReceiptQuantityInvalid => write!(f, "a delivery line must hold at least 1 piece"),
            Self::ReceiptReferenceInvalid => write!(f, "the supplier reference is not valid"),
            Self::ReceiptDateInvalid => write!(f, "the purchase day is not a calendar day"),
            Self::ReceiptNoteInvalid => write!(f, "the delivery note is not valid"),
            Self::NoUntrackedPieces => {
                write!(f, "every piece on hand already carries a serial number")
            }
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
    /// A product the receiving document had to create was refused by the
    /// catalogue (`0035`), so the whole delivery is refused with it.
    Catalog(CatalogError),
    /// The same for a phone model: its company, type or duplicate check failed.
    Brand(BrandServiceError),
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

impl From<CatalogError> for StockServiceError {
    fn from(error: CatalogError) -> Self {
        Self::Catalog(error)
    }
}

impl From<BrandServiceError> for StockServiceError {
    fn from(error: BrandServiceError) -> Self {
        Self::Brand(error)
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
            Self::Catalog(error) => error.code(),
            Self::Brand(error) => error.code(),
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
            Self::Catalog(error) => write!(f, "{error}"),
            Self::Brand(error) => write!(f, "{error}"),
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

/// Read a category id that arrived as text.
///
/// The receiving document takes ids from the WebView, so they are parsed here
/// rather than trusted: a bad id is «no such category», which is what the
/// operator would see if the category had been archived under them.
fn parse_department(raw: &str) -> Result<DepartmentId, CatalogError> {
    uuid::Uuid::parse_str(raw)
        .map(DepartmentId::from_uuid)
        .map_err(|_| CatalogError::CategoryNotFound)
}

/// Read a company id that arrived as text.
fn parse_brand(raw: &str) -> Result<BrandId, BrandServiceError> {
    uuid::Uuid::parse_str(raw)
        .map(BrandId::from_uuid)
        .map_err(|_| crate::domain::catalog::BrandError::NotFound.into())
}

/// Receive stock with optional IMEI units and an explicit receipt kind (`ADR-019`).
///
/// The signature every existing caller uses: a receipt with no paperwork. It is
/// the same transaction as [`receive_with_paperwork`], which is where the work
/// happens now that a delivery can carry a supplier invoice and a note.
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
    receive_with_paperwork(
        pool,
        tokens,
        product_id,
        quantity,
        unit_cost_minor,
        receipt_kind,
        sensitivity,
        supplier,
        &ReceiptPaperwork::default(),
        imeis,
    )
    .await
}

/// Receive stock with the paperwork of a delivery (`0035`).
///
/// The same arithmetic as `receive_with_units`, plus the supplier invoice
/// reference, the purchase day and the note. A receipt is still one transaction:
/// the paperwork commits with the stock or not at all.
#[allow(clippy::too_many_arguments)]
pub async fn receive_with_paperwork(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    product_id: &str,
    quantity: i64,
    unit_cost_minor: i64,
    receipt_kind: ReceiptKind,
    sensitivity: Sensitivity,
    supplier: Option<SupplierName>,
    paperwork: &ReceiptPaperwork,
    imeis: &[String],
) -> Result<StockOutcome, StockServiceError> {
    if receipt_kind == ReceiptKind::Opening && supplier.is_some() {
        return Err(UnitError::OpeningReceiptHasSupplier.into());
    }
    paperwork.validate(receipt_kind)?;
    let parsed_imeis = Imei::parse_batch(imeis)?;
    let paperwork = paperwork.trimmed();

    let (session, approval) = authorize(pool, tokens, sensitivity).await?;
    let now = Timestamp::now();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    // Spent inside the receipt's transaction, so the approval and the receipt
    // commit together or not at all. `None` for a routine receipt.
    let approved_by = approval_service::consume_in_tx(&mut tx, &session, approval).await?;

    let outcome = receive_in_tx(
        &mut tx,
        &session,
        now,
        product_id,
        quantity,
        unit_cost_minor,
        receipt_kind,
        supplier.as_ref(),
        &paperwork,
        &parsed_imeis,
        approved_by.as_ref(),
    )
    .await?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(outcome)
}

/// One line of a delivery document (`0035`).
///
/// A line is EITHER an existing product (`product_id`) OR a new one described
/// inline (`new_item` / `new_phone`). The new-product variant exists because the
/// shopkeeper registering «Samsung A16 256GB — وصلت ٥» is doing one thing, and
/// splitting it into «create the model» then «receive the pieces» is how a
/// product can be left behind with no stock after a failed second step.
pub struct DocumentLine {
    pub product_id: Option<String>,
    pub new_item: Option<NewCountedProduct>,
    pub new_phone: Option<NewPhoneProduct>,
    pub quantity: i64,
    pub unit_cost_minor: i64,
    pub imeis: Vec<String>,
}

/// A counted product (accessory or part) created by the receiving document.
pub struct NewCountedProduct {
    pub name: String,
    pub category_id: Option<String>,
    pub sale_price_minor: Option<i64>,
}

/// A phone model created by the receiving document.
pub struct NewPhoneProduct {
    pub category_id: String,
    pub brand_id: String,
    pub model: String,
    pub device_type: String,
    pub storage_gb: Option<i64>,
    pub ram_gb: Option<i64>,
    pub sale_price_minor: Option<i64>,
}

/// What one saved delivery wrote.
#[derive(Debug, Clone)]
pub struct ReceivedDocument {
    pub document_id: String,
    pub lines: Vec<(String, StockOutcome)>,
}

impl ReceivedDocument {
    /// Pieces on the whole delivery, in the shop's own word for it.
    pub fn total_quantity(&self) -> i64 {
        self.lines.iter().map(|(_, outcome)| outcome.quantity).sum()
    }
}

/// Receive a whole delivery as ONE transaction (`0035`).
///
/// All lines commit or none do: a carton of five items is one page of paper, and
/// a program that saves four of them has told the shopkeeper something untrue
/// about their own delivery. A line may name an existing product or describe a
/// brand-new one; in the second case the product, its details, its stock, its
/// receipt and its IMEI units are all written inside this same transaction.
#[allow(clippy::too_many_arguments)]
pub async fn receive_document(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    receipt_kind: ReceiptKind,
    supplier: Option<SupplierName>,
    paperwork: &ReceiptPaperwork,
    lines: &[DocumentLine],
) -> Result<ReceivedDocument, StockServiceError> {
    if lines.is_empty() {
        return Err(StockError::ReceiptEmpty.into());
    }
    if receipt_kind == ReceiptKind::Opening && supplier.is_some() {
        return Err(UnitError::OpeningReceiptHasSupplier.into());
    }
    paperwork.validate(receipt_kind)?;
    let paperwork = paperwork.trimmed();

    // Every IMEI in the whole document is parsed before the transaction opens, so
    // a typo in line five costs nothing.
    let mut parsed_by_line: Vec<Vec<Imei>> = Vec::with_capacity(lines.len());
    for line in lines {
        if line.quantity < 1 {
            return Err(StockError::ReceiptQuantityInvalid.into());
        }
        if line.unit_cost_minor < 0 {
            return Err(CostError::NegativeTotal.into());
        }
        parsed_by_line.push(Imei::parse_batch(&line.imeis)?);
    }

    let sensitivity = match receipt_kind {
        ReceiptKind::Opening => Sensitivity::Sensitive,
        ReceiptKind::Supplier => Sensitivity::Routine,
    };
    let (session, approval) = authorize(pool, tokens, sensitivity).await?;
    let now = Timestamp::now();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    // One approval for the whole document, spent inside its transaction.
    let approved_by = approval_service::consume_in_tx(&mut tx, &session, approval).await?;

    let document_id = paperwork
        .document_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let mut paperwork = paperwork;
    paperwork.document_id = Some(document_id.clone());

    let mut written: Vec<(String, StockOutcome)> = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        let product_id = match (&line.new_item, &line.new_phone) {
            (Some(item), None) => {
                let product = catalog_product::create_in_tx(
                    &mut tx,
                    &session,
                    catalog_product::NewProduct {
                        name: item.name.clone(),
                        disposition: Disposition::Quantity,
                        barcode: None,
                        sale_price_minor: item.sale_price_minor,
                        category: item
                            .category_id
                            .as_deref()
                            .map(parse_department)
                            .transpose()?,
                    },
                )
                .await?;
                product.id.as_str()
            }
            (None, Some(phone)) => {
                let product = phone_use_cases::create_phone_in_tx(
                    &mut tx,
                    &session,
                    now,
                    phone_use_cases::NewPhone {
                        category: parse_department(&phone.category_id)?,
                        brand: parse_brand(&phone.brand_id)?,
                        model: phone.model.clone(),
                        device_type: DeviceType::parse(&phone.device_type)
                            .ok_or(CatalogError::InvalidDeviceType)?,
                        storage_gb: phone.storage_gb,
                        ram_gb: phone.ram_gb,
                        sale_price_minor: phone.sale_price_minor,
                    },
                )
                .await?;
                product.product.id.as_str()
            }
            (None, None) => match line.product_id.as_deref() {
                Some(id) => id.to_owned(),
                None => return Err(StockError::ReceiptLineEmpty.into()),
            },
            (Some(_), Some(_)) => return Err(StockError::ReceiptLineEmpty.into()),
        };

        let outcome = receive_in_tx(
            &mut tx,
            &session,
            now,
            &product_id,
            line.quantity,
            line.unit_cost_minor,
            receipt_kind,
            supplier.as_ref(),
            &paperwork,
            &parsed_by_line[index],
            approved_by.as_ref(),
        )
        .await?;
        written.push((product_id, outcome));
    }

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(ReceivedDocument {
        document_id,
        lines: written,
    })
}

/// Give one piece already on the shelf its real IMEI (`0035`).
///
/// A quantity product can hold pieces nobody wrote a serial for — the owner's
/// choice is «الـIMEI مش إجباري». This registers one of those pieces as a unit at
/// the product's current moving average, and changes neither the balance nor the
/// total cost: the piece was already counted, only its identity is new.
pub async fn register_stock_unit(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    product_id: &str,
    imei: &str,
    color: Option<&str>,
) -> Result<UnitRecord, StockServiceError> {
    let (session, _) = authorize(pool, tokens, Sensitivity::Routine).await?;
    let now = Timestamp::now();
    let actor = session.user_id();
    let imei = Imei::parse(imei)?;
    let color = validate_optional_bounded(color, UNIT_COLOR_MAX_CHARS)?;

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    ensure_product(&mut tx, product_id).await?;
    let tracking = unit_repo::product_tracking(&mut tx, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(StockError::ProductNotFound)?;
    if !tracking.allows_imei() {
        return Err(UnitError::ProductNotSerialTracked.into());
    }
    if unit_repo::find_by_imei(&mut tx, imei.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .is_some()
    {
        return Err(UnitError::ImeiAlreadyRegistered.into());
    }

    let position = load_position(&mut tx, product_id).await?;
    let current = average_position(product_id, position.as_ref())?;
    let registered = unit_repo::list_in_stock_for_product(&mut tx, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .len() as i64;
    if registered >= current.on_hand {
        // Every piece on the shelf already has a serial: a new one would claim a
        // device the shop does not have.
        return Err(StockError::NoUntrackedPieces.into());
    }
    let unit_cost = if current.on_hand > 0 {
        current.total_cost_minor / current.on_hand
    } else {
        0
    };

    let record = UnitRecord {
        id: uuid::Uuid::now_v7().to_string(),
        product_id: product_id.to_owned(),
        imei: imei.as_str().to_owned(),
        imei2: None,
        color,
        unit_cost_minor: unit_cost,
        status: "in_stock".to_owned(),
        received_movement_id: None,
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
    };
    unit_repo::insert_unit(&mut tx, &record)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::STOCK_RECEIVED,
        now,
        Some(format!(
            r#"{{"product":"{}","registered_imei":true,"unit_cost_minor":{}}}"#,
            product_id, unit_cost
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(record)
}

/// The longest supplier reference the column holds (`0035`).
pub const RECEIPT_REFERENCE_MAX_CHARS: usize = 60;

/// The longest delivery note the column holds (`0035`).
pub const RECEIPT_NOTE_MAX_CHARS: usize = 300;

/// The paperwork that belongs to one delivery (`0035`).
///
/// Every field is optional and every field is a label the operator typed on the
/// paper that came with the goods. `None` is «not written down», which is a
/// different fact from an empty string — the columns say so too.
#[derive(Debug, Clone, Default)]
pub struct ReceiptPaperwork {
    /// Groups the lines of one delivery. Assigned by `receive_document`, which is
    /// the only writer of a multi-line receipt; a one-line receipt from
    /// `receive_with_paperwork` gets its own id when the caller supplies none.
    pub document_id: Option<String>,
    /// The supplier's own invoice/reference number.
    pub document_ref: Option<String>,
    /// The day the goods were bought, `YYYY-MM-DD`.
    pub purchase_date: Option<String>,
    /// One free line about the delivery.
    pub note: Option<String>,
}

impl ReceiptPaperwork {
    /// Refuse paperwork the ledger cannot honestly hold.
    ///
    /// The bounds mirror the columns in `0035`; the date is checked as a real
    /// calendar day rather than just a shape, because «2026-02-31» would pass a
    /// regex and lie. Opening stock is not a purchase, so it may carry a note
    /// («الرف اللي ورا») and nothing else.
    pub fn validate(&self, receipt_kind: ReceiptKind) -> Result<(), StockServiceError> {
        let reference = self.document_ref.as_deref().map(str::trim).unwrap_or("");
        if self.document_ref.is_some()
            && (reference.is_empty() || reference.chars().count() > RECEIPT_REFERENCE_MAX_CHARS)
        {
            return Err(StockError::ReceiptReferenceInvalid.into());
        }
        let note = self.note.as_deref().map(str::trim).unwrap_or("");
        if self.note.is_some() && (note.is_empty() || note.chars().count() > RECEIPT_NOTE_MAX_CHARS)
        {
            return Err(StockError::ReceiptNoteInvalid.into());
        }
        if let Some(date) = self.purchase_date.as_deref() {
            if !is_calendar_day(date) {
                return Err(StockError::ReceiptDateInvalid.into());
            }
        }
        if receipt_kind == ReceiptKind::Opening
            && (self.document_ref.is_some() || self.purchase_date.is_some())
        {
            return Err(UnitError::OpeningReceiptHasSupplier.into());
        }
        Ok(())
    }

    fn trimmed(&self) -> ReceiptPaperwork {
        ReceiptPaperwork {
            document_id: self.document_id.clone(),
            document_ref: self
                .document_ref
                .as_deref()
                .map(str::trim)
                .map(str::to_owned),
            purchase_date: self.purchase_date.clone(),
            note: self.note.as_deref().map(str::trim).map(str::to_owned),
        }
    }
}

/// `YYYY-MM-DD`, and a day that exists.
fn is_calendar_day(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let digits = |from: usize, to: usize| -> Option<i64> {
        let slice = raw.get(from..to)?;
        if !slice.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        slice.parse::<i64>().ok()
    };
    let (Some(year), Some(month), Some(day)) = (digits(0, 4), digits(5, 7), digits(8, 10)) else {
        return false;
    };
    if !(1900..=2999).contains(&year) || !(1..=12).contains(&month) {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let last = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if leap {
                29
            } else {
                28
            }
        }
    };
    (1..=last).contains(&day)
}

/// The receiving arithmetic, inside a transaction the caller owns.
///
/// This is what `receive_with_units`, `receive_document` and the inline-creation
/// path all call: one product, one quantity, one unit cost, one receipt row, its
/// IMEI units, its audit row and the shortages it resolves. Nothing here begins
/// or commits a transaction, so a delivery of five lines commits as one page or
/// not at all.
#[allow(clippy::too_many_arguments)]
async fn receive_in_tx(
    conn: &mut sqlx::SqliteConnection,
    // The session, not an actor id: the identity that writes a receipt is resolved
    // once, by the service, and a helper that took an id could be called with any.
    session: &Session,
    now: Timestamp,
    product_id: &str,
    quantity: i64,
    unit_cost_minor: i64,
    receipt_kind: ReceiptKind,
    supplier: Option<&SupplierName>,
    paperwork: &ReceiptPaperwork,
    parsed_imeis: &[Imei],
    approved_by: Option<&UserId>,
) -> Result<StockOutcome, StockServiceError> {
    let actor = session.user_id();
    // Every receipt belongs to a document, even a delivery of one line: that is
    // what lets the history read a batch back as one page (`0035`).
    let document_id = paperwork
        .document_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    ensure_product(&mut *conn, product_id).await?;
    let tracking = unit_repo::product_tracking(&mut *conn, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(StockError::ProductNotFound)?;
    let appearance = settings_repo::load_appearance(&mut *conn)
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
    for imei in parsed_imeis {
        if unit_repo::find_by_imei(&mut *conn, imei.as_str())
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
            .is_some()
        {
            return Err(UnitError::ImeiAlreadyRegistered.into());
        }
    }

    collapse_legacy_in_tx(&mut *conn, &actor, product_id, now).await?;
    let position = load_position(&mut *conn, product_id).await?;

    let current = average_position(product_id, position.as_ref())?;
    let updated = current.receive(quantity, unit_cost_minor)?;
    repo::upsert_position(
        conn,
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
        conn,
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
            supplier_name: supplier.map(|name| name.as_str().to_owned()),
            receipt_kind: Some(receipt_kind.as_str().to_owned()),
            // The delivery this line belongs to, and the paperwork typed on it
            // (`0035`). Every line of one «احفظ التوريد» shares the document id.
            document_id: Some(document_id),
            document_ref: paperwork.document_ref.clone(),
            purchase_date: paperwork.purchase_date.clone(),
            note: paperwork.note.clone(),
        },
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    for imei in parsed_imeis {
        unit_repo::insert_unit(
            conn,
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
        conn,
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
            supplier.map_or("null".to_owned(), |name| {
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
    shortage_repo::resolve_shortages_for_product(conn, product_id, now.as_millis())
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
    remove_with_reason(pool, tokens, product_id, quantity, None).await
}

/// Take stock out and write **why** (`0035`).
///
/// A removal is not a sale and not a delivery: it is the shop saying «الناقص ده
/// تالف» or «الجهاز ضاع» or «العدّ غلط». Without the reason those three read the
/// same in the ledger a month later, so the reason is required here and recorded
/// twice — in the audit row and as the retired unit's own reason.
#[allow(clippy::too_many_arguments)]
pub async fn remove_with_reason(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    product_id: &str,
    quantity: i64,
    reason: Option<&str>,
) -> Result<StockOutcome, StockServiceError> {
    let reason = reason.map(str::trim).filter(|text| !text.is_empty());
    if let Some(text) = reason {
        if text.chars().count() > RECEIPT_NOTE_MAX_CHARS {
            return Err(StockError::ReceiptNoteInvalid.into());
        }
    }
    let (session, _) = authorize(pool, tokens, Sensitivity::Routine).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    let removal = remove_in_tx(&mut tx, &actor, product_id, quantity, now).await?;
    // The operator's own words when they gave any; otherwise the ledger's old
    // name for a manual removal, so a piece never retires without a reason.
    let unit_reason = reason.unwrap_or("manual_stock_removal");
    for uid in &removal.retired_unit_ids {
        unit_repo::mark_retired_manual(&mut tx, uid, unit_reason)
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
                document_id: None,
                document_ref: None,
                purchase_date: None,
                note: None,
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
            r#"{{"product":"{}","quantity":{},"cost_minor":{},"method":"{}","on_hand":{},"reason":{}}}"#,
            product_id,
            quantity,
            removal.cost_removed_minor,
            removal.method,
            removal.remaining_quantity,
            // `null` rather than `""`: «no reason given» and «an empty reason»
            // must not be the same row.
            reason.map_or("null".to_owned(), |text| format!("\"{}\"", text.replace('"', "\\\"")))
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

/// Read all `in_stock` units across all active products (`ADR-034`, Plan item 2.4).
///
/// Requires `Permission::ManageInventory`. Cost and seller fields are redacted
/// unless the operator also holds `Permission::ViewCostAndProfit`.
pub async fn list_all_units_in_stock(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Vec<UnitRecord>, StockServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageInventory)?;
    let can_view_cost = session.role().allows(Permission::ViewCostAndProfit);

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let mut units = unit_repo::list_all_in_stock_for_active_products(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if !can_view_cost {
        for u in &mut units {
            u.unit_cost_minor = 0;
            u.seller_name = None;
            u.seller_phone = None;
            u.seller_national_id = None;
        }
    }
    Ok(units)
}

/// What the whole stock is worth at cost, and how many pieces it holds.
///
/// The owner measures his stock at the wholesale price, never at the sale price
/// (`2026-10-23`). Reading that one product at a time needed a request per product
/// and left the screen with a total it could not trust; this answers it once, from
/// the same authority `position` reads (`stock_levels.total_cost_minor`, with a
/// legacy FIFO position reported at its summed layers).
///
/// Requires `Permission::ManageInventory` **and** `Permission::ViewCostAndProfit`:
/// it is a cost figure, not a quantity.
pub struct StockValueView {
    /// Cost of everything on hand, in piastres.
    pub value_minor: i64,
    /// Pieces on hand across every product that has any.
    pub quantity: i64,
    /// How many products those pieces belong to.
    pub products: i64,
}

pub async fn stock_value(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<StockValueView, StockServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageInventory)?;
    session.authorize(Permission::ViewCostAndProfit)?;

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let ids = repo::list_active_product_ids(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let mut value_minor = 0i64;
    let mut quantity = 0i64;
    let mut products = 0i64;
    for id in ids {
        let stored = load_position(&mut conn, &id).await?;
        let layers = repo::list_layers(&mut conn, &id)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        // Same reading as `position()`, so the total and the per-product figure
        // can never disagree.
        let (on_hand, total_cost_minor) = match legacy_average(&id, stored.as_ref(), layers)? {
            Some(average) => (average.on_hand, average.total_cost_minor),
            None => (
                stored.as_ref().map(|position| position.quantity).unwrap_or(0),
                stored
                    .as_ref()
                    .and_then(|position| position.total_cost_minor)
                    .unwrap_or(0),
            ),
        };
        if on_hand > 0 {
            products += 1;
            quantity += on_hand;
            value_minor += total_cost_minor;
        }
    }

    Ok(StockValueView {
        value_minor,
        quantity,
        products,
    })
}

/// One delivery that came in: what, how many, at what cost, from whom.
pub struct ReceiptRow {
    pub id: String,
    pub product_id: String,
    pub product_name: String,
    pub quantity: i64,
    pub unit_cost_minor: i64,
    pub supplier_name: Option<String>,
    pub occurred_at: i64,
    /// `'supplier'` for a purchase, `'opening'` for stock already on the shelf.
    pub receipt_kind: Option<String>,
    /// The delivery this line belongs to — several lines share one (`0035`).
    pub document_id: Option<String>,
    /// The supplier's invoice/reference number, as typed (`0035`).
    pub document_ref: Option<String>,
    /// The day the goods were bought, `YYYY-MM-DD` (`0035`).
    pub purchase_date: Option<String>,
    /// The note typed on the delivery (`0035`).
    pub note: Option<String>,
}

/// The receiving log, newest first — the deliveries, not the sales (`2026-11-02`).
///
/// Requires `Permission::ManageInventory`. The cost is zeroed for an operator who
/// may not see cost, exactly as `list_all_units_in_stock` does.
pub async fn list_receipts(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    limit: i64,
    product_id: Option<&str>,
) -> Result<Vec<ReceiptRow>, StockServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageInventory)?;
    let can_view_cost = session.role().allows(Permission::ViewCostAndProfit);
    let limit = limit.clamp(1, 500);

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let rows = repo::list_receipts(&mut conn, limit, product_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let mut out: Vec<ReceiptRow> = rows
        .into_iter()
        .map(|r| ReceiptRow {
            id: r.id,
            product_id: r.product_id,
            product_name: r.product_name,
            quantity: r.quantity,
            unit_cost_minor: r.unit_cost_minor,
            supplier_name: r.supplier_name,
            occurred_at: r.occurred_at,
            receipt_kind: r.receipt_kind,
            document_id: r.document_id,
            document_ref: r.document_ref,
            purchase_date: r.purchase_date,
            note: r.note,
        })
        .collect();
    if !can_view_cost {
        for r in &mut out {
            r.unit_cost_minor = 0;
        }
    }
    Ok(out)
}

/// One product's physical count input during a Stock Count reconciliation (`ADR-034`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StockCountItemInput {
    pub product_id: String,
    pub counted_quantity: i64,
    /// Specific `in_stock` unit IDs confirmed missing during the IMEI scan count.
    pub missing_unit_ids: Vec<String>,
    /// Optional fallback unit cost in piastres when a surplus is found on a 0-stock item.
    pub unit_cost_minor: Option<i64>,
}

/// Summary of what a Stock Count reconciliation changed (`ADR-034`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StockCountReconcileOutcome {
    pub adjusted_products: usize,
    pub retired_units: usize,
    pub net_quantity_delta: i64,
    pub net_cost_delta_minor: i64,
}

/// Reconcile physical stock count discrepancies and missing IMEI units (`ADR-034`, Plan item 2.4).
///
/// `Sensitive`: requires `Permission::ManageInventory` and spends one Owner PIN
/// approval inside the transaction (`PLAN.md` §11: «الرصيد الافتتاحي والتسويات: بـPIN المالك، مع سبب»).
pub async fn reconcile_stock_count(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    reason: &str,
    items: &[StockCountItemInput],
) -> Result<StockCountReconcileOutcome, StockServiceError> {
    let (session, approval) = authorize(pool, tokens, Sensitivity::Sensitive).await?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let clean_reason = {
        let trimmed = reason.trim();
        if trimmed.is_empty() {
            "تسوية جرد بالمسح"
        } else {
            trimmed
        }
    };
    let retired_note = format!("جرد: {clean_reason}");

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    let approved_by = approval_service::consume_in_tx(&mut tx, &session, approval).await?;

    let mut adjusted_products = 0usize;
    let mut retired_units_total = 0usize;
    let mut net_quantity_delta = 0i64;
    let mut net_cost_delta_minor = 0i64;

    for item in items {
        if item.counted_quantity < 0 {
            return Err(StockError::Cost(CostError::NegativeQuantity).into());
        }
        ensure_product(&mut tx, &item.product_id).await?;
        collapse_legacy_in_tx(&mut tx, &actor, &item.product_id, now).await?;
        let position = load_position(&mut tx, &item.product_id).await?;
        let current = average_position(&item.product_id, position.as_ref())?;
        let in_stock_units = unit_repo::list_in_stock_for_product(&mut tx, &item.product_id)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

        // Identify explicitly missing IMEI units that belong to this product and are in_stock.
        let explicit_missing: Vec<&UnitRecord> = in_stock_units
            .iter()
            .filter(|u| item.missing_unit_ids.iter().any(|mid| mid == &u.id))
            .collect();
        let explicit_missing_count = explicit_missing.len() as i64;

        // If explicit missing units are specified, the counted quantity cannot exceed
        // `current.on_hand - explicit_missing_count`.
        let effective_counted = if explicit_missing_count > 0 {
            item.counted_quantity
                .min((current.on_hand - explicit_missing_count).max(0))
        } else {
            item.counted_quantity
        };

        let qty_delta = effective_counted - current.on_hand;
        if qty_delta == 0 && explicit_missing.is_empty() {
            continue;
        }

        if qty_delta < 0 {
            let remove_qty = -qty_delta;
            // Validate overall stock sufficiency.
            let _ = current.remove(remove_qty)?;

            // Retire explicitly missing IMEI units first.
            let mut explicit_cost: i64 = 0;
            for u in &explicit_missing {
                unit_repo::mark_retired_manual(&mut tx, &u.id, &retired_note)
                    .await
                    .map_err(|_| DomainError::StorageUnavailable)?;
                explicit_cost = explicit_cost
                    .checked_add(u.unit_cost_minor)
                    .ok_or(CostError::Overflow)?;
                retired_units_total += 1;
            }

            // Remaining units still in stock after explicit retirements:
            let remaining_units: Vec<&UnitRecord> = in_stock_units
                .iter()
                .filter(|u| !item.missing_unit_ids.iter().any(|mid| mid == &u.id))
                .collect();
            let remaining_reg_count = remaining_units.len() as i64;
            let remaining_reg_cost: i64 = remaining_units.iter().map(|u| u.unit_cost_minor).sum();

            let on_hand_after_explicit = current.on_hand - explicit_missing_count;
            let total_cost_after_explicit = (current.total_cost_minor - explicit_cost).max(0);
            let rem_remove = remove_qty - explicit_missing_count;

            let mut extra_cost_removed: i64 = 0;
            if rem_remove > 0 {
                if remaining_units.is_empty() {
                    let pos = AveragePosition::new(total_cost_after_explicit, on_hand_after_explicit)?;
                    let rem = pos.remove(rem_remove)?;
                    extra_cost_removed = rem.cost_removed_minor;
                } else {
                    let unreg_qty = (on_hand_after_explicit - remaining_reg_count).max(0);
                    let unreg_cost = (total_cost_after_explicit - remaining_reg_cost).max(0);
                    if rem_remove <= unreg_qty {
                        let unreg_pos = AveragePosition::new(unreg_cost, unreg_qty)?;
                        let rem = unreg_pos.remove(rem_remove)?;
                        extra_cost_removed = rem.cost_removed_minor;
                    } else {
                        let overflow = (rem_remove - unreg_qty) as usize;
                        let overflow_slice = &remaining_units[..overflow];
                        let overflow_cost: i64 =
                            overflow_slice.iter().map(|u| u.unit_cost_minor).sum();
                        for u in overflow_slice {
                            unit_repo::mark_retired_manual(&mut tx, &u.id, &retired_note)
                                .await
                                .map_err(|_| DomainError::StorageUnavailable)?;
                            retired_units_total += 1;
                        }
                        extra_cost_removed = unreg_cost
                            .checked_add(overflow_cost)
                            .ok_or(CostError::Overflow)?;
                    }
                }
            }

            let total_cost_removed = explicit_cost
                .checked_add(extra_cost_removed)
                .ok_or(CostError::Overflow)?
                .min(current.total_cost_minor);
            let final_total_cost = (current.total_cost_minor - total_cost_removed).max(0);
            let quoted_unit_cost = AveragePosition::new(total_cost_removed, remove_qty)?
                .unit_cost_minor()
                .unwrap_or(0);

            repo::upsert_position(
                &mut tx,
                &repo::StockPosition {
                    product_id: item.product_id.clone(),
                    quantity: effective_counted,
                    total_cost_minor: Some(final_total_cost),
                },
                &actor,
                now.as_millis(),
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

            sales_repo::insert_movement(
                &mut tx,
                &MovementRecord {
                    id: uuid::Uuid::now_v7().to_string(),
                    product_id: item.product_id.clone(),
                    kind: "adjustment".to_owned(),
                    quantity_delta: -remove_qty,
                    unit_cost_minor: quoted_unit_cost,
                    cost_delta_minor: -total_cost_removed,
                    occurred_at: now.as_millis(),
                    actor_id: actor.as_str().to_owned(),
                    sale_id: None,
                    sale_line_id: None,
                    fifo_layer_id: None,
                    fifo_received_at: None,
                    reverses_movement_id: None,
                    supplier_name: None,
                    receipt_kind: None,
                    document_id: None,
                    document_ref: None,
                    purchase_date: None,
                    note: None,
                },
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

            audit::append(
                &mut tx,
                actor.clone(),
                audit::event::STOCK_REMOVED,
                now,
                Some(format!(
                    r#"{{"product":"{}","quantity":{},"cost_minor":{},"method":"{}","on_hand":{},"reason":"{}"{}}}"#,
                    item.product_id,
                    remove_qty,
                    total_cost_removed,
                    QUANTITY_COST_METHOD,
                    effective_counted,
                    clean_reason.replace('"', "\\\""),
                    approved_by
                        .as_ref()
                        .map_or(String::new(), |id| format!(r#","approved_by":"{id}""#))
                )),
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

            adjusted_products += 1;
            net_quantity_delta -= remove_qty;
            net_cost_delta_minor -= total_cost_removed;
        } else if qty_delta > 0 {
            let add_qty = qty_delta;
            let unit_cost = current
                .unit_cost_minor()
                .unwrap_or_else(|| item.unit_cost_minor.unwrap_or(0).max(0));
            let updated = current.receive(add_qty, unit_cost)?;
            let cost_added = updated
                .total_cost_minor
                .checked_sub(current.total_cost_minor)
                .ok_or(CostError::Overflow)?;

            repo::upsert_position(
                &mut tx,
                &repo::StockPosition {
                    product_id: item.product_id.clone(),
                    quantity: updated.on_hand,
                    total_cost_minor: Some(updated.total_cost_minor),
                },
                &actor,
                now.as_millis(),
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

            sales_repo::insert_movement(
                &mut tx,
                &MovementRecord {
                    id: uuid::Uuid::now_v7().to_string(),
                    product_id: item.product_id.clone(),
                    kind: "adjustment".to_owned(),
                    quantity_delta: add_qty,
                    unit_cost_minor: unit_cost,
                    cost_delta_minor: cost_added,
                    occurred_at: now.as_millis(),
                    actor_id: actor.as_str().to_owned(),
                    sale_id: None,
                    sale_line_id: None,
                    fifo_layer_id: None,
                    fifo_received_at: None,
                    reverses_movement_id: None,
                    supplier_name: None,
                    receipt_kind: None,
                    document_id: None,
                    document_ref: None,
                    purchase_date: None,
                    note: None,
                },
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

            shortage_repo::resolve_shortages_for_product(&mut tx, &item.product_id, now.as_millis())
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;

            audit::append(
                &mut tx,
                actor.clone(),
                audit::event::STOCK_RECEIVED,
                now,
                Some(format!(
                    r#"{{"product":"{}","quantity":{},"unit_cost_minor":{},"method":"{}","on_hand":{},"supplier":null,"reason":"{}"{}}}"#,
                    item.product_id,
                    add_qty,
                    unit_cost,
                    QUANTITY_COST_METHOD,
                    updated.on_hand,
                    clean_reason.replace('"', "\\\""),
                    approved_by
                        .as_ref()
                        .map_or(String::new(), |id| format!(r#","approved_by":"{id}""#))
                )),
            )
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;

            adjusted_products += 1;
            net_quantity_delta += add_qty;
            net_cost_delta_minor += cost_added;
        }
    }

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(StockCountReconcileOutcome {
        adjusted_products,
        retired_units: retired_units_total,
        net_quantity_delta,
        net_cost_delta_minor,
    })
}


