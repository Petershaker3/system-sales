//! SQLite persistence for shifts (`shifts`), drawer expenses (`expenses`),
//! and cash movements (`cash_movements`) — Plan item 1.9 (`ADR-024`).

use sqlx::{Row, SqliteConnection};

use crate::domain::identity::{Timestamp, UserId};
use crate::domain::money::Piastres;
use crate::domain::shift::{
    CashMovementId, CashMovementKind, CashMovementReason, CashMovementRecord, ExpenseCategory,
    ExpenseId, ExpenseNote, ExpenseRecord, ShiftCloseNote, ShiftId, ShiftRecord, ShiftStatus,
    ShiftTotals,
};

/// Return the next sequential `shift_number` (`1` for the first shift).
pub async fn next_shift_number(conn: &mut SqliteConnection) -> Result<u64, sqlx::Error> {
    let max_no: Option<i64> = sqlx::query_scalar("SELECT MAX(shift_number) FROM shifts")
        .fetch_one(&mut *conn)
        .await?;
    let next = max_no.unwrap_or(0).saturating_add(1).max(1) as u64;
    Ok(next)
}

/// Find the currently open shift, if any.
pub async fn find_open_shift(
    conn: &mut SqliteConnection,
) -> Result<Option<ShiftRecord>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, shift_number, status, opening_cash_minor, expected_cash_minor,
                counted_cash_minor, difference_minor, close_note,
                opened_by, opened_at, closed_by, closed_at
         FROM shifts
         WHERE status = 'open'
         LIMIT 1",
    )
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(r) => row_to_shift(r).map(Some),
        None => Ok(None),
    }
}

/// Find the most recently closed shift, if any (used to pre-fill next opening drawer cash).
pub async fn find_last_closed_shift(
    conn: &mut SqliteConnection,
) -> Result<Option<ShiftRecord>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, shift_number, status, opening_cash_minor, expected_cash_minor,
                counted_cash_minor, difference_minor, close_note,
                opened_by, opened_at, closed_by, closed_at
         FROM shifts
         WHERE status = 'closed'
         ORDER BY shift_number DESC
         LIMIT 1",
    )
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(r) => row_to_shift(r).map(Some),
        None => Ok(None),
    }
}

/// Find a shift by id.
pub async fn find_by_id(
    conn: &mut SqliteConnection,
    shift_id: &str,
) -> Result<Option<ShiftRecord>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, shift_number, status, opening_cash_minor, expected_cash_minor,
                counted_cash_minor, difference_minor, close_note,
                opened_by, opened_at, closed_by, closed_at
         FROM shifts
         WHERE id = ?1",
    )
    .bind(shift_id)
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(r) => row_to_shift(r).map(Some),
        None => Ok(None),
    }
}

/// Insert a newly opened shift row.
pub async fn insert_open_shift(
    conn: &mut SqliteConnection,
    shift: &ShiftRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO shifts (
            id, shift_number, status, opening_cash_minor,
            expected_cash_minor, counted_cash_minor, difference_minor, close_note,
            opened_by, opened_at, closed_by, closed_at
         ) VALUES (?1, ?2, 'open', ?3, NULL, NULL, NULL, NULL, ?4, ?5, NULL, NULL)",
    )
    .bind(shift.id.as_str())
    .bind(shift.shift_number as i64)
    .bind(shift.opening_cash.as_minor())
    .bind(shift.opened_by.as_str())
    .bind(shift.opened_at.as_millis())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Transition an open shift to `closed`.
pub async fn close_shift_row(
    conn: &mut SqliteConnection,
    shift_id: &str,
    expected_cash_minor: i64,
    counted_cash_minor: i64,
    difference_minor: i64,
    close_note: Option<&str>,
    closed_by: &UserId,
    closed_at: Timestamp,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE shifts
         SET status = 'closed',
             expected_cash_minor = ?2,
             counted_cash_minor = ?3,
             difference_minor = ?4,
             close_note = ?5,
             closed_by = ?6,
             closed_at = ?7
         WHERE id = ?1 AND status = 'open'",
    )
    .bind(shift_id)
    .bind(expected_cash_minor)
    .bind(counted_cash_minor)
    .bind(difference_minor)
    .bind(close_note)
    .bind(closed_by.as_str())
    .bind(closed_at.as_millis())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Insert an expense row for an open shift.
