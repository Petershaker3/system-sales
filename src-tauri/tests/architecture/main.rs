//! Architecture tests.
//!
//! Some guarantees here are not runtime behaviour, so they are asserted against
//! the source at compile time with `include_str!`. Deleting a referenced file
//! fails the build, which is deliberate: a guarantee cannot be quietly dropped.
//!
//! # Why these strip comments first
//!
//! A naive substring check is worse than no check. The first version of this file
//! failed five tests because it matched the words `localStorage`, `execute_sql`
//! and `sync_outbox` inside the very comments that *forbid* them, and matched
//! `SessionToken::new` when it meant `Session::new`. A test that cries wolf gets
//! deleted, so every assertion below runs against comment-stripped source and,
//! where a bare substring is too coarse, parses the construct it actually means.

/// Remove comments, so documentation prose cannot satisfy or break an assertion.
///
/// Both `//` line comments and `/* */` blocks are stripped, and the strip is
/// depth-aware so that a `//` appearing inside a string or inside a block
/// comment does not truncate the rest of the file. The guards below read source
/// text, which means a guard that a comment can defeat is not a guard — and a
/// guard that a comment can accidentally fail is worse than no guard at all,
/// because it teaches people to write vaguer comments.
fn code_only(source: &str) -> String {
    let bytes: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut i = 0usize;
    let mut block_depth = 0usize;

    while i < bytes.len() {
        let rest: String = bytes[i..(i + 2).min(bytes.len())].iter().collect();

        if block_depth > 0 {
            if rest == "*/" {
                block_depth -= 1;
                i += 2;
            } else if rest == "/*" {
                block_depth += 1;
                i += 2;
            } else {
                if bytes[i] == '\n' {
                    out.push('\n');
                }
                i += 1;
            }
            continue;
        }

        if rest == "/*" {
            block_depth = 1;
            i += 2;
            continue;
        }
        if rest == "//" {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if rest == "\"" || rest == "'" || rest == "`" {
            let quote = bytes[i];
            out.push(quote);
            i += 1;
            while i < bytes.len() {
                if bytes[i] == '\\' && i + 1 < bytes.len() {
                    out.push(bytes[i]);
                    out.push(bytes[i + 1]);
                    i += 2;
                    continue;
                }
                out.push(bytes[i]);
                if bytes[i] == quote {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }

        out.push(bytes[i]);
        i += 1;
    }

    out
}

/// Remove SQL `--` line comments, for the same reason applied to migrations.
fn sql_only(source: &str) -> String {
    strip_from(source, "--").to_ascii_lowercase()
}

fn strip_from(source: &str, marker: &str) -> String {
    source
        .lines()
        .map(|line| match line.find(marker) {
            Some(at) => &line[..at],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parameter names of every `pub async fn` in a command module.
///
/// Multi-line signatures are joined first so a parameter list is not truncated.
fn command_parameters(source: &str) -> Vec<String> {
    let flat: String = source.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut names = Vec::new();
    let mut cursor = 0usize;

    while let Some(at) = flat[cursor..].find("pub async fn") {
        let start = cursor + at + "pub async fn".len();
        let Some(open) = flat[start..].find('(') else { break };
        let args_at = start + open + 1;
        let mut depth = 1usize;
        let mut end = args_at;
        for (offset, ch) in flat[args_at..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = args_at + offset;
                        break;
                    }
                }
                _ => {}
            }
        }
        for argument in flat[args_at..end].split(',') {
            if let Some((name, _)) = argument.split_once(':') {
                let name = name.trim().rsplit(' ').next().unwrap_or("").trim();
                if !name.is_empty() {
                    names.push(name.to_string());
                }
            }
        }
        cursor = end;
    }
    names
}

/// Body of `impl <Type> { ... }`, so an assertion about `Session` cannot be
/// satisfied by a same-named method on a different type in the same file.
fn impl_body<'a>(source: &'a str, ty: &str) -> &'a str {
    let marker = format!("impl {ty} {{");
    let Some(start) = source.find(&marker) else { return "" };
    let rest = &source[start + marker.len()..];
    let mut depth = 1usize;
    for (offset, ch) in rest.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &rest[..offset];
                }
            }
            _ => {}
        }
    }
    rest
}

const COMMANDS: &str = include_str!("../../src/commands/identity.rs");
const COMMANDS_MOD: &str = include_str!("../../src/commands/mod.rs");
const LIB: &str = include_str!("../../src/lib.rs");
const DOMAIN_SESSION: &str = include_str!("../../src/domain/identity/session.rs");
const DOMAIN_MOD: &str = include_str!("../../src/domain/identity/mod.rs");
const SERVICES_SESSION: &str = include_str!("../../src/services/identity/session.rs");
const SECURE_STORE: &str = include_str!("../../src/services/identity/secure_store.rs");
const MIGRATION: &str = include_str!("../../src/data/migrations/0001_identity.sql");
const CATALOG_MIGRATION: &str = include_str!("../../src/data/migrations/0002_catalog.sql");
const CATALOG_COMMANDS: &str = include_str!("../../src/commands/catalog.rs");
const CATALOG_SERVICES: &str = include_str!("../../src/services/catalog/product.rs");
const CATALOG_DOMAIN: &str = include_str!("../../src/domain/catalog/catalog.rs");
// Identity lifecycle sources. `DOMAIN_SESSION` already includes the same file, so
// the new constants here carry distinct names rather than shadowing it.
const LIFECYCLE_COMMANDS: &str =
    include_str!("../../src/commands/identity_lifecycle.rs");
const LIFECYCLE_PASSWORD_SERVICE: &str =
    include_str!("../../src/services/identity/password.rs");
const LIFECYCLE_USERS_SERVICE: &str = include_str!("../../src/services/identity/users.rs");
const LIFECYCLE_REPO: &str = include_str!("../../src/data/repositories/identity/user.rs");
const CREDENTIALS_REPO: &str =
    include_str!("../../src/data/repositories/identity/credentials.rs");
const AUTH_SERVICE: &str = include_str!("../../src/services/identity/auth.rs");
const USER_DOMAIN_SOURCE: &str = include_str!("../../src/domain/identity/user.rs");
const ERROR_DOMAIN: &str = include_str!("../../src/domain/identity/error.rs");
const IDENTITY_COMMANDS: &str = include_str!("../../src/commands/identity.rs");
const SESSION_REPO: &str = include_str!("../../src/data/repositories/identity/session.rs");
const LIFECYCLE_MIGRATION: &str =
    include_str!("../../src/data/migrations/0003_identity_lifecycle.sql");
const DEPARTMENTS_MIGRATION: &str =
    include_str!("../../src/data/migrations/0004_departments.sql");
const PRODUCTS_PROFILE_MIGRATION: &str =
    include_str!("../../src/data/migrations/0005_products_inventory_profile.sql");
const ROLE_SOURCE: &str = include_str!("../../src/domain/identity/role.rs");
const USER_SOURCE: &str = include_str!("../../src/domain/identity/user.rs");
const FRONTEND_CATALOG_API: &str = include_str!("../../../src/api/catalog.ts");

const FRONTEND_MAIN: &str = include_str!("../../../src/main.ts");
const FRONTEND_APP: &str = include_str!("../../../src/App.vue");
const FRONTEND_ERRORS: &str = include_str!("../../../src/api/errors.ts");
// `ERROR_DOMAIN` above is the same file as the old `DOMAIN_ERROR` constant, which
// was only ever read by `rust_error_codes`. That function now discovers the domain
// tree itself, so the duplicate is removed rather than left to warn.

// ---------------------------------------------------------------------------
// The WebView cannot become an authorisation source
// ---------------------------------------------------------------------------

#[test]
fn commands_never_construct_a_session() {
    let code = code_only(COMMANDS);
    assert!(
        !code.contains("Session {"),
        "commands must never build a Session literal"
    );
    assert!(
        !code.contains("Session::open"),
        "only services may open a session, and only from resolved facts"
    );
    assert!(
        !code.contains("SessionFacts"),
        "commands must not assemble persistence facts themselves"
    );
}

#[test]
fn no_command_accepts_a_token_a_role_or_an_assurance_level() {
    // Parsed from the real signatures rather than matched as substrings, because
    // the response DTO legitimately has fields called `role` and `assurance`.
    let parameters = command_parameters(&code_only(COMMANDS));
    assert!(
        !parameters.is_empty(),
        "expected to parse at least one command signature"
    );
    for forbidden in ["token", "role", "assurance", "session_token"] {
        assert!(
            !parameters.iter().any(|name| name == forbidden),
            "no command may accept a `{forbidden}` parameter; found in {parameters:?}"
        );
    }
}

#[test]
fn the_session_type_has_no_public_constructor() {
    let code = code_only(DOMAIN_SESSION);
    // Scoped to `impl Session`, so `SessionToken::new` in the same file is not
    // mistaken for `Session::new`.
    let session_impl = impl_body(&code, "Session");
    assert!(
        !session_impl.is_empty(),
        "expected an `impl Session` block"
    );
    assert!(
        !session_impl.contains("pub fn new("),
        "Session must not gain a public constructor"
    );
    assert!(
        !session_impl.contains("pub user_id"),
        "Session fields must stay private"
    );
    assert!(
        code.contains("pub fn open("),
        "Session::open must remain the single entry point"
    );
}

// ---------------------------------------------------------------------------
// The token never reaches JavaScript
// ---------------------------------------------------------------------------

#[test]
fn the_frontend_contains_no_session_token_handling() {
    for (name, source) in [("main.ts", FRONTEND_MAIN), ("App.vue", FRONTEND_APP)] {
        for forbidden in [
            "sessionToken",
            "session_token",
            "token_hash",
            "localStorage",
            "sessionStorage",
        ] {
            assert!(
                !source.contains(forbidden),
                "{name} must not mention `{forbidden}` (ADR-009)"
            );
        }
    }
}

#[test]
fn the_token_is_read_from_the_os_store_not_supplied_by_a_caller() {
    let code = code_only(SERVICES_SESSION);
    assert!(
        code.contains("tokens.get()"),
        "session resolution must read the credential store"
    );
    let parameters = command_parameters(&code);
    for forbidden in ["token", "raw_token"] {
        assert!(
            !parameters.iter().any(|name| name == forbidden),
            "service functions must not accept `{forbidden}`; found in {parameters:?}"
        );
    }
}

#[test]
fn the_secure_store_has_no_weaker_fallback() {
    let code = code_only(SECURE_STORE);
    // A real fallback would need to persist the secret somewhere in this file.
    for forbidden in ["std::fs::write", "File::create", "OpenOptions"] {
        assert!(
            !code.contains(forbidden),
            "the secure store must not fall back to `{forbidden}`"
        );
    }
    assert!(
        code.contains("Unavailable"),
        "unavailability must remain an explicit error variant"
    );
}

// ---------------------------------------------------------------------------
// Layer boundaries (spec:99, spec:101, spec:148)
// ---------------------------------------------------------------------------

#[test]
fn the_domain_mentions_no_infrastructure() {
    let code = code_only(DOMAIN_SESSION);
    for forbidden in ["tauri", "sqlx", "SqlitePool", "keyring"] {
        assert!(
            !code.contains(forbidden),
            "the domain must not reference `{forbidden}` (spec:99)"
        );
    }
    assert!(
        code_only(DOMAIN_MOD).contains("pub use error::DomainError"),
        "the identity module must keep re-exporting its domain types"
    );
}

#[test]
fn no_general_sql_command_is_exposed() {
    let code = code_only(COMMANDS);
    let mod_code = code_only(COMMANDS_MOD);
    for forbidden in ["execute_sql", "executeSql", "select_sql", "selectSql"] {
        assert!(
            !code.contains(forbidden) && !mod_code.contains(forbidden),
            "a general SQL command must never exist: `{forbidden}`"
        );
    }
}

#[test]
fn every_registered_command_is_a_named_function() {
    let code = code_only(LIB);
    for command in [
        "bootstrap_status",
        "create_first_manager",
        "list_users_for_picker",
        "login",
        "login_with_pin",
        "approve_with_owner_pin",
        "logout",
        "whoami",
        "reauthenticate",
    ] {
        assert!(
            code.contains(&format!("commands::identity::{command}")),
            "command `{command}` must stay registered"
        );
    }
}

// ---------------------------------------------------------------------------
// Error codes and Arabic messages
// ---------------------------------------------------------------------------

/// The domain tree, located absolutely from the compile-time manifest directory.
///
/// `env!("CARGO_MANIFEST_DIR")` rather than a relative path: these tests read from
/// disk at run time, and cargo does not guarantee the working directory of a test
/// binary. The manifest directory is fixed at compile time, so this cannot drift.
fn domain_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/domain")
}

/// Every `.rs` file under `src/domain/`, as `(file name, source text)`.
///
/// Walked at run time rather than listed by hand. A hand-written list is a
/// registration step that has to be remembered, and forgetting it is silent: the
/// scanner would simply not see the new slice's codes, so the Arabic-message
/// drift guard would go on passing while a real code had no message. Discovering
/// the sources removes the failure mode instead of documenting it.
fn domain_sources() -> Vec<(String, String)> {
    fn walk(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        // Sorted so a failure message is reproducible run to run. `read_dir`
        // yields directory order, which is filesystem-dependent.
        let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("<unnamed>")
                        .to_string();
                    out.push((name, text));
                }
            }
        }
    }

    let mut found = Vec::new();
    walk(&domain_root(), &mut found);
    assert!(
        !found.is_empty(),
        "found no domain sources under {}; the scanner would pass vacuously",
        domain_root().display()
    );
    found
}

