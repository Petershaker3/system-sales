//! Validation rules: what must hold before any importer writes anything.
//!
//! Validation answers three questions in order. First, is the export readable:
//! unknown shapes and unrecognized keys are hard failures, because proceeding
//! past an unreadable record means migrating around a hole nobody measured.
//! Second, did the mapping refuse anything: any `Blocked` outcome stops the
//! import, full stop, and the need field says what unblocks it. Third, do the
//! mapped rows still tell the legacy story: the legacy report formula,
//! reproduced exactly including its documented quirks, must match the expected
//! totals. A mismatch means the mapping changed the meaning of the data, and
//! the mapping is wrong, not the expectation.

use crate::mapping::{NewInvoiceLine, NewRepair, NewWalletMovement, Outcome};
use crate::reader::Export;
use std::collections::BTreeMap;

/// Legacy report totals for one day, using the legacy names so the comparison
/// reads against `computeFinancialTotals` without translation.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LegacyTotals {
    pub accessory_sell: i64,
    pub accessory_profit: i64,
    pub used_sell: i64,
    pub used_profit: i64,
    pub cash_total: i64,
    pub service_total: i64,
    pub expense_total: i64,
    pub phone_sell: i64,
    pub phone_profit: i64,
    pub repair_sell: i64,
    pub repair_profit: i64,
    /// sales = accessory sell + service + cash. Phone and repair sales are
    /// deliberately excluded: that is the legacy definition, preserved rather
    /// than corrected.
    pub sales_total: i64,
    /// profit = acc + used + cash + service + phones + repairs âˆ’ expenses.
    /// Cash enters whole including withdrawals, and services enter at price
    /// rather than profit: both are legacy behavior, reproduced exactly.
    pub profit_total: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub fatal: bool,
    pub message: String,
}

/// Runs every rule over a read export. Fatal issues stop an importer; the rest
/// form the manual review list. An empty fatal set with a non-empty review set
/// is a valid outcome: it means "migrates, but a human reads the list first".
pub fn validate_export(export: &Export) -> Vec<Issue> {
    let mut issues = Vec::new();
    for key in &export.unrecognized {
        issues.push(Issue {
            fatal: true,
            message: format!("unrecognized key {key}: nothing may vanish silently"),
        });
    }
    for (day, sections) in &export.days {
        for (section, records) in sections {
            for r in records {
                if matches!(r.shape, crate::reader::Shape::Unknown) {
                    issues.push(Issue {
                        fatal: true,
                        message: format!(
                            "{}[{}]: shape unknown; refusing to guess",
                            r.source, r.index
                        ),
                    });
                }
            }
            let _ = (day, section);
        }
    }
    issues
}

/// Collects blocks and reviews from mapping outcomes. Any block is fatal.
pub fn collect_outcomes(outcomes: &[Outcome]) -> (Vec<String>, Vec<String>) {
    let mut blocked = Vec::new();
    let mut review = Vec::new();
    for o in outcomes {
        match o {
            Outcome::Blocked(b) => {
                blocked.push(format!("{}[{}]: {} (need: {})", b.source, b.index, b.reason, b.need))
            }
            Outcome::Review(r) => review.push(format!("{}[{}]: {}", r.source, r.index, r.reason)),
            Outcome::Skipped { source, index, reason } => {
                review.push(format!("{source}[{index}]: skipped, {reason}"))
            }
            _ => {}
        }
    }
    (blocked, review)
}

/// Recomputes the legacy report from mapped rows.
///
/// The inputs are grouped sale lines with their section of origin, plus cash
/// movements, expenses, and repairs. Two different figures live on each line:
/// the stored (extended) values keep the schema invariant, and the recorded
/// values say what the legacy row claimed. Reconciliation sums the RECORDED
/// figures, because the question it answers is "does the mapping still tell
/// the legacy story", not "is the schema consistent" — the schema tests answer
/// that separately. The formula is the legacy one byte for byte: withdrawals
/// stay inside cash, services count at price, cancelled repairs leave profit
/// but stay in the service sum. If this disagrees with the expected totals,
/// the mapping changed what the data means.
///
/// One trap is worth naming up front, because it is easy to misread as a bug:
/// `cash_total` sums unsigned magnitudes while wallet balances sum signed
/// amounts. Both are correct, and they answer different questions. The loop
/// below carries the full argument with source references.
pub fn reconcile(
    lines: &BTreeMap<&str, Vec<NewInvoiceLine>>,
    movements: &[NewWalletMovement],
    expenses: &[(String, i64)],
    repairs: &[NewRepair],
) -> LegacyTotals {
    let mut t = LegacyTotals::default();
    for line in lines.get("acc").into_iter().flatten() {
        t.accessory_sell += line.recorded_total_minor;
        t.accessory_profit += line.recorded_profit_minor;
    }
    for line in lines.get("used").into_iter().flatten() {
        t.used_sell += line.recorded_total_minor;
        t.used_profit += line.recorded_profit_minor;
    }
    for m in movements {
        // Absolute value, and this is not a deliberate divergence from legacy —
        // it is how the legacy figure is rebuilt exactly.
        //
        // The legacy system stores `amount` as an unsigned magnitude and carries
        // the direction in a separate `cashType` field (`cash.js:10` writes the
        // raw number-input value; `entity_mappers.js:245,253` copies `amount`
        // through unchanged). It never stores a negative. Because of that, the
        // report line `cT = cash.reduce((s,i)=>s+i.amount,0)` (`ui.js:40`) sums
        // unsigned magnitudes, which is arithmetically identical to summing the
        // magnitudes of signed amounts — so `.abs()` reconstructs the stored
        // value rather than overriding the legacy rule.
        //
        // Do not "fix" this by dropping `.abs()`. The mapping signs the movement
        // (`cashType` -> +1/-1, mapping.rs) because a wallet balance must be
        // signed; `db_foundation.js:110` and `cash.js:42` both re-apply that same
        // sign from `cashType` when the legacy computes a balance. So for a
        // +1000 deposit and a -500 withdrawal:
        //
        //     report cT          = 1500  (sum of unsigned magnitudes)
        //     wallet balance     =  500  (sum of signed amounts)
        //
        // Two different numbers, both correct, answering two different
        // questions. Only the balance is signed. Dropping `.abs()` here would
        // silently turn every historical cash figure into a balance and break
        // fidelity with the report the shop actually used. See
        // tests::signed_cash_keeps_report_and_balance_apart, which locks both.
        t.cash_total += m.amount_minor.abs();
    }
    for line in lines.get("sw").into_iter().flatten() {
        t.service_total += line.recorded_total_minor;
    }
    for (category, amount) in expenses {
        let _ = category;
        t.expense_total += amount;
    }
    for line in lines.get("phones").into_iter().flatten() {
        t.phone_sell += line.recorded_total_minor;
        t.phone_profit += line.recorded_profit_minor;
    }
    // The service sum keeps cancelled repairs: the legacy rule excludes them
    // from profit but leaves them in the service total, so the two sums read
    // different row sets on purpose.
    for r in repairs.iter() {
        t.repair_sell += r.service_price_minor;
    }
    for r in repairs.iter().filter(|r| !r.cancelled) {
        t.repair_profit += r.profit_minor.unwrap_or(0);
    }
    t.sales_total = t.accessory_sell + t.service_total + t.cash_total;
    t.profit_total = t.accessory_profit
        + t.used_profit
        + t.cash_total
        + t.service_total
        + t.phone_profit
        + t.repair_profit
        - t.expense_total;
    t
}



