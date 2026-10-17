//! The category tree (ADR-018 §1): what a department carries as a category.
//!
//! A category is a [`Department`](super::Department) row — a classification,
//! not a place (`ADR-012` §1, `ADR-016` decision 5). This module holds the
//! values the tree adds and the rules that are not about one row alone:
//!
//! * [`CategoryKind`] — how goods in a category are registered;
//! * [`CategoryIcon`] — the icon, from a fixed list;
//! * [`DEFAULT_CATEGORIES`] — the tree a new shop starts with, under fixed ids;
//! * [`can_delete`] — when a category may be removed.
//!
//! Two levels, never three, and a sub-category on its parent's kind: those are
//! checked when a category is made ([`Department::new_category`]) and again by
//! triggers in migration `0016`.
//!
//! [`Department::new_category`]: super::Department::new_category

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{DepartmentError, DepartmentId};

/// How goods in a category are registered (PLAN §6, `ADR-016` decision 29).
///
/// Chosen for a main category when it is made; a sub-category takes its
/// parent's. It decides what «صنف جديد» asks for, and nothing else here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CategoryKind {
    /// Counted goods, like accessories: a quantity per item.
    Item,
    /// New phones, device by device with the IMEI.
    Phone,
    /// Second-hand devices, each its own item.
    Used,
}

impl CategoryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CategoryKind::Item => "item",
            CategoryKind::Phone => "phone",
            CategoryKind::Used => "used",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "item" => Some(CategoryKind::Item),
            "phone" => Some(CategoryKind::Phone),
            "used" => Some(CategoryKind::Used),
            _ => None,
        }
    }
}

impl fmt::Display for CategoryKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The icons a category may have: the mockup's list (`views/settings.js`,
/// `CAT_ICONS`) plus `recycle` for the second-hand category. Every name is in
/// the frontend's icon set (`src/ui/icons.ts`).
///
/// The list only ever grows. A name removed from it would make every stored
/// category with that icon unreadable, which is what a reader that refuses an
/// unknown value is for — but not something to do to a shop on purpose.
pub const CATEGORY_ICONS: [&str; 17] = [
    "tag",
    "package",
    "smartphone",
    "watch",
    "headphones",
    "plug-zap",
    "cable",
    "shield",
    "layers",
    "battery-charging",
    "memory-stick",
    "car",
    "wallet-cards",
    "signal",
    "wrench",
    "sparkles",
    "recycle",
];

/// A category's icon: one of [`CATEGORY_ICONS`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CategoryIcon(String);

impl CategoryIcon {
    /// The icon a category has when nobody chose one, and the one every
    /// department made before the tree takes.
    pub fn tag() -> Self {
        Self("tag".to_string())
    }

    /// One of the known icons, or [`DepartmentError::IconUnknown`].
    pub fn new(value: &str) -> Result<Self, DepartmentError> {
        if CATEGORY_ICONS.contains(&value) {
            Ok(Self(value.to_string()))
        } else {
            Err(DepartmentError::IconUnknown)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// One category of the tree a new shop starts with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefaultCategory {
    /// Fixed, so the tree is added once and never twice, and so a default can
    /// be told apart from a category the owner made.
    pub id: &'static str,
    pub name: &'static str,
    /// The default main category this one sits under, by id.
    pub parent: Option<&'static str>,
    pub kind: CategoryKind,
    pub icon: &'static str,
    pub sort_order: i64,
}

/// The default tree (PLAN §6; the same names, order and icons as the mockup's
/// `data.js`). Mains first, each sub after its parent.
pub const DEFAULT_CATEGORIES: [DefaultCategory; 11] = [
    DefaultCategory { id: "01a14728-8400-7000-8000-000000000001", name: "موبايلات جديدة", parent: None, kind: CategoryKind::Phone, icon: "smartphone", sort_order: 10 },
    DefaultCategory { id: "01a14728-8400-7000-8000-000000000002", name: "مستعمل", parent: None, kind: CategoryKind::Used, icon: "recycle", sort_order: 20 },
    DefaultCategory { id: "01a14728-8400-7000-8000-000000000003", name: "إكسسوارات", parent: None, kind: CategoryKind::Item, icon: "package", sort_order: 30 },
    DefaultCategory { id: "01a14728-8400-7000-8000-000000000004", name: "جرابات", parent: Some("01a14728-8400-7000-8000-000000000003"), kind: CategoryKind::Item, icon: "shield", sort_order: 10 },
    DefaultCategory { id: "01a14728-8400-7000-8000-000000000005", name: "اسكرينات", parent: Some("01a14728-8400-7000-8000-000000000003"), kind: CategoryKind::Item, icon: "layers", sort_order: 20 },
    DefaultCategory { id: "01a14728-8400-7000-8000-000000000006", name: "شواحن", parent: Some("01a14728-8400-7000-8000-000000000003"), kind: CategoryKind::Item, icon: "plug-zap", sort_order: 30 },
    DefaultCategory { id: "01a14728-8400-7000-8000-000000000007", name: "كابلات ووصلات", parent: Some("01a14728-8400-7000-8000-000000000003"), kind: CategoryKind::Item, icon: "cable", sort_order: 40 },
    DefaultCategory { id: "01a14728-8400-7000-8000-000000000008", name: "سماعات", parent: Some("01a14728-8400-7000-8000-000000000003"), kind: CategoryKind::Item, icon: "headphones", sort_order: 50 },
    DefaultCategory { id: "01a14728-8400-7000-8000-000000000009", name: "باور بانك وميموري", parent: Some("01a14728-8400-7000-8000-000000000003"), kind: CategoryKind::Item, icon: "battery-charging", sort_order: 60 },
    DefaultCategory { id: "01a14728-8400-7000-8000-00000000000a", name: "حوامل", parent: Some("01a14728-8400-7000-8000-000000000003"), kind: CategoryKind::Item, icon: "car", sort_order: 70 },
    DefaultCategory { id: "01a14728-8400-7000-8000-00000000000b", name: "ساعات ذكية", parent: None, kind: CategoryKind::Item, icon: "watch", sort_order: 40 },
];

impl DefaultCategory {
    /// The fixed id as a [`DepartmentId`].
    pub fn department_id(&self) -> DepartmentId {
        DepartmentId::from_uuid(parse_fixed(self.id))
    }

    /// The parent's fixed id as a [`DepartmentId`].
    pub fn parent_id(&self) -> Option<DepartmentId> {
        self.parent.map(|id| DepartmentId::from_uuid(parse_fixed(id)))
    }
}

/// The ids above are literals checked by a unit test, so a failure here is a
/// typo in this file and nothing a shop can cause.
fn parse_fixed(id: &str) -> Uuid {
    Uuid::parse_str(id).unwrap_or(Uuid::nil())
}

/// Whether `id` is one of the default categories. A default may be renamed,
/// re-ordered and hidden, never deleted (ADR-018 §1, as in the mockup).
pub fn is_default_category(id: DepartmentId) -> bool {
    DEFAULT_CATEGORIES
        .iter()
        .any(|default| default.department_id() == id)
}

/// Whether a category may be deleted: not a default, no sub-category under it,
/// and no product in it — archived products included, because the row that
/// names it is still there (`products.department_id` is ON DELETE RESTRICT).
pub fn can_delete(
    id: DepartmentId,
    has_subcategories: bool,
    products: i64,
) -> Result<(), DepartmentError> {
    if is_default_category(id) {
        return Err(DepartmentError::IsDefault);
    }
    if has_subcategories {
        return Err(DepartmentError::HasSubcategories);
    }
    if products > 0 {
        return Err(DepartmentError::NotEmpty);
    }
    Ok(())
}
