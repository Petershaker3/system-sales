//! Encrypted backup and crash-safe restore, against real files on disk.
//!
//! Every case here uses an isolated temporary directory. Nothing touches a real
//! device database, and the password never leaves the test.
//!
//! The four groups are: a successful round trip; a package that must be
//! refused; a restore that must not modify the device; and an interrupted
//! restore, checked at each state a crash could leave behind.

use std::fs;
use std::path::Path;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::backup::error::BackupError;
use mobile_shop_system_lib::domain::backup::format::{self as fmt, Header};
use mobile_shop_system_lib::services::backup::journal::{
    self, Journal, Phase, WorkSpace, DB_FILE, IMAGES_DIR, LAYOUT_VERSION,
};
use mobile_shop_system_lib::services::backup::{self, crypto, RecoveryOutcome};
use mobile_shop_system_lib::services::identity::bootstrap;
use sqlx::SqlitePool;
use tempfile::TempDir;

/// Long enough to satisfy the backup password floor, and not a real secret.
const BACKUP_PASSWORD: &str = "backup pass phrase";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// A file-backed shop with a little real content and one image.
async fn shop_with_data(dir: &Path) -> SqlitePool {
    let pool = db::open(&dir.join("shop.db")).await.expect("open database");
    bootstrap::create_first_manager(&pool, "Peter", "correct horse battery")
        .await
        .expect("first manager");

    // A table the test owns, so the assertion does not depend on a slice's
    // schema: it only has to survive a backup and a restore.
    sqlx::query("CREATE TABLE test_marker (id INTEGER PRIMARY KEY, note TEXT NOT NULL)")
        .execute(&pool)
        .await
        .expect("marker table");
    sqlx::query("INSERT INTO test_marker (id, note) VALUES (1, 'original')")
        .execute(&pool)
        .await
        .expect("marker row");

    fs::create_dir_all(dir.join("images")).expect("images directory");
    fs::write(dir.join("images").join("logo.png"), b"PNG-ORIGINAL").expect("image");

    pool
}

async fn marker_notes(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar("SELECT note FROM test_marker ORDER BY id")
        .fetch_all(pool)
        .await
        .expect("markers")
}

