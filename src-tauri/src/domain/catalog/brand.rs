//! Phone brands and a phone's details (ADR-018 §2).
//!
//! The owner keeps the phone companies in the settings, as in the legacy app
//! (`ADR-016` decision 29): each is touch, keypad or both, in his order, and
//! shown or not in «موبايل جديد». A phone is registered by its company, its
//! model, touch or keypad, and — for a touch phone — its storage and RAM, and
//! its name is built from them: «Samsung Galaxy A16 128GB», «iPhone 16 128GB»
//! (a model that starts with the company's own line drops the company).
//!
//! No storage, no SQL, no Tauri here (`spec:99`).

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::identity::UserId;

/// A brand identifier: a UUID, fixed for the defaults, v7 for the owner's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BrandId(Uuid);

impl BrandId {
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

impl fmt::Display for BrandId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

/// A company's name: trimmed, never empty. Unique among brands whatever the
/// case — the storage's unique index, reported by the service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BrandName(String);

impl BrandName {
    pub fn new(value: &str) -> Result<Self, BrandError> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(BrandError::NameRequired);
        }
        Ok(Self(trimmed.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Which phones a company makes, as the owner set it: it decides which
/// companies «موبايل جديد» offers for a touch phone and for a keypad one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrandDeviceType {
    Touch,
    Keypad,
    Both,
}

impl BrandDeviceType {
    pub fn as_str(self) -> &'static str {
        match self {
            BrandDeviceType::Touch => "touch",
            BrandDeviceType::Keypad => "keypad",
            BrandDeviceType::Both => "both",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "touch" => Some(BrandDeviceType::Touch),
            "keypad" => Some(BrandDeviceType::Keypad),
            "both" => Some(BrandDeviceType::Both),
            _ => None,
        }
    }

    /// Whether a phone of `device` may be registered under this company.
    pub fn allows(self, device: DeviceType) -> bool {
        matches!(
            (self, device),
            (BrandDeviceType::Both, _)
                | (BrandDeviceType::Touch, DeviceType::Touch)
                | (BrandDeviceType::Keypad, DeviceType::Keypad)
        )
    }
}

/// One phone: touch («تاتش») or keypad («زراير»).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceType {
    Touch,
    Keypad,
}

impl DeviceType {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceType::Touch => "touch",
            DeviceType::Keypad => "keypad",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "touch" => Some(DeviceType::Touch),
            "keypad" => Some(DeviceType::Keypad),
            _ => None,
        }
    }
}

/// A phone company, as the settings list it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Brand {
    pub id: BrandId,
    pub name: BrandName,
    pub device_type: BrandDeviceType,
    pub sort_order: i64,
    /// Not offered in «موبايل جديد». Its phones are still sold, and its chip
    /// still shows on the sales screen while it has any.
    pub hidden: bool,
    pub created_by: UserId,
    pub updated_by: UserId,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Brand {
    pub fn new(
        name: BrandName,
        device_type: BrandDeviceType,
        sort_order: i64,
        actor: UserId,
        now: i64,
    ) -> Self {
        Self {
            id: BrandId::generate(),
            name,
            device_type,
            sort_order,
            hidden: false,
            created_by: actor,
            updated_by: actor,
            created_at: now,
            updated_at: now,
        }
    }

    /// Record who changed it and when; every change goes through here.
    pub fn touched(&mut self, actor: UserId, now: i64) {
        self.updated_by = actor;
        self.updated_at = now;
    }
}

/// One of the companies a new shop starts with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefaultBrand {
    /// Fixed: added once, and told apart from the owner's own companies.
    pub id: &'static str,
    pub name: &'static str,
    pub device_type: BrandDeviceType,
    pub sort_order: i64,
    /// Model lines written without the company («iPhone 16», «Redmi 14C»): a
    /// phone whose model starts with one is named without the company.
    pub lines: &'static [&'static str],
    /// How the company is written in Arabic, for search («سامسونج» finds
    /// «Samsung Galaxy A16»).
    pub aliases: &'static str,
}

