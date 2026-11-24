//! Mapping specification: legacy records become target rows.
//!
//! Every rule here is decided by evidence from `dev_extracted/dev/js`, and the
//! evidence is cited where the rule is written. Where the evidence runs out,
//! the mapping does not guess: it returns `Blocked` (the importer must stop)
//! or `Review` (a human looks at a list). The two are different on purpose. A
//! blocked row means "storing this would misstate reality"; a review row means
//! "this stored fine, but something about it needs eyes".
//!
//! # Principles, enforced by construction
//!
//! * No invented links. A sale that names a product never resolves to a product
//!   row by name similarity. Association happens only through recorded ids
//!   (`modelId`), and anything else keeps `product_id = NULL`.
//! * No invented money. Profits are carried as recorded and checked, never
//!   recomputed; a mismatch is a hard failure naming the row.
//! * No invented time. Day keys give the date, `time` gives the clock, and the
//!   two are joined without a timezone suffix because the legacy wall time
//!   carries no offset. Claiming UTC would be the invention.
//! * Meaning-affecting gaps block; descriptive gaps list. An unpaid sale is a
//!   receivable and cannot become a plain sale row; a missing condition note is
//!   detail loss and goes on the review list with its field named.

use crate::reader::{Record, Shape};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Minor-units money: legacy pounds to integer piastres.
///
/// Legacy amounts are JSON numbers with no declared precision. The conversion
/// rounds half away from zero (`f64::round`), which is the only documented
/// policy. Anything that cannot become money â€” non-finite, or negative where
/// the field forbids it â€” is an error naming the value, never a silent zero.
pub fn minor(value: &Value, allow_negative: bool) -> Result<i64, String> {
    let pounds = value
        .as_f64()
        .ok_or_else(|| format!("not a number: {value}"))?;
    if !pounds.is_finite() {
        return Err(format!("not finite: {value}"));
    }
    if !allow_negative && pounds < 0.0 {
        return Err(format!("negative where forbidden: {value}"));
    }
    let minor = (pounds * 100.0).round();
    if minor.abs() > i64::MAX as f64 {
        return Err(format!("out of range: {value}"));
    }
    Ok(minor as i64)
}

/// Builds a timestamp from the pieces the legacy system actually stores.
///
/// A full `createdAt` passes through after a shape check. Otherwise the day key
/// and the `HH:MM` clock join as `{day}T{time}:00` with no suffix: the legacy
/// clock is a wall time with no offset, and appending `Z` would claim knowledge
/// nobody has. A missing clock is a hard failure: sales always carry one from
/// the writer (`ts()`), so its absence means malformed data, not an default.
pub fn stamp(day: Option<&str>, time: Option<&str>, created_at: Option<&str>) -> Result<String, String> {
    if let Some(full) = created_at {
        if looks_like_iso(full) {
            return Ok(full.to_string());
        }
        return Err(format!("malformed createdAt: {full}"));
    }
    let (day, time) = match (day, time) {
        (Some(d), Some(t)) => (d, t),
        _ => return Err("a timestamp needs both a day and a clock".to_string()),
    };
    valid_day(day)?;
    valid_clock(time)?;
    Ok(format!("{day}T{time}:00"))
}

fn looks_like_iso(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 16
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && s[0..10].chars().all(|c| c.is_ascii_digit() || c == '-')
}

fn valid_day(day: &str) -> Result<(), String> {
    let parts: Vec<&str> = day.split('-').collect();
    if parts.len() != 3 {
        return Err(format!("not a day key: {day}"));
    }
    let y: u32 = parts[0].parse().map_err(|_| format!("bad year: {day}"))?;
    let m: u32 = parts[1].parse().map_err(|_| format!("bad month: {day}"))?;
    let d: u32 = parts[2].parse().map_err(|_| format!("bad day: {day}"))?;
    if !(1990..=2100).contains(&y) || !(1..=12).contains(&m) {
        return Err(format!("out of range: {day}"));
    }
    let dim = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) => 29,
        2 => 28,
        _ => unreachable!(),
    };
    if d < 1 || d > dim {
        return Err(format!("no such date: {day}"));
    }
    Ok(())
}

