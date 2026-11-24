//! Validation tests: the rules that stop an importer, and the reconciliation
//! that proves the mapping preserves what the legacy report says.
//!
//! The reconciliation test is the acceptance criterion in executable form. It
//! runs the mapping over the real fixture, regroups the rows by section, and
//! recomputes the legacy formula byte for byte â€” withdrawals inside cash,
//! services at price, cancelled repairs out of profit but in the service sum.
//! If it matches `_expected_legacy_totals`, the mapping tells the same story
//! the old system told.

use mshop_migration::mapping::*;
use mshop_migration::reader::*;
use mshop_migration::validation::*;
use std::collections::BTreeMap;

fn fixture_export() -> Export {
    let text = std::fs::read_to_string("../../spikes/legacy-import/fixtures/legacy-export-mixed.json")
        .expect("fixture must exist");
    read_str(&text).expect("fixture reads")
}

/// The bare fixture lacks seed lists, exactly like a real export would not: a
/// complete export carries mshop_cats. Injecting the three categories the
/// fixture's rows name mirrors a complete export without touching the fixture.
fn export_with_seeds() -> Export {
    let text = std::fs::read_to_string("../../spikes/legacy-import/fixtures/legacy-export-mixed.json")
        .expect("fixture must exist");
    let mut raw: serde_json::Value = serde_json::from_str(&text).expect("json");
    raw["mshop_cats"] = serde_json::json!(["\u{0643}\u{0641}\u{0631}\u{0627}\u{062a}", "\u{0634}\u{0648}\u{0627}\u{062d}\u{0646}", "\u{0633}\u{0627}\u{0639}\u{0627}\u{062a}"]);
    raw["mshop_ce"] = serde_json::json!(["\u{0643}\u{0647}\u{0631}\u{0628}\u{0627}\u{0621}"]);
    let text = serde_json::to_string(&raw).expect("reserialize");
    read_str(&text).expect("reads with seeds")
}

fn map_all(export: &Export) -> (Context, Vec<Outcome>) {
    let ctx = collect_context(export);
    let mut out = Vec::new();
    for (key, items) in &export.collections {
        if *key == "mshop_wallets" {
            continue;
        }
        for r in items {
            out.extend(map_record(&ctx, None, r));
        }
    }
    for (day_key, sections) in &export.days {
        let day = day_key.strip_prefix("mshop_d_");
        for (_section, records) in sections {
            for r in records {
                out.extend(map_record(&ctx, day, r));
            }
        }
    }
    (ctx, out)
}

#[test]
fn full_fixture_maps_with_exactly_the_expected_blocks() {
    // The bare fixture is deliberately incomplete: no seed lists. Two blocks
    // are specified, each a different rule firing for its own evidenced reason.
    // The inventory price gap closed with migration 0003 (NULL price). If this
    // count changes, a rule changed, and that is the news.
    let export = fixture_export();
    let (_ctx, out) = map_all(&export);
    let (blocked, _review) = collect_outcomes(&out);
    assert_eq!(blocked.len(), 3, "three specified blocks: {blocked:?}");
    assert!(blocked.iter().any(|b| b.contains("not complete")), "incomplete service");
    assert_eq!(
        blocked.iter().filter(|b| b.contains("seed")).count(),
        2,
        "unseeded product and expense categories: {blocked:?}"
    );
}

#[test]
fn seeded_export_blocks_only_on_schema_gaps() {
    // With the categories a complete export carries, the only remaining block
    // is the incomplete service: a schema gap (no receivables), zero mapping
    // failures.
    let export = export_with_seeds();
    let (_ctx, out) = map_all(&export);
    let (blocked, _review) = collect_outcomes(&out);
    assert_eq!(blocked.len(), 1, "{blocked:?}");
    assert!(blocked[0].contains("not complete"));
}

#[test]
fn reconciliation_matches_the_legacy_report_on_both_days() {
    let export = export_with_seeds();
    let text = std::fs::read_to_string("../../spikes/legacy-import/fixtures/legacy-export-mixed.json")
        .expect("fixture");
    let raw: serde_json::Value = serde_json::from_str(&text).expect("json");
    let expected = &raw["_expected_legacy_totals"];

    for day in ["2026-09-20", "2026-09-21"] {
        let key = format!("mshop_d_{day}");
        let sections = &export.days[&key];
        let ctx = collect_context(&export);
        let mut lines: BTreeMap<&str, Vec<NewInvoiceLine>> = BTreeMap::new();
        let mut movements = Vec::new();
        let mut expenses = Vec::new();
        let mut repairs = Vec::new();
        for (section, records) in sections {
            for r in records {
                for o in map_record(&ctx, Some(day), r) {
                    match o {
                        Outcome::Sale(_, line) => {
                            lines.entry(section.as_str()).or_default().push(line)
                        }
                        Outcome::Movement(m) => movements.push(m),
                        Outcome::Expense(e) => expenses.push((e.category, e.amount_minor)),
                        Outcome::Repair(r, _) => repairs.push(r),
                        _ => {}
                    }
                }
            }
        }
        let got = reconcile(&lines, &movements, &expenses, &repairs);
        let want = &expected["byDay"][day];
        // The blocked sw row (db shape, amount 150, paid but undelivered) is the
        // only mapped-minus-expected delta on this fixture: 15000 minor units
        // missing from the service sum, the sales sum, and the profit sum, which
        // count services at price. Every other field must match exactly.
        let excluded_sw: i64 = if day == "2026-09-20" { 15000 } else { 0 };
        for (field, value) in [
            ("aS", got.accessory_sell),
            ("aP", got.accessory_profit),
            ("uS", got.used_sell),
            ("uP", got.used_profit),
            ("cT", got.cash_total),
            ("sT", got.service_total),
            ("eT", got.expense_total),
            ("phS", got.phone_sell),
            ("phP", got.phone_profit),
            ("repS", got.repair_sell),
            ("repP", got.repair_profit),
            ("total", got.sales_total),
            ("profit", got.profit_total),
        ] {
            let expected_value = want[field].as_i64().unwrap() * 100;
            let allowed = if field == "sT" || field == "total" || field == "profit" {
                expected_value - excluded_sw
            } else {
                expected_value
            };
            assert_eq!(
                value, allowed,
                "{day}.{field}: mapped {value} != legacy {expected_value} (excluded {excluded_sw})"
            );
        }
    }
}