/// Build a plaintext container by hand, for packages `pack` would refuse.
fn container_bytes(manifest_json: &str, entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(manifest_json.len() as u32).to_le_bytes());
    out.extend_from_slice(manifest_json.as_bytes());
    for (path, bytes) in entries {
        out.extend_from_slice(&(path.len() as u16).to_le_bytes());
        out.extend_from_slice(path.as_bytes());
        out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

/// Wrap arbitrary plaintext in a correctly formed, encrypted envelope.
fn craft_envelope(password: &str, plaintext: &[u8]) -> Vec<u8> {
    let salt = [7u8; fmt::SALT_LEN];
    let nonce = [9u8; fmt::NONCE_LEN];
    let header = Header::new_v1(plaintext.len() as u64 + fmt::TAG_LEN as u64);

    let mut prefix = Vec::new();
    prefix.extend_from_slice(&header.encode());
    prefix.extend_from_slice(&salt);
    prefix.extend_from_slice(&nonce);

    let key = crypto::derive_key(
        password.as_bytes(),
        &salt,
        header.memory_kib,
        header.iterations,
        header.parallelism,
    )
    .expect("derived key");
    let ciphertext = crypto::seal(&key, &nonce, &prefix, plaintext).expect("sealed payload");

    let mut out = prefix;
    out.extend_from_slice(&ciphertext);
    out
}

fn manifest_json(database_path: &str, db_len: u64, images: &[(&str, u64)], total: u64) -> String {
    let digest = "0".repeat(64);
    let images: Vec<serde_json::Value> = images
        .iter()
        .map(|(path, len)| {
            serde_json::json!({ "path": path, "len": len, "sha256": digest })
        })
        .collect();
    serde_json::json!({
        "format_version": 1,
        "created_at_unix_ms": 0,
        "database": { "path": database_path, "len": db_len, "sha256": digest },
        "images": images,
        "uncompressed_len": total,
    })
    .to_string()
}

/// Restore `bytes` as a package and assert it is refused with `expected`.
fn restore_expects(dir: &Path, bytes: &[u8], expected: BackupError) {
    let path = dir.join("crafted.msb");
    fs::write(&path, bytes).expect("write package");
    let error = backup::restore_backup(dir, &path, BACKUP_PASSWORD).expect_err("must be refused");
    assert_eq!(error, expected);
}

// ---------------------------------------------------------------------------
// A successful round trip
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_backup_round_trips_the_database_and_images() {
    let dir = TempDir::new().expect("temp dir");
    let pool = shop_with_data(dir.path()).await;
    let backup_path = dir.path().join("nightly.msb");

    let report = backup::create_backup(&pool, dir.path(), &backup_path, BACKUP_PASSWORD)
        .await
        .expect("create backup");
    assert_eq!(report.image_count, 1);
    assert!(report.database_len > 0);
    assert!(backup_path.exists());

    // Change the device after the backup. The restore must undo every change.
    sqlx::query("DELETE FROM test_marker")
        .execute(&pool)
        .await
        .expect("delete marker");
    fs::write(dir.path().join("images").join("extra.png"), b"EXTRA").expect("extra image");
    fs::remove_file(dir.path().join("images").join("logo.png")).expect("remove logo");
    pool.close().await;

    let outcome =
        backup::restore_backup(dir.path(), &backup_path, BACKUP_PASSWORD).expect("restore");
    assert_eq!(outcome.image_count, 1);

    // The restore leaves no WAL sidecar next to the replaced database, and no
    // work area behind.
    assert!(!dir.path().join("shop.db-wal").exists());
    assert!(!dir.path().join("shop.db-shm").exists());
    assert!(!dir.path().join(journal::WORK_DIR).exists());

    let reopened = db::open(&dir.path().join("shop.db"))
        .await
        .expect("reopen database");
    assert_eq!(marker_notes(&reopened).await, vec!["original".to_string()]);
    assert_eq!(
        fs::read(dir.path().join("images").join("logo.png")).expect("logo"),
        b"PNG-ORIGINAL"
    );
    assert!(
        !dir.path().join("images").join("extra.png").exists(),
        "an image added after the backup must not survive the restore"
    );
}

// ---------------------------------------------------------------------------
// ADR-011 hands the WAL-aware snapshot capability, and its WAL testing, to
// this slice. A backup must capture committed state that still lives only in
// the write-ahead log, because `shop.db` on its own does not contain it.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_snapshot_captures_data_that_lives_only_in_the_wal() {
    let dir = TempDir::new().expect("temp dir");
    let pool = db::open(&dir.path().join("shop.db"))
        .await
        .expect("open database");
    bootstrap::create_first_manager(&pool, "Peter", "correct horse battery")
        .await
        .expect("first manager");

    // Hold one connection and switch off automatic checkpointing on it, so the
    // rows below stay in the WAL instead of being folded back into shop.db.
    // The rows are committed either way; only their *location* differs.
    let mut conn = pool.acquire().await.expect("connection");
    sqlx::query("PRAGMA wal_autocheckpoint=0")
        .execute(&mut *conn)
        .await
        .expect("disable autocheckpoint");
    sqlx::query("CREATE TABLE wal_marker (id INTEGER PRIMARY KEY, note TEXT NOT NULL)")
        .execute(&mut *conn)
        .await
        .expect("marker table");
    for id in 1..=64 {
        sqlx::query("INSERT INTO wal_marker (id, note) VALUES (?1, ?2)")
            .bind(id)
            .bind("committed-into-the-wal")
            .execute(&mut *conn)
            .await
            .expect("marker row");
    }

    // Premise check, not decoration: if the WAL were empty this test would pass
    // vacuously, because the rows would already be inside shop.db.
    let wal_len = fs::metadata(dir.path().join("shop.db-wal"))
        .map(|m| m.len())
        .unwrap_or(0);
    assert!(
        wal_len > 0,
        "the premise needs committed frames to still be in the WAL"
    );
    drop(conn);

    let backup_path = dir.path().join("wal.msb");
    backup::create_backup(&pool, dir.path(), &backup_path, BACKUP_PASSWORD)
        .await
        .expect("create backup");
    pool.close().await;

    backup::restore_backup(dir.path(), &backup_path, BACKUP_PASSWORD).expect("restore");

    // ADR-011: a stale write-ahead log beside the database is the hazard. The
    // restore must not leave the pre-restore sidecars behind. Checked *before*
    // reopening, because opening in WAL mode creates the sidecars again.
    assert!(
        !dir.path().join("shop.db-wal").exists(),
        "a stale write-ahead log must not survive the restore"
    );
    assert!(
        !dir.path().join("shop.db-shm").exists(),
        "a stale shared-memory file must not survive the restore"
    );

    let reopened = db::open(&dir.path().join("shop.db"))
        .await
        .expect("reopen database");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM wal_marker")
        .fetch_one(&reopened)
        .await
        .expect("count markers");
    assert_eq!(
        count, 64,
        "state committed only into the WAL must be in the snapshot"
    );
}

