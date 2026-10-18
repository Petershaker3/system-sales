//! SQLite persistence for shop wallets (`wallets`) and the wallet/services
//! ledger (`wallet_ops`) — Plan item 1.10 (`ADR-025`).

use sqlx::{Row, SqliteConnection};

use crate::domain::identity::{Timestamp, UserId};
use crate::domain::wallet::{
    ServicesWindowTotals, WalletAlertState, WalletId, WalletName, WalletOpId, WalletOpKind,
    WalletOpRecord, WalletPayMethod, WalletPeriodStats, WalletRecord, WalletSummary, WalletVia,
};

/// List all wallets ordered by `sort ASC, id ASC`.
pub async fn list_wallets(conn: &mut SqliteConnection) -> Result<Vec<WalletRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, name, number, color, opening_balance_minor, min_alert_minor,
                max_limit_minor, daily_limit_minor, pay_method, sort, hidden, is_custom, created_at
         FROM wallets
         ORDER BY sort ASC, id ASC",
    )
    .fetch_all(&mut *conn)
    .await?;

    rows.into_iter().map(row_to_wallet).collect()
}

/// Find a wallet by id.
pub async fn find_wallet_by_id(
    conn: &mut SqliteConnection,
    wallet_id: &str,
) -> Result<Option<WalletRecord>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, name, number, color, opening_balance_minor, min_alert_minor,
                max_limit_minor, daily_limit_minor, pay_method, sort, hidden, is_custom, created_at
         FROM wallets
         WHERE id = ?1",
    )
    .bind(wallet_id)
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(r) => row_to_wallet(r).map(Some),
        None => Ok(None),
    }
}

/// Find a wallet by case-insensitive trimmed name.
pub async fn find_wallet_by_name(
    conn: &mut SqliteConnection,
    name: &str,
) -> Result<Option<WalletRecord>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, name, number, color, opening_balance_minor, min_alert_minor,
                max_limit_minor, daily_limit_minor, pay_method, sort, hidden, is_custom, created_at
         FROM wallets
         WHERE lower(trim(name)) = lower(trim(?1))
         LIMIT 1",
    )
    .bind(name)
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(r) => row_to_wallet(r).map(Some),
        None => Ok(None),
    }
}

/// Return the next `sort` position for a newly created wallet.
pub async fn next_wallet_sort(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    let max_sort: Option<i64> = sqlx::query_scalar("SELECT MAX(sort) FROM wallets")
        .fetch_one(&mut *conn)
        .await?;
    Ok(max_sort.unwrap_or(0).saturating_add(1))
}

