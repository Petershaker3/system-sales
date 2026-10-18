//! Registering a new phone (ADR-018 §2; «موبايل جديد» in the mockup): its
//! company, model, touch or keypad, storage and RAM, its category and its sale
//! price. The name is built from them — «Samsung Galaxy A16 128GB», «iPhone 16
//! 128GB» — and the same phone twice is refused.
//!
//! The product is counted by quantity: the IMEI is optional (PLAN §7), and the
//! units table that records one device at a time comes with plan item 1.4. Its
//! stock and cost come from receiving, as for any product.

use sqlx::SqlitePool;

use crate::data::repositories::catalog::brand as brand_repo;
use crate::data::repositories::catalog::product as product_repo;
use crate::data::repositories::identity::audit;
use crate::data::repositories::inventory::stock as stock_repo;
use crate::data::repositories::inventory::unit::{self as unit_repo, ImeiRepairMatch, UnitRecord};
use crate::data::repositories::organisation::department as category_repo;
use crate::data::repositories::sales::{self as sales_repo, MovementRecord};
use crate::data::repositories::settings::app_settings as settings_repo;
use crate::data::repositories::shift as shift_repo;
use crate::data::repositories::shortage as shortage_repo;
use crate::domain::catalog::{
    brand_lines, phone_title, BrandError, BrandId, CatalogError, DeviceType, Disposition,
    PhoneDetails, Product, ProductId, ProductName, ProductStatus, SalePrice,
};
use crate::domain::costing::moving_average::AveragePosition;
use crate::domain::costing::CostError;
use crate::domain::identity::{DomainError, Permission, Sensitivity, Timestamp};
use crate::domain::organisation::{CategoryKind, DepartmentId};
use crate::domain::shift::{
    CashMovementId, CashMovementKind, CashMovementReason, CashMovementRecord, Piastres,
};
use crate::domain::unit::{
    luhn_imei_valid, used_phone_title, validate_battery_health_pct, validate_national_id,
    validate_optional_bounded, ConditionGrade, Imei, ReceiptKind, TrackingMode, UnitError,
    MAX_ACCESSORIES_CHARS, MAX_INTAKE_NOTE_CHARS, MAX_SELLER_NAME_CHARS, MAX_SELLER_PHONE_CHARS,
};
use crate::services::catalog::brands::{authorize, storage, BrandServiceError};
use crate::services::identity::approval as approval_service;
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// A new phone, as «موبايل جديد» sends it.
#[derive(Debug, Clone)]
pub struct NewPhone {
    /// A category registered «جهاز جهاز بالـ IMEI» (or one under such a main).
    pub category: DepartmentId,
    pub brand: BrandId,
    pub model: String,
    pub device_type: DeviceType,
    pub storage_gb: Option<i64>,
    pub ram_gb: Option<i64>,
    /// `None` leaves the price unset, as for any product.
    pub sale_price_minor: Option<i64>,
}

/// The registered phone: the product, and what it was built from.
#[derive(Debug, Clone)]
pub struct RegisteredPhone {
    pub product: Product,
    pub details: PhoneDetails,
}

/// Register a phone in one transaction: the product row and its details, or
/// neither.
pub async fn create_phone(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: NewPhone,
) -> Result<RegisteredPhone, BrandServiceError> {
    let session = authorize(pool, tokens).await?;
    let now = Timestamp::now().as_millis();
    let actor = session.user_id();
    let sale_price = match input.sale_price_minor {
        Some(minor) => Some(SalePrice::new_minor(minor)?),
        None => None,
    };

    let mut tx = pool.begin().await.map_err(storage)?;

    let category = category_repo::find_by_id(&mut tx, input.category)
        .await
        .map_err(storage)?
        .filter(|category| category.is_editable())
        .ok_or(CatalogError::CategoryNotFound)?;
    if category.kind != CategoryKind::Phone {
        return Err(BrandError::CategoryNotPhone.into());
    }

    let brand = brand_repo::find_by_id(&mut tx, input.brand)
        .await
        .map_err(storage)?
        .ok_or(BrandError::NotFound)?;
    if !brand.device_type.allows(input.device_type) {
        return Err(BrandError::TypeMismatch.into());
    }

    let details = PhoneDetails::new(
        brand.id,
        &input.model,
        input.device_type,
        input.storage_gb,
        input.ram_gb,
    )?;
    if brand_repo::find_phone(&mut tx, &details)
        .await
        .map_err(storage)?
        .is_some()
    {
        return Err(BrandError::AlreadyRegistered.into());
    }

    let title = phone_title(
        brand.name.as_str(),
        brand_lines(brand.id),
        &details.model,
        details.storage_gb,
    );
    let product = Product {
        id: ProductId::generate(),
        name: ProductName::new(&title)?,
        disposition: Disposition::Quantity,
        barcode: None,
        sale_price,
        department: Some(category.id),
        default_cost: None,
        vat_rate_bp: None,
        status: ProductStatus::Active,
        created_by: actor,
        updated_by: actor,
        created_at: now,
        updated_at: now,
    };
    product_repo::insert(&mut tx, &product)
        .await
        .map_err(storage)?;
    brand_repo::set_phone_details(&mut tx, product.id, &details)
        .await
        .map_err(storage)?;
    tx.commit().await.map_err(storage)?;
    Ok(RegisteredPhone { product, details })
}

