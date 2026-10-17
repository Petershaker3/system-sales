//! Product catalogue use cases.
//!
//! # Attribution
//!
//! `created_by` and `updated_by` are taken from the resolved [`Session`] and can
//! never be supplied by a caller. `spec:177` requires every operation to be
//! attributed to the executing user, and `plan:143` requires the audit columns.
//! Passing an actor in as a parameter would make attribution a claim rather
//! than a fact.
//!
//! # Authorization
//!
//! Every use case requires `Permission::ManageCatalog`, which the identity slice
//! already defines and gates by role. A sales user is refused before any query
//! runs.

use sqlx::SqliteConnection;

use crate::data::repositories::catalog::product as repo;
use crate::data::repositories::organisation::department as category_repo;
use crate::domain::catalog::{
    next_shop_code as next_code, next_shop_codes as next_codes, Barcode, CatalogError, Disposition,
    Product, ProductId, ProductName, ProductStatus, SalePrice, MAX_VARIANTS,
};

use crate::domain::identity::{Permission, Session, Timestamp};
use crate::domain::organisation::DepartmentId;
use crate::services::catalog::CatalogContext;

/// What a caller supplies when creating a product.
///
/// `sale_price` is optional: a product may be catalogued before its price is
/// known. `None` means not set and is **not** the same as zero.
pub struct NewProduct {
    pub name: String,
    pub disposition: Disposition,
    pub barcode: Option<String>,
    pub sale_price_minor: Option<i64>,
    /// The category it goes in (ADR-018 §1), or `None` to leave it unclassified.
    pub category: Option<DepartmentId>,
}

/// Fields an edit may change. Absent optional fields mean "leave unchanged",
/// which is why this is a patch and not a replacement.
#[derive(Default)]
pub struct ProductPatch {
    pub name: Option<String>,
    pub disposition: Option<Disposition>,
    /// `Some(None)` clears the barcode; `None` leaves it alone.
    pub barcode: Option<Option<String>>,
    /// `Some(None)` clears the price back to "not set".
    pub sale_price_minor: Option<Option<i64>>,
    /// `Some(None)` takes the product out of its category; `None` leaves it.
    pub category: Option<Option<DepartmentId>>,
}

/// Refuse a session whose role may not manage the catalogue.
///
/// A denial is reported as a denial. Folding it into "not found" would hide a
/// permission problem behind a missing-record problem and send an operator
/// looking in the wrong place.
fn authorize(session: &Session) -> Result<(), CatalogError> {
    session
        .authorize(Permission::ManageCatalog)
        .map_err(|_| CatalogError::PermissionDenied)
}

fn build_barcode(value: &Option<String>) -> Result<Option<Barcode>, CatalogError> {
    match value {
        Some(raw) => Ok(Some(Barcode::new(raw)?)),
        None => Ok(None),
    }
}

/// A category a product may be put in: one that exists and is live. An archived
/// department is not offered anywhere any more, so naming one is a stale screen.
async fn live_category(
    conn: &mut SqliteConnection,
    id: Option<DepartmentId>,
) -> Result<Option<DepartmentId>, CatalogError> {
    let Some(id) = id else {
        return Ok(None);
    };
    match category_repo::find_by_id(conn, id).await {
        Ok(Some(category)) if category.is_editable() => Ok(Some(id)),
        Ok(_) => Err(CatalogError::CategoryNotFound),
        Err(_) => Err(CatalogError::NoProductWithThisId),
    }
}

fn build_price(value: &Option<i64>) -> Result<Option<SalePrice>, CatalogError> {
    match value {
        Some(minor) => Ok(Some(SalePrice::new_minor(*minor)?)),
        None => Ok(None),
    }
}