/// Codes the Rust `code()` methods can return, read out of the match arms.
///
/// Scans every domain error enum, not just the first one. Each slice owns its own
/// error type, and a scanner pointed at a single file would let a new slice's
/// codes drift out of the Arabic message table without failing the build.
fn rust_error_codes() -> Vec<String> {
    let mut codes = rust_error_codes_per_source().concat();
    // The inventory service declares its own error codes beside the domain ones
    // (`STOCK_*`). Its `StockServiceError::code` *delegates* to the enum it
    // wraps, so it contributes no literal arms and must not be held to the
    // non-vacuity rule below — which is why the scan is added here rather than
    // by widening the domain walk.
    codes.extend(literal_code_arms(&COSTING_SERVICE));
    codes
}

/// Literal `"UPPER_SNAKE"` values on the right of a `=>` in a `code()` body.
///
/// Shared by the per-source scanner and by the service-level addition above so
/// the two can never drift into accepting different syntax.
fn literal_code_arms(source: &str) -> Vec<String> {
    let code_only_src = code_only(source);
    let Some(start) = code_only_src.find("pub fn code(&self)") else {
        return Vec::new();
    };

    let mut codes = Vec::new();
    for line in code_only_src[start..].lines() {
        // Arms look like:  CatalogError::Foo => "FOO_CODE",
        let Some((_, rest)) = line.split_once("=> \"") else {
            continue;
        };
        let Some((code, _)) = rest.split_once('"') else {
            continue;
        };
        if code
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            && code.len() > 2
        {
            codes.push(code.to_string());
        }
    }
    codes
}

/// The same codes, grouped by the file each came from.
///
/// Returned per source so a test can prove that *each* enum yielded codes. The
/// flattened form alone cannot distinguish "this enum produced nothing" from
/// "this enum has none", which is exactly how a scanner silently stops matching.
fn rust_error_codes_per_source() -> Vec<Vec<String>> {
    let mut per_source = Vec::new();

    for (name, source) in domain_sources() {
        let code_only_src = code_only(&source);
        let Some(start) = code_only_src.find("pub fn code(&self)") else {
            continue;
        };

        let mut codes = Vec::new();
        for line in code_only_src[start..].lines() {
            // Arms look like:  CatalogError::Foo => "FOO_CODE",
            let Some((_, rest)) = line.split_once("=> \"") else {
                continue;
            };
            let Some((code, _)) = rest.split_once('"') else {
                continue;
            };
            if code
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                && code.len() > 2
            {
                codes.push(code.to_string());
            }
        }

        // A source that declares `pub fn code(&self)` but yields nothing means
        // the arm syntax changed and the scanner stopped matching it. Reported
        // here, with the file name, instead of silently contributing zero codes.
        assert!(
            !codes.is_empty(),
            "`{name}` declares `pub fn code(&self)` but the scanner read no code from it; \
             the match-arm syntax must have changed and this scanner would miss every code in it"
        );

        per_source.push(codes);
    }

    per_source
}

/// Codes declared in the frontend's `ErrorCode` object.
fn frontend_error_codes() -> Vec<String> {
    code_only(FRONTEND_ERRORS)
        .lines()
        .filter_map(|line| {
            let (_, rest) = line.split_once(": '")?;
            let (code, _) = rest.split_once('\'')?;
            if code
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                && code.len() > 2
            {
                Some(code.to_string())
            } else {
                None
            }
        })
        .collect()
}

#[test]
fn every_rust_error_code_has_an_arabic_message() {
    // The drift guard. Rust emits a code; the frontend indexes an Arabic table
    // by it. If someone adds a code in Rust and forgets the message, an operator
    // would see the generic fallback instead of a real explanation. This fails
    // the build instead.
    let rust = rust_error_codes();
    let frontend = frontend_error_codes();

    assert!(
        !rust.is_empty(),
        "could not parse any code out of DomainError::code(); the test would pass vacuously"
    );

    for code in &rust {
        assert!(
            frontend.contains(code),
            "Rust emits `{code}` but src/api/errors.ts declares no message for it"
        );
    }
}

#[test]
fn the_frontend_declares_no_code_rust_cannot_emit() {
    // The reverse direction: a stale entry in the frontend is dead code that
    // suggests a message is reachable when it is not.
    let rust = rust_error_codes();
    for code in frontend_error_codes() {
        assert!(
            rust.contains(&code),
            "src/api/errors.ts maps `{code}` but Rust never emits it"
        );
    }
}

#[test]
fn rust_never_sends_user_facing_prose_to_the_frontend() {
    // `spec:127` requires user-facing text to live in Arabic message files. The
    // command layer must therefore return a code, not a sentence.
    let commands = code_only(COMMANDS);

    // Scoped to error handling. `to_string()` elsewhere in this file is
    // legitimate — the `role` DTO field is a String because Tauri serialises it
    // to JSON — so a blanket ban would be a false positive.
    for forbidden in [
        "error.to_string()",
        "err.to_string()",
        "e.to_string()",
        "format!(\"{}\", error",
        ".code().to_string()",
    ] {
        assert!(
            !commands.contains(forbidden),
            "the command layer must not stringify errors for the transport: `{forbidden}`"
        );
    }

    assert!(
        commands.contains("pub code:"),
        "CommandError must expose a code field for the frontend"
    );
    // And the frontend must be the thing that decides language.
    assert!(
        FRONTEND_ERRORS.contains("messageFor"),
        "the frontend must own message rendering"
    );
    assert!(
        FRONTEND_APP.contains("describeError"),
        "App.vue must render errors through the shared message file"
    );
}

#[test]
fn no_arabic_text_leaks_into_the_rust_error_codes() {
    // A guard against someone "just adding" an Arabic string to the transport
    // to fix a wording problem quickly.
    let codes = rust_error_codes();
    for code in codes {
        assert!(
            code.is_ascii(),
            "`{code}` contains non-ASCII; error codes must be language-independent"
        );
    }
}

#[test]
fn identity_schema_carries_no_price_or_sync_state() {
    // The identity migration holds only accounts, sessions and the audit trail.
    // Attribution columns on the catalogue refer to `users`, so nothing here
    // needs a price or a sync table.
    let code = sql_only(MIGRATION);
    for forbidden in ["price", "cost", "sync_outbox", "sync_cursors", "outbox"] {
        assert!(
            !code.contains(forbidden),
            "`{forbidden}` must not appear in the identity schema"
        );
    }
    for required in ["create table users", "create table sessions", "create table audit_events"] {
        assert!(
            code.contains(required),
            "the identity schema must contain `{required}`"
        );
    }
}

#[test]
fn the_catalogue_stores_a_sale_price_and_no_cost_or_wholesale_price() {
    // ADR-010 fixes EGP in piastres as an INTEGER minor unit, so a sale price
    // column is now legitimate. What must stay out is everything the catalogue
    // slice was explicitly told not to add: cost, wholesale, categories,
    // inventory movements and serialised units.
    let code = sql_only(CATALOG_MIGRATION);

    assert!(
        code.contains("sale_price_minor"),
        "the catalogue must hold a sale price in minor units"
    );
    for forbidden in [
        "cost_minor",
        "cost",
        "wholesale",
        "category",
        "categories",
        "stock_movement",
        "serialized_unit",
        "image",
        "sync_outbox",
        "sync_cursors",
        "outbox",
    ] {
        assert!(
            !code.contains(forbidden),
            "`{forbidden}` must not appear in the catalogue schema"
        );
    }
    assert!(
        code.contains("create table products"),
        "the catalogue must define a products table"
    );
}

#[test]
fn the_catalogue_price_column_is_nullable_and_uniquely_constrains_the_barcode() {
    // NULL must mean "not set" and 0 must mean "free" (ADR-010), so the column
    // cannot be NOT NULL with a default of zero.
    let raw = CATALOG_MIGRATION.to_ascii_lowercase();
    let line = raw
        .lines()
        .find(|l| l.trim_start().starts_with("sale_price_minor"))
        .expect("the products table must declare sale_price_minor");
    assert!(
        !line.contains("not null"),
        "sale_price_minor must stay nullable so an unset price is distinguishable from a free one"
    );

    // A nullable unique column still permits many products without a barcode,
    // because SQL unique constraints ignore NULL.
    let unique = raw
        .lines()
        .find(|l| l.contains("unique") && l.contains("barcode"))
        .expect("barcode must carry a UNIQUE constraint");
    assert!(unique.contains("unique"), "barcode must be unique");
}

#[test]
fn the_catalogue_records_attribution_and_refuses_deletion_of_a_referenced_user() {
    let code = sql_only(CATALOG_MIGRATION);
    for required in ["created_by", "updated_by"] {
        assert!(
            code.contains(required),
            "the catalogue must record `{required}` per `spec:177`"
        );
    }
    // RESTRICT rather than CASCADE: deleting a user must not silently delete
    // products that appear in history.
    assert!(
        code.contains("on delete restrict"),
        "catalogue attribution must use ON DELETE RESTRICT"
    );
}

#[test]
fn catalogue_commands_take_no_session_token_user_or_role() {
    // The same rule the identity commands obey, extended to the new module: a
    // caller must not be able to assert who it is. Comments are stripped first,
    // so a doc comment that merely mentions a token cannot satisfy or fail the
    // check by accident.
    let parameters = command_parameters(&code_only(CATALOG_COMMANDS));
    assert!(
        !parameters.is_empty(),
        "the catalogue command parameters must still be discoverable"
    );
    for parameter in &parameters {
        for forbidden in ["token", "user_id", "userId", "role", "created_by", "updated_by"] {
            assert!(
                !parameter.contains(forbidden),
                "a catalogue command must not accept `{parameter}` ({forbidden}); the operator is \
                 resolved from the secure store"
            );
        }
    }
}

#[test]
fn catalogue_services_never_touch_sql() {
    assert!(
        !CATALOG_SERVICES.contains("sqlx::query"),
        "queries belong in the repository layer, not in a use case"
    );
    assert!(
        !CATALOG_SERVICES.contains("SELECT ") && !CATALOG_SERVICES.contains("INSERT "),
        "no raw SQL may appear in a catalogue use case"
    );
}

#[test]
fn the_catalogue_domain_depends_on_no_infrastructure() {
    // `spec:99` and ADR-008: the domain must stay free of Tauri, SQLx and OS
    // APIs so it can be reasoned about on its own.
    for forbidden in ["sqlx", "tauri", "std::process", "rusqlite", "reqwest"] {
        assert!(
            !CATALOG_DOMAIN.contains(forbidden),
            "the catalogue domain must not mention `{forbidden}`"
        );
    }
}

#[test]
fn the_frontend_keeps_an_unset_price_distinguishable_from_a_free_one() {
    // Q: `NULL` means the price is not set and `0` means the product is free
    // (ADR-010). The whole distinction lives in a TypeScript type, so nothing
    // else in the build would notice if someone quietly narrowed it to `number`.
    // An operator would then see a product awaiting a price as a free one.
    let api = code_only(FRONTEND_CATALOG_API);

    assert!(
        api.contains("salePriceMinor?: number | null"),
        "creating a product must allow an omitted or explicitly null price"
    );
    assert!(
        api.contains("readonly salePriceMinor: number | null"),
        "the product returned to the UI must keep its price nullable"
    );
    assert!(
        api.contains("readonly salePriceMinor?: number | null"),
        "the patch type must distinguish an absent field from an explicit null"
    );

    // Guard against the specific collapse that would break it.
    assert!(
        !api.contains("salePriceMinor: number,"),
        "salePriceMinor must never be a bare number; null and zero are different states"
    );
}

#[test]
fn the_catalogue_api_sends_no_token_or_session_token() {
    // Mirrors the Rust-side rule at the TypeScript boundary: the frontend holds
    // no credential, so it has nothing to send even if it wanted to.
    let api = code_only(FRONTEND_CATALOG_API);
    for forbidden in ["sessionToken", "invoke<string>(\"login\")", "localStorage"] {
        assert!(
            !api.contains(forbidden),
            "src/api/catalog.ts must not reference `{forbidden}`"
        );
    }
}

#[test]
fn the_catalogue_api_does_not_reopen_the_blocked_barcode_decision() {
    // ADR-008 blocks scanning, generation and label printing. A catalogue API
    // that grew a camera or print entry point would be reopening that decision
    // by the back door.
    let api = code_only(FRONTEND_CATALOG_API);
    for forbidden in [
        "getCurrentWebview",
        "scan",
        "camera",
        "print",
        "generateBarcode",
        "BarcodeDetector",
    ] {
        assert!(
            !api.contains(forbidden),
            "src/api/catalog.ts must not reference `{forbidden}`; barcode capture is blocked"
        );
    }
}

#[test]
fn the_schema_records_the_security_relevant_constraints() {
    let code = sql_only(MIGRATION);
    // The column that stands in for the token. Asserting on the identifier
    // rather than the phrase "SHA-256" is deliberate: the digest algorithm is
    // documented in ADR-009, and what the schema must guarantee is that the
    // column is named for a hash and holds no token.
    assert!(
        code.contains("token_hash"),
        "the session table must key on a digest column"
    );
    assert!(
        !code.contains("token text"),
        "no column may store the token itself"
    );
    // Role is a closed set, not free text.
    assert!(code.contains("check (role in"));
    // Assurance is a closed set too.
    assert!(code.contains("check (assurance in"));
}

#[test]
fn lifecycle_commands_take_no_session_token_role_or_actor() {
    // Same rule the identity and catalogue commands obey. A caller must not be able
    // to assert who it is, nor name an actor for an administrative write.
    // Naming a *target* account is the whole point of an administrative command:
    // `user_id` is the account being acted upon, and `role` is the role being
    // assigned to it. Neither lets a caller assert who it is.
    //
    // What must be impossible is the caller's own authority being named rather than
    // derived from the resolved session, so the ban is on the shapes that would do
    // that. An `actor`, a token, or anything claiming to be the current operator is
    // rejected by name.
    for parameter in command_parameters(&code_only(LIFECYCLE_COMMANDS)) {
        let lower = parameter.to_lowercase();
        for forbidden in [
            "token", "actor", "assurance", "created_by", "updated_by", "session",
            "current_user", "self_user", "my_user", "current_role", "self_role", "my_role",
            "actor_role",
        ] {
            assert!(
                !lower.contains(forbidden),
                "a lifecycle command must not accept `{parameter}` ({forbidden}); the operator \\
                 is resolved from the secure store, and `{parameter}` would let a caller claim \\
                 to be someone else"
            );
        }
    }

    // Every command that touches an account must take a target and must resolve a
    // session, so the pairing cannot drift: a command acting on an account with no
    // way to authorise it would be a hole.
    assert!(
        command_parameters(&code_only(LIFECYCLE_COMMANDS))
            .iter()
            .any(|p| p.to_lowercase().contains("ctx")),
        "lifecycle commands must still receive the managed context"
    );
}

