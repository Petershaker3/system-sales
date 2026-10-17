//! Departments: the product classification the shop already uses — since
//! ADR-018, the two-level category tree.
//!
//! Sub-modules are added one per domain slice, as in `catalog` and `identity`.

pub mod category;
pub mod department;

pub use category::{
    can_delete, is_default_category, CategoryIcon, CategoryKind, DefaultCategory,
    CATEGORY_ICONS, DEFAULT_CATEGORIES,
};
pub use department::{
    CategoryPlacement, CostMethod, Department, DepartmentError, DepartmentId, DepartmentName,
    DepartmentStatus, DepartmentVat, VatRate,
};
