//! Tauri commands for stock and costing.
//!
//! Transport boundaries only. No SQL and no business rule appears here: the
//! arithmetic, the authority rule and the transaction all live in
//! `services::inventory`.
//!
//! # No session parameter, on purpose
//!
//! No command accepts a token, a user id, a role or an actor. Each resolves the
//! current operator from the OS credential store through the shared
//! `IdentityContext` and lets the service authorise. That is what makes
//! attribution a fact rather than a claim.
//!
//! # `Sensitivity` is the service's decision, not the caller's
//!
//! The movement commands do not take a sensitivity argument. Deciding how much
//! proof an operation needs is a domain judgement (`ADR-015`), and letting the
//! WebView pass it would let a caller downgrade a sensitive operation to a
//! routine one. The frontend chooses *which* use case to invoke; the service
//! decides what that use case costs.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::domain::identity::Sensitivity;
use crate::domain::supplier::SupplierName;
use crate::domain::unit::ReceiptKind;
use crate::services::inventory::stock::{DocumentLine, NewCountedProduct, NewPhoneProduct, ReceiptPaperwork};
use crate::services::identity::IdentityContext;
use crate::services::inventory::imei as imei_use_cases;
use crate::services::inventory::stock::{self as use_cases, StockServiceError};

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure crossing the boundary is a stable code, never prose.
/// `spec:127` keeps user-facing text in Arabic message files on the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCommandError {
    pub code: &'static str,
}

impl From<StockServiceError> for InventoryCommandError {
    fn from(error: StockServiceError) -> Self {
        Self {
            code: error.code(),
        }
    }
}

impl From<imei_use_cases::SetImeiError> for InventoryCommandError {
    fn from(error: imei_use_cases::SetImeiError) -> Self {
        Self {
            code: error.code(),
        }
    }
}

impl From<crate::services::inventory::stock::StockError> for InventoryCommandError {
    fn from(error: crate::services::inventory::stock::StockError) -> Self {
        Self {
            code: error.code(),
        }
    }
}

/// A stock position as the frontend sees it.
///
/// Every quantity product is costed by moving average (`ADR-016` #7).
/// `totalCostMinor` stays nullable and **that nullability is meaningful**:
/// `null` means the product was never stocked, and `0` would mean free stock.
/// The frontend must not collapse them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockPositionDto {
    pub product_id: String,
    pub quantity: i64,
    pub total_cost_minor: Option<i64>,
    pub effective_cost_minor: i64,
}

/// What the whole stock is worth at cost, and how many pieces it holds (`value`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockValueDto {
    pub value_minor: i64,
    pub quantity: i64,
    pub products: i64,
}

/// One delivery in the receiving log.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptRowDto {
    pub id: String,
    pub product_id: String,
    pub product_name: String,
    pub quantity: i64,
    pub unit_cost_minor: i64,
    pub supplier_name: Option<String>,
    pub occurred_at: i64,
    /// `'supplier'` or `'opening'` (`ADR-019`).
    pub receipt_kind: Option<String>,
    /// The delivery this line belongs to; several lines share one (`0035`).
    pub document_id: Option<String>,
    /// The supplier's own invoice/reference number, as typed (`0035`).
    pub document_ref: Option<String>,
    /// The day the goods were bought, `YYYY-MM-DD` (`0035`).
    pub purchase_date: Option<String>,
    /// The note typed on the delivery (`0035`).
    pub note: Option<String>,
}

/// What one movement changed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockOutcomeDto {
    pub product_id: String,
    pub quantity: i64,
    pub cost_minor: i64,
}

/// One registered `in_stock` device unit (`ADR-019`, `ADR-032`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductUnitDto {
    pub id: String,
    pub product_id: String,
    pub imei: String,
    pub imei2: Option<String>,
    pub color: Option<String>,
    pub unit_cost_minor: i64,
    pub condition_grade: Option<String>,
    pub battery_health_pct: Option<i64>,
    pub accessories: Option<String>,
    pub intake_note: Option<String>,
    pub seller_name: Option<String>,
    pub seller_phone: Option<String>,
    pub seller_national_id: Option<String>,
    pub created_at: i64,
}

