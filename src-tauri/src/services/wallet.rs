//! Shop wallets and services ledger use cases (Plan item 1.10, `ADR-025`, `PLAN.md` §9, §12, §16, §19).
//!
//! No SQL appears here; persistence queries live in `data/repositories/wallet.rs`.

use std::fmt;

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::wallet as repo;
use crate::domain::identity::{DomainError, Permission, Timestamp};
use crate::domain::wallet::{
    validate_non_negative_minor, validate_optional_note, validate_void_reason,
    validate_wallet_color, validate_wallet_company, validate_wallet_number, ServicesWindowTotals,
    WalletError, WalletId,
    WalletName, WalletOpId, WalletOpKind, WalletOpRecord, WalletPayMethod, WalletRecord,
    WalletSummary, WalletVia, MAX_SERVICE_REFERENCE_CHARS, MAX_SERVICE_TYPE_CHARS,
};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// Combined overview returned for the «المحافظ» screen and `F9` services dialog.
#[derive(Debug, Clone)]
pub struct WalletsOverview {
    pub wallets: Vec<WalletSummary>,
    pub ops: Vec<WalletOpRecord>,
    pub services_window: ServicesWindowTotals,
}

/// Input payload for updating a shop wallet's configuration in Settings.
#[derive(Debug, Clone)]
pub struct UpdateWalletInput {
    pub wallet_id: String,
    pub name: String,
    pub number: String,
    pub color: String,
    pub opening_balance_minor: i64,
    pub min_alert_minor: i64,
    pub max_limit_minor: i64,
    pub daily_limit_minor: i64,
    pub pay_method: Option<String>,
    /// The company this number belongs to (`ADR-040`). Blank clears the grouping.
    pub company: Option<String>,
    pub sort: i64,
    pub hidden: bool,
}

/// Service error combining identity/session errors and wallet domain errors.
#[derive(Debug)]
pub enum WalletServiceError {
    Identity(DomainError),
    Wallet(WalletError),
}

impl From<DomainError> for WalletServiceError {
    fn from(error: DomainError) -> Self {
        Self::Identity(error)
    }
}

impl From<WalletError> for WalletServiceError {
    fn from(error: WalletError) -> Self {
        Self::Wallet(error)
    }
}

impl WalletServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Identity(error) => error.code(),
            Self::Wallet(error) => error.code(),
        }
    }
}

impl fmt::Display for WalletServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Identity(error) => write!(f, "{error}"),
            Self::Wallet(error) => write!(f, "{}", error.code()),
        }
    }
}

impl std::error::Error for WalletServiceError {}