/// Insert a new wallet row.
pub async fn insert_wallet(
    conn: &mut SqliteConnection,
    wallet: &WalletRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO wallets (
            id, name, number, color,
            opening_balance_minor, min_alert_minor, max_limit_minor, daily_limit_minor,
            pay_method, sort, hidden, is_custom, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    )
    .bind(wallet.id.as_str())
    .bind(wallet.name.as_str())
    .bind(&wallet.number)
    .bind(&wallet.color)
    .bind(wallet.opening_balance_minor)
    .bind(wallet.min_alert_minor)
    .bind(wallet.max_limit_minor)
    .bind(wallet.daily_limit_minor)
    .bind(wallet.pay_method.map(|m| m.as_str()))
    .bind(wallet.sort)
    .bind(i64::from(wallet.hidden))
    .bind(i64::from(wallet.is_custom))
    .bind(wallet.created_at.as_millis())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Clear `pay_method` on any other wallet so at most one wallet owns that payment method.
pub async fn clear_pay_method_on_other_wallets(
    conn: &mut SqliteConnection,
    pay_method: WalletPayMethod,
    except_wallet_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE wallets SET pay_method = NULL WHERE pay_method = ?1 AND id <> ?2")
        .bind(pay_method.as_str())
        .bind(except_wallet_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Update an existing wallet row.
pub async fn update_wallet(
    conn: &mut SqliteConnection,
    wallet: &WalletRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE wallets
         SET name = ?2,
             number = ?3,
             color = ?4,
             opening_balance_minor = ?5,
             min_alert_minor = ?6,
             max_limit_minor = ?7,
             daily_limit_minor = ?8,
             pay_method = ?9,
             sort = ?10,
             hidden = ?11
         WHERE id = ?1",
    )
    .bind(wallet.id.as_str())
    .bind(wallet.name.as_str())
    .bind(&wallet.number)
    .bind(&wallet.color)
    .bind(wallet.opening_balance_minor)
    .bind(wallet.min_alert_minor)
    .bind(wallet.max_limit_minor)
    .bind(wallet.daily_limit_minor)
    .bind(wallet.pay_method.map(|m| m.as_str()))
    .bind(wallet.sort)
    .bind(i64::from(wallet.hidden))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Whether a wallet is referenced by any row in `wallet_ops`.
pub async fn wallet_has_ops(
    conn: &mut SqliteConnection,
    wallet_id: &str,
) -> Result<bool, sqlx::Error> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM wallet_ops WHERE wallet_id = ?1 OR to_wallet_id = ?1",
    )
    .bind(wallet_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(count > 0)
}

/// Delete a custom wallet that has no operations.
pub async fn delete_wallet(
    conn: &mut SqliteConnection,
    wallet_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM wallets WHERE id = ?1 AND is_custom = 1")
        .bind(wallet_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Compute the live balance in piastres for a wallet (`walletBalance` in `analytics.js`).
pub async fn compute_wallet_balance_minor(
    conn: &mut SqliteConnection,
    wallet: &WalletRecord,
) -> Result<i64, sqlx::Error> {
    let wid = wallet.id.as_str();
    let ops_delta: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(
            CASE
                WHEN kind = 'move' AND wallet_id = ?1 THEN -amount_minor
                WHEN kind = 'move' AND to_wallet_id = ?1 THEN amount_minor
                WHEN wallet_id = ?1 AND kind IN ('deposit', 'unload') THEN -amount_minor
                WHEN wallet_id = ?1 AND kind IN ('withdraw', 'topup', 'adjust') THEN amount_minor
                ELSE 0
            END
        ), 0)
        FROM wallet_ops
        WHERE voided_at IS NULL
          AND (wallet_id = ?1 OR to_wallet_id = ?1)",
    )
    .bind(wid)
    .fetch_one(&mut *conn)
    .await?;

    let sales_in_minor = match wallet.pay_method {
        Some(method) => {
            sqlx::query_scalar(
                "SELECT COALESCE(SUM(
                    CASE WHEN s.kind = 'sale' THEN sp.amount_minor ELSE -sp.amount_minor END
                ), 0)
                FROM sale_payments sp
                INNER JOIN sales s ON s.id = sp.sale_id
                WHERE sp.method = ?1",
            )
            .bind(method.as_str())
            .fetch_one(&mut *conn)
            .await?
        }
        None => 0,
    };

    Ok(wallet.opening_balance_minor + ops_delta + sales_in_minor)
}

