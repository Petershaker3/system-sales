//! Mapping specification tests: every rule with its evidence, and every refusal
//! with its reason. A test that only checks the happy path would prove the
//! mapping runs; these prove it refuses for the right reasons.

use mshop_migration::mapping::*;
use mshop_migration::reader::*;
use serde_json::{json, Value};

fn rec(source: &str, index: usize, value: Value) -> Record {
    // Collections have one hand-written shape; only daily sections split
    // Db/Local. The production reader tags collections Local; the helper must
    // do the same, or every collection test exercises the unknown-shape path.
    let section = source.rsplit('.').next().unwrap_or("");
    let shape = if source.contains('.') {
        if source.ends_with("repairs") {
            Shape::LocalOnly
        } else {
            detect_shape(section, &value)
        }
    } else {
        Shape::Local
    };
    Record { source: source.to_string(), index, shape, value }
}

fn ctx() -> Context {
    let mut c = Context::default();
    c.categories.insert("\u{0643}\u{0641}\u{0631}\u{0627}\u{062a}".to_string());
    c.categories.insert("\u{0634}\u{0648}\u{0627}\u{062d}\u{0646}".to_string());
    c.wallets.insert("\u{0641}\u{0648}\u{062f}\u{0627}\u{0641}\u{0648}\u{0646} \u{0643}\u{0627}\u{0634}".to_string());
    c.wallets.insert("\u{0627}\u{062a}\u{0635}\u{0627}\u{0644}\u{0627}\u{062a} \u{0643}\u{0627}\u{0634}".to_string());
    c.inventory_ids.insert("m1".to_string());
    c.internal_codes.insert("A55-128-BLK".to_string(), 1);
    c
}

fn outcomes_of(out: Vec<Outcome>) -> (Vec<String>, Vec<String>) {
    mshop_migration::validation::collect_outcomes(&out)
}

#[test]
fn money_rounds_half_away_and_rejects_nonsense() {
    assert_eq!(minor(&json!(19.99), false), Ok(1999));
    assert_eq!(minor(&json!(40), false), Ok(4000));
    assert_eq!(minor(&json!(0.005), false), Ok(1), "half a piastre rounds away from zero");
    assert!(minor(&json!(-1), false).is_err(), "negative where forbidden");
    assert_eq!(minor(&json!(-1), true), Ok(-100), "allowed where signed");
    assert!(minor(&Value::Null, false).is_err());
}

#[test]
fn timestamps_join_day_and_clock_without_claiming_a_zone() {
    assert_eq!(
        stamp(Some("2026-09-20"), Some("12:30"), None),
        Ok("2026-09-20T12:30:00".to_string())
    );
    assert_eq!(
        stamp(None, None, Some("2026-09-20T11:00:00.000Z")),
        Ok("2026-09-20T11:00:00.000Z".to_string())
    );
    assert!(stamp(Some("2026-09-20"), None, None).is_err(), "no clock, no timestamp");
    assert!(stamp(Some("2026-13-40"), Some("12:30"), None).is_err(), "no such date");
    assert!(stamp(Some("2026-09-20"), Some("25:00"), None).is_err(), "no such hour");
}

#[test]
fn accessory_rows_become_free_name_lines_with_verified_profit() {
    let r = rec(
        "mshop_d_2026-09-20.acc",
        0,
        json!({"snapshotName": "\u{0643}\u{0641}\u{0631} \u{0633}\u{064a}\u{0644}\u{064a}\u{0643}\u{0648}\u{0646}", "snapshotCategory": "\u{0643}\u{0641}\u{0631}\u{0627}\u{062a}",
               "buyAmount": 40, "sellAmount": 70, "profit": 30, "qty": 2,
               "createdAt": "2026-09-20T11:00:00.000Z"}),
    );
    let out = map_record(&ctx(), Some("2026-09-20"), &r);
    let sales: Vec<_> = out.iter().filter_map(|o| match o {
        Outcome::Sale(inv, line) => Some((inv, line)),
        _ => None,
    }).collect();
    assert_eq!(sales.len(), 1);
    let (inv, line) = sales[0];
    assert_eq!(inv.total_minor, 14000, "the invoice carries the extended total");
    assert_eq!(line.snapshot_name, "\u{0643}\u{0641}\u{0631} \u{0633}\u{064a}\u{0644}\u{064a}\u{0643}\u{0648}\u{0646}");
    // The legacy writer records per-unit margin (profit:s-b) even for qty 2,
    // so the row says 30 while the schema stores (70-40)*2 = 60. Both figures
    // survive: stored for the invariant, recorded for reconciliation.
    assert_eq!(line.profit_minor, 6000, "stored extended");
    assert_eq!(line.recorded_profit_minor, 3000, "recorded as legacy said");
    assert_eq!(line.recorded_total_minor, 7000, "legacy summed sell unmultiplied");
    assert!(line.model_legacy_id.is_none(), "never linked by name");
}

