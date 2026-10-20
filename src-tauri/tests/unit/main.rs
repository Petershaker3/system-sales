//! Domain unit tests: no Tauri, no SQLite, no operating system.
//!
//! Every rule the identity domain owns is exercised here as a pure function.
//! `spec:135` requires role permissions to be unit tested, and `spec:139`
//! requires the boundaries of the lockout and expiry rules to be proven rather
//! than assumed.

use mobile_shop_system_lib::domain::catalog::{
    brand_aliases, brand_lines, can_delete_brand, decode_jpeg_data_url, ean13, ean13_check_digit,
    encode_ean13_bars, encode_jpeg_data_url, format_tspl_barcode_label, is_default_brand,
    next_shop_code, next_shop_codes, parse_jpeg_dimensions, phone_title, storage_label,
    validate_jpeg_192, variant_combos, variant_title, BrandDeviceType, BrandError, BrandId,
    BrandName, CatalogError, DeviceType, Disposition, ImageError, LabelDimensionsMm, PhoneDetails,
    PhoneModel, Product, ProductId, ProductImage, ProductName, ProductStatus, SalePrice,
    ShopCodeError, VariantDimension, VariantError, VariantParent, VariantParentId, VariantValue,
    DEFAULT_BRANDS, IMAGE_SIDE, MAX_IMAGE_BYTES, MAX_VARIANTS, VARIANT_DIMENSIONS,
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
        open_mode: false,
    }
}

/// The operator of a shop that has not claimed an account yet (`ADR-039`).
///
/// The `open_mode` flag is the whole difference between this and `facts()`: the
/// row behind it is a real `users` row, and the flag is what lets the two approval
/// axes answer for a device with no secret to prove.
fn open_mode_facts() -> SessionFacts {
    SessionFacts {
        open_mode: true,
        role: Role::Manager,
        assurance: Assurance::Reauthenticated,
        ..facts()
    }
}