pub async fn create(
    ctx: &CatalogContext,
    session: &Session,
    input: NewProduct,
) -> Result<Product, CatalogError> {
    authorize(session)?;

    let name = ProductName::new(&input.name)?;
    let barcode = build_barcode(&input.barcode)?;
    let sale_price = build_price(&input.sale_price_minor)?;

    let now = Timestamp::now().as_millis();
    let actor = session.user_id();
    let product = Product {
        id: ProductId::generate(),
        name,
        disposition: input.disposition,
        barcode,
        sale_price,
        // Classified only when the operator chose a category (checked below).
        // Nothing invents a cost or a VAT rate for it: manufacturing them here
        // would be fabricating business data.
        department: None,
        default_cost: None,
        vat_rate_bp: None,
        status: ProductStatus::Active,
        created_by: actor,
        updated_by: actor,
        created_at: now,
        updated_at: now,
    };

    let mut conn = ctx.pool.acquire().await.map_err(|_| CatalogError::NoProductWithThisId)?;
    let mut product = product;
    product.department = live_category(&mut conn, input.category).await?;

    // A duplicate barcode surfaces as a UNIQUE violation. It is translated here
    // so the caller learns "barcode already in use" rather than a driver string.
    match repo::insert(&mut conn, &product).await {
        Ok(()) => Ok(product),
        Err(sqlx::Error::Database(ref e)) if is_unique_violation(&e.to_string()) => {
            Err(CatalogError::BarcodeAlreadyExists)
        }
        Err(_) => Err(CatalogError::NoProductWithThisId),
    }
}

/// SQLite reports a UNIQUE constraint failure with this code.
fn is_unique_violation(message: &str) -> bool {
    message.contains("UNIQUE constraint failed") || message.contains("constraint failed: UNIQUE")
}

pub async fn get(
    ctx: &CatalogContext,
    session: &Session,
    id: ProductId,
) -> Result<Product, CatalogError> {
    authorize(session)?;
    let mut conn = ctx.pool.acquire().await.map_err(|_| CatalogError::NoProductWithThisId)?;
    repo::find_by_id(&mut conn, id)
        .await
        .map_err(|_| CatalogError::NoProductWithThisId)?
        .ok_or(CatalogError::NoProductWithThisId)
}

pub async fn list(
    ctx: &CatalogContext,
    session: &Session,
    status: ProductStatus,
) -> Result<Vec<Product>, CatalogError> {
    authorize(session)?;
    let mut conn = ctx.pool.acquire().await.map_err(|_| CatalogError::NoProductWithThisId)?;
    repo::list(&mut conn, status)
        .await
        .map_err(|_| CatalogError::NoProductWithThisId)
}

/// The next free shop code for «اعمل كود للمحل» (`ADR-018` §3, `PLAN` §6).
///
/// This reserves nothing: two screens asking at the same moment are told the
/// same code. The product insert is what makes it true, and the `barcode`
/// column's UNIQUE index refuses the second one — the operator is told the
/// barcode is in use and asks again.
pub async fn next_shop_code(
    ctx: &CatalogContext,
    session: &Session,
) -> Result<String, CatalogError> {
    authorize(session)?;
    let mut conn = ctx.pool.acquire().await.map_err(|_| CatalogError::NoProductWithThisId)?;
    let codes = repo::internal_codes(&mut conn)
        .await
        .map_err(|_| CatalogError::NoProductWithThisId)?;
    next_code(codes.iter().map(String::as_str))
        .map_err(|_| CatalogError::ShopCodeExhausted)
}

/// The next `count` internal shop codes (up to [`MAX_VARIANTS`]), advancing
/// past both the database's internal codes and any `reserved` codes already
/// typed into the variant table.
pub async fn next_shop_codes(
    ctx: &CatalogContext,
    session: &Session,
    count: usize,
    reserved: &[String],
) -> Result<Vec<String>, CatalogError> {
    authorize(session)?;
    let bounded = count.min(MAX_VARIANTS);
    let mut conn = ctx.pool.acquire().await.map_err(|_| CatalogError::NoProductWithThisId)?;
    let codes = repo::internal_codes(&mut conn)
        .await
        .map_err(|_| CatalogError::NoProductWithThisId)?;
    let combined = codes
        .iter()
        .map(String::as_str)
        .chain(reserved.iter().map(String::as_str));
    next_codes(combined, bounded).map_err(|_| CatalogError::ShopCodeExhausted)
}