/// Compute statistics for one wallet in a `[from_ms, to_ms]` time window (`walletStats` in `analytics.js`).
pub async fn compute_wallet_period_stats(
    conn: &mut SqliteConnection,
    wallet: &WalletRecord,
    from_ms: i64,
    to_ms: i64,
) -> Result<WalletPeriodStats, sqlx::Error> {
    let wid = wallet.id.as_str();
    let row = sqlx::query(
        "SELECT
            COALESCE(SUM(CASE WHEN kind IN ('deposit', 'withdraw') THEN 1 ELSE 0 END), 0) AS ops_count,
            COALESCE(SUM(CASE WHEN kind = 'deposit' THEN 1 ELSE 0 END), 0) AS dep_count,
            COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount_minor ELSE 0 END), 0) AS dep_minor,
            COALESCE(SUM(CASE WHEN kind = 'withdraw' THEN 1 ELSE 0 END), 0) AS wit_count,
            COALESCE(SUM(CASE WHEN kind = 'withdraw' THEN amount_minor ELSE 0 END), 0) AS wit_minor,
            COALESCE(SUM(CASE WHEN kind IN ('deposit', 'withdraw') THEN fee_minor ELSE 0 END), 0) AS fees_minor
         FROM wallet_ops
         WHERE voided_at IS NULL
           AND wallet_id = ?1
           AND created_at >= ?2
           AND created_at <= ?3",
    )
    .bind(wid)
    .bind(from_ms)
    .bind(to_ms)
    .fetch_one(&mut *conn)
    .await?;

    let ops_count_raw: i64 = row.try_get("ops_count")?;
    let dep_count_raw: i64 = row.try_get("dep_count")?;
    let dep_minor: i64 = row.try_get("dep_minor")?;
    let wit_count_raw: i64 = row.try_get("wit_count")?;
    let wit_minor: i64 = row.try_get("wit_minor")?;
    let fees_minor: i64 = row.try_get("fees_minor")?;

    let sales_in_minor = match wallet.pay_method {
        Some(method) => {
            sqlx::query_scalar(
                "SELECT COALESCE(SUM(
                    CASE WHEN s.kind = 'sale' THEN sp.amount_minor ELSE -sp.amount_minor END
                ), 0)
                FROM sale_payments sp
                INNER JOIN sales s ON s.id = sp.sale_id
                WHERE sp.method = ?1
                  AND s.occurred_at >= ?2
                  AND s.occurred_at <= ?3",
            )
            .bind(method.as_str())
            .bind(from_ms)
            .bind(to_ms)
            .fetch_one(&mut *conn)
            .await?
        }
        None => 0,
    };

    Ok(WalletPeriodStats {
        wallet_id: wallet.id.clone(),
        ops_count: ops_count_raw.max(0) as u64,
        dep_count: dep_count_raw.max(0) as u64,
        dep_minor,
        wit_count: wit_count_raw.max(0) as u64,
        wit_minor,
        fees_minor,
        used_minor: dep_minor + wit_minor,
        sales_in_minor,
    })
}

/// Compute `WalletSummary` for each wallet in `wallets`.
pub async fn compute_wallet_summaries(
    conn: &mut SqliteConnection,
    today_from_ms: i64,
    period_from_ms: i64,
    period_to_ms: i64,
) -> Result<Vec<WalletSummary>, sqlx::Error> {
    let wallets = list_wallets(&mut *conn).await?;
    let mut out = Vec::with_capacity(wallets.len());
    for wallet in wallets {
        let balance_minor = compute_wallet_balance_minor(&mut *conn, &wallet).await?;
        let state = WalletAlertState::compute(
            balance_minor,
            wallet.min_alert_minor,
            wallet.max_limit_minor,
        );
        let today =
            compute_wallet_period_stats(&mut *conn, &wallet, today_from_ms, i64::MAX).await?;
        let period =
            compute_wallet_period_stats(&mut *conn, &wallet, period_from_ms, period_to_ms).await?;
        out.push(WalletSummary {
            wallet,
            balance_minor,
            state,
            today,
            period,
        });
    }
    Ok(out)
}

/// Insert a row into `wallet_ops`.
pub async fn insert_wallet_op(
    conn: &mut SqliteConnection,
    op: &WalletOpRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO wallet_ops (
            id, wallet_id, to_wallet_id, kind, via, service_type, reference,
            amount_minor, fee_minor, note, created_by, created_at,
            voided_by, voided_at, void_reason
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, NULL, NULL)",
    )
    .bind(op.id.as_str())
    .bind(op.wallet_id.as_ref().map(|w| w.as_str()))
    .bind(op.to_wallet_id.as_ref().map(|w| w.as_str()))
    .bind(op.kind.as_str())
    .bind(op.via.map(|v| v.as_str()))
    .bind(op.service_type.as_deref())
    .bind(op.reference.as_deref())
    .bind(op.amount_minor)
    .bind(op.fee_minor)
    .bind(op.note.as_deref())
    .bind(op.created_by.as_str())
    .bind(op.created_at.as_millis())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Find a `wallet_ops` row by id.
pub async fn find_wallet_op_by_id(
    conn: &mut SqliteConnection,
    op_id: &str,
) -> Result<Option<WalletOpRecord>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, wallet_id, to_wallet_id, kind, via, service_type, reference,
                amount_minor, fee_minor, note, created_by, created_at,
                voided_by, voided_at, void_reason
         FROM wallet_ops
         WHERE id = ?1",
    )
    .bind(op_id)
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(r) => row_to_wallet_op(r).map(Some),
        None => Ok(None),
    }
}

