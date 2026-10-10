# R1 Review Bundle — single-use manager-password recovery (R1-T1 → R1-T4)

Base commit: `32e7515` (branch `main`, remote `https://github.com/Petershaker3/system-sales.git`).
Scope: UNCOMMITTED working-tree changes only. No device build, no credential
change, no stock movement in this slice. `Costing = BLOCKED` unchanged.

Reproduce: `git status --short` shows the slice among broader uncommitted work;
the R1 files are listed in §1. Test evidence: `src-tauri/full-default.log`
(71 arch + 194 integration + 86 unit, green, zero warnings) and
`src-tauri/full-recovery.log` (71 + 198 + 86, green, zero warnings).

## 1. R1 file map

Tracked, modified (diff in §3):
- `src-tauri/Cargo.toml` — `[features] recovery = []`
- `src-tauri/src/domain/identity/error.rs` — `RecoveryNotApproved`, `RecoveryAlreadyUsed` + codes + Display
- `src-tauri/src/data/repositories/identity/audit.rs` — `RECOVERY_APPROVED`, `RECOVERY_EXECUTED`
- `src-tauri/src/data/repositories/identity/mod.rs` — `pub mod recovery`
- `src-tauri/src/services/identity/mod.rs` — cfg-gated `pub mod recovery`
- `src-tauri/src/commands/mod.rs` — cfg-gated `pub mod recovery`
- `src-tauri/src/lib.rs` — two cfg-gated handler registrations
- `src-tauri/tests/unit/main.rs` — new codes test + exhaustive list
- `src-tauri/tests/integration/main.rs` — `mod recovery`, cfg-gated `mod recovery_reset`
- `src-tauri/tests/integration/migration_backward_compat.rs` — chain 1..=9 + empty-table assertion
- `src-tauri/tests/integration/products_profile_migration.rs` — chain 1..=9
- `src-tauri/tests/architecture/main.rs` — two containment tests (§2042, §2073)
- `src/api/errors.ts` — two codes + Arabic messages

New files (full content in §4):
- `src-tauri/src/data/migrations/0009_recovery_approval.sql`
- `src-tauri/src/data/repositories/identity/recovery.rs`
- `src-tauri/src/services/identity/recovery.rs`
- `src-tauri/src/commands/recovery.rs`
- `src-tauri/tests/integration/recovery.rs`
- `src-tauri/tests/integration/recovery_reset.rs`

Spec: `docs/superpowers/plans/2026-10-10-manager-recovery-spec.md`.
Plan: `tasks/plan-recovery.md` (excerpt in §5). Tasks: R1 section of
`tasks/todo.md` (excerpt in §5).

## 2. Honest containment notes for the six review checks

1. **stage_approval vs unauthorized call.** Plainly: inside a recovery build,
   whoever holds the supervised device can invoke staging — there is no
   cryptographic authorizer for the stager. Containment is: (a) production
   builds lack the command entirely (arch-pinned), (b) the owner types the new
   password under supervision per the Q2 wording, (c) single-use enforced in
   SQL, (d) every step audited, (e) the build is replaced by a clean one at
   R1-T7. Judge whether that satisfies the check.
2. **Device/user identity.** `device_id` arrives as a caller string; on-device
   it is verified PROCEDURALLY by the supervisor against the physical device
   (expected `R3CMA016SEJ`). Technically it binds replay refusal and audit,
   not a hardware attestation. The recovery TARGET is read from the staged row
   (`services/identity/recovery.rs:111+`), never caller-asserted.
3. **Atomic consumption.** `consume_if_unconsumed` updates only
   `WHERE consumed_at IS NULL`; verifier write, `must_change_password=1`,
   session delete and both audit appends share the same transaction
   (`services/identity/recovery.rs:111-201`). Crash-before-commit rolls back
   (safe retry); crash-after leaves a consumed row (replay refused).
4. **Password/sessions.** Policy checked before any write (weak password never
   consumes). No password or verifier in any log/audit (detail carries
   reference/device/target-counts only). Old sessions deleted in-tx;
   `must_change_password=1` forces the final password through the normal
   screen. Lockout counters untouched (1 pre-existing failed attempt stands).
5. **Feature gate.** Service module, command module, `mod` declarations and
   both handler registrations carry `cfg(feature = "recovery")`; arch tests
   scan sources for the markers and for exactly two registrations, and forbid
   identity-asserting parameters.
6. **Migration 0009.** Additive table only; backward-compat tests prove an
   earlier populated chain upgrades to 1..=9 with the new table present and
   EMPTY (no approval by migration alone); no shop/audit row touched.

## 3. Diffs of tracked files (vs 32e7515)


### Cargo.toml (feature)
``diff
diff --git a/src-tauri/Cargo.toml b/src-tauri/Cargo.toml
index 1273700..2011d6e 100644
--- a/src-tauri/Cargo.toml
+++ b/src-tauri/Cargo.toml
@@ -12,6 +12,13 @@ rust-version = "1.98.1"
 name = "mobile_shop_system_lib"
 crate-type = ["staticlib", "cdylib", "rlib"]
 
+# Optional recovery build (plan R1, Design B). The single-use manager-password
+# recovery path exists ONLY when this feature is enabled. Production builds
+# must never enable it; an architecture test pins the command inventory with
+# and without the flag.
+[features]
+recovery = []
+
 [build-dependencies]
 tauri-build = { version = "=2.7.0", features = [] }
 