fn open_mode_session() -> Session {
    Session::open(open_mode_facts(), at(0)).expect("an open session never expires on its own")
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
fn an_open_shop_carries_its_own_approval_for_sensitive_work() {
    // `ADR-039`: the owner-PIN approval protects the shop from a seller at an
    // unattended till. A shop with no account has no seller and no PIN, so the
    // approval is the session itself, and the audit names the open row on both
    // sides — which is the truth rather than a gap.
    let session = open_mode_session();
    let granted = session
        .require_sensitivity(Sensitivity::Sensitive, at(0))
        .expect("a shop with no account is not kept from its own stock");
    assert_eq!(
        granted.map(|approval| approval.approved_by()),
        Some(session.user_id()),
        "the approver of an open shop is the open row itself"
    );
}

#[test]
fn an_open_shop_still_refuses_nothing_it_would_refuse_signed_in() {
    // Routine work is unaffected: the open session must not claim an approval that
    // was never asked for, or a sale would spend the shop's patience for nothing.
    let session = open_mode_session();
    assert_eq!(
        session.require_sensitivity(Sensitivity::Routine, at(0)),
        Ok(None)
    );
}

#[test]
fn an_open_session_authorizes_the_owner_screens_and_a_seller_s_one_still_needs_a_row() {
    // The open row is a manager, so the screens a manager holds are open to it —
    // including the three that ask for a freshly proven password, which is exactly
    // why `open_mode` carries `Reauthenticated`: there is no password to prove yet.
    let session = open_mode_session();
    for permission in [
        Permission::ManageSettings,
        Permission::ManageUsers,
        Permission::ViewCostAndProfit,
        Permission::Sell,
    ] {
        assert_eq!(
            session.authorize(permission),
            Ok(()),
            "an open shop must reach {permission:?}"
        );
    }
    // The flag alone is not a role: a session that is not open and has not
    // reauthenticated is still refused.
    let signed_in = session_with(Assurance::Normal, None);
    assert_eq!(
        signed_in.authorize(Permission::ManageSettings),
        Err(DomainError::ReauthenticationRequired)
    );
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

// ---------------------------------------------------------------------------
// Product variants (ADR-018 §4, plan item 1.2 step 4)
// ---------------------------------------------------------------------------

#[test]
fn next_shop_codes_generates_a_consecutive_batch_past_the_highest_code() {
    assert_eq!(
        next_shop_codes(std::iter::empty::<&str>(), 0).expect("zero"),
        Vec::<String>::new()
    );
    assert_eq!(
        next_shop_codes(["2000000000015", "2000000000022"], 3).expect("three"),
        vec![
            "2000000000039".to_string(),
            "2000000000046".to_string(),
            "2000000000053".to_string(),
        ]
    );
    assert_eq!(
        next_shop_codes(["2999999999984"], 2),
        Err(ShopCodeError::Exhausted),
        "asking for two when only one sequence remains must fail cleanly"
    );
}

#[test]
fn every_variant_dimension_round_trips_through_its_arabic_label() {
    for label in VARIANT_DIMENSIONS {
        let parsed = VariantDimension::parse(label)
            .unwrap_or_else(|| panic!("{label} must parse as a VariantDimension"));
        assert_eq!(parsed.as_str(), label);
    }
    assert_eq!(
        VariantDimension::parse("  الموبايل  "),
        Some(VariantDimension::Phone)
    );
    assert_eq!(VariantDimension::parse("الماركة"), None);
    assert_eq!(VariantDimension::parse(""), None);
}

#[test]
fn a_variant_value_trims_and_collapses_spaces_and_refuses_blank() {
    let val = VariantValue::new("  Galaxy   A16  ").expect("value");
    assert_eq!(val.as_str(), "Galaxy A16");
    assert_eq!(val.to_string(), "Galaxy A16");
    for blank in ["", "   ", "\t\n"] {
        assert_eq!(VariantValue::new(blank), Err(VariantError::ValueRequired));
    }
}

#[test]
fn variant_combos_builds_one_and_two_dimensional_products_in_order() {
    let one_dim = variant_combos(&["20W".to_string(), "33W".to_string(), "65W".to_string()], &[])
        .expect("1D combos");
    let one_labels: Vec<(&str, Option<&str>)> = one_dim
        .iter()
        .map(|(v1, v2)| (v1.as_str(), v2.as_ref().map(VariantValue::as_str)))
        .collect();
    assert_eq!(
        one_labels,
        vec![("20W", None), ("33W", None), ("65W", None)]
    );

    let two_dim = variant_combos(
        &["Galaxy A16".to_string(), "iPhone 16".to_string()],
        &["أسود".to_string(), "شفاف".to_string()],
    )
    .expect("2D combos");
    let two_labels: Vec<(&str, Option<&str>)> = two_dim
        .iter()
        .map(|(v1, v2)| (v1.as_str(), v2.as_ref().map(VariantValue::as_str)))
        .collect();
    assert_eq!(
        two_labels,
        vec![
            ("Galaxy A16", Some("أسود")),
            ("Galaxy A16", Some("شفاف")),
            ("iPhone 16", Some("أسود")),
            ("iPhone 16", Some("شفاف")),
        ]
    );
}

#[test]
fn variant_combos_refuses_empty_duplicates_and_more_than_sixty() {
    assert_eq!(
        variant_combos(&[], &["أسود".to_string()]),
        Err(VariantError::VariantsEmpty),
        "the first dimension is required even when the second has values"
    );
    assert_eq!(
        variant_combos(&["Galaxy A16".to_string(), "galaxy  a16".to_string()], &[]),
        Err(VariantError::DuplicateValue)
    );
    assert_eq!(
        variant_combos(
            &["Galaxy A16".to_string()],
            &["أسود".to_string(), " أسود ".to_string()]
        ),
        Err(VariantError::DuplicateValue)
    );

    let ten: Vec<String> = (1..=10).map(|i| format!("M{i}")).collect();
    let six: Vec<String> = (1..=6).map(|i| format!("C{i}")).collect();
    let seven: Vec<String> = (1..=7).map(|i| format!("C{i}")).collect();
    assert_eq!(
        variant_combos(&ten, &six).expect("60 is the limit").len(),
        MAX_VARIANTS
    );
    assert_eq!(
        variant_combos(&ten, &seven),
        Err(VariantError::TooManyVariants)
    );
}

#[test]
fn variant_title_joins_base_and_values_with_single_spaces() {
    let v1 = VariantValue::new("Galaxy A16").expect("v1");
    let v2 = VariantValue::new("أسود").expect("v2");
    assert_eq!(
        variant_title("  جراب   سيليكون ملون ", &v1, Some(&v2)),
        "جراب سيليكون ملون Galaxy A16 أسود"
    );
    assert_eq!(
        variant_title("شاحن أنكر", &VariantValue::new("20W").expect("v1"), None),
        "شاحن أنكر 20W"
    );

    let parent = VariantParent::new(
        ProductName::new("جراب سيليكون ملون").expect("name"),
        mobile_shop_system_lib::domain::organisation::DepartmentId::generate(),
        VariantDimension::Phone,
        Some(VariantDimension::Color),
        UserId::generate(),
        100,
    );
    assert_ne!(parent.id, VariantParentId::generate());
    assert!(!parent.id.to_string().is_empty());
}

#[test]
fn every_variant_error_has_a_stable_screaming_snake_code() {
    for error in [
        VariantError::CategoryNotItem,
        VariantError::DimensionUnknown,
        VariantError::VariantsEmpty,
        VariantError::ValueRequired,
        VariantError::DuplicateValue,
        VariantError::TooManyVariants,
        VariantError::ParentAlreadyExists,
        VariantError::PriceRequired,
        VariantError::DuplicateBarcodeInBatch,
        VariantError::RowMismatch,
    ] {
        let code = error.code();
        assert!(code.starts_with("VARIANT_"), "{error:?} -> {code}");
        assert!(
            code.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
            "{code}"
        );
        assert_eq!(error.to_string(), code);
    }
}

// ---------------------------------------------------------------------------
// PRODUCT IMAGES (ADR-018 §5, plan item 1.2 step 5)
// ---------------------------------------------------------------------------

fn sample_jpeg(w: u16, h: u16, extra_app_bytes: usize) -> Vec<u8> {
    let mut out = vec![0xFF, 0xD8]; // SOI
    let app_len = 2 + extra_app_bytes;
    let app_len_u16 = u16::try_from(app_len).expect("app segment length");
    out.extend_from_slice(&[0xFF, 0xE0]); // APP0
    out.extend_from_slice(&app_len_u16.to_be_bytes());
    out.extend(std::iter::repeat_n(0x4A, extra_app_bytes));
    // SOF0 segment: length = 11 (2 length + 1 precision + 2 height + 2 width + 1 components + 3 comp)
    out.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x0B, 0x08]);
    out.extend_from_slice(&h.to_be_bytes());
    out.extend_from_slice(&w.to_be_bytes());
    out.extend_from_slice(&[0x01, 0x01, 0x11, 0x00]);
    // SOS + minimal scan + EOI
    out.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x7F]);
    out.extend_from_slice(&[0xFF, 0xD9]);
    out
}

