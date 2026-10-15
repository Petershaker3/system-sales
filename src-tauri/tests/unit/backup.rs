//! The backup envelope's byte layout and the manifest's path policy.
//!
//! These are pure functions, so they are tested without a filesystem, a
//! password or a database. The interesting cases are the hostile ones: a file
//! and a manifest are untrusted input, and each test below is a way an attacker
//! or a corruption could try to get past the reader.

use mobile_shop_system_lib::domain::backup::error::BackupError;
use mobile_shop_system_lib::domain::backup::format::{
    self as fmt, Header, DEFAULT_ITERATIONS, DEFAULT_MEMORY_KIB, DEFAULT_PARALLELISM, MAGIC,
    MAX_ITERATIONS, MAX_MEMORY_KIB, MAX_PAYLOAD_LEN, MAX_PARALLELISM, MIN_ITERATIONS,
    MIN_MEMORY_KIB, MIN_PARALLELISM,
};
use mobile_shop_system_lib::domain::backup::manifest::{
    classify_component_path, validate_component_path, ComponentKind, ComponentMeta, Manifest,
    DB_COMPONENT,
};

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

fn sample_header() -> Header {
    Header::new_v1(1024)
}

#[test]
fn a_written_header_reads_back_identically() {
    let header = sample_header();
    let encoded = header.encode();
    assert_eq!(encoded.len(), fmt::HEADER_LEN);
    assert_eq!(&encoded[0..4], &MAGIC);
    assert_eq!(fmt::decode_header(&encoded).expect("decode"), header);
}

#[test]
fn the_expected_file_length_includes_the_tag_and_prefix() {
    let header = sample_header();
    assert_eq!(
        header.expected_file_len(),
        fmt::AAD_LEN as u64 + 1024,
        "payload_len already includes the tag; the file adds the 88-byte prefix"
    );
}

#[test]
fn a_file_that_is_not_a_backup_is_refused() {
    let mut bytes = sample_header().encode();
    bytes[0] = b'X';
    assert_eq!(
        fmt::decode_header(&bytes).unwrap_err(),
        BackupError::NotABackupFile
    );
}

#[test]
fn a_short_file_is_reported_as_truncated_not_as_a_foreign_file() {
    let bytes = vec![0u8; fmt::HEADER_LEN - 1];
    assert_eq!(
        fmt::decode_header(&bytes).unwrap_err(),
        BackupError::FileTruncated
    );
}

#[test]
fn a_future_version_is_refused_before_anything_else() {
    let mut bytes = sample_header().encode();
    bytes[4..6].copy_from_slice(&2u16.to_le_bytes());
    assert_eq!(
        fmt::decode_header(&bytes).unwrap_err(),
        BackupError::UnsupportedVersion
    );
}

#[test]
fn an_unknown_algorithm_is_refused() {
    let mut bytes = sample_header().encode();
    bytes[6] = 99; // unknown KDF
    assert_eq!(
        fmt::decode_header(&bytes).unwrap_err(),
        BackupError::UnsupportedAlgorithm
    );

    let mut bytes = sample_header().encode();
    bytes[7] = 99; // unknown AEAD
    assert_eq!(
        fmt::decode_header(&bytes).unwrap_err(),
        BackupError::UnsupportedAlgorithm
    );
}

#[test]
fn a_header_that_disagrees_about_its_own_lengths_is_refused() {
    let mut bytes = sample_header().encode();
    bytes[20] = 16; // salt_len must be 32
    assert_eq!(
        fmt::decode_header(&bytes).unwrap_err(),
        BackupError::HeaderInvalid
    );

    let mut bytes = sample_header().encode();
    bytes[21] = 12; // nonce_len must be 24
    assert_eq!(
        fmt::decode_header(&bytes).unwrap_err(),
        BackupError::HeaderInvalid
    );
}

#[test]
fn a_nonzero_reserved_field_is_refused() {
    let mut bytes = sample_header().encode();
    bytes[22] = 1;
    assert_eq!(
        fmt::decode_header(&bytes).unwrap_err(),
        BackupError::HeaderInvalid
    );
}

#[test]
fn a_payload_len_smaller_than_the_tag_is_refused() {
    let mut bytes = sample_header().encode();
    bytes[24..32].copy_from_slice(&8u64.to_le_bytes());
    assert_eq!(
        fmt::decode_header(&bytes).unwrap_err(),
        BackupError::PayloadTooLarge
    );
}