#[tokio::test]
async fn a_restored_database_is_openable_and_migrated() {
    let dir = TempDir::new().expect("temp dir");
    let pool = shop_with_data(dir.path()).await;
    let backup_path = dir.path().join("b.msb");
    backup::create_backup(&pool, dir.path(), &backup_path, BACKUP_PASSWORD)
        .await
        .expect("create backup");
    pool.close().await;

    backup::restore_backup(dir.path(), &backup_path, BACKUP_PASSWORD).expect("restore");
    let reopened = db::open(&dir.path().join("shop.db"))
        .await
        .expect("reopen database");
    assert!(bootstrap::bootstrap_needed(&reopened)
        .await
        .expect("bootstrap check")
        .eq(&false));
}

#[tokio::test]
async fn a_shop_with_no_images_still_round_trips() {
    let dir = TempDir::new().expect("temp dir");
    let pool = db::open(&dir.path().join("shop.db"))
        .await
        .expect("open database");
    bootstrap::create_first_manager(&pool, "Peter", "correct horse battery")
        .await
        .expect("manager");

    let backup_path = dir.path().join("b.msb");
    let report = backup::create_backup(&pool, dir.path(), &backup_path, BACKUP_PASSWORD)
        .await
        .expect("create backup");
    assert_eq!(report.image_count, 0);
    pool.close().await;

    backup::restore_backup(dir.path(), &backup_path, BACKUP_PASSWORD).expect("restore");
    db::open(&dir.path().join("shop.db"))
        .await
        .expect("reopen database");
}

// ---------------------------------------------------------------------------
// A package that must be refused
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_wrong_password_is_refused_and_the_device_is_untouched() {
    let dir = TempDir::new().expect("temp dir");
    let pool = shop_with_data(dir.path()).await;
    let backup_path = dir.path().join("b.msb");
    backup::create_backup(&pool, dir.path(), &backup_path, BACKUP_PASSWORD)
        .await
        .expect("create backup");
    pool.close().await;

    let before = fs::read(dir.path().join("shop.db")).expect("read db");
    let error = backup::restore_backup(dir.path(), &backup_path, "not the password")
        .expect_err("wrong password");
    assert_eq!(error, BackupError::DecryptionFailed);
    assert_eq!(fs::read(dir.path().join("shop.db")).expect("read db"), before);
    assert!(!dir.path().join(journal::WORK_DIR).exists());
}

#[tokio::test]
async fn a_modified_ciphertext_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    let pool = shop_with_data(dir.path()).await;
    let backup_path = dir.path().join("b.msb");
    backup::create_backup(&pool, dir.path(), &backup_path, BACKUP_PASSWORD)
        .await
        .expect("create backup");
    pool.close().await;

    let mut bytes = fs::read(&backup_path).expect("read package");
    let last = bytes.len() - 1;
    bytes[last] ^= 0x01;
    restore_expects(dir.path(), &bytes, BackupError::DecryptionFailed);
}

#[tokio::test]
async fn a_modified_authenticated_header_field_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    let pool = shop_with_data(dir.path()).await;
    let backup_path = dir.path().join("b.msb");
    backup::create_backup(&pool, dir.path(), &backup_path, BACKUP_PASSWORD)
        .await
        .expect("create backup");
    pool.close().await;

    // Bump memory_kib by one. Still a legal parameter, so the header parses and
    // the length still matches — but the header is associated data, so the tag
    // no longer verifies. This is what proves the metadata is authenticated.
    let mut bytes = fs::read(&backup_path).expect("read package");
    bytes[8] = bytes[8].wrapping_add(1);
    restore_expects(dir.path(), &bytes, BackupError::DecryptionFailed);
}

