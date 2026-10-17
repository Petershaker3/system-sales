//! Domain unit tests: no Tauri, no SQLite, no operating system.
//!
//! Every rule the identity domain owns is exercised here as a pure function.
//! `spec:135` requires role permissions to be unit tested, and `spec:139`
//! requires the boundaries of the lockout and expiry rules to be proven rather
//! than assumed.

use mobile_shop_system_lib::domain::catalog::{
    brand_aliases, brand_lines, can_delete_brand, ean13, ean13_check_digit, is_default_brand,
    next_shop_code, phone_title, storage_label, BrandDeviceType, BrandError, BrandId, BrandName,
    CatalogError, DeviceType, Disposition, PhoneDetails, PhoneModel, Product, ProductId,
    ProductName, ProductStatus, SalePrice, ShopCodeError, DEFAULT_BRANDS,
};
use mobile_shop_system_lib::domain::identity::{
    group_recovery_code, is_locked, normalize_recovery_code, password_is_acceptable,
    register_failure, register_success,
    Assurance,
    CredentialVerifier, DomainError, LockoutState, OwnerApproval, Permission, Role, Sensitivity,
    Session, SessionFacts, SessionToken, Timestamp, UserId, ABSOLUTE_LIFETIME_MS,
    IDLE_TIMEOUT_MS, LOCKOUT_MS, MAX_FAILED_ATTEMPTS, MIN_PASSWORD_LEN, OWNER_APPROVAL_TTL_MS,
    RECOVERY_CODE_ALPHABET, RECOVERY_CODE_GROUP, RECOVERY_CODE_LEN,
};
use mobile_shop_system_lib::domain::money::{MoneyError, Piastres};
use mobile_shop_system_lib::domain::organisation::{
    can_delete, is_default_category, CategoryIcon, CategoryKind, CategoryPlacement, CostMethod,
    Department, DepartmentError, DepartmentId, DepartmentName, DepartmentStatus, DepartmentVat,
    VatRate, CATEGORY_ICONS, DEFAULT_CATEGORIES,
};
use mobile_shop_system_lib::domain::settings::{
    DiscountKind, SettingKey, SettingsError, SettingsSnapshot, PATTERN_REQUIRED,
};
use mobile_shop_system_lib::domain::sales::{SaleError, WarrantyDate};
use mobile_shop_system_lib::domain::supplier::{
    SupplierError, SupplierName, SUPPLIER_NAME_MAX_CHARS,
};

// The backup envelope: byte layout and the manifest path policy.
mod backup;

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
        owner_approval: None,
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
        Permission::ManageCustomers,
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
        Permission::ManageCustomers,
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
fn a_recovery_code_alphabet_has_no_character_misread_on_paper() {
    // ADR-017 §4: written by hand and typed back from paper.
    for misread in ['0', 'O', '1', 'I', 'L'] {
        assert!(
            !RECOVERY_CODE_ALPHABET.contains(misread),
            "`{misread}` is misread on paper"
        );
    }
    assert_eq!(RECOVERY_CODE_ALPHABET.len(), 31, "digits 2-9 and 23 capitals");
    let mut seen: Vec<char> = RECOVERY_CODE_ALPHABET.chars().collect();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), 31, "no symbol twice");
    assert_eq!(RECOVERY_CODE_LEN, 20);
    assert_eq!(RECOVERY_CODE_GROUP, 4);
    // 20 symbols of 31: about 99 bits, far beyond guessing.
    assert!(RECOVERY_CODE_LEN as f64 * 31f64.log2() > 99.0);
}

#[test]
fn a_typed_recovery_code_forgives_case_spaces_dashes_and_arabic_digits() {
    let stored = "23456789ABCDEFGHJKMN";
    assert_eq!(normalize_recovery_code(stored).as_deref(), Some(stored));
    assert_eq!(
        normalize_recovery_code("2345-6789-abcd-efgh-jkmn").as_deref(),
        Some(stored)
    );
    assert_eq!(
        normalize_recovery_code(" 2345 6789\tABCD EFGH JKMN ").as_deref(),
        Some(stored)
    );
    assert_eq!(
        normalize_recovery_code("\u{0662}\u{0663}\u{0664}\u{0665}-6789-ABCD-EFGH-JKMN").as_deref(),
        Some(stored),
        "Arabic-Indic digits typed on an Arabic keyboard"
    );
    assert_eq!(
        normalize_recovery_code("\u{06F2}345-6789-ABCD-EFGH-JKMN").as_deref(),
        Some(stored),
        "Eastern Arabic-Indic digits too"
    );
}

#[test]
fn a_typed_recovery_code_with_a_misread_character_or_a_wrong_length_is_no_code() {
    for typed in [
        "",
        "2345-6789-ABCD-EFGH-JKM",
        "2345-6789-ABCD-EFGH-JKMNP",
        "O345-6789-ABCD-EFGH-JKMN",
        "0345-6789-ABCD-EFGH-JKMN",
        "1345-6789-ABCD-EFGH-JKMN",
        "I345-6789-ABCD-EFGH-JKMN",
        "L345-6789-ABCD-EFGH-JKMN",
        "2345_6789_ABCD_EFGH_JKMN",
        "2345-6789-ABCD-EFGH-JKM\u{0645}",
    ] {
        assert_eq!(normalize_recovery_code(typed), None, "{typed:?} is not a code");
    }
}

#[test]
fn a_recovery_code_is_shown_in_five_groups_of_four() {
    assert_eq!(
        group_recovery_code("23456789ABCDEFGHJKMN"),
        "2345-6789-ABCD-EFGH-JKMN"
    );
    let grouped = group_recovery_code("23456789ABCDEFGHJKMN");
    assert_eq!(
        normalize_recovery_code(&grouped).as_deref(),
        Some("23456789ABCDEFGHJKMN"),
        "what is shown reads back as what is stored"
    );
}