/// The mockup's companies (`data.js`, `brands`), in its order.
pub const DEFAULT_BRANDS: [DefaultBrand; 12] = [
    DefaultBrand { id: "01a14728-8400-7000-8001-000000000001", name: "Samsung", device_type: BrandDeviceType::Touch, sort_order: 10, lines: &[], aliases: "سامسونج جالاكسي جلاكسي" },
    DefaultBrand { id: "01a14728-8400-7000-8001-000000000002", name: "Apple", device_type: BrandDeviceType::Touch, sort_order: 20, lines: &["iPhone"], aliases: "ابل آبل ايفون آيفون" },
    DefaultBrand { id: "01a14728-8400-7000-8001-000000000003", name: "Xiaomi", device_type: BrandDeviceType::Touch, sort_order: 30, lines: &["Redmi", "POCO"], aliases: "شاومي شاومى ريدمي ردمي بوكو" },
    DefaultBrand { id: "01a14728-8400-7000-8001-000000000004", name: "OPPO", device_type: BrandDeviceType::Touch, sort_order: 40, lines: &[], aliases: "اوبو أوبو" },
    DefaultBrand { id: "01a14728-8400-7000-8001-000000000005", name: "realme", device_type: BrandDeviceType::Touch, sort_order: 50, lines: &[], aliases: "ريلمي ريل مي" },
    DefaultBrand { id: "01a14728-8400-7000-8001-000000000006", name: "Honor", device_type: BrandDeviceType::Touch, sort_order: 60, lines: &[], aliases: "هونر هونور" },
    DefaultBrand { id: "01a14728-8400-7000-8001-000000000007", name: "Infinix", device_type: BrandDeviceType::Touch, sort_order: 70, lines: &[], aliases: "انفينكس انفنكس" },
    DefaultBrand { id: "01a14728-8400-7000-8001-000000000008", name: "Tecno", device_type: BrandDeviceType::Both, sort_order: 80, lines: &[], aliases: "تكنو تيكنو" },
    DefaultBrand { id: "01a14728-8400-7000-8001-000000000009", name: "vivo", device_type: BrandDeviceType::Touch, sort_order: 90, lines: &[], aliases: "فيفو" },
    DefaultBrand { id: "01a14728-8400-7000-8001-00000000000a", name: "Huawei", device_type: BrandDeviceType::Touch, sort_order: 100, lines: &[], aliases: "هواوي" },
    DefaultBrand { id: "01a14728-8400-7000-8001-00000000000b", name: "Nokia", device_type: BrandDeviceType::Both, sort_order: 110, lines: &[], aliases: "نوكيا" },
    DefaultBrand { id: "01a14728-8400-7000-8001-00000000000c", name: "itel", device_type: BrandDeviceType::Keypad, sort_order: 120, lines: &[], aliases: "ايتل آيتل" },
];

impl DefaultBrand {
    pub fn brand_id(&self) -> BrandId {
        BrandId::from_uuid(Uuid::parse_str(self.id).unwrap_or(Uuid::nil()))
    }
}

fn default_brand(id: BrandId) -> Option<&'static DefaultBrand> {
    DEFAULT_BRANDS.iter().find(|default| default.brand_id() == id)
}

/// Whether `id` is a default company: renamed, moved and hidden, never deleted.
pub fn is_default_brand(id: BrandId) -> bool {
    default_brand(id).is_some()
}

/// The model lines a company's phones are written with, without the company.
pub fn brand_lines(id: BrandId) -> &'static [&'static str] {
    default_brand(id).map(|default| default.lines).unwrap_or(&[])
}

/// The company's Arabic spellings, for search; empty for the owner's own.
pub fn brand_aliases(id: BrandId) -> &'static str {
    default_brand(id).map(|default| default.aliases).unwrap_or("")
}

/// Whether a company may be deleted: one the owner added, with no phone at all
/// (archived ones included — `products.brand_id` is ON DELETE RESTRICT).
pub fn can_delete_brand(id: BrandId, products: i64) -> Result<(), BrandError> {
    if is_default_brand(id) {
        return Err(BrandError::IsDefault);
    }
    if products > 0 {
        return Err(BrandError::NotEmpty);
    }
    Ok(())
}

/// A phone's model as the shop writes it: trimmed, inner spaces collapsed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PhoneModel(String);

