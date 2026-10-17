//! The product aggregate.
//!
//! # `NULL` and `0` are different facts
//!
//! A product may enter the catalogue before its selling price is known. That is
//! not the same as the item being free, so the price is optional and the domain
//! keeps the two apart: `None` is "not set", `Some(SalePrice(0))` is "free".
//! Collapsing them would assert something false about the shop's pricing.
//!
//! # `disposition` is currently unenforced
//!
//! Recording it now (decision D1) means no product ever has to be reclassified
//! later. It now names three classes — `quantity`, `serialized` and `one_off`
//! (`spec:175`) — but nothing validates it against stock yet, because no
//! `stock_movements` and no `serialized_units` table exists. It states intent, and
//! this comment exists so no later reader assumes the tracking is implemented.

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::identity::UserId;
use crate::domain::money::Piastres;
use crate::domain::organisation::DepartmentId;

/// Stable product identifier. UUID v7, per ADR-009.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProductId(Uuid);

impl ProductId {
    pub fn generate() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }

    pub fn as_str(&self) -> String {
        self.0.to_string()
    }
}

impl fmt::Display for ProductId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

/// How the shop tracks this item (D2).
///
/// Recorded, not yet enforced by any stock logic. See the module documentation.
/// `serde` is `snake_case` so the serialised name and the stored name are the same
/// string: `camelCase` would make `OneOff` serialise as `oneOff` while `as_str`
/// returns `one_off`, and a mismatch between the wire value and the stored value is
/// a bug waiting for a DTO. The rename is a no-op for the other two variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    /// Tracked by quantity. Needs an opening balance before the first sale
    /// (`spec:175`).
    Quantity,
    /// Tracked per piece by IMEI or serial (`plan:171`).
    Serialized,
    /// Sold once as an individual occurrence, keeping **no stock balance**
    /// (`spec:175`: a one-off "is recorded as a sale event without a stock
    /// balance").
    ///
    /// A distinct third class, not a synonym for `Quantity`: a quantity-tracked
    /// product has a balance that must be opened before its first sale, and this
    /// one has no balance to open. Collapsing the two would either require a
    /// fabricated opening balance or lose the distinction the specification draws.
    OneOff,
}

impl Disposition {
    pub fn as_str(self) -> &'static str {
        match self {
            Disposition::Quantity => "quantity",
            Disposition::Serialized => "serialized",
            Disposition::OneOff => "one_off",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "quantity" => Some(Disposition::Quantity),
            "serialized" => Some(Disposition::Serialized),
            "one_off" => Some(Disposition::OneOff),
            _ => None,
        }
    }
}

impl fmt::Display for Disposition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Archive state (D7, `spec:221`). A product linked to history is archived,
/// never deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProductStatus {
    Active,
    Archived,
}

impl ProductStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ProductStatus::Active => "active",
            ProductStatus::Archived => "archived",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(ProductStatus::Active),
            "archived" => Some(ProductStatus::Archived),
            _ => None,
        }
    }
}

/// Whether a change may be applied to a product in this state.
impl ProductStatus {
    /// An archived product is read-only apart from being reactivated.
    pub fn allows_edit(self) -> bool {
        matches!(self, ProductStatus::Active)
    }
}

/// A validated product name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProductName(String);