#[test]
fn lifecycle_services_never_touch_sql() {
    for (name, source) in [
        ("password", LIFECYCLE_PASSWORD_SERVICE),
        ("users", LIFECYCLE_USERS_SERVICE),
    ] {
        assert!(
            !source.contains("sqlx::query"),
            "queries belong in the repository layer, not in the {name} use case"
        );
        assert!(
            !source.contains("SELECT ") && !source.contains("INSERT "),
            "no raw SQL may appear in the {name} use case"
        );
    }
}

#[test]
fn the_lifecycle_migration_keeps_the_credential_invariant_in_the_schema() {
    // D19. A `NOT NULL UNIQUE` that existed only in application code would be an
    // invariant a future caller could forget, so the schema text is asserted here.
    let code = sql_only(LIFECYCLE_MIGRATION);
    assert!(
        code.contains("username") && code.contains("not null"),
        "the login identifier must be declared NOT NULL"
    );
    assert!(
        code.contains("unique"),
        "the login identifier must be declared UNIQUE"
    );
    assert!(
        code.contains("must_change_password") && code.contains("check"),
        "the forced-change flag must carry a CHECK constraint"
    );
}

#[test]
fn the_lifecycle_migration_does_not_rebuild_or_disable_foreign_keys() {
    // The whole reason `user_credentials` exists as a separate table. A rebuild would
    // need `-- no-transaction`, and `PRAGMA foreign_keys` is per-connection, so a
    // migration that toggled it could hand the pool a connection with foreign keys
    // off and silently disable the catalogue's `ON DELETE RESTRICT` guarantee.
    // `sql_only` strips `--` comments first, so the migration's own explanation of
    // *why* it avoids `PRAGMA` cannot trip the guard that forbids using it.
    let source = sql_only(LIFECYCLE_MIGRATION);
    assert!(
        !LIFECYCLE_MIGRATION.starts_with("-- no-transaction"),
        "the lifecycle migration must run inside the normal DDL transaction"
    );
    for forbidden in [
        "pragma foreign_keys",
        "drop table",
        "create table users_new",
        "vacuum",
    ] {
        assert!(
            !source.contains(forbidden),
            "`{forbidden}` must not appear: the migration must not rebuild `users`"
        );
    }
}

#[test]
fn the_inventory_schema_stays_a_classification_and_never_a_location() {
    // D2: a department is a product classification. V1 has one stock counter per
    // product, so nothing in the schema may express a physical place goods sit.
    // Scoped to the two migrations that introduce departments and the product
    // profile, because those are the only files that could introduce one.
    for (name, source) in [
        ("0004_departments", DEPARTMENTS_MIGRATION),
        ("0005_products_inventory_profile", PRODUCTS_PROFILE_MIGRATION),
    ] {
        let code = sql_only(source);
        for forbidden in [
            "warehouse",
            "location",
            "branch",
            "stockroom",
            "storeroom",
            "aisle",
            "shelf",
            "bin_id",
            "on_hand",
            "stock_levels",
            "stock_movements",
        ] {
            // `quantity` is deliberately NOT on this list: it is a legitimate
            // disposition *value* in `0005`'s CHECK, not a column name. Banning
            // the word would forbid the third-class product the Product Owner
            // approved.
            assert!(
                !code.contains(forbidden),
                "`{forbidden}` must not appear in {name}: a department is a \
                 classification, and a physical location would invent a \
                 multi-location requirement V1 does not have"
            );
        }
    }

    // And the one word that *is* expected, so the guard above cannot pass because
    // the migrations stopped talking about departments at all.
    assert!(
        sql_only(DEPARTMENTS_MIGRATION).contains("create table departments"),
        "the departments table must exist"
    );
    assert!(
        sql_only(PRODUCTS_PROFILE_MIGRATION).contains("references departments (id)"),
        "`products.department_id` must point at departments, which is what makes a \
         department a classification the product belongs to"
    );
}

#[test]
fn the_products_rebuild_stays_inside_the_migration_transaction() {
    // `0003` refused to rebuild `users` because that needed `-- no-transaction`
    // and a per-connection `PRAGMA foreign_keys=OFF`. Rebuilding `products` is
    // safe for the opposite reason: nothing references it yet. These two
    // assertions keep the reason true rather than accidental — if a later
    // migration adds a foreign key *to* products, this rebuild must be revisited.
    assert!(
        !PRODUCTS_PROFILE_MIGRATION.starts_with("-- no-transaction"),
        "the products rebuild must run inside the normal DDL transaction"
    );
    let code = sql_only(PRODUCTS_PROFILE_MIGRATION);
    assert!(
        !code.contains("pragma foreign_keys"),
        "the products rebuild must not toggle foreign keys; every FK on the table \
         points outward to users and is recreated verbatim"
    );
    for required in [
        "create table products_rebuilt",
        "insert into products_rebuilt",
        "drop table products",
        "alter table products_rebuilt rename to products",
    ] {
        assert!(
            code.contains(required),
            "the rebuild must include `{required}`"
        );
    }
}

#[test]
fn the_products_rebuild_keeps_every_original_column_and_adds_only_the_approved_ones() {
    // Each column `0002` declared must survive the rebuild, or the migration
    // would silently discard catalogue data on a device that already has products.
    let rebuilt = sql_only(PRODUCTS_PROFILE_MIGRATION);
    let original = sql_only(CATALOG_MIGRATION);

    for column in [
        "id",
        "name",
        "disposition",
        "barcode",
        "sale_price_minor",
        "status",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at",
    ] {
        assert!(
            original.contains(column),
            "precondition: `{column}` should be in the catalogue migration"
        );
        assert!(
            rebuilt.contains(column),
            "`{column}` must survive the products rebuild"
        );
    }

    // And exactly the three approved additions, no more.
    for added in ["department_id", "default_cost_minor", "vat_rate_bp"] {
        assert!(
            rebuilt.contains(added),
            "`{added}` must be added by the rebuild"
        );
    }

    // The third disposition class, and no fourth.
    assert!(
        rebuilt.contains("'quantity', 'serialized', 'one_off'"),
        "the rebuild must widen `disposition` to exactly the three approved classes"
    );

    // Money stays integral. A REAL here would break `spec:56` and ADR-010.
    for forbidden in ["real", "float", "numeric", "decimal", "double"] {
        let column_lines: Vec<&str> = rebuilt
            .lines()
            .filter(|line| line.contains(forbidden))
            .collect();
        assert!(
            column_lines.is_empty(),
            "`{forbidden}` must not appear in the products schema; found {column_lines:?}"
        );
    }
}

#[test]
fn no_user_deletion_path_exists_anywhere() {
    // D10. A deletion path must be absent, not merely unused: a `DELETE FROM users`
    // reaching a device that already attributed products to an operator would either
    // fail at the database or lose history.
    for (name, source) in [
        ("user repository", LIFECYCLE_REPO),
        ("credentials repository", CREDENTIALS_REPO),
        ("lifecycle commands", LIFECYCLE_COMMANDS),
    ] {
        assert!(
            !code_only(source).to_lowercase().contains("delete from users"),
            "the {name} must contain no deletion of a user"
        );
    }
}

#[test]
fn session_revocation_is_scoped_to_one_user() {
    // The mandatory regression from the plan. `delete_all` exists for signing in;
    // reusing it for a manager reset would revoke the manager's own session.
    let code = code_only(SESSION_REPO).to_lowercase();
    assert!(code.contains("delete_by_user"), "a per-user revocation must exist");
    assert!(
        code.contains("delete from sessions where user_id"),
        "revocation must filter on user_id rather than removing every session"
    );
}

#[test]
fn the_assurance_policy_is_declared_on_the_permission() {
    // Adding a sensitive capability must be a decision at the permission, not a
    // growing conditional inside the authorisation function.
    let code = code_only(ROLE_SOURCE);
    assert!(
        code.contains("fn requires_reauthenticated"),
        "Permission must own the assurance requirement"
    );
    assert!(
        code.contains("Permission::ManageUsers"),
        "ManageUsers must be listed among the capabilities that need re-authentication"
    );

    // Bound to a local so the stripped source outlives the borrow `impl_body`
    // returns from it.
    let session_code = code_only(DOMAIN_SESSION);
    let body = impl_body(&session_code, "Session");
    assert!(
        !body.to_lowercase().contains("permission::viewcostandprofit"),
        "Session::authorize must not special-case a single permission"
    );
}

#[test]
fn the_forced_change_gate_lives_in_the_domain() {
    // D4, enforced at the application/data layer as `spec:210` requires rather than
    // by hiding a screen.
    // Bound to a local so the stripped source outlives the borrow `impl_body`
    // returns from it.
    let session_code = code_only(DOMAIN_SESSION);
    let body = impl_body(&session_code, "Session").to_lowercase();
    assert!(
        body.contains("must_change_password"),
        "authorize must consult the forced-change state"
    );
    assert!(
        body.contains("passwordchangerequired"),
        "a pending change must raise PasswordChangeRequired"
    );
    assert!(
        code_only(ROLE_SOURCE).contains("fn is_self_service"),
        "a self-service permission must be recognisable, or the account is stuck"
    );
}

#[test]
fn username_normalisation_lives_in_the_domain() {
    // If normalisation moved to the command layer, a caller could skip it and write
    // a row the database treats as a duplicate while the UI shows it as distinct.
    let code = code_only(USER_SOURCE);
    assert!(
        code.contains("pub struct Username"),
        "the identifier must be a domain type"
    );
    assert!(
        code.contains("to_lowercase"),
        "the constructor must normalise so no caller can skip it"
    );
}

#[test]
fn a_missing_credentials_row_can_never_be_read_as_no_change_pending() {
    // The security property behind the whole `LEFT JOIN` decision. A missing
    // `user_credentials` row must not collapse into "no forced change", because that
    // would issue a session that walks past the gate.
    for (name, source) in [
        ("session repository", SESSION_REPO),
        ("credentials repository", CREDENTIALS_REPO),
        ("auth service", AUTH_SERVICE),
    ] {
        let code = code_only(source).to_lowercase();
        assert!(
            !code.contains("unwrap_or(0)"),
            "the {name} must not default a missing forced-change flag to 0"
        );
    }

    // Narrower than a blanket ban: `flatten` is legitimate elsewhere. What matters is
    // that the forced-change read keeps the three states apart.
    let session = code_only(SESSION_REPO).to_lowercase();
    assert!(
        !session.contains("must_change_raw.unwrap_or(0)"),
        "the session repository must not default a missing forced-change flag"
    );

    // The three states must be distinguishable in the repository that decides.
// `code_only` preserves newlines and this signature is wrapped across several
    // lines, so the text is joined before searching. The needle matches the full
    // `Result<Option<bool>, _>` return type: the `Option` is the point, since a
    // bare `bool` could not represent "the row is absent".
    let credentials = code_only(CREDENTIALS_REPO).to_lowercase().replace('\n', " ");
    assert!(
        credentials.contains("-> result<option<bool>,"),
        "must_change_password must return Result<Option<bool>, _> so absent is \\
         distinguishable from false"
    );
}

#[test]
fn the_credentials_join_does_not_hide_an_account() {
    // A missing credentials row must leave the account visible. An inner join drops it
    // silently, and an operator looking at a short list cannot know an account went
    // missing or why.
    let code = code_only(LIFECYCLE_REPO).to_lowercase();
    assert!(
        code.contains("left join user_credentials"),
        "the listing must use a LEFT JOIN so a broken account still appears"
    );
    assert!(
        !code.contains("from users u\n         join user_credentials")
            && !code.contains("from users u join user_credentials"),
        "an INNER JOIN would hide an account with a broken credentials row"
    );
    assert!(
        code.contains("pub username: option<username>"),
        "the absence must be representable rather than defaulted"
    );
}

#[test]
fn no_code_path_fabricates_credentials_for_a_missing_row() {
    // Read paths must never invent a username, default the flag, or insert a row to
    // paper over the gap. Only `create_user` and bootstrap write here.
    for (name, source) in [
        ("credentials repository", CREDENTIALS_REPO),
        ("user repository", LIFECYCLE_REPO),
        ("auth service", AUTH_SERVICE),
        ("lifecycle users service", LIFECYCLE_USERS_SERVICE),
    ] {
        let code = code_only(source).to_lowercase();
        assert!(
            !code.contains("insert or ignore into user_credentials")
                && !code.contains("insert or replace into user_credentials"),
            "the {name} must not auto-create a credentials row while reading"
        );
    }
}

#[test]
fn the_integrity_failure_has_its_own_error_code() {
    // Reusing `LOCAL_STORAGE_UNAVAILABLE` would send a technician chasing a database
    // outage that is not happening; reusing `INVALID_CREDENTIALS` would tell an
    // operator their password is wrong when it is not.
    let code = code_only(ERROR_DOMAIN).to_lowercase();
    assert!(
        code.contains("=> \"account_data_integrity_error\""),
        "the integrity failure must map to its own stable code"
    );

    // And it must actually be raised where the invariant can break.
    let auth = code_only(AUTH_SERVICE).to_lowercase();
    assert!(
        auth.contains("accountdataintegrityerror"),
        "login must refuse an account with a broken credentials row"
    );
    let sessions = code_only(SESSION_REPO).to_lowercase();
    assert!(
        sessions.contains("no user_credentials row"),
        "resolving a session must treat a missing credentials row as a failure"
    );
}