pub async fn update(
    ctx: &CatalogContext,
    session: &Session,
    id: ProductId,
    patch: ProductPatch,
) -> Result<Product, CatalogError> {
    authorize(session)?;

    // The catalogue's first transaction (`plan` Task 10): the row edit and its
    // price history commit together or not at all — history written outside
    // the edit's transaction would outlive a failed edit and lie. Opened on
    // the pool rather than on an acquired connection: holding a pooled
    // connection while asking for a second one deadlocks a single-connection
    // pool, which is how the in-memory test database is set up (same as
    // identity).
    let mut tx = ctx
        .pool
        .begin()
        .await
        .map_err(|_| CatalogError::NoProductWithThisId)?;

    let mut product = repo::find_by_id(&mut tx, id)
        .await
        .map_err(|_| CatalogError::NoProductWithThisId)?
        .ok_or(CatalogError::NoProductWithThisId)?;

    // The archived refusal is the domain's, not this layer's.
    if !product.is_editable() {
        return Err(CatalogError::ProductArchived);
    }

    // Captured before the patch: this is the "old" side of any transition.
    let old_price = product.sale_price.map(|price| price.as_minor());
    let now = Timestamp::now();

    if let Some(name) = patch.name {
        product.name = ProductName::new(&name)?;
    }
    if let Some(disposition) = patch.disposition {
        product.disposition = disposition;
    }
    if let Some(barcode) = patch.barcode {
        product.barcode = build_barcode(&barcode)?;
    }
    if let Some(price) = patch.sale_price_minor {
        product.sale_price = build_price(&price)?;
    }
    if let Some(category) = patch.category {
        product.department = live_category(&mut tx, category).await?;
    }

    product.updated_by = session.user_id();
    product.updated_at = now.as_millis();

    if let Err(error) = repo::update(&mut tx, &product).await {
        // Dropping `tx` rolls back, so the earlier reads leave nothing behind.
        return Err(match error {
            sqlx::Error::Database(ref e) if is_unique_violation(&e.to_string()) => {
                CatalogError::BarcodeAlreadyExists
            }
            _ => CatalogError::NoProductWithThisId,
        });
    }

    // History only when the price moved: an edit that left the price alone has
    // no transition to record, and the schema's CHECK would refuse the pair
    // anyway.
    let new_price = product.sale_price.map(|price| price.as_minor());
    if old_price != new_price {
        repo::insert_price_history(
            &mut tx,
            product.id,
            old_price,
            new_price,
            session.user_id(),
            now,
        )
        .await
        .map_err(|_| CatalogError::NoProductWithThisId)?;
    }

    tx.commit()
        .await
        .map_err(|_| CatalogError::NoProductWithThisId)?;
    Ok(product)
}

pub async fn set_status(
    ctx: &CatalogContext,
    session: &Session,
    id: ProductId,
    status: ProductStatus,
) -> Result<Product, CatalogError> {
    authorize(session)?;
    let mut conn = ctx.pool.acquire().await.map_err(|_| CatalogError::NoProductWithThisId)?;

    let mut product = repo::find_by_id(&mut conn, id)
        .await
        .map_err(|_| CatalogError::NoProductWithThisId)?
        .ok_or(CatalogError::NoProductWithThisId)?;

    product.set_status(status, session.user_id(), Timestamp::now().as_millis());

    repo::update(&mut conn, &product)
        .await
        .map_err(|_| CatalogError::NoProductWithThisId)?;
    Ok(product)
}

/// Typed or pasted barcode lookup (D4).
///
/// Deliberately independent of any scanner. Scanning is BLOCKED (`ADR-008`); a
/// value the operator types or pastes needs no camera and no decoder, so this
/// does not reopen that decision.
pub async fn find_by_barcode(
    ctx: &CatalogContext,
    session: &Session,
    value: &str,
) -> Result<Product, CatalogError> {
    authorize(session)?;
    let needle = Barcode::new(value)?;
    let mut conn = ctx.pool.acquire().await.map_err(|_| CatalogError::NoProductWithThisId)?;
    repo::find_by_barcode(&mut conn, &needle)
        .await
        .map_err(|_| CatalogError::NoProductWithThisId)?
        .ok_or(CatalogError::NoProductWithThisId)
}