impl ProductName {
    /// Trim, then reject an empty name.
    ///
    /// Length is not capped. No maximum has been approved, and inventing one
    /// here would encode an assumption as a requirement
    /// (`PROJECT_INSTRUCTIONS.md` §4).
    pub fn new(value: &str) -> Result<Self, CatalogError> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(CatalogError::NameRequired);
        }
        Ok(Self(trimmed.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProductName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// An optional barcode (D3).
///
/// Created for the product and never derived from any identifier (`spec:176`).
/// No symbology validation: that knowledge belongs to the blocked barcode
/// decision, so any non-empty value is accepted here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Barcode(String);

impl Barcode {
    pub fn new(value: &str) -> Result<Self, CatalogError> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(CatalogError::BarcodeEmpty);
        }
        Ok(Self(trimmed.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// A case-insensitive lookup key, so a scanner and a typist agree.
    pub fn lookup_key(&self) -> String {
        self.0.to_ascii_lowercase()
    }
}

/// A selling price in piastres (ADR-010).
///
/// This is a **named view of `Piastres`, not a second money representation**.
///
/// It exists because a price and a cost are different facts that happen to share
/// a unit, and a function taking a `SalePrice` cannot be handed a purchase cost
/// by accident. That is the whole justification. The stored number is delegated
/// to [`Piastres`], so there is one place where the unit, the sign rule and the
/// display split are decided.
///
/// `Option<SalePrice>` is what preserves "not set" as distinct from zero:
/// `None` means the price is not yet set, `Some(SalePrice::new_minor(0)?)` means
/// genuinely free. The newtype cannot express "unset" at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SalePrice(Piastres);

impl SalePrice {
    /// Negative prices are rejected. A refund is a different concept and does
    /// not belong in a catalogue price.
    pub fn new_minor(value: i64) -> Result<Self, CatalogError> {
        Piastres::new_minor(value)
            .map(Self)
            .map_err(|_| CatalogError::PriceNegative)
    }

    pub fn as_minor(&self) -> i64 {
        self.0.as_minor()
    }

    /// The underlying amount, for arithmetic in a slice that owns a price and a
    /// cost together. The only way to get from a price to a number.
    pub fn amount(&self) -> Piastres {
        self.0
    }

    /// Value in whole EGP plus piastres, for display only.
    ///
    /// Division happens here, in presentation, and never feeds a stored value.
    /// ADR-010 leaves the rounding policy open, so this returns the exact
    /// quotient and remainder rather than inventing a rounding rule.
    pub fn display_parts(&self) -> (i64, i64) {
        self.0.display_parts()
    }
}

impl From<Piastres> for SalePrice {
    /// Total: `Piastres` is already non-negative by construction, so there is
    /// nothing left to validate.
    fn from(amount: Piastres) -> Self {
        Self(amount)
    }
}

impl fmt::Display for SalePrice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (whole, piastres) = self.display_parts();
        write!(f, "{whole}.{piastres:02}")
    }
}

/// A catalogue product.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Product {
    pub id: ProductId,
    pub name: ProductName,
    pub disposition: Disposition,
    /// Absent means the shop has not set a barcode for this product yet.
    pub barcode: Option<Barcode>,
    /// Absent means the price is not yet set. **Not** the same as free.
    pub sale_price: Option<SalePrice>,
    /// Product classification. Absent means the shop has not classified this
    /// product yet, which is a legitimate state: a product may be in the
    /// catalogue before anyone decides where it belongs.
    ///
    /// Not a physical location, and not a stock counter — V1 has one stock
    /// counter per product.
    pub department: Option<DepartmentId>,
    /// Approved unit cost when the product has none in stock. Absent means no
    /// approved cost is recorded; `Some(0)` means a genuinely cost-free product.
    ///
    /// Stored configuration only. No costing engine reads it yet.
    pub default_cost: Option<Piastres>,
    /// Product-level VAT rate in basis points, overriding any department
    /// default. Absent means no override.
    ///
    /// Stored configuration only. No VAT arithmetic reads it yet.
    pub vat_rate_bp: Option<i64>,
    pub status: ProductStatus,
    pub created_by: UserId,
    pub updated_by: UserId,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Product {
    /// Whether this product may be modified in its current state.
    pub fn is_editable(&self) -> bool {
        self.status.allows_edit()
    }

    /// Change the archive state. Permitted in both directions.
    ///
    /// Every other field change goes through `update`, which refuses when the
    /// product is archived.
    pub fn set_status(&mut self, status: ProductStatus, actor: UserId, now: i64) {
        self.status = status;
        self.updated_by = actor;
        self.updated_at = now;
    }

    /// Apply edits, refusing when the product is archived.
    ///
    /// The three inventory-profile fields take `Option` values that replace the
    /// stored ones wholesale, matching how `barcode` and `sale_price` already
    /// behave: a caller passes the value the product should end up with, not a
    /// patch to merge. A service that wants "leave untouched" must therefore keep
    /// the current value, and says so where it builds the call.
    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &mut self,
        name: ProductName,
        disposition: Disposition,
        barcode: Option<Barcode>,
        sale_price: Option<SalePrice>,
        department: Option<DepartmentId>,
        default_cost: Option<Piastres>,
        vat_rate_bp: Option<i64>,
        actor: UserId,
        now: i64,
    ) -> Result<(), CatalogError> {
        if !self.is_editable() {
            return Err(CatalogError::ProductArchived);
        }
        self.name = name;
        self.disposition = disposition;
        self.barcode = barcode;
        self.sale_price = sale_price;
        self.department = department;
        self.default_cost = default_cost;
        self.vat_rate_bp = vat_rate_bp;
        self.updated_by = actor;
        self.updated_at = now;
        Ok(())
    }
}