pub async fn insert_expense(
    conn: &mut SqliteConnection,
    expense: &ExpenseRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO expenses (id, shift_id, category, amount_minor, note, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(expense.id.as_str())
    .bind(expense.shift_id.as_str())
    .bind(expense.category.as_str())
    .bind(expense.amount.as_minor())
    .bind(expense.note.as_ref().map(|n| n.as_str()))
    .bind(expense.created_by.as_str())
    .bind(expense.created_at.as_millis())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// List expenses for a shift, newest first.
pub async fn list_expenses_for_shift(
    conn: &mut SqliteConnection,
    shift_id: &str,
) -> Result<Vec<ExpenseRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, shift_id, category, amount_minor, note, created_by, created_at
         FROM expenses
         WHERE shift_id = ?1
         ORDER BY created_at DESC, id DESC",
    )
    .bind(shift_id)
    .fetch_all(&mut *conn)
    .await?;

    rows.into_iter().map(row_to_expense).collect()
}

/// Insert a cash drawer movement row for an open shift.
pub async fn insert_cash_movement(
    conn: &mut SqliteConnection,
    movement: &CashMovementRecord,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO cash_movements (id, shift_id, kind, amount_minor, reason, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(movement.id.as_str())
    .bind(movement.shift_id.as_str())
    .bind(movement.kind.as_str())
    .bind(movement.amount.as_minor())
    .bind(movement.reason.as_str())
    .bind(movement.created_by.as_str())
    .bind(movement.created_at.as_millis())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// List cash drawer movements for a shift, newest first.
pub async fn list_cash_movements_for_shift(
    conn: &mut SqliteConnection,
    shift_id: &str,
) -> Result<Vec<CashMovementRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, shift_id, kind, amount_minor, reason, created_by, created_at
         FROM cash_movements
         WHERE shift_id = ?1
         ORDER BY created_at DESC, id DESC",
    )
    .bind(shift_id)
    .fetch_all(&mut *conn)
    .await?;

    rows.into_iter().map(row_to_cash_movement).collect()
}