/// Mark an unvoided `wallet_ops` row as voided with a reason.
pub async fn void_wallet_op(
    conn: &mut SqliteConnection,
    op_id: &str,
    voided_by: &UserId,
    voided_at: Timestamp,
    void_reason: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE wallet_ops
         SET voided_by = ?2,
             voided_at = ?3,
             void_reason = ?4
         WHERE id = ?1 AND voided_at IS NULL",
    )
    .bind(op_id)
    .bind(voided_by.as_str())
    .bind(voided_at.as_millis())
    .bind(void_reason)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// List operations in `wallet_ops` filtered by optional wallet id and time window, newest first.
pub async fn list_wallet_ops(
    conn: &mut SqliteConnection,
    wallet_id: Option<&str>,
    from_ms: i64,
    to_ms: i64,
    limit: u32,
) -> Result<Vec<WalletOpRecord>, sqlx::Error> {
    let rows = match wallet_id {
        Some(wid) => {
            sqlx::query(
                "SELECT id, wallet_id, to_wallet_id, kind, via, service_type, reference,
                        amount_minor, fee_minor, note, created_by, created_at,
                        voided_by, voided_at, void_reason
                 FROM wallet_ops
                 WHERE (wallet_id = ?1 OR to_wallet_id = ?1)
                   AND created_at >= ?2
                   AND created_at <= ?3
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?4",
            )
            .bind(wid)
            .bind(from_ms)
            .bind(to_ms)
            .bind(i64::from(limit))
            .fetch_all(&mut *conn)
            .await?
        }
        None => {
            sqlx::query(
                "SELECT id, wallet_id, to_wallet_id, kind, via, service_type, reference,
                        amount_minor, fee_minor, note, created_by, created_at,
                        voided_by, voided_at, void_reason
                 FROM wallet_ops
                 WHERE created_at >= ?1
                   AND created_at <= ?2
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?3",
            )
            .bind(from_ms)
            .bind(to_ms)
            .bind(i64::from(limit))
            .fetch_all(&mut *conn)
            .await?
        }
    };

    rows.into_iter().map(row_to_wallet_op).collect()
}

/// Compute aggregated service and wallet-drawer numbers for a time range (`servicesOf` in `analytics.js`).
pub async fn compute_services_window_totals(
    conn: &mut SqliteConnection,
    from_ms: i64,
    to_ms: i64,
) -> Result<ServicesWindowTotals, sqlx::Error> {
    let row = sqlx::query(
        "SELECT
            COALESCE(SUM(CASE WHEN kind IN ('deposit', 'withdraw', 'bill', 'card', 'software') THEN 1 ELSE 0 END), 0) AS services_count,
            COALESCE(SUM(CASE WHEN kind IN ('deposit', 'withdraw', 'bill', 'card', 'software') THEN fee_minor ELSE 0 END), 0) AS services_fee_minor,
            COALESCE(SUM(
                CASE
                    WHEN kind IN ('deposit', 'bill', 'card') THEN amount_minor + fee_minor
                    WHEN kind = 'software' THEN fee_minor
                    ELSE 0
                END
            ), 0) AS services_cash_in_minor,
            COALESCE(SUM(
                CASE
                    WHEN kind = 'withdraw' THEN amount_minor - fee_minor
                    ELSE 0
                END
            ), 0) AS services_cash_out_minor,
            COALESCE(SUM(
                CASE
                    WHEN kind = 'topup' AND via = 'drawer' THEN -amount_minor
                    WHEN kind = 'unload' AND via = 'drawer' THEN amount_minor
                    ELSE 0
                END
            ), 0) AS wallet_drawer_net_minor
         FROM wallet_ops
         WHERE voided_at IS NULL
           AND created_at >= ?1
           AND created_at <= ?2",
    )
    .bind(from_ms)
    .bind(to_ms)
    .fetch_one(&mut *conn)
    .await?;

    let services_count_raw: i64 = row.try_get("services_count")?;
    Ok(ServicesWindowTotals {
        services_count: services_count_raw.max(0) as u64,
        services_fee_minor: row.try_get("services_fee_minor")?,
        services_cash_in_minor: row.try_get("services_cash_in_minor")?,
        services_cash_out_minor: row.try_get("services_cash_out_minor")?,
        wallet_drawer_net_minor: row.try_get("wallet_drawer_net_minor")?,
    })
}