/// Failures the catalogue domain can raise on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogError {
    NoProductWithThisId,
    /// The barcode is already used by another product (`plan:167`).
    BarcodeAlreadyExists,
    NameRequired,
    BarcodeEmpty,
    PriceNegative,
    /// The product is archived and may not be edited.
    ProductArchived,
    /// The session's role does not permit catalogue management.
    ///
    /// Carried here rather than collapsed into another variant so the frontend
    /// can say "you do not have permission" instead of "no such product", which
    /// would be a different and wrong statement.
    PermissionDenied,
    /// The category named for a product does not exist or is archived
    /// (ADR-018 §1).
    CategoryNotFound,
    /// Every internal shop code has been used (`ADR-018` §3, `PLAN` §6).
    ///
    /// Practically unreachable — the range holds a hundred billion codes — but
    /// refusing is the honest answer where wrapping would repeat a code.
    ShopCodeExhausted,
}

impl CatalogError {
    /// A stable, language-independent code for the transport.
    ///
    /// `spec:127` keeps user-facing text in Arabic message files on the
    /// frontend, so only the code crosses the boundary.
    pub fn code(&self) -> &'static str {
        match self {
            CatalogError::NoProductWithThisId => "PRODUCT_NOT_FOUND",
            CatalogError::BarcodeAlreadyExists => "BARCODE_ALREADY_EXISTS",
            CatalogError::NameRequired => "PRODUCT_NAME_REQUIRED",
            CatalogError::BarcodeEmpty => "BARCODE_EMPTY",
            CatalogError::PriceNegative => "PRICE_NEGATIVE",
            CatalogError::ProductArchived => "PRODUCT_IS_ARCHIVED",
            CatalogError::PermissionDenied => "PERMISSION_DENIED",
            CatalogError::CategoryNotFound => "PRODUCT_CATEGORY_NOT_FOUND",
            CatalogError::ShopCodeExhausted => "SHOP_CODE_EXHAUSTED",
        }
    }
}

impl fmt::Display for CatalogError {
    /// Developer-facing text for logs and test failures. Never sent to the
    /// frontend; use `code` for that.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CatalogError::NoProductWithThisId => write!(f, "no product with this id"),
            CatalogError::BarcodeAlreadyExists => write!(f, "barcode already in use"),
            CatalogError::NameRequired => write!(f, "product name is required"),
            CatalogError::BarcodeEmpty => write!(f, "barcode is empty"),
            CatalogError::PriceNegative => write!(f, "price cannot be negative"),
            CatalogError::ProductArchived => write!(f, "product is archived"),
            CatalogError::PermissionDenied => write!(f, "permission denied"),
            CatalogError::CategoryNotFound => write!(f, "no live category with this id"),
            CatalogError::ShopCodeExhausted => write!(f, "every internal shop code is in use"),
        }
    }
}

impl std::error::Error for CatalogError {}
