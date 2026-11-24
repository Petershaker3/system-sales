//! The on-disk backup envelope, v1.
//!
//! This module is the single authority for the byte layout. It is pure: no
//! filesystem, no crypto library, no allocator beyond the returned `Vec`. The
//! service layer calls it to write the header and to decide, *before it reads
//! or derives anything expensive*, whether a file is even a candidate.
//!
//! # Exact layout (v1)
//!
//! Everything is little-endian. `HEADER_LEN` is 32 bytes; `salt` and `nonce`
//! follow it, and the AEAD ciphertext follows those. The whole 88-byte prefix
//! (header + salt + nonce) is passed to the AEAD as associated data, so the
//! metadata is authenticated along with the payload.
//!
//! ```text
//! offset  size  field
//!      0     4  magic             = "MSB1"
//!      4     2  format_version    = 1
//!      6     1  kdf_algorithm     = 1 (Argon2id)
//!      7     1  aead_algorithm    = 1 (XChaCha20-Poly1305)
//!      8     4  kdf_memory_kib    (u32, 1 KiB blocks)
//!     12     4  kdf_iterations    (u32)
//!     16     4  kdf_parallelism   (u32)
//!     20     1  salt_len          = 32
//!     21     1  nonce_len         = 24
//!     22     2  flags             = 0
//!     24     8  payload_len       (u64, *includes* the 16-byte AEAD tag)
//!     32    32  salt
//!     64    24  nonce
//!     88     n  ciphertext        (payload_len bytes, tag appended)
//! ```
//!
//! `payload_len` is defined to *include* the AEAD tag. That makes the exact
//! expected file length `88 + payload_len`, so a truncated or padded file is
//! rejected by a length comparison alone, independently of the AEAD. There is
//! no ambiguity to reason about later.

use super::error::BackupError;

/// Magic bytes: "Mobile Shop Backup, version 1".
pub const MAGIC: [u8; 4] = *b"MSB1";

/// The only envelope version this build writes or reads.
pub const FORMAT_VERSION: u16 = 1;

/// Argon2id algorithm id.
pub const KDF_ARGON2ID: u8 = 1;

/// XChaCha20-Poly1305 algorithm id.
pub const AEAD_XCHACHA20_POLY1305: u8 = 1;

/// Fixed header size in bytes.
pub const HEADER_LEN: usize = 32;

/// Salt size in bytes. 256 bits: well beyond what Argon2id requires.
pub const SALT_LEN: usize = 32;

/// Nonce size in bytes. XChaCha20 uses a 192-bit nonce, which is large enough
/// that a random nonce can be used once per file without practical collision
/// risk under a random key.
pub const NONCE_LEN: usize = 24;

/// Poly1305 tag size in bytes.
pub const TAG_LEN: usize = 16;

/// The authenticated prefix: header + salt + nonce.
pub const AAD_LEN: usize = HEADER_LEN + SALT_LEN + NONCE_LEN;

/// KDF parameters a *new* backup is written with.
///
/// 64 MiB / t=3 / p=1 / 32-byte key. `ADR-003:17` requires the format and KDF
/// to be chosen before implementation; these are the chosen values. They are
/// recorded in every header, so raising them later does not strand old backups.
pub const DEFAULT_MEMORY_KIB: u32 = 64 * 1024;
pub const DEFAULT_ITERATIONS: u32 = 3;
pub const DEFAULT_PARALLELISM: u32 = 1;

/// Hard upper/lower bounds applied to the KDF parameters *found in a header*.
///
/// A file is untrusted input. Without these a crafted header could ask this
/// device to allocate gigabytes for one Argon2 call. Readers reject a header
/// outside these bounds before deriving anything, so the cost of a hostile file
/// is the cost of reading 32 bytes.
pub const MIN_MEMORY_KIB: u32 = 8 * 1024;
pub const MAX_MEMORY_KIB: u32 = 256 * 1024;
pub const MIN_ITERATIONS: u32 = 1;
pub const MAX_ITERATIONS: u32 = 10;
pub const MIN_PARALLELISM: u32 = 1;
pub const MAX_PARALLELISM: u32 = 4;

/// Derived key length in bytes.
pub const KEY_LEN: usize = 32;

/// Largest single component (the database, or one image) accepted on read.
pub const MAX_COMPONENT_LEN: u64 = 256 * 1024 * 1024;

/// Largest total uncompressed size accepted on read.
pub const MAX_TOTAL_UNCOMPRESSED: u64 = 256 * 1024 * 1024;

/// Largest number of image components accepted on read.
pub const MAX_COMPONENT_COUNT: usize = 10_000;

/// Largest component path length accepted on read.
pub const MAX_COMPONENT_PATH_LEN: usize = 512;

/// Largest manifest JSON accepted on read.
pub const MAX_MANIFEST_LEN: usize = 4 * 1024 * 1024;

/// Allowance for the container framing (length prefixes + paths + manifest).
pub const MAX_CONTAINER_OVERHEAD: u64 = 8 * 1024 * 1024;

/// Largest declared payload accepted before the file body is touched.
///
/// The one-shot AEAD holds the whole plaintext and ciphertext in memory in v1,
/// so the cap is also the memory ceiling. Raising it is a v2 streaming change,
/// not a constant edit: see `docs/backup-format-v1.md`.
pub const MAX_PAYLOAD_LEN: u64 =
    MAX_TOTAL_UNCOMPRESSED + MAX_CONTAINER_OVERHEAD + TAG_LEN as u64;