#[test]
fn a_drawn_recovery_code_uses_the_whole_alphabet_and_nothing_else() {
    // The generator (OS CSPRNG, rejection sampling below 248): every code is
    // twenty symbols of the alphabet and reads back as itself, no code comes
    // out twice, and across many draws every symbol turns up — a skipped
    // symbol or a stuck byte would show here.
    use mobile_shop_system_lib::services::identity::crypto::generate_recovery_code;
    let mut codes = std::collections::HashSet::new();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..200 {
        let code = generate_recovery_code().expect("the OS generator");
        assert_eq!(code.len(), RECOVERY_CODE_LEN, "{code}");
        assert!(
            code.chars().all(|ch| RECOVERY_CODE_ALPHABET.contains(ch)),
            "only the recovery alphabet: {code}"
        );
        assert_eq!(normalize_recovery_code(&code).as_deref(), Some(code.as_str()));
        seen.extend(code.chars());
        assert!(codes.insert(code), "a recovery code came out twice");
    }
    // 4,000 symbols: the chance that one of the 31 never turns up is about
    // 31 x (30/31)^4000, which is nil.
    assert_eq!(seen.len(), RECOVERY_CODE_ALPHABET.len(), "every symbol is drawn");
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
        DomainError::WeakPin,
        DomainError::PinNotSet,
        DomainError::SessionIdleExpired,
        DomainError::SessionAbsoluteExpired,
        DomainError::SessionNotFound,
        DomainError::PermissionDenied,
        DomainError::ReauthenticationRequired,
        DomainError::AccountDisabled,
        DomainError::PasswordChangeRequired,
        DomainError::OwnerApprovalRequired,
        DomainError::UsernameAlreadyExists,
        DomainError::UsernameInvalid,
        DomainError::DisplayNameRequired,
        DomainError::CannotDisableLastManager,
        DomainError::CannotDisableSelf,
        DomainError::RecoveryCodeNotSet,
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
// The shop's own barcode (ADR-018 §3, PLAN §6)
// ---------------------------------------------------------------------------
//
// The mockup's `ean13` and `nextCode` are the specification: a manufacturer's
// example proves the check digit is the standard one, and the first code proves
// the shop's numbering starts where the mockup starts it.

#[test]
fn the_ean13_check_digit_matches_the_standard_example() {
    // 4006381333931 is the example used wherever EAN-13 is explained; agreeing
    // with it means the weights are the standard 1,3 and not a lookalike.
    assert_eq!(ean13_check_digit("400638133393"), Some(1));
    assert_eq!(ean13("400638133393"), Some("4006381333931".to_string()));
    // A total already divisible by ten yields zero rather than ten.
    assert_eq!(ean13_check_digit("200000000006"), Some(0));
}

#[test]
fn a_body_that_is_not_twelve_ascii_digits_has_no_check_digit() {
    for body in [
        "",
        "20000000000",    // eleven
        "2000000000001",  // thirteen
        "20000000000A",   // a letter
        "20000000000 ",   // a space
        "٢٠٠٠٠٠٠٠٠٠٠١", // Arabic-Indic digits
    ] {
        assert_eq!(ean13_check_digit(body), None, "{body:?} must be refused");
        assert_eq!(ean13(body), None);
    }
}

#[test]
fn the_first_shop_code_is_two_and_zeroes_ending_in_five() {
    // The mockup's `nextCode` with no internal code stored.
    assert_eq!(
        next_shop_code(std::iter::empty::<&str>()).expect("the range is not full"),
        "2000000000015"
    );
}

#[test]
fn the_next_shop_code_follows_the_highest_one_already_stored() {
    assert_eq!(
        next_shop_code(["2000000000015", "2000000000022"]).expect("the range is not full"),
        "2000000000039"
    );
    // Order does not matter: the highest is what counts.
    assert_eq!(
        next_shop_code(["2000000000022", "2000000000015"]).expect("the range is not full"),
        "2000000000039"
    );
}

#[test]
fn a_manufacturer_barcode_never_moves_the_shops_numbering() {
    // A real product's EAN starts with something other than 2; a short code
    // that happens to start with 2 is not 13 digits. Neither is the shop's.
    assert_eq!(
        next_shop_code(["4006381333931", "2123", "2000000000022"])
            .expect("the range is not full"),
        "2000000000039"
    );
}

#[test]
fn a_hand_typed_shop_code_still_reserves_its_sequence() {
    // `2000000000029` has the shape but a wrong check digit (the valid one is
    // `2000000000022`). Skipping it would make the next code repeat its number
    // and the UNIQUE barcode would refuse the insert.
    assert_eq!(
        next_shop_code(["2000000000029"]).expect("the range is not full"),
        "2000000000039"
    );
}

#[test]
fn the_last_shop_code_is_refused_rather_than_wrapped() {
    // 2999999999991 is the last code the range can hold. Wrapping would reuse
    // barcodes the shop has already printed.
    assert_eq!(
        next_shop_code(["2999999999991"]),
        Err(ShopCodeError::Exhausted)
    );
}

#[test]
fn the_exhausted_shop_code_has_a_stable_code() {
    assert_eq!(ShopCodeError::Exhausted.code(), "SHOP_CODE_EXHAUSTED");
    assert_eq!(CatalogError::ShopCodeExhausted.code(), "SHOP_CODE_EXHAUSTED");
    assert!(!ShopCodeError::Exhausted.to_string().is_empty());
    assert!(!CatalogError::ShopCodeExhausted.to_string().is_empty());
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

    // The department's own costing method: an edit may round-trip it but not
    // change it, because changing it must convert the stock that exists.
    let method = dept.cost_method;
    dept.update(
        DepartmentName::new("  Mobile Phones ").unwrap(),
        method,
        vat,
        3,
        actor,
        7000,
    )
    .expect("an active department may be edited");

    assert_eq!(dept.name.as_str(), "Mobile Phones");
    assert_eq!(dept.cost_method, method);
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
    // `Fifo` is refused by nothing. It arrived with its own costing engine in
    // SP-2, and refusing the value would still turn a policy choice into a rule
    // the schema could not express.
    //
    // Construction, not an edit: which method a department uses is decided by the
    // dedicated switch, because switching has to convert existing stock.
    for method in [CostMethod::MovingAverage, CostMethod::Fifo] {
        let dept = Department::new(
            DepartmentName::new("Phones").unwrap(),
            method,
            DepartmentVat::disabled(),
            0,
            UserId::generate(),
            1000,
        );

        assert_eq!(dept.cost_method, method);
    }
}

#[test]
fn an_edit_cannot_change_the_costing_method() {
    let mut dept = department();
    let before = dept.cost_method;
    let target = match before {
        CostMethod::MovingAverage => CostMethod::Fifo,
        CostMethod::Fifo => CostMethod::MovingAverage,
    };

    let refused = dept.update(
        DepartmentName::new("Phones").unwrap(),
        target,
        DepartmentVat::disabled(),
        0,
        UserId::generate(),
        8000,
    );

    assert_eq!(
        refused,
        Err(DepartmentError::CostMethodChangeRequiresSwitch),
        "switching must go through the operation that converts the stock"
    );
    assert_eq!(dept.cost_method, before);
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
        DepartmentError::NameTaken,
        DepartmentError::ParentNotMain,
        DepartmentError::IconUnknown,
        DepartmentError::KindMismatch,
        DepartmentError::IsDefault,
        DepartmentError::HasSubcategories,
        DepartmentError::NotEmpty,
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
// The category tree (ADR-018 §1)
// ---------------------------------------------------------------------------

fn main_category(name: &str, kind: CategoryKind) -> Department {
    Department::new_category(
        DepartmentName::new(name).expect("name"),
        CategoryPlacement::Main(kind),
        CategoryIcon::tag(),
        10,
        UserId::generate(),
        1_000,
    )
    .expect("a main category")
}

#[test]
fn the_default_tree_is_the_plans_with_fixed_unique_ids() {
    // PLAN §6: four mains, and seven sub-categories under «إكسسوارات».
    assert_eq!(DEFAULT_CATEGORIES.len(), 11);
    let mains: Vec<&str> = DEFAULT_CATEGORIES
        .iter()
        .filter(|c| c.parent.is_none())
        .map(|c| c.name)
        .collect();
    assert_eq!(mains, vec!["موبايلات جديدة", "مستعمل", "إكسسوارات", "ساعات ذكية"]);

    let mut ids: Vec<&str> = DEFAULT_CATEGORIES.iter().map(|c| c.id).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 11, "every default has its own id");
    let mut names: Vec<&str> = DEFAULT_CATEGORIES.iter().map(|c| c.name).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), 11, "names are unique across the tree");

    for default in DEFAULT_CATEGORIES.iter() {
        assert!(
            uuid::Uuid::parse_str(default.id).is_ok(),
            "`{}` must be a real UUID, or its row could never be read back",
            default.id
        );
        assert!(!default.department_id().as_uuid().is_nil());
        assert!(is_default_category(default.department_id()));
        assert!(CATEGORY_ICONS.contains(&default.icon), "`{}` has no icon", default.name);
        if let Some(parent) = default.parent {
            let parent = DEFAULT_CATEGORIES
                .iter()
                .find(|c| c.id == parent)
                .expect("the parent is a default");
            assert!(parent.parent.is_none(), "two levels: `{}`", default.name);
            assert_eq!(default.kind, parent.kind, "`{}` takes its parent's kind", default.name);
            let at = |id: &str| DEFAULT_CATEGORIES.iter().position(|c| c.id == id);
            assert!(at(parent.id) < at(default.id), "a parent is added before its subs");
        }
    }
    let kind_of = |name: &str| {
        DEFAULT_CATEGORIES
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.kind)
    };
    assert_eq!(kind_of("موبايلات جديدة"), Some(CategoryKind::Phone));
    assert_eq!(kind_of("مستعمل"), Some(CategoryKind::Used));
    assert_eq!(kind_of("إكسسوارات"), Some(CategoryKind::Item));
    assert!(!is_default_category(DepartmentId::generate()));
}

