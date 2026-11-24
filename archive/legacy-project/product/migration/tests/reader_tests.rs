//! Reader contract tests: shapes, failures, and the exact fixture counts the
//! probe established. If the fixture changes shape, these tests say so before
//! any mapping runs.

use mshop_migration::reader::*;
use std::collections::BTreeSet;

fn fixture() -> String {
    std::fs::read_to_string("../../spikes/legacy-import/fixtures/legacy-export-mixed.json")
        .expect("fixture must exist")
}

#[test]
fn mixed_shapes_are_detected_per_record() {
    let export = read_str(&fixture()).expect("fixture reads");
    let day = export.days.get("mshop_d_2026-09-20").expect("day present");
    let acc = &day["acc"];
    assert_eq!(acc.len(), 3);
    assert_eq!(acc[0].shape, Shape::Db, "snapshotName marks db shape");
    assert_eq!(acc[1].shape, Shape::Local, "name marks local shape");
    assert_eq!(acc[2].shape, Shape::Local, "a rolled row is still local shape");
}

#[test]
fn repairs_are_always_local_shape() {
    let export = read_str(&fixture()).expect("fixture reads");
    for (day, sections) in &export.days {
        for r in &sections["repairs"] {
            assert_eq!(
                r.shape,
                Shape::LocalOnly,
                "{day}: repairs are never repository-written, per the legacy comment"
            );
        }
    }
}

#[test]
fn unknown_shape_is_tagged_not_guessed() {
    let text = r#"{"mshop_d_2026-01-01": {"acc": [{"mystery": 1}], "used": [], "sw": [], "cash": [], "exp": [], "phones": [], "repairs": []}}"#;
    let export = read_str(text).expect("reads");
    let rec = &export.days["mshop_d_2026-01-01"]["acc"][0];
    assert_eq!(rec.shape, Shape::Unknown);
    let issues = mshop_migration::validation::validate_export(&export);
    assert!(issues.iter().any(|i| i.fatal), "unknown shape must be fatal");
}

#[test]
fn non_json_bytes_are_refused_as_unsupported_format() {
    let err = read_bytes(b"\x50\x4b\x03\x04 binary envelope").unwrap_err();
    assert!(
        matches!(err, ReaderError::UnsupportedFormat { .. }),
        ".mshop bytes must be refused, not misread: {err:?}"
    );
}

#[test]
fn empty_and_scalar_inputs_fail_plainly() {
    assert!(matches!(read_bytes(b"   "), Err(ReaderError::InvalidJson(_))));
    assert!(matches!(read_str("[1,2]"), Err(ReaderError::NotAnObject)));
}

#[test]
fn unrecognized_keys_are_reported_and_excluded_keys_are_listed() {
    let text = r#"{"mshop_inventory": [], "mshop_cfg": {"a": 1}, "mshop_future": []}"#;
    let export = read_str(text).expect("reads");
    assert_eq!(export.unrecognized, vec!["mshop_future".to_string()]);
    assert_eq!(export.excluded_present, vec!["mshop_cfg".to_string()]);
    let issues = mshop_migration::validation::validate_export(&export);
    assert!(issues.iter().any(|i| i.fatal && i.message.contains("mshop_future")));
}

#[test]
fn fixture_counts_match_the_probe() {
    // The probe established 12 records on 09-20 and 1 on 09-21. The reader must
    // see exactly the same universe, or something changed under it.
    let export = read_str(&fixture()).expect("fixture reads");
    let count: usize = export.days["mshop_d_2026-09-20"]
        .values()
        .map(|v| v.len())
        .sum();
    assert_eq!(count, 12);
    let count2: usize = export.days["mshop_d_2026-09-21"]
        .values()
        .map(|v| v.len())
        .sum();
    assert_eq!(count2, 1);
    let known: BTreeSet<&str> = ["mshop_inventory", "mshop_ca", "mshop_cu", "mshop_repair_parts"]
        .into_iter()
        .collect();
    for key in export.collections.keys() {
        assert!(known.contains(key.as_str()) || *key == "mshop_wallets", "unexpected collection {key}");
    }
}
