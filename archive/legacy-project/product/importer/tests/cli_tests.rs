//! Gate acceptance for the CLI contract, exercised as a real subprocess so the
//! exit codes and printed report are tested as a caller would see them, not as
//! an in-process function call that cannot fail to print.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::process::Command;

const EXIT_OK: i32 = 0;
const EXIT_REFUSED: i32 = 1;
const EXIT_USAGE: i32 = 2;
const EXIT_UNSUPPORTED: i32 = 3;

fn bin() -> PathBuf {
    // The test binary lives in target/debug/deps/, so the CLI is one level up.
    let mut p = std::env::current_exe().expect("test exe");
    p.pop();
    if p.ends_with("deps") {
        p.pop();
    }
    p.push("mshop-import.exe");
    p
}

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

fn run(args: &[&str]) -> Run {
    let out = Command::new(bin())
        .args(args)
        .output()
        .expect("mshop-import must be built before these tests run");
    Run {
        code: out.status.code().expect("exit code"),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

fn temp(tag: &str, ext: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("mshop_cli_{tag}.{ext}"));
    let _ = std::fs::remove_file(&p);
    p
}

fn clean_fixture() -> PathBuf {
    Path::new("tests/fixtures/clean.json").to_path_buf()
}

fn mixed_fixture() -> PathBuf {
    Path::new("../../spikes/legacy-import/fixtures/legacy-export-mixed.json").to_path_buf()
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn sha256(path: &Path) -> String {
    let bytes = std::fs::read(path).expect("read source");
    let digest = sha256_digest(&bytes);
    digest
}

/// Minimal SHA-256 so the test can prove the source was not touched without
/// pulling a hashing dependency into the crate's own dependency list.
fn sha256_digest(input: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let mut msg = input.to_vec();
    let bitlen = (input.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bitlen.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (i, v) in [a, b, c, d, e, f, g, hh].into_iter().enumerate() {
            h[i] = h[i].wrapping_add(v);
        }
    }
    h.iter().map(|w| format!("{w:08x}")).collect()
}

#[tokio::test]
async fn clean_json_imports_and_reports_success() {
    let dest = temp("ok", "db");
    let r = run(&[&s(&clean_fixture()), &s(&dest)]);

    assert_eq!(r.code, EXIT_OK, "stderr: {}", r.stderr);
    assert!(dest.exists(), "destination is created");
    for expected in [
        "source",
        "destination",
        "schema version",
        "records imported",
        "records reused",
        "totals (minor)",
        "review",
    ] {
        assert!(r.stdout.contains(expected), "report prints {expected}:\n{}", r.stdout);
    }
    assert!(r.stdout.contains("schema version    3"), "version is stated");
    assert!(
        r.stdout.contains("products 2"),
        "record counts are stated:\n{}",
        r.stdout
    );
    assert!(
        r.stdout.contains("review            none"),
        "a clean import needs no review:\n{}",
        r.stdout
    );
}

#[tokio::test]
async fn missing_destination_is_created_and_populated() {
    let dest = temp("created", "db");
    assert!(!dest.exists());
    let r = run(&[&s(&clean_fixture()), &s(&dest)]);
    assert_eq!(r.code, EXIT_OK, "stderr: {}", r.stderr);
    assert!(dest.exists());

    let url = format!("sqlite://{}", s(&dest).replace('\\', "/"));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::from_str(&url)
                .unwrap()
                .create_if_missing(false),
        )
        .await
        .unwrap();
    let products: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(products, 2, "the file is a real database, not a stub");
    pool.close().await;
}

#[tokio::test]
async fn a_destination_holding_any_row_is_refused_before_any_write() {
    // Import once so the destination genuinely holds rows, then try again.
    let dest = temp("occupied", "db");
    let first = run(&[&s(&clean_fixture()), &s(&dest)]);
    assert_eq!(first.code, EXIT_OK, "setup: {}", first.stderr);

    let before = std::fs::metadata(&dest).unwrap().len();
    let second = run(&[&s(&clean_fixture()), &s(&dest)]);
    assert_eq!(second.code, EXIT_REFUSED, "a populated destination is refused");
assert!(
        second.stderr.contains("refuses to merge") && second.stderr.contains("existing data"),
        "the reason is named: {}",
        second.stderr
    );
    let after = std::fs::metadata(&dest).unwrap().len();
    assert_eq!(before, after, "the existing file is left untouched");

    // The pre-existing data must still be intact and still readable.
    let url = format!("sqlite://{}", s(&dest).replace('\\', "/"));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::from_str(&url)
                .unwrap()
                .create_if_missing(false),
        )
        .await
        .unwrap();
    let products: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(products, 2, "refusal did not damage the existing database");
    pool.close().await;
}