#[test]
fn a_category_kind_reads_back_as_itself_and_nothing_else_is_one() {
    for kind in [CategoryKind::Item, CategoryKind::Phone, CategoryKind::Used] {
        assert_eq!(CategoryKind::parse(kind.as_str()), Some(kind));
    }
    assert_eq!(CategoryKind::parse("quantity"), None);
    assert_eq!(CategoryKind::parse(""), None);
}

#[test]
fn a_sub_category_takes_its_mains_kind_and_the_tree_stops_at_two_levels() {
    let phones = main_category("Phones", CategoryKind::Phone);
    let cases = Department::new_category(
        DepartmentName::new("Cases").expect("name"),
        CategoryPlacement::Under(&phones),
        CategoryIcon::new("shield").expect("icon"),
        10,
        UserId::generate(),
        2_000,
    )
    .expect("a sub-category");
    assert_eq!(cases.parent, Some(phones.id));
    assert_eq!(cases.kind, CategoryKind::Phone, "the parent's kind, whatever else");
    assert!(!cases.is_main());
    assert!(!cases.hidden);
    assert_eq!(cases.cost_method, CostMethod::MovingAverage);
    assert!(!cases.vat.is_enabled());

    let third = Department::new_category(
        DepartmentName::new("Too deep").expect("name"),
        CategoryPlacement::Under(&cases),
        CategoryIcon::tag(),
        10,
        UserId::generate(),
        3_000,
    );
    assert_eq!(third.err(), Some(DepartmentError::ParentNotMain));

    let mut closed = main_category("Closed", CategoryKind::Item);
    closed.archive(UserId::generate(), 4_000).expect("archive");
    let under_closed = Department::new_category(
        DepartmentName::new("Under a closed one").expect("name"),
        CategoryPlacement::Under(&closed),
        CategoryIcon::tag(),
        10,
        UserId::generate(),
        5_000,
    );
    assert_eq!(under_closed.err(), Some(DepartmentError::IsArchived));
}