impl PhoneModel {
    pub fn new(value: &str) -> Result<Self, BrandError> {
        let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
        if collapsed.is_empty() {
            return Err(BrandError::ModelRequired);
        }
        Ok(Self(collapsed))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What a phone is: its company, model, device type, and for a touch phone its
/// storage (required) and RAM (optional), in GB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneDetails {
    pub brand: BrandId,
    pub model: PhoneModel,
    pub device_type: DeviceType,
    pub storage_gb: Option<i64>,
    pub ram_gb: Option<i64>,
}

impl PhoneDetails {
    /// A touch phone names its storage; a keypad phone has neither storage nor
    /// RAM («زراير» يعني موبايل من غير رام ومساحة, as the mockup says).
    pub fn new(
        brand: BrandId,
        model: &str,
        device_type: DeviceType,
        storage_gb: Option<i64>,
        ram_gb: Option<i64>,
    ) -> Result<Self, BrandError> {
        let model = PhoneModel::new(model)?;
        match device_type {
            DeviceType::Touch => {
                if storage_gb.is_none() {
                    return Err(BrandError::StorageRequired);
                }
            }
            DeviceType::Keypad => {
                if storage_gb.is_some() || ram_gb.is_some() {
                    return Err(BrandError::KeypadHasNoSpecs);
                }
            }
        }
        if storage_gb.is_some_and(|gb| gb <= 0) || ram_gb.is_some_and(|gb| gb <= 0) {
            return Err(BrandError::SpecInvalid);
        }
        Ok(Self {
            brand,
            model,
            device_type,
            storage_gb,
            ram_gb,
        })
    }
}

/// «128GB», or «1TB» for a whole number of terabytes.
pub fn storage_label(gb: i64) -> String {
    if gb >= 1024 && gb % 1024 == 0 {
        format!("{}TB", gb / 1024)
    } else {
        format!("{gb}GB")
    }
}

/// A phone's name: the company, the model and the storage — without the
/// company when the model already starts with it or with one of its `lines`
/// (`analytics.js`, `phoneTitle`, in the mockup).
pub fn phone_title(
    brand_name: &str,
    lines: &[&str],
    model: &PhoneModel,
    storage_gb: Option<i64>,
) -> String {
    let lower = model.as_str().to_lowercase();
    let brand = brand_name.trim();
    let bare = brand.is_empty()
        || lower.starts_with(&format!("{} ", brand.to_lowercase()))
        || lines
            .iter()
            .any(|line| lower.starts_with(&line.to_lowercase()));
    let mut parts: Vec<String> = Vec::with_capacity(3);
    if !bare {
        parts.push(brand.to_string());
    }
    parts.push(model.as_str().to_string());
    if let Some(gb) = storage_gb {
        parts.push(storage_label(gb));
    }
    parts.join(" ")
}

/// Why a brand change or a phone could not be made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrandError {
    NotFound,
    NameRequired,
    NameTaken,
    /// A default company may be renamed, moved and hidden, never deleted.
    IsDefault,
    /// The company still has phones, archived ones included.
    NotEmpty,
    TypeUnknown,
    ModelRequired,
    /// A touch phone names its storage.
    StorageRequired,
    /// A keypad phone has no storage or RAM.
    KeypadHasNoSpecs,
    /// A storage or RAM that is not a positive number of GB.
    SpecInvalid,
    /// The company does not make this kind of phone (as the owner set it).
    TypeMismatch,
    /// The same company, model, storage and RAM is already a live product.
    AlreadyRegistered,
    /// A phone goes in a category registered «جهاز جهاز بالـ IMEI».
    CategoryNotPhone,
}

impl BrandError {
    pub fn code(&self) -> &'static str {
        match self {
            BrandError::NotFound => "BRAND_NOT_FOUND",
            BrandError::NameRequired => "BRAND_NAME_REQUIRED",
            BrandError::NameTaken => "BRAND_NAME_TAKEN",
            BrandError::IsDefault => "BRAND_IS_DEFAULT",
            BrandError::NotEmpty => "BRAND_NOT_EMPTY",
            BrandError::TypeUnknown => "BRAND_TYPE_UNKNOWN",
            BrandError::ModelRequired => "PHONE_MODEL_REQUIRED",
            BrandError::StorageRequired => "PHONE_STORAGE_REQUIRED",
            BrandError::KeypadHasNoSpecs => "PHONE_KEYPAD_HAS_NO_SPECS",
            BrandError::SpecInvalid => "PHONE_SPEC_INVALID",
            BrandError::TypeMismatch => "PHONE_BRAND_TYPE_MISMATCH",
            BrandError::AlreadyRegistered => "PHONE_ALREADY_REGISTERED",
            BrandError::CategoryNotPhone => "PHONE_CATEGORY_NOT_PHONE",
        }
    }
}

impl fmt::Display for BrandError {
    /// Developer-facing only; the operator reads the Arabic message indexed by
    /// [`BrandError::code`].
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for BrandError {}