#[test]
fn jpeg_192_validation_accepts_a_192_square_jpeg_and_rejects_everything_else() {
    let valid = sample_jpeg(IMAGE_SIDE, IMAGE_SIDE, 16);
    assert_eq!(parse_jpeg_dimensions(&valid), Ok((192, 192)));
    assert_eq!(validate_jpeg_192(&valid), Ok((192, 192)));

    let id = ProductId::generate();
    let img = ProductImage::from_jpeg_bytes(id, &valid).expect("valid 192x192 jpeg");
    assert_eq!(img.product_id, id);
    assert_eq!(img.file, format!("images/{id}.jpg"));
    assert_eq!((img.w, img.h, img.bytes), (192, 192, valid.len()));

    assert_eq!(validate_jpeg_192(&[]), Err(ImageError::Empty));
    assert_eq!(
        validate_jpeg_192(&vec![0xFF; MAX_IMAGE_BYTES + 1]),
        Err(ImageError::TooLarge)
    );
    assert_eq!(
        validate_jpeg_192(b"\x89PNG\r\n\x1a\nnot a jpeg"),
        Err(ImageError::NotJpeg)
    );
    assert_eq!(
        validate_jpeg_192(&sample_jpeg(128, 192, 4)),
        Err(ImageError::DimensionsInvalid)
    );
    assert_eq!(
        validate_jpeg_192(&sample_jpeg(192, 256, 4)),
        Err(ImageError::DimensionsInvalid)
    );
}

#[test]
fn jpeg_data_url_round_trips_all_base64_padding_lengths() {
    let id = ProductId::generate();
    for extra in [10usize, 11, 12] {
        let raw = sample_jpeg(192, 192, extra);
        let url = encode_jpeg_data_url(&raw);
        assert!(url.starts_with("data:image/jpeg;base64,"));
        let decoded = decode_jpeg_data_url(&url).expect("decode data url");
        assert_eq!(decoded, raw);

        let (meta, bytes) = ProductImage::from_data_url(id, &url).expect("from_data_url");
        assert_eq!(bytes, raw);
        assert_eq!(meta.bytes, raw.len());
    }

    assert_eq!(
        decode_jpeg_data_url("data:image/png;base64,AAAA"),
        Err(ImageError::NotJpeg)
    );
    assert_eq!(decode_jpeg_data_url("   "), Err(ImageError::Empty));
    assert_eq!(decode_jpeg_data_url("abc"), Err(ImageError::NotJpeg));
}

#[test]
fn every_image_error_has_a_stable_screaming_snake_code() {
    for error in [
        ImageError::Empty,
        ImageError::TooLarge,
        ImageError::NotJpeg,
        ImageError::DimensionsInvalid,
        ImageError::NotFound,
    ] {
        let code = error.code();
        assert!(code.starts_with("IMAGE_"), "{error:?} -> {code}");
        assert_eq!(error.to_string(), code);
    }
}

// ---------------------------------------------------------------------------
// Plan item 1.4 (ADR-019): IMEI units, Luhn validation, tracking & receipt kinds
// ---------------------------------------------------------------------------

use mobile_shop_system_lib::domain::unit::{
    luhn_check_digit, normalize_imei_digits, Imei, ReceiptKind, TrackingMode, UnitColor,
    UnitError, UnitStatus,
};

#[test]
fn imei_luhn_validates_15_digit_numbers_and_normalizes_arabic_digits() {
    assert_eq!(luhn_check_digit("35693803564380"), Some(9));
    assert_eq!(luhn_check_digit("49015420323751"), Some(8));
    assert_eq!(luhn_check_digit("12345"), None);

    let parsed = Imei::parse("3569-3803-5643-809").expect("valid IMEI with dashes");
    assert_eq!(parsed.as_str(), "356938035643809");

    let arabic = Imei::parse(" ٤٩٠١٥٤٢٠٣٢٣٧٥١٨ ").expect("Arabic digits normalized");
    assert_eq!(arabic.as_str(), "490154203237518");
    assert_eq!(normalize_imei_digits("٠١٢٣٤٥٦٧٨٩"), "0123456789");

    assert_eq!(
        Imei::parse("356938035643808"),
        Err(UnitError::ImeiCheckDigitInvalid)
    );
    assert_eq!(
        Imei::parse("35693803564380"),
        Err(UnitError::ImeiLengthInvalid)
    );
    assert_eq!(
        Imei::parse("35693803564380A"),
        Err(UnitError::ImeiLengthInvalid)
    );
}

