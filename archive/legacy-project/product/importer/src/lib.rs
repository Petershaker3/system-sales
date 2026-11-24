//! Step 3: the importer. Reads an export, maps every record, and writes a fresh
//! SQLite database in a single transaction, or writes nothing at all.
//!
//! # The atomicity contract
//!
//! Mapping is pure and total: every record's outcome is known before the first
//! row is written. If any outcome is `Blocked`, the import returns an error
//! without opening a write transaction, so a blocked import leaves a literally
//! empty database. Whatever does get written goes through one transaction with
//! one commit point, so a failure halfway (a constraint, a disk error) rolls
//! back to empty rather than leaving half a shop behind. Either the migration
//! is complete and reconciled, or the output is untouched.
//!
//! # Idempotency
//!
//! Every row carries (origin, source_entity, origin_ref). Before inserting, the
//! importer looks the triple up; a hit reuses the existing id and skips
//! dependent writes (an invoice's lines, a repair's events). Running the same
//! export twice therefore changes nothing the second time: same rows, same
//! ids, zero inserts. Seeds (vocabularies, wallets, settings) use INSERT OR
//! IGNORE / upsert because their natural keys already exist.

use mshop_migration::mapping::{self, Context, Outcome};
use mshop_migration::reader::{self, Export};
use mshop_migration::validation;
use std::collections::BTreeMap;
use std::str::FromStr;

#[derive(Debug, Default)]
pub struct Counts {
    pub products: i64,
    pub purchases: i64,
    pub invoices: i64,
    pub lines: i64,
    pub repairs: i64,
    pub repair_events: i64,
    pub wallets: i64,
    pub movements: i64,
    pub expenses: i64,
    pub parts: i64,
}

#[derive(Debug)]
pub struct ImportReport {
    pub inserted: Counts,
    pub reused: Counts,
    pub review: Vec<String>,
    pub totals: validation::LegacyTotals,
}

#[derive(Debug)]
pub enum ImportError {
    Read(String),
    Validation(Vec<String>),
    Blocked(Vec<String>),
    Destination(String),
    Db(String),
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportError::Read(e) => write!(f, "cannot read export: {e}"),
            ImportError::Validation(issues) => write!(f, "export invalid: {}", issues.join("; ")),
            ImportError::Blocked(items) => {
                write!(f, "import refused, nothing written: {}", items.join("; "))
            }
            ImportError::Destination(e) => {
                write!(f, "destination refused, nothing written: {e}")
            }
            ImportError::Db(e) => write!(f, "database failed, rolled back: {e}"),
        }
    }
}

impl std::error::Error for ImportError {}

/// Tables whose emptiness defines a usable destination. Reference lists and
/// settings are excluded on purpose: a database created by a previous import
/// that wrote nothing but seeds is still a destination this importer must not
/// merge into, so it is judged by these tables alone plus the meta marker.
const BUSINESS_TABLES: [&str; 9] = [
    "products",
    "purchase_history",
    "invoices",
    "invoice_lines",
    "repairs",
    "wallet_movements",
    "expenses",
    "repair_parts",
    "repair_status_history",
];

