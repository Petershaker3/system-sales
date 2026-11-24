//! Producing a backup file from the live device.
//!
//! # Why the database is snapshotted with `VACUUM INTO`
//!
//! The live database runs in WAL mode, so `shop.db` alone is not the whole
//! database: recent commits may live in `shop.db-wal`. Copying the file while
//! the connection is open would capture a state that is neither the old nor the
//! new one, and the WAL is not part of the package.
//!
//! `VACUUM INTO` asks SQLite itself to write a consistent, standalone copy of
//! the database to a new file. The copy has no WAL, so what the envelope carries
//! is exactly the database the device would see. This is the supported way to
//! snapshot a live SQLite database, not a file copy in disguise.

use std::fs;
use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use zeroize::Zeroizing;

use crate::domain::backup::error::BackupError;
use crate::domain::backup::format::{
    self as fmt, Header, MAX_COMPONENT_COUNT, MAX_COMPONENT_LEN, MAX_TOTAL_UNCOMPRESSED, TAG_LEN,
};
use crate::domain::backup::manifest::{
    classify_component_path, ComponentMeta, Manifest, DB_COMPONENT, IMAGES_PREFIX,
};

use super::container;
use super::crypto;
use super::journal::{self, WorkSpace};
use super::{check_password, now_ms};

/// What a completed backup contains, for reporting without exposing secrets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupReport {
    pub path: PathBuf,
    pub database_len: u64,
    pub image_count: usize,
    pub total_len: u64,
    pub created_at_unix_ms: i64,
}

/// Write a consistent copy of the live database to `dest`.
///
/// `dest` must not already exist; SQLite refuses to overwrite. The caller owns
/// the file afterwards.
pub async fn snapshot_database(pool: &SqlitePool, dest: &Path) -> Result<(), BackupError> {
    let dest = dest
        .to_str()
        .ok_or(BackupError::CreateFailed)?
        .to_string();
    sqlx::query("VACUUM INTO ?1")
        .bind(dest)
        .execute(pool)
        .await
        .map_err(|_| BackupError::CreateFailed)?;
    Ok(())
}

/// Read the image directory into component form.
fn collect_images(images_dir: &Path) -> Result<Vec<(String, Vec<u8>)>, BackupError> {
    fn walk(
        dir: &Path,
        rel: &str,
        out: &mut Vec<(String, Vec<u8>)>,
    ) -> Result<(), BackupError> {
        let mut entries: Vec<_> = fs::read_dir(dir)
            .map_err(|_| BackupError::CreateFailed)?
            .flatten()
            .map(|e| (e.file_name(), e.path()))
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        for (name, path) in entries {
            let name = name.to_string_lossy().to_string();
            let file_type = fs::symlink_metadata(&path).map_err(|_| BackupError::CreateFailed)?;
            // `symlink_metadata` does not follow links, so a symlink is neither
            // `is_file` nor `is_dir` here and is skipped: a backup must not
            // escape its own directory through a link.
            if file_type.is_dir() {
                walk(&path, &format!("{rel}{name}/"), out)?;
            } else if file_type.is_file() {
                let component = format!("{IMAGES_PREFIX}{rel}{name}");
                classify_component_path(&component)?;
                let bytes = fs::read(&path).map_err(|_| BackupError::CreateFailed)?;
                if bytes.is_empty() || bytes.len() as u64 > MAX_COMPONENT_LEN {
                    return Err(BackupError::CreateFailed);
                }
                out.push((component, bytes));
                if out.len() > MAX_COMPONENT_COUNT {
                    return Err(BackupError::CreateFailed);
                }
            }
        }
        Ok(())
    }

    let mut out = Vec::new();
    if fs::symlink_metadata(images_dir).is_err() {
        return Ok(out);
    }
    walk(images_dir, "", &mut out)?;
    Ok(out)
}

/// Write `bytes` to `output`, replacing it if present.
fn write_output(output: &Path, bytes: &[u8]) -> Result<(), BackupError> {
    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|_| BackupError::CreateFailed)?;
    let file_name = output
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(BackupError::CreateFailed)?;
    let tmp = parent.join(format!(".{file_name}.partial"));
    let _ = fs::remove_file(&tmp);
    {
        use std::io::Write;
        let mut file = fs::File::create(&tmp).map_err(|_| BackupError::CreateFailed)?;
        file.write_all(bytes).map_err(|_| BackupError::CreateFailed)?;
        file.sync_all().map_err(|_| BackupError::CreateFailed)?;
    }
    // Windows rename fails if the destination exists, so clear it first. A
    // crash in this window cannot corrupt anything that is not this output
    // file, and the backup is written again on the next attempt.
    let _ = fs::remove_file(output);
    fs::rename(&tmp, output).map_err(|_| BackupError::CreateFailed)?;
    Ok(())
}