#[test]
fn imei_batch_rejects_duplicates_and_preserves_order() {
    let ok = Imei::parse_batch(&[
        "356938035643809".to_string(),
        "490154203237518".to_string(),
    ])
    .expect("two distinct valid IMEIs");
    assert_eq!(ok.len(), 2);
    assert_eq!(ok[0].as_str(), "356938035643809");
    assert_eq!(ok[1].as_str(), "490154203237518");

    let dup = Imei::parse_batch(&[
        "356938035643809".to_string(),
        "٣٥٦٩٣٨٠٣٥٦٤٣٨٠٩".to_string(),
    ]);
    assert_eq!(dup, Err(UnitError::ImeiDuplicateInBatch));
}

#[test]
fn unit_domain_enums_and_color_round_trip() {
    for mode in [
        TrackingMode::None,
        TrackingMode::SerialOptional,
        TrackingMode::SerialRequired,
    ] {
        assert_eq!(TrackingMode::parse(mode.as_str()), Some(mode));
    }
    assert_eq!(TrackingMode::parse("other"), None);

    for kind in [ReceiptKind::Supplier, ReceiptKind::Opening] {
        assert_eq!(ReceiptKind::parse(kind.as_str()), Ok(kind));
    }
    assert_eq!(ReceiptKind::parse("gift"), Err(UnitError::ReceiptKindInvalid));

    for status in [UnitStatus::InStock, UnitStatus::Sold, UnitStatus::Retired] {
        assert_eq!(UnitStatus::parse(status.as_str()), Some(status));
    }

    assert_eq!(UnitColor::parse_optional(None), Ok(None));
    assert_eq!(UnitColor::parse_optional(Some("   ")), Ok(None));
    let black = UnitColor::parse_optional(Some("  أسود  "))
        .expect("valid")
        .expect("some");
    assert_eq!(black.as_str(), "أسود");
    let too_long = "أ".repeat(41);
    assert_eq!(
        UnitColor::parse_optional(Some(&too_long)),
        Err(UnitError::ColorTooLong)
    );
}

#[test]
fn pay_methods_setting_requires_cash_and_canonicalizes_order() {
    use mobile_shop_system_lib::domain::settings::appearance::{
        parse_pay_methods, DEFAULT_PAY_METHODS,
    };

    assert_eq!(
        parse_pay_methods(DEFAULT_PAY_METHODS).as_deref(),
        Some(DEFAULT_PAY_METHODS)
    );
    assert_eq!(
        parse_pay_methods("credit, cash, vf").as_deref(),
        Some("cash,vf,credit")
    );
    // Cash cannot be disabled.
    assert_eq!(parse_pay_methods("vf,instapay"), None);
    // Duplicate methods and unknown methods are refused.
    assert_eq!(parse_pay_methods("cash,vf,vf"), None);
    assert_eq!(parse_pay_methods("cash,crypto"), None);
}

#[test]
fn validate_sale_payments_enforces_enabled_methods_split_sum_and_credit_customer() {
    use mobile_shop_system_lib::domain::sales::{
        validate_sale_payments, PaymentMethod, SaleError, SalePaymentInput,
    };

    let enabled = "cash,vf,instapay,install,credit";

    // Split between cash and vf matching total succeeds.
    let split = validate_sale_payments(
        &[
            SalePaymentInput {
                method: "cash".to_string(),
                amount_minor: 300_00,
                reference: None,
                wallet_id: None,
            },
            SalePaymentInput {
                method: "vf".to_string(),
                amount_minor: 200_00,
                reference: Some("  0100123  ".to_string()),
                wallet_id: None,
            },
        ],
        500_00,
        enabled,
        false,
    )
    .expect("valid split");
    assert_eq!(split.len(), 2);
    assert_eq!(split[0].method, PaymentMethod::Cash);
    assert_eq!(split[1].method, PaymentMethod::Vf);
    assert_eq!(split[1].reference.as_deref(), Some("0100123"));

    // Disabled method (`card` omitted from `enabled`) is refused.
    assert_eq!(
        validate_sale_payments(
            &[SalePaymentInput {
                method: "card".to_string(),
                amount_minor: 500_00,
                reference: None,
                wallet_id: None,
            }],
            500_00,
            enabled,
            false,
        ),
        Err(SaleError::PaymentMethodDisabled)
    );

    // Instalment without provider reference is refused.
    assert_eq!(
        validate_sale_payments(
            &[SalePaymentInput {
                method: "install".to_string(),
                amount_minor: 500_00,
                reference: Some("   ".to_string()),
                wallet_id: None,
            }],
            500_00,
            enabled,
            false,
        ),
        Err(SaleError::InstallmentProviderRequired)
    );

    // Credit without customer is refused; with customer succeeds.
    assert_eq!(
        validate_sale_payments(
            &[SalePaymentInput {
                method: "credit".to_string(),
                amount_minor: 500_00,
                reference: None,
                wallet_id: None,
            }],
            500_00,
            enabled,
            false,
        ),
        Err(SaleError::CreditRequiresCustomer)
    );
    assert!(validate_sale_payments(
        &[SalePaymentInput {
            method: "credit".to_string(),
            amount_minor: 500_00,
            reference: None,
            wallet_id: None,
        }],
        500_00,
        enabled,
        true,
    )
    .is_ok());

    // Mismatched total is refused.
    assert_eq!(
        validate_sale_payments(
            &[SalePaymentInput {
                method: "cash".to_string(),
                amount_minor: 450_00,
                reference: None,
                wallet_id: None,
            }],
            500_00,
            enabled,
            false,
        ),
        Err(SaleError::PaymentTotalMismatch)
    );
}

