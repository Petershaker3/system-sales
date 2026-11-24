//! Stable user identity.
//!
//! `spec:109` and `ADR-008:44` forbid deriving identifiers from storage
//! location or from a per-device counter. UUID v7 satisfies both constraints
//! and additionally sorts in creation order, so `ORDER BY id` is also
//! chronological. See ADR-009.

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A user identifier. Always a UUID v7; there is no other constructor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UserId(Uuid);

impl UserId {
    /// Generate a new identifier, time-ordered.
    pub fn generate() -> Self {
        Self(Uuid::now_v7())
    }

    /// Rehydrate an identifier read from storage.
    ///
    /// This exists so persistence can round-trip a value. It is deliberately
    /// separate from `generate` so that reading never silently mints a new id.
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

impl fmt::Display for UserId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}