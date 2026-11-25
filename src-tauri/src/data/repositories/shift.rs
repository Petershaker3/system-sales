//! SQLite persistence for shifts (`shifts`), drawer expenses (`expenses`),
//! and cash movements (`cash_movements`) — Plan item 1.9 (`ADR-024`).

use sqlx::{Row, SqliteConnection};

use crate::domain::identity::{Timestamp, UserId};
use crate::domain::money::Piastres;
use crate::domain::shift::{
    CashMovementId, CashMovementKind, CashMovementReason, CashMovementRecord, ExpenseCategory,
    ExpenseId, ExpenseNote, ExpenseRecord, PaidFrom, ShiftCloseNote, ShiftId, ShiftRecord,
    ShiftStatus, ShiftTotals,
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
        "INSERT INTO expenses (id, shift_id, paid_from, category, amount_minor, note, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(expense.id.as_str())
    // A genuine NULL for money that never left the drawer (`ADR-043`); the table's
    // CHECK keeps it in step with `paid_from`.
    .bind(expense.shift_id.as_ref().map(|id| id.as_str()))
    .bind(expense.paid_from.as_str())
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
        "SELECT id, shift_id, paid_from, category, amount_minor, note, created_by, created_at
         FROM expenses
         WHERE shift_id = ?1
         ORDER BY created_at DESC, id DESC",
    )
    .bind(shift_id)
    .fetch_all(&mut *conn)
    .await?;

    rows.into_iter().map(row_to_expense).collect()
}

/// Every expense in a window, newest first, with the person who recorded it.
///
/// `from_ms`/`to_ms` are inclusive bounds; `None` means "no bound on this side", which
/// is how the section's «الكل» asks its question. Filtering happens in SQL rather than
/// in the caller so a year of rows does not have to cross the wire to be counted.
pub async fn list_expenses_between(
    conn: &mut SqliteConnection,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
) -> Result<Vec<ExpenseWithName>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT e.id, e.shift_id, e.paid_from, e.category, e.amount_minor, e.note,
                e.created_by, e.created_at, u.display_name AS created_by_name
         FROM expenses e
         JOIN users u ON u.id = e.created_by
         WHERE (?1 IS NULL OR e.created_at >= ?1)
           AND (?2 IS NULL OR e.created_at <= ?2)
         ORDER BY e.created_at DESC, e.id DESC",
    )
    .bind(from_ms)
    .bind(to_ms)
    .fetch_all(&mut *conn)
    .await?;

    rows.into_iter()
        .map(|row| {
            let created_by_name: String = row.try_get("created_by_name")?;
            let record = row_to_expense(row)?;
            Ok(ExpenseWithName {
                record,
                created_by_name,
            })
        })
        .collect()
}

/// One expense beside the display name of whoever recorded it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpenseWithName {
    pub record: ExpenseRecord,
    pub created_by_name: String,
}

/// The categories this shop has actually used, most frequent first.
///
/// Read from the rows rather than from a fixed list: the suggestions a shopkeeper
/// sees should be the words their own shop uses (`ADR-043`).
pub async fn expense_category_counts(
    conn: &mut SqliteConnection,
) -> Result<Vec<(String, i64)>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT category, COUNT(*) AS uses
         FROM expenses
         GROUP BY category
         ORDER BY uses DESC, category ASC
         LIMIT 24",
    )
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter()
        .map(|row| {
            let category: String = row.try_get("category")?;
            let uses: i64 = row.try_get("uses")?;
            Ok((category, uses))
        })
        .collect()
}