#[test]
fn discount_validation_and_seller_limit_math_are_exact() {
    use mobile_shop_system_lib::domain::sales::{
        discount_exceeds_limit, validate_invoice_discount, validate_line_discount, SaleError,
    };
    use mobile_shop_system_lib::domain::settings::appearance::Appearance;

    assert_eq!(SaleError::DiscountInvalid.code(), "SALE_DISCOUNT_INVALID");
    assert_eq!(validate_line_discount(10_000, 0), Ok(10_000));
    assert_eq!(validate_line_discount(10_000, 500), Ok(9_500));
    assert_eq!(validate_line_discount(10_000, 10_000), Ok(0));
    assert_eq!(validate_line_discount(10_000, -1), Err(SaleError::DiscountInvalid));
    assert_eq!(
        validate_line_discount(10_000, 10_001),
        Err(SaleError::DiscountInvalid)
    );

    assert_eq!(validate_invoice_discount(9_500, 500), Ok(9_000));
    assert_eq!(
        validate_invoice_discount(9_500, 9_501),
        Err(SaleError::DiscountInvalid)
    );

    // 5% limit on 20_000 is 1_000: 1_000 does not exceed, 1_001 exceeds.
    assert!(!discount_exceeds_limit(20_000, 0, 5));
    assert!(!discount_exceeds_limit(20_000, 1_000, 5));
    assert!(discount_exceeds_limit(20_000, 1_001, 5));
    assert!(discount_exceeds_limit(20_000, 1, 0));
    assert!(!discount_exceeds_limit(20_000, 20_000, 100));

    let mut def = Appearance::default();
    assert_eq!(def.discount_limit_pct, "5");
    assert_eq!(def.discount_limit_pct_num(), 5);
    def.set("ui.discount_limit_pct", " 15 ").expect("valid");
    assert_eq!(def.discount_limit_pct, "15");
    assert_eq!(def.discount_limit_pct_num(), 15);
    assert!(def.set("ui.discount_limit_pct", "101").is_err());
    assert!(def.set("ui.discount_limit_pct", "-1").is_err());
    assert!(def.set("ui.discount_limit_pct", "5.5").is_err());
}

#[test]
fn shift_domain_and_seller_close_setting_are_validated() {
    use mobile_shop_system_lib::domain::settings::appearance::Appearance;
    use mobile_shop_system_lib::domain::shift::{
        validate_cash_movement_amount, validate_counted_cash, validate_expense_amount,
        validate_opening_cash, CashMovementKind, CashMovementReason, ExpenseCategory, ExpenseNote,
        ShiftCloseNote, ShiftError, ShiftTotals,
    };

    let mut a = Appearance::default();
    assert_eq!(a.seller_can_close_shift, "off");
    a.set("ui.seller_can_close_shift", "on").expect("on is valid");
    assert_eq!(a.seller_can_close_shift, "on");
    assert!(a.set("ui.seller_can_close_shift", "maybe").is_err());

    assert_eq!(validate_opening_cash(0).unwrap().as_minor(), 0);
    assert_eq!(
        validate_opening_cash(-10),
        Err(ShiftError::InvalidOpeningCash)
    );
    assert_eq!(
        validate_counted_cash(-1),
        Err(ShiftError::InvalidCountedCash)
    );
    assert_eq!(
        validate_expense_amount(0),
        Err(ShiftError::InvalidExpenseAmount)
    );
    assert_eq!(
        validate_cash_movement_amount(0),
        Err(ShiftError::InvalidCashMovementAmount)
    );
    assert_eq!(
        ExpenseCategory::new("  شاي وضيافة ").unwrap().as_str(),
        "شاي وضيافة"
    );
    assert!(ExpenseNote::parse_optional(Some("   ")).unwrap().is_none());
    assert!(ShiftCloseNote::parse_optional(None).unwrap().is_none());
    assert_eq!(
        CashMovementKind::parse("owner_draw").unwrap(),
        CashMovementKind::OwnerDraw
    );
    assert_eq!(
        CashMovementReason::new("سحب المالك").unwrap().as_str(),
        "سحب المالك"
    );

    let totals = ShiftTotals::compute(
        100_000, 150_000, 30_000, 20_000, 0, 0, 50_000, 250_000, 180_000, 3, 10_000, 5_000, 25_000,
        4_000,
    );
    // Expected drawer = 1000 + 1500 + 100 + 50 - 40 - 250 = 2,360 EGP (236_000 minor)
    assert_eq!(totals.expected_cash_minor, 236_000);
    assert_eq!(totals.gross_profit_minor, 70_000);
    assert_eq!(totals.net_profit_minor, 66_000);
}