``n
### domain error
``diff
diff --git a/src-tauri/src/domain/identity/error.rs b/src-tauri/src/domain/identity/error.rs
index 4a891da..57afcf1 100644
--- a/src-tauri/src/domain/identity/error.rs
+++ b/src-tauri/src/domain/identity/error.rs
@@ -85,9 +85,21 @@ pub enum DomainError {
     /// It is an invariant violation, it is not transient, and retrying will not fix
     /// it ΓÇö so it must surface as a defect rather than as a transient hiccup.
     AccountDataIntegrityError,
+    /// Single-use recovery was attempted without a matching unconsumed
+    /// owner approval.
+    ///
+    /// Deliberately distinct from [`DomainError::InvalidCredentials`]: a
+    /// missing approval is a gate state, not a wrong password, and reporting
+    /// it as credentials would send the operator round a retry loop that can
+    /// never succeed.
+    RecoveryNotApproved,
+    /// The single-use recovery approval was already consumed.
+    RecoveryAlreadyUsed,
     /// Refusing to disable the last active manager.
     ///
     /// There is no backdoor reset and no second device, because V1 has no server
+    ///
+    /// There is no backdoor reset and no second device, because V1 has no server
     /// (`ADR-008`). Disabling the only manager would leave a device that nobody
     /// can ever administer again, so this is refused rather than warned about.
     CannotDisableLastManager,
@@ -144,6 +156,8 @@ impl DomainError {
             DomainError::DisplayNameRequired => "DISPLAY_NAME_REQUIRED",
             DomainError::AccountDataIntegrityError => "ACCOUNT_DATA_INTEGRITY_ERROR",
             DomainError::CannotDisableLastManager => "CANNOT_DISABLE_LAST_MANAGER",
+            DomainError::RecoveryNotApproved => "RECOVERY_NOT_APPROVED",
+            DomainError::RecoveryAlreadyUsed => "RECOVERY_ALREADY_USED",
             DomainError::CannotDisableSelf => "CANNOT_DISABLE_SELF",
             DomainError::WeakPassword => "PASSWORD_DOES_NOT_MEET_POLICY",
             DomainError::SessionIdleExpired => "SESSION_IDLE_EXPIRED",
@@ -205,6 +219,12 @@ impl fmt::Display for DomainError {
             DomainError::CannotDisableLastManager => {
                 write!(f, "cannot disable the last active manager")
             }
+            DomainError::RecoveryNotApproved => {
+                write!(f, "recovery was not approved for this device and reference")
+            }
+            DomainError::RecoveryAlreadyUsed => {
+                write!(f, "the recovery approval has already been consumed")
+            }
             DomainError::CannotDisableSelf => write!(f, "cannot disable your own account"),
             DomainError::StorageUnavailable => write!(f, "the local database is unavailable"),
             DomainError::SecureStorageUnavailable => {
``n
### audit events + repo mod
``diff
diff --git a/src-tauri/src/data/repositories/identity/audit.rs b/src-tauri/src/data/repositories/identity/audit.rs
index b0eca3a..6d9ce03 100644
--- a/src-tauri/src/data/repositories/identity/audit.rs
+++ b/src-tauri/src/data/repositories/identity/audit.rs
@@ -30,6 +30,12 @@ pub mod event {
     /// A manager set someone else's password. Distinct from
     /// `PASSWORD_CHANGED` so a report can separate self-service from recovery.
     pub const PASSWORD_RESET: &str = "password_reset";
+    /// An owner approved a single-use recovery (plan R1). The detail carries
+    /// the approval reference, device and approver ΓÇö never a credential.
+    pub const RECOVERY_APPROVED: &str = "recovery_approved";
+    /// A single-use recovery approval was executed. The detail carries the
+    /// approval reference, device and target ΓÇö never a credential.
+    pub const RECOVERY_EXECUTED: &str = "recovery_executed";
     pub const ROLE_CHANGED: &str = "role_changed";
     pub const USER_DISABLED: &str = "user_disabled";
     pub const USER_ENABLED: &str = "user_enabled";
@@ -45,6 +51,20 @@ pub const DEPARTMENT_CREATED: &str = "department_created";
 pub const DEPARTMENT_UPDATED: &str = "department_updated";
 pub const DEPARTMENT_ARCHIVED: &str = "department_archived";
 
+/// Inventory and costing (SP-2).
+///
+/// `COST_METHOD_SWITCHED` is its own event rather than a
+/// `department_updated`: the switch is the only operation that rewrites how
+/// every existing unit of stock is valued, and a report on costing history has
+/// to be able to find those moments without inferring them from a diff of two
+/// department rows.
+///
+/// Detail carries amounts only, never a Pattern: `spec:19` attributes every
+/// operation, and the schema forbids storing anything secret in `detail`.
+pub const STOCK_RECEIVED: &str = "stock_received";
+pub const STOCK_REMOVED: &str = "stock_removed";
+pub const COST_METHOD_SWITCHED: &str = "cost_method_switched";
+
 /// Settings and Pattern.
 ///
 /// `PATTERN_VERIFIED` is intentionally **not** recorded. A successful Pattern
diff --git a/src-tauri/src/data/repositories/identity/mod.rs b/src-tauri/src/data/repositories/identity/mod.rs
index 24701a3..5f30d53 100644
--- a/src-tauri/src/data/repositories/identity/mod.rs
+++ b/src-tauri/src/data/repositories/identity/mod.rs
@@ -7,5 +7,6 @@
 pub mod audit;
 pub mod credentials;
 pub mod pattern;
+pub mod recovery;
 pub mod session;
 pub mod user;
``n
### module gates + handler registration
``diff
diff --git a/src-tauri/src/commands/mod.rs b/src-tauri/src/commands/mod.rs
index 6242dc6..2ddeb76 100644
--- a/src-tauri/src/commands/mod.rs
+++ b/src-tauri/src/commands/mod.rs
@@ -8,5 +8,12 @@ pub mod catalog;
 pub mod departments;
 pub mod identity;
 pub mod identity_lifecycle;
+pub mod inventory;
 pub mod pattern;
+/// One-time supervised manager-password recovery (plan R1, Design B).
+///
+/// Recovery builds only. Without `--features recovery` this module does not
+/// exist.
+#[cfg(feature = "recovery")]
+pub mod recovery;
 pub mod settings;
diff --git a/src-tauri/src/lib.rs b/src-tauri/src/lib.rs
index ba2a26e..8bc8baf 100644
--- a/src-tauri/src/lib.rs
+++ b/src-tauri/src/lib.rs
@@ -72,6 +72,14 @@ pub fn run() {
             commands::pattern::set_pattern,
             commands::pattern::reset_pattern,
             commands::pattern::disable_pattern,
+            commands::inventory::receive_stock,
+            commands::inventory::remove_stock,
+            commands::inventory::get_position,
+            commands::inventory::switch_cost_method,
+            #[cfg(feature = "recovery")]
+            commands::recovery::stage_recovery_approval,
+            #[cfg(feature = "recovery")]
+            commands::recovery::execute_manager_recovery,
         ])
         .setup(move |app| {
             // Fail closed, and loudly. If the OS credential store cannot be
diff --git a/src-tauri/src/services/identity/mod.rs b/src-tauri/src/services/identity/mod.rs
index 95f8d75..e2dbe51 100644
--- a/src-tauri/src/services/identity/mod.rs
+++ b/src-tauri/src/services/identity/mod.rs
@@ -7,6 +7,12 @@ pub mod auth;
 pub mod bootstrap;
 pub mod crypto;
 pub mod password;
+/// One-time supervised manager-password recovery (plan R1, Design B).
+///
+/// Recovery builds only. Without `--features recovery` this module does not
+/// exist, and no recovery path can be reached from any command.
+#[cfg(feature = "recovery")]
+pub mod recovery;
 pub mod secure_store;
 pub mod session;
 pub mod users;
``n
### unit + integration harness
``diff
diff --git a/src-tauri/tests/integration/main.rs b/src-tauri/tests/integration/main.rs
index 278742d..c045556 100644
--- a/src-tauri/tests/integration/main.rs
+++ b/src-tauri/tests/integration/main.rs
@@ -721,3 +721,20 @@ mod authority;
 // Price history: the edit and its transition row commit together (plan
 // SP-1b).
 mod price_history;
+
+// Stock and costing: Moving Average, FIFO, the authority invariant, stock
+// exhaustion, rollback and the costing-method switch (plan SP-2).
+mod stock_costing;
+
+// Backward-compatible migration: a populated database from an earlier chain must
+// accept the current one. Found on the device, not by the fresh-database suite.
+mod migration_backward_compat;
+
+// Single-use recovery approvals: provision, atomic consume, replay refusal
+// (plan R1). No password logic here; the reset is proved with the use case.
+mod recovery;
+
+// The recovery use case itself. Recovery-build only: production builds never
+// contain this path (plan R1, Design B).
+#[cfg(feature = "recovery")]
+mod recovery_reset;
diff --git a/src-tauri/tests/unit/main.rs b/src-tauri/tests/unit/main.rs
index f82be0d..b08ab8d 100644
--- a/src-tauri/tests/unit/main.rs
+++ b/src-tauri/tests/unit/main.rs
@@ -339,6 +339,30 @@ fn infrastructure_failures_have_their_own_codes() {
     assert_ne!(storage, secure);
 }
 
+#[test]
+fn recovery_failures_have_distinct_stable_codes() {
+    // The recovery gate must fail closed with codes the frontend can render.
+    // Reusing INVALID_CREDENTIALS would conflate a missing approval with a
+    // wrong password and send the operator round a retry loop that can never
+    // succeed; reusing anything else would leak the gate's state.
+    assert_eq!(
+        DomainError::RecoveryNotApproved.code(),
+        "RECOVERY_NOT_APPROVED"
+    );
+    assert_eq!(
+        DomainError::RecoveryAlreadyUsed.code(),
+        "RECOVERY_ALREADY_USED"
+    );
+    assert_ne!(
+        DomainError::RecoveryNotApproved.code(),
+        DomainError::InvalidCredentials.code()
+    );
+    assert_ne!(
+        DomainError::RecoveryAlreadyUsed.code(),
+        DomainError::InvalidCredentials.code()
+    );
+}
+
 #[test]
 fn every_domain_error_yields_a_non_empty_screaming_snake_code() {
     // The frontend indexes an Arabic message table by this code. A code that is
@@ -361,6 +385,8 @@ fn every_domain_error_yields_a_non_empty_screaming_snake_code() {
         DomainError::DisplayNameRequired,
         DomainError::CannotDisableLastManager,
         DomainError::CannotDisableSelf,
+        DomainError::RecoveryNotApproved,
+        DomainError::RecoveryAlreadyUsed,
         DomainError::StorageUnavailable,
         DomainError::SecureStorageUnavailable,
     ];
@@ -695,9 +721,12 @@ fn an_active_department_accepts_an_edit() {
     let actor = UserId::generate();
     let vat = DepartmentVat::new(true, Some(VatRate::new(1450).unwrap()), true).unwrap();
 
+    // The department's own costing method: an edit may round-trip it but not
+    // change it, because changing it must convert the stock that exists.
+    let method = dept.cost_method;
     dept.update(
         DepartmentName::new("  Mobile Phones ").unwrap(),
-        CostMethod::Fifo,
+        method,
         vat,
         3,
         actor,
@@ -706,7 +735,7 @@ fn an_active_department_accepts_an_edit() {
     .expect("an active department may be edited");
 
     assert_eq!(dept.name.as_str(), "Mobile Phones");
-    assert_eq!(dept.cost_method, CostMethod::Fifo);
+    assert_eq!(dept.cost_method, method);
     assert_eq!(dept.sort_order, 3);
     assert!(dept.vat.is_enabled());
     assert_eq!(dept.vat.rate().map(|r| r.as_basis_points()), Some(1450));
@@ -721,24 +750,52 @@ fn an_active_department_accepts_an_edit() {
 
 #[test]
 fn both_cost_methods_are_accepted_and_neither_is_none() {
-    // `Fifo` is refused by nothing. Its costing engine does not exist yet, and
-    // refusing the value would turn a missing implementation into a rule.
+    // `Fifo` is refused by nothing. It arrived with its own costing engine in
+    // SP-2, and refusing the value would still turn a policy choice into a rule
+    // the schema could not express.
+    //
+    // Construction, not an edit: which method a department uses is decided by the
+    // dedicated switch, because switching has to convert existing stock.
     for method in [CostMethod::MovingAverage, CostMethod::Fifo] {
-        let mut dept = department();
-        dept.update(
+        let dept = Department::new(
             DepartmentName::new("Phones").unwrap(),
             method,
             DepartmentVat::disabled(),
             0,
             UserId::generate(),
-            8000,
-        )
-        .unwrap_or_else(|e| panic!("`{method:?}` must be a valid cost method: {e}"));
+            1000,
+        );
 
         assert_eq!(dept.cost_method, method);
     }
 }
 
+#[test]
+fn an_edit_cannot_change_the_costing_method() {
+    let mut dept = department();
+    let before = dept.cost_method;
+    let target = match before {
+        CostMethod::MovingAverage => CostMethod::Fifo,
+        CostMethod::Fifo => CostMethod::MovingAverage,
+    };
+
+    let refused = dept.update(
+        DepartmentName::new("Phones").unwrap(),
+        target,
+        DepartmentVat::disabled(),
+        0,
+        UserId::generate(),
+        8000,
+    );
+
+    assert_eq!(
+        refused,
+        Err(DepartmentError::CostMethodChangeRequiresSwitch),
+        "switching must go through the operation that converts the stock"
+    );
+    assert_eq!(dept.cost_method, before);
+}
+
 #[test]
 fn a_cost_method_round_trips_through_its_stored_form() {
     // The stored strings are what migration `0004`'s CHECK accepts.
``n
### chain assertions
``diff
diff --git a/src-tauri/tests/integration/products_profile_migration.rs b/src-tauri/tests/integration/products_profile_migration.rs
index 50bf2cd..c894efb 100644
--- a/src-tauri/tests/integration/products_profile_migration.rs
+++ b/src-tauri/tests/integration/products_profile_migration.rs
@@ -149,7 +149,7 @@ async fn create_department(pool: &SqlitePool, name: &str) -> String {
 // ---------------------------------------------------------------------------
 
 #[tokio::test]
-async fn all_seven_migrations_apply_in_order_on_a_fresh_database() {
+async fn all_migrations_apply_in_order_on_a_fresh_database() {
     let pool = db::open_in_memory().await.expect("in-memory database");
 
     let versions: Vec<i64> =
@@ -160,8 +160,8 @@ async fn all_seven_migrations_apply_in_order_on_a_fresh_database() {
 
     assert_eq!(
         versions,
-        vec![1, 2, 3, 4, 5, 6, 7],
-        "all seven migrations must be recorded in order, with 0007 last"
+        vec![1, 2, 3, 4, 5, 6, 7, 8, 9],
+        "every migration must be recorded in order, with 0009 (recovery approvals) last"
     );
 }
 
``n
### arch containment tests
``diff
diff --git a/src-tauri/tests/architecture/main.rs b/src-tauri/tests/architecture/main.rs
index 9ee594a..08d8342 100644
--- a/src-tauri/tests/architecture/main.rs
+++ b/src-tauri/tests/architecture/main.rs
@@ -434,7 +434,44 @@ fn domain_sources() -> Vec<(String, String)> {
 /// error type, and a scanner pointed at a single file would let a new slice's
 /// codes drift out of the Arabic message table without failing the build.
 fn rust_error_codes() -> Vec<String> {
-    rust_error_codes_per_source().concat()
+    let mut codes = rust_error_codes_per_source().concat();
+    // The inventory service declares its own error codes beside the domain ones
+    // (`STOCK_*`). Its `StockServiceError::code` *delegates* to the enum it
+    // wraps, so it contributes no literal arms and must not be held to the
+    // non-vacuity rule below ΓÇö which is why the scan is added here rather than
+    // by widening the domain walk.
+    codes.extend(literal_code_arms(&COSTING_SERVICE));
+    codes
+}
+
+/// Literal `"UPPER_SNAKE"` values on the right of a `=>` in a `code()` body.
+///
+/// Shared by the per-source scanner and by the service-level addition above so
+/// the two can never drift into accepting different syntax.
+fn literal_code_arms(source: &str) -> Vec<String> {
+    let code_only_src = code_only(source);
+    let Some(start) = code_only_src.find("pub fn code(&self)") else {
+        return Vec::new();
+    };
+
+    let mut codes = Vec::new();
+    for line in code_only_src[start..].lines() {
+        // Arms look like:  CatalogError::Foo => "FOO_CODE",
+        let Some((_, rest)) = line.split_once("=> \"") else {
+            continue;
+        };
+        let Some((code, _)) = rest.split_once('"') else {
+            continue;
+        };
+        if code
+            .chars()
+            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
+            && code.len() > 2
+        {
+            codes.push(code.to_string());
+        }
+    }
+    codes
 }
 
 /// The same codes, grouped by the file each came from.
@@ -1562,6 +1599,10 @@ fn every_authority_command_is_registered_in_lib() {
         ("pattern", "set_pattern"),
         ("pattern", "reset_pattern"),
         ("pattern", "disable_pattern"),
+        ("inventory", "receive_stock"),
+        ("inventory", "remove_stock"),
+        ("inventory", "get_position"),
+        ("inventory", "switch_cost_method"),
     ] {
         assert!(
             code.contains(&format!("commands::{module}::{command}")),
@@ -1569,3 +1610,476 @@ fn every_authority_command_is_registered_in_lib() {
         );
     }
 }
+
+// ---------------------------------------------------------------------------
+// SP-2: the costing contract (ADR-013, spec ┬º10)
+//
+// The rounding and storage rules are the ones thing a later slice would
+// silently break, because every alternative compiles and every alternative
+// produces plausible numbers. A piastre lost to a `round()` instead of a
+// ceiling does not fail loudly; it just quietly costs the shop money. These
+// guards turn the contract into a build failure rather than a code review
+// memory.
+// ---------------------------------------------------------------------------
+
+const COSTING_MOD: &str = include_str!("../../src/domain/costing/mod.rs");
+const COSTING_MOVING_AVERAGE: &str = include_str!("../../src/domain/costing/moving_average.rs");
+const COSTING_FIFO: &str = include_str!("../../src/domain/costing/fifo.rs");
+const STOCK_MIGRATION: &str = include_str!("../../src/data/migrations/0008_stock_and_cost_layers.sql");
+const COSTING_SERVICE: &str = include_str!("../../src/services/inventory/stock.rs");
+const INVENTORY_COMMANDS: &str = include_str!("../../src/commands/inventory.rs");
+const FRONTEND_INVENTORY_API: &str = include_str!("../../../src/api/inventory.ts");
+const FRONTEND_STOCK_PANEL: &str = include_str!("../../../src/components/StockPanel.vue");
+const FRONTEND_DEPARTMENTS_PANEL: &str =
+    include_str!("../../../src/components/DepartmentsPanel.vue");
+
+#[test]
+fn the_inventory_commands_take_no_session_token_role_or_actor() {
+    // The same rule every other command module is held to (`spec:210`, and the
+    // existing catalogue and authority guards). Attribution has to be a fact
+    // resolved from the credential store, never a value a caller supplies.
+    for parameter in ["token:", "role:", "actor:", "assurance:", "user_id:"] {
+        assert!(
+            !INVENTORY_COMMANDS.contains(parameter),
+            "an inventory command must not accept `{parameter}` from a caller"
+        );
+    }
+    assert!(
+        INVENTORY_COMMANDS.contains("State<'a, IdentityContext>"),
+        "inventory commands must resolve the operator through the shared context"
+    );
+}
+
+#[test]
+fn the_inventory_commands_never_touch_sql() {
+    // Transport only. The arithmetic and the transaction belong to the service;
+    // a query here would mean the two could disagree about a rule.
+    let code = code_only(INVENTORY_COMMANDS);
+    for forbidden in ["sqlx::", "SELECT ", "INSERT ", "UPDATE ", "DELETE "] {
+        assert!(
+            !code.contains(forbidden),
+            "commands/inventory.rs must not contain `{forbidden}`: queries live under \
+             data/repositories and the rules in services"
+        );
+    }
+}
+
+#[test]
+fn a_caller_cannot_choose_how_much_proof_a_movement_needs() {
+    // `Sensitivity` decides how much authority an operation needs. If the WebView
+    // could pass it, a caller would downgrade a sensitive operation to a routine
+    // one by sending the weaker value ΓÇö a parallel authority path, which the
+    // sensitivity module exists to prevent.
+    let code = code_only(INVENTORY_COMMANDS);
+    assert!(
+        !command_parameters(INVENTORY_COMMANDS)
+            .iter()
+            .any(|name| name.contains("sensitivity")),
+        "no command may accept a sensitivity argument"
+    );
+    assert!(
+        code.contains("Sensitivity::Routine"),
+        "the service call must state the sensitivity in Rust, not accept it"
+    );
+}
+
+#[test]
+fn the_stock_panel_never_computes_a_cost_of_its_own() {
+    // The ceiling rule lives in `domain/costing`. A locally divided average
+    // would be a second rounding rule, which is exactly the drift ADR-013 exists
+    // to prevent ΓÇö and it would differ from the figure the sale is snapshotted
+    // with.
+    let code = code_only(FRONTEND_STOCK_PANEL);
+    for forbidden in ["Math.ceil", "round(", "Math.round", "/ onHand", "/ quantity"] {
+        assert!(
+            !code.contains(forbidden),
+            "the panel must render the figure Rust returned, never recompute one \
+             (found `{forbidden}`)"
+        );
+    }
+    assert!(
+        code.contains("effectiveCostMinor"),
+        "the panel must show the derived cost Rust supplied"
+    );
+}
+
+#[test]
+fn the_null_and_zero_cost_distinction_survives_the_boundary() {
+    // `null` means FIFO holds the cost; `0` means free stock. The API type and
+    // the panel must both keep them apart, or the authority rule becomes
+    // invisible exactly where it matters.
+    assert!(
+        FRONTEND_INVENTORY_API.contains("totalCostMinor: number | null"),
+        "the API type must keep totalCostMinor nullable"
+    );
+    let panel = code_only(FRONTEND_STOCK_PANEL);
+    assert!(
+        !panel.contains("position.totalCostMinor || 0"),
+        "the panel must not collapse a null total into zero"
+    );
+}
+
+#[test]
+fn the_departments_panel_offers_no_control_the_backend_will_refuse() {
+    // An edit may no longer change the costing method: switching has to convert
+    // the stock that already exists. A `<select>` bound to that field would be a
+    // control that can only ever fail, which is worse than no control at all.
+    let panel = code_only(FRONTEND_DEPARTMENTS_PANEL);
+    assert!(
+        !panel.contains("v-model=\"formcostmethod\""),
+        "the department form must not offer a costing-method choice"
+    );
+    assert!(
+        panel.contains("readonly-method"),
+        "the current method should still be shown, read-only"
+    );
+}
+
+#[test]
+fn every_inventory_error_code_has_an_arabic_message() {
+    // The bidirectional guard covers domain error codes. The service introduced
+    // two more (`STOCK_*`) and the frontend message table must carry both, or an
+    // operator sees the generic fallback for a genuine data defect.
+    for code in ["STOCK_PRODUCT_NOT_FOUND", "STOCK_COST_AUTHORITY_CONFLICT"] {
+        assert!(
+            COSTING_SERVICE.contains(&format!("\"{code}\"")),
+            "the service is expected to emit `{code}`; the guard's scan is broken"
+        );
+        assert!(
+            FRONTEND_ERRORS.contains(&format!("{code}:")),
+            "Rust emits `{code}` but src/api/errors.ts declares no code for it"
+        );
+    }
+}
+
+#[test]
+fn the_stock_schema_stays_one_counter_per_product_and_opens_no_location() {
+    // D2, restated where the stock tables actually appear. `ADR-012` decided
+    // that `stock_levels` is keyed by `product_id` alone and that a department
+    // classifies a product rather than locating it, but that decision was
+    // recorded while no stock table existed. `0008` is the migration that creates
+    // one, so it is the file where the question could be quietly reopened ΓÇö by a
+    // `location_id` column, or by a composite key that reintroduces the per-site
+    // stock the ADR rejected as never requested.
+    let sql = sql_only(STOCK_MIGRATION);
+    for forbidden in [
+        "location",
+        "warehouse",
+        "branch",
+        "stockroom",
+        "shelf",
+        "bin",
+        "aisle",
+    ] {
+        assert!(
+            !sql.contains(forbidden),
+            "0008 must not mention `{forbidden}`: V1 has one stock counter per \
+             product and no physical place (ADR-012)"
+        );
+    }
+
+    // Two tables, so two primary keys. The invariant is not "one key" but "no
+    // composite key": `stock_levels` is keyed by the product alone and
+    // `fifo_layers` by its own id, and neither key may grow a second column that
+    // reintroduces the per-site stock ADR-012 refused.
+    //
+    // `sql_only` lowercases and strips `--` comments, so keywords are compared
+    // in lower case.
+    assert_eq!(
+        sql.matches("primary key").count(),
+        2,
+        "0008 declares two tables and each takes exactly one primary key"
+    );
+    for forbidden in [
+        "primary key (product_id,",
+        "primary key (product_id ,",
+        "primary key (product_id, location",
+    ] {
+        assert!(
+            !sql.contains(forbidden),
+            "`{forbidden}` would reintroduce per-site stock that ADR-012 refused"
+        );
+    }
+    assert!(
+        sql.contains("product_id") && sql.contains("references products (id)"),
+        "stock_levels must be keyed by product_id alone (ADR-012)"
+    );
+}
+
+#[test]
+fn the_stock_schema_keeps_money_and_quantities_integer_and_never_negative() {
+    // `spec:56` and ADR-010: an integer count of piastres, never a float. And
+    // the one state a costing bug must never be able to write is a negative
+    // balance, so the CHECK belongs in the schema rather than only in Rust.
+    let sql = sql_only(STOCK_MIGRATION);
+    assert!(
+        sql.contains("quantity >= 0"),
+        "a negative balance must be impossible at the storage layer"
+    );
+    assert!(
+        sql.contains("total_cost_minor >= 0"),
+        "a negative total cost must be impossible at the storage layer"
+    );
+    assert!(
+        sql.contains("quantity > 0"),
+        "a spent FIFO layer must be deleted, not kept at zero"
+    );
+    for forbidden in ["real", "float", "double", "numeric"] {
+        assert!(
+            !sql.contains(forbidden),
+            "0008 must not declare `{forbidden}`: money is an integer minor unit"
+        );
+    }
+}
+
+#[test]
+fn the_costing_service_runs_each_operation_in_one_transaction() {
+    // The atomicity claim is the point of the slice: a balance, its layers and
+    // its audit event move together or not at all. Asserting that each public
+    // operation opens a transaction and commits one is the cheapest way to stop
+    // a later slice from adding a fourth write outside it.
+    for operation in ["receive", "remove", "switch_cost_method"] {
+        let start = COSTING_SERVICE
+            .find(&format!("pub async fn {operation}("))
+            .unwrap_or_else(|| panic!("`{operation}` must be a public use case"));
+        let body = &COSTING_SERVICE[start..];
+        assert!(
+            body.contains("pool.begin()"),
+            "{operation} must open one transaction"
+        );
+        assert!(
+            body.contains("tx.commit()"),
+            "{operation} must commit that transaction"
+        );
+    }
+}
+
+#[test]
+fn the_costing_service_never_writes_sql() {
+    // Services orchestrate; repositories own queries (`spec:99`, and the same
+    // rule the catalogue and authority services are held to). One exception is
+    // declared and narrow: the switch writes the department's costing method,
+    // because that is the one statement whose whole purpose is to move that
+    // column, and routing it through the ordinary department update would be the
+    // relabelling-without-converting bug the switch exists to prevent.
+    let code = code_only(COSTING_SERVICE);
+    let statements = code.matches("sqlx::query").count();
+    assert!(
+        statements <= 3,
+        "the costing service writes {statements} statements; queries belong in \
+         data/repositories (only the costing-method column update belongs here)"
+    );
+}
+
+#[test]
+fn the_costing_service_never_resolves_a_session_from_a_caller() {
+    // Same rule as every other service: no token, role or assurance level is
+    // accepted from outside. Resolution goes through the shared helper.
+    let code = code_only(COSTING_SERVICE);
+    for parameter in ["token:", "role:", "actor:", "assurance:"] {
+        assert!(
+            !code.contains(parameter),
+            "the costing service must not accept `{parameter}` from a caller"
+        );
+    }
+    assert!(
+        code.contains("identity_session::resolve"),
+        "the session must come from the shared resolver"
+    );
+}
+
+#[test]
+fn the_costing_module_never_uses_a_float() {
+    // spec:56 and ADR-010: money is an integer count of piastres. A float cannot
+    // represent 0.01 EGP, so any float in this path is a silent accuracy bug
+    // wearing the costume of a rounding decision.
+    for (name, source) in [
+        ("costing/mod.rs", COSTING_MOD),
+        ("costing/moving_average.rs", COSTING_MOVING_AVERAGE),
+        ("costing/fifo.rs", COSTING_FIFO),
+    ] {
+        let code = code_only(source);
+        for forbidden in ["f32", "f64", "REAL", "floating"] {
+            assert!(
+                !code.contains(forbidden),
+                "{name} must not mention `{forbidden}`: money is integer piastres (spec:56)"
+            );
+        }
+    }
+}
+
+#[test]
+fn the_costing_module_offers_no_alternative_rounding_rule() {
+    // Nearest, half-up and banker's rounding are all named rejections in
+    // ADR-013. Naming them again here means a future contributor cannot add one
+    // and call it a local optimisation: the ceiling is the only rounding rule
+    // this codebase has for money.
+    for (name, source) in [
+        ("costing/mod.rs", COSTING_MOD),
+        ("costing/moving_average.rs", COSTING_MOVING_AVERAGE),
+        ("costing/fifo.rs", COSTING_FIFO),
+    ] {
+        let code = code_only(source);
+        for forbidden in ["round()", ".round(", "banker", "half_up", "nearest"] {
+            assert!(
+                !code.contains(forbidden),
+                "{name} must not contain `{forbidden}`: ADR-013 approves ceiling rounding only"
+            );
+        }
+    }
+}
+
+#[test]
+fn the_costing_module_carries_no_remainder_column() {
+    // ADR-013 proves the remainder is always zero under ceiling rounding and
+    // rejects the column. A stored remainder would reintroduce exactly the
+    // fractional persisted state `spec` ┬º10 forbids.
+    //
+    // Scoped to declarations, not the whole word: the documentation must be able
+    // to explain the rejection, and a test may legitimately be named after what
+    // it proves. What must not exist is a *field* or *parameter* that carries a
+    // remainder.
+    for (name, source) in [
+        ("costing/mod.rs", COSTING_MOD),
+        ("costing/moving_average.rs", COSTING_MOVING_AVERAGE),
+        ("costing/fifo.rs", COSTING_FIFO),
+    ] {
+        let code = code_only(source);
+        for forbidden in [
+            "remainder:",
+            "remainder :",
+            "_remainder:",
+            "remainder_minor:",
+            "cost_remainder_minor",
+            "residual:",
+        ] {
+            assert!(
+                !code.contains(forbidden),
+                "{name} must not declare `{forbidden}`: ADR-013 proves no remainder is needed"
+            );
+        }
+    }
+}
+
+#[test]
+fn the_costing_arithmetic_computes_its_intermediates_in_i128() {
+    // `units ├ù total_cost_minor` overflows i64 at plausible volumes, so the
+    // contract is not "careful coding" but a wider type. Asserting the product
+    // goes through `i128::from` keeps a refactor from quietly widening nothing.
+    let code = code_only(COSTING_MOVING_AVERAGE);
+    assert!(
+        code.contains("i128"),
+        "moving_average must compute intermediates in i128 (ADR-013 \"i128 ┘ä┘ä┘ê╪│╪º╪ª╪╖\")"
+    );
+}
+
+#[test]
+fn the_costing_module_knows_no_infrastructure() {
+    // domain/ is the layer that knows no Tauri, no SQLx, no SQLite and no
+    // platform (spec:99). Costing is arithmetic, so the cheapest way to keep it
+    // arithmetic is to refuse every one of those names at build time.
+    let code = format!("{COSTING_MOD}{COSTING_MOVING_AVERAGE}{COSTING_FIFO}");
+    for forbidden in ["sqlx", "SqlitePool", "tauri", "invoke", "Transaction"] {
+        assert!(
+            !code.contains(forbidden),
+            "domain/costing must not mention `{forbidden}`: the domain knows no infrastructure"
+        );
+    }
+}
+
+#[test]
+fn the_costing_module_does_not_redefine_the_cost_method_vocabulary() {
+    // `CostMethod` already lives in domain/organisation beside the department
+    // that owns the setting. A second spelling is the drift domain/mod.rs
+    // forbids, and two enums that both parse "fifo" would eventually disagree
+    // on what one stored string means.
+    assert!(
+        !COSTING_MOD.contains("enum CostMethod"),
+        "CostMethod is defined once in domain/organisation; costing must import it, not redefine it"
+    );
+    assert!(
+        COSTING_MOD.contains("pub use crate::domain::organisation::CostMethod"),
+        "costing must re-export the shared CostMethod so callers have one name"
+    );
+}
+
+#[test]
+fn every_costing_error_code_is_declared_and_has_an_arabic_message() {
+    // Mirrors the existing bidirectional guard for domain error codes: a code
+    // Rust can emit but the operator cannot read is a blank error message at
+    // best, and a machine code shown to a shop owner at worst.
+    let code = format!("{COSTING_MOD}{COSTING_MOVING_AVERAGE}{COSTING_FIFO}");
+    let mut codes = Vec::new();
+    let mut rest = code.as_str();
+    while let Some(index) = rest.find("\"COST_") {
+        rest = &rest[index + 1..];
+        let end = rest
+            .find('"')
+            .expect("a COST_ code literal must close");
+        codes.push(&rest[..end]);
+        rest = &rest[end + 1..];
+    }
+    assert!(
+        !codes.is_empty(),
+        "costing must emit COST_* codes; the scan found none, so the guard is broken"
+    );
+    for code in &codes {
+        assert!(
+            FRONTEND_ERRORS.contains(&format!("{code}:")),
+            "Rust emits `{code}` but src/api/errors.ts declares no code for it"
+        );
+    }
+}
+
+const RECOVERY_COMMANDS: &str = include_str!("../../src/commands/recovery.rs");
+const RECOVERY_SERVICE: &str = include_str!("../../src/services/identity/recovery.rs");
+
+// ---------------------------------------------------------------------------
+// Recovery path containment (plan R1, Design B)
+// ---------------------------------------------------------------------------
+
+#[test]
+fn recovery_path_exists_only_behind_the_recovery_feature() {
+    // The bypass must be ungraftable from a production build: the module, the
+    // service and the handler registration all carry the same gate, so
+    // removing any one of them breaks the build loudly rather than silently
+    // widening the path.
+    for (name, source) in [
+        ("commands/recovery.rs", RECOVERY_COMMANDS),
+        ("services/identity/recovery.rs", RECOVERY_SERVICE),
+    ] {
+        assert!(
+            source.contains("cfg(feature = \"recovery\")"),
+            "{name} must be gated on the recovery feature"
+        );
+    }
+    assert!(
+        COMMANDS_MOD.contains("#[cfg(feature = \"recovery\")]"),
+        "commands/mod.rs must gate the recovery module declaration"
+    );
+    let registrations = LIB.matches("commands::recovery::").count();
+    assert_eq!(
+        registrations, 2,
+        "lib.rs must register exactly the two recovery commands, got {registrations}"
+    );
+    let gated = LIB.matches("#[cfg(feature = \"recovery\")]").count();
+    assert!(
+        gated >= 2,
+        "each recovery registration in lib.rs must carry the feature gate"
+    );
+}
+
+#[test]
+fn recovery_commands_take_no_identity_from_the_caller() {
+    // Same transport rule as every other command: no token, user id, role or
+    // actor parameter. The recovery screen sends what the owner typed (the
+    // approval fields and the new password); identity is resolved from the
+    // staged approval row, never asserted by the WebView.
+    let forbidden = ["token", "user_id", "role", "actor", "session"];
+    for parameter in command_parameters(&code_only(RECOVERY_COMMANDS)) {
+        assert!(
+            !forbidden.contains(&parameter.as_str()),
+            "recovery command parameter `{parameter}` would let the caller assert identity"
+        );
+    }
+}
``n
### Arabic messages
``diff
diff --git a/src/api/errors.ts b/src/api/errors.ts
index 6d18b4f..e52e053 100644
--- a/src/api/errors.ts
+++ b/src/api/errors.ts
@@ -38,6 +38,8 @@ export const ErrorCode = {
   CANNOT_DISABLE_LAST_MANAGER: 'CANNOT_DISABLE_LAST_MANAGER',
   CANNOT_DISABLE_SELF: 'CANNOT_DISABLE_SELF',
   ACCOUNT_DATA_INTEGRITY_ERROR: 'ACCOUNT_DATA_INTEGRITY_ERROR',
+  RECOVERY_NOT_APPROVED: 'RECOVERY_NOT_APPROVED',
+  RECOVERY_ALREADY_USED: 'RECOVERY_ALREADY_USED',
   // Catalogue
   PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
   BARCODE_ALREADY_EXISTS: 'BARCODE_ALREADY_EXISTS',
@@ -53,6 +55,8 @@ export const ErrorCode = {
   DEPARTMENT_IS_ARCHIVED: 'DEPARTMENT_IS_ARCHIVED',
   DEPARTMENT_NOT_ARCHIVED: 'DEPARTMENT_NOT_ARCHIVED',
   DEPARTMENT_ARCHIVE_STATE_INCONSISTENT: 'DEPARTMENT_ARCHIVE_STATE_INCONSISTENT',
+  DEPARTMENT_COST_METHOD_REQUIRES_SWITCH:
+    'DEPARTMENT_COST_METHOD_REQUIRES_SWITCH',
   VAT_RATE_REQUIRED: 'VAT_RATE_REQUIRED',
   VAT_RATE_NEGATIVE: 'VAT_RATE_NEGATIVE',
   // الخطوة الثانية (النمط / الإعدادات)
@@ -60,7 +64,18 @@ export const ErrorCode = {
   PATTERN_APPROVAL_STALE: 'PATTERN_APPROVAL_STALE',
   PATTERN_NOT_CONFIGURED: 'PATTERN_NOT_CONFIGURED',
   SETTING_UNKNOWN_KEY: 'SETTING_UNKNOWN_KEY',
-  SETTING_VALUE_INVALID: 'SETTING_VALUE_INVALID'
+  SETTING_VALUE_INVALID: 'SETTING_VALUE_INVALID',
+
+  // التكلفة (ADR-013)
+  COST_NEGATIVE_QUANTITY: 'COST_NEGATIVE_QUANTITY',
+  COST_NEGATIVE_TOTAL: 'COST_NEGATIVE_TOTAL',
+  COST_INSUFFICIENT_STOCK: 'COST_INSUFFICIENT_STOCK',
+  COST_ZERO_UNITS: 'COST_ZERO_UNITS',
+  COST_OVERFLOW: 'COST_OVERFLOW',
+
+  // المخزون (ADR-015)
+  STOCK_PRODUCT_NOT_FOUND: 'STOCK_PRODUCT_NOT_FOUND',
+  STOCK_COST_AUTHORITY_CONFLICT: 'STOCK_COST_AUTHORITY_CONFLICT'
 } as const;
 
 export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
@@ -113,6 +128,10 @@ const MESSAGES_AR: Readonly<Record<ErrorCodeValue, string>> = {
     'لا يُمكن تعطيل حسابك الشخصي.',
   [ErrorCode.ACCOUNT_DATA_INTEGRITY_ERROR]:
     'بيانات هذا الحساب غير مكتملة. كلّم المسؤول الفني عن الجهاز.',
+  [ErrorCode.RECOVERY_NOT_APPROVED]:
+    'لا توجد موافقة استرداد صالحة لهذا الجهاز. لا يمكن المتابعة.',
+  [ErrorCode.RECOVERY_ALREADY_USED]:
+    'تم استخدام موافقة الاسترداد من قبل. لا يمكن إعادة استخدامها.',
 
   // الكتالوغ
   [ErrorCode.PRODUCT_NOT_FOUND]: 'المنتج غير موجود.',
@@ -140,6 +159,8 @@ const MESSAGES_AR: Readonly<Record<ErrorCodeValue, string>> = {
     'هذا القسم نشط بالفعل. لا يوجد ما يسترجعه.',
   [ErrorCode.DEPARTMENT_ARCHIVE_STATE_INCONSISTENT]:
     'بيانات القسم غير مكتملة. كلّم المسؤول الفني عن الجهاز.',
+  [ErrorCode.DEPARTMENT_COST_METHOD_REQUIRES_SWITCH]:
+    'تغيير طريقة حساب التكلفة يحتاج عملية مخصصة تُحوّل المخزون القائم. استخدم زر تبديل طريقة التكلفة.',
   [ErrorCode.VAT_RATE_REQUIRED]:
     'يجب تحديد نسبة ضريبة قبل تفعيل الضريبة على القسم.',
   [ErrorCode.VAT_RATE_NEGATIVE]: 'لا يُقبل أن تكون نسبة الضريبة سالبة.',
@@ -152,7 +173,23 @@ const MESSAGES_AR: Readonly<Record<ErrorCodeValue, string>> = {
   [ErrorCode.PATTERN_NOT_CONFIGURED]:
     'حماية النمط مُفعّلة ولم يُعيَّن نمط بعد. كلّم مدير المحل.',
   [ErrorCode.SETTING_UNKNOWN_KEY]: 'إعداد غير معروف.',
-  [ErrorCode.SETTING_VALUE_INVALID]: 'قيمة الإعداد غير صحيحة.'
+  [ErrorCode.SETTING_VALUE_INVALID]: 'قيمة الإعداد غير صحيحة.',
+
+  // التكلفة (ADR-013)
+  [ErrorCode.COST_NEGATIVE_QUANTITY]:
+    'كمية غير صحيحة. لا يُقبل أن تكون الكمية سالبة أو صفرًا عند الخصم.',
+  [ErrorCode.COST_NEGATIVE_TOTAL]: 'إجمالي تكلفة غير صحيح. لا يُقبل أن يكون سالبًا.',
+  [ErrorCode.COST_INSUFFICIENT_STOCK]:
+    'الكمية المطلوبة أكبر من الكمية المتوفرة في المخزون.',
+  [ErrorCode.COST_ZERO_UNITS]: 'لا يُقبل حذف صفر وحدات من المخزون.',
+  [ErrorCode.COST_OVERFLOW]:
+    'قيمة التكلفة أكبر من الحد المسموح. راجع الكمية أو سعر التوريد.',
+
+  // المخزون (ADR-015)
+  [ErrorCode.STOCK_PRODUCT_NOT_FOUND]:
+    'المنتج غير موجود، فلا يمكن تسجيل حركة مخزون له.',
+  [ErrorCode.STOCK_COST_AUTHORITY_CONFLICT]:
+    'بيانات تكلفة هذا المنتج غير متسقة مع طريقة التكلفة المستخدمة. كلّم المسؤول الفني عن الجهاز.'
 };
 
 /** Shown when Rust sends something this build does not know about. */
``n## §4 file: src-tauri/src/data/migrations/0009_recovery_approval.sql
``sql
-- Migration 0009: single-use recovery approvals (plan R1).
--
-- One row per owner-approved password reset. The row is consumed
-- transactionally with the verifier write: `consumed_at` moves from NULL to a
-- timestamp in the same transaction, so a crash before commit rolls the
-- consumption back (safe retry with the same reference) and a crash after
-- commit leaves a consumed row (replay refused).
--
-- The row carries no secret: reference, device, target and reason only. The
-- new password travels through the supervised session and is never stored.

CREATE TABLE recovery_approval (
    reference      TEXT    PRIMARY KEY,
    device_id      TEXT    NOT NULL,
    target_user_id TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    reason         TEXT    NOT NULL,
    approved_at    INTEGER NOT NULL,
    consumed_at    INTEGER
);

``n
## §4 file: src-tauri/src/data/repositories/identity/recovery.rs
``rust
//! Single-use recovery approvals.
//!
//! One row per owner-approved reset. Provisioning and consumption are separate
//! calls so tests can prove each half, but the use case consumes the row in
//! the *same transaction* as the verifier write: crash before commit rolls
//! back (safe retry), crash after commit leaves a consumed row (replay
//! refused). No secret ever appears here — reference, device, target and
//! reason only.

use sqlx::{Row, SqliteConnection};

/// An owner-approved reset that has not necessarily been executed yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approval {
    pub reference: String,
    pub device_id: String,
    pub target_user_id: String,
    pub reason: String,
    pub approved_at: i64,
}

/// Record an approval. A duplicate reference is an error: a reference is
/// single-use from the moment it exists.
pub async fn provision(conn: &mut SqliteConnection, approval: &Approval) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO recovery_approval
            (reference, device_id, target_user_id, reason, approved_at, consumed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
    )
    .bind(&approval.reference)
    .bind(&approval.device_id)
    .bind(&approval.target_user_id)
    .bind(&approval.reason)
    .bind(approval.approved_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// An approval row as stored, including its consumption state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredApproval {
    pub approval: Approval,
    /// `None` while the approval is still usable.
    pub consumed_at: Option<i64>,
}

/// The row for a reference, or `None` when no such approval was ever staged.
pub async fn find_by_reference(
    conn: &mut SqliteConnection,
    reference: &str,
) -> Result<Option<StoredApproval>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT reference, device_id, target_user_id, reason, approved_at, consumed_at
         FROM recovery_approval WHERE reference = ?1",
    )
    .bind(reference)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|row| StoredApproval {
        approval: Approval {
            reference: row.get("reference"),
            device_id: row.get("device_id"),
            target_user_id: row.get("target_user_id"),
            reason: row.get("reason"),
            approved_at: row.get("approved_at"),
        },
        consumed_at: row.get("consumed_at"),
    }))
}
/// Consume an approval if — and only if — it exists for this device and is
/// still unconsumed. Returns the row on success, `None` otherwise: unknown
/// reference, wrong device and replay are indistinguishable by design, so a
/// probe discloses nothing about which approvals exist.
pub async fn consume_if_unconsumed(
    conn: &mut SqliteConnection,
    reference: &str,
    device_id: &str,
    consumed_at: i64,
) -> Result<Option<Approval>, sqlx::Error> {
    let row = sqlx::query(
        "UPDATE recovery_approval
         SET consumed_at = ?3
         WHERE reference = ?1 AND device_id = ?2 AND consumed_at IS NULL
         RETURNING reference, device_id, target_user_id, reason, approved_at",
    )
    .bind(reference)
    .bind(device_id)
    .bind(consumed_at)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|row| Approval {
        reference: row.get("reference"),
        device_id: row.get("device_id"),
        target_user_id: row.get("target_user_id"),
        reason: row.get("reason"),
        approved_at: row.get("approved_at"),
    }))
}

``n
## §4 file: src-tauri/src/services/identity/recovery.rs
``rust
//! One-time supervised manager-password recovery (plan R1, Design B).
//!
//! Recovery builds only: this module is compiled only with
//! `--features recovery`. Production builds contain no recovery path at all,
//! which an architecture test pins by enumerating the registered commands
//! with and without the flag.
//!
//! # Honesty note
//!
//! Resetting a password without the old one is a bypass by construction. It
//! is contained, not disguised: the call itself is the supervised owner act
//! (the owner types the new password under supervision after explicit
//! approval), the approval row binds reference + device + target + reason,
//! consumption is atomic with the verifier write (at-most-once even across a
//! crash), every step is audited, old sessions die, and the build carrying
//! this module is replaced by a clean one immediately after use (R1-T7).

//! Whole-module gate: this file compiles only in recovery builds. The module
//! declaration in `services/identity/mod.rs` carries the same gate, so
//! removing either breaks the build loudly.
#![cfg(feature = "recovery")]

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::credentials as credential_repo;
use crate::data::repositories::identity::recovery as recovery_repo;
use crate::data::repositories::identity::session as session_repo;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::identity::{
    password_is_acceptable, CredentialVerifier, DomainError, Role, Timestamp, UserId,
};
use crate::services::identity::crypto;

/// Hash a password into a verifier, rejecting one that fails the policy first.
///
/// Mirrors the policy gate in `password.rs`: a rejected password costs no
/// hashing work and surfaces as a policy error, never as storage trouble.
fn verifier_for(password: &str) -> Result<CredentialVerifier, DomainError> {
    if !password_is_acceptable(password) {
        return Err(DomainError::WeakPassword);
    }
    let phc = crypto::hash_password(password).map_err(|_| DomainError::InvalidCredentials)?;
    CredentialVerifier::from_phc(phc)
}

/// Stage an owner approval for a later single execution.
///
/// The supervised owner act: the owner confirms the exact approval (plan R1,
/// Q2 wording) and the supervisor records it. An identical re-stage is
/// idempotent; a conflicting row for the same reference is refused. Nothing
/// about the password changes here.
pub async fn stage_approval(
    pool: &SqlitePool,
    reference: &str,
    device_id: &str,
    target: UserId,
    reason: &str,
    approved_by: &str,
) -> Result<(), DomainError> {
    let now = Timestamp::now();
    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    let staged = recovery_repo::Approval {
        reference: reference.to_string(),
        device_id: device_id.to_string(),
        target_user_id: target.as_str().to_string(),
        reason: reason.to_string(),
        approved_at: now.as_millis(),
    };
    match recovery_repo::find_by_reference(&mut tx, reference)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        None => recovery_repo::provision(&mut tx, &staged)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?,
        Some(stored) if stored.approval != staged || stored.consumed_at.is_some() => {
            return Err(DomainError::RecoveryNotApproved)
        }
        Some(_) => {}
    }

    audit::append(
        &mut tx,
        target,
        audit::event::RECOVERY_APPROVED,
        now,
        Some(format!(
            r#"{{"reference":"{}","device_id":"{}","approved_by":"{}"}}"#,
            reference, device_id, approved_by
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}

/// Execute a staged approval: consume it and set a temporary password on the
/// target manager, forcing a change at next sign-in.
///
/// No staged, unconsumed, device-matching approval exists — no reset, no
/// writes at all. Consumption shares the transaction with the verifier write
/// (at-most-once even across a crash), and the target is read from the staged
/// row, never from the caller, so an approval cannot be redirected to another
/// account.
pub async fn recover_manager_password(
    pool: &SqlitePool,
    reference: &str,
    device_id: &str,
    new_password: &str,
) -> Result<UserId, DomainError> {
    // Policy before any write: a weak password must not consume the approval.
    let verifier = verifier_for(new_password)?;
    let now = Timestamp::now();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    // Atomic consumption: crash before commit rolls back (safe retry with the
    // same reference), crash after commit leaves a consumed row (replay
    // refused). Either way at-most-once is structural.
    let consumed = recovery_repo::consume_if_unconsumed(&mut tx, reference, device_id, now.as_millis())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let staged = match consumed {
        Some(approval) => approval,
        None => {
            let status = recovery_repo::find_by_reference(&mut tx, reference)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
            return Err(match status {
                Some(stored) if stored.consumed_at.is_some() => DomainError::RecoveryAlreadyUsed,
                _ => DomainError::RecoveryNotApproved,
            });
        }
    };
    let target = UserId::from_uuid(
        staged
            .target_user_id
            .parse::<uuid::Uuid>()
            .map_err(|_| DomainError::RecoveryNotApproved)?,
    );

    // The approval names a live manager and nothing else. A missing, disabled
    // or non-manager target means the approval does not describe a
    // recoverable account.
    let user = user_repo::find_by_id(&mut tx, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::RecoveryNotApproved)?;
    if user.role != Role::Manager {
        return Err(DomainError::RecoveryNotApproved);
    }
    let disabled = user_repo::find_disabled_at(&mut tx, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .flatten()
        .is_some();
    if disabled {
        return Err(DomainError::RecoveryNotApproved);
    }

    user_repo::update_verifier(&mut tx, target, &verifier, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    credential_repo::set_must_change_password(&mut tx, target, true)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let revoked = session_repo::delete_by_user(&mut tx, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        target,
        audit::event::PASSWORD_RESET,
        now,
        Some(format!(
            r#"{{"target":"{}","sessions_revoked":{},"via":"recovery"}}"#,
            target.as_str(),
            revoked
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        target,
        audit::event::RECOVERY_EXECUTED,
        now,
        Some(format!(
            r#"{{"reference":"{}","device_id":"{}"}}"#,
            reference, device_id
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(target)
}

``n
## §4 file: src-tauri/src/commands/recovery.rs
``rust
//! Tauri commands for one-time supervised manager-password recovery.
//!
//! Recovery builds only (`--features recovery`). Without the flag this module
//! does not exist and `lib.rs` registers nothing from it, so a production
//! build cannot expose the recovery path — an architecture test pins that
//! property by scanning these sources.
//!
//! Transport boundaries only. No SQL and no business rule appears here. Like
//! every other command module, no command accepts a token, a user id that
//! asserts identity, a role, or an actor: the target of the recovery is read
//! from the staged approval row inside the use case, and the only identifiers
//! crossing here are the approval reference, the device id, and the new
//! password the owner typed under supervision.

#![cfg(feature = "recovery")]

use serde::Serialize;
use tauri::State;

use crate::domain::identity::{DomainError, UserId};
use crate::services::identity::recovery as recovery_use_cases;
use crate::services::identity::IdentityContext;

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure crossing the boundary is a stable code, never prose.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCommandError {
    pub code: &'static str,
}

impl From<DomainError> for RecoveryCommandError {
    fn from(error: DomainError) -> Self {
        Self {
            code: error.code(),
        }
    }
}

fn parse_user_id(raw: &str) -> Result<UserId, DomainError> {
    // An unparseable target means the approval does not name a recoverable
    // account. It is deliberately not `UserNotFound`/`INVALID_CREDENTIALS`:
    // that code would tell the operator their password is wrong when the
    // problem is the approval itself.
    uuid::Uuid::parse_str(raw)
        .map(UserId::from_uuid)
        .map_err(|_| DomainError::RecoveryNotApproved)
}

/// Record the owner's explicit approval for one later execution.
///
/// The supervisor calls this while the owner confirms the exact approval
/// wording (plan R1, Q2). Nothing about any password changes here.
#[tauri::command]
pub async fn stage_recovery_approval(
    ctx: Ctx<'_>,
    reference: String,
    device_id: String,
    target_user_id: String,
    reason: String,
    approved_by: String,
) -> Result<(), RecoveryCommandError> {
    recovery_use_cases::stage_approval(
        &ctx.pool,
        &reference,
        &device_id,
        parse_user_id(&target_user_id)?,
        &reason,
        &approved_by,
    )
    .await
    .map_err(RecoveryCommandError::from)?;
    Ok(())
}

/// Consume a staged approval and set a temporary password on its target.
///
/// Returns the recovered account's id so the frontend can continue to the
/// normal forced-change screen. Fails closed without a matching unconsumed
/// approval, and a consumed approval fails closed on replay.
#[tauri::command]
pub async fn execute_manager_recovery(
    ctx: Ctx<'_>,
    reference: String,
    device_id: String,
    new_password: String,
) -> Result<String, RecoveryCommandError> {
    let target =
        recovery_use_cases::recover_manager_password(&ctx.pool, &reference, &device_id, &new_password)
            .await
            .map_err(RecoveryCommandError::from)?;
    Ok(target.as_str())
}

``n
## §4 file: src-tauri/tests/integration/recovery.rs
``rust
//! Single-use recovery approvals against real SQLite.
//!
//! Provision, atomic consume-if-unconsumed, and replay refusal. No password
//! logic appears here: this module proves the gate's single-use property, and
//! the reset itself is proved in the use-case tests.

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::data::repositories::identity::recovery;
use mobile_shop_system_lib::domain::identity::Timestamp;
use mobile_shop_system_lib::services::identity::bootstrap;

const DEVICE: &str = "R3CMA016SEJ";
const REASON: &str = "lost first-run password";

fn approval() -> recovery::Approval {
    let now = Timestamp::now().as_millis();
    recovery::Approval {
        reference: "R1-20261010-01".to_string(),
        device_id: DEVICE.to_string(),
        // Filled by the caller after creating the manager; a placeholder here
        // keeps the constructor honest about requiring a real target.
        target_user_id: String::new(),
        reason: REASON.to_string(),
        approved_at: now,
    }
}

#[tokio::test]
async fn approval_consumes_exactly_once_then_refuses_replay() {
    let (pool, _tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    let mut wanted = approval();
    wanted.target_user_id = created.user_id.as_str().to_string();

    let mut conn = pool.acquire().await.expect("connection");
    recovery::provision(&mut conn, &wanted)
        .await
        .expect("provision");

    let now = || Timestamp::now().as_millis();

    // First consume wins and returns the row.
    let consumed = recovery::consume_if_unconsumed(&mut conn, &wanted.reference, DEVICE, now())
        .await
        .expect("consume");
    assert!(consumed.is_some(), "an unconsumed approval must be consumed");
    assert_eq!(consumed.expect("row").reference, wanted.reference);

    // Replay, wrong device, and unknown reference all refuse without a row.
    let replay = recovery::consume_if_unconsumed(&mut conn, &wanted.reference, DEVICE, now())
        .await
        .expect("replay");
    assert!(replay.is_none(), "a consumed approval must never be consumed twice");
    let wrong_device =
        recovery::consume_if_unconsumed(&mut conn, &wanted.reference, "OTHER-DEVICE", now())
            .await
            .expect("wrong device");
    assert!(wrong_device.is_none());
    let unknown =
        recovery::consume_if_unconsumed(&mut conn, "R1-20261010-99", DEVICE, now())
            .await
            .expect("unknown");
    assert!(unknown.is_none());
}

#[tokio::test]
async fn duplicate_reference_is_rejected() {
    let (pool, _tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    let mut wanted = approval();
    wanted.target_user_id = created.user_id.as_str().to_string();

    let mut conn = pool.acquire().await.expect("connection");
    recovery::provision(&mut conn, &wanted)
        .await
        .expect("first provision");
    recovery::provision(&mut conn, &wanted)
        .await
        .expect_err("a reference must be single-use from the moment it exists");
}

``n
## §4 file: src-tauri/tests/integration/recovery_reset.rs
``rust
//! Single-use manager-password recovery against real SQLite.
//!
//! Fail-closed without approval, exactly-once execution, replay refusal and
//! wrong-device refusal. Runs only with the `recovery` feature: production
//! builds never contain this path.

#![cfg(feature = "recovery")]

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::domain::identity::DomainError;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, recovery};
use sqlx::SqlitePool;

const DEVICE: &str = "R3CMA016SEJ";
const REFERENCE: &str = "R1-20261010-01";
const REASON: &str = "lost first-run password";
const APPROVED_BY: &str = "owner";
const TEMPORARY: &str = "temporary rescue phrase";

async fn audit_count(pool: &SqlitePool, event: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE event_type = ?1")
        .bind(event)
        .fetch_one(pool)
        .await
        .expect("audit count")
}

#[tokio::test]
async fn without_approval_nothing_is_written() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    let refused = recovery::recover_manager_password(
        &pool,
        "R1-20261010-99",
        DEVICE,
        TEMPORARY,
    )
    .await
    .expect_err("no approval row, no reset");
    assert_eq!(refused, DomainError::RecoveryNotApproved);

    // The old password still works: the verifier was not touched.
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("verifier untouched");
    assert_eq!(audit_count(&pool, "password_reset").await, 0);
    assert_eq!(audit_count(&pool, "recovery_executed").await, 0);
}

#[tokio::test]
async fn staged_approval_executes_exactly_once() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    recovery::stage_approval(
        &pool,
        REFERENCE,
        DEVICE,
        created.user_id,
        REASON,
        APPROVED_BY,
    )
    .await
    .expect("stage");
    assert_eq!(audit_count(&pool, "recovery_approved").await, 1);

    let target = recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("execute");
    assert_eq!(target, created.user_id);

    // Old password dead, temporary works, forced change flagged.
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect_err("old password must stop working");
    auth::login(&pool, tokens.as_ref(), created.user_id, TEMPORARY)
        .await
        .expect("temporary password works");
    let must_change: i64 =
        sqlx::query_scalar("SELECT must_change_password FROM user_credentials WHERE user_id = ?1")
            .bind(created.user_id.as_str())
            .fetch_one(&pool)
            .await
            .expect("credentials row");
    assert_eq!(must_change, 1);
    assert_eq!(audit_count(&pool, "password_reset").await, 1);
    assert_eq!(audit_count(&pool, "recovery_executed").await, 1);

    // Replay with the same reference refuses and changes nothing.
    let replay = recovery::recover_manager_password(&pool, REFERENCE, DEVICE, "another rescue phrase")
        .await
        .expect_err("single use");
    assert_eq!(replay, DomainError::RecoveryAlreadyUsed);
    auth::login(&pool, tokens.as_ref(), created.user_id, TEMPORARY)
        .await
        .expect("temporary still the password after refused replay");
    assert_eq!(audit_count(&pool, "recovery_executed").await, 1);
}

#[tokio::test]
async fn wrong_device_and_conflicting_stage_refuse() {
    let (pool, _tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    recovery::stage_approval(
        &pool,
        REFERENCE,
        DEVICE,
        created.user_id,
        REASON,
        APPROVED_BY,
    )
    .await
    .expect("stage");

    let wrong_device =
        recovery::recover_manager_password(&pool, REFERENCE, "OTHER-DEVICE", TEMPORARY)
            .await
            .expect_err("device binding");
    assert_eq!(wrong_device, DomainError::RecoveryNotApproved);

    let conflict = recovery::stage_approval(
        &pool,
        REFERENCE,
        DEVICE,
        created.user_id,
        "a different reason",
        APPROVED_BY,
    )
    .await
    .expect_err("conflicting re-stage");
    assert_eq!(conflict, DomainError::RecoveryNotApproved);

    // Nothing consumed by the refusals: the real execution still works.
    recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("execute after refusals");
}

#[tokio::test]
async fn weak_temporary_password_does_not_consume_the_approval() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    recovery::stage_approval(
        &pool,
        REFERENCE,
        DEVICE,
        created.user_id,
        REASON,
        APPROVED_BY,
    )
    .await
    .expect("stage");

    let weak = recovery::recover_manager_password(&pool, REFERENCE, DEVICE, "short")
        .await
        .expect_err("policy first");
    assert_eq!(weak, DomainError::WeakPassword);

    recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("approval survived the weak attempt");
    auth::login(&pool, tokens.as_ref(), created.user_id, TEMPORARY)
        .await
        .expect("temporary works");
}

``n
## §5 plan + tasks (unfenced markdown follows)

# Implementation Plan: One-Time Manager Recovery (R1)

## Overview
Implement the approved recovery Spec
(`docs/superpowers/plans/2026-10-10-manager-recovery-spec.md`) as a
single-use, owner-supervised path that resets the `ShopManager1` password on
the shop device, preserves data + audit, rotates credentials/sessions/Pattern,
then closes the path. Production builds must never ship the bypass.

## Architecture Decisions
- **Recommended: Design B (recovery-gated build).** New `recovery` cargo
  feature gates the command + use case; production APKs build without it, so
  the bypass cannot exist in shipped code. Rationale over Design A (command
  added then removed): removal is verified by build graph, not by remembering
  to delete code; the architecture test already enumerates commands per
  module and will pin the gate.
- **Approval artifact:** single-use row in a new `recovery_approval` table
  (migration `0009`), consumed transactionally with the reset. Provisioned
  only during the supervised session, from the owner's explicit go-ahead
  (exact provisioning handshake fixed at plan approval — see Open Questions).
- **Audit:** new `RECOVERY_APPROVED` + `RECOVERY_EXECUTED` events; existing
  `PASSWORD_RESET` reused for the verifier change with target + sessions
  revoked, per `password.rs` convention. Never log passwords/verifiers.
- **Post-reset state:** `must_change_password = true` so the owner sets the
  final password through the normal forced-change screen; all sessions
  revoked; Pattern re-established by the owner afterwards.

## Dependency Graph
```
domain errors (codes)
    └── migration 0009 + repo fns
            └── recovery use case (fail-closed, single-use, audited)
                    ├── command boundary (+ lib.rs gate + arch test)
                    └── frontend minimal screen + Arabic messages
                            └── integration tests (all six spec cases)
                                    └── recovery APK → supervised device run
                                            └── verify → close path → clean build → ADR
```

## Task List

### Phase 1: Fail-closed foundation
- [ ] R1-T1: Domain errors `RecoveryNotApproved`, `RecoveryAlreadyUsed` with
  stable codes + unit tests.
- [ ] R1-T2: Migration `0009_recovery_approval.sql` + repository fns
  (provision/consume-if-unconsumed) + tests.
### Checkpoint: Foundation
- [ ] `cargo test -p mobile-shop-system identity` green; nothing callable yet.
### Phase 2: Use case + boundary (vertical slice, no UI)
- [ ] R1-T3: Recovery use case (approval consumed transactionally with
  verifier replace + `must_change_password=true` + sessions revoked + audit)
  with fail-closed, replay, and wrong-approval tests.
- [ ] R1-T4: `recovery` feature gate + Tauri command + `lib.rs` registration
  + architecture-test pin + Arabic error codes on frontend.
### Checkpoint: Slice complete
- [ ] Full `cargo test` green; command absent without the feature flag.
- [ ] Human review before any device build.
### Phase 3: Supervised device run (owner present)
- [ ] R1-T5: Build recovery APK, install `-r`, supervised execution, verify
  new-password login.
- [ ] R1-T6: Owner sets final password via forced-change screen,
  re-establishes Pattern, reads `TEST-MA-1` (separate costing gate).
### Checkpoint: Access restored
- [ ] Login evidenced; `TEST-MA-1` result recorded; audit chain inspected.
### Phase 4: Closure
- [ ] R1-T7: Remove/close path, clean production build, reinstall, verify
  recovery command absent, record ADR.
### Checkpoint: Complete
- [ ] All spec success criteria evidenced; `Costing` gate revisited separately.

## Risks and Mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Failed logins lock the account (5 max, 15 min) | Med | No further guesses; recovery path does not go through `login` |
| Keystore session leftovers across `-r` reinstall | Med | Revoke all sessions in the reset tx; verify `whoami=None` before run |
| Approval row replay | High | Consume-if-unconsumed in the same tx as the verifier write |
| Recovery build leaks beyond this device | High | Single-use approval bound to device id + date; path closed + clean build after |
| Scope creep into costing/inventory | Med | Recovery touches identity tables only; tests assert no stock writes |

## Open Questions (for plan approval)
1. Design B confirmed, or Design A instead?
2. Approval provisioning handshake: owner reads aloud a statement (device id +
   date + reason) that the supervisor inserts via the recovery screen, then it
   is consumed — acceptable?
3. New Pattern value chosen in the same supervised session?

## Task list target
Tasks mirrored in `tasks/todo.md` under "R1 Recovery". This file is the
authoritative plan.

---

## R1 Recovery — one-time supervised manager-password recovery (plan: tasks/plan-recovery.md)

- [x] R1-T1: Domain errors RecoveryNotApproved/RecoveryAlreadyUsed + unit tests
  - Acceptance: stable codes asserted; unknown code rejected
  - Verify: cargo test -p mobile-shop-system identity
  - Files: src-tauri/src/domain/identity/error.rs
- [x] R1-T2: Migration 0009_recovery_approval.sql + repo fns + tests
  - Acceptance: provision + consume-if-unconsumed atomic; replay refused
  - Verify: cargo test -p mobile-shop-system identity
  - Files: src-tauri/src/data/migrations/0009_recovery_approval.sql, identity repo
- [x] R1-T3: Recovery use case + fail-closed/replay tests
  - Acceptance: no approval = no write; one approval = exactly one reset + audit + sessions revoked
  - Verify: cargo test
  - Files: src-tauri/src/services/identity/ (+ new recovery.rs)
- [x] R1-T4: recovery feature gate + command + arch-test pin + Arabic codes
  - Acceptance: command absent without flag; stable codes only across IPC
  - Verify: cargo test; build with/without --features recovery
  - Files: src-tauri/src/commands/, src-tauri/src/lib.rs, src/api/

## Checkpoint: R1 slice complete (human review before any device build)

- [ ] Full suite green; recovery unreachable in production build
- [ ] Plan questions Q1–Q3 answered (design, approval handshake, Pattern)

- [ ] R1-T5: Recovery APK + supervised device run + new-password login
- [ ] R1-T6: Forced-change final password + Pattern re-setup + TEST-MA-1 read
- [ ] R1-T7: Close path + clean build + reinstall + verify absence + ADR
---

# §6 Fix addendum (F1-F4) — verdict fixes, uncommitted code at review time

Base: same 32e7515 working tree; prior reviewed docs: commit 44d1a80. This section overlays the reviewed slice.

## §6 file: src-tauri/src/services/identity/recovery.rs
``rust
//! One-time supervised manager-password recovery (plan R1, Design B).
//!
//! Recovery builds only: this module is compiled only with
//! `--features recovery`. Production builds contain no recovery path at all,
//! which an architecture test pins by enumerating the registered commands
//! with and without the flag.
//!
//! # Honesty note
//!
//! Resetting a password without the old one is a bypass by construction. It
//! is contained, not disguised: the call itself is the supervised owner act
//! (the owner types the new password under supervision after explicit
//! approval), the approval row binds reference + device + target + reason,
//! consumption is atomic with the verifier write (at-most-once even across a
//! crash), every step is audited, old sessions die, and the build carrying
//! this module is replaced by a clean one immediately after use (R1-T7).

//! Whole-module gate: this file compiles only in recovery builds. The module
//! declaration in `services/identity/mod.rs` carries the same gate, so
//! removing either breaks the build loudly.
#![cfg(feature = "recovery")]

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::credentials as credential_repo;
use crate::data::repositories::identity::pattern as pattern_repo;
use crate::data::repositories::identity::recovery as recovery_repo;
use crate::data::repositories::identity::session as session_repo;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::identity::{
    password_is_acceptable, CredentialVerifier, DomainError, Role, Timestamp, UserId,
};
use crate::services::identity::crypto;

/// Hash a password into a verifier, rejecting one that fails the policy first.
///
/// Mirrors the policy gate in `password.rs`: a rejected password costs no
/// hashing work and surfaces as a policy error, never as storage trouble.
fn verifier_for(password: &str) -> Result<CredentialVerifier, DomainError> {
    if !password_is_acceptable(password) {
        return Err(DomainError::WeakPassword);
    }
    let phc = crypto::hash_password(password).map_err(|_| DomainError::InvalidCredentials)?;
    CredentialVerifier::from_phc(phc)
}

/// Stage an owner approval for a later single execution.
///
/// The supervised owner act: the owner confirms the exact approval (plan R1,
/// Q2 wording), enters the CURRENT device Pattern, and the supervisor records
/// the approval. The Pattern check is the same credential check the Pattern
/// service itself performs (`pattern_repo::find` + `crypto::verify_password`,
/// same codes) — no session exists to stamp, and none is created.
///
/// An identical re-stage is a silent no-op (one row, one approval event): the
/// stable fields — reference, device, target, reason — define identity, and
/// `approved_at` deliberately does not, so a retry is never misread as a
/// conflict. A conflicting row, or any re-stage of a consumed approval,
/// fails closed and writes nothing.
pub async fn stage_approval(
    pool: &SqlitePool,
    reference: &str,
    device_id: &str,
    target: UserId,
    reason: &str,
    approved_by: &str,
    pattern: &str,
) -> Result<(), DomainError> {
    // The permission barrier (verdict fix F1): knowledge of the current device
    // Pattern, checked before anything is written. Argon2 work per attempt is
    // the brute-force throttle, exactly as in the Pattern verify path. No
    // audit event on refusal — matching `verify`, which audits neither way —
    // and no approval row.
    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let stored = pattern_repo::find(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::PatternNotConfigured)?;
    if !crypto::verify_password(pattern, &stored.verifier) {
        return Err(DomainError::InvalidCredentials);
    }
    drop(conn);

    let now = Timestamp::now();
    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    let staged = recovery_repo::Approval {
        reference: reference.to_string(),
        device_id: device_id.to_string(),
        target_user_id: target.as_str().to_string(),
        reason: reason.to_string(),
        approved_at: now.as_millis(),
    };
    match recovery_repo::find_by_reference(&mut tx, reference)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        None => recovery_repo::provision(&mut tx, &staged)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?,
        Some(stored) if stored.consumed_at.is_some() => {
            return Err(DomainError::RecoveryAlreadyUsed)
        }
        Some(stored) if !stored.approval.same_stable_fields(&staged) => {
            return Err(DomainError::RecoveryNotApproved)
        }
        // Identical and unconsumed: a retry, not a new approval. No second
        // row (the key forbids it) and no second event (it would mislead).
        Some(_) => return Ok(()),
    }

    audit::append(
        &mut tx,
        target,
        audit::event::RECOVERY_APPROVED,
        now,
        Some(format!(
            r#"{{"reference":"{}","device_id":"{}","approved_by":"{}"}}"#,
            reference, device_id, approved_by
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}

/// Execute a staged approval: consume it and set a temporary password on the
/// target manager, forcing a change at next sign-in.
///
/// No staged, unconsumed, device-matching approval exists — no reset, no
/// writes at all. Consumption shares the transaction with the verifier write
/// (at-most-once even across a crash), and the target is read from the staged
/// row, never from the caller, so an approval cannot be redirected to another
/// account. The `device_id` argument is likewise checked against the staged
/// row — the value the owner authenticated with the Pattern at staging time
/// (verdict fix F2) — so a mismatch refuses even though both strings cross
/// the same transport: one of them is anchored in owner-authenticated state.
pub async fn recover_manager_password(
    pool: &SqlitePool,
    reference: &str,
    device_id: &str,
    new_password: &str,
) -> Result<UserId, DomainError> {
    // Policy before any write: a weak password must not consume the approval.
    let verifier = verifier_for(new_password)?;
    let now = Timestamp::now();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    // Atomic consumption: crash before commit rolls back (safe retry with the
    // same reference), crash after commit leaves a consumed row (replay
    // refused). Either way at-most-once is structural.
    let consumed = recovery_repo::consume_if_unconsumed(&mut tx, reference, device_id, now.as_millis())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let staged = match consumed {
        Some(approval) => approval,
        None => {
            let status = recovery_repo::find_by_reference(&mut tx, reference)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
            return Err(match status {
                Some(stored) if stored.consumed_at.is_some() => DomainError::RecoveryAlreadyUsed,
                _ => DomainError::RecoveryNotApproved,
            });
        }
    };
    let target = UserId::from_uuid(
        staged
            .target_user_id
            .parse::<uuid::Uuid>()
            .map_err(|_| DomainError::RecoveryNotApproved)?,
    );

    // The approval names a live manager and nothing else. A missing, disabled
    // or non-manager target means the approval does not describe a
    // recoverable account.
    let user = user_repo::find_by_id(&mut tx, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::RecoveryNotApproved)?;
    if user.role != Role::Manager {
        return Err(DomainError::RecoveryNotApproved);
    }
    let disabled = user_repo::find_disabled_at(&mut tx, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .flatten()
        .is_some();
    if disabled {
        return Err(DomainError::RecoveryNotApproved);
    }

    user_repo::update_verifier(&mut tx, target, &verifier, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    credential_repo::set_must_change_password(&mut tx, target, true)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let revoked = session_repo::delete_by_user(&mut tx, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        target,
        audit::event::PASSWORD_RESET,
        now,
        Some(format!(
            r#"{{"target":"{}","sessions_revoked":{},"via":"recovery"}}"#,
            target.as_str(),
            revoked
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        target,
        audit::event::RECOVERY_EXECUTED,
        now,
        Some(format!(
            r#"{{"reference":"{}","device_id":"{}"}}"#,
            reference, device_id
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(target)
}

``n
## §6 file: src-tauri/src/commands/recovery.rs
``rust
//! Tauri commands for one-time supervised manager-password recovery.
//!
//! Recovery builds only (`--features recovery`). Without the flag this module
//! does not exist and `lib.rs` registers nothing from it, so a production
//! build cannot expose the recovery path — an architecture test pins that
//! property by scanning these sources.
//!
//! Transport boundaries only. No SQL and no business rule appears here. Like
//! every other command module, no command accepts a token, a user id that
//! asserts identity, a role, or an actor: the target of the recovery is read
//! from the staged approval row inside the use case, and the only identifiers
//! crossing here are the approval reference, the device id, and the new
//! password the owner typed under supervision.

#![cfg(feature = "recovery")]

use serde::Serialize;
use tauri::State;

use crate::domain::identity::{DomainError, UserId};
use crate::services::identity::recovery as recovery_use_cases;
use crate::services::identity::IdentityContext;

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure crossing the boundary is a stable code, never prose.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCommandError {
    pub code: &'static str,
}

impl From<DomainError> for RecoveryCommandError {
    fn from(error: DomainError) -> Self {
        Self {
            code: error.code(),
        }
    }
}

fn parse_user_id(raw: &str) -> Result<UserId, DomainError> {
    // An unparseable target means the approval does not name a recoverable
    // account. It is deliberately not `UserNotFound`/`INVALID_CREDENTIALS`:
    // that code would tell the operator their password is wrong when the
    // problem is the approval itself.
    uuid::Uuid::parse_str(raw)
        .map(UserId::from_uuid)
        .map_err(|_| DomainError::RecoveryNotApproved)
}

/// Record the owner's explicit approval for one later execution.
///
/// The supervisor calls this while the owner confirms the exact approval
/// wording (plan R1, Q2) and enters the CURRENT device Pattern. Staging
/// refuses without the Pattern (verdict fix F1). Nothing about any password
/// changes here.
#[tauri::command]
pub async fn stage_recovery_approval(
    ctx: Ctx<'_>,
    reference: String,
    device_id: String,
    target_user_id: String,
    reason: String,
    approved_by: String,
    pattern: String,
) -> Result<(), RecoveryCommandError> {
    recovery_use_cases::stage_approval(
        &ctx.pool,
        &reference,
        &device_id,
        parse_user_id(&target_user_id)?,
        &reason,
        &approved_by,
        &pattern,
    )
    .await
    .map_err(RecoveryCommandError::from)?;
    Ok(())
}

/// Consume a staged approval and set a temporary password on its target.
///
/// The caller-supplied `device_id` is compared against the STAGED row — the
/// value the owner authenticated with the Pattern at staging time (verdict
/// fix F2) — never against another caller-supplied value in the same call.
/// Mismatch refuses. No platform hardware identifier is claimed: on this
/// offline V1 build the device binding is consistency enforcement plus
/// supervisor verification against the physical device, documented as
/// procedural rather than an independent attestation barrier.
///
/// Returns the recovered account's id so the frontend can continue to the
/// normal forced-change screen. Fails closed without a matching unconsumed
/// approval, and a consumed approval fails closed on replay.
#[tauri::command]
pub async fn execute_manager_recovery(
    ctx: Ctx<'_>,
    reference: String,
    device_id: String,
    new_password: String,
) -> Result<String, RecoveryCommandError> {
    let target =
        recovery_use_cases::recover_manager_password(&ctx.pool, &reference, &device_id, &new_password)
            .await
            .map_err(RecoveryCommandError::from)?;
    Ok(target.as_str())
}

``n
## §6 file: src-tauri/src/data/repositories/identity/recovery.rs
``rust
//! Single-use recovery approvals.
//!
//! One row per owner-approved reset. Provisioning and consumption are separate
//! calls so tests can prove each half, but the use case consumes the row in
//! the *same transaction* as the verifier write: crash before commit rolls
//! back (safe retry), crash after commit leaves a consumed row (replay
//! refused). No secret ever appears here — reference, device, target and
//! reason only.

use sqlx::{Row, SqliteConnection};

/// An owner-approved reset that has not necessarily been executed yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approval {
    pub reference: String,
    pub device_id: String,
    pub target_user_id: String,
    pub reason: String,
    pub approved_at: i64,
}

impl Approval {
    /// Whether two approvals describe the same grant.
    ///
    /// `approved_at` deliberately does not participate: it records when the
    /// row was written, so a retried staging would otherwise misread as a
    /// conflict (verdict fix F3). Identity is reference + device + target +
    /// reason.
    pub fn same_stable_fields(&self, other: &Approval) -> bool {
        self.reference == other.reference
            && self.device_id == other.device_id
            && self.target_user_id == other.target_user_id
            && self.reason == other.reason
    }
}

/// Record an approval. A duplicate reference is an error: a reference is
/// single-use from the moment it exists.
pub async fn provision(conn: &mut SqliteConnection, approval: &Approval) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO recovery_approval
            (reference, device_id, target_user_id, reason, approved_at, consumed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
    )
    .bind(&approval.reference)
    .bind(&approval.device_id)
    .bind(&approval.target_user_id)
    .bind(&approval.reason)
    .bind(approval.approved_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// An approval row as stored, including its consumption state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredApproval {
    pub approval: Approval,
    /// `None` while the approval is still usable.
    pub consumed_at: Option<i64>,
}

/// The row for a reference, or `None` when no such approval was ever staged.
pub async fn find_by_reference(
    conn: &mut SqliteConnection,
    reference: &str,
) -> Result<Option<StoredApproval>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT reference, device_id, target_user_id, reason, approved_at, consumed_at
         FROM recovery_approval WHERE reference = ?1",
    )
    .bind(reference)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|row| StoredApproval {
        approval: Approval {
            reference: row.get("reference"),
            device_id: row.get("device_id"),
            target_user_id: row.get("target_user_id"),
            reason: row.get("reason"),
            approved_at: row.get("approved_at"),
        },
        consumed_at: row.get("consumed_at"),
    }))
}
/// Consume an approval if — and only if — it exists for this device and is
/// still unconsumed. Returns the row on success, `None` otherwise: unknown
/// reference, wrong device and replay are indistinguishable by design, so a
/// probe discloses nothing about which approvals exist.
pub async fn consume_if_unconsumed(
    conn: &mut SqliteConnection,
    reference: &str,
    device_id: &str,
    consumed_at: i64,
) -> Result<Option<Approval>, sqlx::Error> {
    let row = sqlx::query(
        "UPDATE recovery_approval
         SET consumed_at = ?3
         WHERE reference = ?1 AND device_id = ?2 AND consumed_at IS NULL
         RETURNING reference, device_id, target_user_id, reason, approved_at",
    )
    .bind(reference)
    .bind(device_id)
    .bind(consumed_at)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|row| Approval {
        reference: row.get("reference"),
        device_id: row.get("device_id"),
        target_user_id: row.get("target_user_id"),
        reason: row.get("reason"),
        approved_at: row.get("approved_at"),
    }))
}

``n
## §6 file: src-tauri/tests/integration/recovery_reset.rs
``rust
//! Single-use manager-password recovery against real SQLite.
//!
//! Fail-closed without approval, exactly-once execution, replay refusal and
//! wrong-device refusal. Runs only with the `recovery` feature: production
//! builds never contain this path.

#![cfg(feature = "recovery")]

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::domain::identity::DomainError;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, recovery, session};
use mobile_shop_system_lib::services::pattern;
use sqlx::SqlitePool;
use std::sync::Arc;

const DEVICE: &str = "R3CMA016SEJ";
const REFERENCE: &str = "R1-20261010-01";
const REASON: &str = "lost first-run password";
const APPROVED_BY: &str = "owner";
const TEMPORARY: &str = "temporary rescue phrase";
/// The device Pattern, configured exactly as the owner configured it on the
/// device. Verdict fix F1 stages only behind this secret.
const PATTERN: &str = "open sesame";

/// First manager, signed in, re-authenticated, Pattern configured — the
/// in-test analogue of the device state (verdict fix F1).
async fn manager_with_pattern() -> (SqlitePool, Arc<InMemoryTokenStore>) {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("re-authenticate");
    pattern::set(&pool, tokens.as_ref(), PATTERN)
        .await
        .expect("set pattern");
    (pool, tokens)
}

#[tokio::test]
async fn staging_refuses_a_wrong_pattern_and_writes_nothing() {
    // Verdict fix F1 acceptance: no approval row and no RECOVERY_APPROVED
    // event when the current Pattern check fails.
    let (pool, _tokens) = manager_with_pattern().await;
    let target = super::manager_of(&pool).await;

    let refused = recovery::stage_approval(
        &pool, REFERENCE, DEVICE, target, REASON, APPROVED_BY, "wrong pattern",
    )
    .await
    .expect_err("wrong Pattern must refuse staging");
    assert_eq!(refused, DomainError::InvalidCredentials);

    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recovery_approval")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(rows, 0, "refused staging writes no approval row");
    assert_eq!(audit_count(&pool, "recovery_approved").await, 0);
}

#[tokio::test]
async fn staging_refuses_when_no_pattern_is_configured() {
    let (pool, _tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    let refused = recovery::stage_approval(
        &pool, REFERENCE, DEVICE, created.user_id, REASON, APPROVED_BY, PATTERN,
    )
    .await
    .expect_err("no Pattern configured must fail closed");
    assert_eq!(refused, DomainError::PatternNotConfigured);
}

async fn audit_count(pool: &SqlitePool, event: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE event_type = ?1")
        .bind(event)
        .fetch_one(pool)
        .await
        .expect("audit count")
}

#[tokio::test]
async fn without_approval_nothing_is_written() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    let refused = recovery::recover_manager_password(
        &pool,
        "R1-20261010-99",
        DEVICE,
        TEMPORARY,
    )
    .await
    .expect_err("no approval row, no reset");
    assert_eq!(refused, DomainError::RecoveryNotApproved);

    // The old password still works: the verifier was not touched.
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("verifier untouched");
    assert_eq!(audit_count(&pool, "password_reset").await, 0);
    assert_eq!(audit_count(&pool, "recovery_executed").await, 0);
}

#[tokio::test]
async fn staged_approval_executes_exactly_once() {
    let (pool, tokens) = manager_with_pattern().await;
    let created = super::manager_of(&pool).await;

    recovery::stage_approval(
        &pool,
        REFERENCE,
        DEVICE,
        created,
        REASON,
        APPROVED_BY,
        PATTERN,
    )
    .await
    .expect("stage");
    assert_eq!(audit_count(&pool, "recovery_approved").await, 1);

    let target = recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("execute");
    assert_eq!(target, created);

    // Old password dead, temporary works, forced change flagged.
    auth::login(&pool, tokens.as_ref(), created, PASSWORD)
        .await
        .expect_err("old password must stop working");
    auth::login(&pool, tokens.as_ref(), created, TEMPORARY)
        .await
        .expect("temporary password works");
    let must_change: i64 =
        sqlx::query_scalar("SELECT must_change_password FROM user_credentials WHERE user_id = ?1")
            .bind(created.as_str())
            .fetch_one(&pool)
            .await
            .expect("credentials row");
    assert_eq!(must_change, 1);
    assert_eq!(audit_count(&pool, "password_reset").await, 1);
    assert_eq!(audit_count(&pool, "recovery_executed").await, 1);

    // Replay with the same reference refuses and changes nothing.
    let replay = recovery::recover_manager_password(&pool, REFERENCE, DEVICE, "another rescue phrase")
        .await
        .expect_err("single use");
    assert_eq!(replay, DomainError::RecoveryAlreadyUsed);
    auth::login(&pool, tokens.as_ref(), created, TEMPORARY)
        .await
        .expect("temporary still the password after refused replay");
    assert_eq!(audit_count(&pool, "recovery_executed").await, 1);
}

#[tokio::test]
async fn wrong_device_and_conflicting_stage_refuse() {
    let (pool, _tokens) = manager_with_pattern().await;
    let created = super::manager_of(&pool).await;

    recovery::stage_approval(
        &pool,
        REFERENCE,
        DEVICE,
        created,
        REASON,
        APPROVED_BY,
        PATTERN,
    )
    .await
    .expect("stage");

    let wrong_device =
        recovery::recover_manager_password(&pool, REFERENCE, "OTHER-DEVICE", TEMPORARY)
            .await
            .expect_err("device binding");
    assert_eq!(wrong_device, DomainError::RecoveryNotApproved);

    let conflict = recovery::stage_approval(
        &pool,
        REFERENCE,
        DEVICE,
        created,
        "a different reason",
        APPROVED_BY,
        PATTERN,
    )
    .await
    .expect_err("conflicting re-stage");
    assert_eq!(conflict, DomainError::RecoveryNotApproved);

    // Nothing consumed by the refusals: the real execution still works.
    recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("execute after refusals");
}

#[tokio::test]
async fn identical_restage_is_a_silent_noop() {
    // Verdict fix F3: retrying the same approval must not create a second row
    // nor a misleading second approval event. `approved_at` differs between
    // attempts and must not participate in the identity comparison.
    let (pool, _tokens) = manager_with_pattern().await;
    let created = super::manager_of(&pool).await;

    recovery::stage_approval(
        &pool, REFERENCE, DEVICE, created, REASON, APPROVED_BY, PATTERN,
    )
    .await
    .expect("first stage");
    recovery::stage_approval(
        &pool, REFERENCE, DEVICE, created, REASON, APPROVED_BY, PATTERN,
    )
    .await
    .expect("identical re-stage is a no-op, not a conflict");

    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recovery_approval")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(rows, 1, "one approval row, not two");
    assert_eq!(audit_count(&pool, "recovery_approved").await, 1);

    // And the single approval still executes exactly once.
    recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("execute after restage");
}

#[tokio::test]
async fn consumed_approval_cannot_be_restaged() {
    let (pool, _tokens) = manager_with_pattern().await;
    let created = super::manager_of(&pool).await;

    recovery::stage_approval(
        &pool, REFERENCE, DEVICE, created, REASON, APPROVED_BY, PATTERN,
    )
    .await
    .expect("stage");
    recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("execute");

    let revived = recovery::stage_approval(
        &pool, REFERENCE, DEVICE, created, REASON, APPROVED_BY, PATTERN,
    )
    .await
    .expect_err("a consumed approval cannot be revived");
    assert_eq!(revived, DomainError::RecoveryAlreadyUsed);
}

#[tokio::test]
async fn weak_temporary_password_does_not_consume_the_approval() {
    let (pool, tokens) = manager_with_pattern().await;
    let created = super::manager_of(&pool).await;

    recovery::stage_approval(
        &pool,
        REFERENCE,
        DEVICE,
        created,
        REASON,
        APPROVED_BY,
        PATTERN,
    )
    .await
    .expect("stage");

    let weak = recovery::recover_manager_password(&pool, REFERENCE, DEVICE, "short")
        .await
        .expect_err("policy first");
    assert_eq!(weak, DomainError::WeakPassword);

    recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("approval survived the weak attempt");
    auth::login(&pool, tokens.as_ref(), created, TEMPORARY)
        .await
        .expect("temporary works");
}

``n
## §6 fix map (reviewed-version -> fixed-version)

- F1: stage_approval gains pattern: &str; Pattern check (repo find + argon2, codes InvalidCredentials/PatternNotConfigured) runs BEFORE pool tx; refusal writes nothing. Command gains pattern param. Tests: staging_refuses_a_wrong_pattern_and_writes_nothing, staging_refuses_when_no_pattern_is_configured (+ manager_with_pattern helper).
- F2: execute_manager_recovery doc + use-case doc state the compared-against value is the Pattern-authenticated staged row; no serial plumbing; procedural binding documented, not claimed as attestation.
- F3: Approval::same_stable_fields (reference+device+target+reason; approved_at excluded); identical unconsumed re-stage returns Ok with no second row/event; consumed re-stage returns RecoveryAlreadyUsed. Tests: identical_restage_is_a_silent_noop, consumed_approval_cannot_be_restaged.
- F4: cargo build both configs + findstr on rlibs (results in src-tauri/build-proof-evidence.txt); arch source-scan tests unchanged and green.