/// Whether a shift is open right now, and which one.
pub async fn open_shift_id(conn: &mut SqliteConnection) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT id FROM shifts WHERE status = 'open' LIMIT 1")
        .fetch_optional(&mut *conn)
        .await
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
    let shift_id_raw: Option<String> = row.try_get("shift_id")?;
    let paid_from_raw: String = row.try_get("paid_from")?;
    let category_raw: String = row.try_get("category")?;
    let amount_raw: i64 = row.try_get("amount_minor")?;
    let note_raw: Option<String> = row.try_get("note")?;
    let created_by_raw: String = row.try_get("created_by")?;
    let created_at_raw: i64 = row.try_get("created_at")?;

    Ok(ExpenseRecord {
        id: ExpenseId::new(id_raw).ok_or(sqlx::Error::RowNotFound)?,
        shift_id: shift_id_raw
            .map(|raw| ShiftId::new(raw).ok_or(sqlx::Error::RowNotFound))
            .transpose()?,
        paid_from: PaidFrom::parse(&paid_from_raw).ok_or(sqlx::Error::RowNotFound)?,
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

/// A physical count is an observation, not a reconciled balance.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftCashCount {
    pub id: String,
    pub shift_id: String,
    pub amount_minor: i64,
    pub counted_by: String,
    pub counted_at: i64,
}

pub async fn insert_cash_count(conn: &mut SqliteConnection, count: &ShiftCashCount) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO shift_cash_counts(id,shift_id,amount_minor,counted_by,counted_at) VALUES(?1,?2,?3,?4,?5)")
        .bind(&count.id).bind(&count.shift_id).bind(count.amount_minor).bind(&count.counted_by).bind(count.counted_at)
        .execute(&mut *conn).await?;
    Ok(())
}

pub async fn latest_cash_count(conn: &mut SqliteConnection, shift_id: &str) -> Result<Option<ShiftCashCount>, sqlx::Error> {
    let row = sqlx::query("SELECT id,shift_id,amount_minor,counted_by,counted_at FROM shift_cash_counts WHERE shift_id=?1 ORDER BY counted_at DESC,id DESC LIMIT 1")
        .bind(shift_id).fetch_optional(&mut *conn).await?;
    Ok(row.map(|r| ShiftCashCount { id: r.get("id"), shift_id: r.get("shift_id"), amount_minor: r.get("amount_minor"), counted_by: r.get("counted_by"), counted_at: r.get("counted_at") }))
}