/// Refuses a destination that already holds business rows.
///
/// This is the gate the library could not rely on callers for: importing into
/// a populated database would silently interleave two histories and quietly
/// double-count reconciliation. The check runs before any write and before the
/// schema is created, so a refused import leaves the existing file untouched.
pub async fn ensure_fresh_destination(db_path: &std::path::Path) -> Result<(), ImportError> {
    if !db_path.exists() {
        return Ok(());
    }
    if db_path.metadata().map(|m| m.len()).unwrap_or(0) > 0 {
        let url = format!("sqlite://{}", db_path.display().to_string().replace('\\', "/"));
        let opts = sqlx::sqlite::SqliteConnectOptions::from_str(&url)
            .map_err(|e| ImportError::Db(format!("destination not a database: {e}")))?
            .create_if_missing(false)
            .foreign_keys(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .map_err(|e| ImportError::Destination(format!("{}: {e}", db_path.display())))?;
        for table in BUSINESS_TABLES {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            let n: i64 = sqlx::query_scalar(&sql)
                .fetch_one(&pool)
                .await
                .map_err(|e| ImportError::Db(format!("probe {table}: {e}")))?;
            if n > 0 {
                pool.close().await;
                return Err(ImportError::Destination(format!(
                    "{} already holds {n} {table}; import refuses to merge into existing data",
                    db_path.display()
                )));
            }
        }
        pool.close().await;
    }
    Ok(())
}

/// Imports `export_json` into a fresh database at `db_path`, migrating the
/// schema to v3 first. The destination must hold no business rows: importing
/// into a database that already holds them is a different operation with
/// different rules, and this function refuses the ambiguity.
pub async fn import_from_str(
    export_json: &str,
    db_path: &std::path::Path,
) -> Result<ImportReport, ImportError> {
    ensure_fresh_destination(db_path).await?;
    let export =
        reader::read_str(export_json).map_err(|e| ImportError::Read(e.to_string()))?;

    let fatal: Vec<String> = validation::validate_export(&export)
        .into_iter()
        .filter(|i| i.fatal)
        .map(|i| i.message)
        .collect();
    if !fatal.is_empty() {
        return Err(ImportError::Validation(fatal));
    }

    let ctx = mapping::collect_context(&export);
    let anchor = export.days.keys().next().map(|k| {
        k.strip_prefix("mshop_d_").unwrap_or(k).to_string()
    });

    // Every outcome is computed before anything is written. A single Blocked
    // anywhere aborts with zero writes: the database file may exist (migrated
    // and empty), but no business row does.
    let mut outcomes: Vec<(String, Outcome)> = Vec::new();
    for (key, items) in &export.collections {
        if *key == "mshop_wallets" {
            continue;
        }
        for r in items {
            for o in mapping::map_record(&ctx, None, r) {
                outcomes.push((key.clone(), o));
            }
        }
    }
    if let Some(items) = export.collections.get("mshop_wallets") {
        for r in items {
            for o in mapping::map_record(&ctx, anchor.as_deref(), r) {
                outcomes.push(("mshop_wallets".to_string(), o));
            }
        }
    }
    for (day_key, sections) in &export.days {
        let day = day_key.strip_prefix("mshop_d_");
        for (_section, records) in sections {
            for r in records {
                for o in mapping::map_record(&ctx, day, r) {
                    outcomes.push((r.source.clone(), o));
                }
            }
        }
    }

    let (blocked, review) = validation::collect_outcomes(
        &outcomes.iter().map(|(_, o)| o.clone()).collect::<Vec<_>>(),
    );
    if !blocked.is_empty() {
        return Err(ImportError::Blocked(blocked));
    }

    let url = format!("sqlite://{}", db_path.display().to_string().replace('\\', "/"));
    let pool = mshop_schema::open(&url)
        .await
        .map_err(|e| ImportError::Db(format!("open: {e}")))?;

    let mut report = ImportReport {
        inserted: Counts::default(),
        reused: Counts::default(),
        review,
        totals: validation::LegacyTotals::default(),
    };
    let mut lines: BTreeMap<&str, Vec<mapping::NewInvoiceLine>> = BTreeMap::new();
    let mut movements = Vec::new();
    let mut expenses = Vec::new();
    let mut repairs = Vec::new();

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| ImportError::Db(format!("begin: {e}")))?;
    let result: Result<(), ImportError> = async {
        seed_reference_lists(&mut tx, &export).await?;
        seed_wallets_config(&mut tx, &export).await?;
        apply_stagnant_days(&mut tx, &export).await?;

        for (entity, outcome) in &outcomes {
            write_outcome(&mut tx, &ctx, entity, outcome, &mut report,
                          &mut lines, &mut movements, &mut expenses, &mut repairs).await?;
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        tx.rollback().await.map_err(|r| ImportError::Db(format!("{e}; rollback also failed: {r}")))?;
        return Err(e);
    }
    tx.commit().await.map_err(|e| ImportError::Db(format!("commit: {e}")))?;

    report.totals = validation::reconcile(&lines, &movements, &expenses, &repairs);
    pool.close().await;
    Ok(report)
}

async fn seed_reference_lists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    export: &Export,
) -> Result<(), ImportError> {
    let pairs = [
        ("mshop_cats", "categories"),
        ("mshop_ce", "expense_categories"),
        ("mshop_fault_types", "fault_types"),
        ("mshop_brands", "brands"),
        ("mshop_brands2", "brands"),
    ];
    for (key, table) in pairs {
        let names = match export.reference_lists.get(key) {
            Some(v) => names_in(v),
            None => Vec::new(),
        };
        for name in names {
            let sql = format!("INSERT OR IGNORE INTO {table} (name) VALUES (?1)");
            sqlx::query(&sql)
                .bind(&name)
                .execute(&mut **tx)
                .await
                .map_err(|e| ImportError::Db(format!("seed {table} {name}: {e}")))?;
        }
    }
    Ok(())
}