fn parse_user_id(raw: &str) -> Result<UserId, sqlx::Error> {
    raw.parse()
        .map(UserId::from_uuid)
        .map_err(|_| sqlx::Error::RowNotFound)
}

fn row_to_wallet(row: sqlx::sqlite::SqliteRow) -> Result<WalletRecord, sqlx::Error> {
    let id_raw: String = row.try_get("id")?;
    let name_raw: String = row.try_get("name")?;
    let number: String = row.try_get("number")?;
    let color: String = row.try_get("color")?;
    let opening_balance_minor: i64 = row.try_get("opening_balance_minor")?;
    let min_alert_minor: i64 = row.try_get("min_alert_minor")?;
    let max_limit_minor: i64 = row.try_get("max_limit_minor")?;
    let daily_limit_minor: i64 = row.try_get("daily_limit_minor")?;
    let pay_method_raw: Option<String> = row.try_get("pay_method")?;
    let sort: i64 = row.try_get("sort")?;
    let hidden_raw: i64 = row.try_get("hidden")?;
    let is_custom_raw: i64 = row.try_get("is_custom")?;
    let created_at_raw: i64 = row.try_get("created_at")?;

    Ok(WalletRecord {
        id: WalletId::new(id_raw).ok_or(sqlx::Error::RowNotFound)?,
        name: WalletName::new(name_raw).map_err(|_| sqlx::Error::RowNotFound)?,
        number,
        color,
        opening_balance_minor,
        min_alert_minor,
        max_limit_minor,
        daily_limit_minor,
        pay_method: WalletPayMethod::parse_optional(pay_method_raw.as_deref())
            .map_err(|_| sqlx::Error::RowNotFound)?,
        sort,
        hidden: hidden_raw != 0,
        is_custom: is_custom_raw != 0,
        created_at: Timestamp::from_millis(created_at_raw),
    })
}

fn row_to_wallet_op(row: sqlx::sqlite::SqliteRow) -> Result<WalletOpRecord, sqlx::Error> {
    let id_raw: String = row.try_get("id")?;
    let wallet_id_raw: Option<String> = row.try_get("wallet_id")?;
    let to_wallet_id_raw: Option<String> = row.try_get("to_wallet_id")?;
    let kind_raw: String = row.try_get("kind")?;
    let via_raw: Option<String> = row.try_get("via")?;
    let service_type: Option<String> = row.try_get("service_type")?;
    let reference: Option<String> = row.try_get("reference")?;
    let amount_minor: i64 = row.try_get("amount_minor")?;
    let fee_minor: i64 = row.try_get("fee_minor")?;
    let note: Option<String> = row.try_get("note")?;
    let created_by_raw: String = row.try_get("created_by")?;
    let created_at_raw: i64 = row.try_get("created_at")?;
    let voided_by_raw: Option<String> = row.try_get("voided_by")?;
    let voided_at_raw: Option<i64> = row.try_get("voided_at")?;
    let void_reason: Option<String> = row.try_get("void_reason")?;

    Ok(WalletOpRecord {
        id: WalletOpId::new(id_raw).ok_or(sqlx::Error::RowNotFound)?,
        wallet_id: match wallet_id_raw {
            Some(w) => Some(WalletId::new(w).ok_or(sqlx::Error::RowNotFound)?),
            None => None,
        },
        to_wallet_id: match to_wallet_id_raw {
            Some(w) => Some(WalletId::new(w).ok_or(sqlx::Error::RowNotFound)?),
            None => None,
        },
        kind: WalletOpKind::parse(&kind_raw).map_err(|_| sqlx::Error::RowNotFound)?,
        via: match via_raw {
            Some(v) => Some(WalletVia::parse(&v).map_err(|_| sqlx::Error::RowNotFound)?),
            None => None,
        },
        service_type,
        reference,
        amount_minor,
        fee_minor,
        note,
        created_by: parse_user_id(&created_by_raw)?,
        created_at: Timestamp::from_millis(created_at_raw),
        voided_by: match voided_by_raw {
            Some(u) => Some(parse_user_id(&u)?),
            None => None,
        },
        voided_at: voided_at_raw.map(Timestamp::from_millis),
        void_reason,
    })
}