#[test]
fn the_picker_refuses_rather_than_projecting_a_partial_list() {
    // The picker is where a silent disappearance would hurt most, so the command
    // layer fails the whole call instead of returning a list with an account
    // missing from it.
    let code = code_only(IDENTITY_COMMANDS).to_lowercase();
    assert!(
        code.contains("any(|user| user.username.is_none())"),
        "the picker command must detect an account with no identifier"
    );
    assert!(
        code.contains("accountdataintegrityerror"),
        "and must report it as an integrity failure"
    );
}

#[test]
fn the_management_list_keeps_a_broken_account_visible() {
    // The one surface where an operator can act on the fault, so it must show the row
    // with a flag rather than omit it.
    let code = code_only(LIFECYCLE_USERS_SERVICE).to_lowercase();
    assert!(
        code.contains("integrity_fault"),
        "the management projection must carry an integrity flag"
    );
    assert!(
        code.contains("missing_username_placeholder"),
        "and a placeholder that can never be mistaken for a real identifier"
    );
}

#[test]
fn username_normalisation_stays_in_the_domain() {
    // Regression guard for the refactor that made the username optional: the
    // normalisation must not have leaked into a caller.
    let code = code_only(USER_DOMAIN_SOURCE);
    assert!(
        code.contains("to_lowercase"),
        "the constructor must still normalise"
    );
    assert!(
        code.contains("pub struct Username"),
        "the identifier must still be a domain type"
    );
}

// ---------------------------------------------------------------------------
// Authority, settings and the owner's approval (SP-1b/c; ADR-017 §3)
// ---------------------------------------------------------------------------

/// The category commands (ADR-018 §1), which replaced the department commands
/// of SP-1b (archived with their panel).
const CATEGORY_COMMANDS: &str = include_str!("../../src/commands/categories.rs");
const CATEGORIES_SERVICE: &str =
    include_str!("../../src/services/organisation/categories.rs");
const CATEGORY_TREE_MIGRATION: &str =
    include_str!("../../src/data/migrations/0016_category_tree.sql");
/// Phone brands and registering a new phone (ADR-018 §2).
const BRAND_COMMANDS: &str = include_str!("../../src/commands/brands.rs");
const BRANDS_SERVICE: &str = include_str!("../../src/services/catalog/brands.rs");
const PHONE_SERVICE: &str = include_str!("../../src/services/catalog/phone.rs");
const BRAND_DOMAIN: &str = include_str!("../../src/domain/catalog/brand.rs");
const BRANDS_MIGRATION: &str =
    include_str!("../../src/data/migrations/0017_brands_and_phone_details.sql");
/// Product variants (ADR-018 §4).
const VARIANTS_SERVICE: &str = include_str!("../../src/services/catalog/variants.rs");
const VARIANT_DOMAIN: &str = include_str!("../../src/domain/catalog/variant.rs");
const VARIANTS_MIGRATION: &str =
    include_str!("../../src/data/migrations/0018_product_variants.sql");
/// Product images (ADR-018 §5).
const IMAGES_SERVICE: &str = include_str!("../../src/services/catalog/images.rs");
const IMAGE_DOMAIN: &str = include_str!("../../src/domain/catalog/image.rs");
const IMAGES_MIGRATION: &str =
    include_str!("../../src/data/migrations/0019_product_images.sql");


const SETTINGS_COMMANDS: &str = include_str!("../../src/commands/settings.rs");
const ORGANISATION_SERVICE: &str =
    include_str!("../../src/services/organisation/departments.rs");
const SETTINGS_SERVICE: &str = include_str!("../../src/services/settings/mod.rs");
const APPROVAL_SERVICE: &str = include_str!("../../src/services/identity/approval.rs");
const AUDIT_EVENTS: &str = include_str!("../../src/data/repositories/identity/audit.rs");

/// Every command module added by SP-1b/c, with its module path in `lib.rs`.
///
/// The Pattern's module left with the Pattern (ADR-017 §3); the owner's
/// approval is an identity command, covered with the identity rules.
fn authority_command_modules() -> Vec<(&'static str, &'static str)> {
    vec![
        ("categories", CATEGORY_COMMANDS),
        ("brands", BRAND_COMMANDS),
        ("settings", SETTINGS_COMMANDS),
    ]
}

#[test]
fn authority_commands_take_no_token_role_or_actor() {
    // The same rule identity, catalogue and lifecycle commands obey, extended
    // to the new modules: a caller must not be able to assert who it is.
    // Comments are stripped first, so a doc comment mentioning a token cannot
    // fail the check by accident.
    let mut parsed = 0usize;
    for (module, source) in authority_command_modules() {
        let parameters = command_parameters(&code_only(source));
        assert!(
            !parameters.is_empty(),
            "the `{module}` command parameters must still be discoverable"
        );
        parsed += parameters.len();
        for parameter in &parameters {
            let lower = parameter.to_lowercase();
            for forbidden in [
                "token", "user_id", "userid", "role", "created_by", "updated_by", "actor",
                "assurance", "session",
            ] {
                assert!(
                    !lower.contains(forbidden),
                    "a `{module}` command must not accept `{parameter}` ({forbidden}); the \
                     operator is resolved from the secure store"
                );
            }
        }
    }

    // Non-vacuous: the parser must have seen the real signatures, known only
    // from the implementations, not merely found three empty files.
    let all: Vec<String> = authority_command_modules()
        .into_iter()
        .flat_map(|(_, source)| command_parameters(&code_only(source)))
        .collect();
    for known in ["ctx", "parent_id", "hidden", "direction", "key", "value"] {
        assert!(
            all.iter().any(|p| p == known),
            "expected the authority commands to still declare a `{known}` parameter; \
             the signature parser read {all:?}"
        );
    }
    assert!(
        parsed >= 8,
        "expected at least one parameter per registered authority command (8); parsed {parsed}"
    );
}

#[test]
fn authority_commands_never_construct_a_session() {
    // Same rule as `commands_never_construct_a_session`, applied to the new
    // modules: only services may open a session, and only from resolved facts.
    for (module, source) in authority_command_modules() {
        let code = code_only(source);
        assert!(
            !code.contains("Session {"),
            "the `{module}` commands must never build a Session literal"
        );
        assert!(
            !code.contains("Session::open"),
            "only services may open a session, and only from resolved facts (`{module}`)"
        );
        assert!(
            !code.contains("SessionFacts"),
            "the `{module}` commands must not assemble persistence facts themselves"
        );
    }
}

#[test]
fn authority_services_never_touch_sql() {
    // The layer split the plan demands: use cases orchestrate authorization,
    // domain mutation, repository writes and audit, while SQL lives only in
    // the repository layer.
    for (name, source) in [
        ("departments", ORGANISATION_SERVICE),
        ("categories", CATEGORIES_SERVICE),
        ("brands", BRANDS_SERVICE),
        ("phone", PHONE_SERVICE),
        ("variants", VARIANTS_SERVICE),
        ("images", IMAGES_SERVICE),
        ("settings", SETTINGS_SERVICE),
        ("approval", APPROVAL_SERVICE),

    ] {

        let code = code_only(source);
        assert!(
            !code.contains("sqlx::query"),
            "queries belong in the repository layer, not in the {name} use case"
        );
        for statement in ["SELECT ", "INSERT ", "UPDATE ", "DELETE "] {
            assert!(
                !code.contains(statement),
                "no raw `{statement}` SQL may appear in the {name} use case"
            );
        }
    }
}

#[test]
fn every_audit_event_constant_is_ascii_screaming_snake() {
    // The event vocabulary is read by external tooling, so the *constant names*
    // must stay screaming-snake and the module must not silently shrink: the
    // authority slice added six events, and a lost one would lose a fact.
    let source = code_only(AUDIT_EVENTS);
    let marker = "pub mod event {";
    let start = source
        .find(marker)
        .expect("audit.rs must declare `pub mod event`");
    let rest = &source[start + marker.len()..];
    let end = rest.find('}').expect("the event module must close");
    let block = &rest[..end];

    let mut declared = Vec::new();
    for line in block.lines() {
        let Some((_, rest)) = line.split_once("pub const ") else {
            continue;
        };
        let name = rest.split(':').next().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        assert!(
            name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
                && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
            "audit event constant `{name}` must be ASCII screaming-snake"
        );
        declared.push(name.to_string());
    }

    assert!(
        declared.len() >= 19,
        "expected at least the 19 audit event constants (13 identity + SP-1b/c's six); \
         found {}: {declared:?}",
        declared.len()
    );
    // The Pattern's two events stay although nothing writes them since ADR-017:
    // rows written before still need their name.
    for added_by_sp1bc in [
        "DEPARTMENT_CREATED",
        "DEPARTMENT_UPDATED",
        "DEPARTMENT_ARCHIVED",
        "SETTING_CHANGED",
        "PATTERN_SET",
        "PATTERN_RESET",
    ] {
        assert!(
            declared.contains(&added_by_sp1bc.to_string()),
            "`{added_by_sp1bc}` must stay in the audit event vocabulary"
        );
    }
    for added_by_item_1_1 in [
        "PIN_SET",
        "PIN_SET_BY_MANAGER",
        "OWNER_APPROVAL_GRANTED",
        "OWNER_APPROVAL_FAILED",
    ] {
        assert!(
            declared.contains(&added_by_item_1_1.to_string()),
            "`{added_by_item_1_1}` must stay in the audit event vocabulary (ADR-017)"
        );
    }
    for added_by_item_1_2 in [
        "DEPARTMENT_DELETED",
        "DEFAULT_CATEGORIES_ADDED",
        "BRAND_CREATED",
        "BRAND_UPDATED",
        "BRAND_DELETED",
        "DEFAULT_BRANDS_ADDED",
        "VARIANTS_CREATED",
        "PRODUCT_IMAGE_SET",
        "PRODUCT_IMAGE_REMOVED",
    ] {


        assert!(
            declared.contains(&added_by_item_1_2.to_string()),
            "`{added_by_item_1_2}` must stay in the audit event vocabulary (ADR-018)"
        );
    }
}

#[test]
fn stored_secret_material_never_reaches_the_frontend() {
    // A verifier (or anything that could re-derive one) in WebView code would
    // put a secret within reach of a script. Typing a PIN is necessarily a
    // frontend concern; the stored material never is.
    let frontend_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
    let mut sources: Vec<(String, String)> = Vec::new();

    fn walk(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for path in entries.flatten().map(|e| e.path()).collect::<Vec<_>>() {
            if path.is_dir() {
                walk(&path, out);
            } else if matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("ts") | Some("vue")
            ) {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    out.push((
                        path.file_name().and_then(|n| n.to_str()).unwrap_or("?").into(),
                        text,
                    ));
                }
            }
        }
    }

    walk(&frontend_root, &mut sources);
    assert!(
        sources.len() >= 5,
        "found only {} frontend sources under {}; the scan would pass vacuously",
        sources.len(),
        frontend_root.display()
    );

    // Non-vacuous anchor: errors.ts declares the PIN codes, so the frontend
    // does speak about PINs — the ban below is aimed at real code, not at a
    // frontend that never mentions them.
    assert!(
        sources.iter().any(|(_, text)| text.contains("PIN_NOT_SET")),
        "expected the frontend error table to declare the PIN codes; without one \
         this guard would pass vacuously"
    );

    for (name, text) in &sources {
        let lower = text.to_lowercase();
        for forbidden in [
            "verifier",
            "argon2",
            "hash_password",
            "pattern_hash",
            "manager_pattern",
        ] {
            assert!(
                !lower.contains(forbidden),
                "`{name}` mentions `{forbidden}`; stored secret material must stay in Rust"
            );
        }
    }
}

#[test]
fn the_error_code_drift_guards_are_non_vacuous_in_both_directions() {
    // The two existing drift guards each fail when only one side is empty, so
    // an emptied table could pass one of them. Assert both tables are populated
    // here, once, without modifying the SP-1a guards themselves.
    let rust = rust_error_codes();
    let frontend = frontend_error_codes();
    assert!(
        !rust.is_empty(),
        "Rust emits no error codes at all; the forward drift guard would pass vacuously"
    );
    assert!(
        !frontend.is_empty(),
        "src/api/errors.ts declares no error codes; the reverse drift guard would pass \
         vacuously"
    );
    assert!(
        !frontend.iter().any(|code| !rust.contains(code)),
        "every frontend code must be one Rust can emit (checked non-vacuously)"
    );
}

#[test]
fn every_authority_command_is_registered_in_lib() {
    // Registration is what makes a command reachable from the WebView; an
    // unregistered command compiles, tests, and silently does not exist for
    // the application.
    let code = code_only(LIB);
    for (module, command) in [
        ("categories", "list_categories"),
        ("categories", "create_category"),
        ("categories", "rename_category"),
        ("categories", "set_category_hidden"),
        ("categories", "move_category"),
        ("categories", "delete_category"),
        ("catalog", "set_product_category"),
        ("catalog", "next_shop_code"),
        ("catalog", "next_shop_codes"),
        ("catalog", "create_variants"),
        ("brands", "list_brands"),

        ("brands", "create_brand"),
        ("brands", "rename_brand"),
        ("brands", "set_brand_type"),
        ("brands", "set_brand_hidden"),
        ("brands", "move_brand"),
        ("brands", "delete_brand"),
        ("brands", "create_phone"),
        ("settings", "read_settings"),
        ("settings", "update_setting"),
        ("inventory", "receive_stock"),
        ("inventory", "receive_opening_stock"),
        ("inventory", "list_product_units"),
        ("inventory", "remove_stock"),
        ("inventory", "get_position"),
        ("customer", "create_customer"),
        ("customer", "list_customers"),
        ("customer", "get_customer"),
        ("customer", "archive_customer"),
        ("customer", "record_customer_payment"),
        ("customer", "list_customer_ledger"),
        ("shift", "current_shift_summary"),
        ("shift", "open_shift"),
        ("shift", "record_expense"),
        ("shift", "record_cash_movement"),
        ("shift", "close_shift"),
    ] {
        assert!(
            code.contains(&format!("commands::{module}::{command}")),
            "command `{module}::{command}` must stay registered in lib.rs"
        );
    }
}

