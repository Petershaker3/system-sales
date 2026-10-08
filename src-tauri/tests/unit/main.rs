//! Domain unit tests: no Tauri, no SQLite, no operating system.
//!
//! Every rule the identity domain owns is exercised here as a pure function.
//! `spec:135` requires role permissions to be unit tested, and `spec:139`
//! requires the boundaries of the lockout and expiry rules to be proven rather
//! than assumed.

use mobile_shop_system_lib::domain::catalog::{
    CatalogError, Disposition, Product, ProductId, ProductName, ProductStatus, SalePrice,
};
use mobile_shop_system_lib::domain::identity::{
    is_locked, password_is_acceptable, register_failure, register_success, Assurance,
    CredentialVerifier, DomainError, LockoutState, PatternApproval, Permission, Role, Sensitivity,
    Session, SessionFacts, SessionToken, Timestamp, UserId, ABSOLUTE_LIFETIME_MS,
    IDLE_TIMEOUT_MS, LOCKOUT_MS, MAX_FAILED_ATTEMPTS, MIN_PASSWORD_LEN, PATTERN_TTL_MS,
};
use mobile_shop_system_lib::domain::money::{MoneyError, Piastres};
use mobile_shop_system_lib::domain::organisation::{
    CostMethod, Department, DepartmentError, DepartmentId, DepartmentName, DepartmentStatus,
    DepartmentVat, VatRate,
};
use mobile_shop_system_lib::domain::settings::{
    DiscountKind, SettingKey, SettingsError, SettingsSnapshot, PATTERN_REQUIRED,
};

/// Shorthand: a valid amount, so an arithmetic test states only what it is about.
fn money(value: i64) -> Piastres {
    Piastres::new_minor(value).expect("a non-negative amount")
}

fn at(minutes: i64) -> Timestamp {
    Timestamp::from_millis(minutes * 60 * 1000)
}

/// A healthy, currently-valid session.
///
/// `must_change_password` and `disabled_at` default to the ordinary case so a test
/// that is about something else does not have to restate them. Tests that care
/// override them explicitly.
fn facts() -> SessionFacts {
    let now = at(0);
    SessionFacts {
        user_id: UserId::generate(),
        role: Role::Manager,
        assurance: Assurance::Normal,
        issued_at: now,
        last_seen_at: now,
        absolute_expires_at: now.plus_millis(ABSOLUTE_LIFETIME_MS),
        must_change_password: false,
        disabled_at: None,
        pattern_approved_at: None,
        pattern_epoch: None,
    }
}

// ---------------------------------------------------------------------------
// Roles and permissions (spec:17-18, spec:54)
// ---------------------------------------------------------------------------

#[test]
fn manager_holds_every_business_permission() {
    for permission in [
        Permission::ManageCatalog,
        Permission::ViewCostAndProfit,
        Permission::ManageUsers,
        Permission::Sell,
    ] {
        assert!(
            Role::Manager.allows(permission),
            "manager must hold {permission:?}"
        );
    }
}

#[test]
fn sales_may_sell_and_nothing_else() {
    assert!(Role::Sales.allows(Permission::Sell));
    for denied in [
        Permission::ManageCatalog,
        Permission::ViewCostAndProfit,
        Permission::ManageUsers,
    ] {
        assert!(
            !Role::Sales.allows(denied),
            "sales must not hold {denied:?}"
        );
    }
}

#[test]
fn first_run_setup_is_not_a_role_permission() {
    // It is a property of an empty user table, checked transactionally in the
    // service layer. Granting it to a role would make it available forever.
    assert!(!Role::Manager.allows(Permission::PerformFirstRunSetup));
    assert!(!Role::Sales.allows(Permission::PerformFirstRunSetup));
}

#[test]
fn role_parsing_is_exactly_two_values() {
    assert_eq!(Role::parse("manager"), Some(Role::Manager));
    assert_eq!(Role::parse("sales"), Some(Role::Sales));
    assert_eq!(Role::parse("admin"), None);
    assert_eq!(Role::parse("Manager"), None);
    assert_eq!(Role::parse(""), None);
}

// ---------------------------------------------------------------------------
// Assurance: wholesale data needs re-authentication (plan:151)
// ---------------------------------------------------------------------------

#[test]
fn manager_cannot_see_cost_after_only_logging_in() {
    let session = Session::open(facts(), at(0)).expect("fresh session");
    assert_eq!(
        session.authorize(Permission::ViewCostAndProfit),
        Err(DomainError::ReauthenticationRequired),
        "a Normal session must not unlock wholesale figures"
    );
}

#[test]
fn manager_sees_cost_after_reauthenticating() {
    let mut session = Session::open(facts(), at(0)).expect("fresh session");
    session.upgrade_assurance();
    assert_eq!(session.authorize(Permission::ViewCostAndProfit), Ok(()));
}

#[test]
fn sales_never_sees_cost_even_after_reauthenticating() {
    let mut data = facts();
    data.role = Role::Sales;
    let mut session = Session::open(data, at(0)).expect("fresh session");
    session.upgrade_assurance();
    assert_eq!(
        session.authorize(Permission::ViewCostAndProfit),
        Err(DomainError::PermissionDenied),
        "role is checked before assurance; re-authentication must not promote a sales user"
    );
}

#[test]
fn sales_may_sell_at_normal_assurance() {
    let mut data = facts();
    data.role = Role::Sales;
    let session = Session::open(data, at(0)).expect("fresh session");
    assert_eq!(session.authorize(Permission::Sell), Ok(()));
}

// ---------------------------------------------------------------------------
// Session expiry boundaries (Product Owner decision: 15 min idle, 12 h absolute)
// ---------------------------------------------------------------------------

#[test]
fn session_is_valid_just_inside_the_idle_window() {
    let session = Session::open(facts(), at(14)).expect("14 minutes is inside 15");
    assert_eq!(session.role(), Role::Manager);
}

#[test]
fn session_expires_at_exactly_fifteen_idle_minutes() {
    let expired = Session::open(facts(), Timestamp::from_millis(IDLE_TIMEOUT_MS));
    assert_eq!(expired, Err(DomainError::SessionIdleExpired));
}