#[test]
fn wallet_domain_and_service_fee_settings_are_validated() {
    use mobile_shop_system_lib::domain::settings::{Appearance, AppearanceKey};
    use mobile_shop_system_lib::domain::shift::ShiftTotals;
    use mobile_shop_system_lib::domain::wallet::{
        compute_auto_wallet_fee_minor, validate_wallet_color, WalletAlertState, WalletName,
        WalletOpKind, WalletPayMethod, WalletVia,
    };

    let mut a = Appearance::default();
    assert_eq!(a.service_fee_mode, "manual");
    assert_eq!(a.service_fee_pct, "1");
    assert_eq!(a.service_fee_min, "5");
    assert_eq!(a.bill_fee, "5");
    assert!(AppearanceKey::ServiceFeeMode.is_catalog_choice());
    assert!(AppearanceKey::ServiceFeePct.is_catalog_choice());
    assert!(AppearanceKey::ServiceFeeMin.is_catalog_choice());
    assert!(AppearanceKey::BillFee.is_catalog_choice());
    assert!(a.set("ui.service_fee_mode", "auto").is_ok());
    assert_eq!(a.service_fee_mode, "auto");
    assert!(a.set("ui.service_fee_mode", "invalid").is_err());
    assert!(a.set("ui.service_fee_pct", "2").is_ok());
    assert!(a.set("ui.service_fee_min", "10").is_ok());
    assert!(a.set("ui.bill_fee", "7").is_ok());

    assert_eq!(
        WalletName::new("  فودافون كاش  ").unwrap().as_str(),
        "فودافون كاش"
    );
    assert!(WalletName::new("   ").is_err());
    assert_eq!(validate_wallet_color("#E60000").unwrap(), "#e60000");
    assert!(validate_wallet_color("red").is_err());
    assert_eq!(
        WalletPayMethod::parse_optional(Some("vf")).unwrap(),
        Some(WalletPayMethod::Vf)
    );
    assert_eq!(WalletVia::parse("drawer").unwrap(), WalletVia::Drawer);
    assert!(WalletOpKind::Deposit.is_customer_service());
    assert!(!WalletOpKind::Move.is_customer_service());
    assert_eq!(compute_auto_wallet_fee_minor(100_000, 1, 500), 1_000);
    assert_eq!(compute_auto_wallet_fee_minor(20_000, 1, 500), 500);
    assert_eq!(
        WalletAlertState::compute(250_000, 300_000, 9_000_000),
        WalletAlertState::Low
    );

    let totals = ShiftTotals::compute_with_services(
        100_000, // opening: 1,000 EGP
        150_000, // cash sales: 1,500 EGP
        0,
        0,
        0,
        0,
        0,
        150_000,
        100_000,
        2,
        0,
        3,       // 3 services
        2_500,   // 25 EGP service fees
        101_000, // 1,010 EGP services cash in
        49_000,  // 490 EGP services cash out
        -20_000, // 200 EGP wallet topup from drawer
        0,
        0,
        5_000, // 50 EGP expenses
    );
    // Expected cash = 1000 + 1500 + 1010 - 490 - 200 - 50 = 2,770 EGP (277_000 minor)
    assert_eq!(totals.expected_cash_minor, 277_000);
    // Gross profit = 500 EGP; net = 500 + 25 - 50 = 475 EGP (47_500 minor)
    assert_eq!(totals.net_profit_minor, 47_500);
}