/// The parsed, validated fixed header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub format_version: u16,
    pub kdf: u8,
    pub aead: u8,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    /// Length of the trailing ciphertext, *including* the AEAD tag.
    pub payload_len: u64,
}

impl Header {
    /// A header for a new backup with the default KDF policy.
    pub fn new_v1(payload_len: u64) -> Self {
        Header {
            format_version: FORMAT_VERSION,
            kdf: KDF_ARGON2ID,
            aead: AEAD_XCHACHA20_POLY1305,
            memory_kib: DEFAULT_MEMORY_KIB,
            iterations: DEFAULT_ITERATIONS,
            parallelism: DEFAULT_PARALLELISM,
            payload_len,
        }
    }

    /// The exact total file length this header implies.
    pub fn expected_file_len(&self) -> u64 {
        AAD_LEN as u64 + self.payload_len
    }

    /// Serialise to the fixed 32-byte header.
    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut out = [0u8; HEADER_LEN];
        out[0..4].copy_from_slice(&MAGIC);
        out[4..6].copy_from_slice(&self.format_version.to_le_bytes());
        out[6] = self.kdf;
        out[7] = self.aead;
        out[8..12].copy_from_slice(&self.memory_kib.to_le_bytes());
        out[12..16].copy_from_slice(&self.iterations.to_le_bytes());
        out[16..20].copy_from_slice(&self.parallelism.to_le_bytes());
        out[20] = SALT_LEN as u8;
        out[21] = NONCE_LEN as u8;
        out[22..24].copy_from_slice(&0u16.to_le_bytes());
        out[24..32].copy_from_slice(&self.payload_len.to_le_bytes());
        out
    }
}

fn bytes<const N: usize>(source: &[u8], offset: usize) -> Result<[u8; N], BackupError> {
    source
        .get(offset..offset + N)
        .and_then(|slice| <[u8; N]>::try_from(slice).ok())
        .ok_or(BackupError::FileTruncated)
}

/// Validate KDF cost parameters against the hard bounds.
///
/// Called on every read *before* Argon2 is constructed. A parameter set that
/// fails here never reaches the KDF.
pub fn validate_kdf_params(
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<(), BackupError> {
    if !(MIN_MEMORY_KIB..=MAX_MEMORY_KIB).contains(&memory_kib) {
        return Err(BackupError::KdfParamsInvalid);
    }
    if !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&iterations) {
        return Err(BackupError::KdfParamsInvalid);
    }
    if !(MIN_PARALLELISM..=MAX_PARALLELISM).contains(&parallelism) {
        return Err(BackupError::KdfParamsInvalid);
    }
    // Argon2 requires at least 8 blocks per lane.
    if memory_kib < parallelism.saturating_mul(8) {
        return Err(BackupError::KdfParamsInvalid);
    }
    Ok(())
}

/// Parse and validate the fixed header from the first 32 bytes of a file.
pub fn decode_header(source: &[u8]) -> Result<Header, BackupError> {
    if source.len() < HEADER_LEN {
        return Err(BackupError::FileTruncated);
    }
    if &source[0..4] != MAGIC.as_slice() {
        return Err(BackupError::NotABackupFile);
    }

    let format_version = u16::from_le_bytes(bytes::<2>(source, 4)?);
    if format_version != FORMAT_VERSION {
        return Err(BackupError::UnsupportedVersion);
    }

    let kdf = source[6];
    let aead = source[7];
    if kdf != KDF_ARGON2ID || aead != AEAD_XCHACHA20_POLY1305 {
        return Err(BackupError::UnsupportedAlgorithm);
    }

    let memory_kib = u32::from_le_bytes(bytes::<4>(source, 8)?);
    let iterations = u32::from_le_bytes(bytes::<4>(source, 12)?);
    let parallelism = u32::from_le_bytes(bytes::<4>(source, 16)?);

    // The declared lengths and the reserved field are part of the format, not
    // free variables: a file that disagrees is malformed, not merely unusual.
    if source[20] != SALT_LEN as u8 || source[21] != NONCE_LEN as u8 {
        return Err(BackupError::HeaderInvalid);
    }
    if u16::from_le_bytes(bytes::<2>(source, 22)?) != 0 {
        return Err(BackupError::HeaderInvalid);
    }

    validate_kdf_params(memory_kib, iterations, parallelism)?;

    let payload_len = u64::from_le_bytes(bytes::<8>(source, 24)?);
    if payload_len < TAG_LEN as u64 || payload_len > MAX_PAYLOAD_LEN {
        return Err(BackupError::PayloadTooLarge);
    }

    Ok(Header {
        format_version,
        kdf,
        aead,
        memory_kib,
        iterations,
        parallelism,
        payload_len,
    })
}

/// Check that the file's actual length matches what its header declares.
///
/// This is what makes truncation and padding detectable without the password.
pub fn check_file_len(header: &Header, file_len: u64) -> Result<(), BackupError> {
    if file_len < header.expected_file_len() {
        return Err(BackupError::FileTruncated);
    }
    if file_len > header.expected_file_len() {
        // Trailing bytes are not part of the format; silently ignoring them
        // would let two different files verify as one backup.
        return Err(BackupError::ContentInvalid);
    }
    Ok(())
}
