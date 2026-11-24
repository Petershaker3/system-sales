//! Key derivation and authenticated encryption for the backup envelope.
//!
//! Byte-level operations, so they live in `services/` rather than `domain/`,
//! exactly as the identity slice keeps Argon2 and SHA-256 here.
//!
//! Every algorithm parameter is named and explicit. A library default that
//! changed between versions would silently alter the security of every backup,
//! and the whole point of recording parameters in the header is that they are
//! reviewable.
//!
//! # Secret handling
//!
//! The derived key is returned inside [`zeroize::Zeroizing`], so it is wiped
//! when it goes out of scope. Callers take the password as a `&str` and copy it
//! into a `Zeroizing<Vec<u8>>` for the duration of the call; the copy is wiped
//! on drop. Nothing here ever formats a key or a password into a string.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::domain::backup::error::BackupError;
use crate::domain::backup::format as fmt;

/// A derived 256-bit key that wipes itself on drop.
pub type DerivedKey = Zeroizing<[u8; fmt::KEY_LEN]>;

/// Fill `N` bytes from the OS CSPRNG.
///
/// An all-zero result is treated as a broken RNG rather than entropy, matching
/// the identity slice's token generation.
pub fn random_bytes<const N: usize>() -> Result<[u8; N], BackupError> {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).map_err(|_| BackupError::CreateFailed)?;
    if out.iter().all(|b| *b == 0) {
        return Err(BackupError::CreateFailed);
    }
    Ok(out)
}

/// Derive the envelope key with Argon2id.
///
/// The KDF parameters are validated against the hard bounds first, so a header
/// read from an untrusted file cannot drive an unbounded allocation.
pub fn derive_key(
    password: &[u8],
    salt: &[u8],
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<DerivedKey, BackupError> {
    fmt::validate_kdf_params(memory_kib, iterations, parallelism)?;

    let params = Params::new(memory_kib, iterations, parallelism, Some(fmt::KEY_LEN))
        .map_err(|_| BackupError::KdfParamsInvalid)?;
    let ctx = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = Zeroizing::new([0u8; fmt::KEY_LEN]);
    ctx.hash_password_into(password, salt, &mut key[..])
        .map_err(|_| BackupError::KdfParamsInvalid)?;
    Ok(key)
}

/// Encrypt the payload, returning ciphertext with the AEAD tag appended.
///
/// `aad` is the 88-byte envelope prefix (header + salt + nonce). Binding it
/// means every metadata byte the format declares is authenticated: changing the
/// version, a KDF parameter, the declared length or the nonce invalidates the
/// tag even though those bytes are not themselves encrypted.
pub fn seal(
    key: &[u8; fmt::KEY_LEN],
    nonce: &[u8; fmt::NONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, BackupError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| BackupError::CreateFailed)?;
    let nonce = XNonce::try_from(&nonce[..]).map_err(|_| BackupError::CreateFailed)?;
    cipher
        .encrypt(&nonce, Payload { msg: plaintext, aad })
        .map_err(|_| BackupError::CreateFailed)
}

/// Decrypt and authenticate the payload.
///
/// A wrong password, a modified header (via `aad`), a modified ciphertext and a
/// truncated body all fail here and collapse to one error on purpose.
pub fn open(
    key: &[u8; fmt::KEY_LEN],
    nonce: &[u8; fmt::NONCE_LEN],
    aad: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, BackupError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| BackupError::DecryptionFailed)?;
    let nonce = XNonce::try_from(&nonce[..]).map_err(|_| BackupError::DecryptionFailed)?;
    cipher
        .decrypt(&nonce, Payload { msg: ciphertext, aad })
        .map_err(|_| BackupError::DecryptionFailed)
}

/// Lowercase hex SHA-256, matching the digest stored in the manifest.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(char::from_digit(u32::from(byte >> 4), 16).expect("nibble is < 16"));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).expect("nibble is < 16"));
    }
    out
}