#[test]
fn grand_totals_match_as_well() {
    let export = export_with_seeds();
    let text = std::fs::read_to_string("../../spikes/legacy-import/fixtures/legacy-export-mixed.json")
        .expect("fixture");
    let raw: serde_json::Value = serde_json::from_str(&text).expect("json");
    let want = &raw["_expected_legacy_totals"]["grand"];

    let ctx = collect_context(&export);
    let mut lines: BTreeMap<&str, Vec<NewInvoiceLine>> = BTreeMap::new();
    let mut movements = Vec::new();
    let mut expenses = Vec::new();
    let mut repairs = Vec::new();
    for (day_key, sections) in &export.days {
        let day = day_key.strip_prefix("mshop_d_");
        for (section, records) in sections {
            for r in records {
                for o in map_record(&ctx, day, r) {
                    match o {
                        Outcome::Sale(_, line) => {
                            lines.entry(section.as_str()).or_default().push(line)
                        }
                        Outcome::Movement(m) => movements.push(m),
                        Outcome::Expense(e) => expenses.push((e.category, e.amount_minor)),
                        Outcome::Repair(r, _) => repairs.push(r),
                        _ => {}
                    }
                }
            }
        }
    }
    let got = reconcile(&lines, &movements, &expenses, &repairs);
    // Same single exclusion as the daily test: the blocked sw row (15000).
    assert_eq!(got.sales_total, want["total"].as_i64().unwrap() * 100 - 15000);
    assert_eq!(got.profit_total, want["profit"].as_i64().unwrap() * 100 - 15000);
}

#[test]
fn signed_cash_keeps_report_and_balance_apart() {
    // Guards a distinction that is easy to collapse by accident. The legacy
    // system stores cash `amount` as an UNSIGNED magnitude and carries the
    // direction in `cashType` (`cash.js:10`, `entity_mappers.js:245,253`). The
    // mapping signs the movement so a wallet balance can be correct
    // (`db_foundation.js:110`, `cash.js:42` re-apply the sign from cashType).
    //
    // So for a +1000 deposit and a -500 withdrawal there are two legitimate
    // numbers, and they must never be confused:
    //
    //     report cash_total = 1500   legacy `Σ i.amount` over unsigned magnitudes
    //     wallet balance   =  500   signed sum
    //
    // If someone drops the `.abs()` in `reconcile`, cash_total collapses to 500
    // and every historical cash figure silently becomes a balance instead. This
    // test fails on exactly that edit, and no other.
    let movement = |amount_minor: i64| NewWalletMovement {
        wallet: "W1".to_string(),
        amount_minor,
        service: None,
        note: None,
        created_at: "2026-09-20T00:00:00Z".to_string(),
        origin_ref: None,
    };
    let movements = vec![movement(100_000), movement(-50_000)];

    let got = reconcile(
        &BTreeMap::new(),
        &movements,
        &[],
        &[],
    );

    assert_eq!(
        got.cash_total, 150_000,
        "report cT sums unsigned magnitudes: a withdrawal adds to the report total"
    );
    let balance: i64 = movements.iter().map(|m| m.amount_minor).sum();
    assert_eq!(
        balance, 50_000,
        "the wallet balance is the signed sum: the same two rows, read differently"
    );
    assert_eq!(
        got.sales_total, 150_000,
        "sales_total inherits cT unchanged (aS + sT + cT)"
    );
    assert_eq!(
        got.profit_total, 150_000,
        "profit inherits cT unchanged when it is the only figure (aP+uP+cT+sT+phP+repP-eT)"
    );

    // A lone withdrawal still contributes positively to the report, which is the
    // legacy behavior this whole distinction exists to preserve.
    let only_withdrawal = reconcile(&BTreeMap::new(), &[movement(-50_000)], &[], &[]);
    assert_eq!(only_withdrawal.cash_total, 50_000);
    assert_eq!(only_withdrawal.profit_total, 50_000);
}

#[test]
fn validation_lists_blocks_and_reviews_separately() {
    let export = fixture_export();
    let (_ctx, out) = map_all(&export);
    let (blocked, review) = collect_outcomes(&out);
    assert!(!blocked.is_empty(), "the fixture is specified to block twice");
    assert!(!review.is_empty(), "skips and notes must appear for humans");
    assert!(
        review.iter().any(|r| r.contains("rolled")),
        "the rolled row must be listed: {review:?}"
    );
}