#[test]
fn a_category_icon_is_one_of_the_list() {
    assert_eq!(CategoryIcon::new("watch").map(|i| i.as_str().to_string()), Ok("watch".to_string()));
    assert_eq!(CategoryIcon::new("rocket"), Err(DepartmentError::IconUnknown));
    assert_eq!(CategoryIcon::new(""), Err(DepartmentError::IconUnknown));
    assert_eq!(CategoryIcon::tag().as_str(), "tag");
    assert!(CATEGORY_ICONS.contains(&"recycle"), "the second-hand category's icon");
}

#[test]
fn a_stored_row_that_is_its_own_parent_is_refused() {
    let category = main_category("Loop", CategoryKind::Item);
    let id = category.id;
    let refused = category.with_tree(Some(id), CategoryKind::Item, CategoryIcon::tag(), false);
    assert_eq!(refused.err(), Some(DepartmentError::ParentNotMain));
}

#[test]
fn renaming_hiding_and_moving_change_a_live_category_only() {
    let actor = UserId::generate();
    let mut category = main_category("Cards", CategoryKind::Item);
    category
        .rename(DepartmentName::new("Top-up cards").expect("name"), actor, 6_000)
        .expect("rename");
    category.set_hidden(true, actor, 7_000).expect("hide");
    category.set_sort_order(30, actor, 8_000).expect("move");
    assert_eq!(category.name.as_str(), "Top-up cards");
    assert!(category.hidden);
    assert_eq!(category.sort_order, 30);
    assert_eq!(category.updated_at, 8_000);
    assert_eq!(category.updated_by, actor);

    category.archive(actor, 9_000).expect("archive");
    assert_eq!(category.set_hidden(false, actor, 10_000), Err(DepartmentError::IsArchived));
    assert_eq!(category.set_sort_order(10, actor, 10_000), Err(DepartmentError::IsArchived));
    assert_eq!(
        category.rename(DepartmentName::new("Again").expect("name"), actor, 10_000),
        Err(DepartmentError::IsArchived)
    );
}

#[test]
fn only_an_empty_category_the_owner_made_may_be_deleted() {
    let default = DEFAULT_CATEGORIES[0].department_id();
    assert_eq!(can_delete(default, false, 0), Err(DepartmentError::IsDefault));
    let own = DepartmentId::generate();
    assert_eq!(can_delete(own, true, 0), Err(DepartmentError::HasSubcategories));
    assert_eq!(can_delete(own, false, 1), Err(DepartmentError::NotEmpty));
    assert_eq!(can_delete(own, false, 0), Ok(()));
}

// ---------------------------------------------------------------------------
// Phone brands and a phone's details (ADR-018 §2)
// ---------------------------------------------------------------------------

fn model(text: &str) -> PhoneModel {
    PhoneModel::new(text).expect("a model")
}

#[test]
fn a_phone_is_named_from_its_details() {
    // The same examples as src/screens/store/phone.test.ts.
    assert_eq!(phone_title("Samsung", &[], &model("Galaxy A16"), Some(128)), "Samsung Galaxy A16 128GB");
    assert_eq!(
        phone_title("Apple", &["iPhone"], &model("iPhone 16"), Some(128)),
        "iPhone 16 128GB",
        "a line drops the company"
    );
    assert_eq!(
        phone_title("Xiaomi", &["Redmi", "POCO"], &model("redmi 14C"), Some(256)),
        "redmi 14C 256GB",
        "whatever the case"
    );
    assert_eq!(
        phone_title("Samsung", &[], &model("Samsung Galaxy S24"), Some(256)),
        "Samsung Galaxy S24 256GB",
        "never the company twice"
    );
    assert_eq!(phone_title("Nokia", &[], &model("105"), None), "Nokia 105", "a keypad phone has no storage");
    assert_eq!(phone_title("Apple", &["iPhone"], &model("  iPhone   16  Pro "), Some(1024)), "iPhone 16 Pro 1TB");
}

#[test]
fn storage_reads_in_gb_or_whole_terabytes_and_a_model_is_tidied() {
    assert_eq!(storage_label(64), "64GB");
    assert_eq!(storage_label(1024), "1TB");
    assert_eq!(storage_label(2048), "2TB");
    assert_eq!(storage_label(1536), "1536GB");
    assert_eq!(model("  Galaxy   A16 ").as_str(), "Galaxy A16");
    assert_eq!(PhoneModel::new("   "), Err(BrandError::ModelRequired));
    assert_eq!(BrandName::new("  Motorola ").map(|n| n.as_str().to_string()), Ok("Motorola".to_string()));
    assert_eq!(BrandName::new(" "), Err(BrandError::NameRequired));
}

#[test]
fn a_touch_phone_names_its_storage_and_a_keypad_phone_has_none() {
    let brand = BrandId::generate();
    let touch = PhoneDetails::new(brand, "Galaxy A16", DeviceType::Touch, Some(128), Some(6)).expect("touch");
    assert_eq!(touch.storage_gb, Some(128));
    assert_eq!(touch.ram_gb, Some(6));
    assert!(PhoneDetails::new(brand, "Galaxy A16", DeviceType::Touch, Some(128), None).is_ok(), "RAM is optional");
    assert_eq!(
        PhoneDetails::new(brand, "Galaxy A16", DeviceType::Touch, None, Some(6)).err(),
        Some(BrandError::StorageRequired)
    );
    assert!(PhoneDetails::new(brand, "105", DeviceType::Keypad, None, None).is_ok());
    assert_eq!(
        PhoneDetails::new(brand, "105", DeviceType::Keypad, Some(32), None).err(),
        Some(BrandError::KeypadHasNoSpecs)
    );
    assert_eq!(
        PhoneDetails::new(brand, "105", DeviceType::Keypad, None, Some(1)).err(),
        Some(BrandError::KeypadHasNoSpecs)
    );
    assert_eq!(
        PhoneDetails::new(brand, "A16", DeviceType::Touch, Some(0), None).err(),
        Some(BrandError::SpecInvalid)
    );
    assert_eq!(
        PhoneDetails::new(brand, " ", DeviceType::Touch, Some(64), None).err(),
        Some(BrandError::ModelRequired)
    );
}