#[tokio::test]
async fn an_existing_but_empty_destination_is_allowed() {
    // Zero-byte file: no rows, so the guard must let it through. This is the
    // documented contract, and it is the case that proves the guard judges rows
    // rather than merely judging a file's existence.
    let dest = temp("empty", "db");
    std::fs::write(&dest, b"").expect("create empty file");
    let r = run(&[&s(&clean_fixture()), &s(&dest)]);
    assert_eq!(r.code, EXIT_OK, "an empty destination is usable: {}", r.stderr);
}

#[tokio::test]
async fn blocked_source_produces_no_output_at_all() {
    let dest = temp("blocked", "db");
    let r = run(&[&s(&mixed_fixture()), &s(&dest)]);

    assert_eq!(r.code, EXIT_REFUSED, "blocked rows refuse the import");
    assert!(r.stderr.contains("blocked rows"), "the reason is named");
    assert!(
        !dest.exists(),
        "no output file survives a refused import: {}",
        dest.display()
    );
}

#[tokio::test]
async fn mshop_format_is_refused_as_unsupported_not_guessed() {
    // The gate that matters most for the real acceptance ahead: a .mshop file
    // must be refused with its own exit code, never parsed on a guess.
    let src = temp("sample", "mshop");
    std::fs::write(&src, b"\x00\x01\x02 not really a mshop file").expect("write sample");
    let dest = temp("mshop_out", "db");

    let r = run(&[&s(&src), &s(&dest)]);
    assert_eq!(
        r.code, EXIT_UNSUPPORTED,
        "a .mshop file is unsupported, not unreadable: {}",
        r.stderr
    );
    assert!(
        r.stderr.contains("not understood yet"),
        "the message says the format is unknown, not corrupt: {}",
        r.stderr
    );
    assert!(!dest.exists(), "no destination is created");
}

#[tokio::test]
async fn unknown_extension_is_unsupported_too() {
    let src = temp("mystery", "bin");
    std::fs::write(&src, b"whatever").expect("write");
    let dest = temp("bin_out", "db");
    let r = run(&[&s(&src), &s(&dest)]);
    assert_eq!(r.code, EXIT_UNSUPPORTED, "stderr: {}", r.stderr);
    assert!(!dest.exists());
}

#[tokio::test]
async fn wrong_argument_count_is_a_usage_error() {
    let r = run(&[&s(&clean_fixture())]);
    assert_eq!(r.code, EXIT_USAGE, "one argument is not enough");
    assert!(r.stderr.contains("usage:"), "usage is printed");
}

#[tokio::test]
async fn a_missing_source_is_an_io_error() {
    let dest = temp("nosrc", "db");
    let r = run(&["does-not-exist.json", &s(&dest)]);
    assert_eq!(r.code, 4, "missing source is I/O, not refusal");
    assert!(r.stderr.contains("not found"));
}

#[tokio::test]
async fn the_source_is_never_modified() {
    let src = temp("immutable", "json");
    std::fs::copy(clean_fixture(), &src).expect("copy fixture");

    let before = sha256(&src);
    let first = run(&[&s(&src), &s(&temp("immutable_a", "db"))]);
    let second = run(&[&s(&src), &s(&temp("immutable_b", "db"))]);
    assert_eq!(first.code, EXIT_OK, "{}", first.stderr);
    assert_eq!(second.code, EXIT_OK, "{}", second.stderr);

    let after = sha256(&src);
    assert_eq!(before, after, "the export's bytes are identical after two imports");
}

#[tokio::test]
async fn same_source_into_a_new_destination_gives_the_same_report() {
    let src = clean_fixture();
    let a = run(&[&s(&src), &s(&temp("det_a", "db"))]);
    let b = run(&[&s(&src), &s(&temp("det_b", "db"))]);

    assert_eq!(a.code, EXIT_OK, "{}", a.stderr);
    assert_eq!(b.code, EXIT_OK, "{}", b.stderr);

    // The reports name their own source and destination, so compare only the
    // lines that describe the data.
    let data_lines = |out: &str| -> Vec<String> {
        out.lines()
            .filter(|l| l.contains("records") || l.contains("totals"))
            .map(|l| l.to_string())
            .collect()
    };
    assert_eq!(
        data_lines(&a.stdout),
        data_lines(&b.stdout),
        "the same source must yield the same numbers"
    );
}

#[tokio::test]
async fn an_invalid_json_source_is_refused_not_half_imported() {
    let src = temp("bad", "json");
    std::fs::write(&src, br#"{"mshop_d_2026-01-01": "not the expected shape"}"#).expect("write");
    let dest = temp("bad_out", "db");
    let r = run(&[&s(&src), &s(&dest)]);
    assert_eq!(r.code, EXIT_REFUSED, "stderr: {}", r.stderr);
    assert!(
        !dest.exists(),
        "an unparseable source leaves no half-built database"
    );
}


