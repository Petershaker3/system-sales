//! Automatic backup policy rules (`ADR-027`, `PLAN.md` §17, §19).
//!
//! Pure domain rules for:
//! - Trigger classification and Arabic reason labels (`يدوي`, `فتح وردية #N`,
//!   `تقفيل وردية #N`, `دوري (كل ساعتين)`),
//! - Periodic 2-hour schedule check (`AUTO_BACKUP_INTERVAL_MS`),
//! - Retention and rotation (`MAX_RETAINED_BACKUPS = 30`),
//! - Saved backup identifier validation (preventing path traversal).

use serde::{Deserialize, Serialize};

use super::error::BackupError;

/// Maximum number of automatic/saved backups kept before older ones are rotated out.
pub const MAX_RETAINED_BACKUPS: usize = 30;

/// Interval between periodic automatic backups while running: 2 hours in milliseconds.
pub const AUTO_BACKUP_INTERVAL_MS: i64 = 2 * 60 * 60 * 1000;

/// Expected volume label / directory marker for the backup USB flash drive.
pub const USB_VOLUME_NAME: &str = "MSHOP-BACKUP";

/// Subdirectory inside the USB flash drive where backups and the index are mirrored.
pub const USB_BACKUPS_SUBDIR: &str = "mshop-backups";

/// What triggered a saved backup (`ADR-027` §3.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupTriggerKind {
    Manual,
    ShiftOpen,
    ShiftClose,
    Periodic,
}

impl BackupTriggerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            BackupTriggerKind::Manual => "manual",
            BackupTriggerKind::ShiftOpen => "shift_open",
            BackupTriggerKind::ShiftClose => "shift_close",
            BackupTriggerKind::Periodic => "periodic",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "manual" => Some(BackupTriggerKind::Manual),
            "shift_open" => Some(BackupTriggerKind::ShiftOpen),
            "shift_close" => Some(BackupTriggerKind::ShiftClose),
            "periodic" => Some(BackupTriggerKind::Periodic),
            _ => None,
        }
    }

    /// Standard Arabic reason shown in the «آخر النسخ المحفوظة» table.
    pub fn arabic_reason(self, shift_number: Option<u64>) -> String {
        match (self, shift_number) {
            (BackupTriggerKind::Manual, _) => "يدوي".to_string(),
            (BackupTriggerKind::ShiftOpen, Some(n)) => format!("فتح وردية #{n}"),
            (BackupTriggerKind::ShiftOpen, None) => "فتح وردية".to_string(),
            (BackupTriggerKind::ShiftClose, Some(n)) => format!("تقفيل وردية #{n}"),
            (BackupTriggerKind::ShiftClose, None) => "تقفيل وردية".to_string(),
            (BackupTriggerKind::Periodic, _) => "دوري (كل ساعتين)".to_string(),
        }
    }
}

/// Metadata for one saved backup in `<data_dir>/backups/index.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedBackupEntry {
    pub id: String,
    pub file_name: String,
    pub created_at_unix_ms: i64,
    pub trigger_kind: String,
    pub reason: String,
    pub total_len: u64,
    pub database_len: u64,
    pub image_count: usize,
    pub verified: bool,
    pub usb_copied: bool,
}

/// Whether the 2-hour periodic backup is due at `now_ms`.
pub fn is_periodic_backup_due(last_backup_at_ms: Option<i64>, now_ms: i64) -> bool {
    match last_backup_at_ms {
        None => true,
        Some(last) => now_ms.saturating_sub(last) >= AUTO_BACKUP_INTERVAL_MS,
    }
}

/// Sort saved backups newest-first and split into `(retained, pruned)` according to `max_retained`.
pub fn partition_retained_backups(
    mut entries: Vec<SavedBackupEntry>,
    max_retained: usize,
) -> (Vec<SavedBackupEntry>, Vec<SavedBackupEntry>) {
    entries.sort_by(|a, b| {
        b.created_at_unix_ms
            .cmp(&a.created_at_unix_ms)
            .then_with(|| b.id.cmp(&a.id))
    });
    if entries.len() <= max_retained {
        return (entries, Vec::new());
    }
    let pruned = entries.split_off(max_retained);
    (entries, pruned)
}

/// Validate a saved backup identifier (filename) before joining onto `<data_dir>/backups/`.
pub fn validate_saved_backup_id(raw: &str) -> Result<&str, BackupError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err(BackupError::UnsafePath);
    }
    if !trimmed.ends_with(".msb") {
        return Err(BackupError::UnsafePath);
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.contains(':')
        || trimmed.starts_with('.')
        || trimmed.chars().any(|c| c.is_control())
    {
        return Err(BackupError::UnsafePath);
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(id: &str, ts: i64) -> SavedBackupEntry {
        SavedBackupEntry {
            id: id.to_string(),
            file_name: id.to_string(),
            created_at_unix_ms: ts,
            trigger_kind: "periodic".to_string(),
            reason: "دوري (كل ساعتين)".to_string(),
            total_len: 1024,
            database_len: 512,
            image_count: 1,
            verified: true,
            usb_copied: false,
        }
    }

    #[test]
    fn trigger_reasons_match_approved_arabic_labels() {
        assert_eq!(BackupTriggerKind::Manual.arabic_reason(None), "يدوي");
        assert_eq!(
            BackupTriggerKind::ShiftOpen.arabic_reason(Some(142)),
            "فتح وردية #142"
        );
        assert_eq!(
            BackupTriggerKind::ShiftClose.arabic_reason(Some(141)),
            "تقفيل وردية #141"
        );
        assert_eq!(
            BackupTriggerKind::Periodic.arabic_reason(None),
            "دوري (كل ساعتين)"
        );
    }

    #[test]
    fn periodic_due_check_respects_two_hour_interval() {
        assert!(is_periodic_backup_due(None, 1_000));
        assert!(!is_periodic_backup_due(
            Some(1_000),
            1_000 + AUTO_BACKUP_INTERVAL_MS - 1
        ));
        assert!(is_periodic_backup_due(
            Some(1_000),
            1_000 + AUTO_BACKUP_INTERVAL_MS
        ));
    }

    #[test]
    fn retention_keeps_newest_and_prunes_oldest() {
        assert_eq!(MAX_RETAINED_BACKUPS, 30);
        let entries: Vec<SavedBackupEntry> = (1..=35)
            .map(|i| sample_entry(&format!("backup-{i:02}.msb"), i * 1000))
            .collect();
        let (retained, pruned) = partition_retained_backups(entries, MAX_RETAINED_BACKUPS);
        assert_eq!(retained.len(), 30);
        assert_eq!(pruned.len(), 5);
        assert_eq!(retained[0].id, "backup-35.msb");
        assert_eq!(retained[29].id, "backup-06.msb");
        assert_eq!(pruned[0].id, "backup-05.msb");
        assert_eq!(pruned[4].id, "backup-01.msb");
    }

    #[test]
    fn validate_saved_backup_id_rejects_traversal_and_non_msb() {
        assert_eq!(
            validate_saved_backup_id("backup-1792324800000-a1b2.msb"),
            Ok("backup-1792324800000-a1b2.msb")
        );
        assert_eq!(
            validate_saved_backup_id("../backup.msb"),
            Err(BackupError::UnsafePath)
        );
        assert_eq!(
            validate_saved_backup_id("sub/backup.msb"),
            Err(BackupError::UnsafePath)
        );
        assert_eq!(
            validate_saved_backup_id(".hidden.msb"),
            Err(BackupError::UnsafePath)
        );
        assert_eq!(
            validate_saved_backup_id("backup.db"),
            Err(BackupError::UnsafePath)
        );
    }
}