#[test]
fn a_company_makes_touch_keypad_or_both() {
    assert!(BrandDeviceType::Both.allows(DeviceType::Touch));
    assert!(BrandDeviceType::Both.allows(DeviceType::Keypad));
    assert!(BrandDeviceType::Touch.allows(DeviceType::Touch));
    assert!(!BrandDeviceType::Touch.allows(DeviceType::Keypad));
    assert!(!BrandDeviceType::Keypad.allows(DeviceType::Touch));
    for kind in [BrandDeviceType::Touch, BrandDeviceType::Keypad, BrandDeviceType::Both] {
        assert_eq!(BrandDeviceType::parse(kind.as_str()), Some(kind));
    }
    assert_eq!(BrandDeviceType::parse("flip"), None);
    assert_eq!(DeviceType::parse("both"), None, "one phone is touch or keypad, never both");
}

#[test]
fn the_default_companies_are_the_mockups_under_fixed_unique_ids() {
    assert_eq!(DEFAULT_BRANDS.len(), 12);
    let mut ids: Vec<&str> = DEFAULT_BRANDS.iter().map(|b| b.id).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 12);
    let mut names: Vec<String> = DEFAULT_BRANDS.iter().map(|b| b.name.to_lowercase()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), 12, "unique whatever the case");
    for default in DEFAULT_BRANDS.iter() {
        assert!(uuid::Uuid::parse_str(default.id).is_ok(), "`{}` must be a UUID", default.id);
        assert!(is_default_brand(default.brand_id()));
        assert!(!default.aliases.is_empty(), "`{}` has its Arabic spellings", default.name);
    }
    let apple = DEFAULT_BRANDS.iter().find(|b| b.name == "Apple").expect("Apple");
    assert_eq!(brand_lines(apple.brand_id()), &["iPhone"]);
    let xiaomi = DEFAULT_BRANDS.iter().find(|b| b.name == "Xiaomi").expect("Xiaomi");
    assert_eq!(brand_lines(xiaomi.brand_id()), &["Redmi", "POCO"]);
    let itel = DEFAULT_BRANDS.iter().find(|b| b.name == "itel").expect("itel");
    assert_eq!(itel.device_type, BrandDeviceType::Keypad);
    let own = BrandId::generate();
    assert!(!is_default_brand(own));
    assert!(brand_lines(own).is_empty());
    assert_eq!(brand_aliases(own), "");
}

#[test]
fn only_a_company_the_owner_added_with_no_phone_may_be_deleted() {
    let default = DEFAULT_BRANDS[0].brand_id();
    assert_eq!(can_delete_brand(default, 0), Err(BrandError::IsDefault));
    let own = BrandId::generate();
    assert_eq!(can_delete_brand(own, 1), Err(BrandError::NotEmpty));
    assert_eq!(can_delete_brand(own, 0), Ok(()));
}

#[test]
fn every_brand_error_has_a_stable_screaming_snake_code() {
    for error in [
        BrandError::NotFound,
        BrandError::NameRequired,
        BrandError::NameTaken,
        BrandError::IsDefault,
        BrandError::NotEmpty,
        BrandError::TypeUnknown,
        BrandError::ModelRequired,
        BrandError::StorageRequired,
        BrandError::KeypadHasNoSpecs,
        BrandError::SpecInvalid,
        BrandError::TypeMismatch,
        BrandError::AlreadyRegistered,
        BrandError::CategoryNotPhone,
    ] {
        let code = error.code();
        assert!(
            !code.is_empty()
                && code.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
            "{error:?} produced {code:?}"
        );
        assert!(!error.to_string().is_empty());
    }
}

// ---------------------------------------------------------------------------
// Sensitivity: the owner's PIN approval (ADR-017 §3)
// ---------------------------------------------------------------------------

/// A healthy session at `assurance`, optionally carrying an owner approval.
fn session_with(assurance: Assurance, approval: Option<OwnerApproval>) -> Session {
    let mut data = facts();
    data.assurance = assurance;
    data.owner_approval = approval;
    Session::open(data, at(0)).expect("a valid session")
}

#[test]
fn routine_work_never_asks_for_an_approval() {
    let session = session_with(Assurance::Normal, None);
    assert_eq!(
        session.require_sensitivity(Sensitivity::Routine, at(0)),
        Ok(None)
    );
}

#[test]
fn routine_work_does_not_claim_a_waiting_approval() {
    // Claiming it would make the service spend it on a sale.
    let approval = OwnerApproval::granted(UserId::generate(), at(0));
    let session = session_with(Assurance::Normal, Some(approval));
    assert_eq!(
        session.require_sensitivity(Sensitivity::Routine, at(0)),
        Ok(None)
    );
}

#[test]
fn sensitive_work_without_an_approval_asks_for_the_owner() {
    for assurance in [Assurance::Normal, Assurance::Reauthenticated] {
        let session = session_with(assurance, None);
        assert_eq!(
            session.require_sensitivity(Sensitivity::Sensitive, at(0)),
            Err(DomainError::OwnerApprovalRequired),
            "{assurance:?}: a password, even freshly proven, is not the owner's approval"
        );
    }
}

#[test]
fn a_fresh_approval_is_handed_to_the_operation_that_will_spend_it() {
    let owner = UserId::generate();
    let approval = OwnerApproval::granted(owner, at(0));
    let session = session_with(Assurance::Normal, Some(approval));
    let granted = session
        .require_sensitivity(Sensitivity::Sensitive, at(1))
        .expect("a one-minute-old approval is fresh");
    assert_eq!(granted, Some(approval));
    assert_eq!(granted.map(|spent| spent.approved_by()), Some(owner));
}

