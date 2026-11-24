//! Product variants («تفرعات الصنف», ADR-018 §4, plan item 1.2 step 4).
//!
//! A counted item such as a phone case, screen protector, charger or cable can
//! be registered once as a parent (`VariantParent`) with one or two dimensions
//! from the mockup's fixed vocabulary (`NI_DIMS` in `views/catalog.js`), and
//! every combination of their values becomes a product row (`ProductVariant`)
//! with its own barcode, sale price, stock balance and moving-average cost.
//!
//! No storage, no SQL, no Tauri here (`spec:99`).

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::catalog::ProductName;
use crate::domain::identity::UserId;
use crate::domain::organisation::DepartmentId;

/// The most combinations one parent may generate (`NI_MAX_VARIANTS = 60` in
/// `docs/ui/mockup-v1/views/catalog.js`). Above that, the shop splits the item
/// into more than one parent so the variant picker stays readable on one screen.
pub const MAX_VARIANTS: usize = 60;

/// The seven dimensions the shop splits a counted item by (`NI_DIMS`).
pub const VARIANT_DIMENSIONS: [&str; 7] = [
    "الموبايل",
    "اللون",
    "النوع",
    "المقاس",
    "القوة",
    "الطول",
    "المساحة",
];

/// Identifier of a variant parent (`product_parents.id`): a UUID v7.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VariantParentId(Uuid);

impl VariantParentId {
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

impl fmt::Display for VariantParentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

/// Which axis a variant parent splits by (`NI_DIMS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum VariantDimension {
    Phone,
    Color,
    Kind,
    Size,
    Power,
    Length,
    Storage,
}

impl VariantDimension {
    pub fn as_str(self) -> &'static str {
        match self {
            VariantDimension::Phone => "الموبايل",
            VariantDimension::Color => "اللون",
            VariantDimension::Kind => "النوع",
            VariantDimension::Size => "المقاس",
            VariantDimension::Power => "القوة",
            VariantDimension::Length => "الطول",
            VariantDimension::Storage => "المساحة",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "الموبايل" => Some(VariantDimension::Phone),
            "اللون" => Some(VariantDimension::Color),
            "النوع" => Some(VariantDimension::Kind),
            "المقاس" => Some(VariantDimension::Size),
            "القوة" => Some(VariantDimension::Power),
            "الطول" => Some(VariantDimension::Length),
            "المساحة" => Some(VariantDimension::Storage),
            _ => None,
        }
    }
}

/// One value along a dimension («Galaxy A16», «أسود», «20W»): trimmed, inner
/// spaces collapsed, never empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VariantValue(String);

impl VariantValue {
    pub fn new(value: &str) -> Result<Self, VariantError> {
        let collapsed = value.trim().split_whitespace().collect::<Vec<_>>().join(" ");
        if collapsed.is_empty() {
            return Err(VariantError::ValueRequired);
        }
        Ok(Self(collapsed))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for VariantValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The parent item that groups its variant products under one tile on the sales
/// screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantParent {
    pub id: VariantParentId,
    pub name: ProductName,
    pub category: DepartmentId,
    pub dimension_1: VariantDimension,
    pub dimension_2: Option<VariantDimension>,
    pub created_by: UserId,
    pub updated_by: UserId,
    pub created_at: i64,
    pub updated_at: i64,
}

impl VariantParent {
    pub fn new(
        name: ProductName,
        category: DepartmentId,
        dimension_1: VariantDimension,
        dimension_2: Option<VariantDimension>,
        actor: UserId,
        now: i64,
    ) -> Self {
        Self {
            id: VariantParentId::generate(),
            name,
            category,
            dimension_1,
            dimension_2,
            created_by: actor,
            updated_by: actor,
            created_at: now,
            updated_at: now,
        }
    }
}

/// The variant details stored on one product row (`products.parent_id`,
/// `variant_1`, `variant_2`, `variant_order`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProductVariant {
    pub parent_id: VariantParentId,
    pub value_1: VariantValue,
    pub value_2: Option<VariantValue>,
    pub order: i64,
}