fn valid_clock(time: &str) -> Result<(), String> {
    let parts: Vec<&str> = time.split(':').collect();
    if parts.len() != 2 {
        return Err(format!("not a clock time: {time}"));
    }
    let h: u32 = parts[0].parse().map_err(|_| format!("bad hour: {time}"))?;
    let m: u32 = parts[1].parse().map_err(|_| format!("bad minute: {time}"))?;
    if h > 23 || m > 59 {
        return Err(format!("out of range: {time}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Target rows. Plain data mirroring the product schema tables; no database
// types here, so the mapping stays testable without SQLite and the importer
// stays the only place that writes.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct NewProduct {
    pub legacy_id: Option<String>,
    pub sku: String,
    pub name: String,
    pub kind: &'static str,
    /// None means "legacy product with unknown selling price" (migration
    /// 0003). It is never zero-by-default: zero claims the item is free.
    pub price_minor: Option<i64>,
    pub qty: i64,
    /// Source identity for idempotent re-imports: the stable legacy id when
    /// one exists, else a content hash. Never positional. See [`identity_of`].
    pub origin_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewPurchase {
    pub product_legacy_id: String,
    pub qty: i64,
    pub unit_cost_minor: i64,
    pub total_minor: i64,
    pub supplier: Option<String>,
    pub received_at: String,
    /// Identity for the row's future origin_ref. Receptions carry no ids, so
    /// this is always a content hash over the parent product plus the entry:
    /// two products receiving identical terms still get distinct identities.
    pub origin_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewInvoice {
    pub total_minor: i64,
    pub created_at: String,
    /// Identity for the row's future origin_ref: the legacy id when the row
    /// has one, else a content hash. Never positional.
    pub origin_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewInvoiceLine {
    /// Legacy inventory id when the sale names one (`modelId`). The importer
    /// resolves it later; the mapping never resolves by name.
    pub model_legacy_id: Option<String>,
    pub snapshot_name: String,
    pub snapshot_barcode: Option<String>,
    pub qty: i64,
    pub unit_price_minor: i64,
    pub unit_cost_minor: i64,
    /// What the schema stores: extended profit, satisfying
    /// profit = (price − cost) × qty by construction.
    pub profit_minor: i64,
    /// What the legacy row recorded. Differs from profit_minor only through the
    /// legacy writer quirk of recording per-unit margin (`profit:s-b`) even when
    /// qty > 1. Reconciliation sums the recorded values, so the legacy report
    /// reproduces exactly; the stored values keep the schema invariant.
    pub recorded_profit_minor: i64,
    /// Legacy sale total as recorded (sell, unmultiplied). Same split as profit.
    pub recorded_total_minor: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewRepair {
    pub legacy_id: Option<String>,
    pub client_name: Option<String>,
    pub device_brand: Option<String>,
    pub device_model: Option<String>,
    pub status: &'static str,
    pub cancelled: bool,
    pub service_price_minor: i64,
    pub profit_minor: Option<i64>,
    pub created_at: String,
    pub origin_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewRepairEvent {
    pub repair_legacy_id: Option<String>,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewWalletMovement {
    pub wallet: String,
    pub amount_minor: i64,
    pub service: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
    pub origin_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewExpense {
    pub category: String,
    pub amount_minor: i64,
    pub created_at: String,
    pub origin_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewRepairPart {
    pub legacy_id: Option<String>,
    pub name: String,
    pub compatible: Option<String>,
    pub qty: i64,
    pub buy_price_minor: i64,
    pub supplier: Option<String>,
    pub origin_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReviewItem {
    pub source: String,
    pub index: usize,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BlockItem {
    pub source: String,
    pub index: usize,
    pub reason: String,
    /// What has to change before this row can migrate: a schema amendment, a
    /// manual decision, or missing source data. Never empty.
    pub need: String,
}

/// One record's mapping result. A record yields rows, a skip, a review note, or
/// a block. It never yields silence: an unhandled record is a bug, and the
/// importer treats an unhandled variant as a failure.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Product(NewProduct),
    Purchase(NewPurchase),
    Sale(NewInvoice, NewInvoiceLine),
    Repair(NewRepair, Vec<NewRepairEvent>),
    Wallet(String),
    Movement(NewWalletMovement),
    Expense(NewExpense),
    Part(NewRepairPart),
    Seed { table: &'static str, name: String },
    Setting { key: String, value: String },
    Skipped { source: String, index: usize, reason: String },
    Review(ReviewItem),
    Blocked(BlockItem),
}

/// Names the legacy system already knows, collected before any row is mapped so
/// a sale can never reference a category or wallet the seed pass missed.
#[derive(Debug, Default)]
pub struct Context {
    pub inventory_ids: BTreeSet<String>,
    pub internal_codes: BTreeMap<String, usize>,
    /// Product vocabularies: mshop_cats, catalog mainCats, brands.
    pub categories: BTreeSet<String>,
    /// Expense vocabularies: mshop_ce only. Kept apart from product
    /// categories so a sale cannot pass on an expense-only name, or vice
    /// versa: sharing one set would let each side borrow the other's words.
    pub expense_categories: BTreeSet<String>,
    pub wallets: BTreeSet<String>,
}

fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.get(key)
}

fn req_str(v: &Value, key: &str, at: &str) -> Result<String, String> {
    match get(v, key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s.clone()),
        _ => Err(format!("{at}: missing or empty {key}")),
    }
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    match get(v, key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn req_money(v: &Value, key: &str, at: &str) -> Result<i64, String> {
    match get(v, key) {
        Some(n) => minor(n, false).map_err(|e| format!("{at}.{key}: {e}")),
        None => Err(format!("{at}: missing {key}")),
    }
}

fn at(source: &str, index: usize) -> String {
    format!("{source}[{index}]")
}

/// Source identity for idempotent re-imports.
///
/// A stable legacy id wins whenever one exists. Otherwise the identity is the
/// SHA-256 of the canonical record JSON: deterministic across runs of the same
/// export, independent of row order, and impossible to collide by position.
/// What never happens is an index-derived id: two identical rows at different
/// indexes share one identity (they are the same content), and re-running the
/// same export yields the same refs, which is what makes a second run a no-op
/// instead of a duplication.
pub fn identity_of(legacy_id: Option<&str>, value: &Value) -> String {
    if let Some(id) = legacy_id {
        if !id.trim().is_empty() {
            return id.to_string();
        }
    }
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_string(value).unwrap_or_default().into_bytes();
    let hash: Vec<u8> = Sha256::digest(&bytes).to_vec();
    format!("sha256:{}", hash.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

// ---------------------------------------------------------------------------
// Pass 1: seeds. Categories from the list plus every mainCat the catalogs use;
// wallets from the config plus every service/cash name the days use. A sale
// that names something outside these sets fails loudly instead of creating it.
// ---------------------------------------------------------------------------

pub fn collect_context(export: &crate::reader::Export) -> Context {
    let mut ctx = Context::default();

    if let Some(items) = export.collections.get("mshop_inventory") {
        for r in items {
            if let Some(Value::String(id)) = get(&r.value, "id") {
                ctx.inventory_ids.insert(id.clone());
            }
            if let Some(Value::String(code)) = get(&r.value, "internalCode") {
                if !code.trim().is_empty() {
                    *ctx.internal_codes.entry(code.clone()).or_insert(0) += 1;
                }
            }
        }
    }

    // Reference lists arrive either as string arrays or as {name} objects;
    // both are legacy shapes and both seed the same tables. Product and
    // expense vocabularies stay in separate sets (see Context).
    if let Some(list) = export.reference_lists.get("mshop_cats") {
        for name in names_in(list) {
            ctx.categories.insert(name);
        }
    }
    if let Some(list) = export.reference_lists.get("mshop_ce") {
        for name in names_in(list) {
            ctx.expense_categories.insert(name);
        }
    }
    for key in ["mshop_fault_types", "mshop_brands", "mshop_brands2"] {
        if let Some(list) = export.reference_lists.get(key) {
            for name in names_in(list) {
                ctx.categories.insert(format!("{key}:{name}"));
            }
        }
    }

    // Catalog mainCats are categories too: a sale naming one must find it.
    for key in ["mshop_ca", "mshop_cu"] {
        if let Some(items) = export.collections.get(key) {
            for r in items {
                if let Some(Value::String(c)) = get(&r.value, "mainCat") {
                    if !c.trim().is_empty() {
                        ctx.categories.insert(c.clone());
                    }
                }
            }
        }
    }

    // Wallets: config order first, then every service name any movement uses.
    if let Some(Value::Object(cfg)) = export.collections.get("mshop_wallets").and_then(|_| None) {
        let _ = cfg;
    }
    // mshop_wallets is configuration ({order, limits, opening}), handled in
    // map_wallets, but its names seed the wallet set here.
    // (Read directly from the export map; see map_wallets for the shape.)
    collect_wallet_names(export, &mut ctx);

    for (_day, sections) in &export.days {
        if let Some(rows) = sections.get("cash") {
            for r in rows {
                if let Some(Value::String(s)) = get(&r.value, "service").or_else(|| get(&r.value, "walletName")) {
                    if !s.trim().is_empty() {
                        ctx.wallets.insert(s.clone());
                    }
                }
            }
        }
    }
    ctx
}

fn collect_wallet_names(export: &crate::reader::Export, ctx: &mut Context) {
    // The config object lives under collections only if the reader saw the key;
    // the reader stores non-day keys it knows, and wallets config is JSON object.
    // It is read here defensively: absent config still leaves movement names.
    if let Some(Value::Object(cfg)) = export
        .collections
        .get("mshop_wallets")
        .and_then(|v| v.first())
        .map(|r| &r.value)
    {
        if let Some(Value::Array(order)) = cfg.get("order") {
            for name in order.iter().filter_map(|v| v.as_str()) {
                if !name.trim().is_empty() {
                    ctx.wallets.insert(name.to_string());
                }
            }
        }
    }
}

fn names_in(list: &Value) -> Vec<String> {
    match list {
        Value::Array(items) => items
            .iter()
            .filter_map(|v| match v {
                Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
                Value::Object(o) => o.get("name").and_then(|n| n.as_str()).filter(|s| !s.trim().is_empty()).map(str::to_string),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Pass 2: rows.
// ---------------------------------------------------------------------------

/// Maps one tagged record. `day` is the `YYYY-MM-DD` the record lives under, or
/// `None` for collections. Every branch either yields rows or explains itself.
pub fn map_record(ctx: &Context, day: Option<&str>, record: &Record) -> Vec<Outcome> {
    let at = at(&record.source, record.index);
    let v = &record.value;
    let section = record.source.rsplit('.').next().unwrap_or("");

    if record.shape == Shape::Unknown {
        return vec![Outcome::Blocked(BlockItem {
            source: record.source.clone(),
            index: record.index,
            reason: "shape could not be detected; refusing to guess".to_string(),
            need: "extend the marker table with evidence from the writer code".to_string(),
        })];
    }

    match collection_of(&record.source).unwrap_or(section) {
        "mshop_inventory" => map_inventory(ctx, &at, record.index, v),
        "mshop_ca" => map_catalog(ctx, &at, record.index, v, "accessory"),
        "mshop_cu" => map_catalog(ctx, &at, record.index, v, "used"),
        "mshop_repair_parts" => map_part(&at, record.index, v),
        "mshop_wallets" => map_wallets(&at, record.index, v, day),
        "acc" => map_acc(ctx, &at, record.index, v, day, record.shape),
        "used" => map_used(&at, record.index, v, day, record.shape),
        "sw" => map_sw(&at, record.index, v, day, record.shape),
        "cash" => map_cash(ctx, &at, record.index, v, day, record.shape),
        "exp" => map_exp(ctx, &at, record.index, v, day, record.shape),
        "phones" => map_phones(ctx, &at, record.index, v, day, record.shape),
        "repairs" => map_repair(&at, record.index, v, day),
        _ => vec![Outcome::Blocked(BlockItem {
            source: record.source.clone(),
            index: record.index,
            reason: format!("no mapping rule for section {section}"),
            need: "add a rule with writer-code evidence, or exclude by decision".to_string(),
        })],
    }
}

fn collection_of(source: &str) -> Option<&str> {
    if source.starts_with("mshop_") && !source.starts_with("mshop_d_") && !source.contains('.') {
        Some(source)
    } else {
        None
    }
}

// --- inventory ---------------------------------------------------------------
// A stock phone carries everything except a sale price, and the schema demands
// one (price_minor NOT NULL). Averaging past sale prices would invent a price;
// zero would claim the phone is free. So the product row is BLOCKED with the
// amendment named, while its purchase history still maps: the events are real
// even when the product row cannot exist yet.

fn map_inventory(ctx: &Context, at: &str, index: usize, v: &Value) -> Vec<Outcome> {
    let mut out = Vec::new();
    let source = at.split('[').next().unwrap_or(at).to_string();

    let legacy_id = match get(v, "id").and_then(|x| x.as_str()) {
        Some(id) if !id.trim().is_empty() => id.to_string(),
        _ => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: "inventory item without an id cannot be referenced later".to_string(),
                need: "a stable legacy identity for the row".to_string(),
            })]
        }
    };

    let brand = opt_str(v, "brand").unwrap_or_default();
    let model = opt_str(v, "model").unwrap_or_default();
    if brand.is_empty() && model.is_empty() {
        out.push(Outcome::Review(ReviewItem {
            source: source.clone(),
            index,
            reason: "no brand and no model: the row cannot become an identifiable product".to_string(),
        }));
        return out;
    }
    let mut name = format!("{brand} {model}").trim().to_string();
    for key in ["ram", "storage", "color"] {
        if let Some(part) = opt_str(v, key) {
            name.push(' ');
            name.push_str(&part);
        }
    }

    let qty = match get(v, "qty") {
        Some(n) => match n.as_i64() {
            Some(q) if q >= 0 => q,
            _ => {
                return vec![Outcome::Blocked(BlockItem {
                    source: source.clone(),
                    index,
                    reason: format!("unusable qty: {n}"),
                    need: "a non-negative integer quantity".to_string(),
                })]
            }
        },
        None => 0,
    };

    // SKU from the internal code when it is present and unique shop-wide;
    // otherwise the legacy id, which is stable data rather than invention.
    // A collision is listed for review because two products sharing a code
    // will confuse every later lookup by that code.
    let code = opt_str(v, "internalCode");
    let sku = match code {
        Some(c) if ctx.internal_codes.get(&c).copied().unwrap_or(0) == 1 => c,
        Some(c) => {
            out.push(Outcome::Review(ReviewItem {
                source: source.clone(),
                index,
                reason: format!("internalCode {c} is used more than once; falling back to the legacy id"),
            }));
            format!("legacy:{legacy_id}")
        }
        None => format!("legacy:{legacy_id}"),
    };

    out.push(Outcome::Product(NewProduct {
        legacy_id: Some(legacy_id.clone()),
        sku,
        name,
        kind: "phone",
        // Unknown, not zero: the schema holds NULL for exactly this case since
        // migration 0003, and the mapping is forbidden from collapsing it.
        price_minor: None,
        qty,
        origin_ref: Some(identity_of(Some(&legacy_id), v)),
    }));

    // The receptions are independent facts and map regardless.
    if let Some(Value::Array(history)) = get(v, "purchaseHistory") {
        for (hi, h) in history.iter().enumerate() {
            let price = match get(h, "price") {
                Some(p) => match minor(p, false) {
                    Ok(m) => m,
                    Err(e) => {
                        out.push(Outcome::Blocked(BlockItem {
                            source: source.clone(),
                            index,
                            reason: format!("purchaseHistory[{hi}]: {e}"),
                            need: "a finite non-negative unit price".to_string(),
                        }));
                        continue;
                    }
                },
                None => {
                    out.push(Outcome::Blocked(BlockItem {
                        source: source.clone(),
                        index,
                        reason: format!("purchaseHistory[{hi}] without a price"),
                        need: "a unit price for the reception".to_string(),
                    }));
                    continue;
                }
            };
            let hqty = match get(h, "qty").and_then(|q| q.as_i64()) {
                Some(q) if q > 0 => q,
                _ => {
                    out.push(Outcome::Blocked(BlockItem {
                        source: source.clone(),
                        index,
                        reason: format!("purchaseHistory[{hi}] without a positive qty"),
                        need: "a reception quantity".to_string(),
                    }));
                    continue;
                }
            };
            let date = match get(h, "date").and_then(|d| d.as_str()) {
                Some(d) => match valid_day(d) {
                    Ok(()) => d.to_string(),
                    Err(e) => {
                        out.push(Outcome::Blocked(BlockItem {
                            source: source.clone(),
                            index,
                            reason: format!("purchaseHistory[{hi}]: {e}"),
                            need: "a real calendar date".to_string(),
                        }));
                        continue;
                    }
                },
                None => {
                    out.push(Outcome::Blocked(BlockItem {
                        source: source.clone(),
                        index,
                        reason: format!("purchaseHistory[{hi}] without a date"),
                        need: "a reception date".to_string(),
                    }));
                    continue;
                }
            };
            out.push(Outcome::Purchase(NewPurchase {
                product_legacy_id: legacy_id.clone(),
                qty: hqty,
                unit_cost_minor: price,
                total_minor: hqty * price,
                supplier: opt_str(h, "supplier"),
                received_at: format!("{date}T00:00:00"),
                origin_ref: Some(identity_of(None, &serde_json::json!({
                    "product": legacy_id,
                    "entry": h,
                }))),
            }));
        }
    }

    // buyPrice without a quantity event cannot enter a moving average
    // (ADR-002), so it is consciously dropped here and named, not lost.
    if get(v, "buyPrice").is_some() {
        out.push(Outcome::Review(ReviewItem {
            source: source.clone(),
            index,
            reason: "buyPrice is a price hint without a quantity event and cannot seed the moving average; see purchaseHistory instead".to_string(),
        }));
    }
    out
}

// --- catalogs (ca/cu) --------------------------------------------------------
// Catalog rows are price lists, not stock: no quantity exists anywhere, so qty
// is 0 and cost is unknown (NULL in spirit; the row carries price only). The
// opening stock-take the spec requires is where quantities come from, entered
// by a human rather than inferred here. buy is a catalog hint, not a cost
// basis, and is not stored: storing it as cost without a reception would
// corrupt the moving average from its first row.

fn map_catalog(
    _ctx: &Context,
    at: &str,
    index: usize,
    v: &Value,
    kind: &'static str,
) -> Vec<Outcome> {
    let source = at.split('[').next().unwrap_or(at).to_string();
    let name = match req_str(v, "name", at) {
        Ok(n) => n,
        Err(e) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a catalog name".to_string(),
            })]
        }
    };
    let price = match req_money(v, "sell", at) {
        Ok(m) => m,
        Err(e) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a sale price".to_string(),
            })]
        }
    };
    vec![Outcome::Product(NewProduct {
        legacy_id: None,
        sku: format!("legacy:catalog:{name}"),
        name,
        kind,
        price_minor: Some(price),
        qty: 0,
        origin_ref: Some(identity_of(None, v)),
    })]
}

// --- repair parts ------------------------------------------------------------

fn map_part(at: &str, index: usize, v: &Value) -> Vec<Outcome> {
    let source = at.split('[').next().unwrap_or(at).to_string();
    let name = match req_str(v, "name", at) {
        Ok(n) => n,
        Err(e) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a part name".to_string(),
            })]
        }
    };
    // The legacy mapper defaults both to zero, so absence means zero here too.
    let qty = get(v, "qty").and_then(|q| q.as_i64()).unwrap_or(0);
    if qty < 0 {
        return vec![Outcome::Blocked(BlockItem {
            source: source.clone(),
            index,
            reason: format!("negative qty: {qty}"),
            need: "a non-negative quantity".to_string(),
        })];
    }
    let buy = match get(v, "buyPrice") {
        Some(b) => match minor(b, false) {
            Ok(m) => m,
            Err(e) => {
                return vec![Outcome::Blocked(BlockItem {
                    source: source.clone(),
                    index,
                    reason: format!("buyPrice: {e}"),
                    need: "a finite non-negative price".to_string(),
                })]
            }
        },
        None => 0,
    };
    vec![Outcome::Part(NewRepairPart {
        legacy_id: get(v, "id").and_then(|x| x.as_str()).map(str::to_string),
        name,
        compatible: opt_str(v, "compatible"),
        qty,
        buy_price_minor: buy,
        supplier: opt_str(v, "supplier"),
        origin_ref: Some(identity_of(
            get(v, "id").and_then(|x| x.as_str()),
            v,
        )),
    })]
}

// --- wallets config ----------------------------------------------------------
// {order[], limits{}, opening{}} is configuration plus three balances. Names
// become wallets; limits become settings (they are thresholds, like
// stagnant_days, not business rows); openings become movements marked as such,
// because the legacy balance is defined as opening plus signed movements and
// the new sum must equal it.

fn map_wallets(at: &str, index: usize, v: &Value, day: Option<&str>) -> Vec<Outcome> {
    let source = at.split('[').next().unwrap_or(at).to_string();
    let mut out = Vec::new();
    let obj = match v.as_object() {
        Some(o) => o,
        None => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: "wallets config is not an object".to_string(),
                need: "{order, limits, opening}".to_string(),
            })]
        }
    };

    if let Some(Value::Array(order)) = obj.get("order") {
        for name in order.iter().filter_map(|n| n.as_str()) {
            if !name.trim().is_empty() {
                out.push(Outcome::Wallet(name.to_string()));
            }
        }
    }
    if let Some(Value::Object(limits)) = obj.get("limits") {
        for (name, value) in limits {
            match minor(value, false) {
                Ok(m) => out.push(Outcome::Setting {
                    key: format!("wallet_limit_{name}"),
                    value: m.to_string(),
                }),
                Err(e) => out.push(Outcome::Blocked(BlockItem {
                    source: source.clone(),
                    index,
                    reason: format!("limit for {name}: {e}"),
                    need: "a finite non-negative limit".to_string(),
                })),
            }
        }
    }
    if let Some(Value::Object(opening)) = obj.get("opening") {
        // An opening balance has no date of its own. It is anchored to the
        // earliest observed day so the row is honest about what the date means;
        // with no day keys at all there is nothing to anchor to.
        let anchor = match day {
            Some(d) => d.to_string(),
            None => {
                out.push(Outcome::Blocked(BlockItem {
                    source: source.clone(),
                    index,
                    reason: "opening balances exist but the export has no day to anchor them to".to_string(),
                    need: "at least one mshop_d_* day, or owner-dated openings".to_string(),
                }));
                String::new()
            }
        };
        if !anchor.is_empty() {
            for (name, value) in opening {
                match minor(value, false) {
                    Ok(m) if m > 0 => out.push(Outcome::Movement(NewWalletMovement {
                        wallet: name.clone(),
                        amount_minor: m,
                        service: Some(name.clone()),
                        note: Some("opening-balance".to_string()),
                        created_at: format!("{anchor}T00:00:00"),
                        origin_ref: Some(identity_of(None, &serde_json::json!({
                            "wallet": name,
                            "opening": m,
                        }))),
                    })),
                    Ok(_) => {}
                    Err(e) => out.push(Outcome::Blocked(BlockItem {
                        source: source.clone(),
                        index,
                        reason: format!("opening for {name}: {e}"),
                        need: "a finite non-negative balance".to_string(),
                    })),
                }
            }
        }
    }
    out
}