/// Input for registering a used phone unit into stock (`ADR-032`, `PLAN.md` §13).
#[derive(Debug, Clone)]
pub struct NewUsedPhone {
    pub category: DepartmentId,
    pub brand: BrandId,
    pub model: String,
    pub device_type: DeviceType,
    pub storage_gb: Option<i64>,
    pub ram_gb: Option<i64>,
    pub color: Option<String>,
    pub imei: String,
    pub imei2: Option<String>,
    pub condition_grade: String,
    pub battery_health_pct: Option<i64>,
    pub accessories: Option<String>,
    pub intake_note: Option<String>,
    pub cost_minor: i64,
    pub sale_price_minor: i64,
    pub seller_name: Option<String>,
    pub seller_phone: Option<String>,
    pub seller_national_id: Option<String>,
    pub is_opening_stock: bool,
    pub payout_from_drawer: bool,
}

/// Result of registering a used phone (`ADR-032`).
#[derive(Debug, Clone)]
pub struct RegisteredUsedPhone {
    pub product: Product,
    pub details: PhoneDetails,
    pub unit_id: String,
    pub imei: String,
    pub imei2: Option<String>,
    pub condition_grade: String,
    pub battery_health_pct: Option<i64>,
    pub cost_minor: i64,
    pub sale_price_minor: i64,
    pub on_hand: i64,
}

