//! Product identity domain.
//!
//! Rules and types for the product catalogue, and since ADR-018 §2 the phone
//! brands and a phone's details. Depends on nothing from Tauri,
//! SQLx, SQLite or the operating system (`spec:99`, `ADR-008:121`), and nothing
//! from the identity slice's storage: `UserId` is borrowed as a plain identifier.

mod brand;
mod catalog;
mod shop_code;
mod variant;

pub use brand::{
    brand_aliases, brand_lines, can_delete_brand, is_default_brand, phone_title, storage_label,
    Brand, BrandDeviceType, BrandError, BrandId, BrandName, DefaultBrand, DeviceType,
    PhoneDetails, PhoneModel, DEFAULT_BRANDS,
};
pub use catalog::{
    Barcode, CatalogError, Disposition, Product, ProductId, ProductName, ProductStatus, SalePrice,
};
pub use shop_code::{ean13, ean13_check_digit, next_shop_code, next_shop_codes, ShopCodeError};
pub use variant::{
    variant_combos, variant_title, ProductVariant, VariantDimension, VariantError, VariantParent,
    VariantParentId, VariantValue, MAX_VARIANTS, VARIANT_DIMENSIONS,
};