#[tokio::test]
async fn a_truncated_file_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    let pool = shop_with_data(dir.path()).await;
    let backup_path = dir.path().join("b.msb");
    backup::create_backup(&pool, dir.path(), &backup_path, BACKUP_PASSWORD)
        .await
        .expect("create backup");
    pool.close().await;

    let mut bytes = fs::read(&backup_path).expect("read package");
    bytes.pop();
    restore_expects(dir.path(), &bytes, BackupError::FileTruncated);
}

#[tokio::test]
async fn a_future_version_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    let pool = shop_with_data(dir.path()).await;
    let backup_path = dir.path().join("b.msb");
    backup::create_backup(&pool, dir.path(), &backup_path, BACKUP_PASSWORD)
        .await
        .expect("create backup");
    pool.close().await;

    let mut bytes = fs::read(&backup_path).expect("read package");
    bytes[4..6].copy_from_slice(&2u16.to_le_bytes());
    restore_expects(dir.path(), &bytes, BackupError::UnsupportedVersion);
}

#[tokio::test]
async fn an_unknown_algorithm_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    let pool = shop_with_data(dir.path()).await;
    let backup_path = dir.path().join("b.msb");
    backup::create_backup(&pool, dir.path(), &backup_path, BACKUP_PASSWORD)
        .await
        .expect("create backup");
    pool.close().await;

    let mut bytes = fs::read(&backup_path).expect("read package");
    bytes[7] = 42;
    restore_expects(dir.path(), &bytes, BackupError::UnsupportedAlgorithm);
}

#[tokio::test]
async fn out_of_bounds_kdf_parameters_are_refused_before_deriving() {
    let dir = TempDir::new().expect("temp dir");
    let plaintext = container_bytes(
        &manifest_json("shop.db", 5, &[], 5),
        &[("shop.db", b"hello")],
    );
    let mut bytes = craft_envelope(BACKUP_PASSWORD, &plaintext);

    // A header that would ask this device to allocate 4 GiB for one Argon2 run.
    bytes[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
    restore_expects(dir.path(), &bytes, BackupError::KdfParamsInvalid);
}

#[tokio::test]
async fn an_unsafe_component_path_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    let manifest = manifest_json("shop.db", 5, &[("../escape.png", 3)], 8);
    let plaintext = container_bytes(&manifest, &[("shop.db", b"hello"), ("../escape.png", b"bad")]);
    let bytes = craft_envelope(BACKUP_PASSWORD, &plaintext);

    let path = dir.path().join("crafted.msb");
    fs::write(&path, &bytes).expect("write package");
    let error = backup::restore_backup(dir.path(), &path, BACKUP_PASSWORD).expect_err("refused");
    assert_eq!(error, BackupError::UnsafePath);
    assert!(!dir.path().join("escape.png").exists());
}

#[tokio::test]
async fn a_duplicate_component_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    let manifest = manifest_json("shop.db", 5, &[("images/a.png", 1), ("images/a.png", 1)], 7);
    let plaintext = container_bytes(
        &manifest,
        &[
            ("shop.db", b"hello"),
            ("images/a.png", b"x"),
            ("images/a.png", b"x"),
        ],
    );
    let bytes = craft_envelope(BACKUP_PASSWORD, &plaintext);
    restore_expects(dir.path(), &bytes, BackupError::DuplicateComponent);
}

#[tokio::test]
async fn a_malformed_manifest_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    let plaintext = container_bytes("{ this is not json", &[("shop.db", b"hello")]);
    let bytes = craft_envelope(BACKUP_PASSWORD, &plaintext);
    restore_expects(dir.path(), &bytes, BackupError::ManifestInvalid);
}

#[tokio::test]
async fn a_package_without_a_database_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    // The database slot names an image instead of the reserved database path.
    let manifest = manifest_json("images/a.png", 1, &[], 1);
    let plaintext = container_bytes(&manifest, &[("images/a.png", b"x")]);
    let bytes = craft_envelope(BACKUP_PASSWORD, &plaintext);
    restore_expects(dir.path(), &bytes, BackupError::MissingDatabase);
}