/// Create an encrypted backup of `data_dir`'s database and images.
///
/// `pool` must be the live database connection; it is used only to take a
/// consistent snapshot. Nothing here mutates the device.
pub async fn create_backup(
    pool: &SqlitePool,
    data_dir: &Path,
    output: &Path,
    password: &str,
) -> Result<BackupReport, BackupError> {
    check_password(password)?;
    // The password is copied once, used, and wiped. The caller's `&str` is
    // borrowed and cannot be wiped here; callers should drop it promptly.
    let secret = Zeroizing::new(password.as_bytes().to_vec());

    let work = WorkSpace::new(data_dir);
    fs::create_dir_all(&work.root).map_err(|_| BackupError::CreateFailed)?;

    // 1. Consistent database snapshot.
    let snapshot = work.root.join(format!(
        "snapshot-{}.db",
        hex_suffix(&crypto::random_bytes::<8>()?)
    ));
    let _ = fs::remove_file(&snapshot);
    snapshot_database(pool, &snapshot).await?;
    let database = fs::read(&snapshot).map_err(|_| BackupError::CreateFailed)?;
    let _ = fs::remove_file(&snapshot);
    // Leave no work area behind. `remove_dir` only succeeds if the directory is
    // empty, so this can never delete a restore's journal or snapshot.
    let _ = fs::remove_dir(&work.root);
    if database.is_empty() || database.len() as u64 > MAX_COMPONENT_LEN {
        return Err(BackupError::CreateFailed);
    }

    // 2. Images.
    let images = collect_images(&data_dir.join(journal::IMAGES_DIR))?;

    // 3. Manifest and container.
    let created_at_unix_ms = now_ms();
    let mut total = database.len() as u64;
    let mut image_metas = Vec::with_capacity(images.len());
    for (path, bytes) in &images {
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or(BackupError::CreateFailed)?;
        image_metas.push(ComponentMeta {
            path: path.clone(),
            len: bytes.len() as u64,
            sha256: crypto::sha256_hex(bytes),
        });
    }
    if total > MAX_TOTAL_UNCOMPRESSED {
        return Err(BackupError::CreateFailed);
    }

    let manifest = Manifest {
        format_version: fmt::FORMAT_VERSION,
        created_at_unix_ms,
        database: ComponentMeta {
            path: DB_COMPONENT.to_string(),
            len: database.len() as u64,
            sha256: crypto::sha256_hex(&database),
        },
        images: image_metas,
        uncompressed_len: total,
    };

    let mut components: Vec<(String, Vec<u8>)> = Vec::with_capacity(images.len() + 1);
    components.push((DB_COMPONENT.to_string(), database));
    components.extend(images);
    let plaintext = container::pack(&manifest, &components)?;

    // 4. Envelope. payload_len must be known before the header is built,
    //    because the header is authenticated data.
    let salt = crypto::random_bytes::<{ fmt::SALT_LEN }>()?;
    let nonce = crypto::random_bytes::<{ fmt::NONCE_LEN }>()?;
    let payload_len = plaintext.len() as u64 + TAG_LEN as u64;
    let header = Header::new_v1(payload_len);

    let mut prefix = Vec::with_capacity(fmt::AAD_LEN);
    prefix.extend_from_slice(&header.encode());
    prefix.extend_from_slice(&salt);
    prefix.extend_from_slice(&nonce);

    let key = crypto::derive_key(
        &secret,
        &salt,
        header.memory_kib,
        header.iterations,
        header.parallelism,
    )?;
    let ciphertext = crypto::seal(&key, &nonce, &prefix, &plaintext)?;

    let mut file = prefix;
    file.extend_from_slice(&ciphertext);
    write_output(output, &file)?;

    Ok(BackupReport {
        path: output.to_path_buf(),
        database_len: manifest.database.len,
        image_count: manifest.images.len(),
        total_len: file.len() as u64,
        created_at_unix_ms,
    })
}

fn hex_suffix(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).expect("nibble is < 16"));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).expect("nibble is < 16"));
    }
    out
}