#[test]
fn the_retired_pattern_is_read_by_nothing() {
    // ADR-017 §3. `manager_pattern` and the `pattern_*` session columns stay in
    // the schema, because an applied migration never changes, but no code may
    // read them again: a stale read would be a second approval path.
    for (name, source) in [
        ("services/inventory/stock.rs", COSTING_SERVICE),
        ("services/sales/mod.rs", SALES_SERVICE),
        ("services/identity/approval.rs", APPROVAL_SERVICE),
        ("services/identity/auth.rs", AUTH_SERVICE),
        ("data/repositories/identity/session.rs", SESSION_REPO),
        ("domain/identity/session.rs", DOMAIN_SESSION),
        ("domain/identity/mod.rs", DOMAIN_MOD),
    ] {
        let code = code_only(source).to_lowercase();
        for forbidden in [
            "manager_pattern",
            "pattern_approved_at",
            "pattern_epoch",
            "services::pattern",
            "patternapproval",
            "pattern_ttl_ms",
        ] {
            assert!(
                !code.contains(forbidden),
                "{name} still reaches the retired Pattern (`{forbidden}`)"
            );
        }
    }
    assert!(
        !code_only(LIB).contains("commands::pattern"),
        "the Pattern commands are retired and must stay unregistered"
    );
    assert!(
        !code_only(COMMANDS_MOD).contains("mod pattern"),
        "commands/mod.rs must not declare the Pattern module again"
    );
}

#[test]
fn every_sensitive_operation_spends_its_approval_inside_its_transaction() {
    // ADR-017 §3: one approval, one operation. The spend is what makes it one —
    // a service that only checked freshness would let one approval serve
    // every operation for two minutes.
    for (name, source) in [
        ("services/inventory/stock.rs", COSTING_SERVICE),
        ("services/sales/mod.rs", SALES_SERVICE),
    ] {
        let code = code_only(source);
        assert!(
            code.contains("require_sensitivity("),
            "{name} must state each operation's sensitivity"
        );
        assert!(
            code.contains("consume_in_tx(&mut tx,"),
            "{name} must spend the approval it was authorized with, inside its own \
             transaction"
        );
    }

    // The spend is one conditional statement: the exact approval, from a
    // manager who is still active and still holds a PIN.
    let repo = code_only(SESSION_REPO)
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    for condition in [
        "set approved_by = null, approved_at = null where user_id = ?1 and approved_by = ?2 and approved_at = ?3",
        "u.role = 'manager'",
        "u.disabled_at is null",
        "c.pin_verifier is not null",
        "rows_affected() == 1",
    ] {
        assert!(
            repo.contains(condition),
            "consume_owner_approval must keep `{condition}`"
        );
    }

    // The approval service holds no SQL of its own and keeps the lockout
    // shared with sign-in.
    let service = code_only(APPROVAL_SERVICE);
    for required in ["register_failure(", "update_lockout(", "is_locked(", "OWNER_APPROVAL_GRANTED"] {
        assert!(
            service.contains(required),
            "the approval service must keep `{required}`"
        );
    }
}

// ---------------------------------------------------------------------------
// SP-2: the costing contract (ADR-013, spec §10)
//
// The rounding and storage rules are the ones thing a later slice would
// silently break, because every alternative compiles and every alternative
// produces plausible numbers. A piastre lost to a `round()` instead of a
// ceiling does not fail loudly; it just quietly costs the shop money. These
// guards turn the contract into a build failure rather than a code review
// memory.
// ---------------------------------------------------------------------------

const COSTING_MOD: &str = include_str!("../../src/domain/costing/mod.rs");
const COSTING_MOVING_AVERAGE: &str = include_str!("../../src/domain/costing/moving_average.rs");
const COSTING_FIFO: &str = include_str!("../../src/domain/costing/fifo.rs");
const STOCK_MIGRATION: &str = include_str!("../../src/data/migrations/0008_stock_and_cost_layers.sql");
const IMEI_UNITS_MIGRATION: &str =
    include_str!("../../src/data/migrations/0020_imei_units_and_receiving.sql");
const SALE_PAYMENTS_MIGRATION: &str =
    include_str!("../../src/data/migrations/0021_sale_payments_and_customer_ledger.sql");
const SALE_DISCOUNTS_MIGRATION: &str =
    include_str!("../../src/data/migrations/0022_sale_discounts.sql");
const COSTING_SERVICE: &str = include_str!("../../src/services/inventory/stock.rs");
const INVENTORY_COMMANDS: &str = include_str!("../../src/commands/inventory.rs");
const FRONTEND_INVENTORY_API: &str = include_str!("../../../src/api/inventory.ts");
const FRONTEND_STOCK_PANEL: &str = include_str!("../../../src/components/StockPanel.vue");
const FRONTEND_CATEGORIES_CARD: &str =
    include_str!("../../../src/screens/settings/CategoriesCard.vue");
const FRONTEND_SETTINGS_PANEL: &str = include_str!("../../../src/components/SettingsPanel.vue");
const INVENTORY_REPOSITORY: &str =
    include_str!("../../src/data/repositories/inventory/stock.rs");
const SALES_SERVICE: &str = include_str!("../../src/services/sales/mod.rs");

#[test]
fn the_inventory_commands_take_no_session_token_role_or_actor() {
    // The same rule every other command module is held to (`spec:210`, and the
    // existing catalogue and authority guards). Attribution has to be a fact
    // resolved from the credential store, never a value a caller supplies.
    for parameter in ["token:", "role:", "actor:", "assurance:", "user_id:"] {
        assert!(
            !INVENTORY_COMMANDS.contains(parameter),
            "an inventory command must not accept `{parameter}` from a caller"
        );
    }
    assert!(
        INVENTORY_COMMANDS.contains("State<'a, IdentityContext>"),
        "inventory commands must resolve the operator through the shared context"
    );
}

#[test]
fn the_inventory_commands_never_touch_sql() {
    // Transport only. The arithmetic and the transaction belong to the service;
    // a query here would mean the two could disagree about a rule.
    let code = code_only(INVENTORY_COMMANDS);
    for forbidden in ["sqlx::", "SELECT ", "INSERT ", "UPDATE ", "DELETE "] {
        assert!(
            !code.contains(forbidden),
            "commands/inventory.rs must not contain `{forbidden}`: queries live under \
             data/repositories and the rules in services"
        );
    }
}

#[test]
fn a_caller_cannot_choose_how_much_proof_a_movement_needs() {
    // `Sensitivity` decides how much authority an operation needs. If the WebView
    // could pass it, a caller would downgrade a sensitive operation to a routine
    // one by sending the weaker value — a parallel authority path, which the
    // sensitivity module exists to prevent.
    let code = code_only(INVENTORY_COMMANDS);
    assert!(
        !command_parameters(INVENTORY_COMMANDS)
            .iter()
            .any(|name| name.contains("sensitivity")),
        "no command may accept a sensitivity argument"
    );
    assert!(
        code.contains("Sensitivity::Routine"),
        "the service call must state the sensitivity in Rust, not accept it"
    );
}

#[test]
fn the_stock_panel_never_computes_a_cost_of_its_own() {
    // The ceiling rule lives in `domain/costing`. A locally divided average
    // would be a second rounding rule, which is exactly the drift ADR-013 exists
    // to prevent — and it would differ from the figure the sale is snapshotted
    // with.
    let code = code_only(FRONTEND_STOCK_PANEL);
    for forbidden in ["Math.ceil", "round(", "Math.round", "/ onHand", "/ quantity"] {
        assert!(
            !code.contains(forbidden),
            "the panel must render the figure Rust returned, never recompute one \
             (found `{forbidden}`)"
        );
    }
    assert!(
        code.contains("effectiveCostMinor"),
        "the panel must show the derived cost Rust supplied"
    );
}

#[test]
fn the_null_and_zero_cost_distinction_survives_the_boundary() {
    // `null` means the product was never stocked; `0` means free stock. The API
    // type and the panel must both keep them apart, or a missing cost would read
    // as a free one exactly where it matters.
    assert!(
        FRONTEND_INVENTORY_API.contains("totalCostMinor: number | null"),
        "the API type must keep totalCostMinor nullable"
    );
    let panel = code_only(FRONTEND_STOCK_PANEL);
    assert!(
        !panel.contains("position.totalCostMinor || 0"),
        "the panel must not collapse a null total into zero"
    );
}

#[test]
fn the_categories_card_neither_offers_nor_shows_a_costing_method() {
    // Every product counted by quantity is costed by moving average (ADR-016 #7,
    // plan item 1.3). A category's stored method is inert, so showing it would
    // suggest a choice that no longer exists. The card that replaced the
    // departments panel (ADR-018 §1) carries the same guard.
    let card = code_only(FRONTEND_CATEGORIES_CARD);
    for forbidden in [
        "costMethod",
        "cost_method",
        "FIFO",
        "fifo",
        "vatRate",
        "vat_rate",
    ] {
        assert!(
            !card.contains(forbidden),
            "the categories card must not offer or show a costing method or VAT (found `{forbidden}`)"
        );
    }
}

#[test]
fn the_retired_department_commands_stay_retired() {
    // ADR-018 §1: archiving, the full re-order, and editing the inert costing
    // method and VAT left with the departments panel. Registered, they would
    // be reachable from the WebView (there is no command ACL) and could put
    // the tree in states the screens never offer — an archived main with live
    // sub-categories, say.
    let lib = code_only(LIB);
    for gone in [
        "commands::departments::",
        "create_department",
        "update_department",
        "set_department_archived",
        "reorder_departments",
        "list_departments",
        "get_department",
    ] {
        assert!(!lib.contains(gone), "lib.rs must not register `{gone}` again");
    }
    assert!(
        !code_only(COMMANDS_MOD).contains("mod departments"),
        "commands/mod.rs must not bring the department commands back"
    );
}

#[test]
fn a_phone_is_whole_in_storage_and_named_by_the_domain() {
    // ADR-018 §2. Migration 0017 refuses half a phone with triggers, so a
    // write that skips the domain cannot leave a company without a model or a
    // keypad phone with storage; and it only adds.
    let sql = sql_only(BRANDS_MIGRATION);
    for required in [
        "create table brands",
        "create unique index idx_brands_name on brands (name collate nocase)",
        "check (device_type in ('touch', 'keypad', 'both'))",
        "add column brand_id text references brands (id) on delete restrict",
        "create trigger products_phone_details_insert",
        "create trigger products_phone_details_update",
    ] {
        assert!(sql.contains(required), "0017 must keep `{required}`");
    }
    for forbidden in ["drop ", "delete from", "insert into"] {
        assert!(!sql.contains(forbidden), "0017 is additive only: found `{forbidden}`");
    }
    // The name is built in one place, the domain, from the details; the use
    // case checks the company makes that kind of phone and that it is new.
    let domain = code_only(BRAND_DOMAIN);
    for forbidden in ["sqlx", "tauri", "SqlitePool"] {
        assert!(!domain.contains(forbidden), "the brand domain must not reference `{forbidden}`");
    }
    let service = code_only(PHONE_SERVICE);
    for required in [
        "phone_title(",
        "brand_lines(",
        ".allows(input.device_type)",
        "find_phone(",
        "BrandError::CategoryNotPhone",
        "set_phone_details(",
        "tx.commit()",
    ] {
        assert!(service.contains(required), "registering a phone must keep `{required}`");
    }
    let brands = code_only(BRANDS_SERVICE);
    for required in [
        "Permission::ManageCatalog",
        "can_delete_brand(",
        "audit::event::BRAND_CREATED",
        "audit::event::BRAND_UPDATED",
        "audit::event::BRAND_DELETED",
        "audit::event::DEFAULT_BRANDS_ADDED",
    ] {
        assert!(brands.contains(required), "the brand use cases must keep `{required}`");
    }
}

#[test]
fn product_variants_are_whole_in_storage_and_named_by_the_domain() {
    // ADR-018 §4. Migration 0018 keeps variant details all-or-nothing with
    // triggers, refuses a phone that is also a variant, and only adds.
    let sql = sql_only(VARIANTS_MIGRATION);
    for required in [
        "create table product_parents",
        "create unique index idx_product_parents_category_name",
        "on product_parents (department_id, name collate nocase)",
        "add column parent_id text references product_parents (id) on delete restrict",
        "create trigger products_variant_details_insert",
        "create trigger products_variant_details_update",
    ] {

        assert!(sql.contains(required), "0018 must keep `{required}`");
    }
    for forbidden in ["drop ", "delete from", "insert into"] {
        assert!(!sql.contains(forbidden), "0018 is additive only: found `{forbidden}`");
    }
    let domain = code_only(VARIANT_DOMAIN);
    for forbidden in ["sqlx", "tauri", "SqlitePool"] {
        assert!(
            !domain.contains(forbidden),
            "the variant domain must not reference `{forbidden}`"
        );
    }
    let service = code_only(VARIANTS_SERVICE);
    for required in [
        "variant_combos(",
        "variant_title(",
        "VariantError::CategoryNotItem",
        "parent_name_taken(",
        "insert_parent(",
        "set_variant_details(",
        "audit::event::VARIANTS_CREATED",
        "tx.commit()",
    ] {
        assert!(
            service.contains(required),
            "registering variants must keep `{required}`"
        );
    }
}