#[test]
fn stored_lines_always_satisfy_the_schema_invariant() {
    // Whatever the legacy row claimed, what gets stored must satisfy
    // profit = (price - cost) * qty, or the schema CHECK would refuse it.
    // This is the property the importer relies on without rechecking.
    let r = rec(
        "mshop_d_2026-09-20.acc",
        0,
        serde_json::json!({"snapshotName": "\u{0643}\u{0641}\u{0631} \u{0633}\u{064a}\u{0644}\u{064a}\u{0643}\u{0648}\u{0646}", "snapshotCategory": "\u{0643}\u{0641}\u{0631}\u{0627}\u{062a}",
               "buyAmount": 40, "sellAmount": 70, "profit": 30, "qty": 2,
               "createdAt": "2026-09-20T11:00:00.000Z"}),
    );
    let out = map_record(&ctx(), Some("2026-09-20"), &r);
    for o in &out {
        if let Outcome::Sale(_, line) = o {
            assert_eq!(
                line.profit_minor,
                (line.unit_price_minor - line.unit_cost_minor) * line.qty,
                "stored profit must satisfy the schema invariant"
            );
        }
    }
}

#[test]
fn rolled_rows_are_skipped_and_listed() {
    let r = rec(
        "mshop_d_2026-09-20.acc",
        2,
        json!({"name": "\u{0633}\u{0627}\u{0639}\u{0629}", "buy": 200, "sell": 260, "profit": 60, "time": "12:50", "_rolled": true}),
    );
    let out = map_record(&ctx(), Some("2026-09-20"), &r);
    assert!(out.iter().any(|o| matches!(o, Outcome::Skipped { .. })), "rolled must skip");
    assert!(!out.iter().any(|o| matches!(o, Outcome::Sale(..))), "rolled must not sell");
}

#[test]
fn profit_mismatch_is_a_hard_failure_naming_the_row() {
    let r = rec(
        "mshop_d_2026-09-20.acc",
        0,
        json!({"name": "\u{0634}\u{0627}\u{062d}\u{0646}", "mainCat": "\u{0634}\u{0648}\u{0627}\u{062d}\u{0646}", "buy": 100, "sell": 150, "profit": 49, "time": "12:30"}),
    );
    let out = map_record(&ctx(), Some("2026-09-20"), &r);
    let (blocked, _) = outcomes_of(out);
    assert_eq!(blocked.len(), 1);
    assert!(blocked[0].contains("profit"), "the failure must name the reason: {}", blocked[0]);
}

#[test]
fn unknown_category_never_invents_one() {
    let r = rec(
        "mshop_d_2026-09-20.acc",
        0,
        json!({"name": "x", "mainCat": "\u{063a}\u{064a}\u{0631} \u{0645}\u{0648}\u{062c}\u{0648}\u{062f}\u{0629}", "buy": 1, "sell": 2, "profit": 1, "time": "12:30"}),
    );
    let (blocked, _) = outcomes_of(map_record(&ctx(), Some("2026-09-20"), &r));
    assert!(blocked.iter().any(|b| b.contains("seed")), "must demand seeding: {blocked:?}");
}