/// Read all wallets (with live balances and period stats), operations log, and services window summary.
pub async fn wallets_overview(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    today_from_ms: i64,
    period_from_ms: i64,
    period_to_ms: i64,
    wallet_id: Option<&str>,
    limit: u32,
) -> Result<WalletsOverview, WalletServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let wallets = repo::compute_wallet_summaries(
        &mut conn,
        today_from_ms.max(0),
        period_from_ms.max(0),
        period_to_ms.max(0),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    let filtered_wid = wallet_id.map(str::trim).filter(|s| !s.is_empty());
    let ops = repo::list_wallet_ops(
        &mut conn,
        filtered_wid,
        period_from_ms.max(0),
        period_to_ms.max(0),
        limit.clamp(1, 500),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    let services_window = repo::compute_services_window_totals(
        &mut conn,
        period_from_ms.max(0),
        period_to_ms.max(0),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(WalletsOverview {
        wallets,
        ops,
        services_window,
    })
}

/// Record a customer wallet operation (`deposit` or `withdraw`) without requiring a customer number (`ADR-016` #27).
pub async fn record_wallet_op(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    wallet_id: &str,
    kind_raw: &str,
    amount_minor: i64,
    fee_minor: i64,
    note_raw: Option<&str>,
) -> Result<WalletOpRecord, WalletServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let kind = WalletOpKind::parse(kind_raw)?;
    if !matches!(kind, WalletOpKind::Deposit | WalletOpKind::Withdraw) {
        return Err(WalletError::WalletOpKindInvalid.into());
    }
    if amount_minor <= 0 {
        return Err(WalletError::WalletOpAmountInvalid.into());
    }
    if fee_minor < 0 {
        return Err(WalletError::WalletOpFeeInvalid.into());
    }
    if kind == WalletOpKind::Withdraw && fee_minor > amount_minor {
        return Err(WalletError::WalletOpFeeExceedsAmount.into());
    }
    let note = validate_optional_note(note_raw)?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let wallet = repo::find_wallet_by_id(&mut tx, wallet_id.trim())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(WalletError::WalletNotFound)?;

    if kind == WalletOpKind::Deposit {
        let balance_minor = repo::compute_wallet_balance_minor(&mut tx, &wallet)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        if amount_minor > balance_minor {
            return Err(WalletError::WalletInsufficientBalance.into());
        }
    }

    let op = WalletOpRecord {
        id: WalletOpId::generate(),
        wallet_id: Some(wallet.id.clone()),
        to_wallet_id: None,
        kind,
        via: None,
        service_type: None,
        reference: None,
        amount_minor,
        fee_minor,
        note,
        created_by: actor,
        created_at: now,
        voided_by: None,
        voided_at: None,
        void_reason: None,
    };

    repo::insert_wallet_op(&mut tx, &op)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let detail = format!(
        r#"{{"op_id":"{}","wallet_id":"{}","kind":"{}","amount_minor":{},"fee_minor":{}}}"#,
        op.id.as_str(),
        wallet.id.as_str(),
        kind.as_str(),
        amount_minor,
        fee_minor
    );
    audit::append(&mut tx, actor, audit::event::WALLET_OP_RECORDED, now, Some(detail))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(op)
}

/// Record a quick service operation (`bill`, `card`, or `software`) in `wallet_ops` (`ADR-025` §1).
pub async fn record_service_op(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    kind_raw: &str,
    service_type_raw: &str,
    reference_raw: Option<&str>,
    amount_minor: i64,
    fee_minor: i64,
    note_raw: Option<&str>,
) -> Result<WalletOpRecord, WalletServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let kind = WalletOpKind::parse(kind_raw)?;
    if !matches!(
        kind,
        WalletOpKind::Bill | WalletOpKind::Card | WalletOpKind::Software
    ) {
        return Err(WalletError::WalletOpKindInvalid.into());
    }

    let service_type = service_type_raw.trim();
    if service_type.is_empty()
        || service_type.chars().count() > MAX_SERVICE_TYPE_CHARS
        || service_type.chars().any(char::is_control)
    {
        return Err(WalletError::WalletOpKindInvalid.into());
    }

    let reference = match reference_raw {
        Some(r) => {
            let t = r.trim();
            if t.is_empty() {
                None
            } else if t.chars().count() > MAX_SERVICE_REFERENCE_CHARS
                || t.chars().any(char::is_control)
            {
                return Err(WalletError::WalletOpNoteInvalid.into());
            } else {
                Some(t.to_owned())
            }
        }
        None => None,
    };

    match kind {
        WalletOpKind::Bill | WalletOpKind::Card => {
            if amount_minor <= 0 {
                return Err(WalletError::WalletOpAmountInvalid.into());
            }
            if fee_minor < 0 {
                return Err(WalletError::WalletOpFeeInvalid.into());
            }
        }
        WalletOpKind::Software => {
            if fee_minor <= 0 {
                return Err(WalletError::WalletOpAmountInvalid.into());
            }
        }
        _ => unreachable!(),
    }

    let normalized_amount = if kind == WalletOpKind::Software {
        0
    } else {
        amount_minor
    };
    let note = validate_optional_note(note_raw)?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let op = WalletOpRecord {
        id: WalletOpId::generate(),
        wallet_id: None,
        to_wallet_id: None,
        kind,
        via: None,
        service_type: Some(service_type.to_owned()),
        reference,
        amount_minor: normalized_amount,
        fee_minor,
        note,
        created_by: actor,
        created_at: now,
        voided_by: None,
        voided_at: None,
        void_reason: None,
    };

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    repo::insert_wallet_op(&mut tx, &op)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let detail = format!(
        r#"{{"op_id":"{}","kind":"{}","service_type":"{}","amount_minor":{},"fee_minor":{}}}"#,
        op.id.as_str(),
        kind.as_str(),
        service_type,
        normalized_amount,
        fee_minor
    );
    audit::append(&mut tx, actor, audit::event::WALLET_OP_RECORDED, now, Some(detail))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(op)
}