#[test]
fn session_expires_one_millisecond_past_the_idle_window() {
    let expired = Session::open(facts(), Timestamp::from_millis(IDLE_TIMEOUT_MS + 1));
    assert_eq!(expired, Err(DomainError::SessionIdleExpired));
}

#[test]
fn session_expires_at_exactly_twelve_hours() {
    let expired = Session::open(facts(), Timestamp::from_millis(ABSOLUTE_LIFETIME_MS));
    assert_eq!(expired, Err(DomainError::SessionAbsoluteExpired));
}

#[test]
fn absolute_expiry_wins_over_idle_expiry() {
    // Beyond twelve hours with a fresh last_seen_at: the absolute deadline is the
    // one that must be reported, because idling could never have extended it.
    let mut data = facts();
    data.last_seen_at = at(13 * 60);
    data.absolute_expires_at = at(12 * 60);
    assert_eq!(
        Session::open(data, at(13 * 60)),
        Err(DomainError::SessionAbsoluteExpired)
    );
}

#[test]
fn touching_restarts_idle_but_never_the_absolute_deadline() {
    let mut session = Session::open(facts(), at(10)).expect("valid at 10 minutes");
    let absolute = session.absolute_expires_at();

    session.touch(at(20));
    assert_eq!(session.last_seen_at(), at(20));
    assert_eq!(
        session.absolute_expires_at(),
        absolute,
        "touch must not move the absolute deadline"
    );
}

// ---------------------------------------------------------------------------
// Lockout state machine (Product Owner decision: 5 attempts, 15 minutes)
// ---------------------------------------------------------------------------

fn clean() -> LockoutState {
    LockoutState {
        failed_attempts: 0,
        locked_until: None,
    }
}

#[test]
fn four_failures_do_not_lock() {
    let mut state = clean();
    for attempt in 1..MAX_FAILED_ATTEMPTS {
        let transition = register_failure(&state, at(0));
        assert!(!transition.just_locked, "attempt {attempt} must not lock");
        assert!(!is_locked(&transition_as_state(&transition), at(0)));
        state = LockoutState {
            failed_attempts: transition.failed_attempts,
            locked_until: transition.locked_until,
        };
    }
    assert_eq!(state.failed_attempts, MAX_FAILED_ATTEMPTS - 1);
}

fn transition_as_state(
    transition: &mobile_shop_system_lib::domain::identity::LockoutTransition,
) -> LockoutState {
    LockoutState {
        failed_attempts: transition.failed_attempts,
        locked_until: transition.locked_until,
    }
}

#[test]
fn fifth_failure_locks_for_exactly_fifteen_minutes() {
    let state = LockoutState {
        failed_attempts: MAX_FAILED_ATTEMPTS - 1,
        locked_until: None,
    };
    let transition = register_failure(&state, at(0));

    assert!(transition.just_locked);
    assert_eq!(transition.failed_attempts, MAX_FAILED_ATTEMPTS);
    assert!(is_locked(
        &transition_as_state(&transition),
        Timestamp::from_millis(LOCKOUT_MS - 1)
    ));
    assert!(
        !is_locked(
            &transition_as_state(&transition),
            Timestamp::from_millis(LOCKOUT_MS)
        ),
        "the lock must lift at exactly fifteen minutes"
    );
}

#[test]
fn success_clears_the_counters() {
    let transition = register_success();
    assert_eq!(transition.failed_attempts, 0);
    assert_eq!(transition.locked_until, None);
    assert!(!is_locked(&transition_as_state(&transition), at(0)));
}

#[test]
fn counter_saturates_instead_of_overflowing() {
    let state = LockoutState {
        failed_attempts: i32::MAX - 1,
        locked_until: None,
    };
    let transition = register_failure(&state, at(0));
    assert_eq!(transition.failed_attempts, i32::MAX);
}

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

#[test]
fn password_policy_is_length_only_as_approved() {
    assert!(!password_is_acceptable(""));
    assert!(!password_is_acceptable(&"a".repeat(MIN_PASSWORD_LEN - 1)));
    assert!(password_is_acceptable(&"a".repeat(MIN_PASSWORD_LEN)));
    assert!(password_is_acceptable("a much longer passphrase"));
    // No character-class rule was approved, so none is silently imposed.
    assert!(password_is_acceptable("12345678"));
}

// ---------------------------------------------------------------------------
// Value hygiene
// ---------------------------------------------------------------------------

#[test]
fn session_token_debug_output_is_redacted() {
    let token = SessionToken::new([7u8; 32]);
    let rendered = format!("{token:?}");
    assert_eq!(rendered, "SessionToken(<redacted>)");
    assert!(
        !rendered.contains(&token.expose()[..8]),
        "the secret must not appear in debug output"
    );
}

#[test]
fn verifier_debug_output_is_redacted() {
    let verifier = CredentialVerifier::from_phc("$argon2id$v=19$abc$def".to_string())
        .expect("non-empty PHC string");
    assert_eq!(format!("{verifier:?}"), "CredentialVerifier(<redacted>)");
}

#[test]
fn user_not_found_and_invalid_credentials_are_indistinguishable() {
    // `plan:151` and the enumeration defence depend on this. It is asserted on
    // the CODE rather than the message, because the code is what crosses the
    // transport: if these two ever differed, the frontend would render two
    // different Arabic sentences and the response would disclose which account
    // identifiers exist.
    assert_eq!(
        DomainError::UserNotFound.code(),
        DomainError::InvalidCredentials.code()
    );
    assert_eq!(DomainError::InvalidCredentials.code(), "INVALID_CREDENTIALS");
}

#[test]
fn infrastructure_failures_have_their_own_codes() {
    // A storage outage reported as "invalid credentials" would tell a cashier
    // their password is wrong when it is not, and would send them round a retry
    // loop that can never succeed. These must stay distinct.
    let storage = DomainError::StorageUnavailable.code();
    let secure = DomainError::SecureStorageUnavailable.code();
    assert_ne!(storage, DomainError::InvalidCredentials.code());
    assert_ne!(secure, DomainError::InvalidCredentials.code());
    assert_ne!(storage, secure);
}