#[tokio::test]
async fn a_component_whose_hash_disagrees_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    // The manifest carries the *real* digest of "hello", but the container
    // carries "world": the recomputed hash disagrees, so the package is refused
    // even though it authenticated correctly.
    let good = crypto::sha256_hex(b"hello");
    let manifest = format!(
        r#"{{"format_version":1,"created_at_unix_ms":0,"database":{{"path":"shop.db","len":5,"sha256":"{good}"}},"images":[],"uncompressed_len":5}}"#
    );
    let plaintext = container_bytes(&manifest, &[("shop.db", b"world")]);
    let bytes = craft_envelope(BACKUP_PASSWORD, &plaintext);
    restore_expects(dir.path(), &bytes, BackupError::ContentInvalid);
}

#[tokio::test]
async fn a_short_password_is_refused_on_both_paths() {
    let dir = TempDir::new().expect("temp dir");
    let pool = shop_with_data(dir.path()).await;
    let backup_path = dir.path().join("b.msb");

    let error = backup::create_backup(&pool, dir.path(), &backup_path, "short")
        .await
        .expect_err("weak password");
    assert_eq!(error, BackupError::PasswordTooWeak);

    let error = backup::create_backup(&pool, dir.path(), &backup_path, "")
        .await
        .expect_err("empty password");
    assert_eq!(error, BackupError::PasswordRequired);

    backup::create_backup(&pool, dir.path(), &backup_path, BACKUP_PASSWORD)
        .await
        .expect("create backup");
    pool.close().await;

    let error = backup::restore_backup(dir.path(), &backup_path, "short").expect_err("weak");
    assert_eq!(error, BackupError::PasswordTooWeak);
    assert!(!dir.path().join(".b.msb.partial").exists());
}

// ---------------------------------------------------------------------------
// Interrupted restores
// ---------------------------------------------------------------------------

fn original_state(data: &Path) {
    fs::create_dir_all(data.join(IMAGES_DIR)).expect("images");
    fs::write(data.join(DB_FILE), b"ORIGINAL-DB").expect("db");
    fs::write(data.join(IMAGES_DIR).join("old.png"), b"ORIGINAL-IMAGE").expect("image");
}

/// A complete pre-restore snapshot, exactly as `apply` leaves `rollback/`.
fn write_snapshot(work: &WorkSpace, data: &Path) {
    fs::create_dir_all(work.rollback().join(IMAGES_DIR)).expect("snapshot images");
    fs::copy(data.join(DB_FILE), work.rollback().join(DB_FILE)).expect("snapshot db");
    fs::copy(
        data.join(IMAGES_DIR).join("old.png"),
        work.rollback().join(IMAGES_DIR).join("old.png"),
    )
    .expect("snapshot image");
}

/// The device after a replacement: new database, old image gone, new image in.
fn replaced_state(data: &Path) {
    fs::write(data.join(DB_FILE), b"NEW-DB").expect("new db");
    fs::remove_dir_all(data.join(IMAGES_DIR)).expect("drop images");
    fs::create_dir_all(data.join(IMAGES_DIR)).expect("new images");
    fs::write(data.join(IMAGES_DIR).join("new.png"), b"NEW-IMAGE").expect("new image");
}

fn assert_original(data: &Path) {
    assert_eq!(fs::read(data.join(DB_FILE)).expect("db"), b"ORIGINAL-DB");
    assert_eq!(
        fs::read(data.join(IMAGES_DIR).join("old.png")).expect("old image"),
        b"ORIGINAL-IMAGE"
    );
    assert!(!data.join(IMAGES_DIR).join("new.png").exists());
}

fn store_phase(work: &WorkSpace, phase: Phase) {
    journal::store_journal(
        work,
        &Journal {
            layout_version: LAYOUT_VERSION,
            phase,
            started_at_unix_ms: 0,
        },
    )
    .expect("journal");
}