/// Receive stock at a known unit cost.
///
/// `Routine`: receiving a delivery is ordinary work (`ADR-015`).
///
/// `supplier_name` is the operator's own label for who delivered it (D1). It is
/// optional and blank means none: an empty supplier is refused by the domain
/// rather than stored, so the shop's supplier list never grows a blank entry.
#[tauri::command]
pub async fn receive_stock(
    ctx: Ctx<'_>,
    product_id: String,
    quantity: i64,
    unit_cost_minor: i64,
    supplier_name: Option<String>,
    imeis: Option<Vec<String>>,
) -> Result<StockOutcomeDto, InventoryCommandError> {
    let supplier = SupplierName::parse_optional(supplier_name.as_deref().unwrap_or(""))
        .map_err(|error| InventoryCommandError { code: error.code() })?;
    let imeis = imeis.unwrap_or_default();
    let outcome = use_cases::receive_with_units(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &product_id,
        quantity,
        unit_cost_minor,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        supplier,
        &imeis,
    )
    .await?;

    Ok(StockOutcomeDto {
        product_id,
        quantity: outcome.quantity,
        cost_minor: outcome.cost_minor,
    })
}

/// Receive first-time opening stock already on the shelf (`ADR-016` #30, `ADR-019`).
///
/// `Sensitive`: spends one owner PIN approval inside the transaction, and
/// takes no supplier name because opening stock is not a supplier purchase.
#[tauri::command]
pub async fn receive_opening_stock(
    ctx: Ctx<'_>,
    product_id: String,
    quantity: i64,
    unit_cost_minor: i64,
    imeis: Option<Vec<String>>,
) -> Result<StockOutcomeDto, InventoryCommandError> {
    let imeis = imeis.unwrap_or_default();
    let outcome = use_cases::receive_with_units(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &product_id,
        quantity,
        unit_cost_minor,
        ReceiptKind::Opening,
        Sensitivity::Sensitive,
        None,
        &imeis,
    )
    .await?;

    Ok(StockOutcomeDto {
        product_id,
        quantity: outcome.quantity,
        cost_minor: outcome.cost_minor,
    })
}

/// List registered `in_stock` device units for a product (`ADR-019`).
#[tauri::command]
pub async fn list_product_units(
    ctx: Ctx<'_>,
    product_id: String,
) -> Result<Vec<ProductUnitDto>, InventoryCommandError> {
    let units = use_cases::list_units_in_stock(&ctx.pool, ctx.tokens.as_ref(), &product_id).await?;
    Ok(units
        .into_iter()
        .map(|u| ProductUnitDto {
            id: u.id,
            product_id: u.product_id,
            imei: u.imei,
            imei2: u.imei2,
            color: u.color,
            unit_cost_minor: u.unit_cost_minor,
            condition_grade: u.condition_grade,
            battery_health_pct: u.battery_health_pct,
            accessories: u.accessories,
            intake_note: u.intake_note,
            seller_name: u.seller_name,
            seller_phone: u.seller_phone,
            seller_national_id: u.seller_national_id,
            created_at: u.created_at,
        })
        .collect())
}

/// Remove stock, reporting what the units cost at the moving average.
#[tauri::command]
pub async fn remove_stock(
    ctx: Ctx<'_>,
    product_id: String,
    quantity: i64,
    reason: Option<String>,
) -> Result<StockOutcomeDto, InventoryCommandError> {
    let outcome = use_cases::remove_with_reason(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &product_id,
        quantity,
        reason.as_deref(),
    )
    .await?;

    Ok(StockOutcomeDto {
        product_id,
        quantity: outcome.quantity,
        cost_minor: outcome.cost_minor,
    })
}

/// Read a product's position. No mutation.
#[tauri::command]
pub async fn get_position(
    ctx: Ctx<'_>,
    product_id: String,
) -> Result<StockPositionDto, InventoryCommandError> {
    let view = use_cases::position(&ctx.pool, ctx.tokens.as_ref(), &product_id).await?;

    Ok(StockPositionDto {
        product_id,
        quantity: view.quantity,
        total_cost_minor: view.total_cost_minor,
        // Zero for a product never stocked; the stored total otherwise.
        effective_cost_minor: view.effective_cost_minor().map_err(InventoryCommandError::from)?,
    })
}