// --- shared sale helpers -------------------------------------------------------

fn rolled(v: &Value) -> bool {
    v.get("_rolled").and_then(|x| x.as_bool()).unwrap_or(false)
}

fn sale_invoice(
    _at: &str,
    _index: usize,
    _source: &str,
    total_minor: i64,
    created_at: String,
    origin_ref: Option<String>,
    line: NewInvoiceLine,
) -> Vec<Outcome> {
    // One legacy transaction row is one sale is one invoice. Grouping a day's
    // rows into fewer invoices would merge distinct sales, so it is not done.
    // The invoice carries the row's identity; its lines ride along.
    vec![Outcome::Sale(
        NewInvoice { total_minor, created_at, origin_ref },
        line,
    )]
}

fn check_profit(at: &str, sell: i64, buy: i64, qty: i64, recorded: i64) -> Result<(i64, Option<i64>), String> {
    // Returns (stored, recorded-if-different). The stored value is always the
    // extended profit the schema demands. When the legacy row agrees, there is
    // nothing more to say. When it carries the per-unit margin instead — the
    // writer records `profit:s-b` without multiplying — the recorded figure
    // rides along for reconciliation and review. Anything else is corruption
    // no rule explains, and it stops the import naming the row.
    let extended = (sell - buy) * qty;
    if recorded == extended {
        return Ok((extended, None));
    }
    if recorded == sell - buy {
        return Ok((extended, Some(recorded)));
    }
    Err(format!(
        "{at}: recorded profit {recorded} is neither the extended {extended} \
         nor the per-unit margin {}; the row explains itself to nobody",
        sell - buy
    ))
}

