//! Department rows.
//!
//! # Reading is defensive, not repairing
//!
//! SQLite enforces most of what `Department` promises, but a persisted row can
//! still be malformed — a partial restore, a hand edit, a future migration that
//! wrote a value this build does not know. So every read goes through
//! [`Department::rehydrate`] and every failure is reported.
//!
//! Specifically, this file never:
//!
//! - mints an id while reading (`from_uuid`, not `generate`);
//! - trims a stored name, because a stored name is already trimmed and
//!   re-trimming would hide a row that was written without the domain;
//! - repairs a status/`archived_at` disagreement;
//! - defaults an unrecognised `cost_method` to the first variant;
//! - fills in a VAT rate that was never recorded.
//!
//! Each of those would turn a corrupt row into a plausible department, and a
//! plausible wrong department is worse than a failed read.

use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

use crate::domain::identity::UserId;
use crate::domain::organisation::{
    CategoryIcon, CategoryKind, CostMethod, Department, DepartmentError, DepartmentId,
    DepartmentName, DepartmentStatus, DepartmentVat, VatRate,
};

/// The seventeen columns every read selects: the thirteen of `0004` and the
/// four of the category tree (`0016`).
///
/// Written out in each statement as a literal, the way `repositories/catalog`
/// does. SQLx 0.9 requires SQL to be a literal it can audit rather than a
/// formatted string, and repeating the list is the established convention here.
/// `row_to_department` is the only reader, so the two lists cannot drift in
/// practice: a column added to a `SELECT` without being read fails immediately on
/// the missing `row.get`.

/// SQLite has no boolean type. `1` and `0`, matching `departments.vat_enabled`.
fn encode_bool(value: bool) -> i64 {
    i64::from(value)
}

pub async fn insert(
    conn: &mut SqliteConnection,
    department: &Department,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO departments
         (id, name, status, cost_method, vat_enabled, vat_rate_bp, vat_inclusive,
          sort_order, created_by, updated_by, created_at, updated_at, archived_at,
          parent_id, kind, icon, hidden)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
    )
    .bind(department.id.as_str())
    .bind(department.name.as_str())
    .bind(department.status.as_str())
    .bind(department.cost_method.as_str())
    .bind(encode_bool(department.vat.is_enabled()))
    .bind(department.vat.rate().map(|rate| rate.as_basis_points()))
    .bind(encode_bool(department.vat.is_inclusive()))
    .bind(department.sort_order)
    .bind(department.created_by.as_str())
    .bind(department.updated_by.as_str())
    .bind(department.created_at)
    .bind(department.updated_at)
    // A genuine None for a live department. Binding a zero here would invent an
    // archive moment that never happened.
    .bind(department.archived_at)
    .bind(department.parent.map(|id| id.as_str()))
    .bind(department.kind.as_str())
    .bind(department.icon.as_str())
    .bind(encode_bool(department.hidden))
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn find_by_id(
    conn: &mut SqliteConnection,
    id: DepartmentId,
) -> Result<Option<Department>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, name, status, cost_method, vat_enabled, vat_rate_bp,
                vat_inclusive, sort_order, created_by, updated_by,
                created_at, updated_at, archived_at, parent_id, kind, icon, hidden
         FROM departments WHERE id = ?1",
    )
        .bind(id.as_str())
        .fetch_optional(&mut *conn)
        .await?;

    match row {
        Some(row) => row_to_department(row).map(Some),
        None => Ok(None),
    }
}

/// Every department, active and archived, in the approved display order.
///
/// Archived rows are included. A department linked to history is archived, never
/// deleted (`spec:221`), so a listing that quietly dropped them would hide
/// records that still exist and still matter in a report.
pub async fn list_all(conn: &mut SqliteConnection) -> Result<Vec<Department>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, name, status, cost_method, vat_enabled, vat_rate_bp,
                vat_inclusive, sort_order, created_by, updated_by,
                created_at, updated_at, archived_at, parent_id, kind, icon, hidden
         FROM departments
         ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC",
    )
    .fetch_all(&mut *conn)
    .await?;

    let mut departments = Vec::with_capacity(rows.len());
    for row in rows {
        departments.push(row_to_department(row)?);
    }
    Ok(departments)
}

/// Only the live departments, in the same order as `list_all`.
///
/// An explicit second function rather than a parameter on `list_all`: "list the
/// departments" and "list the classifications the shop currently uses" are
/// different questions, and a boolean argument at a call site does not say which
/// one is being asked.
pub async fn list_active(conn: &mut SqliteConnection) -> Result<Vec<Department>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, name, status, cost_method, vat_enabled, vat_rate_bp,
                vat_inclusive, sort_order, created_by, updated_by,
                created_at, updated_at, archived_at, parent_id, kind, icon, hidden
         FROM departments
         WHERE status = 'active'
         ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC",
    )
    .fetch_all(&mut *conn)
    .await?;

    let mut departments = Vec::with_capacity(rows.len());
    for row in rows {
        departments.push(row_to_department(row)?);
    }
    Ok(departments)
}