#[test]
fn the_owner_approval_window_is_two_minutes() {
    // ADR-017 §3.
    assert_eq!(OWNER_APPROVAL_TTL_MS, 120_000);
}

#[test]
fn an_approval_is_fresh_inside_the_window_and_stale_at_the_boundary() {
    let approval = OwnerApproval::granted(UserId::generate(), at(0));
    assert!(
        approval.is_fresh(at(0), OWNER_APPROVAL_TTL_MS),
        "fresh the instant it is granted"
    );
    assert!(
        approval.is_fresh(at(0).plus_millis(OWNER_APPROVAL_TTL_MS - 1), OWNER_APPROVAL_TTL_MS),
        "fresh one millisecond before the window closes"
    );
    assert!(
        !approval.is_fresh(at(0).plus_millis(OWNER_APPROVAL_TTL_MS), OWNER_APPROVAL_TTL_MS),
        "stale exactly at the window, matching the session deadlines' `>=`"
    );
}

#[test]
fn a_session_refuses_an_approval_exactly_at_the_window() {
    let approval = OwnerApproval::granted(UserId::generate(), at(0));
    let session = session_with(Assurance::Normal, Some(approval));
    assert_eq!(
        session.require_sensitivity(
            Sensitivity::Sensitive,
            at(0).plus_millis(OWNER_APPROVAL_TTL_MS)
        ),
        Err(DomainError::OwnerApprovalRequired)
    );
    assert_eq!(
        session.require_sensitivity(
            Sensitivity::Sensitive,
            at(0).plus_millis(OWNER_APPROVAL_TTL_MS - 1)
        ),
        Ok(Some(approval))
    );
}

#[test]
fn an_approval_stamped_in_the_future_is_not_fresh() {
    // The clock moved backwards since the PIN was entered. Trusting the stamp
    // would stretch the window by however far the clock jumped; refusing costs
    // one more PIN entry.
    let approval = OwnerApproval::granted(UserId::generate(), at(10));
    assert!(!approval.is_fresh(at(9), OWNER_APPROVAL_TTL_MS));
    let session = session_with(Assurance::Normal, Some(approval));
    assert_eq!(
        session.require_sensitivity(Sensitivity::Sensitive, at(9)),
        Err(DomainError::OwnerApprovalRequired)
    );
}

#[test]
fn owner_approvals_compare_by_approver_and_moment() {
    let owner = UserId::generate();
    assert_eq!(
        OwnerApproval::granted(owner, at(0)),
        OwnerApproval::granted(owner, at(0))
    );
    assert_ne!(
        OwnerApproval::granted(owner, at(0)),
        OwnerApproval::granted(owner, at(1)),
        "approving again is a different approval"
    );
    assert_ne!(
        OwnerApproval::granted(owner, at(0)),
        OwnerApproval::granted(UserId::generate(), at(0)),
        "another manager's approval is a different approval"
    );
}

