//! Device-level configuration.
//!
//! A settings slice is a domain slice: what may be configured, what a value
//! means, and what a refusal looks like. Reading and writing rows lives in
//! `data/repositories/settings`, and orchestration in `services/settings`.

pub mod snapshot;

pub use snapshot::{
    DiscountKind, SettingKey, SettingsError, SettingsSnapshot, PATTERN_REQUIRED,
};