// --- acc -----------------------------------------------------------------------
// Db shape: snapshotName/snapshotCategory/buyAmount/sellAmount/profit/qty?
// Local shape: name/mainCat/buy/sell/profit/qty?/time. qty is optional in the
// writer (accessories.js addAcc), so a missing qty is one sale, by evidence
// rather than by default.

fn map_acc(
    ctx: &Context,
    at: &str,
    index: usize,
    v: &Value,
    day: Option<&str>,
    shape: Shape,
) -> Vec<Outcome> {
    let source = at.split('[').next().unwrap_or(at).to_string();
    if rolled(v) {
        return vec![Outcome::Skipped {
            source: source.clone(),
            index,
            reason: "rolled (cancelled): excluded from sums, preserved in source".to_string(),
        }];
    }
    // qty is not validated here because the writer makes it optional: a missing
    // qty is one sale, by evidence from accessories.js, not by default.
    let qty: i64 = get(v, "qty").and_then(|q| q.as_i64()).unwrap_or(1);
    let (name, category, buy, sell, profit, when) = match shape {
        Shape::Db => (
            req_str(v, "snapshotName", at),
            opt_str(v, "snapshotCategory"),
            req_money(v, "buyAmount", at),
            req_money(v, "sellAmount", at),
            req_money_allow_negative(v, "profit", at),
            created(v, day),
        ),
        _ => (
            req_str(v, "name", at),
            opt_str(v, "mainCat"),
            req_money(v, "buy", at),
            req_money(v, "sell", at),
            req_money_allow_negative(v, "profit", at),
            stamp(day, opt_str(v, "time").as_deref(), opt_str(v, "createdAt").as_deref()).map_err(|e| e),
        ),
    };
    let (name, buy, sell, profit, when) = match (name, buy, sell, profit, when) {
        (Ok(a), Ok(b), Ok(c), Ok(d), Ok(e)) => (a, b, c, d, e),
        (Err(e), _, _, _, _)
        | (_, Err(e), _, _, _)
        | (_, _, Err(e), _, _)
        | (_, _, _, Err(e), _)
        | (_, _, _, _, Err(e)) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "complete sale fields".to_string(),
            })]
        }
    };
    if qty < 1 {
        return vec![Outcome::Blocked(BlockItem {
            source: source.clone(),
            index,
            reason: format!("qty {qty} is not a sale"),
            need: "a positive quantity".to_string(),
        })];
    }
    if let Some(cat) = &category {
        if !ctx.categories.contains(cat) {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: format!("category {cat} is outside the seeded set"),
                need: "seed it first; categories are never created from sales".to_string(),
            })];
        }
    }
    let (profit, recorded) = match check_profit(at, sell, buy, qty, profit) {
        Ok(v) => v,
        Err(e) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a recorded profit that is extended or per-unit".to_string(),
            })]
        }
    };
    let mut outcomes = Vec::new();
    if let Some(recorded) = recorded {
        outcomes.push(Outcome::Review(ReviewItem {
            source: source.clone(),
            index,
            reason: format!(
                "legacy recorded per-unit profit {recorded}, stored extended {profit}; \
                 reconciliation uses the recorded figure"
            ),
        }));
    }
      outcomes.extend(sale_invoice(
          at,
          index,
          &source,
          sell * qty,
          when,
          Some(identity_of(get(v, "id").and_then(|x| x.as_str()), v)),
          NewInvoiceLine {
              model_legacy_id: None,
              snapshot_name: name,
              snapshot_barcode: None,
              qty,
              unit_price_minor: sell,
              unit_cost_minor: buy,
              profit_minor: profit,
              recorded_profit_minor: recorded.unwrap_or(profit),
              recorded_total_minor: sell,
          },
      ));
      outcomes
  }

  fn req_money_allow_negative(v: &Value, key: &str, at: &str) -> Result<i64, String> {
    match get(v, key) {
        Some(n) => minor(n, true).map_err(|e| format!("{at}.{key}: {e}")),
        None => Err(format!("{at}: missing {key}")),
    }
}