/// Compute all financial totals for a shift from `sales`, `sale_payments`,
/// `customer_ledger`, `expenses`, and `cash_movements`.
pub async fn compute_shift_totals(
    conn: &mut SqliteConnection,
    shift: &ShiftRecord,
) -> Result<ShiftTotals, sqlx::Error> {
    let from_ms = shift.opened_at.as_millis();
    let to_ms = shift
        .closed_at
        .map(|ts| ts.as_millis())
        .unwrap_or(i64::MAX);

    let pay_row = sqlx::query(
        "SELECT
            COALESCE(SUM(CASE WHEN sp.method = 'cash' THEN (CASE WHEN s.kind = 'sale' THEN sp.amount_minor ELSE -sp.amount_minor END) ELSE 0 END), 0) AS cash_minor,
            COALESCE(SUM(CASE WHEN sp.method = 'vf' THEN (CASE WHEN s.kind = 'sale' THEN sp.amount_minor ELSE -sp.amount_minor END) ELSE 0 END), 0) AS vf_minor,
            COALESCE(SUM(CASE WHEN sp.method = 'instapay' THEN (CASE WHEN s.kind = 'sale' THEN sp.amount_minor ELSE -sp.amount_minor END) ELSE 0 END), 0) AS instapay_minor,
            COALESCE(SUM(CASE WHEN sp.method = 'card' THEN (CASE WHEN s.kind = 'sale' THEN sp.amount_minor ELSE -sp.amount_minor END) ELSE 0 END), 0) AS card_minor,
            COALESCE(SUM(CASE WHEN sp.method = 'install' THEN (CASE WHEN s.kind = 'sale' THEN sp.amount_minor ELSE -sp.amount_minor END) ELSE 0 END), 0) AS install_minor,
            COALESCE(SUM(CASE WHEN sp.method = 'credit' THEN (CASE WHEN s.kind = 'sale' THEN sp.amount_minor ELSE -sp.amount_minor END) ELSE 0 END), 0) AS credit_minor
         FROM sale_payments sp
         INNER JOIN sales s ON s.id = sp.sale_id
         WHERE s.occurred_at >= ?1 AND s.occurred_at <= ?2",
    )
    .bind(from_ms)
    .bind(to_ms)
    .fetch_one(&mut *conn)
    .await?;

    let cash_sales_minor: i64 = pay_row.try_get("cash_minor")?;
    let vf_sales_minor: i64 = pay_row.try_get("vf_minor")?;
    let instapay_sales_minor: i64 = pay_row.try_get("instapay_minor")?;
    let card_sales_minor: i64 = pay_row.try_get("card_minor")?;
    let install_sales_minor: i64 = pay_row.try_get("install_minor")?;
    let credit_sales_minor: i64 = pay_row.try_get("credit_minor")?;

    let sales_row = sqlx::query(
        "SELECT
            COALESCE(SUM(CASE WHEN kind = 'sale' THEN total_minor ELSE -total_minor END), 0) AS total_minor,
            COALESCE(SUM(CASE WHEN kind = 'sale' THEN cost_total_minor ELSE -cost_total_minor END), 0) AS cost_minor,
            COALESCE(SUM(CASE WHEN kind = 'sale' THEN 1 ELSE -1 END), 0) AS net_count
         FROM sales
         WHERE occurred_at >= ?1 AND occurred_at <= ?2",
    )
    .bind(from_ms)
    .bind(to_ms)
    .fetch_one(&mut *conn)
    .await?;

    let sales_total_minor: i64 = sales_row.try_get("total_minor")?;
    let sales_cost_minor: i64 = sales_row.try_get("cost_minor")?;
    let net_count: i64 = sales_row.try_get("net_count")?;
    let sales_count = net_count.max(0) as u64;

    let customer_cash_in_minor: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(-amount_minor), 0)
         FROM customer_ledger
         WHERE kind = 'payment'
           AND method = 'cash'
           AND occurred_at >= ?1
           AND occurred_at <= ?2",
    )
    .bind(from_ms)
    .bind(to_ms)
    .fetch_one(&mut *conn)
    .await?;

    let expenses_minor: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount_minor), 0)
         FROM expenses
         WHERE shift_id = ?1",
    )
    .bind(shift.id.as_str())
    .fetch_one(&mut *conn)
    .await?;

    let mov_row = sqlx::query(
        "SELECT
            COALESCE(SUM(CASE WHEN kind = 'cash_in' THEN amount_minor ELSE 0 END), 0) AS cash_in_minor,
            COALESCE(SUM(CASE WHEN kind = 'owner_draw' THEN amount_minor ELSE 0 END), 0) AS owner_draw_minor
         FROM cash_movements
         WHERE shift_id = ?1",
    )
    .bind(shift.id.as_str())
    .fetch_one(&mut *conn)
    .await?;

    let cash_in_minor: i64 = mov_row.try_get("cash_in_minor")?;
    let owner_draw_minor: i64 = mov_row.try_get("owner_draw_minor")?;

    let svc_row = sqlx::query(
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

    let services_count_raw: i64 = svc_row.try_get("services_count")?;
    let services_fee_minor: i64 = svc_row.try_get("services_fee_minor")?;
    let services_cash_in_minor: i64 = svc_row.try_get("services_cash_in_minor")?;
    let services_cash_out_minor: i64 = svc_row.try_get("services_cash_out_minor")?;
    let wallet_drawer_net_minor: i64 = svc_row.try_get("wallet_drawer_net_minor")?;

    let rep_row = sqlx::query(
        "SELECT
            COALESCE(SUM(CASE WHEN status != 'cancelled' AND created_at >= ?1 AND created_at <= ?2 AND deposit_minor > 0 THEN deposit_minor ELSE 0 END), 0) AS deposit_cash_minor,
            COALESCE(SUM(CASE WHEN status = 'delivered' AND delivered_at >= ?1 AND delivered_at <= ?2 AND pay_method = 'cash' THEN MAX(0, final_price_minor - deposit_minor) ELSE 0 END), 0) AS deliv_cash_minor,
            COALESCE(SUM(CASE WHEN status = 'delivered' AND delivered_at >= ?1 AND delivered_at <= ?2 AND pay_method = 'vf' THEN MAX(0, final_price_minor - deposit_minor) ELSE 0 END), 0) AS deliv_vf_minor,
            COALESCE(SUM(CASE WHEN status = 'delivered' AND delivered_at >= ?1 AND delivered_at <= ?2 AND pay_method = 'instapay' THEN MAX(0, final_price_minor - deposit_minor) ELSE 0 END), 0) AS deliv_instapay_minor,
            COALESCE(SUM(CASE WHEN status = 'delivered' AND delivered_at >= ?1 AND delivered_at <= ?2 AND pay_method = 'card' THEN MAX(0, final_price_minor - deposit_minor) ELSE 0 END), 0) AS deliv_card_minor,
            COALESCE(SUM(CASE WHEN status = 'delivered' AND delivered_at >= ?1 AND delivered_at <= ?2 THEN 1 ELSE 0 END), 0) AS deliv_count,
            COALESCE(SUM(CASE WHEN status = 'delivered' AND delivered_at >= ?1 AND delivered_at <= ?2 THEN (final_price_minor - parts_cost_minor) ELSE 0 END), 0) AS deliv_profit_minor
         FROM repairs",
    )
    .bind(from_ms)
    .bind(to_ms)
    .fetch_one(&mut *conn)
    .await?;

    let rep_deposit_cash: i64 = rep_row.try_get("deposit_cash_minor")?;
    let rep_deliv_cash: i64 = rep_row.try_get("deliv_cash_minor")?;
    let rep_deliv_vf: i64 = rep_row.try_get("deliv_vf_minor")?;
    let rep_deliv_instapay: i64 = rep_row.try_get("deliv_instapay_minor")?;
    let rep_deliv_card: i64 = rep_row.try_get("deliv_card_minor")?;
    let rep_deliv_count: i64 = rep_row.try_get("deliv_count")?;
    let rep_deliv_profit: i64 = rep_row.try_get("deliv_profit_minor")?;

    Ok(ShiftTotals::compute_with_services(
        shift.opening_cash.as_minor(),
        cash_sales_minor,
        vf_sales_minor + rep_deliv_vf,
        instapay_sales_minor + rep_deliv_instapay,
        card_sales_minor + rep_deliv_card,
        install_sales_minor,
        credit_sales_minor,
        sales_total_minor,
        sales_cost_minor,
        sales_count,
        customer_cash_in_minor,
        (services_count_raw + rep_deliv_count).max(0) as u64,
        services_fee_minor + rep_deliv_profit,
        services_cash_in_minor + rep_deposit_cash + rep_deliv_cash,
        services_cash_out_minor,
        wallet_drawer_net_minor,
        cash_in_minor,
        owner_draw_minor,
        expenses_minor,
    ))
}