#[test]
fn a_crash_before_the_snapshot_only_discards_staging() {
    let dir = TempDir::new().expect("temp dir");
    let data = dir.path();
    original_state(data);

    let work = WorkSpace::new(data);
    fs::create_dir_all(work.staging()).expect("staging");
    fs::write(work.staging().join("shop.db"), b"NEW-DB").expect("staged db");
    store_phase(&work, Phase::Prepared);

    let outcome = backup::recover_interrupted(data).expect("recover");
    assert!(matches!(outcome, RecoveryOutcome::Cleaned { .. }));
    assert_original(data);
    assert!(!work.root.exists());
}

#[test]
fn a_crash_after_the_snapshot_but_before_the_journal_update_reverts() {
    let dir = TempDir::new().expect("temp dir");
    let data = dir.path();
    original_state(data);

    let work = WorkSpace::new(data);
    fs::create_dir_all(work.staging()).expect("staging");
    write_snapshot(&work, data);
    // The journal still says Prepared: the update to BackedUp had not landed.
    store_phase(&work, Phase::Prepared);

    let outcome = backup::recover_interrupted(data).expect("recover");
    assert!(matches!(outcome, RecoveryOutcome::Reverted { .. }));
    assert_original(data);
    assert!(!work.root.exists());
}

#[test]
fn a_crash_during_replacement_reverts_from_the_snapshot() {
    let dir = TempDir::new().expect("temp dir");
    let data = dir.path();
    original_state(data);

    let work = WorkSpace::new(data);
    write_snapshot(&work, data);
    store_phase(&work, Phase::BackedUp);
    replaced_state(data);

    let outcome = backup::recover_interrupted(data).expect("recover");
    assert!(matches!(outcome, RecoveryOutcome::Reverted { .. }));
    assert_original(data);
    assert!(!work.root.exists());
}

#[test]
fn a_crash_after_install_but_before_commit_reverts() {
    let dir = TempDir::new().expect("temp dir");
    let data = dir.path();
    original_state(data);

    let work = WorkSpace::new(data);
    write_snapshot(&work, data);
    store_phase(&work, Phase::Installed);
    replaced_state(data);

    let outcome = backup::recover_interrupted(data).expect("recover");
    assert!(matches!(outcome, RecoveryOutcome::Reverted { .. }));
    assert_original(data);
}

#[test]
fn a_crash_after_the_snapshot_is_deleted_keeps_the_new_state() {
    let dir = TempDir::new().expect("temp dir");
    let data = dir.path();
    original_state(data);

    let work = WorkSpace::new(data);
    fs::create_dir_all(work.staging()).expect("staging");
    store_phase(&work, Phase::Installed);
    replaced_state(data);
    // No snapshot: the commit already discarded it.

    let outcome = backup::recover_interrupted(data).expect("recover");
    assert!(matches!(outcome, RecoveryOutcome::Cleaned { .. }));
    assert_eq!(fs::read(data.join(DB_FILE)).expect("db"), b"NEW-DB");
    assert!(data.join(IMAGES_DIR).join("new.png").exists());
    assert!(!work.root.exists());
}

#[test]
fn a_crash_while_the_snapshot_was_being_copied_only_discards_staging() {
    let dir = TempDir::new().expect("temp dir");
    let data = dir.path();
    original_state(data);

    let work = WorkSpace::new(data);
    fs::create_dir_all(work.staging()).expect("staging");
    // rollback.tmp is written before it is renamed, so an interruption leaves it
    // partial and `rollback/` absent. Recovery must not treat it as a snapshot.
    fs::create_dir_all(work.rollback_tmp().join(IMAGES_DIR)).expect("partial snapshot");
    fs::write(work.rollback_tmp().join(DB_FILE), b"PARTIAL").expect("partial db");
    store_phase(&work, Phase::Prepared);

    let outcome = backup::recover_interrupted(data).expect("recover");
    assert!(matches!(outcome, RecoveryOutcome::Cleaned { .. }));
    assert_original(data);
    assert!(!work.root.exists());
}

#[test]
fn recovery_is_idempotent() {
    let dir = TempDir::new().expect("temp dir");
    let data = dir.path();
    original_state(data);

    let work = WorkSpace::new(data);
    write_snapshot(&work, data);
    store_phase(&work, Phase::Installed);
    replaced_state(data);

    backup::recover_interrupted(data).expect("first recovery");
    assert_original(data);

    let second = backup::recover_interrupted(data).expect("second recovery");
    assert_eq!(second, RecoveryOutcome::NothingToDo);
    assert_original(data);
}