#[test]
fn incomplete_services_block_with_the_gap_named() {
    for (paid, delivered) in [(false, true), (true, false), (false, false)] {
        let r = rec(
            "mshop_d_2026-09-20.sw",
            0,
            json!({"name": "\u{062a}\u{0646}\u{0632}\u{064a}\u{0644}", "price": 80, "paid": paid, "delivered": delivered, "time": "15:40"}),
        );
        let (blocked, _) = outcomes_of(map_record(&ctx(), Some("2026-09-20"), &r));
        assert_eq!(blocked.len(), 1, "paid={paid} delivered={delivered} must block");
        assert!(blocked[0].contains("receivable") || blocked[0].contains("pending"));
    }
}

#[test]
fn completed_services_map_as_free_lines_at_full_price() {
    let r = rec(
        "mshop_d_2026-09-20.sw",
        0,
        json!({"snapshotName": "\u{062a}\u{0641}\u{0639}\u{064a}\u{0644} \u{0634}\u{0627}\u{0634}\u{0629}", "amount": 150, "paid": true, "delivered": true,
               "createdAt": "2026-09-20T15:10:00.000Z"}),
    );
    let out = map_record(&ctx(), Some("2026-09-20"), &r);
    let lines: Vec<_> = out.iter().filter_map(|o| match o {
        Outcome::Sale(_, line) => Some(line),
        _ => None,
    }).collect();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].unit_cost_minor, 0, "no recorded cost: profit equals price, stated not derived");
    assert_eq!(lines[0].profit_minor, 15000);
}

#[test]
fn cash_sign_comes_from_type_and_unknown_types_fail() {
    let dep = rec(
        "mshop_d_2026-09-20.cash", 0,
        json!({"cashType": "\u{0627}\u{064a}\u{062f}\u{0627}\u{0639}", "service": "\u{0641}\u{0648}\u{062f}\u{0627}\u{0641}\u{0648}\u{0646} \u{0643}\u{0627}\u{0634}", "amount": 500, "time": "16:00"}),
    );
    let out = map_record(&ctx(), Some("2026-09-20"), &dep);
    let movements: Vec<_> = out.iter().filter_map(|o| match o {
        Outcome::Movement(m) => Some(m),
        _ => None,
    }).collect();
    assert_eq!(movements.len(), 1);
    assert_eq!(movements[0].amount_minor, 50000);

    let wit = rec(
        "mshop_d_2026-09-20.cash", 1,
        json!({"walletName": "\u{0627}\u{062a}\u{0635}\u{0627}\u{0644}\u{0627}\u{062a} \u{0643}\u{0627}\u{0634}", "cashType": "\u{0633}\u{062d}\u{0628}", "amount": 200,
               "createdAt": "2026-09-20T16:30:00.000Z"}),
    );
    let out = map_record(&ctx(), Some("2026-09-20"), &wit);
    let movements: Vec<_> = out.iter().filter_map(|o| match o {
        Outcome::Movement(m) => Some(m),
        _ => None,
    }).collect();
    assert_eq!(movements[0].amount_minor, -20000, "withdrawals are negative");

    let bad = rec(
        "mshop_d_2026-09-20.cash", 2,
        json!({"service": "\u{0641}\u{0648}\u{062f}\u{0627}\u{0641}\u{0648}\u{0646} \u{0643}\u{0627}\u{0634}", "cashType": "\u{062a}\u{062d}\u{0648}\u{064a}\u{0644}", "amount": 1, "time": "16:00"}),
    );
    let (blocked, _) = outcomes_of(map_record(&ctx(), Some("2026-09-20"), &bad));
    assert!(blocked.iter().any(|b| b.contains("cashType")), "unknown types stop: {blocked:?}");
}