/// Register a used phone unit in one atomic transaction (`ADR-032`):
/// 1. Validates grade (`A`/`B`/`C`), battery (`1..=100`), primary & optional
///    secondary IMEI (15 digits + Luhn + unique in shop), and seller info.
/// 2. Finds or creates the used-phone product under `category` (`موبايلات مستعملة`)
///    with title `<Brand> <Model> <Storage> مستعمل فئة <A/B/C>`.
/// 3. Increments `stock_levels`, records a `stock_movements` receipt (`supplier`
///    or `opening`), and inserts the `units` row with its actual purchase cost
///    and inspection details.
/// 4. When `payout_from_drawer` is true (customer purchase or trade-in) and a
///    shift is open, records a drawer cash-out movement (`owner_draw`) so
///    expected drawer cash reflects the net cash remaining in the drawer.
pub async fn create_used_phone(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: NewUsedPhone,
) -> Result<RegisteredUsedPhone, BrandServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    let now = Timestamp::now();
    let now_ms = now.as_millis();
    let actor = session.user_id();

    let approval = if input.is_opening_stock {
        session.authorize(Permission::ManageInventory)?;
        session.require_sensitivity(Sensitivity::Sensitive, now)?
    } else {
        if !session.has_permission(Permission::ManageCatalog)
            && !session.has_permission(Permission::ManageInventory)
            && !session.has_permission(Permission::Sell)
        {
            return Err(DomainError::Forbidden.into());
        }
        None
    };

    let grade = ConditionGrade::parse(&input.condition_grade)?;
    let battery_health_pct = validate_battery_health_pct(input.battery_health_pct)?;
    let imei = Imei::parse(&input.imei)?;
    let imei2 = match input
        .imei2
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw) => {
            let parsed = Imei::parse(raw)?;
            if parsed.as_str() == imei.as_str() {
                return Err(UnitError::ImeiSecondaryMatchesPrimary.into());
            }
            Some(parsed)
        }
        None => None,
    };
    let color = validate_optional_bounded(input.color.as_deref(), MAX_ACCESSORIES_CHARS)?;
    let accessories =
        validate_optional_bounded(input.accessories.as_deref(), MAX_ACCESSORIES_CHARS)?;
    let intake_note =
        validate_optional_bounded(input.intake_note.as_deref(), MAX_INTAKE_NOTE_CHARS)?;
    let seller_name =
        validate_optional_bounded(input.seller_name.as_deref(), MAX_SELLER_NAME_CHARS)?;
    let seller_phone =
        validate_optional_bounded(input.seller_phone.as_deref(), MAX_SELLER_PHONE_CHARS)?;
    let seller_national_id = validate_national_id(input.seller_national_id.as_deref())?;

    if input.cost_minor < 0 {
        return Err(CostError::NegativeTotal.into());
    }
    let sale_price = SalePrice::new_minor(input.sale_price_minor)?;

    let mut tx = pool.begin().await.map_err(storage)?;
    let approved_by = approval_service::consume_in_tx(&mut tx, &session, approval).await?;

    let category = category_repo::find_by_id(&mut tx, input.category)
        .await
        .map_err(storage)?
        .filter(|category| category.is_editable())
        .ok_or(CatalogError::CategoryNotFound)?;
    if category.kind != CategoryKind::Used && category.kind != CategoryKind::Phone {
        return Err(BrandError::CategoryNotPhone.into());
    }

    let brand = brand_repo::find_by_id(&mut tx, input.brand)
        .await
        .map_err(storage)?
        .ok_or(BrandError::NotFound)?;
    if !brand.device_type.allows(input.device_type) {
        return Err(BrandError::TypeMismatch.into());
    }

    let details = PhoneDetails::new(
        brand.id,
        &input.model,
        input.device_type,
        input.storage_gb,
        input.ram_gb,
    )?;

    if unit_repo::find_by_imei(&mut tx, imei.as_str())
        .await
        .map_err(storage)?
        .is_some()
    {
        return Err(UnitError::ImeiAlreadyRegistered.into());
    }
    if let Some(ref second) = imei2 {
        if unit_repo::find_by_imei(&mut tx, second.as_str())
            .await
            .map_err(storage)?
            .is_some()
        {
            return Err(UnitError::ImeiAlreadyRegistered.into());
        }
    }

    let title = used_phone_title(
        brand.name.as_str(),
        brand_lines(brand.id),
        &details.model,
        details.storage_gb,
        grade,
    );

    let product = if let Some(existing_raw_id) =
        brand_repo::find_used_phone_by_name(&mut tx, category.id.as_str(), &title)
            .await
            .map_err(storage)?
    {
        let existing_id: ProductId = existing_raw_id
            .parse()
            .map_err(|_| BrandServiceError::Identity(DomainError::StorageUnavailable))?;
        brand_repo::update_product_sale_price_minor(
            &mut tx,
            existing_id.as_str(),
            input.sale_price_minor,
            &actor.as_str(),
            now_ms,
        )
        .await
        .map_err(storage)?;
        unit_repo::set_product_tracking(&mut tx, existing_id.as_str(), TrackingMode::SerialOptional)
            .await
            .map_err(storage)?;
        product_repo::find_by_id(&mut tx, existing_id)
            .await
            .map_err(storage)?
            .ok_or(BrandServiceError::Identity(DomainError::StorageUnavailable))?
    } else {
        let p = Product {
            id: ProductId::generate(),
            name: ProductName::new(&title)?,
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price: Some(sale_price),
            department: Some(category.id),
            default_cost: None,
            vat_rate_bp: None,
            status: ProductStatus::Active,
            created_by: actor,
            updated_by: actor,
            created_at: now_ms,
            updated_at: now_ms,
        };
        product_repo::insert(&mut tx, &p).await.map_err(storage)?;
        brand_repo::set_phone_details(&mut tx, p.id, &details)
            .await
            .map_err(storage)?;
        unit_repo::set_product_tracking(&mut tx, p.id.as_str(), TrackingMode::SerialOptional)
            .await
            .map_err(storage)?;
        p
    };

    let current_pos = match stock_repo::find_position(&mut tx, product.id.as_str())
        .await
        .map_err(storage)?
    {
        Some(pos) => AveragePosition::new(pos.total_cost_minor.unwrap_or(0), pos.quantity)?,
        None => AveragePosition::EMPTY,
    };
    let updated_pos = current_pos.receive(1, input.cost_minor)?;
    stock_repo::upsert_position(
        &mut tx,
        &stock_repo::StockPosition {
            product_id: product.id.as_str().to_owned(),
            quantity: updated_pos.on_hand,
            total_cost_minor: Some(updated_pos.total_cost_minor),
        },
        &actor,
        now_ms,
    )
    .await
    .map_err(storage)?;

    let receipt_kind = if input.is_opening_stock {
        ReceiptKind::Opening
    } else {
        ReceiptKind::Supplier
    };
    let movement_id = uuid::Uuid::now_v7().to_string();
    sales_repo::insert_movement(
        &mut tx,
        &MovementRecord {
            id: movement_id.clone(),
            product_id: product.id.as_str().to_owned(),
            kind: "receipt".to_owned(),
            quantity_delta: 1,
            unit_cost_minor: input.cost_minor,
            cost_delta_minor: input.cost_minor,
            occurred_at: now_ms,
            actor_id: actor.as_str().to_owned(),
            sale_id: None,
            sale_line_id: None,
            fifo_layer_id: None,
            fifo_received_at: None,
            reverses_movement_id: None,
            supplier_name: if input.is_opening_stock {
                None
            } else {
                seller_name.clone()
            },
            receipt_kind: Some(receipt_kind.as_str().to_owned()),
        },
    )
    .await
    .map_err(storage)?;

    let unit_id = uuid::Uuid::now_v7().to_string();
    unit_repo::insert_unit(
        &mut tx,
        &UnitRecord {
            id: unit_id.clone(),
            product_id: product.id.as_str().to_owned(),
            imei: imei.as_str().to_owned(),
            imei2: imei2.as_ref().map(|v| v.as_str().to_owned()),
            color: color.clone(),
            unit_cost_minor: input.cost_minor,
            status: "in_stock".to_owned(),
            received_movement_id: Some(movement_id.clone()),
            sale_line_id: None,
            retired_reason: None,
            created_by: actor.as_str().to_owned(),
            created_at: now_ms,
            condition_grade: Some(grade.as_str().to_owned()),
            battery_health_pct,
            accessories: accessories.clone(),
            seller_name: seller_name.clone(),
            seller_phone: seller_phone.clone(),
            seller_national_id: seller_national_id.clone(),
            intake_note: intake_note.clone(),
        },
    )
    .await
    .map_err(storage)?;

    let _ = shortage_repo::resolve_shortages_for_product(&mut tx, product.id.as_str(), now_ms)
        .await
        .map_err(storage)?;

    if input.payout_from_drawer && !input.is_opening_stock && input.cost_minor > 0 {
        if let Some(open_shift) = shift_repo::find_open_shift(&mut tx).await.map_err(storage)? {
            let reason_str = format!("شراء جهاز مستعمل: {}", product.name.as_str());
            let truncated: String = reason_str.chars().take(120).collect();
            let reason = CashMovementReason::new(truncated)?;
            let amount = Piastres::new_minor(input.cost_minor)?;
            shift_repo::insert_cash_movement(
                &mut tx,
                &CashMovementRecord {
                    id: CashMovementId::generate(),
                    shift_id: open_shift.id,
                    kind: CashMovementKind::OwnerDraw,
                    amount,
                    reason,
                    created_by: actor,
                    created_at: now,
                },
            )
            .await
            .map_err(storage)?;
        }
    }

    let audit_event = if input.is_opening_stock {
        audit::event::OPENING_STOCK_RECEIVED
    } else {
        audit::event::USED_PHONE_REGISTERED
    };
    audit::append(
        &mut tx,
        actor,
        audit_event,
        now,
        Some(
            serde_json::json!({
                "product_id": product.id.as_str(),
                "unit_id": unit_id,
                "imei": imei.as_str(),
                "condition_grade": grade.as_str(),
                "cost_minor": input.cost_minor,
                "sale_price_minor": input.sale_price_minor,
                "is_opening_stock": input.is_opening_stock,
                "approved_by": approved_by.map(|u| u.as_str()),
            })
            .to_string(),
        ),
    )
    .await
    .map_err(storage)?;

    tx.commit().await.map_err(storage)?;

    Ok(RegisteredUsedPhone {
        product,
        details,
        unit_id,
        imei: imei.as_str().to_owned(),
        imei2: imei2.map(|v| v.as_str().to_owned()),
        condition_grade: grade.as_str().to_owned(),
        battery_health_pct,
        cost_minor: input.cost_minor,
        sale_price_minor: input.sale_price_minor,
        on_hand: updated_pos.on_hand,
    })
}