#[test]
fn recovery_on_a_clean_device_does_nothing() {
    let dir = TempDir::new().expect("temp dir");
    let data = dir.path();
    original_state(data);

    let outcome = backup::recover_interrupted(data).expect("recover");
    assert_eq!(outcome, RecoveryOutcome::NothingToDo);
    assert_original(data);
}

#[test]
fn a_restore_clears_leftovers_from_an_earlier_interruption() {
    // A leftover snapshot from a previous crash must not be treated as the
    // snapshot of the *new* restore.
    let dir = TempDir::new().expect("temp dir");
    let data = dir.path();
    original_state(data);

    let work = WorkSpace::new(data);
    write_snapshot(&work, data);
    store_phase(&work, Phase::BackedUp);
    replaced_state(data);

    // Recovery as it would run at startup.
    backup::recover_interrupted(data).expect("recover");
    assert_original(data);
    assert!(!work.root.exists());
}

// ---------------------------------------------------------------------------
// Plan item 1.12 — Automatic backup policy, USB sync, rotation, and PIN restore (ADR-027)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn automatic_backup_on_shift_open_and_close_verifies_integrity_and_records_arabic_reasons() {
    let dir = TempDir::new().expect("temp dir");
    let pool = shop_with_data(dir.path()).await;

    let open_entry = backup::auto::trigger_shift_backup(&pool, dir.path(), 142, true)
        .await
        .expect("shift open backup")
        .expect("enabled by default");
    assert_eq!(open_entry.trigger_kind, "shift_open");
    assert_eq!(open_entry.reason, "فتح وردية #142");
    assert!(open_entry.verified);
    assert!(!open_entry.usb_copied);

    let close_entry = backup::auto::trigger_shift_backup(&pool, dir.path(), 142, false)
        .await
        .expect("shift close backup")
        .expect("enabled by default");
    assert_eq!(close_entry.trigger_kind, "shift_close");
    assert_eq!(close_entry.reason, "تقفيل وردية #142");
    assert!(close_entry.verified);

    let list = backup::auto::list_saved_backups(dir.path());
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].id, close_entry.id);
    assert_eq!(list[1].id, open_entry.id);

    // When `ui.backup_on_shift` is turned off, shift triggers skip backup creation.
    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES ('ui.backup_on_shift', 'off', 'system', 1)",
    )
    .execute(&pool)
    .await
    .expect("disable shift backup");

    let skipped = backup::auto::trigger_shift_backup(&pool, dir.path(), 143, true)
        .await
        .expect("shift trigger when off");
    assert!(skipped.is_none());
    pool.close().await;
}

#[tokio::test]
async fn automatic_backup_copies_to_mshop_backup_usb_and_rotates_oldest_files() {
    use mobile_shop_system_lib::domain::backup::policy::{
        BackupTriggerKind, USB_BACKUPS_SUBDIR, USB_VOLUME_NAME,
    };

    let dir = TempDir::new().expect("temp dir");
    let pool = shop_with_data(dir.path()).await;

    // Simulate a mounted `MSHOP-BACKUP` USB flash drive inside the isolated temp dir.
    let usb_mount = dir.path().join(USB_VOLUME_NAME);
    fs::create_dir_all(&usb_mount).expect("create USB mount");

    let b1 = backup::auto::create_auto_backup_with_limit(
        &pool,
        dir.path(),
        BackupTriggerKind::Periodic,
        None,
        2,
    )
    .await
    .expect("backup 1");
    assert!(b1.usb_copied);
    assert_eq!(b1.reason, "دوري (كل ساعتين)");
    assert!(usb_mount.join(USB_BACKUPS_SUBDIR).join(&b1.file_name).is_file());

    let b2 = backup::auto::create_auto_backup_with_limit(
        &pool,
        dir.path(),
        BackupTriggerKind::Manual,
        None,
        2,
    )
    .await
    .expect("backup 2");
    let b3 = backup::auto::create_auto_backup_with_limit(
        &pool,
        dir.path(),
        BackupTriggerKind::Manual,
        None,
        2,
    )
    .await
    .expect("backup 3");

    // Local rotation retains only the newest 2 backups (`b3` and `b2`), pruning `b1` from PC disk.
    assert!(!dir.path().join("backups").join(&b1.file_name).exists());
    assert!(dir.path().join("backups").join(&b2.file_name).is_file());
    assert!(dir.path().join("backups").join(&b3.file_name).is_file());

    pool.close().await;
}