#[test]
fn product_images_store_external_192_jpeg_files_never_database_blobs() {
    // ADR-018 §5 and XC-10: `0019_product_images.sql` records only the relative
    // file path under `images/` and the verified 192×192 dimensions and byte
    // length, never raw image bytes.
    let sql = sql_only(IMAGES_MIGRATION);
    for required in [
        "create table product_images",
        "product_id text    primary key references products (id) on delete restrict",
        "and file glob 'images/[0-9a-fa-f-]*.jpg'",
        "check (w = 192)",
        "check (h = 192)",
        "check (bytes > 0 and bytes <= 65536)",
    ] {
        assert!(sql.contains(required), "0019 must keep `{required}`");
    }
    for forbidden in ["blob", "drop ", "delete from", "insert into"] {
        assert!(
            !sql.contains(forbidden),
            "0019 must stay additive and free of BLOB columns: found `{forbidden}`"
        );
    }
    let domain = code_only(IMAGE_DOMAIN);
    for forbidden in ["sqlx", "tauri", "SqlitePool"] {
        assert!(
            !domain.contains(forbidden),
            "the image domain must not reference `{forbidden}`"
        );
    }
    let service = code_only(IMAGES_SERVICE);
    for required in [
        "ProductImage::from_data_url(",
        "image_repo::upsert(",
        "image_repo::delete(",
        "audit::event::PRODUCT_IMAGE_SET",
        "audit::event::PRODUCT_IMAGE_REMOVED",
        "tx.commit()",
    ] {
        assert!(
            service.contains(required),
            "the image use cases must keep `{required}`"
        );
    }
    let lib = code_only(LIB);
    for command in [
        "commands::catalog::list_product_images",
        "commands::catalog::set_product_image",
        "commands::catalog::remove_product_image",
        "commands::catalog::get_shop_logo",
        "commands::catalog::set_shop_logo",
        "commands::catalog::remove_shop_logo",
    ] {
        assert!(
            lib.contains(command),
            "lib.rs must register `{command}`"
        );
    }
}



#[test]
fn the_category_tree_is_two_levels_deep_in_storage_too() {
    // The domain refuses a third level and a sub-category of another kind;
    // migration 0016 refuses them again with triggers, so a write that skips
    // the domain cannot break the tree either.
    let sql = sql_only(CATEGORY_TREE_MIGRATION);
    for required in [
        "create trigger departments_tree_two_levels_insert",
        "create trigger departments_tree_two_levels_update",
        "create trigger departments_tree_kind_insert",
        "create trigger departments_tree_kind_update",
        "check (kind in ('item', 'phone', 'used'))",
        "references departments (id) on delete restrict",
    ] {
        assert!(sql.contains(required), "0016 must keep `{required}`");
    }
    for forbidden in ["drop ", "delete from", "update departments set"] {
        assert!(!sql.contains(forbidden), "0016 is additive only: found `{forbidden}`");
    }
    // The use cases read and write through the repository, and every change
    // writes its audit row.
    let service = code_only(CATEGORIES_SERVICE);
    for required in [
        "audit::event::DEPARTMENT_CREATED",
        "audit::event::DEPARTMENT_UPDATED",
        "audit::event::DEPARTMENT_DELETED",
        "audit::event::DEFAULT_CATEGORIES_ADDED",
        "Permission::ManageDepartments",
        "can_delete(",
        "serde_json::json!",
    ] {
        assert!(service.contains(required), "the category use cases must keep `{required}`");
    }
}

#[test]
fn fifo_and_the_method_switch_are_retired_from_every_path() {
    // Plan item 1.3: FIFO and switching the costing method are removed from the
    // services and the screens. Legacy layers are only read and collapsed, never
    // written, and no command or screen can bring either back.
    let lib = code_only(LIB);
    assert!(
        !lib.contains("switch_cost_method"),
        "switch_cost_method must not be registered"
    );
    for (name, source) in [
        ("commands/inventory.rs", INVENTORY_COMMANDS),
        ("services/inventory/stock.rs", COSTING_SERVICE),
        ("services/sales/mod.rs", SALES_SERVICE),
    ] {
        let code = code_only(source);
        for forbidden in [
            "switch_cost_method",
            "insert_layer",
            "update_layer_quantity",
            "CostMethod::Fifo",
            "resolve_cost_method",
        ] {
            assert!(
                !code.contains(forbidden),
                "{name} must not contain `{forbidden}`: FIFO is retired (plan 1.3)"
            );
        }
    }
    let repository = sql_only(INVENTORY_REPOSITORY);
    for forbidden in ["insert into fifo_layers", "update fifo_layers"] {
        assert!(
            !repository.contains(forbidden),
            "the stock repository must never write a FIFO layer again (found `{forbidden}`)"
        );
    }
    for (name, source) in [
        ("src/api/inventory.ts", FRONTEND_INVENTORY_API),
        ("src/components/StockPanel.vue", FRONTEND_STOCK_PANEL),
        ("src/components/SettingsPanel.vue", FRONTEND_SETTINGS_PANEL),
    ] {
        let code = code_only(source);
        for forbidden in ["switch_cost_method", "switchCostMethod", "'fifo'", "FIFO"] {
            assert!(
                !code.contains(forbidden),
                "{name} must not offer FIFO or the method switch (found `{forbidden}`)"
            );
        }
    }
    assert!(
        code_only(COSTING_SERVICE).contains("collapse_legacy_in_tx"),
        "legacy FIFO positions must be collapsed into the moving average on first touch"
    );
}

#[test]
fn every_inventory_error_code_has_an_arabic_message() {
    // The bidirectional guard covers domain error codes. The service introduced
    // two more (`STOCK_*`) and the frontend message table must carry both, or an
    // operator sees the generic fallback for a genuine data defect.
    for code in ["STOCK_PRODUCT_NOT_FOUND", "STOCK_COST_AUTHORITY_CONFLICT"] {
        assert!(
            COSTING_SERVICE.contains(&format!("\"{code}\"")),
            "the service is expected to emit `{code}`; the guard's scan is broken"
        );
        assert!(
            FRONTEND_ERRORS.contains(&format!("{code}:")),
            "Rust emits `{code}` but src/api/errors.ts declares no code for it"
        );
    }
}

#[test]
fn the_stock_schema_stays_one_counter_per_product_and_opens_no_location() {
    // D2, restated where the stock tables actually appear. `ADR-012` decided
    // that `stock_levels` is keyed by `product_id` alone and that a department
    // classifies a product rather than locating it, but that decision was
    // recorded while no stock table existed. `0008` is the migration that creates
    // one, so it is the file where the question could be quietly reopened — by a
    // `location_id` column, or by a composite key that reintroduces the per-site
    // stock the ADR rejected as never requested.
    let sql = sql_only(STOCK_MIGRATION);
    for forbidden in [
        "location",
        "warehouse",
        "branch",
        "stockroom",
        "shelf",
        "bin",
        "aisle",
    ] {
        assert!(
            !sql.contains(forbidden),
            "0008 must not mention `{forbidden}`: V1 has one stock counter per \
             product and no physical place (ADR-012)"
        );
    }

    // Two tables, so two primary keys. The invariant is not "one key" but "no
    // composite key": `stock_levels` is keyed by the product alone and
    // `fifo_layers` by its own id, and neither key may grow a second column that
    // reintroduces the per-site stock ADR-012 refused.
    //
    // `sql_only` lowercases and strips `--` comments, so keywords are compared
    // in lower case.
    assert_eq!(
        sql.matches("primary key").count(),
        2,
        "0008 declares two tables and each takes exactly one primary key"
    );
    for forbidden in [
        "primary key (product_id,",
        "primary key (product_id ,",
        "primary key (product_id, location",
    ] {
        assert!(
            !sql.contains(forbidden),
            "`{forbidden}` would reintroduce per-site stock that ADR-012 refused"
        );
    }
    assert!(
        sql.contains("product_id") && sql.contains("references products (id)"),
        "stock_levels must be keyed by product_id alone (ADR-012)"
    );
}

#[test]
fn the_imei_units_migration_enforces_15_digits_and_opening_stock_rules() {
    // ADR-019 (plan item 1.4): 15-digit IMEIs, non-negative integer costs,
    // tracking modes on products, and opening-stock receipts that cannot name
    // a supplier.
    let sql = sql_only(IMEI_UNITS_MIGRATION);
    for required in [
        "check (tracking in ('none', 'serial_optional', 'serial_required'))",
        "check (receipt_kind is null or receipt_kind in ('supplier', 'opening'))",
        "when new.receipt_kind = 'opening' and new.supplier_name is not null",
        "create table units",
        "length(imei) = 15",
        "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]",
        "unit_cost_minor      integer not null check (unit_cost_minor >= 0)",
        "check (status in ('in_stock', 'sold', 'retired'))",
        "alter table sale_lines add column unit_id text null",
    ] {
        assert!(
            sql.contains(required),
            "0020_imei_units_and_receiving.sql must contain `{required}`"
        );
    }
}

#[test]
fn the_sale_payments_migration_enforces_append_only_and_credit_customer_rules() {
    // ADR-020 (plan item 1.5): sale_payments and customer_ledger are append-only,
    // money is integer minor units, and credit payments require a linked customer.
    let sql = sql_only(SALE_PAYMENTS_MIGRATION);
    for required in [
        "create table sale_payments (",
        "check (method in ('cash', 'vf', 'instapay', 'card', 'install', 'credit'))",
        "amount_minor  integer not null check (amount_minor >= 0)",
        "create trigger sale_payments_credit_requires_customer",
        "create trigger sale_payments_no_update",
        "create trigger sale_payments_no_delete",
        "create table customer_ledger (",
        "check (kind in ('credit_sale', 'payment', 'sale_reversal'))",
        "create trigger customer_ledger_no_update",
        "create trigger customer_ledger_no_delete",
    ] {
        assert!(
            sql.contains(required),
            "0021_sale_payments_and_customer_ledger.sql must contain `{required}`"
        );
    }
}

#[test]
fn the_sale_discounts_migration_enforces_non_negative_discounts_and_net_line_totals() {
    // ADR-021 (plan item 1.6): discounts are integer minor units >= 0, and
    // each line's net total equals (quantity * unit_selling_price_minor) - discount_minor.
    let sql = sql_only(SALE_DISCOUNTS_MIGRATION);
    for required in [
        "alter table sales",
        "add column discount_minor integer not null default 0 check (discount_minor >= 0)",
        "add column approved_by text references users (id)",
        "alter table sale_lines",
        "create trigger sale_lines_discount_within_gross",
        "new.line_total_minor != (new.quantity * new.unit_selling_price_minor) - new.discount_minor",
    ] {
        assert!(
            sql.contains(required),
            "0022_sale_discounts.sql must contain `{required}`"
        );
    }
}

#[test]
fn the_stock_schema_keeps_money_and_quantities_integer_and_never_negative() {
    // `spec:56` and ADR-010: an integer count of piastres, never a float. And
    // the one state a costing bug must never be able to write is a negative
    // balance, so the CHECK belongs in the schema rather than only in Rust.
    let sql = sql_only(STOCK_MIGRATION);
    assert!(
        sql.contains("quantity >= 0"),
        "a negative balance must be impossible at the storage layer"
    );
    assert!(
        sql.contains("total_cost_minor >= 0"),
        "a negative total cost must be impossible at the storage layer"
    );
    assert!(
        sql.contains("quantity > 0"),
        "a spent FIFO layer must be deleted, not kept at zero"
    );
    for forbidden in ["real", "float", "double", "numeric"] {
        assert!(
            !sql.contains(forbidden),
            "0008 must not declare `{forbidden}`: money is an integer minor unit"
        );
    }
}

#[test]
fn the_costing_service_runs_each_operation_in_one_transaction() {
    // The atomicity claim is the point of the slice: a balance, its layers and
    // its audit event move together or not at all. Asserting that each public
    // operation opens a transaction and commits one is the cheapest way to stop
    // a later slice from adding a fourth write outside it.
    for operation in ["receive", "remove"] {
        let start = COSTING_SERVICE
            .find(&format!("pub async fn {operation}("))
            .unwrap_or_else(|| panic!("`{operation}` must be a public use case"));
        let body = &COSTING_SERVICE[start..];
        assert!(
            body.contains("pool.begin()"),
            "{operation} must open one transaction"
        );
        assert!(
            body.contains("tx.commit()"),
            "{operation} must commit that transaction"
        );
    }
}

#[test]
fn the_costing_service_never_writes_sql() {
    // Services orchestrate; repositories own queries (`spec:99`, and the same
    // rule the catalogue and authority services are held to). One read is
    // declared and narrow: the product-existence check, so an unknown product is
    // refused before anything else is read. The costing-method update the
    // retired switch needed is gone with it (plan item 1.3).
    let code = code_only(COSTING_SERVICE);
    let statements = code.matches("sqlx::query").count();
    assert!(
        statements <= 1,
        "the costing service runs {statements} statements; queries belong in \
         data/repositories (only the product-existence check belongs here)"
    );
}

#[test]
fn the_costing_service_never_resolves_a_session_from_a_caller() {
    // Same rule as every other service: no token, role or assurance level is
    // accepted from outside. Resolution goes through the shared helper.
    let code = code_only(COSTING_SERVICE);
    for parameter in ["token:", "role:", "actor:", "assurance:"] {
        assert!(
            !code.contains(parameter),
            "the costing service must not accept `{parameter}` from a caller"
        );
    }
    assert!(
        code.contains("identity_session::resolve"),
        "the session must come from the shared resolver"
    );
}

#[test]
fn the_costing_module_never_uses_a_float() {
    // spec:56 and ADR-010: money is an integer count of piastres. A float cannot
    // represent 0.01 EGP, so any float in this path is a silent accuracy bug
    // wearing the costume of a rounding decision.
    for (name, source) in [
        ("costing/mod.rs", COSTING_MOD),
        ("costing/moving_average.rs", COSTING_MOVING_AVERAGE),
        ("costing/fifo.rs", COSTING_FIFO),
    ] {
        let code = code_only(source);
        for forbidden in ["f32", "f64", "REAL", "floating"] {
            assert!(
                !code.contains(forbidden),
                "{name} must not mention `{forbidden}`: money is integer piastres (spec:56)"
            );
        }
    }
}

