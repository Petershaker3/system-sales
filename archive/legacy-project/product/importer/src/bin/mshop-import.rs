//! mshop-import: the real migration entry point.
//!
//! The contract is `mshop-import <source> <out.db>` and deliberately says
//! "source", not "export.json". The format of the source is decided by the
//! reader, not by the caller: a `.mshop` file or anything unrecognised is
//! reported as unsupported rather than guessed at, so that learning the real
//! `.mshop` format later means adding a reader, not changing this command's
//! spelling.
//!
//! Exit codes are the machine-readable contract:
//!   0  imported and reconciled
//!   1  refused: blocked rows, invalid export, or a destination in use
//!   2  usage error
//!   3  unsupported source format (including every .mshop file, for now)
//!   4  I/O failure reading the source
//!
//! The source is opened read-only and never written, moved, or deleted. The
//! destination is only created here, and only after every row has been mapped.

use mshop_importer::{import_from_str, ImportError};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::str::FromStr;

const EXIT_OK: u8 = 0;
const EXIT_REFUSED: u8 = 1;
const EXIT_USAGE: u8 = 2;
const EXIT_UNSUPPORTED: u8 = 3;
const EXIT_IO: u8 = 4;

const USAGE: &str = "\
usage: mshop-import <source> <out.db>

Imports a legacy shop export into a new SQLite database. The destination must
not already contain shop rows; this command never merges into existing data.

supported source: JSON export
unsupported (refused, not guessed): .mshop and any other format";

/// What the reader made of the source. Resolution lives here so the CLI contract
/// stays `source`, not `export.json`: adding a `.mshop` reader later means
/// adding an arm to `resolve_source` and nothing else.
enum Source {
    Json(String),
}

/// Why a source could not be read. The distinction is the whole point of the
/// `source` contract: `Unsupported` means "this format is not implemented yet"
/// (a real `.mshop` will be readable once its format is known), while
/// `Unreadable` means the bytes could not be fetched at all.
enum SourceError {
    Unsupported(String),
    Unreadable(String),
}

impl SourceError {
    fn exit_code(&self) -> u8 {
        match self {
            SourceError::Unsupported(_) => EXIT_UNSUPPORTED,
            SourceError::Unreadable(_) => EXIT_IO,
        }
    }
}

impl std::fmt::Display for SourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SourceError::Unsupported(m) | SourceError::Unreadable(m) => write!(f, "{m}"),
        }
    }
}

fn resolve_source(path: &Path) -> Result<Source, SourceError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        "mshop" => Err(SourceError::Unsupported(format!(
            "{}: the .mshop format is not understood yet, so it is refused rather than guessed. \
export as JSON, or bring a real sample for the format to be determined first.",
            path.display()
        ))),
        "json" => std::fs::read_to_string(path)
            .map(Source::Json)
            .map_err(|e| SourceError::Unreadable(format!("{}: {e}", path.display()))),
        other => Err(SourceError::Unsupported(format!(
            "{}: unrecognised source format '{other}'; only a JSON export is supported",
            path.display()
        ))),
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 || args[0] == "-h" || args[0] == "--help" {
        eprintln!("{USAGE}");
        return ExitCode::from(if args.len() == 2 { EXIT_OK } else { EXIT_USAGE });
    }

    let source = PathBuf::from(&args[0]);
    let dest = PathBuf::from(&args[1]);

    if !source.exists() {
        eprintln!("source not found: {}", source.display());
        return ExitCode::from(EXIT_IO);
    }

let text = match resolve_source(&source) {
        Ok(Source::Json(t)) => t,
        Err(err) => {
            // A refused format is not a crash and not a usage problem: the
            // command was understood, the file simply is not readable yet.
            // The typed distinction lets a script know whether a real `.mshop`
            // will ever be importable without parsing the message text.
            let code = err.exit_code();
            eprintln!("{err}");
            return ExitCode::from(code);
        }
    };

    let report = match import_from_str(&text, &dest).await {
        Ok(r) => r,
        Err(ImportError::Blocked(items)) => {
            remove_empty_output(&dest).await;
            eprintln!("refused, nothing written. blocked rows:");
            for item in &items {
                eprintln!("  - {item}");
            }
            return ExitCode::from(EXIT_REFUSED);
        }
        Err(ImportError::Validation(issues)) => {
            remove_empty_output(&dest).await;
            eprintln!("refused, nothing written. invalid export:");
            for issue in &issues {
                eprintln!("  - {issue}");
            }
            return ExitCode::from(EXIT_REFUSED);
        }
        Err(ImportError::Destination(msg)) => {
            eprintln!("refused: {msg}");
            return ExitCode::from(EXIT_REFUSED);
        }
        Err(ImportError::Db(msg)) => {
            remove_empty_output(&dest).await;
            eprintln!("failed, rolled back: {msg}");
            return ExitCode::from(EXIT_REFUSED);
        }
        Err(ImportError::Read(msg)) => {
            eprintln!("refused: {msg}");
            return ExitCode::from(EXIT_REFUSED);
        }
    };

    let schema_version = mshop_schema::VERSION;
    let c = &report.inserted;
    let t = &report.totals;

    println!("source            {}", source.display());
    println!("destination       {}", dest.display());
    println!("schema version    {schema_version}");
    println!("records imported  products {} | invoices {} | invoice_lines {} | purchases {} | repairs {} | movements {} | expenses {} | repair_parts {}",
        c.products, c.invoices, c.lines, c.purchases, c.repairs, c.movements, c.expenses, c.parts);
    println!("records reused    products {} | invoices {} | invoice_lines {} | purchases {} | repairs {} | movements {} | expenses {} | repair_parts {}",
        report.reused.products, report.reused.invoices, report.reused.lines,
        report.reused.purchases, report.reused.repairs, report.reused.movements,
        report.reused.expenses, report.reused.parts);
    println!(
        "totals (minor)    total {} | profit {} | accessories {} | used {} | cash {} | services {} | phones {} | repairs {} | expenses {}",
        t.sales_total, t.profit_total, t.accessory_sell, t.used_sell, t.cash_total,
        t.service_total, t.phone_sell, t.repair_sell, t.expense_total
    );

    if report.review.is_empty() {
        println!("review            none");
    } else {
        println!("review            {} row(s) need a human decision:", report.review.len());
        for r in &report.review {
            println!("  - {r}");
        }
    }

    ExitCode::from(EXIT_OK)
}

/// After a refusal, an output file must not be left behind. Only a file that
/// holds no business rows is removed: a pre-existing destination is never
/// deleted, even by accident.
async fn remove_empty_output(dest: &Path) {
    const BUSINESS: [&str; 9] = [
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
    if !dest.exists() {
        return;
    }
    let url = format!("sqlite://{}", dest.display().to_string().replace('\\', "/"));
    let opts = sqlx::sqlite::SqliteConnectOptions::from_str(&url)
        .expect("dest url")
        .create_if_missing(false)
        .read_only(true);
    let Ok(pool) = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
    else {
        return;
    };
    let mut empty = true;
    for table in BUSINESS {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        match sqlx::query_scalar::<_, i64>(&sql).fetch_one(&pool).await {
            Ok(0) => {}
            _ => {
                empty = false;
                break;
            }
        }
    }
    pool.close().await;
    if empty {
        let _ = std::fs::remove_file(dest);
        eprintln!("removed empty output {}", dest.display());
    }
}