#[tokio::test]
async fn usb_manual_copy_and_pin_approved_saved_backup_restore_round_trip() {
    use mobile_shop_system_lib::domain::backup::policy::USB_VOLUME_NAME;
    use mobile_shop_system_lib::domain::identity::DomainError;
    use mobile_shop_system_lib::services::backup::BackupServiceError;
    use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
    use mobile_shop_system_lib::services::identity::{approval, auth, pin, session};

    let dir = TempDir::new().expect("temp dir");
    let pool = db::open(&dir.path().join("shop.db")).await.expect("open db");
    let tokens = InMemoryTokenStore::new();

    let created = bootstrap::create_first_manager(&pool, "Peter", BACKUP_PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, &tokens, created.user_id, BACKUP_PASSWORD)
        .await
        .expect("login");
    let mgr_session = session::resolve(&pool, &tokens).await.expect("session");
    pin::set_own_pin(&pool, &mgr_session, None, "2580")
        .await
        .expect("set owner pin");

    sqlx::query("CREATE TABLE test_marker (id INTEGER PRIMARY KEY, note TEXT NOT NULL)")
        .execute(&pool)
        .await
        .expect("marker table");
    sqlx::query("INSERT INTO test_marker (id, note) VALUES (1, 'before-backup')")
        .execute(&pool)
        .await
        .expect("marker row");

    // 1. Create a manual saved backup («خد نسخة دلوقتي»).
    let saved = backup::auto::create_auto_backup_now_authorized(&pool, &tokens, dir.path())
        .await
        .expect("create auto backup now");
    assert_eq!(saved.reason, "يدوي");
    assert!(saved.verified);
    assert!(!saved.usb_copied);

    // 2. Manual copy to USB («انسخ على فلاشة») fails with UsbNotConnected when USB is absent.
    let err = backup::auto::copy_latest_backup_to_usb_authorized(&pool, &tokens, dir.path())
        .await
        .expect_err("no usb connected");
    assert!(matches!(
        err,
        BackupServiceError::Backup(BackupError::UsbNotConnected)
    ));

    // Plug in MSHOP-BACKUP and copy again -> succeeds and marks usb_copied = true.
    fs::create_dir_all(dir.path().join(USB_VOLUME_NAME)).expect("plug usb");
    let copied = backup::auto::copy_latest_backup_to_usb_authorized(&pool, &tokens, dir.path())
        .await
        .expect("copy to usb");
    assert!(copied.usb_copied);

    // 3. Mutate the live database after the backup.
    sqlx::query("INSERT INTO test_marker (id, note) VALUES (2, 'after-backup')")
        .execute(&pool)
        .await
        .expect("insert after backup");
    assert_eq!(
        marker_notes(&pool).await,
        vec!["before-backup".to_string(), "after-backup".to_string()]
    );

    // 4. Restoring from saved backups WITHOUT Owner PIN approval is refused and leaves pool open.
    let unapproved = backup::auto::restore_saved_backup_authorized(
        &pool,
        &tokens,
        dir.path(),
        &saved.id,
    )
    .await
    .expect_err("requires owner PIN approval");
    assert!(matches!(
        unapproved,
        BackupServiceError::Identity(DomainError::OwnerApprovalRequired)
    ));

    // 5. Grant Owner PIN approval and restore -> succeeds and reverts `shop.db` to backup state.
    approval::approve_with_owner_pin(&pool, &tokens, created.user_id, "2580")
        .await
        .expect("approve with owner pin");
    let outcome = backup::auto::restore_saved_backup_authorized(
        &pool,
        &tokens,
        dir.path(),
        &saved.id,
    )
    .await
    .expect("restore saved backup with owner approval");
    assert!(outcome.database_len > 0);

    let reopened = db::open(&dir.path().join("shop.db"))
        .await
        .expect("reopen restored db");
    assert_eq!(
        marker_notes(&reopened).await,
        vec!["before-backup".to_string()]
    );
    reopened.close().await;
}

