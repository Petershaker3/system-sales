//! Automatic backup policy, USB (`MSHOP-BACKUP`) sync, rotation, and PIN-gated restore
//! (`ADR-027`, `PLAN.md` §17, §19).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::data::repositories::settings::app_settings as settings_repo;
use crate::domain::backup::error::BackupError;
use crate::domain::backup::policy::{
    is_periodic_backup_due, partition_retained_backups, validate_saved_backup_id,
    BackupTriggerKind, SavedBackupEntry, MAX_RETAINED_BACKUPS, USB_BACKUPS_SUBDIR,
    USB_VOLUME_NAME,
};
use crate::domain::identity::{DomainError, Permission, Sensitivity, Timestamp};
use crate::services::identity::approval as approval_service;
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

use super::authorized::BackupServiceError;
use super::crypto;
use super::now_ms;
use super::restore::RestoreOutcome;

/// Directory under `<data_dir>` where automatic backups and `index.json` live.
pub const BACKUPS_DIR: &str = "backups";

/// Device-managed 256-bit key file for automatic `.msb` backups.
const AUTO_KEY_FILE: &str = ".auto-key";

/// JSON catalog of saved backups.
const INDEX_FILE: &str = "index.json";
const INDEX_TMP_FILE: &str = ".index.json.tmp";

fn backups_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(BACKUPS_DIR)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).expect("nibble < 16"));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).expect("nibble < 16"));
    }
    out
}

fn atomic_write(target: &Path, tmp_name: &str, bytes: &[u8]) -> Result<(), BackupError> {
    let parent = target.parent().ok_or(BackupError::CreateFailed)?;
    fs::create_dir_all(parent).map_err(|_| BackupError::CreateFailed)?;
    let tmp = parent.join(tmp_name);
    let _ = fs::remove_file(&tmp);
    {
        let mut file = fs::File::create(&tmp).map_err(|_| BackupError::CreateFailed)?;
        file.write_all(bytes).map_err(|_| BackupError::CreateFailed)?;
        file.sync_all().map_err(|_| BackupError::CreateFailed)?;
    }
    let _ = fs::remove_file(target);
    fs::rename(&tmp, target).map_err(|_| BackupError::CreateFailed)?;
    Ok(())
}

/// Detect a connected `MSHOP-BACKUP` USB flash drive (`ADR-027` §3.5).
///
/// Checks:
/// 1. `<data_dir>/MSHOP-BACKUP` (local mount/marker directory, also used by
///    isolated integration tests without cross-test races),
/// 2. Windows drive letters `D:\`..`Z:\` matching volume label `MSHOP-BACKUP`
///    or containing a root `MSHOP-BACKUP` directory,
/// 3. Standard Unix removable media mounts (`/Volumes/MSHOP-BACKUP`,
///    `/mnt/MSHOP-BACKUP`, `/media/MSHOP-BACKUP`, `/media/*/MSHOP-BACKUP`,
///    `/run/media/*/MSHOP-BACKUP`).
pub fn detect_usb_backup_dir(data_dir: &Path) -> Option<PathBuf> {
    let local_marker = data_dir.join(USB_VOLUME_NAME);
    if local_marker.is_dir() {
        return Some(local_marker.join(USB_BACKUPS_SUBDIR));
    }

    #[cfg(target_os = "windows")]
    if let Some(root) = find_windows_usb_volume(USB_VOLUME_NAME) {
        return Some(root.join(USB_BACKUPS_SUBDIR));
    }

    #[cfg(not(target_os = "windows"))]
    if let Some(root) = find_unix_usb_volume(USB_VOLUME_NAME) {
        return Some(root.join(USB_BACKUPS_SUBDIR));
    }

    None
}