#[test]
fn every_domain_error_yields_a_non_empty_screaming_snake_code() {
    // The frontend indexes an Arabic message table by this code. A code that is
    // not a plain upper-case identifier cannot be matched reliably.
    let all = [
        DomainError::BootstrapAlreadyCompleted,
        DomainError::UserNotFound,
        DomainError::InvalidCredentials,
        DomainError::AccountLocked,
        DomainError::WeakPassword,
        DomainError::SessionIdleExpired,
        DomainError::SessionAbsoluteExpired,
        DomainError::SessionNotFound,
        DomainError::PermissionDenied,
        DomainError::ReauthenticationRequired,
        DomainError::AccountDisabled,
        DomainError::PasswordChangeRequired,
        DomainError::UsernameAlreadyExists,
        DomainError::UsernameInvalid,
        DomainError::DisplayNameRequired,
        DomainError::CannotDisableLastManager,
        DomainError::CannotDisableSelf,
        DomainError::StorageUnavailable,
        DomainError::SecureStorageUnavailable,
    ];
    for error in all {
        let code = error.code();
        assert!(!code.is_empty(), "{error:?} produced an empty code");
        assert!(
            code.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
            "{error:?} produced {code:?}, which is not a stable identifier"
        );
    }
}

#[test]
fn token_round_trips_through_its_text_form() {
    let token = SessionToken::new([0xabu8; 32]);
    let parsed = SessionToken::parse(token.expose()).expect("well-formed token");
    assert_eq!(parsed, token);
}

#[test]
fn malformed_tokens_are_rejected() {
    assert!(SessionToken::parse("").is_none());
    assert!(SessionToken::parse("short").is_none());
    assert!(SessionToken::parse(&"z".repeat(64)).is_none(), "not hex");
    assert!(SessionToken::parse(&"a".repeat(63)).is_none(), "wrong length");
}