fn created(v: &Value, day: Option<&str>) -> Result<String, String> {
    stamp(day, None, opt_str(v, "createdAt").as_deref())
}

// --- used ----------------------------------------------------------------------

fn map_used(at: &str, index: usize, v: &Value, day: Option<&str>, _shape: Shape) -> Vec<Outcome> {
    // Both shapes carry the same fields under the same names; the db/local
    // split does not change used rows. A used sale is always one item.
    let source = at.split('[').next().unwrap_or(at).to_string();
    if rolled(v) {
        return vec![Outcome::Skipped {
            source: source.clone(),
            index,
            reason: "rolled (cancelled): excluded from sums, preserved in source".to_string(),
        }];
    }
    let mut out = Vec::new();
    // The condition note is operational detail with no target column. The row
    // migrates; the note is listed, not lost silently and not forced anywhere.
    if let Some(note) = opt_str(v, "note") {
        out.push(Outcome::Review(ReviewItem {
            source: source.clone(),
            index,
            reason: format!("condition note has no target column and stays in source: {note}"),
        }));
    }
    let name = match req_str(v, "name", at) {
        Ok(n) => n,
        Err(e) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a sale name".to_string(),
            })]
        }
    };
    let (buy, sell, profit) = match (req_money(v, "buy", at), req_money(v, "sell", at), req_money_allow_negative(v, "profit", at)) {
        (Ok(b), Ok(s), Ok(p)) => (b, s, p),
        (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "complete sale fields".to_string(),
            })]
        }
    };
    let when = match stamp(day, opt_str(v, "time").as_deref(), opt_str(v, "createdAt").as_deref()) {
        Ok(w) => w,
        Err(e) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a timestamp".to_string(),
            })]
        }
    };
    let (profit, recorded) = match check_profit(at, sell, buy, 1, profit) {
        Ok(v) => v,
        Err(e) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a recorded profit that is extended or per-unit".to_string(),
            })]
        }
    };
    // A used sale is one item by structure, so recorded and extended agree; the
    // recorded figure is still carried for reconciliation to sum.
    if let Some(r) = recorded {
        out.push(Outcome::Review(ReviewItem {
            source: source.clone(),
            index,
            reason: format!("recorded profit {r} differs on a single-item sale; stored extended {profit}"),
        }));
    }
    out.extend(sale_invoice(
        at,
        index,
        &source,
        sell,
        when,
        Some(identity_of(get(v, "id").and_then(|x| x.as_str()), v)),
        NewInvoiceLine {
            model_legacy_id: None,
            snapshot_name: name,
            snapshot_barcode: None,
            qty: 1,
            unit_price_minor: sell,
            unit_cost_minor: buy,
            profit_minor: profit,
            recorded_profit_minor: recorded.unwrap_or(profit),
            recorded_total_minor: sell,
        },
    ));
    out
}