#[test]
fn the_costing_module_offers_no_alternative_rounding_rule() {
    // Nearest, half-up and banker's rounding are all named rejections in
    // ADR-013. Naming them again here means a future contributor cannot add one
    // and call it a local optimisation: the ceiling is the only rounding rule
    // this codebase has for money.
    for (name, source) in [
        ("costing/mod.rs", COSTING_MOD),
        ("costing/moving_average.rs", COSTING_MOVING_AVERAGE),
        ("costing/fifo.rs", COSTING_FIFO),
    ] {
        let code = code_only(source);
        for forbidden in ["round()", ".round(", "banker", "half_up", "nearest"] {
            assert!(
                !code.contains(forbidden),
                "{name} must not contain `{forbidden}`: ADR-013 approves ceiling rounding only"
            );
        }
    }
}

#[test]
fn the_costing_module_carries_no_remainder_column() {
    // ADR-013 proves the remainder is always zero under ceiling rounding and
    // rejects the column. A stored remainder would reintroduce exactly the
    // fractional persisted state `spec` §10 forbids.
    //
    // Scoped to declarations, not the whole word: the documentation must be able
    // to explain the rejection, and a test may legitimately be named after what
    // it proves. What must not exist is a *field* or *parameter* that carries a
    // remainder.
    for (name, source) in [
        ("costing/mod.rs", COSTING_MOD),
        ("costing/moving_average.rs", COSTING_MOVING_AVERAGE),
        ("costing/fifo.rs", COSTING_FIFO),
    ] {
        let code = code_only(source);
        for forbidden in [
            "remainder:",
            "remainder :",
            "_remainder:",
            "remainder_minor:",
            "cost_remainder_minor",
            "residual:",
        ] {
            assert!(
                !code.contains(forbidden),
                "{name} must not declare `{forbidden}`: ADR-013 proves no remainder is needed"
            );
        }
    }
}

#[test]
fn the_costing_arithmetic_computes_its_intermediates_in_i128() {
    // `units × total_cost_minor` overflows i64 at plausible volumes, so the
    // contract is not "careful coding" but a wider type. Asserting the product
    // goes through `i128::from` keeps a refactor from quietly widening nothing.
    let code = code_only(COSTING_MOVING_AVERAGE);
    assert!(
        code.contains("i128"),
        "moving_average must compute intermediates in i128 (ADR-013 \"i128 للوسائط\")"
    );
}

#[test]
fn the_costing_module_knows_no_infrastructure() {
    // domain/ is the layer that knows no Tauri, no SQLx, no SQLite and no
    // platform (spec:99). Costing is arithmetic, so the cheapest way to keep it
    // arithmetic is to refuse every one of those names at build time.
    let code = format!("{COSTING_MOD}{COSTING_MOVING_AVERAGE}{COSTING_FIFO}");
    for forbidden in ["sqlx", "SqlitePool", "tauri", "invoke", "Transaction"] {
        assert!(
            !code.contains(forbidden),
            "domain/costing must not mention `{forbidden}`: the domain knows no infrastructure"
        );
    }
}

#[test]
fn the_costing_module_does_not_redefine_the_cost_method_vocabulary() {
    // `CostMethod` already lives in domain/organisation beside the department
    // that owns the setting. A second spelling is the drift domain/mod.rs
    // forbids, and two enums that both parse "fifo" would eventually disagree
    // on what one stored string means.
    assert!(
        !COSTING_MOD.contains("enum CostMethod"),
        "CostMethod is defined once in domain/organisation; costing must import it, not redefine it"
    );
    assert!(
        COSTING_MOD.contains("pub use crate::domain::organisation::CostMethod"),
        "costing must re-export the shared CostMethod so callers have one name"
    );
}

#[test]
fn every_costing_error_code_is_declared_and_has_an_arabic_message() {
    // Mirrors the existing bidirectional guard for domain error codes: a code
    // Rust can emit but the operator cannot read is a blank error message at
    // best, and a machine code shown to a shop owner at worst.
    let code = format!("{COSTING_MOD}{COSTING_MOVING_AVERAGE}{COSTING_FIFO}");
    let mut codes = Vec::new();
    let mut rest = code.as_str();
    while let Some(index) = rest.find("\"COST_") {
        rest = &rest[index + 1..];
        let end = rest
            .find('"')
            .expect("a COST_ code literal must close");
        codes.push(&rest[..end]);
        rest = &rest[end + 1..];
    }
    assert!(
        !codes.is_empty(),
        "costing must emit COST_* codes; the scan found none, so the guard is broken"
    );
    for code in &codes {
        assert!(
            FRONTEND_ERRORS.contains(&format!("{code}:")),
            "Rust emits `{code}` but src/api/errors.ts declares no code for it"
        );
    }
}

// ---------------------------------------------------------------------------
// The recovery code (ADR-017 §4), and the retired `recovery` build (plan R1)
// ---------------------------------------------------------------------------

const CARGO_MANIFEST: &str = include_str!("../../Cargo.toml");
const RECOVERY_CODE_SERVICE: &str = include_str!("../../src/services/identity/recovery_code.rs");
const FRONTEND_RECOVER_PASSWORD: &str = include_str!("../../../src/shell/RecoverPassword.vue");
const FRONTEND_RECOVERY_CODE_SHOW: &str = include_str!("../../../src/shell/RecoveryCodeShow.vue");
const FRONTEND_RECOVERY_CODE_CARD: &str =
    include_str!("../../../src/screens/settings/RecoveryCodeCard.vue");

#[test]
fn the_retired_recovery_build_stays_retired() {
    // ADR-017 §4 retired the `recovery` cargo feature and its supervised
    // single-use path. Its tables (0009, 0010) stay, inert, because applied
    // migrations never change; the flag, its commands and the panel behind
    // VITE_RECOVERY may not come back.
    let manifest: String = CARGO_MANIFEST
        .lines()
        .map(|line| line.split('#').next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !manifest.contains("recovery ="),
        "Cargo.toml must not declare the `recovery` feature again"
    );
    let lib = code_only(LIB);
    for gone in [
        "feature = \"recovery\"",
        "commands::recovery::",
        "stage_recovery_approval",
        "execute_manager_recovery",
    ] {
        assert!(!lib.contains(gone), "lib.rs must not carry `{gone}` again");
    }
    assert!(
        !code_only(COMMANDS_MOD).contains("mod recovery"),
        "commands/mod.rs must not declare the retired recovery module"
    );
    for gone in ["VITE_RECOVERY", "RecoveryPanel"] {
        assert!(
            !FRONTEND_APP.contains(gone),
            "App.vue must not bring back `{gone}`"
        );
    }
}

#[test]
fn the_recovery_code_commands_stay_registered() {
    // Registration is what makes them reachable; an unregistered command
    // compiles, passes its tests and silently does not exist for the owner.
    let lib = code_only(LIB);
    for command in [
        "commands::identity::recover_password_with_code",
        "commands::identity_lifecycle::create_recovery_code",
        "commands::identity_lifecycle::recovery_code_status",
    ] {
        assert!(
            lib.contains(command),
            "`{command}` must stay registered in lib.rs"
        );
    }
}

#[test]
fn the_recovery_code_comes_from_the_os_generator_and_is_kept_only_as_a_verifier() {
    // The code is shown once and never kept: what is stored is its Argon2id
    // verifier, drawn from the same CSPRNG as the session token. The service
    // holds no SQL of its own, and a wrong code advances the shared lockout.
    let service = code_only(RECOVERY_CODE_SERVICE);
    for required in [
        "crypto::generate_recovery_code()",
        "crypto::hash_password(&code)",
        "set_recovery_verifier(",
        "register_failure(",
        "update_lockout(",
        "delete_all(",
    ] {
        assert!(
            service.contains(required),
            "the recovery-code service must keep `{required}`"
        );
    }
    assert!(
        !service.contains("sqlx::query"),
        "queries belong in the repository layer, not in the recovery-code use case"
    );
    // No audit detail is built from a secret.
    for secret in ["{code}", "{next_code}", "{new_password}", "{current_password}", "{normalized}"] {
        assert!(
            !service.contains(secret),
            "the recovery-code service must never format `{secret}` into text"
        );
    }
}