#[test]
fn an_absurd_payload_len_is_refused_before_the_body_is_read() {
    let mut bytes = sample_header().encode();
    bytes[24..32].copy_from_slice(&(MAX_PAYLOAD_LEN + 1).to_le_bytes());
    assert_eq!(
        fmt::decode_header(&bytes).unwrap_err(),
        BackupError::PayloadTooLarge
    );
}

#[test]
fn kdf_parameters_outside_the_hard_bounds_are_refused() {
    for memory in [MIN_MEMORY_KIB - 1, MAX_MEMORY_KIB + 1] {
        let mut bytes = sample_header().encode();
        bytes[8..12].copy_from_slice(&memory.to_le_bytes());
        assert_eq!(
            fmt::decode_header(&bytes).unwrap_err(),
            BackupError::KdfParamsInvalid,
            "memory_kib {memory}"
        );
    }

    for iterations in [MIN_ITERATIONS - 1, MAX_ITERATIONS + 1] {
        let mut bytes = sample_header().encode();
        bytes[12..16].copy_from_slice(&iterations.to_le_bytes());
        assert_eq!(
            fmt::decode_header(&bytes).unwrap_err(),
            BackupError::KdfParamsInvalid,
            "iterations {iterations}"
        );
    }

    for parallelism in [MIN_PARALLELISM - 1, MAX_PARALLELISM + 1] {
        let mut bytes = sample_header().encode();
        bytes[16..20].copy_from_slice(&parallelism.to_le_bytes());
        assert_eq!(
            fmt::decode_header(&bytes).unwrap_err(),
            BackupError::KdfParamsInvalid,
            "parallelism {parallelism}"
        );
    }
}

#[test]
fn the_default_parameters_are_inside_their_own_bounds() {
    // A default that its own reader would reject is a format that can write
    // files it cannot read.
    fmt::validate_kdf_params(DEFAULT_MEMORY_KIB, DEFAULT_ITERATIONS, DEFAULT_PARALLELISM)
        .expect("defaults are legal");
}

#[test]
fn a_file_shorter_than_its_header_declares_is_truncated() {
    let header = sample_header();
    let declared = header.expected_file_len();
    assert_eq!(
        fmt::check_file_len(&header, declared - 1).unwrap_err(),
        BackupError::FileTruncated
    );
}

#[test]
fn a_file_longer_than_its_header_declares_is_content_invalid() {
    let header = sample_header();
    let declared = header.expected_file_len();
    assert_eq!(
        fmt::check_file_len(&header, declared + 1).unwrap_err(),
        BackupError::ContentInvalid,
        "trailing bytes must not be silently ignored"
    );
}

#[test]
fn an_exact_length_is_accepted() {
    let header = sample_header();
    fmt::check_file_len(&header, header.expected_file_len()).expect("exact length");
}

// ---------------------------------------------------------------------------
// Component paths
// ---------------------------------------------------------------------------

#[test]
fn ordinary_component_paths_are_accepted() {
    for path in [
        "shop.db",
        "images/a.png",
        "images/sub/dir/photo-1_2.jpeg",
        "images/صورة المنتج.png",
        "images/with space.png",
    ] {
        validate_component_path(path).unwrap_or_else(|e| panic!("{path} should be safe: {e}"));
    }
}

#[test]
fn paths_that_could_escape_the_restore_root_are_refused() {
    for path in [
        "",
        "/etc/passwd",
        "\\windows\\system32",
        "images\\a.png",   // backslash separator
        "../shop.db",      // parent traversal
        "images/../../x",  // traversal below a prefix
        "images/./a.png",  // dot segment
        "C:/shop.db",      // drive letter
        "images/ads:stream",
    ] {
        assert_eq!(
            validate_component_path(path).unwrap_err(),
            BackupError::UnsafePath,
            "{path} should be refused"
        );
    }
}

#[test]
fn names_windows_rewrites_or_reserves_are_refused() {
    // Windows strips a trailing dot or space, so two distinct names could map to
    // one file; reserved device names open something other than a file.
    for path in ["images/a.", "images/a ", "images/CON", "images/con.txt", "images/LPT1.png"] {
        assert_eq!(
            validate_component_path(path).unwrap_err(),
            BackupError::UnsafePath,
            "{path} should be refused"
        );
    }
}

#[test]
fn control_characters_are_refused() {
    assert_eq!(
        validate_component_path("images/a\u{0}b.png").unwrap_err(),
        BackupError::UnsafePath
    );
    assert_eq!(
        validate_component_path("images/a\nb.png").unwrap_err(),
        BackupError::UnsafePath
    );
}