/// List recent closed shifts (most recent first, up to `limit`).
pub async fn list_recent_closed_shifts(
    conn: &mut SqliteConnection,
    limit: u32,
) -> Result<Vec<ShiftRecord>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, shift_number, status, opening_cash_minor, expected_cash_minor,
                counted_cash_minor, difference_minor, close_note,
                opened_by, opened_at, closed_by, closed_at
         FROM shifts
         WHERE status = 'closed'
         ORDER BY shift_number DESC
         LIMIT ?1",
    )
    .bind(i64::from(limit))
    .fetch_all(&mut *conn)
    .await?;

    rows.into_iter().map(row_to_shift).collect()
}

fn row_to_shift(row: sqlx::sqlite::SqliteRow) -> Result<ShiftRecord, sqlx::Error> {
    let id_raw: String = row.try_get("id")?;
    let shift_number_raw: i64 = row.try_get("shift_number")?;
    let status_raw: String = row.try_get("status")?;
    let opening_raw: i64 = row.try_get("opening_cash_minor")?;
    let expected_raw: Option<i64> = row.try_get("expected_cash_minor")?;
    let counted_raw: Option<i64> = row.try_get("counted_cash_minor")?;
    let difference_raw: Option<i64> = row.try_get("difference_minor")?;
    let close_note_raw: Option<String> = row.try_get("close_note")?;
    let opened_by_raw: String = row.try_get("opened_by")?;
    let opened_at_raw: i64 = row.try_get("opened_at")?;
    let closed_by_raw: Option<String> = row.try_get("closed_by")?;
    let closed_at_raw: Option<i64> = row.try_get("closed_at")?;

    let id = ShiftId::new(id_raw).ok_or(sqlx::Error::RowNotFound)?;
    let status = ShiftStatus::parse(&status_raw).ok_or(sqlx::Error::RowNotFound)?;
    let opening_cash = Piastres::new_minor(opening_raw).map_err(|_| sqlx::Error::RowNotFound)?;
    let counted_cash = match counted_raw {
        Some(v) => Some(Piastres::new_minor(v).map_err(|_| sqlx::Error::RowNotFound)?),
        None => None,
    };
    let close_note =
        ShiftCloseNote::parse_optional(close_note_raw.as_deref()).map_err(|_| sqlx::Error::RowNotFound)?;
    let opened_by = parse_user_id(&opened_by_raw)?;
    let opened_at = Timestamp::from_millis(opened_at_raw);
    let closed_by = match closed_by_raw {
        Some(raw) => Some(parse_user_id(&raw)?),
        None => None,
    };
    let closed_at = closed_at_raw.map(Timestamp::from_millis);

    Ok(ShiftRecord {
        id,
        shift_number: shift_number_raw.max(1) as u64,
        status,
        opening_cash,
        expected_cash_minor: expected_raw,
        counted_cash,
        difference_minor: difference_raw,
        close_note,
        opened_by,
        opened_at,
        closed_by,
        closed_at,
    })
}

