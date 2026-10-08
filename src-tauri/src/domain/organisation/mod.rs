//! Departments: the product classification the shop already uses.
//!
//! Sub-modules are added one per domain slice, as in `catalog` and `identity`.

pub mod department;

pub use department::{
    CostMethod, Department, DepartmentError, DepartmentId, DepartmentName, DepartmentStatus,
    DepartmentVat, VatRate,
};