/// Persist an edit to a department.
///
/// Only the mutable fields are written. `id`, `created_by` and `created_at` are
/// identity and provenance: an ordinary edit does not get to rewrite who created
/// a department or when, and leaving them out of the statement is what guarantees
/// it rather than a convention the caller has to remember.
///
/// The archived-state refusal lives in the domain (`Department::update`), not
/// here: a second copy of the rule in SQL would be a second thing to keep in
/// step, and this repository persists a domain decision rather than making one.
pub async fn update(
    conn: &mut SqliteConnection,
    department: &Department,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE departments
         SET name = ?2, cost_method = ?3, vat_enabled = ?4, vat_rate_bp = ?5,
             vat_inclusive = ?6, sort_order = ?7, updated_by = ?8, updated_at = ?9,
             hidden = ?10
         WHERE id = ?1",
    )
    .bind(department.id.as_str())
    .bind(department.name.as_str())
    .bind(department.cost_method.as_str())
    .bind(encode_bool(department.vat.is_enabled()))
    .bind(department.vat.rate().map(|rate| rate.as_basis_points()))
    .bind(encode_bool(department.vat.is_inclusive()))
    .bind(department.sort_order)
    .bind(department.updated_by.as_str())
    .bind(department.updated_at)
    .bind(encode_bool(department.hidden))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Remove an empty category (ADR-018 §1). Returns how many rows went: `0`
/// means there was no such row.
///
/// Whether it may go is the domain's (`organisation::can_delete`), decided from
/// [`has_subcategories`] and [`count_products`] in the same transaction. The
/// foreign keys refuse as well: a product or a sub-category still naming the
/// row makes this statement fail rather than leave a dangling reference.
pub async fn delete(conn: &mut SqliteConnection, id: DepartmentId) -> Result<u64, sqlx::Error> {
    let done = sqlx::query("DELETE FROM departments WHERE id = ?1")
        .bind(id.as_str())
        .execute(&mut *conn)
        .await?;
    Ok(done.rows_affected())
}

/// Whether any category, live or archived, sits under `id`.
pub async fn has_subcategories(
    conn: &mut SqliteConnection,
    id: DepartmentId,
) -> Result<bool, sqlx::Error> {
    let found: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM departments WHERE parent_id = ?1 LIMIT 1")
            .bind(id.as_str())
            .fetch_optional(&mut *conn)
            .await?;
    Ok(found.is_some())
}

/// How many products name `id` as their category, archived ones included.
pub async fn count_products(
    conn: &mut SqliteConnection,
    id: DepartmentId,
) -> Result<i64, sqlx::Error> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products WHERE department_id = ?1")
        .bind(id.as_str())
        .fetch_one(&mut *conn)
        .await?;
    Ok(count)
}

/// Live products per category, for the settings list: `(category id, count)`.
/// Categories with none are absent.
pub async fn active_product_counts(
    conn: &mut SqliteConnection,
) -> Result<Vec<(String, i64)>, sqlx::Error> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT department_id, COUNT(*) FROM products
          WHERE department_id IS NOT NULL AND status = 'active'
          GROUP BY department_id",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows)
}