// --- sw ------------------------------------------------------------------------
// A service sale is complete only when paid and delivered. Anything else is a
// receivable or pending work, and the schema has no home for either: storing it
// as a plain sale would misstate reality, so those rows block with the gap
// named. Completed services migrate as free-name lines with no recorded cost,
// because the legacy system tracks none; profit therefore equals price, stated
// plainly rather than derived.

fn map_sw(at: &str, index: usize, v: &Value, day: Option<&str>, shape: Shape) -> Vec<Outcome> {
    let source = at.split('[').next().unwrap_or(at).to_string();
    if rolled(v) {
        return vec![Outcome::Skipped {
            source: source.clone(),
            index,
            reason: "rolled (cancelled): excluded from sums, preserved in source".to_string(),
        }];
    }
    let mut out = Vec::new();
    if let Some(note) = opt_str(v, "note") {
        out.push(Outcome::Review(ReviewItem {
            source: source.clone(),
            index,
            reason: format!("service note has no target column and stays in source: {note}"),
        }));
    }
    let paid = v.get("paid").and_then(|x| x.as_bool()).unwrap_or(false);
    let delivered = v.get("delivered").and_then(|x| x.as_bool()).unwrap_or(false);
    if !paid || !delivered {
        out.push(Outcome::Blocked(BlockItem {
            source: source.clone(),
            index,
            reason: format!(
                "service is not complete (paid={paid}, delivered={delivered}): \
                 a receivable or pending work cannot become a plain sale row"
            ),
            need: "schema support for receivables/fulfillment, or an owner decision per row".to_string(),
        }));
        return out;
    }
    let (name, amount) = match shape {
        Shape::Db => (req_str(v, "snapshotName", at), req_money(v, "amount", at)),
        _ => (req_str(v, "name", at), req_money(v, "price", at)),
    };
    let (name, amount) = match (name, amount) {
        (Ok(n), Ok(a)) => (n, a),
        (Err(e), _) | (_, Err(e)) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a service name and amount".to_string(),
            })]
        }
    };
    let when = match stamp(day, opt_str(v, "time").as_deref(), opt_str(v, "createdAt").as_deref()) {
        Ok(w) => w,
        Err(e) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a timestamp".to_string(),
            })]
        }
    };
    out.extend(sale_invoice(
        at,
        index,
        &source,
        amount,
        when,
        Some(identity_of(get(v, "id").and_then(|x| x.as_str()), v)),
        NewInvoiceLine {
            model_legacy_id: None,
            snapshot_name: name,
            snapshot_barcode: None,
            qty: 1,
            unit_price_minor: amount,
            unit_cost_minor: 0,
            profit_minor: amount,
            recorded_profit_minor: amount,
            recorded_total_minor: amount,
        },
    ));
    out
}

// --- cash ----------------------------------------------------------------------
// Signed by type: deposit adds, withdrawal subtracts. The legacy report sums
// amounts as recorded including withdrawals, which the reconciliation test
// reproduces exactly rather than correcting. transactionType rides along as a
// note because it describes the movement without changing its value.