#[test]
fn user_ids_are_unique_and_time_ordered() {
    let first = UserId::generate();
    let second = UserId::generate();
    assert_ne!(first, second);
    assert!(
        first < second,
        "UUID v7 must sort in creation order so ORDER BY id is chronological"
    );
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

#[test]
fn money_rejects_a_negative_amount() {
    // A refund moves money backwards, but it does so in the transaction that
    // represents it. A negative *amount* is not a thing this system stores.
    assert_eq!(Piastres::new_minor(-1), Err(MoneyError::Negative));
    assert_eq!(Piastres::new_minor(i64::MIN), Err(MoneyError::Negative));
}

#[test]
fn money_accepts_zero_because_zero_is_an_amount() {
    assert_eq!(Piastres::new_minor(0), Ok(Piastres::ZERO));
    assert_eq!(Piastres::ZERO.as_minor(), 0);
}

#[test]
fn money_adds_exactly() {
    assert_eq!(money(10050).checked_add(&money(50)), Some(money(10100)));
    assert_eq!(Piastres::ZERO.checked_add(&money(7)), Some(money(7)));
}

#[test]
fn money_refuses_an_overflowing_sum_rather_than_saturating() {
    // The load-bearing assertion. A saturating add would return i64::MAX, which
    // is a plausible-looking total that nobody chose, and a caller would store it.
    assert_eq!(money(i64::MAX).checked_add(&money(1)), None);
}

#[test]
fn money_subtracts_and_refuses_going_below_zero() {
    assert_eq!(money(10100).checked_sub(&money(50)), Some(money(10050)));
    assert_eq!(
        money(100).checked_sub(&money(100)),
        Some(Piastres::ZERO),
        "subtracting the whole amount leaves zero, not a negative"
    );
    assert_eq!(
        money(100).checked_sub(&money(101)),
        None,
        "an amount cannot become negative, so the difference is refused"
    );
}

#[test]
fn money_reports_an_exact_display_split_without_rounding() {
    // 10050 piastres is 100.50 EGP. The quotient and remainder are exact, so no
    // rounding rule is invoked; ADR-010 leaves rounding open and this must not
    // quietly settle it.
    assert_eq!(money(10050).display_parts(), (100, 50));
    assert_eq!(money(0).display_parts(), (0, 0));
    assert_eq!(money(99).display_parts(), (0, 99));
    assert_eq!(money(100).display_parts(), (1, 0));
}

#[test]
fn money_displays_piastres_always_in_two_digits() {
    assert_eq!(money(0).to_string(), "0.00");
    assert_eq!(money(5).to_string(), "0.05");
    assert_eq!(money(10050).to_string(), "100.50");
}

// ---------------------------------------------------------------------------
// The catalogue price still behaves exactly as it did
// ---------------------------------------------------------------------------

#[test]
fn a_sale_price_rejects_a_negative_amount_with_the_catalogue_code() {
    // The catalogue's own error, not the money type's, so the operator-facing
    // code stays PRICE_NEGATIVE and the Arabic message table is unchanged.
    assert!(matches!(
        SalePrice::new_minor(-1),
        Err(CatalogError::PriceNegative)
    ));
}

#[test]
fn a_sale_price_delegates_its_display_to_the_money_type() {
    let price = SalePrice::new_minor(10050).expect("valid");
    assert_eq!(price.as_minor(), 10050);
    assert_eq!(price.display_parts(), money(10050).display_parts());
    assert_eq!(price.to_string(), "100.50");
    assert_eq!(price.amount(), money(10050));
}

#[test]
fn a_free_price_is_still_a_price_and_not_an_absent_one() {
    // `Some(0)` is genuinely free. `None` is not set. This is the distinction
    // the whole optional field exists to preserve, so it is asserted directly.
    let free = SalePrice::new_minor(0).expect("zero is a valid price");
    assert_eq!(free.as_minor(), 0);
    assert_eq!(free.to_string(), "0.00");

    let unset: Option<SalePrice> = None;
    assert!(unset.is_none(), "an unset price must stay distinguishable from zero");
}

// ---------------------------------------------------------------------------
// Product dispositions: three classes, and exactly three
// ---------------------------------------------------------------------------

#[test]
fn every_disposition_round_trips_through_its_stored_form() {
    // These strings are what `products.disposition` stores and what migration
    // `0005`'s CHECK accepts.
    for (disposition, stored) in [
        (Disposition::Quantity, "quantity"),
        (Disposition::Serialized, "serialized"),
        (Disposition::OneOff, "one_off"),
    ] {
        assert_eq!(disposition.as_str(), stored);
        assert_eq!(Disposition::parse(stored), Some(disposition));
        assert_eq!(disposition.to_string(), stored);
    }
}

#[test]
fn one_off_is_a_distinct_third_class() {
    // `spec:175` separates a quantity-tracked product from one that keeps no stock
    // balance at all. Collapsing them would either require a fabricated opening
    // balance or lose the distinction, so all three must remain distinct.
    assert_ne!(Disposition::OneOff, Disposition::Quantity);
    assert_ne!(Disposition::OneOff, Disposition::Serialized);
    assert_ne!(Disposition::Quantity, Disposition::Serialized);
    assert_eq!(Disposition::parse("one_off"), Some(Disposition::OneOff));
}

#[test]
fn the_two_original_dispositions_are_unchanged() {
    // Migration `0005` widened the CHECK; it must not have renamed or altered the
    // values a device already stores, or every existing product would be
    // reclassified by a schema change.
    assert_eq!(Disposition::Quantity.as_str(), "quantity");
    assert_eq!(Disposition::Serialized.as_str(), "serialized");
    assert_eq!(
        Disposition::parse("quantity"),
        Some(Disposition::Quantity)
    );
    assert_eq!(
        Disposition::parse("serialized"),
        Some(Disposition::Serialized)
    );
}

#[test]
fn an_unrecognised_disposition_is_still_rejected() {
    for candidate in ["", "consignment", "Quantity", "ONE_OFF", "one-off", "oneoff"] {
        assert_eq!(
            Disposition::parse(candidate),
            None,
            "`{candidate}` must not parse to any disposition"
        );
    }
}

#[test]
fn the_serialised_disposition_name_equals_the_stored_value() {
    // The wire name and the stored name are one string, so a DTO cannot disagree
    // with the column. `camelCase` would have made `OneOff` serialise as `oneOff`
    // while `as_str` returned `one_off`.
    assert_eq!(
        serde_json::to_string(&Disposition::OneOff).expect("serialise"),
        "\"one_off\""
    );
    assert_eq!(
        serde_json::to_string(&Disposition::Quantity).expect("serialise"),
        "\"quantity\""
    );
    assert_eq!(
        serde_json::to_string(&Disposition::Serialized).expect("serialise"),
        "\"serialized\""
    );
}

// ---------------------------------------------------------------------------
// Departments: a product classification, never a physical place
// ---------------------------------------------------------------------------

/// A department under test, with the manager as its actor.
fn department() -> Department {
    Department::new(
        DepartmentName::new("Phones").expect("a valid name"),
        CostMethod::MovingAverage,
        DepartmentVat::disabled(),
        0,
        UserId::generate(),
        1000,
    )
}

#[test]
fn a_department_name_is_trimmed_and_stored_trimmed() {
    let name = DepartmentName::new("  Accessories  ").expect("a valid name");
    assert_eq!(name.as_str(), "Accessories");
    assert_eq!(name.to_string(), "Accessories");
}

#[test]
fn a_department_name_that_is_only_whitespace_is_refused_and_not_manufactured() {
    // The rule that matters: an empty result is an error, never a fallback name.
    // Inventing one would put a row in the shop's list that nobody typed.
    for candidate in ["", " ", "   ", "\t", "\n", " \t\n "] {
        assert_eq!(
            DepartmentName::new(candidate),
            Err(DepartmentError::NameRequired),
            "`{candidate:?}` must be refused rather than replaced"
        );
    }
}

#[test]
fn an_already_trimmed_department_name_is_unchanged() {
    assert_eq!(
        DepartmentName::new("Spare Parts").expect("valid").as_str(),
        "Spare Parts"
    );
}

#[test]
fn a_department_name_keeps_the_managers_own_capitalisation() {
    // Case folding is a comparison rule owned by the storage index, not a
    // transformation of the operator's text. `Phones` must stay `Phones`.
    let name = DepartmentName::new("Phones").expect("valid");
    assert_eq!(name.as_str(), "Phones");
    assert_ne!(name.as_str(), name.as_str().to_lowercase());
}

#[test]
fn a_new_department_is_active_and_never_archived() {
    let dept = department();
    assert_eq!(dept.status, DepartmentStatus::Active);
    assert_eq!(dept.archived_at, None);
    assert!(dept.is_editable(), "a new department must be editable");
}

#[test]
fn an_active_department_can_be_archived() {
    let mut dept = department();
    let actor = UserId::generate();

    dept.archive(actor, 5000).expect("archiving an active department");

    assert_eq!(dept.status, DepartmentStatus::Archived);
    assert_eq!(
        dept.archived_at,
        Some(5000),
        "the archive moment is recorded, not merely implied by the status"
    );
    assert_eq!(dept.updated_by, actor, "archiving is an attributed change");
    assert_eq!(dept.updated_at, 5000);
    assert!(!dept.is_editable());
}

#[test]
fn an_archived_department_refuses_every_mutation() {
    let mut dept = department();
    dept.archive(UserId::generate(), 5000).expect("archive");

    let actor = UserId::generate();

    assert_eq!(
        dept.update(
            DepartmentName::new("Renamed").unwrap(),
            CostMethod::Fifo,
            DepartmentVat::disabled(),
            99,
            actor,
            6000,
        ),
        Err(DepartmentError::IsArchived),
        "an archived department must refuse edits"
    );

    assert_eq!(
        dept.archive(actor, 7000),
        Err(DepartmentError::IsArchived),
        "archiving twice must be refused rather than restamping the archive moment"
    );

    // Refused means unchanged: no field moved.
    assert_eq!(dept.name.as_str(), "Phones");
    assert_eq!(dept.cost_method, CostMethod::MovingAverage);
    assert_eq!(dept.sort_order, 0);
    assert_eq!(dept.archived_at, Some(5000));
}

#[test]
fn an_active_department_accepts_an_edit() {
    let mut dept = department();
    let actor = UserId::generate();
    let vat = DepartmentVat::new(true, Some(VatRate::new(1450).unwrap()), true).unwrap();

    dept.update(
        DepartmentName::new("  Mobile Phones ").unwrap(),
        CostMethod::Fifo,
        vat,
        3,
        actor,
        7000,
    )
    .expect("an active department may be edited");

    assert_eq!(dept.name.as_str(), "Mobile Phones");
    assert_eq!(dept.cost_method, CostMethod::Fifo);
    assert_eq!(dept.sort_order, 3);
    assert!(dept.vat.is_enabled());
    assert_eq!(dept.vat.rate().map(|r| r.as_basis_points()), Some(1450));
    assert!(dept.vat.is_inclusive());
    assert_eq!(dept.updated_by, actor);
    assert_eq!(dept.updated_at, 7000);
    assert_eq!(
        dept.created_at, 1000,
        "an edit must not rewrite when the department was created"
    );
}

#[test]
fn both_cost_methods_are_accepted_and_neither_is_none() {
    // `Fifo` is refused by nothing. Its costing engine does not exist yet, and
    // refusing the value would turn a missing implementation into a rule.
    for method in [CostMethod::MovingAverage, CostMethod::Fifo] {
        let mut dept = department();
        dept.update(
            DepartmentName::new("Phones").unwrap(),
            method,
            DepartmentVat::disabled(),
            0,
            UserId::generate(),
            8000,
        )
        .unwrap_or_else(|e| panic!("`{method:?}` must be a valid cost method: {e}"));

        assert_eq!(dept.cost_method, method);
    }
}

#[test]
fn a_cost_method_round_trips_through_its_stored_form() {
    // The stored strings are what migration `0004`'s CHECK accepts.
    assert_eq!(CostMethod::MovingAverage.as_str(), "moving_average");
    assert_eq!(CostMethod::Fifo.as_str(), "fifo");
    assert_eq!(
        CostMethod::parse("moving_average"),
        Some(CostMethod::MovingAverage)
    );
    assert_eq!(CostMethod::parse("fifo"), Some(CostMethod::Fifo));
    assert_eq!(CostMethod::parse("weighted_average"), None);
    assert_eq!(CostMethod::parse(""), None);

    // And the serialised name is the same string, so a DTO cannot disagree with
    // the column.
    assert_eq!(
        serde_json::to_string(&CostMethod::Fifo).expect("serialise"),
        "\"fifo\""
    );
}

#[test]
fn vat_disabled_with_no_rate_is_valid_and_is_the_new_department_state() {
    let vat = DepartmentVat::disabled();
    assert!(!vat.is_enabled());
    assert!(vat.rate().is_none());
    assert!(!vat.is_inclusive());
}

#[test]
fn vat_disabled_with_a_recorded_rate_is_valid() {
    // Switching VAT off is a business decision. Erasing the rate with it would
    // lose information for no benefit, so a rate may outlive the flag.
    let vat = DepartmentVat::new(false, Some(VatRate::new(1450).unwrap()), false).expect("valid");
    assert!(!vat.is_enabled());
    assert_eq!(vat.rate().map(|r| r.as_basis_points()), Some(1450));
}

#[test]
fn enabling_vat_without_a_rate_is_refused() {
    assert_eq!(
        DepartmentVat::new(true, None, false),
        Err(DepartmentError::VatRateRequired),
        "VAT on with no rate is the one meaningless combination"
    );
}

#[test]
fn a_vat_setting_can_be_switched_off_without_losing_its_rate() {
    let on = DepartmentVat::new(true, Some(VatRate::new(1450).unwrap()), false).expect("valid");

    let off = on.with_enabled(false).expect("switching VAT off always succeeds");

    assert!(!off.is_enabled());
    assert_eq!(
        off.rate().map(|r| r.as_basis_points()),
        Some(1450),
        "the rate must survive the switch, which is why it is a separate field"
    );

    // Switching it back on is then possible without re-entering the rate.
    assert!(off.with_enabled(true).expect("re-enable").is_enabled());
}

#[test]
fn switching_vat_on_without_a_rate_is_refused() {
    let off = DepartmentVat::disabled();
    assert_eq!(
        off.with_enabled(true),
        Err(DepartmentError::VatRateRequired)
    );
}

#[test]
fn a_vat_rate_is_an_integer_count_of_basis_points_and_never_negative() {
    let rate = VatRate::new(1450).expect("a valid rate");
    assert_eq!(rate.as_basis_points(), 1450);
    assert_eq!(VatRate::new(0).expect("zero is a valid rate").as_basis_points(), 0);
    assert_eq!(VatRate::new(-1), Err(DepartmentError::VatRateNegative));
    assert_eq!(
        VatRate::new(i64::MIN),
        Err(DepartmentError::VatRateNegative),
        "the check is a sign test, so the most negative integer is covered too"
    );
}

#[test]
fn a_department_rehydrates_from_stored_values_only_when_they_agree() {
    let actor = UserId::generate();
    let name = DepartmentName::new("Phones").expect("valid");

    let active = Department::rehydrate(
        DepartmentId::generate(),
        name.clone(),
        DepartmentStatus::Active,
        CostMethod::MovingAverage,
        DepartmentVat::disabled(),
        1,
        actor,
        actor,
        100,
        100,
        None,
    )
    .expect("active with no archive timestamp");

    assert_eq!(active.archived_at, None);

    Department::rehydrate(
        DepartmentId::generate(),
        name.clone(),
        DepartmentStatus::Archived,
        CostMethod::Fifo,
        DepartmentVat::disabled(),
        1,
        actor,
        actor,
        100,
        500,
        Some(500),
    )
    .expect("archived with an archive timestamp");

    // The two contradictory rows are the ones worth refusing: quietly repairing
    // them would erase the evidence that something wrote an impossible state.
    assert_eq!(
        Department::rehydrate(
            DepartmentId::generate(),
            name.clone(),
            DepartmentStatus::Active,
            CostMethod::MovingAverage,
            DepartmentVat::disabled(),
            1,
            actor,
            actor,
            100,
            500,
            Some(500),
        ),
        Err(DepartmentError::ArchiveStateInconsistent),
        "active with an archive timestamp is a corrupt row"
    );

    assert_eq!(
        Department::rehydrate(
            DepartmentId::generate(),
            name,
            DepartmentStatus::Archived,
            CostMethod::MovingAverage,
            DepartmentVat::disabled(),
            1,
            actor,
            actor,
            100,
            500,
            None,
        ),
        Err(DepartmentError::ArchiveStateInconsistent),
        "archived without an archive timestamp is a corrupt row"
    );
}

#[test]
fn the_department_status_domain_is_exactly_two_states() {
    assert_eq!(DepartmentStatus::Active.as_str(), "active");
    assert_eq!(DepartmentStatus::Archived.as_str(), "archived");
    assert_eq!(
        DepartmentStatus::parse("active"),
        Some(DepartmentStatus::Active)
    );
    assert_eq!(
        DepartmentStatus::parse("archived"),
        Some(DepartmentStatus::Archived)
    );
    assert_eq!(DepartmentStatus::parse("deleted"), None);
    assert_eq!(DepartmentStatus::parse(""), None);
    assert_eq!(
        serde_json::to_string(&DepartmentStatus::Archived).expect("serialise"),
        "\"archived\""
    );
}

#[test]
fn every_department_error_has_a_stable_screaming_snake_code() {
    for error in [
        DepartmentError::NameRequired,
        DepartmentError::IsArchived,
        DepartmentError::VatRateRequired,
        DepartmentError::VatRateNegative,
        DepartmentError::ArchiveStateInconsistent,
    ] {
        let code = error.code();
        assert!(!code.is_empty(), "{error:?} produced an empty code");
        assert_eq!(
            code,
            code.to_ascii_uppercase(),
            "{error:?} produced {code:?}, which is not upper case"
        );
        assert!(
            code.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
            "{error:?} produced {code:?}, which is not a screaming-snake identifier"
        );
        assert!(!error.to_string().is_empty());
    }
}

// ---------------------------------------------------------------------------
// Sensitivity: the fourth authorization axis (plan SP-1b, Task 4)
// ---------------------------------------------------------------------------

/// A session that has proved its password, optionally carrying a Pattern
/// approval granted at `approved_at` under `epoch`.
fn reauthenticated(
    assurance: Assurance,
    approved_at: Option<Timestamp>,
    epoch: Option<i64>,
) -> Session {
    let mut data = facts();
    data.assurance = assurance;
    data.pattern_approved_at = approved_at;
    data.pattern_epoch = epoch;
    Session::open(data, at(0)).expect("session facts are valid")
}

#[test]
fn routine_operations_never_ask_for_the_pattern() {
    // The shortest-circuit branch: routine work passes on every axis, even
    // with protection on and no approval anywhere — proving `Routine` is
    // checked before assurance, the pattern flag and the epoch.
    let session = reauthenticated(Assurance::Normal, None, None);
    assert_eq!(
        session.require_sensitivity(Sensitivity::Routine, true, Some(1), at(0)),
        Ok(()),
        "routine work must not be gated by any axis"
    );
}

#[test]
fn sensitive_work_demands_reauthentication_before_the_pattern() {
    // Assurance is the second branch: a Normal session is refused even when
    // pattern protection is off, so the axes cannot be swapped.
    let session = reauthenticated(Assurance::Normal, None, None);
    assert_eq!(
        session.require_sensitivity(Sensitivity::Sensitive, false, None, at(0)),
        Err(DomainError::ReauthenticationRequired),
        "the pattern flag must not let a Normal session past the assurance check"
    );
}

#[test]
fn sensitive_work_passes_when_pattern_protection_is_off() {
    let session = reauthenticated(Assurance::Reauthenticated, None, None);
    assert_eq!(
        session.require_sensitivity(Sensitivity::Sensitive, false, Some(1), at(0)),
        Ok(()),
        "with protection off, re-authenticated sensitive work needs no approval"
    );
}

#[test]
fn protection_on_without_a_stored_pattern_fails_closed() {
    // `Some`/`None` of the *current epoch* is how "a Pattern exists" reaches
    // the domain: no row means no epoch, and that must not read as "off".
    let session = reauthenticated(Assurance::Reauthenticated, None, None);
    assert_eq!(
        session.require_sensitivity(Sensitivity::Sensitive, true, None, at(0)),
        Err(DomainError::PatternNotConfigured),
        "an enabled but unconfigured Pattern must fail closed"
    );
}

#[test]
fn a_session_that_never_approved_is_asked_for_the_pattern() {
    let session = reauthenticated(Assurance::Reauthenticated, None, Some(1));
    assert_eq!(
        session.require_sensitivity(Sensitivity::Sensitive, true, Some(1), at(0)),
        Err(DomainError::PatternRequired),
        "an approval that was never granted is the remedy-by-entry case"
    );
}

#[test]
fn an_approval_from_another_epoch_is_stale_even_when_new() {
    // A Pattern change bumps the epoch; every open approval must die with it
    // without any sweep of session rows.
    let session = reauthenticated(Assurance::Reauthenticated, Some(at(0)), Some(1));
    assert_eq!(
        session.require_sensitivity(Sensitivity::Sensitive, true, Some(2), at(1)),
        Err(DomainError::PatternApprovalStale),
        "an approval granted under epoch 1 must not survive epoch 2"
    );
}

#[test]
fn a_fresh_approval_unlocks_sensitive_work() {
    let session = reauthenticated(Assurance::Reauthenticated, Some(at(0)), Some(1));
    assert_eq!(
        session.require_sensitivity(Sensitivity::Sensitive, true, Some(1), at(4)),
        Ok(()),
        "inside the window, under the current epoch: the operation proceeds"
    );
}

#[test]
fn an_approval_exactly_at_the_ttl_is_stale() {
    // Boundary: `is_fresh` is strictly-less-than the TTL, so the millisecond
    // the window closes, the Pattern must be asked for again.
    let session = reauthenticated(Assurance::Reauthenticated, Some(at(0)), Some(1));
    assert_eq!(
        session.require_sensitivity(Sensitivity::Sensitive, true, Some(1), at(5)),
        Err(DomainError::PatternApprovalStale),
        "exactly five minutes is outside the window, not inside it"
    );
}

// ---------------------------------------------------------------------------
// PatternApproval freshness (plan SP-1b, Testing)
// ---------------------------------------------------------------------------

#[test]
fn the_pattern_ttl_is_five_minutes() {
    // A Product Owner assumption made executable: 5 * 60 * 1000.
    assert_eq!(PATTERN_TTL_MS, 300_000);
}

#[test]
fn an_approval_is_fresh_inside_the_window_and_stale_at_the_boundary() {
    let approval = PatternApproval::granted(at(0), 1);
    assert!(
        approval.is_fresh(at(0).plus_millis(PATTERN_TTL_MS - 1), 1, PATTERN_TTL_MS),
        "one millisecond before the deadline is still fresh"
    );
    assert!(
        !approval.is_fresh(at(0).plus_millis(PATTERN_TTL_MS), 1, PATTERN_TTL_MS),
        "the deadline millisecond is stale"
    );
    assert!(
        approval.is_fresh(at(0), 1, PATTERN_TTL_MS),
        "granted at now is fresh at now"
    );
}

#[test]
fn an_epoch_mismatch_outranks_a_fresh_timestamp() {
    let approval = PatternApproval::granted(at(0), 3);
    assert!(
        !approval.is_fresh(at(1), 4, PATTERN_TTL_MS),
        "a recent approval under a superseded epoch is stale"
    );
    assert!(
        !approval.is_fresh(at(6), 3, PATTERN_TTL_MS),
        "the right epoch outside the window is stale too"
    );
}

#[test]
fn a_clock_that_moved_backwards_does_not_age_an_approval() {
    // `millis_since` saturates at zero, so time travel yields "not yet
    // elapsed" rather than an approval that outlives its window.
    let approval = PatternApproval::granted(at(10), 1);
    assert!(
        approval.is_fresh(at(0), 1, PATTERN_TTL_MS),
        "an elapsed time below zero must read as just-granted, never as expired"
    );
}

#[test]
fn pattern_approvals_compare_by_both_fields() {
    assert_eq!(
        PatternApproval::granted(at(0), 1),
        PatternApproval::granted(at(0), 1)
    );
    assert_ne!(
        PatternApproval::granted(at(0), 1),
        PatternApproval::granted(at(0), 2),
        "the epoch is part of the approval's identity"
    );
    assert_ne!(
        PatternApproval::granted(at(0), 1),
        PatternApproval::granted(at(1), 1),
        "the grant moment is part of the approval's identity"
    );
}

#[test]
fn a_session_delegates_pattern_freshness_to_one_rule() {
    let mut session = reauthenticated(Assurance::Reauthenticated, None, None);
    session.set_pattern_approval(at(0), 7);

    assert_eq!(session.pattern_approved_at(), Some(at(0)));
    assert_eq!(session.pattern_epoch(), Some(7));
    assert!(session.pattern_approval_is_current(at(1), 7, PATTERN_TTL_MS));
    assert!(
        !session.pattern_approval_is_current(at(1), 8, PATTERN_TTL_MS),
        "the session must not accept a superseded epoch"
    );
    assert!(
        !session.pattern_approval_is_current(at(5), 7, PATTERN_TTL_MS),
        "the session must not accept an expired approval"
    );

    session.clear_pattern_approval();
    assert_eq!(session.pattern_approved_at(), None);
    assert_eq!(session.pattern_epoch(), None);
    assert!(
        !session.pattern_approval_is_current(at(0), 7, PATTERN_TTL_MS),
        "a cleared approval is never current"
    );
}

// ---------------------------------------------------------------------------
// Settings: defaults, keys, values (plan SP-1b, Task 3)
// ---------------------------------------------------------------------------

#[test]
fn every_missing_setting_reads_as_its_domain_default() {
    // Assumption 4: a partially configured device must still open, so the
    // defaults are asserted one by one rather than through `Default` alone.
    let snapshot = SettingsSnapshot::default();
    assert_eq!(snapshot.default_cost_method, CostMethod::MovingAverage);
    assert_eq!(snapshot.invoice_prefix, "");
    assert!(!snapshot.default_vat_enabled);
    assert_eq!(snapshot.default_vat_rate_bp, None);
    assert!(!snapshot.default_vat_inclusive);
    assert_eq!(snapshot.max_discount_kind, DiscountKind::Money);
    assert_eq!(
        snapshot.max_discount_value, 0,
        "no discount allowed by default: the default fails closed"
    );
}

#[test]
fn every_setting_key_round_trips_through_its_stored_form() {
    let all = [
        SettingKey::DefaultCostMethod,
        SettingKey::InvoicePrefix,
        SettingKey::DefaultVatEnabled,
        SettingKey::DefaultVatRateBp,
        SettingKey::DefaultVatInclusive,
        SettingKey::MaxDiscountKind,
        SettingKey::MaxDiscountValue,
    ];
    for key in all {
        assert_eq!(SettingKey::parse(key.as_str()), Some(key));
    }
    for unknown in ["", "nope", "pattern_required", "PATTERN_REQUIRED", "default_vat"] {
        assert_eq!(
            SettingKey::parse(unknown),
            None,
            "`{unknown}` must not be a snapshot key"
        );
    }
}

#[test]
fn the_pattern_toggle_is_refused_by_the_generic_settings_write() {
    // The design guarantee: only the pattern slice may flip protection, so
    // the generic write path must not even recognise the key.
    let mut snapshot = SettingsSnapshot::default();
    assert_eq!(
        snapshot.set(PATTERN_REQUIRED, "1"),
        Err(SettingsError::UnknownKey {
            key: PATTERN_REQUIRED.to_string()
        }),
        "`pattern_required` must be outside the generic settings vocabulary"
    );
    assert_eq!(
        SettingsError::UnknownKey {
            key: "nope".to_string()
        }
        .code(),
        "SETTING_UNKNOWN_KEY"
    );
    assert_eq!(
        SettingsError::MalformedValue {
            key: "nope".to_string(),
            reason: "x",
        }
        .code(),
        "SETTING_VALUE_INVALID"
    );
}

#[test]
fn the_snapshot_applies_every_recognised_key() {
    let mut snapshot = SettingsSnapshot::default();

    snapshot.set("default_cost_method", "fifo").expect("fifo");
    assert_eq!(snapshot.default_cost_method, CostMethod::Fifo);

    snapshot.set("invoice_prefix", "2026-10-").expect("prefix");
    assert_eq!(snapshot.invoice_prefix, "2026-10-");

    snapshot.set("default_vat_enabled", "1").expect("on");
    assert!(snapshot.default_vat_enabled);
    snapshot.set("default_vat_enabled", "0").expect("off");
    assert!(!snapshot.default_vat_enabled);

    snapshot.set("default_vat_rate_bp", "1500").expect("rate");
    assert_eq!(
        snapshot.default_vat_rate_bp,
        Some(VatRate::new(1500).expect("positive"))
    );
    snapshot.set("default_vat_rate_bp", "0").expect("recorded zero");
    assert_eq!(
        snapshot.default_vat_rate_bp,
        Some(VatRate::new(0).expect("zero is a rate")),
        "a recorded zero must stay distinct from never set"
    );
    snapshot.set("default_vat_rate_bp", "").expect("clear");
    assert_eq!(snapshot.default_vat_rate_bp, None);

    snapshot.set("default_vat_inclusive", "1").expect("inclusive");
    assert!(snapshot.default_vat_inclusive);

    snapshot.set("max_discount_kind", "percentage").expect("kind");
    assert_eq!(snapshot.max_discount_kind, DiscountKind::Percentage);
    snapshot.set("max_discount_value", "250").expect("value");
    assert_eq!(snapshot.max_discount_value, 250);
}

#[test]
fn a_value_this_key_cannot_hold_is_refused_never_defaulted() {
    let mut snapshot = SettingsSnapshot::default();

    for (key, value) in [
        ("default_cost_method", "warehouse"),
        ("default_vat_enabled", "yes"),
        ("default_vat_inclusive", "true"),
        ("default_vat_rate_bp", "abc"),
        ("default_vat_rate_bp", "-1"),
        ("max_discount_kind", "points"),
        ("max_discount_value", "-5"),
        ("max_discount_value", "1.5"),
    ] {
        let before = snapshot.clone();
        assert_eq!(
            snapshot.set(key, value),
            Err(SettingsError::MalformedValue {
                key: key.to_string(),
                reason: match key {
                    "default_cost_method" => "expected moving_average|fifo",
                    "default_vat_enabled" | "default_vat_inclusive" => "expected 0|1",
                    "default_vat_rate_bp" if value == "-1" => "negative",
                    "default_vat_rate_bp" => "expected integer bp",
                    "max_discount_kind" => "expected money|percentage",
                    _ => "expected non-negative integer",
                },
            }),
            "`{key}` must refuse `{value}`"
        );
        assert_eq!(snapshot, before, "a refusal must not partially apply");
    }
}

#[test]
fn an_unknown_key_is_refused_with_its_own_code() {
    let mut snapshot = SettingsSnapshot::default();
    assert_eq!(
        snapshot.set("nope", "1"),
        Err(SettingsError::UnknownKey {
            key: "nope".to_string()
        })
    );
}

#[test]
fn discount_kind_defaults_to_money_and_round_trips() {
    assert_eq!(DiscountKind::default(), DiscountKind::Money);
    assert_eq!(DiscountKind::parse("money"), Some(DiscountKind::Money));
    assert_eq!(
        DiscountKind::parse("percentage"),
        Some(DiscountKind::Percentage)
    );
    assert_eq!(DiscountKind::parse("Money"), None);
    assert_eq!(DiscountKind::parse(""), None);
    assert_eq!(DiscountKind::Percentage.as_str(), "percentage");
    assert_eq!(DiscountKind::Percentage.to_string(), "percentage");
}

// ---------------------------------------------------------------------------
// VatRate on Product (plan SP-1b, Testing)
// ---------------------------------------------------------------------------

fn product(vat_rate_bp: Option<i64>) -> Product {
    Product {
        id: ProductId::generate(),
        name: ProductName::new("Coffee 250g").expect("a name"),
        disposition: Disposition::Quantity,
        barcode: None,
        sale_price: None,
        department: None,
        default_cost: None,
        vat_rate_bp,
        status: ProductStatus::Active,
        created_by: UserId::generate(),
        updated_by: UserId::generate(),
        created_at: 0,
        updated_at: 0,
    }
}

#[test]
fn a_products_vat_rate_keeps_never_set_distinct_from_a_recorded_zero() {
    // The product carries the rate as a plain nullable basis-point override
    // (stored configuration, `plan` §14): `None` is "no override" and
    // `Some(0)` is a recorded zero, and an edit replaces the value wholesale.
    let mut product = product(None);
    assert_eq!(product.vat_rate_bp, None);

    product
        .update(
            product.name.clone(),
            product.disposition,
            None,
            None,
            None,
            None,
            Some(0),
            UserId::generate(),
            10,
        )
        .expect("an active product accepts an edit");
    assert_eq!(product.vat_rate_bp, Some(0));

    product
        .update(
            product.name.clone(),
            product.disposition,
            None,
            None,
            None,
            None,
            Some(1500),
            UserId::generate(),
            20,
        )
        .expect("the override can be raised");
    assert_eq!(product.vat_rate_bp, Some(1500));

    product
        .update(
            product.name.clone(),
            product.disposition,
            None,
            None,
            None,
            None,
            None,
            UserId::generate(),
            30,
        )
        .expect("the override can be cleared");
    assert_eq!(product.vat_rate_bp, None);
}

#[test]
fn an_archived_product_refuses_a_vat_override_too() {
    let mut product = product(None);
    product.set_status(ProductStatus::Archived, UserId::generate(), 5);
    assert_eq!(
        product.update(
            product.name.clone(),
            product.disposition,
            None,
            None,
            None,
            None,
            Some(1500),
            UserId::generate(),
            6,
        ),
        Err(CatalogError::ProductArchived),
        "archiving closes every field, the VAT override included"
    );
    assert_eq!(product.vat_rate_bp, None, "the refusal must not partially apply");
}