//! The plaintext container that lives *inside* the encrypted payload.
//!
//! Layout, little-endian, no compression in v1:
//!
//! ```text
//! u32  manifest_len
//!      manifest_json           (manifest_len bytes, UTF-8 JSON)
//! repeat until end of buffer:
//!   u16  path_len
//!        path                 (path_len bytes, UTF-8)
//!   u64  data_len
//!        data                 (data_len bytes)
//! ```
//!
//! Nothing here is trusted. Every length is checked against the remaining input
//! and against the format bounds before it is used, and every component's
//! SHA-256 is recomputed and compared to the manifest. A component whose name
//! is not in the manifest, or a manifest entry with no bytes, is rejected: the
//! two halves must agree exactly.

use std::collections::HashMap;

use serde_json;

use crate::domain::backup::error::BackupError;
use crate::domain::backup::format::{
    MAX_COMPONENT_LEN, MAX_COMPONENT_PATH_LEN, MAX_MANIFEST_LEN, MAX_TOTAL_UNCOMPRESSED,
};
use crate::domain::backup::manifest::{
    classify_component_path, ComponentKind, Manifest, DB_COMPONENT,
};

use super::crypto;

/// A validated container: the manifest plus the component bytes it names.
#[derive(Debug)]
pub struct Unpacked {
    pub manifest: Manifest,
    pub database: Vec<u8>,
    /// Image components as `(path, bytes)`, in manifest order.
    pub images: Vec<(String, Vec<u8>)>,
}

/// Serialise the manifest and components into the plaintext container.
pub fn pack(manifest: &Manifest, components: &[(String, Vec<u8>)]) -> Result<Vec<u8>, BackupError> {
    manifest.validate()?;

    let manifest_json =
        serde_json::to_vec(manifest).map_err(|_| BackupError::ManifestInvalid)?;
    if manifest_json.len() > MAX_MANIFEST_LEN {
        return Err(BackupError::ManifestInvalid);
    }

    let mut out = Vec::new();
    out.extend_from_slice(&(manifest_json.len() as u32).to_le_bytes());
    out.extend_from_slice(&manifest_json);

    for (path, bytes) in components {
        classify_component_path(path)?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_COMPONENT_LEN {
            return Err(BackupError::ContentInvalid);
        }
        let path_bytes = path.as_bytes();
        let path_len = u16::try_from(path_bytes.len()).map_err(|_| BackupError::UnsafePath)?;
        out.extend_from_slice(&path_len.to_le_bytes());
        out.extend_from_slice(path_bytes);
        out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    Ok(out)
}

/// A bounds-checked cursor over the plaintext container.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], BackupError> {
        if n > self.remaining() {
            return Err(BackupError::ContentInvalid);
        }
        let slice = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16, BackupError> {
        let raw: [u8; 2] = self.take(2)?.try_into().map_err(|_| BackupError::ContentInvalid)?;
        Ok(u16::from_le_bytes(raw))
    }

    fn u32(&mut self) -> Result<u32, BackupError> {
        let raw: [u8; 4] = self.take(4)?.try_into().map_err(|_| BackupError::ContentInvalid)?;
        Ok(u32::from_le_bytes(raw))
    }

    fn u64(&mut self) -> Result<u64, BackupError> {
        let raw: [u8; 8] = self.take(8)?.try_into().map_err(|_| BackupError::ContentInvalid)?;
        Ok(u64::from_le_bytes(raw))
    }
}

/// Parse and fully validate a plaintext container.
pub fn unpack(plaintext: &[u8]) -> Result<Unpacked, BackupError> {
    let mut reader = Reader::new(plaintext);

    let manifest_len = reader.u32()? as usize;
    if manifest_len == 0 || manifest_len > MAX_MANIFEST_LEN {
        return Err(BackupError::ManifestInvalid);
    }
    let manifest_bytes = reader.take(manifest_len)?;
    let manifest: Manifest =
        serde_json::from_slice(manifest_bytes).map_err(|_| BackupError::ManifestInvalid)?;
    manifest.validate()?;

    // Read every entry, rejecting duplicates and unknown names as they appear.
    let mut entries: HashMap<String, Vec<u8>> = HashMap::new();
    let mut total: u64 = 0;
    while reader.remaining() > 0 {
        let path_len = reader.u16()? as usize;
        if path_len == 0 || path_len > MAX_COMPONENT_PATH_LEN {
            return Err(BackupError::UnsafePath);
        }
        let path_bytes = reader.take(path_len)?;
        let path = std::str::from_utf8(path_bytes).map_err(|_| BackupError::UnsafePath)?;
        // Reject a path the format does not admit (absolute, `..`, drive letter)
        // before it is ever joined onto a directory.
        classify_component_path(path)?;

        let data_len = reader.u64()?;
        if data_len == 0 || data_len > MAX_COMPONENT_LEN {
            return Err(BackupError::ContentInvalid);
        }
        total = total
            .checked_add(data_len)
            .ok_or(BackupError::ContentInvalid)?;
        if total > MAX_TOTAL_UNCOMPRESSED {
            return Err(BackupError::ContentInvalid);
        }
        let data = reader.take(data_len as usize)?;

        if entries.contains_key(path) {
            return Err(BackupError::DuplicateComponent);
        }
        entries.insert(path.to_string(), data.to_vec());
    }

    // The manifest and the entries must describe exactly the same set.
    let mut database: Option<Vec<u8>> = None;
    let mut images: Vec<(String, Vec<u8>)> = Vec::with_capacity(manifest.images.len());

    for (meta, kind) in manifest.components() {
        let bytes = match entries.remove(&meta.path) {
            Some(bytes) => bytes,
            None => {
                return if kind == ComponentKind::Database {
                    Err(BackupError::MissingDatabase)
                } else {
                    Err(BackupError::ContentInvalid)
                }
            }
        };
        if bytes.len() as u64 != meta.len {
            return Err(BackupError::ContentInvalid);
        }
        if crypto::sha256_hex(&bytes) != meta.sha256 {
            return Err(BackupError::ContentInvalid);
        }
        match kind {
            ComponentKind::Database => database = Some(bytes),
            ComponentKind::Image => images.push((meta.path.clone(), bytes)),
        }
    }

    if !entries.is_empty() {
        // Bytes for a component the manifest never named.
        return Err(BackupError::ContentInvalid);
    }

    let database = database.ok_or(BackupError::MissingDatabase)?;
    debug_assert_eq!(manifest.database.path, DB_COMPONENT);
    Ok(Unpacked {
        manifest,
        database,
        images,
    })
}