#[test]
fn partial_returns_and_default_refund_allocation_domain_rules_hold() {
    use mobile_shop_system_lib::domain::sales::{
        allocate_default_refund_payments, compute_partial_line_return,
        compute_return_refund_minor, PaymentMethod, ReturnCondition, SaleError,
        validate_return_reason,
    };

    assert_eq!(ReturnCondition::parse("intact").unwrap(), ReturnCondition::Intact);
    assert_eq!(ReturnCondition::parse("damaged").unwrap(), ReturnCondition::Damaged);
    assert_eq!(
        ReturnCondition::parse("broken"),
        Err(SaleError::ReturnConditionInvalid)
    );
    assert_eq!(validate_return_reason("  عيب صناعة  ").unwrap(), "عيب صناعة");
    assert_eq!(validate_return_reason("   "), Err(SaleError::ReturnReasonRequired));

    // Line of 3 units @ 100 EGP (10_000), line discount 1_000, line cost 18_000 (6_000/unit).
    let r1 = compute_partial_line_return(
        3,
        10_000,
        1_000,
        Some(6_000),
        18_000,
        0,
        0,
        0,
        1,
    )
    .expect("first partial return of 1 unit");
    assert_eq!(r1.quantity, 1);
    assert_eq!(r1.discount_minor, 333);
    assert_eq!(r1.line_total_minor, 10_000 - 333);
    assert_eq!(r1.line_cost_minor, 6_000);

    // Returning the remaining 2 units takes the exact remainder so sum == original.
    let r2 = compute_partial_line_return(
        3,
        10_000,
        1_000,
        Some(6_000),
        18_000,
        r1.quantity,
        r1.discount_minor,
        r1.line_cost_minor,
        2,
    )
    .expect("second partial return of remaining 2 units");
    assert_eq!(r1.discount_minor + r2.discount_minor, 1_000);
    assert_eq!(r1.line_total_minor + r2.line_total_minor, 29_000);
    assert_eq!(r1.line_cost_minor + r2.line_cost_minor, 18_000);

    // Returning a 4th unit is refused.
    assert_eq!(
        compute_partial_line_return(
            3,
            10_000,
            1_000,
            Some(6_000),
            18_000,
            3,
            1_000,
            18_000,
            1,
        ),
        Err(SaleError::ReturnQuantityExceedsRemaining)
    );

    // Invoice-level discount pro-rating + exact final remainder.
    let (ref1, disc1) = compute_return_refund_minor(27_000, 30_000, 0, 0, 10_000);
    assert_eq!(disc1, 1_000);
    assert_eq!(ref1, 9_000);
    let (ref2, disc2) = compute_return_refund_minor(27_000, 30_000, 10_000, ref1, 20_000);
    assert_eq!(ref1 + ref2, 27_000);
    assert_eq!(disc1 + disc2, 3_000);

    // Default refund allocation across split payment methods.
    let alloc = allocate_default_refund_payments(
        &[
            (PaymentMethod::Cash, 10_000, None, None),
            (
                PaymentMethod::Vf,
                17_000,
                Some("VF-1".to_owned()),
                Some("w-2".to_owned()),
            ),
        ],
        PaymentMethod::Cash,
        15_000,
    );
    assert_eq!(alloc.len(), 2);
    assert_eq!(alloc[0].method, PaymentMethod::Cash);
    assert_eq!(alloc[0].amount_minor, 10_000);
    assert_eq!(alloc[1].method, PaymentMethod::Vf);
    assert_eq!(alloc[1].amount_minor, 5_000);
    // A refund leaves by the number that took the money (`ADR-041`), and a row that names none
    // leaves the seller with nothing to inherit rather than a guess.
    assert_eq!(alloc[1].wallet_id.as_deref(), Some("w-2"));
    assert_eq!(alloc[0].wallet_id, None);
}

#[test]
fn ean13_bar_encoding_and_tspl_label_formatting() {
    let empty: [&str; 0] = [];
    let code = next_shop_code(empty).expect("first internal shop code");
    assert_eq!(code, "2000000000015");
    let bars = encode_ean13_bars(&code).expect("valid 95-module GS1 EAN-13 bars");
    assert_eq!(bars.len(), 95);
    assert!(bars.starts_with("101"));
    assert_eq!(&bars[45..50], "01010");
    assert!(bars.ends_with("101"));
    assert_eq!(encode_ean13_bars("2000000000014"), None);

    let tspl = format_tspl_barcode_label(LabelDimensionsMm::STANDARD_40X30, &code, 3);
    assert!(tspl.contains("SIZE 40 mm, 30 mm"));
    assert!(tspl.contains("GAP 2 mm, 0 mm"));
    assert!(tspl.contains("BARCODE 24,88,\"EAN13\",64,1,0,2,2,\"2000000000015\""));
    assert!(tspl.contains("PRINT 3,1"));
}

/// A handset is "connected" only while the wire says so (`ADR-042`).
///
/// The companion panel used to print two phones and say they were online because
/// that is what the demo data looked like. These are the bounds of the rule that
/// replaced it: the window is inclusive, a device that has never spoken is not
/// connected, and a clock that moved backwards is not a connection either.
#[test]
fn a_phone_counts_as_connected_only_while_it_is_being_heard() {
    use mobile_shop_system_lib::domain::companion::{is_online, ONLINE_WINDOW_MS};

    assert!(!is_online(0, 1_000), "never heard from is not connected");
    assert!(is_online(1_000, 1_000), "this instant counts");
    assert!(
        is_online(1_000, 1_000 + ONLINE_WINDOW_MS),
        "the edge of the window still counts"
    );
    assert!(
        !is_online(1_000, 1_001 + ONLINE_WINDOW_MS),
        "one millisecond past it does not"
    );
    assert!(!is_online(5_000, 1_000), "a future last-seen is not a connection");
}