#[test]
fn phone_sales_carry_the_legacy_id_for_later_resolution() {
    let r = rec(
        "mshop_d_2026-09-20.phones", 0,
        json!({"modelId": "m1", "snapshotModelName": "Samsung A55 8/128",
               "buyPrice": 9000, "sellPrice": 9600, "profit": 600, "qty": 1,
               "createdAt": "2026-09-20T13:00:00.000Z"}),
    );
    let out = map_record(&ctx(), Some("2026-09-20"), &r);
    let lines: Vec<_> = out.iter().filter_map(|o| match o {
        Outcome::Sale(_, line) => Some(line),
        _ => None,
    }).collect();
    assert_eq!(lines[0].model_legacy_id.as_deref(), Some("m1"));
    assert_eq!(lines[0].profit_minor, 60000);

    let ghost = rec(
        "mshop_d_2026-09-20.phones", 1,
        json!({"modelId": "m9", "snapshotModelName": "Ghost", "buyPrice": 1,
               "sellPrice": 2, "profit": 1, "createdAt": "2026-09-20T13:00:00.000Z"}),
    );
    let out = map_record(&ctx(), Some("2026-09-20"), &ghost);
    let (blocked, review) = outcomes_of(out);
    assert!(blocked.is_empty(), "an unresolvable id reviews, it does not block");
    assert!(review.iter().any(|r| r.contains("m9")), "the id stays attached: {review:?}");
}

#[test]
fn repairs_map_status_explicitly_and_unpaid_repairs_block() {
    let done = rec(
        "mshop_d_2026-09-20.repairs", 0,
        json!({"brand": "Huawei", "model": "P40", "servicePrice": 200, "profit": 100,
               "status": "\u{062a}\u{0645} \u{0627}\u{0644}\u{0625}\u{0635}\u{0644}\u{0627}\u{062d}", "clientName": "\u{0623}\u{062d}\u{0645}\u{062f}", "fixed": true,
               "delivered": false, "paid": true, "time": "18:00"}),
    );
    let out = map_record(&ctx(), Some("2026-09-20"), &done);
    let repairs: Vec<_> = out.iter().filter_map(|o| match o {
        Outcome::Repair(r, _) => Some(r),
        _ => None,
    }).collect();
    assert_eq!(repairs.len(), 1);
    assert_eq!(repairs[0].status, "done");
    assert!(!repairs[0].cancelled);
    assert_eq!(repairs[0].client_name.as_deref(), Some("\u{0623}\u{062d}\u{0645}\u{062f}"));

    let unpaid = rec(
        "mshop_d_2026-09-20.repairs", 1,
        json!({"servicePrice": 150, "status": "\u{062a}\u{0645} \u{0627}\u{0644}\u{0625}\u{0635}\u{0644}\u{0627}\u{062d}", "paid": false, "time": "19:00"}),
    );
    let (blocked, _) = outcomes_of(map_record(&ctx(), Some("2026-09-20"), &unpaid));
    assert!(blocked.iter().any(|b| b.contains("receivable")), "unpaid is a receivable: {blocked:?}");

    let strange = rec(
        "mshop_d_2026-09-20.repairs", 2,
        json!({"servicePrice": 150, "status": "\u{062d}\u{0627}\u{0644}\u{0629} \u{063a}\u{0631}\u{064a}\u{0628}\u{0629}", "paid": true, "time": "19:00"}),
    );
    let (blocked, _) = outcomes_of(map_record(&ctx(), Some("2026-09-20"), &strange));
    assert!(blocked.iter().any(|b| b.contains("unknown repair status")), "statuses are never coerced: {blocked:?}");
}

#[test]
fn inventory_products_emit_unknown_price_while_history_maps() {
    // Migration 0003 made price NULL for exactly this case: the stock is real,
    // the price is unknown, and neither zero nor omission is honest. The
    // product migrates with price None; its receptions map alongside it.
    let item = serde_json::json!({
        "id": "m1", "brand": "Samsung", "model": "A55", "internalCode": "A55-128-BLK",
        "qty": 4, "buyPrice": 9000,
        "purchaseHistory": [{"price": 9000, "supplier": "s", "date": "2026-09-18", "qty": 2}]
    });
    let r = rec("mshop_inventory", 0, item);
    let out = map_record(&ctx(), None, &r);
    let (blocked, review) = outcomes_of(out.clone());
    assert!(blocked.is_empty(), "nothing here blocks anymore: {blocked:?}");
    let products: Vec<_> = out.iter().filter_map(|o| match o {
        Outcome::Product(p) => Some(p),
        _ => None,
    }).collect();
    assert_eq!(products.len(), 1);
    assert_eq!(products[0].price_minor, None, "unknown is NULL, never zero");
    assert_eq!(products[0].origin_ref.as_deref(), Some("m1"), "stable id wins");
    assert!(out.iter().any(|o| matches!(o, Outcome::Purchase(_))), "receptions are facts and still map");
    assert!(review.iter().any(|r| r.contains("buyPrice")), "the dropped hint is named: {review:?}");
}