/// List all registered `in_stock` device units across all active products (`ADR-034`, Plan item 2.4).
#[tauri::command]
pub async fn list_all_product_units(
    ctx: Ctx<'_>,
) -> Result<Vec<ProductUnitDto>, InventoryCommandError> {
    let units = use_cases::list_all_units_in_stock(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(units
        .into_iter()
        .map(|u| ProductUnitDto {
            id: u.id,
            product_id: u.product_id,
            imei: u.imei,
            imei2: u.imei2,
            color: u.color,
            unit_cost_minor: u.unit_cost_minor,
            condition_grade: u.condition_grade,
            battery_health_pct: u.battery_health_pct,
            accessories: u.accessories,
            intake_note: u.intake_note,
            seller_name: u.seller_name,
            seller_phone: u.seller_phone,
            seller_national_id: u.seller_national_id,
            created_at: u.created_at,
        })
        .collect())
}

/// One product's physical count input during a Stock Count reconciliation (`ADR-034`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockCountItemInputDto {
    pub product_id: String,
    pub counted_quantity: i64,
    pub missing_unit_ids: Option<Vec<String>>,
    pub unit_cost_minor: Option<i64>,
}

/// What a Stock Count reconciliation changed (`ADR-034`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockCountReconcileOutcomeDto {
    pub adjusted_products: usize,
    pub retired_units: usize,
    pub net_quantity_delta: i64,
    pub net_cost_delta_minor: i64,
}

/// Reconcile physical stock count discrepancies and missing IMEI units (`ADR-034`, Plan item 2.4).
///
/// `Sensitive`: requires `Permission::ManageInventory` and spends one Owner PIN approval.
#[tauri::command]
pub async fn reconcile_stock_count(
    ctx: Ctx<'_>,
    reason: String,
    items: Vec<StockCountItemInputDto>,
) -> Result<StockCountReconcileOutcomeDto, InventoryCommandError> {
    let inputs: Vec<use_cases::StockCountItemInput> = items
        .into_iter()
        .map(|item| use_cases::StockCountItemInput {
            product_id: item.product_id,
            counted_quantity: item.counted_quantity,
            missing_unit_ids: item.missing_unit_ids.unwrap_or_default(),
            unit_cost_minor: item.unit_cost_minor,
        })
        .collect();
    let outcome =
        use_cases::reconcile_stock_count(&ctx.pool, ctx.tokens.as_ref(), &reason, &inputs).await?;
    Ok(StockCountReconcileOutcomeDto {
        adjusted_products: outcome.adjusted_products,
        retired_units: outcome.retired_units,
        net_quantity_delta: outcome.net_quantity_delta,
        net_cost_delta_minor: outcome.net_cost_delta_minor,
    })
}


/// Give a device its real IMEI after it was registered without one.
///
/// The stand-in number a used handset gets («بدون IMEI») is a placeholder the
/// shop owns, so replacing it with the number on the box is an inventory fix —
/// and only while the piece is still in stock.
#[tauri::command]
pub async fn set_unit_imei(
    ctx: Ctx<'_>,
    unit_id: String,
    imei: String,
) -> Result<String, InventoryCommandError> {
    Ok(imei_use_cases::set_imei(&ctx.pool, ctx.tokens.as_ref(), &unit_id, &imei).await?)
}

/// What the stock is worth at cost, in one answer (`value`, owner 2026-11-02).
#[tauri::command]
pub async fn stock_value(ctx: Ctx<'_>) -> Result<StockValueDto, InventoryCommandError> {
    let view = use_cases::stock_value(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(StockValueDto {
        value_minor: view.value_minor,
        quantity: view.quantity,
        products: view.products,
    })
}

/// One line of a delivery, as the receiving screen sends it (`0035`).
///
/// A line names an existing product (`productId`) OR describes the new one it is
/// receiving for the first time. Both are the same transaction on the Rust side,
/// which is the whole point: the shopkeeper thinks «وصلت ٥ من الموديل ده», not
/// «أنشئ منتج ثم استلم».
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiveLineInputDto {
    pub product_id: Option<String>,
    pub new_item: Option<NewItemInputDto>,
    pub new_phone: Option<NewPhoneInputDto>,
    pub quantity: i64,
    pub unit_cost_minor: i64,
    pub imeis: Option<Vec<String>>,
}

/// A counted product (accessory or part) created by the delivery itself.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewItemInputDto {
    pub name: String,
    pub category_id: Option<String>,
    /// `None` means «no price yet», which is not the same as zero.
    pub sale_price_minor: Option<i64>,
}

/// A phone model created by the delivery itself.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPhoneInputDto {
    pub category_id: String,
    pub brand_id: String,
    pub model: String,
    pub device_type: String,
    pub storage_gb: Option<i64>,
    pub ram_gb: Option<i64>,
    pub sale_price_minor: Option<i64>,
}