/// What a capture must contain before either side queues it (`ADR-042`).
///
/// `one_off` is refused on purpose: that disposition has no stock balance for a
/// receipt to move, so accepting it would mean writing a draft the shop then has to
/// explain away in the ledger.
#[test]
fn a_capture_draft_is_checked_before_it_is_held() {
    use mobile_shop_system_lib::domain::companion::{
        validate_intake_draft, CompanionIntakeDraft, MAX_INTAKE_PHOTOS,
    };

    let base = || CompanionIntakeDraft {
        id: "draft-1".to_string(),
        // Empty means a product: every draft written before expenses existed (`ADR-043`).
        kind: String::new(),
        expense_category: String::new(),
        expense_amount_minor: 0,
        expense_paid_from: String::new(),
        expense_note: String::new(),
        pair_code: "PAIR-1".to_string(),
        device_name: "موبايل بيتر".to_string(),
        created_at: 1,
        disposition: "quantity".to_string(),
        product_name: "شاحن".to_string(),
        barcode: String::new(),
        quantity: 2,
        unit_cost_minor: 25_000,
        imeis: Vec::new(),
        photos: Vec::new(),
        product_id: None,
        receipt_id: None,
        pushed_at: None,
        push_error: None,
        note: None,
    };
    assert_eq!(validate_intake_draft(&base()), Ok(()));

    let mut no_name = base();
    no_name.product_name = "   ".to_string();
    assert_eq!(
        validate_intake_draft(&no_name),
        Err("draft carries no product name")
    );

    let mut serialised = base();
    serialised.disposition = "serialized".to_string();
    assert!(
        validate_intake_draft(&serialised).is_err(),
        "a serialized draft with no IMEI leaves a unit nobody can sell"
    );

    let mut one_off = base();
    one_off.disposition = "one_off".to_string();
    assert!(
        validate_intake_draft(&one_off).is_err(),
        "a one-off item has no stock balance for a receipt to move"
    );

    let mutations: [fn(&mut CompanionIntakeDraft); 7] = [
        |draft| draft.quantity = 0,
        |draft| draft.quantity = -3,
        |draft| draft.unit_cost_minor = -1,
        |draft| draft.device_name = " ".to_string(),
        |draft| draft.photos = vec!["x".to_string(); MAX_INTAKE_PHOTOS + 1],
        |draft| draft.imeis = vec!["1".to_string(); 41],
        |draft| draft.product_name = "س".repeat(400),
    ];
    for mutate in mutations {
        let mut draft = base();
        mutate(&mut draft);
        assert!(
            validate_intake_draft(&draft).is_err(),
            "a draft that breaks one of the caps must be refused, not trimmed"
        );
    }
}

/// One queue, two kinds (`ADR-043`).
///
/// A draft is either a product capture or money that left the shop, and the wire
/// guard refuses anything else — including a draft that carries half of each. The
/// empty `kind` is not a third kind: it is every draft stored before expenses
/// existed, and it must still read as a product.
#[test]
fn an_expense_draft_says_where_its_money_came_from() {
    use mobile_shop_system_lib::domain::companion::{
        draft_kind, validate_intake_draft, CompanionIntakeDraft, DraftKind, MAX_EXPENSE_NOTE_CHARS,
    };

    let base = |kind: &str| CompanionIntakeDraft {
        id: "draft-1".to_string(),
        kind: kind.to_string(),
        expense_category: "إيجار".to_string(),
        expense_amount_minor: 500_000,
        expense_paid_from: "outside".to_string(),
        expense_note: "إيجار أكتوبر".to_string(),
        pair_code: "PAIR-1".to_string(),
        device_name: "موبايل بيتر".to_string(),
        created_at: 1,
        disposition: String::new(),
        product_name: String::new(),
        barcode: String::new(),
        quantity: 0,
        unit_cost_minor: 0,
        imeis: Vec::new(),
        photos: Vec::new(),
        product_id: None,
        receipt_id: None,
        pushed_at: None,
        push_error: None,
        note: None,
    };

    assert_eq!(draft_kind(&base("expense")), Some(DraftKind::Expense));
    assert_eq!(draft_kind(&base("")), Some(DraftKind::Product));
    assert_eq!(draft_kind(&base("product")), Some(DraftKind::Product));
    assert_eq!(
        draft_kind(&base("rent")),
        None,
        "an unknown word is refused rather than guessed into stock or into money"
    );
    assert_eq!(validate_intake_draft(&base("expense")), Ok(()));
    assert!(
        validate_intake_draft(&base("rent")).is_err(),
        "a typo must not become a ledger row"
    );

    // Each half of the expense is required, in the shop's own words.
    let mut no_category = base("expense");
    no_category.expense_category = "  ".to_string();
    assert!(validate_intake_draft(&no_category).is_err());

    let mut no_amount = base("expense");
    no_amount.expense_amount_minor = 0;
    assert!(validate_intake_draft(&no_amount).is_err());

    let mut no_source = base("expense");
    no_source.expense_paid_from = String::new();
    assert!(
        validate_intake_draft(&no_source).is_err(),
        "a default source would decide whether the drawer shrinks"
    );

    let mut long_note = base("expense");
    long_note.expense_note = "ن".repeat(MAX_EXPENSE_NOTE_CHARS + 1);
    assert!(validate_intake_draft(&long_note).is_err());

    // The two kinds are separate: an expense does not need a product name, and a
    // product draft does not need an amount.
    let mut product = base("");
    product.kind = "product".to_string();
    product.product_name = "شاحن".to_string();
    product.disposition = "quantity".to_string();
    product.quantity = 2;
    assert_eq!(validate_intake_draft(&product), Ok(()));
}