#[test]
fn a_path_is_classified_as_the_database_an_image_or_neither() {
    assert_eq!(
        classify_component_path(DB_COMPONENT).expect("db"),
        ComponentKind::Database
    );
    assert_eq!(
        classify_component_path("images/a.png").expect("image"),
        ComponentKind::Image
    );
    assert_eq!(
        classify_component_path("notes.txt").unwrap_err(),
        BackupError::ContentInvalid,
        "safe but not a component this format admits"
    );
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

fn digest() -> String {
    "0".repeat(64)
}

fn db_meta(len: u64) -> ComponentMeta {
    ComponentMeta {
        path: DB_COMPONENT.to_string(),
        len,
        sha256: digest(),
    }
}

fn image_meta(path: &str, len: u64) -> ComponentMeta {
    ComponentMeta {
        path: path.to_string(),
        len,
        sha256: digest(),
    }
}

fn manifest(database: ComponentMeta, images: Vec<ComponentMeta>, total: u64) -> Manifest {
    Manifest {
        format_version: fmt::FORMAT_VERSION,
        created_at_unix_ms: 1_700_000_000_000,
        database,
        images,
        uncompressed_len: total,
    }
}

#[test]
fn a_well_formed_manifest_is_accepted() {
    let m = manifest(db_meta(10), vec![image_meta("images/a.png", 5)], 15);
    m.validate().expect("valid");
    assert_eq!(m.components().len(), 2);
}

#[test]
fn a_manifest_without_a_database_is_refused() {
    let m = manifest(image_meta("images/a.png", 5), vec![], 5);
    assert_eq!(m.validate().unwrap_err(), BackupError::MissingDatabase);
}

#[test]
fn a_manifest_with_a_duplicate_component_is_refused() {
    let m = manifest(
        db_meta(10),
        vec![image_meta("images/a.png", 5), image_meta("images/a.png", 5)],
        20,
    );
    assert_eq!(m.validate().unwrap_err(), BackupError::DuplicateComponent);
}

#[test]
fn an_image_outside_the_images_prefix_is_refused() {
    let m = manifest(db_meta(10), vec![image_meta("steal.db", 5)], 15);
    assert_eq!(m.validate().unwrap_err(), BackupError::ContentInvalid);
}

#[test]
fn a_manifest_with_a_malformed_digest_is_refused() {
    let mut meta = image_meta("images/a.png", 5);
    meta.sha256 = "NOT-A-DIGEST".to_string();
    let m = manifest(db_meta(10), vec![meta], 15);
    assert_eq!(m.validate().unwrap_err(), BackupError::ManifestInvalid);
}

#[test]
fn a_manifest_whose_total_disagrees_with_its_parts_is_refused() {
    let m = manifest(db_meta(10), vec![image_meta("images/a.png", 5)], 99);
    assert_eq!(m.validate().unwrap_err(), BackupError::ManifestInvalid);
}

#[test]
fn a_manifest_from_a_future_format_version_is_refused() {
    let mut m = manifest(db_meta(10), vec![], 10);
    m.format_version = fmt::FORMAT_VERSION + 1;
    assert_eq!(m.validate().unwrap_err(), BackupError::ManifestInvalid);
}

#[test]
fn an_empty_component_is_refused() {
    let m = manifest(db_meta(0), vec![], 0);
    assert_eq!(m.validate().unwrap_err(), BackupError::ManifestInvalid);
}

#[test]
fn every_backup_error_has_a_distinct_code() {
    let errors = [
        BackupError::NotABackupFile,
        BackupError::UnsupportedVersion,
        BackupError::UnsupportedAlgorithm,
        BackupError::FileTruncated,
        BackupError::HeaderInvalid,
        BackupError::KdfParamsInvalid,
        BackupError::PayloadTooLarge,
        BackupError::DecryptionFailed,
        BackupError::ManifestInvalid,
        BackupError::ContentInvalid,
        BackupError::UnsafePath,
        BackupError::DuplicateComponent,
        BackupError::MissingDatabase,
        BackupError::PasswordRequired,
        BackupError::PasswordTooWeak,
        BackupError::CreateFailed,
        BackupError::RestoreFailed,
        BackupError::RecoveryIncomplete,
    ];
    let mut codes: Vec<&str> = errors.iter().map(|e| e.code()).collect();
    let count = codes.len();
    codes.sort_unstable();
    codes.dedup();
    assert_eq!(codes.len(), count, "two variants share a code");
    for code in codes {
        assert!(
            code.starts_with("BACKUP_"),
            "backup codes are namespaced: {code}"
        );
    }
}