/// Record an owner wallet movement (`topup`, `unload`, or `move`) (`ADR-025` §1).
pub async fn record_wallet_movement(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    kind_raw: &str,
    wallet_id: &str,
    to_wallet_id_raw: Option<&str>,
    via_raw: Option<&str>,
    amount_minor: i64,
    note_raw: Option<&str>,
) -> Result<WalletOpRecord, WalletServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;

    let kind = WalletOpKind::parse(kind_raw)?;
    if !matches!(
        kind,
        WalletOpKind::Topup | WalletOpKind::Unload | WalletOpKind::Move
    ) {
        return Err(WalletError::WalletOpKindInvalid.into());
    }
    if amount_minor <= 0 {
        return Err(WalletError::WalletOpAmountInvalid.into());
    }
    let note = validate_optional_note(note_raw)?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let wallet = repo::find_wallet_by_id(&mut tx, wallet_id.trim())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(WalletError::WalletNotFound)?;

    let (to_wallet_id, via) = match kind {
        WalletOpKind::Topup | WalletOpKind::Unload => {
            let v = WalletVia::parse(via_raw.unwrap_or(""))?;
            if kind == WalletOpKind::Unload {
                let bal = repo::compute_wallet_balance_minor(&mut tx, &wallet)
                    .await
                    .map_err(|_| DomainError::StorageUnavailable)?;
                if amount_minor > bal {
                    return Err(WalletError::WalletInsufficientBalance.into());
                }
            }
            (None, Some(v))
        }
        WalletOpKind::Move => {
            let target_raw = to_wallet_id_raw
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or(WalletError::WalletNotFound)?;
            if target_raw == wallet.id.as_str() {
                return Err(WalletError::WalletOpKindInvalid.into());
            }
            let target = repo::find_wallet_by_id(&mut tx, target_raw)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?
                .ok_or(WalletError::WalletNotFound)?;
            let bal = repo::compute_wallet_balance_minor(&mut tx, &wallet)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
            if amount_minor > bal {
                return Err(WalletError::WalletInsufficientBalance.into());
            }
            (Some(target.id), None)
        }
        _ => unreachable!(),
    };

    let op = WalletOpRecord {
        id: WalletOpId::generate(),
        wallet_id: Some(wallet.id.clone()),
        to_wallet_id,
        kind,
        via,
        service_type: None,
        reference: None,
        amount_minor,
        fee_minor: 0,
        note,
        created_by: actor,
        created_at: now,
        voided_by: None,
        voided_at: None,
        void_reason: None,
    };

    repo::insert_wallet_op(&mut tx, &op)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let detail = format!(
        r#"{{"op_id":"{}","wallet_id":"{}","kind":"{}","amount_minor":{}}}"#,
        op.id.as_str(),
        wallet.id.as_str(),
        kind.as_str(),
        amount_minor
    );
    audit::append(&mut tx, actor, audit::event::WALLET_OP_RECORDED, now, Some(detail))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(op)
}