#[test]
fn the_recovery_screens_keep_nothing_copy_nothing_and_open_no_channel() {
    // The guards of the retired panel, carried over to the screens that
    // replaced it. The code belongs on paper: never stored in the WebView,
    // never put on the clipboard. Each attempt is one press, never a timed
    // retry. And the path is driven by a person at the device — no deep link,
    // URI scheme or external opener.
    for (name, source) in [
        ("shell/RecoverPassword.vue", FRONTEND_RECOVER_PASSWORD),
        ("shell/RecoveryCodeShow.vue", FRONTEND_RECOVERY_CODE_SHOW),
        ("screens/settings/RecoveryCodeCard.vue", FRONTEND_RECOVERY_CODE_CARD),
    ] {
        for banned in [
            "localStorage",
            "sessionStorage",
            "indexedDB",
            "document.cookie",
            "clipboard",
            "setTimeout",
            "setInterval",
            "deep-link",
            "deeplink",
            "register_uri_scheme",
            "tauri://",
            "invoke('open",
            "window.open",
        ] {
            assert!(
                !source.contains(banned),
                "{name} must not contain `{banned}`"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// The strongest claim is checked on the artifact, not on the spelling of a
// source file: whatever is in `dist/` is what a build would ship.
// ---------------------------------------------------------------------------

#[test]
fn a_built_bundle_carries_no_recovery_call() {
    // The retired `recovery` build must never be what sits in `dist/`: its
    // panel and its two commands are gone from the sources, and this reads the
    // built output to prove no stale bundle still carries them.
    //
    // It skips when there is no bundle, because `dist/` is a build artefact and
    // is gitignored.
    let assets = std::path::Path::new("../dist/assets");
    let Ok(entries) = std::fs::read_dir(assets) else {
        eprintln!("no dist/assets to inspect; skipping the built-bundle check");
        return;
    };

    let mut inspected = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_bundle = path
            .extension()
            .map(|ext| ext == "js")
            .unwrap_or(false);
        if !is_bundle {
            continue;
        }
        inspected += 1;
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        assert!(
            !name.contains("RecoveryPanel"),
            "dist/assets/{name} is the retired recovery panel: re-run the production \
             build (`npm run build`)."
        );
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        for marker in ["stage_recovery_approval", "execute_manager_recovery"] {
            assert!(
                !contents.contains(marker),
                "dist/assets/{name} calls the retired `{marker}`: re-run the production \
                 build (`npm run build`)."
            );
        }
    }

    if inspected == 0 {
        eprintln!("dist/assets held no JavaScript bundle; nothing to inspect");
        return;
    }

    if let Ok(index) = std::fs::read_to_string(std::path::Path::new("../dist/index.html")) {
        assert!(
            !index.contains("RecoveryPanel"),
            "dist/index.html references the retired recovery panel: re-run the \
             production build."
        );
    }
}

const SHIFTS_MIGRATION: &str =
    include_str!("../../src/data/migrations/0023_shifts_and_expenses.sql");
const SHIFT_DOMAIN: &str = include_str!("../../src/domain/shift.rs");
const SHIFT_SERVICE: &str = include_str!("../../src/services/shift.rs");
const SHIFT_COMMANDS: &str = include_str!("../../src/commands/shift.rs");

#[test]
fn shift_slice_preserves_layer_and_schema_invariants() {
    let sql = sql_only(SHIFTS_MIGRATION);
    for required in [
        "create table shifts",
        "create unique index idx_shifts_single_open on shifts (status) where status = 'open'",
        "create trigger shifts_immutable_once_closed",
        "create table expenses",
        "create trigger expenses_require_open_shift",
        "create table cash_movements",
        "create trigger cash_movements_require_open_shift",
    ] {
        assert!(
            sql.contains(required),
            "0023_shifts_and_expenses.sql must contain `{required}`"
        );
    }

    let domain = code_only(SHIFT_DOMAIN);
    for forbidden in ["tauri", "sqlx", "SqlitePool", "keyring"] {
        assert!(
            !domain.contains(forbidden),
            "domain/shift.rs must not reference `{forbidden}`"
        );
    }

    let service = code_only(SHIFT_SERVICE);
    for forbidden in ["sqlx::query", "SELECT ", "INSERT ", "UPDATE ", "DELETE "] {
        assert!(
            !service.contains(forbidden),
            "services/shift.rs must delegate SQL to repositories (`{forbidden}`)"
        );
    }

    let commands = code_only(SHIFT_COMMANDS);
    let params = command_parameters(&commands);
    for forbidden in [
        "token",
        "user_id",
        "userid",
        "role",
        "created_by",
        "updated_by",
        "actor",
        "assurance",
        "session",
    ] {
        assert!(
            !params.iter().any(|p| p == forbidden),
            "commands/shift.rs must not accept `{forbidden}`; found {params:?}"
        );
    }
}

const WALLETS_MIGRATION: &str =
    include_str!("../../src/data/migrations/0024_wallets_and_services.sql");
const WALLET_DOMAIN: &str = include_str!("../../src/domain/wallet.rs");
const WALLET_SERVICE: &str = include_str!("../../src/services/wallet.rs");
const WALLET_COMMANDS: &str = include_str!("../../src/commands/wallet.rs");

#[test]
fn wallet_slice_preserves_layer_and_schema_invariants() {
    let sql = sql_only(WALLETS_MIGRATION);
    for required in [
        "create table wallets",
        "create unique index idx_wallets_pay_method on wallets(pay_method) where pay_method is not null",
        "create table wallet_ops",
        "create trigger wallets_no_delete_default_or_used",
        "create trigger wallet_ops_no_delete",
        "create trigger wallet_ops_only_void_transition",
    ] {
        assert!(
            sql.contains(required),
            "0024_wallets_and_services.sql must contain `{required}`"
        );
    }

    let domain = code_only(WALLET_DOMAIN);
    for forbidden in ["tauri", "sqlx", "SqlitePool", "keyring"] {
        assert!(
            !domain.contains(forbidden),
            "domain/wallet.rs must not reference `{forbidden}`"
        );
    }

    let service = code_only(WALLET_SERVICE);
    for forbidden in ["sqlx::query", "SELECT ", "INSERT ", "UPDATE ", "DELETE "] {
        assert!(
            !service.contains(forbidden),
            "services/wallet.rs must delegate SQL to repositories (`{forbidden}`)"
        );
    }

    let commands = code_only(WALLET_COMMANDS);
    let params = command_parameters(&commands);
    for forbidden in [
        "token",
        "user_id",
        "userid",
        "role",
        "created_by",
        "updated_by",
        "actor",
        "assurance",
        "session",
    ] {
        assert!(
            !params.iter().any(|p| p == forbidden),
            "commands/wallet.rs must not accept `{forbidden}`; found {params:?}"
        );
    }

    let lib = code_only(LIB);
    for command in [
        "commands::wallet::wallets_overview",
        "commands::wallet::record_wallet_op",
        "commands::wallet::record_service_op",
        "commands::wallet::record_wallet_movement",
        "commands::wallet::reconcile_wallet",
        "commands::wallet::void_wallet_op",
        "commands::wallet::create_wallet",
        "commands::wallet::update_wallet",
        "commands::wallet::delete_wallet",
    ] {
        assert!(lib.contains(command), "lib.rs must register `{command}`");
    }
}

const PARTIAL_RETURNS_MIGRATION: &str =
    include_str!("../../src/data/migrations/0025_partial_returns_and_damaged_stock.sql");
const SALES_COMMANDS: &str = include_str!("../../src/commands/sales.rs");

#[test]
fn partial_returns_and_damaged_stock_slice_preserves_layer_and_schema_invariants() {
    let sql = sql_only(PARTIAL_RETURNS_MIGRATION);
    for required in [
        "add column reverses_line_id text null references sale_lines (id) on delete restrict",
        "add column return_condition text null check (return_condition is null or return_condition in ('intact', 'damaged'))",
        "create table sale_returns (",
        "create trigger sale_returns_no_update",
        "create trigger sale_returns_no_delete",
        "create table damaged_stock (",
        "create trigger damaged_stock_no_update",
        "create trigger damaged_stock_no_delete",
    ] {
        assert!(
            sql.contains(required),
            "0025_partial_returns_and_damaged_stock.sql must contain `{required}`"
        );
    }

    let commands = code_only(SALES_COMMANDS);
    let params = command_parameters(&commands);
    for forbidden in [
        "token",
        "user_id",
        "userid",
        "role",
        "created_by",
        "updated_by",
        "actor",
        "assurance",
        "session",
        "sensitivity",
    ] {
        assert!(
            !params.iter().any(|p| p == forbidden),
            "commands/sales.rs must not accept `{forbidden}`; found {params:?}"
        );
    }

    let lib = code_only(LIB);
    for command in [
        "commands::sales::inspect_sale_for_return",
        "commands::sales::list_recent_sales_for_return",
        "commands::sales::record_sale_return",
        "commands::sales::record_sale_exchange",
        "commands::sales::list_damaged_stock",
        "commands::sales::list_sales_history",
    ] {
        assert!(lib.contains(command), "lib.rs must register `{command}`");
    }
}

const BACKUP_POLICY_DOMAIN: &str = include_str!("../../src/domain/backup/policy.rs");
const BACKUP_AUTO_SERVICE: &str = include_str!("../../src/services/backup/auto.rs");
const BACKUP_COMMANDS: &str = include_str!("../../src/commands/backup.rs");

#[test]
fn automatic_backup_policy_slice_preserves_layer_invariants() {
    let domain = code_only(BACKUP_POLICY_DOMAIN);
    for forbidden in ["tauri", "sqlx", "SqlitePool", "keyring", "std::fs"] {
        assert!(
            !domain.contains(forbidden),
            "domain/backup/policy.rs must not reference `{forbidden}`"
        );
    }

    let service = code_only(BACKUP_AUTO_SERVICE);
    for forbidden in ["sqlx::query", "SELECT ", "INSERT ", "UPDATE ", "DELETE "] {
        assert!(
            !service.contains(forbidden),
            "services/backup/auto.rs must delegate SQL to repositories (`{forbidden}`)"
        );
    }

    let commands = code_only(BACKUP_COMMANDS);
    let params = command_parameters(&commands);
    for forbidden in [
        "token",
        "user_id",
        "userid",
        "role",
        "created_by",
        "updated_by",
        "actor",
        "assurance",
        "session",
        "sensitivity",
    ] {
        assert!(
            !params.iter().any(|p| p == forbidden),
            "commands/backup.rs must not accept `{forbidden}`; found {params:?}"
        );
    }

    let lib = code_only(LIB);
    for command in [
        "commands::backup::create_backup",
        "commands::backup::restore_backup",
        "commands::backup::list_saved_backups",
        "commands::backup::create_auto_backup_now",
        "commands::backup::copy_latest_backup_to_usb",
        "commands::backup::restore_saved_backup",
        "commands::backup::run_periodic_backup_tick",
    ] {
        assert!(lib.contains(command), "lib.rs must register `{command}`");
    }
}

const SETTINGS_SCREEN_VUE: &str =
    include_str!("../../../src/screens/settings/SettingsScreen.vue");
const SETTINGS_TABS_TS: &str = include_str!("../../../src/screens/settings/tabs.ts");
const DEVICES_PRINTER_CARD_VUE: &str =
    include_str!("../../../src/screens/settings/DevicesPrinterCard.vue");

#[test]
fn eight_settings_screens_slice_preserves_tab_and_printer_invariants() {
    for tab in [
        "'shop'",
        "'look'",
        "'catalog'",
        "'users'",
        "'pay'",
        "'receipt'",
        "'backup'",
        "'devices'",
    ] {
        assert!(
            SETTINGS_TABS_TS.contains(tab),
            "src/screens/settings/tabs.ts must declare settings tab {tab}"
        );
        assert!(
            SETTINGS_SCREEN_VUE.contains(tab),
            "src/screens/settings/SettingsScreen.vue must wire settings section {tab}"
        );
    }

    assert!(
        DEVICES_PRINTER_CARD_VUE.contains("عندي طابعة إيصالات"),
        "DevicesPrinterCard.vue must include «عندي طابعة إيصالات» toggle"
    );
}

const SALES_SCREEN_VUE: &str = include_str!("../../../src/screens/sales/SalesScreen.vue");
const SALES_ANALYTICS_TS: &str = include_str!("../../../src/screens/sales/analytics.ts");
const SHELL_NAV_TS: &str = include_str!("../../../src/shell/nav.ts");

#[test]
fn sales_history_screen_slice_preserves_layer_and_permission_invariants() {
    for view in ["'inv'", "'day'", "'prod'", "'cat'"] {
        assert!(
            SALES_ANALYTICS_TS.contains(view),
            "src/screens/sales/analytics.ts must declare sales view {view}"
        );
    }

    for marker in [
        "كل مبيعات المحل",
        "مبيعاتك انت بس",
        "ابعت الإيصال تاني واتساب",
        "إلغاء الفاتورة",
        "تصدير Excel",
    ] {
        assert!(
            SALES_SCREEN_VUE.contains(marker),
            "src/screens/sales/SalesScreen.vue must include `{marker}`"
        );
    }

    assert!(
        SHELL_NAV_TS.contains("id: 'sales', label: 'المبيعات', icon: 'receipt-text', ownerOnly: false"),
        "src/shell/nav.ts must expose «المبيعات» to both owner and seller (`ownerOnly: false`)"
    );
}

const SHORTAGES_MIGRATION: &str =
    include_str!("../../src/data/migrations/0026_shortages.sql");
const SHORTAGE_DOMAIN: &str = include_str!("../../src/domain/shortage.rs");
const SHORTAGE_SERVICE: &str = include_str!("../../src/services/shortage.rs");
const SHORTAGE_COMMANDS: &str = include_str!("../../src/commands/shortage.rs");
const SHORTAGES_PANEL_VUE: &str =
    include_str!("../../../src/screens/store/ShortagesPanel.vue");
const STORE_SCREEN_VUE: &str = include_str!("../../../src/screens/store/StoreScreen.vue");

#[test]
fn shortages_slice_preserves_layer_and_schema_invariants() {
    let sql = sql_only(SHORTAGES_MIGRATION);
    for required in [
        "create table shortages",
        "check (qty >= 1)",
        "check (status in ('open', 'ordered'))",
        ") strict",
        "create index idx_shortages_active",
        "create index idx_shortages_product",
    ] {
        assert!(
            sql.contains(required),
            "0026_shortages.sql must contain `{required}`"
        );
    }

    let domain = code_only(SHORTAGE_DOMAIN);
    for forbidden in ["sqlx", "tauri", "SqlitePool"] {
        assert!(
            !domain.contains(forbidden),
            "domain/shortage.rs must not reference `{forbidden}`"
        );
    }

    let service = code_only(SHORTAGE_SERVICE);
    for forbidden in ["sqlx::query", "SELECT ", "INSERT ", "UPDATE ", "DELETE "] {
        assert!(
            !service.contains(forbidden),
            "services/shortage.rs must not write raw SQL (`{forbidden}`)"
        );
    }

    let cmds = code_only(SHORTAGE_COMMANDS);
    for forbidden in ["sqlx::", "SELECT ", "INSERT ", "UPDATE ", "DELETE "] {
        assert!(
            !cmds.contains(forbidden),
            "commands/shortage.rs must not touch SQL (`{forbidden}`)"
        );
    }
    assert!(
        !command_parameters(SHORTAGE_COMMANDS).iter().any(|p| {
            let lower = p.to_lowercase();
            ["token", "user_id", "userid", "role", "created_by", "actor", "session"]
                .iter()
                .any(|f| lower.contains(f))
        }),
        "shortage commands must never accept identity/session parameters from the caller"
    );

    assert!(
        code_only(COSTING_SERVICE).contains("resolve_shortages_for_product"),
        "services/inventory/stock.rs must auto-resolve shortages on stock receipt"
    );

    for marker in [
        "إضافة للنواقص",
        "قايمة النواقص",
        "مقترح من المخزن",
        "ضيف الكل",
        "اتطلب",
        "وصل",
    ] {
        assert!(
            SHORTAGES_PANEL_VUE.contains(marker),
            "ShortagesPanel.vue must include `{marker}`"
        );
    }

    for marker in ["الأصناف", "النواقص"] {
        assert!(
            STORE_SCREEN_VUE.contains(marker),
            "StoreScreen.vue must include tab `{marker}`"
        );
    }
}

const REPAIRS_MIGRATION_SQL: &str =
    include_str!("../../src/data/migrations/0027_repairs_and_software.sql");
const REPAIR_SERVICE: &str = include_str!("../../src/services/repair.rs");
const REPAIR_COMMANDS: &str = include_str!("../../src/commands/repair.rs");
const REPAIRS_SCREEN_VUE: &str =
    include_str!("../../../src/screens/repairs/RepairsScreen.vue");

#[test]
fn repairs_and_software_migration_service_commands_and_ui_invariants_hold() {
    let sql = sql_only(REPAIRS_MIGRATION_SQL);
    for clause in [
        "CREATE TABLE repairs",
        "service_kind TEXT NOT NULL DEFAULT 'hardware' CHECK (service_kind IN ('hardware', 'software'))",
        "status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'diagnosing', 'waiting', 'ready', 'delivered', 'cancelled'))",
        "estimated_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (estimated_price_minor >= 0)",
        "final_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (final_price_minor >= 0)",
        "parts_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (parts_cost_minor >= 0)",
        "deposit_minor INTEGER NOT NULL DEFAULT 0 CHECK (deposit_minor >= 0)",
        "pay_method TEXT NOT NULL DEFAULT 'cash' CHECK (pay_method IN ('cash', 'vf', 'instapay', 'card'))",
        ") STRICT;",
    ] {
        assert!(
            sql.contains(clause),
            "0027_repairs_and_software.sql must contain `{clause}`"
        );
    }

    let service = code_only(REPAIR_SERVICE);
    for forbidden in ["sqlx::query", "SELECT ", "INSERT ", "UPDATE ", "DELETE "] {
        assert!(
            !service.contains(forbidden),
            "services/repair.rs must not write raw SQL (`{forbidden}`)"
        );
    }

    let cmds = code_only(REPAIR_COMMANDS);
    for forbidden in ["sqlx::", "SELECT ", "INSERT ", "UPDATE ", "DELETE "] {
        assert!(
            !cmds.contains(forbidden),
            "commands/repair.rs must not touch SQL (`{forbidden}`)"
        );
    }
    assert!(
        !command_parameters(REPAIR_COMMANDS).iter().any(|p| {
            let lower = p.to_lowercase();
            ["token", "user_id", "userid", "role", "created_by", "actor", "session"]
                .iter()
                .any(|f| lower.contains(f))
        }),
        "repair commands must never accept identity/session parameters from the caller"
    );

    assert!(
        SHELL_NAV_TS.contains("id: 'repairs', label: 'الصيانة', icon: 'wrench', ownerOnly: false"),
        "src/shell/nav.ts must expose the Repairs & Software screen on the rail"
    );

    for marker in [
        "الصيانة والسوفت وير",
        "فلوس الصيانة لوحدها",
        "فلوس السوفت وير لوحدها",
        "صيانة هاردوير",
        "سوفت وير",
        "سلّم وحصّل",
    ] {
        assert!(
            REPAIRS_SCREEN_VUE.contains(marker),
            "RepairsScreen.vue must include `{marker}`"
        );
    }
}