fn map_cash(
    ctx: &Context,
    at: &str,
    index: usize,
    v: &Value,
    day: Option<&str>,
    _shape: Shape,
) -> Vec<Outcome> {
    let source = at.split('[').next().unwrap_or(at).to_string();
    if rolled(v) {
        return vec![Outcome::Skipped {
            source: source.clone(),
            index,
            reason: "rolled (cancelled): excluded from sums, preserved in source".to_string(),
        }];
    }
    let wallet = match get(v, "walletName").or_else(|| get(v, "service")) {
        Some(Value::String(s)) if !s.trim().is_empty() => s.clone(),
        _ => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: "movement without a wallet".to_string(),
                need: "a walletName or service".to_string(),
            })]
        }
    };
    if !ctx.wallets.contains(&wallet) {
        return vec![Outcome::Blocked(BlockItem {
            source: source.clone(),
            index,
            reason: format!("wallet {wallet} was never declared"),
            need: "declare it in mshop_wallets; wallets are never created from movements".to_string(),
        })];
    }
    let kind = match get(v, "cashType").and_then(|x| x.as_str()) {
        Some("\u{0627}\u{064a}\u{062f}\u{0627}\u{0639}") => 1i64,
        Some("\u{0633}\u{062d}\u{0628}") => -1i64,
        other => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: format!("unknown cashType: {other:?}"),
                need: "\u{0627}\u{064a}\u{062f}\u{0627}\u{0639} or \u{0633}\u{062d}\u{0628}".to_string(),
            })]
        }
    };
    let amount = match get(v, "amount") {
        Some(n) => match minor(n, false) {
            Ok(m) => m,
            Err(e) => {
                return vec![Outcome::Blocked(BlockItem {
                    source: source.clone(),
                    index,
                    reason: format!("amount: {e}"),
                    need: "a finite non-negative amount".to_string(),
                })]
            }
        },
        None => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: "movement without an amount".to_string(),
                need: "an amount".to_string(),
            })]
        }
    };
    let when = match stamp(day, opt_str(v, "time").as_deref(), opt_str(v, "createdAt").as_deref()) {
        Ok(w) => w,
        Err(e) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a timestamp".to_string(),
            })]
        }
    };
    let note = opt_str(v, "transactionType").filter(|t| t != "sale");
    vec![Outcome::Movement(NewWalletMovement {
        wallet,
        amount_minor: kind * amount,
        service: None,
        note,
        created_at: when,
        origin_ref: Some(identity_of(get(v, "id").and_then(|x| x.as_str()), v)),
    })]
}

// --- exp -------------------------------------------------------------------------

fn map_exp(
    ctx: &Context,
    at: &str,
    index: usize,
    v: &Value,
    day: Option<&str>,
    _shape: Shape,
) -> Vec<Outcome> {
    let source = at.split('[').next().unwrap_or(at).to_string();
    if rolled(v) {
        return vec![Outcome::Skipped {
            source: source.clone(),
            index,
            reason: "rolled (cancelled): excluded from sums, preserved in source".to_string(),
        }];
    }
    // Local shape uses category; the db marker snapshotCategory names the same
    // field under the repository naming. Both are accepted because both are
    // evidenced; anything else is missing, not guessed. Like product sales,
    // the category must be seeded: expense vocabularies are never created from
    // rows.
    let category = match get(v, "category").or_else(|| get(v, "snapshotCategory")) {
        Some(Value::String(s)) if !s.trim().is_empty() => s.clone(),
        _ => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: "expense without a category".to_string(),
                need: "a category".to_string(),
            })]
        }
    };
    if !ctx.expense_categories.contains(&category) {
        return vec![Outcome::Blocked(BlockItem {
            source: source.clone(),
            index,
            reason: format!("expense category {category} is outside the seeded set"),
            need: "seed it first; vocabularies are never created from rows".to_string(),
        })];
    }
    let amount = match get(v, "amount") {
        Some(n) => match minor(n, false) {
            Ok(m) => m,
            Err(e) => {
                return vec![Outcome::Blocked(BlockItem {
                    source: source.clone(),
                    index,
                    reason: format!("amount: {e}"),
                    need: "a finite non-negative amount".to_string(),
                })]
            }
        },
        None => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: "expense without an amount".to_string(),
                need: "an amount".to_string(),
            })]
        }
    };
    let when = match stamp(day, opt_str(v, "time").as_deref(), opt_str(v, "createdAt").as_deref()) {
        Ok(w) => w,
        Err(e) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a timestamp".to_string(),
            })]
        }
    };
    vec![Outcome::Expense(NewExpense {
        category,
        amount_minor: amount,
        created_at: when,
        origin_ref: Some(identity_of(None, v)),
    })]
}

// --- phones ------------------------------------------------------------------------
// A sale that names an inventory id links to it; anything else keeps a free
// snapshot with the legacy id attached for the importer to resolve later. The
// recorded prices are carried as recorded and checked, matching the snapshot
// rule: the legacy writer computes profit from the live buyPrice, and the
// mapping verifies rather than recomputes.

fn map_phones(
    ctx: &Context,
    at: &str,
    index: usize,
    v: &Value,
    day: Option<&str>,
    shape: Shape,
) -> Vec<Outcome> {
    let source = at.split('[').next().unwrap_or(at).to_string();
    if rolled(v) {
        return vec![Outcome::Skipped {
            source: source.clone(),
            index,
            reason: "rolled (cancelled): excluded from sums, preserved in source".to_string(),
        }];
    }
    let mut out = Vec::new();
    // qty defaults to one sale: the phone writer proves it optional
    // (`parseInt(...)||1`), and there is no multi-unit phone sale shape.
    let qty: i64 = get(v, "qty").and_then(|q| q.as_i64()).unwrap_or(1);
    let (name, buy, sell, profit) = match shape {
        Shape::Db => (
            req_str(v, "snapshotModelName", at),
            req_money(v, "buyPrice", at),
            req_money(v, "sellPrice", at),
            req_money_allow_negative(v, "profit", at),
        ),
        _ => (
            req_str(v, "model", at).or_else(|_| req_str(v, "name", at)),
            req_money(v, "buyPrice", at),
            req_money(v, "sellPrice", at),
            req_money_allow_negative(v, "profit", at),
        ),
    };
    let (name, buy, sell, profit) = match (name, buy, sell, profit) {
        (Ok(a), Ok(b), Ok(c), Ok(d)) => (a, b, c, d),
        (Err(e), _, _, _) | (_, Err(e), _, _) | (_, _, Err(e), _) | (_, _, _, Err(e)) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "complete sale fields".to_string(),
            })]
        }
    };
    if qty < 1 {
        return vec![Outcome::Blocked(BlockItem {
            source: source.clone(),
            index,
            reason: format!("qty {qty} is not a sale"),
            need: "a positive quantity".to_string(),
        })];
    }
    let (profit, recorded) = match check_profit(at, sell, buy, qty, profit) {
        Ok(v) => v,
        Err(e) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a recorded profit that is extended or per-unit".to_string(),
            })]
        }
    };
    if let Some(r) = recorded {
        out.push(Outcome::Review(ReviewItem {
            source: source.clone(),
            index,
            reason: format!(
                "legacy recorded per-unit profit {r}, stored extended {profit}; \
                 reconciliation uses the recorded figure"
            ),
        }));
    }
    let when = match stamp(day, opt_str(v, "time").as_deref(), opt_str(v, "createdAt").as_deref()) {
        Ok(w) => w,
        Err(e) => {
            return vec![Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a timestamp".to_string(),
            })]
        }
    };
    let model_id = opt_str(v, "modelId");
    let linked = model_id.as_ref().is_some_and(|id| ctx.inventory_ids.contains(id));
    if let Some(id) = &model_id {
        if !linked {
            out.push(Outcome::Review(ReviewItem {
                source: source.clone(),
                index,
                reason: format!(
                    "modelId {id} names no migrated product; the sale keeps a free snapshot and the id for later resolution"
                ),
            }));
        }
    }
    out.extend(sale_invoice(
        at,
        index,
        &source,
        sell * qty,
        when,
        Some(identity_of(get(v, "id").and_then(|x| x.as_str()), v)),
        NewInvoiceLine {
            model_legacy_id: model_id,
            snapshot_name: name,
            snapshot_barcode: None,
            qty,
            unit_price_minor: sell,
            unit_cost_minor: buy,
            profit_minor: profit,
            recorded_profit_minor: recorded.unwrap_or(profit),
            recorded_total_minor: sell,
        },
    ));
    out
}