#[test]
fn a_session_carries_its_approval_through_open_unchanged() {
    let approval = OwnerApproval::granted(UserId::generate(), at(0));
    assert_eq!(
        session_with(Assurance::Normal, Some(approval)).owner_approval(),
        Some(approval)
    );
    assert_eq!(session_with(Assurance::Normal, None).owner_approval(), None);
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
    // The retired Pattern's flag (ADR-017 §3): an older database may still
    // hold the row, but the generic write path must never recognise the key,
    // so nothing can recreate it.
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
#[test]
fn piastres_multiply_by_units_is_exact_and_checked() {
    // Line total = quantity x unit price. The intermediate is i128 because
    // `units * price` overflows i64 long before either operand looks large,
    // and money refuses rather than clamps (minor.rs:41-47).
    assert_eq!(money(100).checked_mul_units(3), Some(money(300)));
    assert_eq!(Piastres::ZERO.checked_mul_units(1_000_000), Some(Piastres::ZERO));
    assert_eq!(money(0).checked_mul_units(0), Some(Piastres::ZERO));
    // 3e9 units at 8e9 minor: 2.4e19, far past i64::MAX. A naive i64 multiply
    // would wrap negative; the i128 intermediate keeps it exact or refuses.
    assert_eq!(money(8_000_000_000).checked_mul_units(3_000_000_000), None);
    assert_eq!(money(i64::MAX).checked_mul_units(2), None);
}

#[test]
fn piastres_multiply_refuses_negative_units() {
    // Quantities arrive from the transport; a negative one must not silently
    // become a negative amount, and Piastres cannot hold one.
    assert_eq!(money(100).checked_mul_units(-1), None);
    assert_eq!(money(100).checked_mul_units(0), Some(Piastres::ZERO));
}

#[test]
fn civil_date_handles_leap_year_and_month_boundaries() {
    use mobile_shop_system_lib::domain::sales::civil_ymd_from_millis;
    // 2024-02-29 exists (leap year); 2023-02-28 does not roll into March.
    assert_eq!(civil_ymd_from_millis(1709164800000), (2024, 2, 29));
    assert_eq!(civil_ymd_from_millis(1677542400000), (2023, 2, 28));
    // Year boundary: 2025-12-31 23:59:59 UTC -> next day is 2026-01-01.
    assert_eq!(civil_ymd_from_millis(1767225599000), (2025, 12, 31));
    assert_eq!(civil_ymd_from_millis(1767225600000), (2026, 1, 1));
    // Epoch itself is a Thursday, not a special case.
    assert_eq!(civil_ymd_from_millis(0), (1970, 1, 1));
}

#[test]
fn invoice_reference_omits_the_dash_when_no_prefix_is_set() {
    use mobile_shop_system_lib::domain::sales::format_invoice_reference;
    // Empty prefix is the documented device default (snapshot.rs:115-118):
    // bare sequence numbers, no leading dash.
    assert_eq!(format_invoice_reference("", 2026, 10, 12, 1), "20261012-0001");
    assert_eq!(format_invoice_reference("SHOP", 2026, 10, 12, 42), "SHOP-20261012-0042");
    assert_eq!(format_invoice_reference("SHOP", 2026, 10, 12, 9999), "SHOP-20261012-9999");
}

#[test]
fn sale_errors_have_stable_screaming_snake_codes() {
    use mobile_shop_system_lib::domain::sales::SaleError;
    assert_eq!(SaleError::Empty.code(), "SALE_EMPTY");
    assert_eq!(SaleError::ProductArchived.code(), "SALE_PRODUCT_ARCHIVED");
    assert_eq!(
        SaleError::DispositionNotSupported.code(),
        "SALE_DISPOSITION_NOT_SUPPORTED"
    );
    assert_eq!(SaleError::PriceNotSet.code(), "SALE_PRICE_NOT_SET");
    assert_eq!(SaleError::InvalidQuantity.code(), "SALE_INVALID_QUANTITY");
    assert_eq!(SaleError::ReferenceConflict.code(), "SALE_REFERENCE_CONFLICT");
    assert_eq!(SaleError::AlreadyCancelled.code(), "SALE_ALREADY_CANCELLED");
    assert_eq!(
        SaleError::ReversalInconsistent.code(),
        "SALE_REVERSAL_INCONSISTENT"
    );
    assert_eq!(SaleError::Busy.code(), "SALE_BUSY");
}

// ---------------------------------------------------------------------------
// Warranty dates on a sale line (decisions D4, D8, D9)
// ---------------------------------------------------------------------------
//
// D8: a warranty boundary is a CALENDAR DAY the operator typed, stored as
// `YYYY-MM-DD` — not an instant in epoch milliseconds like every other
// timestamp in this schema. "Covered until 15 March" must not depend on a
// timezone, and must not drift a day because a device clock moved.

#[test]
fn a_warranty_date_is_the_exact_day_the_operator_typed() {
    let date = WarrantyDate::parse("2027-03-15").expect("a real day");
    assert_eq!(date.to_string(), "2027-03-15");
    assert_eq!(date.as_str(), "2027-03-15");
    assert_eq!(
        WarrantyDate::parse("2026-01-01").expect("new year").as_str(),
        "2026-01-01",
        "a padded input is stored padded, never as `2026-1-1`"
    );
}

#[test]
fn a_day_that_does_not_exist_is_refused_rather_than_stored() {
    // The load-bearing case: a permissive parser would store 30 February and
    // the shop would honour a warranty end date that never arrives.
    for candidate in [
        "2026-02-30", // 2026 is not a leap year
        "2027-02-29", // and neither is 2027
        "2026-04-31", // April has 30 days
        "2026-06-31",
        "2026-09-31",
        "2026-11-31",
        "2026-13-01", // there is no month 13
        "2026-00-10", // nor month 0
        "2026-01-00", // nor day 0
        "2026-01-32",
    ] {
        assert_eq!(
            WarrantyDate::parse(candidate),
            Err(SaleError::WarrantyDateInvalid),
            "{candidate} is not a day and must be refused"
        );
    }
}

#[test]
fn a_leap_day_is_a_real_day_in_a_leap_year() {
    // The other side of the same rule: refusing 29 February outright would be
    // wrong, and 1900 (not a leap year) must still be refused.
    assert!(WarrantyDate::parse("2028-02-29").is_ok());
    assert!(WarrantyDate::parse("2000-02-29").is_ok(), "divisible by 400");
    assert_eq!(
        WarrantyDate::parse("1900-02-29"),
        Err(SaleError::WarrantyDateInvalid),
        "divisible by 100 but not 400"
    );
}

#[test]
fn a_warranty_date_in_any_shape_other_than_iso_is_refused() {
    // The operator types into a free-text field, so every plausible typo is
    // input. Accepting `15-03-2026` would store a day nobody can read back.
    for candidate in [
        "",
        " ",
        "2026-3-15",            // unpadded
        "2026-03-5",            // unpadded day
        "15-03-2026",           // day first
        "03-15-2026",           // American order
        "2026/03/15",           // slashes
        "2026-03-15T00:00:00Z", // an instant, which is what D8 refuses
        " 2026-03-15",          // leading space
        "2026-03-15 ",          // trailing space
        "2026-03-155",          // one digit too many
        "26-03-15",             // two-digit year
        "today",
        "2026-٠٣-١٥", // Arabic-Indic digits
    ] {
        assert_eq!(
            WarrantyDate::parse(candidate),
            Err(SaleError::WarrantyDateInvalid),
            "{candidate:?} must be refused"
        );
    }
}

#[test]
fn warranty_dates_order_by_their_text_because_iso_days_sort_that_way() {
    // The property the SQL CHECK on the table relies on: `warranty_end >=
    // warranty_start` compares TEXT, so text order must BE date order. If this
    // ever fails, the database constraint is comparing nonsense.
    let days = [
        "2026-01-01",
        "2026-01-02",
        "2026-02-28",
        "2026-10-12",
        "2026-12-31",
        "2027-01-01",
        "2027-03-15",
        "2028-01-01",
        "2028-02-29",
        "2031-12-31",
    ];
    let parsed: Vec<WarrantyDate> = days
        .iter()
        .map(|d| WarrantyDate::parse(d).expect("a real day"))
        .collect();
    let mut by_text: Vec<String> = parsed.iter().map(|d| d.to_string()).collect();
    let mut by_value = parsed.clone();
    by_text.sort();
    by_value.sort();
    assert_eq!(
        by_text,
        by_value
            .iter()
            .map(|d| d.to_string())
            .collect::<Vec<String>>(),
        "sorting the stored text must agree with sorting the dates"
    );
    assert_eq!(by_text[0], "2026-01-01");
    assert_eq!(by_text[by_text.len() - 1], "2031-12-31");
}

#[test]
fn a_warranty_range_that_ends_before_it_starts_is_refused() {
    let start = WarrantyDate::parse("2027-03-15").expect("a real day");

    assert_eq!(
        start.checked_end(Some(WarrantyDate::parse("2027-03-14").expect("a real day"))),
        Err(SaleError::WarrantyRangeInvalid),
        "a warranty that has already ended is not a warranty"
    );
    assert_eq!(
        start.checked_end(Some(WarrantyDate::parse("2026-03-15").expect("a real day"))),
        Err(SaleError::WarrantyRangeInvalid)
    );
}

#[test]
fn a_warranty_range_may_be_a_single_day_and_may_be_open_at_either_end() {
    let start = WarrantyDate::parse("2027-03-15").expect("a real day");

    assert_eq!(
        start
            .checked_end(Some(WarrantyDate::parse("2027-03-15").expect("a real day")))
            .expect("the same day is a valid one-day warranty"),
        Some("2027-03-15".to_string())
    );
    assert_eq!(
        start
            .checked_end(Some(WarrantyDate::parse("2029-12-31").expect("a real day")))
            .expect("a later end is valid"),
        Some("2029-12-31".to_string())
    );
    // Open-ended: an end the operator has not been given yet is not an error,
    // and the start on its own is a range that has not ended.
    assert_eq!(start.checked_end(None), Ok(None));
    assert!(WarrantyDate::parse("2027-03-15").is_ok());
}

#[test]
fn the_two_warranty_refusals_have_their_own_codes() {
    // Distinct codes, because the operator's two mistakes are different: a
    // mistyped shape versus a range that runs backwards.
    assert_eq!(
        SaleError::WarrantyDateInvalid.code(),
        "SALE_WARRANTY_DATE_INVALID"
    );
    assert_eq!(
        SaleError::WarrantyRangeInvalid.code(),
        "SALE_WARRANTY_RANGE_INVALID"
    );
    assert_ne!(
        SaleError::WarrantyDateInvalid.code(),
        SaleError::WarrantyRangeInvalid.code()
    );
    assert!(!SaleError::WarrantyDateInvalid.to_string().is_empty());
    assert!(!SaleError::WarrantyRangeInvalid.to_string().is_empty());
}

// ---------------------------------------------------------------------------
// The supplier label on receiving (P4b, decision D1)
// ---------------------------------------------------------------------------
//
// D1 is a NAME the operator typed on a delivery — not a counterparty entity, not
// a purchase order. `spec:29`/`§231` keep procurement out of V1, so this type
// holds text and nothing else: no identity, no ledger, no payable.

#[test]
fn a_supplier_name_is_trimmed_and_stored_trimmed() {
    let name = SupplierName::parse("  Vodafone Egypt ").expect("a real supplier");
    assert_eq!(name.as_str(), "Vodafone Egypt");
    assert_eq!(name.to_string(), "Vodafone Egypt");
    // A name kept for later lookup must read the same way every time it is
    // shown, and the migration stores exactly this text.
    assert_eq!(name.as_str(), name.as_str().trim());
}

#[test]
fn a_supplier_name_that_is_only_whitespace_is_refused_rather_than_replaced() {
    // The load-bearing rule. Trimming "   " would yield "", and an empty string
    // stored as a supplier would be a supplier the shop can neither search for
    // nor distinguish from "no supplier given".
    for candidate in ["", " ", "   ", "\t", "\n", " \t\n "] {
        assert_eq!(
            SupplierName::parse(candidate),
            Err(SupplierError::NameRequired),
            "{candidate:?} must be refused rather than trimmed into nothing"
        );
    }
}

#[test]
fn a_blank_field_reads_as_no_supplier_rather_than_as_an_empty_one() {
    // What the operator's untouched field means. `None` and `Some("")` are not
    // the same thing, and the column stores only one of them.
    assert_eq!(SupplierName::parse_optional(""), Ok(None));
    assert_eq!(SupplierName::parse_optional("   "), Ok(None));
    assert_eq!(
        SupplierName::parse_optional("Vodafone")
            .expect("a named supplier")
            .map(|name| name.as_str().to_string()),
        Some("Vodafone".to_string())
    );
}

#[test]
fn a_supplier_name_longer_than_the_operator_field_is_refused() {
    // The bound is the input field's, not the storage layer's appetite for long
    // text: this is a label typed on a phone.
    let longest = "س".repeat(SUPPLIER_NAME_MAX_CHARS);
    assert!(
        SupplierName::parse(&longest).is_ok(),
        "a name exactly at the bound is accepted"
    );
    let too_long = "س".repeat(SUPPLIER_NAME_MAX_CHARS + 1);
    assert_eq!(
        SupplierName::parse(&too_long),
        Err(SupplierError::NameTooLong),
        "one character past the bound must be refused"
    );
}

#[test]
fn a_supplier_name_keeps_the_capitalisation_and_digits_the_operator_typed() {
    // Case folding is a comparison rule for the storage index, never a
    // transformation of the operator's text.
    for candidate in ["STC", "stc", "Etisalat 2G", "0122-345-6789"] {
        assert_eq!(
            SupplierName::parse(candidate).expect("a real supplier").as_str(),
            candidate
        );
    }
}

#[test]
fn every_supplier_error_has_a_stable_code_the_frontend_can_index() {
    for error in [SupplierError::NameRequired, SupplierError::NameTooLong] {
        let code = error.code();
        assert!(!code.is_empty());
        assert_eq!(code, code.to_ascii_uppercase(), "{error:?} produced {code:?}");
        assert!(
            code.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
            "{error:?} produced {code:?}, which is not a screaming-snake identifier"
        );
        assert!(!error.to_string().is_empty());
    }
    assert_eq!(SupplierError::NameRequired.code(), "SUPPLIER_NAME_REQUIRED");
    assert_eq!(SupplierError::NameTooLong.code(), "SUPPLIER_NAME_TOO_LONG");
}