#[test]
fn unseeded_expense_category_blocks() {
    let r = rec(
        "mshop_d_2026-09-20.exp",
        0,
        serde_json::json!({"category": "rent", "amount": 120, "time": "17:00"}),
    );
    let (blocked, _) = outcomes_of(map_record(&ctx(), Some("2026-09-20"), &r));
    assert!(blocked.iter().any(|b| b.contains("seed")), "vocabularies are never created from rows: {blocked:?}");
}

#[test]
fn wallet_openings_anchor_to_a_day_or_block() {
    let cfg = || {
        rec(
            "mshop_wallets",
            0,
            serde_json::json!({"order": ["X"], "limits": {}, "opening": {"X": 1000}}),
        )
    };
    // Without a day there is nothing honest to date the opening with.
    let (blocked, _) = outcomes_of(map_record(&ctx(), None, &cfg()));
    assert!(blocked.iter().any(|b| b.contains("anchor")), "undated openings stop: {blocked:?}");

    let out = map_record(&ctx(), Some("2026-09-20"), &cfg());
    let movements: Vec<_> = out.iter().filter_map(|o| match o {
        Outcome::Movement(m) => Some(m),
        _ => None,
    }).collect();
    assert_eq!(movements.len(), 1);
    assert_eq!(movements[0].amount_minor, 100000);
    assert_eq!(movements[0].created_at, "2026-09-20T00:00:00");
}

#[test]
fn identity_is_deterministic_and_order_independent() {
    // The same bytes always yield the same ref, wherever the row sits: this is
    // what makes a second run a no-op instead of a duplication, and what
    // forbids index-derived ids.
    let row = || {
        rec(
            "mshop_d_2026-09-20.exp",
            0,
            serde_json::json!({"category": "rent", "amount": 120, "time": "17:00"}),
        )
    };
    // The row's category must be seeded first, or the rule under test is not
    // identity but the vocabulary gate.
    let mut seeded = ctx();
    seeded.expense_categories.insert("rent".to_string());
    let first = map_record(&seeded, Some("2026-09-20"), &row());
    let second = map_record(&seeded, Some("2026-09-20"), &row());
    let refs = |out: Vec<Outcome>| {
        out.into_iter()
            .filter_map(|o| match o {
                Outcome::Expense(e) => e.origin_ref,
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let (a, b) = (refs(first), refs(second));
    assert_eq!(a.len(), 1);
    assert_eq!(a, b, "same content must yield the same ref across runs");
    assert!(a[0].starts_with("sha256:"), "id-less rows hash their content: {}", a[0]);

    let named = rec(
        "mshop_d_2026-09-20.exp",
        5,
        serde_json::json!({"category": "rent", "amount": 120, "time": "17:00"}),
    );
    let third = map_record(&seeded, Some("2026-09-20"), &named);
    assert_eq!(refs(third), a, "index 0 and index 5 share one identity: content, not position");
}

#[test]
fn catalog_rows_become_zero_stock_products() {
    let r = rec("mshop_ca", 0, serde_json::json!({"name": "\u{0643}\u{0641}\u{0631}", "mainCat": "\u{0643}\u{0641}\u{0631}\u{0627}\u{062a}", "buy": 40, "sell": 70}));
    let out = map_record(&ctx(), None, &r);
    let products: Vec<_> = out.iter().filter_map(|o| match o {
        Outcome::Product(p) => Some(p),
        _ => None,
    }).collect();
    assert_eq!(products.len(), 1);
    assert_eq!(products[0].qty, 0, "no quantity exists anywhere: the opening stock-take provides it");
    assert_eq!(products[0].price_minor, Some(7000), "catalog prices are known");
}