/// Clean and validate one dimension's values, refusing empty or duplicate
/// entries (case-insensitively).
fn parse_values(raw: &[String]) -> Result<Vec<VariantValue>, VariantError> {
    let mut out: Vec<VariantValue> = Vec::with_capacity(raw.len());
    for item in raw {
        let val = VariantValue::new(item)?;
        let key = val.as_str().to_lowercase();
        if out.iter().any(|existing| existing.as_str().to_lowercase() == key) {
            return Err(VariantError::DuplicateValue);
        }
        out.push(val);
    }
    Ok(out)
}

/// The Cartesian product of one or two dimensions (`variantCombos` in
/// `docs/ui/mockup-v1/analytics.js`).
///
/// The first dimension must have at least one value; the second is optional
/// (when empty, each combination is `(v1, None)`). Refuses more than
/// [`MAX_VARIANTS`] combinations.
pub fn variant_combos(
    values_1: &[String],
    values_2: &[String],
) -> Result<Vec<(VariantValue, Option<VariantValue>)>, VariantError> {
    let first = parse_values(values_1)?;
    if first.is_empty() {
        return Err(VariantError::VariantsEmpty);
    }
    let second = parse_values(values_2)?;

    let total = if second.is_empty() {
        first.len()
    } else {
        first.len().saturating_mul(second.len())
    };
    if total > MAX_VARIANTS {
        return Err(VariantError::TooManyVariants);
    }

    let mut combos = Vec::with_capacity(total);
    if second.is_empty() {
        for v1 in first {
            combos.push((v1, None));
        }
    } else {
        for v1 in &first {
            for v2 in &second {
                combos.push((v1.clone(), Some(v2.clone())));
            }
        }
    }
    Ok(combos)
}

/// A variant product's full name as the shop stores and searches it
/// (`${base} ${c.join(' ')}` in `views/catalog.js`): «جراب سيليكون ملون Galaxy A16 أسود».
pub fn variant_title(
    base: &str,
    value_1: &VariantValue,
    value_2: Option<&VariantValue>,
) -> String {
    let clean_base = base.trim().split_whitespace().collect::<Vec<_>>().join(" ");
    [
        clean_base.as_str(),
        value_1.as_str(),
        value_2.map(VariantValue::as_str).unwrap_or(""),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}

/// Domain failures in product variants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VariantError {
    /// Variants are only for counted items (`kind = 'item'`), not phones.
    CategoryNotItem,
    /// A dimension name is not one of the seven in [`VARIANT_DIMENSIONS`].
    DimensionUnknown,
    /// The first dimension has no values.
    VariantsEmpty,
    /// A dimension value is blank after trimming.
    ValueRequired,
    /// The same value appears twice in the same dimension.
    DuplicateValue,
    /// The combinations exceed [`MAX_VARIANTS`] (60).
    TooManyVariants,
    /// A variant parent with this name already exists in the same category.
    ParentAlreadyExists,
    /// A variant item needs a positive sale price (either on the parent or on
    /// the row).
    PriceRequired,
    /// Two variant rows in the same batch were given the same barcode.
    DuplicateBarcodeInBatch,
    /// Per-row overrides do not match the number of generated combinations.
    RowMismatch,
}

impl VariantError {
    pub fn code(&self) -> &'static str {
        match self {
            VariantError::CategoryNotItem => "VARIANT_CATEGORY_NOT_ITEM",
            VariantError::DimensionUnknown => "VARIANT_DIMENSION_UNKNOWN",
            VariantError::VariantsEmpty => "VARIANT_VALUES_REQUIRED",
            VariantError::ValueRequired => "VARIANT_VALUE_EMPTY",
            VariantError::DuplicateValue => "VARIANT_VALUE_DUPLICATE",
            VariantError::TooManyVariants => "VARIANT_LIMIT_EXCEEDED",
            VariantError::ParentAlreadyExists => "VARIANT_PARENT_ALREADY_EXISTS",
            VariantError::PriceRequired => "VARIANT_PRICE_REQUIRED",
            VariantError::DuplicateBarcodeInBatch => "VARIANT_BARCODE_DUPLICATE",
            VariantError::RowMismatch => "VARIANT_ROWS_MISMATCH",
        }
    }
}

impl fmt::Display for VariantError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for VariantError {}