fn parse_user_id(raw: &str) -> Result<UserId, sqlx::Error> {
    raw.parse()
        .map(UserId::from_uuid)
        .map_err(|_| sqlx::Error::RowNotFound)
}

fn row_to_expense(row: sqlx::sqlite::SqliteRow) -> Result<ExpenseRecord, sqlx::Error> {
    let id_raw: String = row.try_get("id")?;
    let shift_id_raw: String = row.try_get("shift_id")?;
    let category_raw: String = row.try_get("category")?;
    let amount_raw: i64 = row.try_get("amount_minor")?;
    let note_raw: Option<String> = row.try_get("note")?;
    let created_by_raw: String = row.try_get("created_by")?;
    let created_at_raw: i64 = row.try_get("created_at")?;

    Ok(ExpenseRecord {
        id: ExpenseId::new(id_raw).ok_or(sqlx::Error::RowNotFound)?,
        shift_id: ShiftId::new(shift_id_raw).ok_or(sqlx::Error::RowNotFound)?,
        category: ExpenseCategory::new(category_raw).map_err(|_| sqlx::Error::RowNotFound)?,
        amount: Piastres::new_minor(amount_raw).map_err(|_| sqlx::Error::RowNotFound)?,
        note: ExpenseNote::parse_optional(note_raw.as_deref())
            .map_err(|_| sqlx::Error::RowNotFound)?,
        created_by: parse_user_id(&created_by_raw)?,
        created_at: Timestamp::from_millis(created_at_raw),
    })
}

fn row_to_cash_movement(row: sqlx::sqlite::SqliteRow) -> Result<CashMovementRecord, sqlx::Error> {
    let id_raw: String = row.try_get("id")?;
    let shift_id_raw: String = row.try_get("shift_id")?;
    let kind_raw: String = row.try_get("kind")?;
    let amount_raw: i64 = row.try_get("amount_minor")?;
    let reason_raw: String = row.try_get("reason")?;
    let created_by_raw: String = row.try_get("created_by")?;
    let created_at_raw: i64 = row.try_get("created_at")?;

    Ok(CashMovementRecord {
        id: CashMovementId::new(id_raw).ok_or(sqlx::Error::RowNotFound)?,
        shift_id: ShiftId::new(shift_id_raw).ok_or(sqlx::Error::RowNotFound)?,
        kind: CashMovementKind::parse(&kind_raw).map_err(|_| sqlx::Error::RowNotFound)?,
        amount: Piastres::new_minor(amount_raw).map_err(|_| sqlx::Error::RowNotFound)?,
        reason: CashMovementReason::new(reason_raw).map_err(|_| sqlx::Error::RowNotFound)?,
        created_by: parse_user_id(&created_by_raw)?,
        created_at: Timestamp::from_millis(created_at_raw),
    })
}