/// Whether a live category other than `except` already has `name`, compared
/// the way the unique index compares (`COLLATE NOCASE`).
pub async fn active_name_taken(
    conn: &mut SqliteConnection,
    name: &DepartmentName,
    except: Option<DepartmentId>,
) -> Result<bool, sqlx::Error> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM departments
          WHERE status = 'active' AND name = ?1 COLLATE NOCASE AND id <> COALESCE(?2, '')
          LIMIT 1",
    )
    .bind(name.as_str())
    .bind(except.map(|id| id.as_str()))
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// Persist the one-way archive transition.
///
/// Its own statement rather than a call to `update`, and it writes only the
/// archive fields plus attribution. A generic update here could be pointed at an
/// already-archived department with `status = 'active'` and would reopen it; this
/// statement has no path that writes any status other than `archived`, so it
/// cannot reopen anything even if a caller passes the wrong aggregate.
pub async fn archive(
    conn: &mut SqliteConnection,
    department: &Department,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE departments
         SET status = 'archived', archived_at = ?2, updated_by = ?3, updated_at = ?4
         WHERE id = ?1",
    )
    .bind(department.id.as_str())
    .bind(department.archived_at)
    .bind(department.updated_by.as_str())
    .bind(department.updated_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Persist the restore transition: archived → active.
///
/// Its own statement, mirroring [`archive`] in the opposite direction. It writes
/// only `status = 'active'`, `archived_at = NULL` and attribution, and its
/// `WHERE` clause requires the row to be archived — so it cannot touch an
/// already-active department even if a caller passes the wrong aggregate, the
/// same one-way guarantee `archive` gives in reverse.
pub async fn restore(
    conn: &mut SqliteConnection,
    department: &Department,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE departments
         SET status = 'active', archived_at = NULL, updated_by = ?2, updated_at = ?3
         WHERE id = ?1 AND status = 'archived'",
    )
    .bind(department.id.as_str())
    .bind(department.updated_by.as_str())
    .bind(department.updated_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// A domain rule that rejects a stored row is reported as a protocol failure.
///
/// `sqlx::Error::Protocol` is the convention the catalogue repository already
/// uses for a corrupt row, so this adds no new error type and needs no frontend
/// code: nothing here crosses the command boundary yet. The domain's own stable
/// code is carried in the message so a log names the exact rule that failed.
fn reject(error: DepartmentError, what: &str) -> sqlx::Error {
    sqlx::Error::Protocol(format!("{what}: {}", error.code()))
}

fn row_to_department(row: sqlx::sqlite::SqliteRow) -> Result<Department, sqlx::Error> {
    let raw_id: String = row.get("id");
    let name: String = row.get("name");
    let status_raw: String = row.get("status");
    let cost_method_raw: String = row.get("cost_method");
    let vat_enabled: i64 = row.get("vat_enabled");
    let vat_rate_bp: Option<i64> = row.get("vat_rate_bp");
    let vat_inclusive: i64 = row.get("vat_inclusive");
    let sort_order: i64 = row.get("sort_order");
    let created_by: String = row.get("created_by");
    let updated_by: String = row.get("updated_by");
    let created_at: i64 = row.get("created_at");
    let updated_at: i64 = row.get("updated_at");
    let archived_at: Option<i64> = row.get("archived_at");
    let parent_raw: Option<String> = row.get("parent_id");
    let kind_raw: String = row.get("kind");
    let icon_raw: String = row.get("icon");
    let hidden_raw: i64 = row.get("hidden");

    // A corrupt row is an error, never a default. Defaulting an unknown status to
    // the lesser state, or an unparseable cost method to the first variant, would
    // quietly invent data about a shop's money.
    let status = DepartmentStatus::parse(&status_raw).ok_or_else(|| {
        sqlx::Error::Protocol(format!(
            "unknown status in departments: {status_raw}"
        ))
    })?;
    let cost_method = CostMethod::parse(&cost_method_raw).ok_or_else(|| {
        sqlx::Error::Protocol(format!(
            "unknown cost_method in departments: {cost_method_raw}"
        ))
    })?;

    let decode_bool = |raw: i64, column: &str| -> Result<bool, sqlx::Error> {
        match raw {
            0 => Ok(false),
            1 => Ok(true),
            other => Err(sqlx::Error::Protocol(format!(
                "unexpected {column} in departments: {other}"
            ))),
        }
    };

    let rate = match vat_rate_bp {
        Some(value) => Some(
            VatRate::new(value).map_err(|e| reject(e, "negative vat_rate_bp"))?,
        ),
        None => None,
    };

    // `DepartmentVat::new` refuses "enabled with no rate", so that combination
    // cannot survive a read even if a row somehow contains it.
    let vat = DepartmentVat::new(
        decode_bool(vat_enabled, "vat_enabled")?,
        rate,
        decode_bool(vat_inclusive, "vat_inclusive")?,
    )
    .map_err(|e| reject(e, "invalid vat state"))?;

    let parse_uuid = |raw: String, what: &str| -> Result<Uuid, sqlx::Error> {
        raw.parse()
            .map_err(|_| sqlx::Error::Protocol(format!("malformed {what} in departments")))
    };

    // The tree columns of 0016, read as strictly as the rest: an unknown kind
    // or icon is a row this build does not understand, never a default.
    let kind = CategoryKind::parse(&kind_raw).ok_or_else(|| {
        sqlx::Error::Protocol(format!("unknown kind in departments: {kind_raw}"))
    })?;
    let icon = CategoryIcon::new(&icon_raw).map_err(|e| reject(e, "unknown icon"))?;
    let hidden = decode_bool(hidden_raw, "hidden")?;
    let parent = match parent_raw {
        Some(raw) => Some(DepartmentId::from_uuid(parse_uuid(raw, "parent_id")?)),
        None => None,
    };

    // Rehydration, not a struct literal: it is the domain's own check that
    // `status` and `archived_at` agree, and rehydrating is what keeps that check
    // from being bypassed by a future column being added to the struct. The tree
    // columns go through `with_tree`, which refuses a row that is its own parent.
    Department::rehydrate(
        DepartmentId::from_uuid(parse_uuid(raw_id, "department id")?),
        // Rejects an empty or whitespace-only stored name. Not trimmed first: a
        // stored name is already trimmed, so leading whitespace means the row was
        // written without the domain, and quietly cleaning it would hide that.
        DepartmentName::new(&name).map_err(|e| reject(e, "invalid department name"))?,
        status,
        cost_method,
        vat,
        sort_order,
        UserId::from_uuid(parse_uuid(created_by, "created_by")?),
        UserId::from_uuid(parse_uuid(updated_by, "updated_by")?),
        created_at,
        updated_at,
        archived_at,
    )
    .and_then(|department| department.with_tree(parent, kind, icon, hidden))
    .map_err(|e| reject(e, "inconsistent department state"))
}