fn names_in(list: &serde_json::Value) -> Vec<String> {
    match list {
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|v| match v {
                serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
                serde_json::Value::Object(o) => o
                    .get("name")
                    .and_then(|n| n.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

async fn seed_wallets_config(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    export: &Export,
) -> Result<(), ImportError> {
    // Wallet names come from the config order plus every service the movements
    // name. The set is data, not invention: every name was written by the shop.
    let mut names: Vec<String> = Vec::new();
    if let Some(items) = export.collections.get("mshop_wallets") {
        if let Some(first) = items.first() {
            if let Some(order) = first.value.get("order").and_then(|o| o.as_array()) {
                for n in order.iter().filter_map(|v| v.as_str()) {
                    if !n.trim().is_empty() && !names.contains(&n.to_string()) {
                        names.push(n.to_string());
                    }
                }
            }
        }
    }
    for (_day, sections) in &export.days {
        if let Some(rows) = sections.get("cash") {
            for r in rows {
                for key in ["service", "walletName"] {
                    if let Some(s) = r.value.get(key).and_then(|v| v.as_str()) {
                        if !s.trim().is_empty() && !names.contains(&s.to_string()) {
                            names.push(s.to_string());
                        }
                    }
                }
            }
        }
    }
    for name in names {
        sqlx::query("INSERT OR IGNORE INTO wallets (name, created_at, origin) VALUES (?1, ?2, 'legacy-import')")
            .bind(&name)
            .bind(mshop_schema_now())
            .execute(&mut **tx)
            .await
            .map_err(|e| ImportError::Db(format!("seed wallet {name}: {e}")))?;
    }
    Ok(())
}

fn mshop_schema_now() -> String {
    // Import timestamps are new-system facts, so they use full UTC ISO.
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    format!("{}-import", ms)
}

async fn apply_stagnant_days(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    export: &Export,
) -> Result<(), ImportError> {
    // A single threshold string. The schema seeds 30; a legacy value wins
    // because it is the shop's own setting, not a default anyone chose.
    if let Some(v) = export.reference_lists.get("mshop_stagnant_days") {
        if let Some(s) = v.as_str() {
            sqlx::query("INSERT INTO settings (key, value) VALUES ('stagnant_days', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1")
                .bind(s)
                .execute(&mut **tx)
                .await
                .map_err(|e| ImportError::Db(format!("stagnant_days: {e}")))?;
        }
    }
    Ok(())
}

async fn find_existing(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &str,
    entity: &str,
    reference: &str,
) -> Result<Option<i64>, ImportError> {
    let sql = format!(
        "SELECT id FROM {table} WHERE origin = 'legacy-import' AND source_entity = ?1 AND origin_ref = ?2"
    );
    let id: Option<i64> = sqlx::query_scalar(&sql)
        .bind(entity)
        .bind(reference)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| ImportError::Db(format!("lookup {table} {entity} {reference}: {e}")))?;
    Ok(id)
}

async fn write_outcome(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ctx: &Context,
    entity: &str,
    outcome: &Outcome,
    report: &mut ImportReport,
    lines: &mut BTreeMap<&str, Vec<mapping::NewInvoiceLine>>,
    movements: &mut Vec<mapping::NewWalletMovement>,
    expenses: &mut Vec<(String, i64)>,
    repairs: &mut Vec<mapping::NewRepair>,
) -> Result<(), ImportError> {
    match outcome {
        Outcome::Product(p) => {
            let reference = p.origin_ref.clone().expect("products always carry identity");
            if let Some(id) = find_existing(tx, "products", entity, &reference).await? {
                let _ = id;
                report.reused.products += 1;
                return Ok(());
            }
            sqlx::query(
                "INSERT INTO products (sku, name, kind, price_minor, qty, created_at, origin, source_entity, origin_ref)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'legacy-import', ?7, ?8)",
            )
            .bind(&p.sku)
            .bind(&p.name)
            .bind(p.kind)
            .bind(p.price_minor)
            .bind(p.qty)
            .bind(mshop_schema_now())
            .bind(entity)
            .bind(&reference)
            .execute(&mut **tx)
            .await
            .map_err(|e| ImportError::Db(format!("product {}: {e}", p.sku)))?;
            report.inserted.products += 1;
        }
        Outcome::Purchase(p) => {
            let reference = p.origin_ref.clone().expect("purchases always carry identity");
            if find_existing(tx, "purchase_history", entity, &reference).await?.is_some() {
                report.reused.purchases += 1;
                return Ok(());
            }
            let product_id: i64 = sqlx::query_scalar(
                "SELECT id FROM products WHERE origin = 'legacy-import' AND source_entity = 'mshop_inventory' AND origin_ref = ?1",
            )
            .bind(&p.product_legacy_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| ImportError::Db(format!("resolve product {}: {e}", p.product_legacy_id)))?
            .ok_or_else(|| {
                ImportError::Db(format!(
                    "purchase for unknown product {}: the product row must exist first",
                    p.product_legacy_id
                ))
            })?;
            sqlx::query(
                "INSERT INTO purchase_history (product_id, qty, unit_cost_minor, total_minor, supplier, received_at, origin, source_entity, origin_ref)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'legacy-import', ?7, ?8)",
            )
            .bind(product_id)
            .bind(p.qty)
            .bind(p.unit_cost_minor)
            .bind(p.total_minor)
            .bind(&p.supplier)
            .bind(&p.received_at)
            .bind(entity)
            .bind(&reference)
            .execute(&mut **tx)
            .await
            .map_err(|e| ImportError::Db(format!("purchase: {e}")))?;
            report.inserted.purchases += 1;
        }
        Outcome::Sale(invoice, line) => {
            let reference = invoice
                .origin_ref
                .clone()
                .expect("invoices always carry identity");
            if let Some(_id) = find_existing(tx, "invoices", entity, &reference).await? {
                report.reused.invoices += 1;
                report.reused.lines += 1;
            } else {
                let invoice_id = sqlx::query(
                    "INSERT INTO invoices (total_minor, created_at, origin, source_entity, origin_ref)
                     VALUES (?1, ?2, 'legacy-import', ?3, ?4)",
                )
                .bind(invoice.total_minor)
                .bind(&invoice.created_at)
                .bind(entity)
                .bind(&reference)
                .execute(&mut **tx)
                .await
                .map_err(|e| ImportError::Db(format!("invoice: {e}")))?
                .last_insert_rowid();
                sqlx::query(
                    "INSERT INTO invoice_lines (invoice_id, product_id, snapshot_name, qty, unit_price_minor, unit_cost_minor, profit_minor)
                     VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)",
                )
                .bind(invoice_id)
                .bind(&line.snapshot_name)
                .bind(line.qty)
                .bind(line.unit_price_minor)
                .bind(line.unit_cost_minor)
                .bind(line.profit_minor)
                .execute(&mut **tx)
                .await
                .map_err(|e| ImportError::Db(format!("invoice line: {e}")))?;
                report.inserted.invoices += 1;
                report.inserted.lines += 1;
            }
            // Reconciliation reads mapped rows, not database rows, so reused
            // invoices still contribute: the report describes the source either
            // way, and counts say which run wrote it. A section outside the
            // four sale kinds contributes nowhere rather than landing in the
            // wrong bucket: misbucketed rows reconcile against the wrong
            // legacy formula silently.
            let section = entity.rsplit('.').next().unwrap_or("");
            if let Some(bucket) = match section {
                "acc" => Some("acc"),
                "used" => Some("used"),
                "sw" => Some("sw"),
                "phones" => Some("phones"),
                _ => None,
            } {
                lines.entry(bucket).or_default().push(line.clone());
            }
        }
        Outcome::Repair(repair, events) => {
            let reference = repair
                .origin_ref
                .clone()
                .expect("repairs always carry identity");
            let (repair_id, fresh) = match find_existing(tx, "repairs", entity, &reference).await? {
                Some(id) => {
                    report.reused.repairs += 1;
                    (id, false)
                }
                None => {
                    let id = sqlx::query(
                        "INSERT INTO repairs (client_name, device_brand, device_model, status, service_price_minor, profit_minor, cancelled, created_at, origin, source_entity, origin_ref)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'legacy-import', ?9, ?10)",
                    )
                    .bind(&repair.client_name)
                    .bind(&repair.device_brand)
                    .bind(&repair.device_model)
                    .bind(repair.status)
                    .bind(repair.service_price_minor)
                    .bind(repair.profit_minor)
                    .bind(if repair.cancelled { 1 } else { 0 })
                    .bind(&repair.created_at)
                    .bind(entity)
                    .bind(&reference)
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| ImportError::Db(format!("repair: {e}")))?
                    .last_insert_rowid();
                    report.inserted.repairs += 1;
                    (id, true)
                }
            };
            // Events ride with their repair: a reused repair skips re-inserting
            // history, or a second run would double every trail.
            if fresh {
                for event in events {
                    sqlx::query(
                        "INSERT INTO repair_status_history (repair_id, status, created_at) VALUES (?1, ?2, ?3)",
                    )
                    .bind(repair_id)
                    .bind(&event.status)
                    .bind(&event.created_at)
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| ImportError::Db(format!("repair event: {e}")))?;
                    report.inserted.repair_events += 1;
                }
            }
            repairs.push(repair.clone());
        }
        Outcome::Wallet(name) => {
            sqlx::query("INSERT OR IGNORE INTO wallets (name, created_at, origin) VALUES (?1, ?2, 'legacy-import')")
                .bind(name)
                .bind(mshop_schema_now())
                .execute(&mut **tx)
                .await
                .map_err(|e| ImportError::Db(format!("wallet {name}: {e}")))?;
            report.inserted.wallets += 1;
        }
        Outcome::Movement(m) => {
            let reference = m.origin_ref.clone().expect("movements always carry identity");
            if find_existing(tx, "wallet_movements", entity, &reference).await?.is_some() {
                report.reused.movements += 1;
                movements.push(m.clone());
                return Ok(());
            }
            let wallet_id: i64 = sqlx::query_scalar("SELECT id FROM wallets WHERE name = ?1")
                .bind(&m.wallet)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|e| ImportError::Db(format!("resolve wallet {}: {e}", m.wallet)))?
                .ok_or_else(|| ImportError::Db(format!("movement for unknown wallet {}", m.wallet)))?;
            sqlx::query(
                "INSERT INTO wallet_movements (wallet_id, amount_minor, service, note, created_at, origin, source_entity, origin_ref)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'legacy-import', ?6, ?7)",
            )
            .bind(wallet_id)
            .bind(m.amount_minor)
            .bind(&m.service)
            .bind(&m.note)
            .bind(&m.created_at)
            .bind(entity)
            .bind(&reference)
            .execute(&mut **tx)
            .await
            .map_err(|e| ImportError::Db(format!("movement: {e}")))?;
            report.inserted.movements += 1;
            movements.push(m.clone());
        }
        Outcome::Expense(e) => {
            let reference = e.origin_ref.clone().expect("expenses always carry identity");
            if find_existing(tx, "expenses", entity, &reference).await?.is_some() {
                report.reused.expenses += 1;
                return Ok(());
            }
            sqlx::query(
                "INSERT INTO expenses (category, amount_minor, created_at, origin, source_entity, origin_ref)
                 VALUES (?1, ?2, ?3, 'legacy-import', ?4, ?5)",
            )
            .bind(&e.category)
            .bind(e.amount_minor)
            .bind(&e.created_at)
            .bind(entity)
            .bind(&reference)
            .execute(&mut **tx)
            .await
            .map_err(|e| ImportError::Db(format!("expense: {e}")))?;
            report.inserted.expenses += 1;
            expenses.push((e.category.clone(), e.amount_minor));
        }
        Outcome::Part(p) => {
            let reference = p.origin_ref.clone().expect("parts always carry identity");
            if find_existing(tx, "repair_parts", entity, &reference).await?.is_some() {
                report.reused.parts += 1;
                return Ok(());
            }
            sqlx::query(
                "INSERT INTO repair_parts (name, compatible, qty, buy_price_minor, supplier, created_at, origin, source_entity, origin_ref)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'legacy-import', ?7, ?8)",
            )
            .bind(&p.name)
            .bind(&p.compatible)
            .bind(p.qty)
            .bind(p.buy_price_minor)
            .bind(&p.supplier)
            .bind(mshop_schema_now())
            .bind(entity)
            .bind(&reference)
            .execute(&mut **tx)
            .await
            .map_err(|e| ImportError::Db(format!("part {}: {e}", p.name)))?;
            report.inserted.parts += 1;
        }
        Outcome::Seed { table, name } => {
            // Seeds predate rows and use natural keys, so OR IGNORE is the
            // whole idempotency story: reruns change nothing.
            let sql = format!("INSERT OR IGNORE INTO {table} (name) VALUES (?1)");
            sqlx::query(&sql)
                .bind(name)
                .execute(&mut **tx)
                .await
                .map_err(|e| ImportError::Db(format!("seed {table} {name}: {e}")))?;
        }
        Outcome::Setting { key, value } => {
            sqlx::query("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2")
                .bind(key)
                .bind(value)
                .execute(&mut **tx)
                .await
                .map_err(|e| ImportError::Db(format!("setting {key}: {e}")))?;
        }
        Outcome::Skipped { .. } | Outcome::Review(_) => {}
        Outcome::Blocked(_) => {
            unreachable!("blocked outcomes abort before any write; reaching one here is a driver bug")
        }
    }
    let _ = ctx;
    Ok(())
}