/// Local unit match returned by [`check_imei`] (`ADR-032`).
#[derive(Debug, Clone)]
pub struct ImeiLocalUnitMatch {
    pub unit_id: String,
    pub product_id: String,
    pub product_name: String,
    pub imei: String,
    pub imei2: Option<String>,
    pub status: String,
    pub color: Option<String>,
    pub condition_grade: Option<String>,
    pub battery_health_pct: Option<i64>,
    pub accessories: Option<String>,
    pub intake_note: Option<String>,
    pub unit_cost_minor: Option<i64>,
    pub seller_name: Option<String>,
    pub seller_phone: Option<String>,
    pub seller_national_id: Option<String>,
    pub created_at: i64,
}

/// Complete IMEI inspection report (`ADR-032`, `PLAN.md` §13).
#[derive(Debug, Clone)]
pub struct ImeiCheckResult {
    pub normalized: String,
    pub digit_count: usize,
    pub format_valid: bool,
    pub luhn_valid: bool,
    pub tac: Option<String>,
    pub local_unit: Option<ImeiLocalUnitMatch>,
    pub repairs: Vec<ImeiRepairMatch>,
}

/// Inspect an IMEI: strips formatting, validates length (15 digits) and Luhn
/// check digit, extracts the 8-digit TAC, and searches local `units` and
/// `repairs` history (`ADR-032`).
pub async fn check_imei(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    raw_imei: &str,
) -> Result<ImeiCheckResult, BrandServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    let mut conn = pool.acquire().await.map_err(storage)?;
    let appearance = settings_repo::load_appearance(&mut conn)
        .await
        .map_err(storage)?;
    let can_view_cost =
        session.has_permission(Permission::ViewCostAndProfit) || appearance.seller_can_view_cost;

    let normalized: String = raw_imei
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    let digits_only = !normalized.is_empty() && normalized.chars().all(|c| c.is_ascii_digit());
    let digit_count = normalized.chars().count();
    let format_valid = digits_only && digit_count == 15;
    let luhn_valid = format_valid && luhn_imei_valid(&normalized);
    let tac = if digits_only && digit_count >= 8 {
        Some(normalized.chars().take(8).collect())
    } else {
        None
    };

    let local_unit = if !normalized.is_empty() {
        unit_repo::find_unit_with_product_by_imei(&mut conn, &normalized)
            .await
            .map_err(storage)?
            .map(|(u, product_name)| ImeiLocalUnitMatch {
                unit_id: u.id,
                product_id: u.product_id,
                product_name,
                imei: u.imei,
                imei2: u.imei2,
                status: u.status,
                color: u.color,
                condition_grade: u.condition_grade,
                battery_health_pct: u.battery_health_pct,
                accessories: u.accessories,
                intake_note: u.intake_note,
                unit_cost_minor: if can_view_cost {
                    Some(u.unit_cost_minor)
                } else {
                    None
                },
                seller_name: if can_view_cost { u.seller_name } else { None },
                seller_phone: if can_view_cost { u.seller_phone } else { None },
                seller_national_id: if can_view_cost {
                    u.seller_national_id
                } else {
                    None
                },
                created_at: u.created_at,
            })
    } else {
        None
    };

    let repairs = if !normalized.is_empty() {
        unit_repo::list_repairs_by_imei(&mut conn, &normalized)
            .await
            .map_err(storage)?
    } else {
        Vec::new()
    };

    Ok(ImeiCheckResult {
        normalized,
        digit_count,
        format_valid,
        luhn_valid,
        tac,
        local_unit,
        repairs,
    })
}