/// What a saved delivery wrote back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedDocumentDto {
    pub document_id: String,
    pub total_quantity: i64,
    pub lines: Vec<ReceivedLineDto>,
}

/// One saved line: which product it landed on, and the balance afterwards.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedLineDto {
    pub product_id: String,
    pub quantity: i64,
}

/// Save a whole delivery in ONE transaction (`0035`).
///
/// `receiptKind` is `supplier` (a purchase, `Routine`) or `opening` (stock already
/// on the shelf, `Sensitive` — one owner PIN for the whole document). Every line
/// commits or none does, so a carton of five items cannot land as three.
///
/// The supplier invoice reference, the purchase day and the note are the
/// operator's own labels on the paper that came with the goods. All optional.
#[tauri::command]
pub async fn receive_document(
    ctx: Ctx<'_>,
    receipt_kind: String,
    supplier_name: Option<String>,
    document_ref: Option<String>,
    purchase_date: Option<String>,
    note: Option<String>,
    lines: Vec<ReceiveLineInputDto>,
) -> Result<ReceivedDocumentDto, InventoryCommandError> {
    let kind = ReceiptKind::parse(&receipt_kind)
        .map_err(|error| InventoryCommandError { code: error.code() })?;
    let supplier = SupplierName::parse_optional(supplier_name.as_deref().unwrap_or(""))
        .map_err(|error| InventoryCommandError { code: error.code() })?;
    let paperwork = ReceiptPaperwork {
        document_id: None,
        document_ref,
        purchase_date,
        note,
    };
    let mapped: Vec<DocumentLine> = lines
        .into_iter()
        .map(|line| DocumentLine {
            product_id: line.product_id,
            new_item: line.new_item.map(|item| NewCountedProduct {
                name: item.name,
                category_id: item.category_id,
                sale_price_minor: item.sale_price_minor,
            }),
            new_phone: line.new_phone.map(|phone| NewPhoneProduct {
                category_id: phone.category_id,
                brand_id: phone.brand_id,
                model: phone.model,
                device_type: phone.device_type,
                storage_gb: phone.storage_gb,
                ram_gb: phone.ram_gb,
                sale_price_minor: phone.sale_price_minor,
            }),
            quantity: line.quantity,
            unit_cost_minor: line.unit_cost_minor,
            imeis: line.imeis.unwrap_or_default(),
        })
        .collect();

    let saved = use_cases::receive_document(
        &ctx.pool,
        ctx.tokens.as_ref(),
        kind,
        supplier,
        &paperwork,
        &mapped,
    )
    .await?;

    Ok(ReceivedDocumentDto {
        document_id: saved.document_id,
        total_quantity: saved.total_quantity(),
        lines: saved
            .lines
            .into_iter()
            .map(|(product_id, outcome)| ReceivedLineDto {
                product_id,
                quantity: outcome.quantity,
            })
            .collect(),
    })
}

/// Give a piece already in stock its real IMEI (`0035`).
///
/// Changes no balance and no cost: the piece was counted, only its identity is
/// new. Refused when every piece on the shelf already carries a serial.
#[tauri::command]
pub async fn register_stock_unit(
    ctx: Ctx<'_>,
    product_id: String,
    imei: String,
    color: Option<String>,
) -> Result<ProductUnitDto, InventoryCommandError> {
    let unit = use_cases::register_stock_unit(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &product_id,
        &imei,
        color.as_deref(),
    )
    .await?;
    Ok(ProductUnitDto {
        id: unit.id,
        product_id: unit.product_id,
        imei: unit.imei,
        imei2: unit.imei2,
        color: unit.color,
        unit_cost_minor: unit.unit_cost_minor,
        condition_grade: unit.condition_grade,
        battery_health_pct: unit.battery_health_pct,
        accessories: unit.accessories,
        intake_note: unit.intake_note,
        seller_name: unit.seller_name,
        seller_phone: unit.seller_phone,
        seller_national_id: unit.seller_national_id,
        created_at: unit.created_at,
    })
}

/// The receiving log, newest first — what came in, from whom, and at what cost.
#[tauri::command]
pub async fn list_receipts(
    ctx: Ctx<'_>,
    limit: Option<i64>,
    product_id: Option<String>,
) -> Result<Vec<ReceiptRowDto>, InventoryCommandError> {
    let rows = use_cases::list_receipts(
        &ctx.pool,
        ctx.tokens.as_ref(),
        limit.unwrap_or(100),
        product_id.as_deref(),
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ReceiptRowDto {
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
        .collect())
}