/// Reconcile a wallet's balance against its real app balance (`adjust`, owner only).
/// Returns `Ok(None)` if `real_balance_minor` already equals the computed balance.
pub async fn reconcile_wallet(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    wallet_id: &str,
    real_balance_minor: i64,
    reason_raw: &str,
    note_raw: Option<&str>,
) -> Result<Option<WalletOpRecord>, WalletServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;

    if real_balance_minor < 0 {
        return Err(WalletError::WalletOpAmountInvalid.into());
    }

    let actor = session.user_id();
    let now = Timestamp::now();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let wallet = repo::find_wallet_by_id(&mut tx, wallet_id.trim())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(WalletError::WalletNotFound)?;

    let expected_minor = repo::compute_wallet_balance_minor(&mut tx, &wallet)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let diff_minor = real_balance_minor - expected_minor;
    if diff_minor == 0 {
        return Ok(None);
    }

    let reason = validate_void_reason(reason_raw)?;
    let extra = validate_optional_note(note_raw)?;
    let combined_note = match extra {
        Some(n) => format!("جرد: {reason}، {n}"),
        None => format!("جرد: {reason}"),
    };
    let final_note = validate_optional_note(Some(&combined_note))?;

    let op = WalletOpRecord {
        id: WalletOpId::generate(),
        wallet_id: Some(wallet.id.clone()),
        to_wallet_id: None,
        kind: WalletOpKind::Adjust,
        via: None,
        service_type: None,
        reference: None,
        amount_minor: diff_minor,
        fee_minor: 0,
        note: final_note,
        created_by: actor,
        created_at: now,
        voided_by: None,
        voided_at: None,
        void_reason: None,
    };

    repo::insert_wallet_op(&mut tx, &op)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let detail = format!(
        r#"{{"op_id":"{}","wallet_id":"{}","kind":"adjust","diff_minor":{}}}"#,
        op.id.as_str(),
        wallet.id.as_str(),
        diff_minor
    );
    audit::append(&mut tx, actor, audit::event::WALLET_OP_RECORDED, now, Some(detail))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(Some(op))
}

/// Void a recorded operation with a reason (owner only; row remains in `wallet_ops` struck through).
pub async fn void_wallet_op(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    op_id: &str,
    reason_raw: &str,
) -> Result<WalletOpRecord, WalletServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;

    let reason = validate_void_reason(reason_raw)?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let existing = repo::find_wallet_op_by_id(&mut tx, op_id.trim())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(WalletError::WalletOpNotFound)?;

    if existing.is_voided() {
        return Err(WalletError::WalletOpAlreadyVoided.into());
    }

    let voided_at = Timestamp::from_millis(now.as_millis().max(existing.created_at.as_millis()));
    repo::void_wallet_op(&mut tx, existing.id.as_str(), &actor, voided_at, &reason)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let detail = format!(
        r#"{{"op_id":"{}","kind":"{}"}}"#,
        existing.id.as_str(),
        existing.kind.as_str()
    );
    audit::append(&mut tx, actor, audit::event::WALLET_OP_VOIDED, voided_at, Some(detail))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let updated = repo::find_wallet_op_by_id(&mut tx, existing.id.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(WalletError::WalletOpNotFound)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(updated)
}

/// Create a custom shop wallet (owner only).
pub async fn create_wallet(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    name_raw: &str,
    color_raw: &str,
    number_raw: Option<&str>,
    company_raw: Option<&str>,
) -> Result<WalletRecord, WalletServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;

    let name = WalletName::new(name_raw)?;
    let color = validate_wallet_color(color_raw)?;
    let number = validate_wallet_number(number_raw.unwrap_or(""))?;
    let company = validate_wallet_company(company_raw)?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    if repo::find_wallet_by_name(&mut tx, name.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .is_some()
    {
        return Err(WalletError::WalletNameDuplicate.into());
    }

    let sort = repo::next_wallet_sort(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let wallet = WalletRecord {
        id: WalletId::generate(),
        name,
        company,
        number,
        color,
        opening_balance_minor: 0,
        min_alert_minor: 0,
        max_limit_minor: 0,
        daily_limit_minor: 0,
        pay_method: None,
        sort,
        hidden: false,
        is_custom: true,
        created_at: now,
    };

    repo::insert_wallet(&mut tx, &wallet)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let detail = format!(r#"{{"action":"created","wallet_id":"{}"}}"#, wallet.id.as_str());
    audit::append(&mut tx, actor, audit::event::WALLET_CHANGED, now, Some(detail))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(wallet)
}

/// The wallet numbers that can receive a sale paid with `method` (`ADR-040`).
///
/// A seller may read this: it is the choice the pay screen offers when one company holds more
/// than one number. Deliberately not `wallets_overview` — the POS hot path must not pull every
/// wallet's balances and period stats to name a number, so no totals are computed here.
pub async fn payment_wallet_candidates(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    method_raw: &str,
) -> Result<Vec<WalletRecord>, WalletServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::Sell)?;

    let method = WalletPayMethod::parse_optional(Some(method_raw))?
        .ok_or(WalletError::WalletPayMethodInvalid)?;

    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let wallets = repo::list_payment_wallets(&mut conn, method)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(wallets)
}

