//! Encrypted backup and recovery (`ADR-003`).
//!
//! The domain half of the slice: the exact envelope layout, the manifest and
//! its path policy, and the errors both can raise. It is pure and touches no
//! filesystem, no crypto library and no database, so every rule below is
//! testable as a function.
//!
//! The service half (`services::backup`) owns Argon2id, XChaCha20-Poly1305,
//! the file IO and the staged restore engine.

pub mod error;
pub mod format;
pub mod manifest;

pub use error::BackupError;
pub use format::Header;
pub use manifest::{ComponentKind, ComponentMeta, Manifest};