/// Record the observed opening and (when known) the previous physical count.
/// A difference here is an unresolved handover observation, not an adjustment.
pub async fn insert_opening_observation(
    conn: &mut SqliteConnection, shift: &ShiftRecord, previous: Option<&ShiftRecord>,
) -> Result<(), sqlx::Error> {
    // Older closes predate physical-count observations and may have accepted a
    // prefilled estimate. Retain the prior shift link but do not elevate that
    // historical value into a proven physical count.
    let previous_count: Option<i64> = if let Some(prior) = previous {
        sqlx::query_scalar("SELECT c.amount_minor FROM shift_cash_counts c JOIN shifts s ON s.id=c.shift_id WHERE s.id=?1 AND c.counted_at=s.closed_at AND c.counted_by=s.closed_by AND c.amount_minor=s.counted_cash_minor ORDER BY c.id DESC LIMIT 1")
            .bind(prior.id.as_str()).fetch_optional(&mut *conn).await?
    } else { None };
    let difference = previous_count.map(|v| shift.opening_cash.as_minor() - v);
    sqlx::query("INSERT INTO shift_opening_observations(shift_id,previous_shift_id,opening_minor,previous_count_minor,handover_difference_minor,observed_by,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7)")
        .bind(shift.id.as_str()).bind(previous.map(|s| s.id.as_str())).bind(shift.opening_cash.as_minor())
        .bind(previous_count).bind(difference).bind(shift.opened_by.as_str()).bind(shift.opened_at.as_millis())
        .execute(&mut *conn).await?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CashDrawerIdentity {
    pub id: String,
    pub name: String,
    pub created_by: String,
    pub created_at: i64,
    pub is_default: bool,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CashSourcePosting {
    pub source_kind: String,
    pub source_id: String,
    pub shift_id: Option<String>,
    pub drawer_id: Option<String>,
    pub signed_minor: i64,
    pub actor_id: String,
    pub occurred_at: i64,
}

pub async fn list_cash_drawers(conn: &mut SqliteConnection) -> Result<Vec<CashDrawerIdentity>, sqlx::Error> {
    sqlx::query_as("SELECT d.id,d.name,d.created_by,d.created_at,EXISTS(SELECT 1 FROM cash_drawer_default x WHERE x.drawer_id=d.id) is_default FROM cash_drawers d ORDER BY d.created_at,d.id").fetch_all(&mut *conn).await
}

pub async fn recent_cash_source_postings(conn: &mut SqliteConnection) -> Result<Vec<CashSourcePosting>, sqlx::Error> {
    sqlx::query_as("SELECT source_kind,source_id,shift_id,drawer_id,signed_minor,actor_id,occurred_at FROM cash_source_postings ORDER BY occurred_at DESC,source_kind,source_id LIMIT 100").fetch_all(&mut *conn).await
}

pub async fn create_cash_drawer(conn: &mut SqliteConnection, id: &str, name: &str, actor: &str, now: i64) -> Result<bool, sqlx::Error> {
    sqlx::query("INSERT OR IGNORE INTO cash_drawers(id,name,created_by,created_at) VALUES(?1,?2,?3,?4)").bind(id).bind(name).bind(actor).bind(now).execute(&mut *conn).await?;
    let result: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cash_drawers WHERE id=?1 AND name=?2 AND created_by=?3)").bind(id).bind(name).bind(actor).fetch_one(&mut *conn).await?;
    Ok(result)
}

pub async fn drawer_config_request_matches(conn: &mut SqliteConnection, request_id: &str, id: &str, name: &str, actor: &str) -> Result<Option<bool>, sqlx::Error> {
    let row = sqlx::query("SELECT e.drawer_id,e.actor_id,d.name FROM cash_drawer_configuration_events e JOIN cash_drawers d ON d.id=e.drawer_id WHERE e.request_id=?1").bind(request_id).fetch_optional(&mut *conn).await?;
    Ok(row.map(|r| r.get::<String,_>("drawer_id")==id && r.get::<String,_>("name")==name && r.get::<String,_>("actor_id")==actor))
}

pub async fn configure_cash_drawer(conn: &mut SqliteConnection, id: &str, actor: &str, now: i64, request_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO cash_drawer_configuration_events(request_id,drawer_id,actor_id,occurred_at) VALUES(?1,?2,?3,?4)").bind(request_id).bind(id).bind(actor).bind(now).execute(&mut *conn).await?;
    sqlx::query("INSERT INTO cash_drawer_default(singleton,drawer_id,configured_by,configured_at) VALUES(1,?1,?2,?3) ON CONFLICT(singleton) DO UPDATE SET drawer_id=excluded.drawer_id,configured_by=excluded.configured_by,configured_at=excluded.configured_at").bind(id).bind(actor).bind(now).execute(&mut *conn).await?;
    Ok(())
}

pub async fn shift_drawer_id(conn: &mut SqliteConnection, shift_id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT drawer_id FROM shift_drawers WHERE shift_id=?1").bind(shift_id).fetch_optional(&mut *conn).await
}

pub async fn transfer_request_matches(conn: &mut SqliteConnection, request: &str, shift: &str, to: &str, amount: i64, reason: &str, actor: &str) -> Result<Option<bool>, sqlx::Error> {
    let row = sqlx::query("SELECT shift_id,to_drawer_id,amount_minor,reason,actor_id FROM cash_drawer_transfers WHERE request_id=?1").bind(request).fetch_optional(&mut *conn).await?;
    Ok(row.map(|r| r.get::<String,_>("shift_id")==shift && r.get::<String,_>("to_drawer_id")==to && r.get::<i64,_>("amount_minor")==amount && r.get::<String,_>("reason")==reason && r.get::<String,_>("actor_id")==actor))
}

pub async fn insert_drawer_transfer(conn: &mut SqliteConnection, request: &str, shift: &str, from: &str, to: &str, amount: i64, reason: &str, actor: &str, now: i64) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO cash_drawer_transfers(request_id,shift_id,from_drawer_id,to_drawer_id,amount_minor,reason,actor_id,occurred_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)")
        .bind(request).bind(shift).bind(from).bind(to).bind(amount).bind(reason).bind(actor).bind(now).execute(&mut *conn).await?;
    Ok(())
}