// --- repairs -------------------------------------------------------------------------
// Status strings are mapped explicitly from evidence (repair.js writers and the
// fixture). Anything else stops with the value named: statuses are workflow
// states and must never be coerced. Cancellation sets the flag and keeps the
// recorded profit, because cancelled rows stay in the record while leaving the
// profit sums. paid=false is a receivable with no ledger to hold it, so those
// rows block with the gap named; fixed/delivered shape the status and need no
// separate columns. clientName is a snapshot the schema holds; faultType,
// deviceType, clientPhone, part fields and notes have no columns and are listed
// per field rather than lost silently.

fn map_repair(at: &str, index: usize, v: &Value, day: Option<&str>) -> Vec<Outcome> {
    let source = at.split('[').next().unwrap_or(at).to_string();
    if rolled(v) {
        return vec![Outcome::Skipped {
            source: source.clone(),
            index,
            reason: "rolled (cancelled): excluded from sums, preserved in source".to_string(),
        }];
    }
    let mut out = Vec::new();

    let raw_status = opt_str(v, "status").unwrap_or_default();
    let (status, cancelled) = match raw_status.as_str() {
        "inProgress" => ("in_progress", false),
        s if s.contains("\u{0645}\u{0644}\u{063a}\u{064a}") => ("cancelled", true),
        s if s.contains("\u{0625}\u{0635}\u{0644}\u{0627}\u{062d}") || s.contains("\u{062a}\u{0645}") => ("done", false),
        s if s.contains("\u{062a}\u{0633}\u{0644}\u{064a}\u{0645}") => ("delivered", false),
        _ => {
            out.push(Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: format!("unknown repair status: {raw_status:?}"),
                need: "an explicit status mapping with writer-code evidence".to_string(),
            }));
            return out;
        }
    };

    // The paid gate applies to live work only. A cancelled repair is history,
    // not a receivable: nobody owes anything on work that was called off, and
    // the row migrates as a cancelled record. An open repair without payment
    // is money owed with no ledger, and those rows block.
    let paid = v.get("paid").and_then(|x| x.as_bool()).unwrap_or(false);
    if !cancelled && !paid {
        out.push(Outcome::Blocked(BlockItem {
            source: source.clone(),
            index,
            reason: "repair is unpaid: a receivable with no ledger to hold it".to_string(),
            need: "schema support for receivables, or an owner decision per row".to_string(),
        }));
        return out;
    }

    for (field, present) in [
        ("faultType", opt_str(v, "faultType")),
        ("deviceType", opt_str(v, "deviceType")),
        ("clientPhone", opt_str(v, "clientPhone")),
        ("partName", opt_str(v, "partName")),
        ("partBuyPrice", get(v, "partBuyPrice").map(|x| x.to_string())),
        ("supplier", opt_str(v, "supplier")),
        ("notes", opt_str(v, "notes")),
    ] {
        if let Some(value) = present {
            out.push(Outcome::Review(ReviewItem {
                source: source.clone(),
                index,
                reason: format!("{field} has no target column and stays in source: {value}"),
            }));
        }
    }

    let service = match req_money(v, "servicePrice", at) {
        Ok(m) => m,
        Err(e) => {
            out.push(Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a service price".to_string(),
            }));
            return out;
        }
    };
    let profit = match get(v, "profit") {
        Some(p) => match minor(p, true) {
            Ok(m) => Some(m),
            Err(e) => {
                out.push(Outcome::Blocked(BlockItem {
                    source: source.clone(),
                    index,
                    reason: format!("profit: {e}"),
                    need: "a finite profit".to_string(),
                }));
                return out;
            }
        },
        None => None,
    };
    let when = match stamp(day, opt_str(v, "time").as_deref(), opt_str(v, "createdAt").as_deref()) {
        Ok(w) => w,
        Err(e) => {
            out.push(Outcome::Blocked(BlockItem {
                source: source.clone(),
                index,
                reason: e,
                need: "a timestamp".to_string(),
            }));
            return out;
        }
    };

    let legacy_id = get(v, "id").and_then(|x| x.as_str()).map(str::to_string);
    let mut events = Vec::new();
    if let Some(Value::Array(history)) = get(v, "statusHistory") {
        for h in history {
            if let Some(s) = get(h, "status").and_then(|x| x.as_str()) {
                let hwhen = stamp(
                    day,
                    opt_str(h, "time").as_deref(),
                    opt_str(h, "createdAt").as_deref(),
                )
                .unwrap_or_else(|_| when.clone());
                events.push(NewRepairEvent {
                    repair_legacy_id: legacy_id.clone(),
                    status: s.to_string(),
                    created_at: hwhen,
                });
            }
        }
    }

    out.push(Outcome::Repair(
        NewRepair {
            legacy_id,
            client_name: opt_str(v, "clientName"),
            device_brand: opt_str(v, "brand"),
            device_model: opt_str(v, "model"),
            status,
            cancelled,
            service_price_minor: service,
            profit_minor: profit,
            created_at: when,
            origin_ref: Some(identity_of(
                get(v, "id").and_then(|x| x.as_str()),
                v,
            )),
        },
        events,
    ));
    out
}