/// Update an existing shop wallet's configuration (owner only).
pub async fn update_wallet(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    input: UpdateWalletInput,
) -> Result<WalletRecord, WalletServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;

    let name = WalletName::new(&input.name)?;
    let number = validate_wallet_number(&input.number)?;
    let color = validate_wallet_color(&input.color)?;
    let opening_balance_minor = validate_non_negative_minor(input.opening_balance_minor)?;
    let min_alert_minor = validate_non_negative_minor(input.min_alert_minor)?;
    let max_limit_minor = validate_non_negative_minor(input.max_limit_minor)?;
    let daily_limit_minor = validate_non_negative_minor(input.daily_limit_minor)?;
    let pay_method = WalletPayMethod::parse_optional(input.pay_method.as_deref())?;
    let company = validate_wallet_company(input.company.as_deref())?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let mut existing = repo::find_wallet_by_id(&mut tx, input.wallet_id.trim())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(WalletError::WalletNotFound)?;

    if let Some(clash) = repo::find_wallet_by_name(&mut tx, name.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        if clash.id != existing.id {
            return Err(WalletError::WalletNameDuplicate.into());
        }
    }

    // No `pay_method` is taken away from another wallet here. Several numbers of one company
    // may receive the same method since `ADR-040`; clearing the link elsewhere would silently
    // re-point where tomorrow's money lands because someone edited an unrelated number.
    existing.name = name;
    existing.number = number;
    existing.color = color;
    existing.opening_balance_minor = opening_balance_minor;
    existing.min_alert_minor = min_alert_minor;
    existing.max_limit_minor = max_limit_minor;
    existing.daily_limit_minor = daily_limit_minor;
    existing.pay_method = pay_method;
    existing.company = company;
    existing.sort = input.sort;
    existing.hidden = input.hidden;

    repo::update_wallet(&mut tx, &existing)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let detail = format!(r#"{{"action":"updated","wallet_id":"{}"}}"#, existing.id.as_str());
    audit::append(&mut tx, actor, audit::event::WALLET_CHANGED, now, Some(detail))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(existing)
}

/// Delete a custom shop wallet that has no recorded operations (owner only).
pub async fn delete_wallet(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    wallet_id: &str,
) -> Result<(), WalletServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageCatalog)?;
    let actor = session.user_id();
    let now = Timestamp::now();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let existing = repo::find_wallet_by_id(&mut tx, wallet_id.trim())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(WalletError::WalletNotFound)?;

    if !existing.is_custom {
        return Err(WalletError::WalletDeleteForbidden.into());
    }
    let has_ops = repo::wallet_has_ops(&mut tx, existing.id.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if has_ops {
        return Err(WalletError::WalletDeleteForbidden.into());
    }

    repo::delete_wallet(&mut tx, existing.id.as_str())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let detail = format!(r#"{{"action":"deleted","wallet_id":"{}"}}"#, existing.id.as_str());
    audit::append(&mut tx, actor, audit::event::WALLET_CHANGED, now, Some(detail))
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(())
}