#[cfg(target_os = "windows")]
fn find_windows_usb_volume(target_label: &str) -> Option<PathBuf> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetVolumeInformationW(
            lp_root_path_name: *const u16,
            lp_volume_name_buffer: *mut u16,
            n_volume_name_size: u32,
            lp_volume_serial_number: *mut u32,
            lp_maximum_component_length: *mut u32,
            lp_file_system_flags: *mut u32,
            lp_file_system_name_buffer: *mut u16,
            n_file_system_name_size: u32,
        ) -> i32;
    }

    for letter in b'D'..=b'Z' {
        let drive = format!("{}:\\", letter as char);
        let root_path = PathBuf::from(&drive);
        let marker = root_path.join(target_label);
        if marker.is_dir() {
            return Some(marker);
        }
        let wide: Vec<u16> = drive.encode_utf16().chain(std::iter::once(0)).collect();
        let mut label_buf = [0u16; 261];
        let ok = unsafe {
            GetVolumeInformationW(
                wide.as_ptr(),
                label_buf.as_mut_ptr(),
                label_buf.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
            )
        };
        if ok != 0 {
            let end = label_buf
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(label_buf.len());
            if let Ok(label) = String::from_utf16(&label_buf[..end]) {
                if label.trim().eq_ignore_ascii_case(target_label) {
                    return Some(root_path);
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn find_unix_usb_volume(target_label: &str) -> Option<PathBuf> {
    for direct in ["/Volumes", "/mnt", "/media"] {
        let candidate = Path::new(direct).join(target_label);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    for parent in ["/media", "/run/media"] {
        let Ok(entries) = fs::read_dir(parent) else {
            continue;
        };
        for entry in entries.flatten() {
            let candidate = entry.path().join(target_label);
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Load or generate the 256-bit automatic backup key (`<data_dir>/backups/.auto-key`).
fn load_or_create_auto_key(data_dir: &Path) -> Result<String, BackupError> {
    let dir = backups_dir(data_dir);
    let key_path = dir.join(AUTO_KEY_FILE);
    if let Ok(existing) = fs::read_to_string(&key_path) {
        let trimmed = existing.trim();
        if trimmed.len() >= 16 {
            return Ok(trimmed.to_string());
        }
    }

    if let Some(usb_dir) = detect_usb_backup_dir(data_dir) {
        if let Ok(usb_key) = fs::read_to_string(usb_dir.join(AUTO_KEY_FILE)) {
            let trimmed = usb_key.trim();
            if trimmed.len() >= 16 {
                let _ = atomic_write(&key_path, ".auto-key.tmp", trimmed.as_bytes());
                return Ok(trimmed.to_string());
            }
        }
    }

    let raw = crypto::random_bytes::<32>()?;
    let hex_key = hex_encode(&raw);
    atomic_write(&key_path, ".auto-key.tmp", hex_key.as_bytes())?;
    Ok(hex_key)
}

/// Read the saved backups catalog, keeping entries whose `.msb` file exists on disk or USB.
pub fn list_saved_backups(data_dir: &Path) -> Vec<SavedBackupEntry> {
    let dir = backups_dir(data_dir);
    let usb_dir = detect_usb_backup_dir(data_dir);

    let mut entries: Vec<SavedBackupEntry> = fs::read(dir.join(INDEX_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();

    if entries.is_empty() {
        if let Some(ref usb) = usb_dir {
            entries = fs::read(usb.join(INDEX_FILE))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
        }
    }

    entries.retain(|entry| {
        if validate_saved_backup_id(&entry.file_name).is_err() {
            return false;
        }
        let local_exists = dir.join(&entry.file_name).is_file();
        let usb_exists = usb_dir
            .as_ref()
            .map(|u| u.join(&entry.file_name).is_file())
            .unwrap_or(false);
        local_exists || usb_exists
    });

    entries.sort_by(|a, b| {
        b.created_at_unix_ms
            .cmp(&a.created_at_unix_ms)
            .then_with(|| b.id.cmp(&a.id))
    });
    entries
}

fn save_index(data_dir: &Path, entries: &[SavedBackupEntry]) -> Result<(), BackupError> {
    let dir = backups_dir(data_dir);
    let json = serde_json::to_vec_pretty(entries).map_err(|_| BackupError::CreateFailed)?;
    atomic_write(&dir.join(INDEX_FILE), INDEX_TMP_FILE, &json)?;
    if let Some(usb_dir) = detect_usb_backup_dir(data_dir) {
        if usb_dir.exists() {
            let _ = atomic_write(&usb_dir.join(INDEX_FILE), INDEX_TMP_FILE, &json);
        }
    }
    Ok(())
}

fn copy_file_to_usb(data_dir: &Path, usb_dir: &Path, file_name: &str) -> Result<(), BackupError> {
    let src = backups_dir(data_dir).join(file_name);
    let bytes = fs::read(&src).map_err(|_| BackupError::CreateFailed)?;
    fs::create_dir_all(usb_dir).map_err(|_| BackupError::CreateFailed)?;

    let dst = usb_dir.join(file_name);
    let tmp_name = format!(".{file_name}.partial");
    atomic_write(&dst, &tmp_name, &bytes)?;

    let key_src = backups_dir(data_dir).join(AUTO_KEY_FILE);
    if let Ok(key_bytes) = fs::read(&key_src) {
        let _ = atomic_write(&usb_dir.join(AUTO_KEY_FILE), ".auto-key.tmp", &key_bytes);
    }
    Ok(())
}

/// Create an automatic or one-click backup with an explicit retention cap (`ADR-027`).
pub async fn create_auto_backup_with_limit(
    pool: &SqlitePool,
    data_dir: &Path,
    trigger: BackupTriggerKind,
    shift_number: Option<u64>,
    max_retained: usize,
) -> Result<SavedBackupEntry, BackupError> {
    let appearance = {
        let mut conn = pool
            .acquire()
            .await
            .map_err(|_| BackupError::CreateFailed)?;
        settings_repo::load_appearance(&mut conn)
            .await
            .unwrap_or_default()
    };

    let auto_key = load_or_create_auto_key(data_dir)?;
    let dir = backups_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|_| BackupError::CreateFailed)?;

    let suffix = hex_encode(&crypto::random_bytes::<4>()?);
    let stamp = now_ms();
    let file_name = format!("backup-{stamp}-{suffix}.msb");
    let output_path = dir.join(&file_name);

    let report = super::create_backup(pool, data_dir, &output_path, &auto_key).await?;

    let verified = if appearance.backup_verify == "on" {
        match super::verify_backup(&output_path, &auto_key) {
            Ok(_) => true,
            Err(err) => {
                let _ = fs::remove_file(&output_path);
                return Err(err);
            }
        }
    } else {
        true
    };

    let mut usb_copied = false;
    if appearance.backup_usb_auto == "on" {
        if let Some(usb_dir) = detect_usb_backup_dir(data_dir) {
            if copy_file_to_usb(data_dir, &usb_dir, &file_name).is_ok() {
                usb_copied = true;
            }
        }
    }

    let entry = SavedBackupEntry {
        id: file_name.clone(),
        file_name,
        created_at_unix_ms: report.created_at_unix_ms,
        trigger_kind: trigger.as_str().to_string(),
        reason: trigger.arabic_reason(shift_number),
        total_len: report.total_len,
        database_len: report.database_len,
        image_count: report.image_count,
        verified,
        usb_copied,
    };

    let mut existing = list_saved_backups(data_dir);
    existing.retain(|e| e.id != entry.id);
    existing.push(entry.clone());

    let (retained, pruned) = partition_retained_backups(existing, max_retained.max(1));
    for old in pruned {
        let _ = fs::remove_file(dir.join(&old.file_name));
    }
    save_index(data_dir, &retained)?;

    Ok(entry)
}

/// Create an automatic or one-click backup retaining at most [`MAX_RETAINED_BACKUPS`] (30) entries.
pub async fn create_auto_backup(
    pool: &SqlitePool,
    data_dir: &Path,
    trigger: BackupTriggerKind,
    shift_number: Option<u64>,
) -> Result<SavedBackupEntry, BackupError> {
    create_auto_backup_with_limit(pool, data_dir, trigger, shift_number, MAX_RETAINED_BACKUPS).await
}

/// Trigger an automatic backup on shift open (`is_open = true`) or shift close (`is_open = false`)
/// if `ui.backup_on_shift == "on"` (`ADR-027` §2).
pub async fn trigger_shift_backup(
    pool: &SqlitePool,
    data_dir: &Path,
    shift_number: u64,
    is_open: bool,
) -> Result<Option<SavedBackupEntry>, BackupError> {
    let appearance = {
        let mut conn = pool
            .acquire()
            .await
            .map_err(|_| BackupError::CreateFailed)?;
        settings_repo::load_appearance(&mut conn)
            .await
            .unwrap_or_default()
    };
    if appearance.backup_on_shift != "on" {
        return Ok(None);
    }
    let trigger = if is_open {
        BackupTriggerKind::ShiftOpen
    } else {
        BackupTriggerKind::ShiftClose
    };
    let entry = create_auto_backup(pool, data_dir, trigger, Some(shift_number)).await?;
    Ok(Some(entry))
}

/// Run the background periodic backup and USB auto-sync check (`ADR-027` §3.4, §3.5):
/// 1. If `ui.backup_usb_auto == "on"` and `MSHOP-BACKUP` is connected, copies the
///    latest backup onto the USB drive if it has not been copied yet.
/// 2. If `ui.backup_every_2h == "on"` and at least 2 hours have elapsed since the
///    last backup, creates a new `"دوري (كل ساعتين)"` backup.
pub async fn run_periodic_backup_tick(
    pool: &SqlitePool,
    data_dir: &Path,
) -> Result<Option<SavedBackupEntry>, BackupError> {
    let appearance = {
        let mut conn = pool
            .acquire()
            .await
            .map_err(|_| BackupError::CreateFailed)?;
        settings_repo::load_appearance(&mut conn)
            .await
            .unwrap_or_default()
    };

    let mut entries = list_saved_backups(data_dir);
    let mut usb_synced_entry: Option<SavedBackupEntry> = None;

    if appearance.backup_usb_auto == "on" {
        if let Some(usb_dir) = detect_usb_backup_dir(data_dir) {
            if let Some(latest) = entries.first_mut() {
                if !latest.usb_copied
                    && copy_file_to_usb(data_dir, &usb_dir, &latest.file_name).is_ok()
                {
                    latest.usb_copied = true;
                    usb_synced_entry = Some(latest.clone());
                    let _ = save_index(data_dir, &entries);
                }
            }
        }
    }

    if appearance.backup_every_2h == "on" {
        let last_ts = entries.first().map(|e| e.created_at_unix_ms);
        if is_periodic_backup_due(last_ts, now_ms()) {
            let created =
                create_auto_backup(pool, data_dir, BackupTriggerKind::Periodic, None).await?;
            return Ok(Some(created));
        }
    }

    Ok(usb_synced_entry)
}

/// Authorized: list saved backups for the Settings screen.
pub async fn list_saved_backups_authorized(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    data_dir: &Path,
) -> Result<Vec<SavedBackupEntry>, BackupServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    Ok(list_saved_backups(data_dir))
}

/// Authorized: create a manual backup right now («خد نسخة دلوقتي»).
pub async fn create_auto_backup_now_authorized(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    data_dir: &Path,
) -> Result<SavedBackupEntry, BackupServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    let entry = create_auto_backup(pool, data_dir, BackupTriggerKind::Manual, None).await?;
    Ok(entry)
}

/// Authorized: copy the latest backup to the `MSHOP-BACKUP` USB flash drive («انسخ على فلاشة»).
pub async fn copy_latest_backup_to_usb_authorized(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    data_dir: &Path,
) -> Result<SavedBackupEntry, BackupServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;

    let usb_dir = detect_usb_backup_dir(data_dir).ok_or(BackupError::UsbNotConnected)?;

    let mut entries = list_saved_backups(data_dir);
    if entries.is_empty() {
        let created = create_auto_backup(pool, data_dir, BackupTriggerKind::Manual, None).await?;
        entries = vec![created];
    }

    let latest = entries.first_mut().ok_or(BackupError::BackupNotFound)?;
    copy_file_to_usb(data_dir, &usb_dir, &latest.file_name)?;
    latest.usb_copied = true;
    let updated = latest.clone();
    save_index(data_dir, &entries)?;
    Ok(updated)
}

/// Authorized: restore a saved backup from `<data_dir>/backups/` (or `MSHOP-BACKUP`)
/// after verifying Owner PIN approval (`Sensitivity::Sensitive`) and package integrity.
pub async fn restore_saved_backup_authorized(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    data_dir: &Path,
    backup_id: &str,
) -> Result<RestoreOutcome, BackupServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    let now = Timestamp::now();
    let approval = session.require_sensitivity(Sensitivity::Sensitive, now)?;

    let clean_id = validate_saved_backup_id(backup_id)?;
    let local_path = backups_dir(data_dir).join(clean_id);
    let backup_path = if local_path.is_file() {
        local_path
    } else if let Some(usb_dir) = detect_usb_backup_dir(data_dir) {
        let usb_path = usb_dir.join(clean_id);
        if usb_path.is_file() {
            usb_path
        } else {
            return Err(BackupError::BackupNotFound.into());
        }
    } else {
        return Err(BackupError::BackupNotFound.into());
    };

    let auto_key = load_or_create_auto_key(data_dir)?;
    // Verify integrity BEFORE spending the approval or closing the live pool.
    super::verify_backup(&backup_path, &auto_key)?;

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let _approved_by = approval_service::consume_in_tx(&mut tx, &session, approval)
        .await?
        .ok_or(DomainError::OwnerApprovalRequired)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    pool.close().await;
    let outcome = super::restore_backup(data_dir, &backup_path, &auto_key)?;
    Ok(outcome)
}

/// Authorized: run the periodic backup / USB auto-sync tick while signed in.
pub async fn run_periodic_backup_tick_authorized(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    data_dir: &Path,
) -> Result<Option<SavedBackupEntry>, BackupServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;
    let res = run_periodic_backup_tick(pool, data_dir).await?;
    Ok(res)
}
