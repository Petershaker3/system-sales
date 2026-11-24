//! What a backup contains, and the rules its contents must satisfy.
//!
//! A backup carries the device database plus the application-managed product
//! images. The manifest names every component and records its length and
//! SHA-256, so a reader can validate structure before touching the live device
//! and can check every byte after extraction (`ADR-003:14`).
//!
//! The manifest is *inside* the AEAD payload, so it is already tamper-evident.
//! It exists anyway because it is what lets a restore refuse a package that is
//! authenticated but nonsensical (a duplicate path, a missing database), and it
//! is the seam a streaming v2 reader would use.
//!
//! # Path policy
//!
//! Every component path is a relative, forward-slash path below the restore
//! root. Absolute paths, `..`, drive letters, backslashes, NUL and control
//! characters are rejected outright ([`validate_component_path`]). This is the
//! rule that stops a crafted package from writing outside the staging directory.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use super::error::BackupError;
use super::format::{
    FORMAT_VERSION, MAX_COMPONENT_COUNT, MAX_COMPONENT_LEN, MAX_COMPONENT_PATH_LEN,
    MAX_TOTAL_UNCOMPRESSED,
};

/// The one component that must always be present.
pub const DB_COMPONENT: &str = "shop.db";

/// Every image component lives under this prefix.
pub const IMAGES_PREFIX: &str = "images/";

/// Length of a lowercase hex SHA-256 digest.
const SHA256_HEX_LEN: usize = 64;

/// Metadata for one component of the package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentMeta {
    /// Storage-relative path, forward slashes.
    pub path: String,
    /// Exact byte length of the component.
    pub len: u64,
    /// Lowercase hex SHA-256 of the component's bytes.
    pub sha256: String,
}

/// The package's table of contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub format_version: u16,
    pub created_at_unix_ms: i64,
    pub database: ComponentMeta,
    pub images: Vec<ComponentMeta>,
    /// Sum of every component length, so a reader can bound work up front.
    pub uncompressed_len: u64,
}

/// Which part of the package a path names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComponentKind {
    Database,
    Image,
}

/// Device names Windows resolves before it looks at a directory.
const WINDOWS_RESERVED_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Reject anything that is not a safe relative path.
///
/// The rules are the intersection of what Windows and Android both accept
/// safely, because a backup made on one is restored on the other:
///
/// * relative, forward slashes only, no leading separator and no drive letter;
/// * no `.` or `..` segment, so a path cannot climb out of the restore root;
/// * no control characters, no `:`, no `\`, no NUL;
/// * no segment ending in `.` or space (Windows silently strips those, which
///   would make two different names collide);
/// * no reserved device name.
///
/// Non-ASCII letters and digits are allowed: an image a shop named in Arabic is
/// legitimate, and refusing it would make the backup fail for a reason the
/// operator could not act on.
pub fn validate_component_path(path: &str) -> Result<(), BackupError> {
    if path.is_empty() || path.len() > MAX_COMPONENT_PATH_LEN {
        return Err(BackupError::UnsafePath);
    }
    if path.starts_with('/') || path.starts_with('\\') || path.contains('\\') {
        return Err(BackupError::UnsafePath);
    }

    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(BackupError::UnsafePath);
        }
        if segment.ends_with('.') || segment.ends_with(' ') {
            return Err(BackupError::UnsafePath);
        }
        // A `:` anywhere would allow "C:" or an NTFS alternate data stream.
        if segment.contains(':') {
            return Err(BackupError::UnsafePath);
        }
        if segment.chars().any(|ch| ch.is_control()) {
            return Err(BackupError::UnsafePath);
        }
        // Compare on the stem, so "con.txt" is rejected as well as "CON".
        let stem = segment.split('.').next().unwrap_or(segment);
        if WINDOWS_RESERVED_NAMES
            .iter()
            .any(|name| stem.eq_ignore_ascii_case(name))
        {
            return Err(BackupError::UnsafePath);
        }
    }
    Ok(())
}

/// Classify a safe path as the database or an image.
pub fn classify_component_path(path: &str) -> Result<ComponentKind, BackupError> {
    validate_component_path(path)?;
    if path == DB_COMPONENT {
        Ok(ComponentKind::Database)
    } else if path.starts_with(IMAGES_PREFIX) {
        Ok(ComponentKind::Image)
    } else {
        // Safe, but not a component this format admits.
        Err(BackupError::ContentInvalid)
    }
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == SHA256_HEX_LEN
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn validate_meta(meta: &ComponentMeta, expected: ComponentKind) -> Result<(), BackupError> {
    if classify_component_path(&meta.path)? != expected {
        return Err(BackupError::ManifestInvalid);
    }
    if meta.len == 0 || meta.len > MAX_COMPONENT_LEN {
        return Err(BackupError::ManifestInvalid);
    }
    if !is_lower_hex_sha256(&meta.sha256) {
        return Err(BackupError::ManifestInvalid);
    }
    Ok(())
}

impl Manifest {
    /// Validate every declared invariant.
    ///
    /// Everything a reader needs to trust about structure is decided here, so
    /// the restore engine can assume a validated manifest.
    pub fn validate(&self) -> Result<(), BackupError> {
        if self.format_version != FORMAT_VERSION {
            return Err(BackupError::ManifestInvalid);
        }
        if classify_component_path(&self.database.path)? != ComponentKind::Database {
            // A package whose database is not at the reserved path is ambiguous.
            return Err(BackupError::MissingDatabase);
        }
        validate_meta(&self.database, ComponentKind::Database)?;

        if self.images.len() > MAX_COMPONENT_COUNT {
            return Err(BackupError::ManifestInvalid);
        }

        let mut seen: HashSet<&str> = HashSet::new();
        seen.insert(self.database.path.as_str());

        let mut total: u64 = self.database.len;
        for image in &self.images {
            validate_meta(image, ComponentKind::Image)?;
            if !seen.insert(image.path.as_str()) {
                return Err(BackupError::DuplicateComponent);
            }
            total = total
                .checked_add(image.len)
                .ok_or(BackupError::ManifestInvalid)?;
        }

        if total > MAX_TOTAL_UNCOMPRESSED {
            return Err(BackupError::ManifestInvalid);
        }
        if total != self.uncompressed_len {
            return Err(BackupError::ManifestInvalid);
        }
        Ok(())
    }

    /// Every component, database first, then images in declared order.
    pub fn components(&self) -> Vec<(&ComponentMeta, ComponentKind)> {
        let mut out = Vec::with_capacity(self.images.len() + 1);
        out.push((&self.database, ComponentKind::Database));
        for image in &self.images {
            out.push((image, ComponentKind::Image));
        }
        out
    }
}
