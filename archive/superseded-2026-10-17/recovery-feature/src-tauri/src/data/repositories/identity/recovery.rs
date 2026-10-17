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

// ---------------------------------------------------------------------------
// Attempt throttling
// ---------------------------------------------------------------------------

/// A device's throttle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttemptState {
    pub failed_attempts: i32,
    /// When the previous attempt was reserved, if there was one.
    pub last_attempt_at: Option<i64>,
}

/// Current throttle state for a device, or `None` when it has never attempted.
pub async fn find_attempt(
    conn: &mut SqliteConnection,
    device_id: &str,
) -> Result<Option<AttemptState>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT failed_attempts, last_attempt_at FROM recovery_attempt WHERE device_id = ?1",
    )
    .bind(device_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|row| AttemptState {
        failed_attempts: row.get("failed_attempts"),
        last_attempt_at: row.get("last_attempt_at"),
    }))
}

/// Create the row for a device if it does not exist.
///
/// Idempotent so concurrent callers may both run it: only one insert lands and
/// the other is a no-op. Existence alone grants nothing — the reservation
/// below is what admits an attempt.
pub async fn ensure_attempt(
    conn: &mut SqliteConnection,
    device_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT OR IGNORE INTO recovery_attempt (device_id, failed_attempts)
         VALUES (?1, 0)",
    )
    .bind(device_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Claim the right to make one attempt now. `true` means the caller holds the
/// reservation; `false` means someone else holds it, or the cooldown has not
/// elapsed, and the caller must not hash anything.
///
/// A single statement on purpose: the `failed_attempts = ?2` guard asserts the
/// state the caller computed its delay from, and `reservation IS NULL` (or an
/// expired reservation) asserts nobody is in flight. Two simultaneous callers
/// therefore cannot both succeed, and cannot both read one counter and write
/// one increment — the loser updates zero rows and is throttled.
///
/// A reservation older than `takeover_before` is treated as abandoned, so a
/// process that died between reserving and finalising does not wedge the path.
pub async fn reserve_attempt(
    conn: &mut SqliteConnection,
    device_id: &str,
    expected_failed: i32,
    cooldown_deadline: i64,
    takeover_before: i64,
    reservation: &str,
    now: i64,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE recovery_attempt
         SET reservation = ?4, last_attempt_at = ?5
         WHERE device_id = ?1
           AND failed_attempts = ?2
           AND (last_attempt_at IS NULL OR last_attempt_at <= ?3)
           AND (reservation IS NULL OR last_attempt_at <= ?6)",
    )
    .bind(device_id)
    .bind(expected_failed)
    .bind(cooldown_deadline)
    .bind(reservation)
    .bind(now)
    .bind(takeover_before)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Record a failed attempt. Scoped to the reservation token, so only the
/// attempt that was admitted may count, and a taken-over reservation cannot be
/// written by the attempt it replaced.
pub async fn record_attempt_failure(
    conn: &mut SqliteConnection,
    device_id: &str,
    reservation: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE recovery_attempt
         SET failed_attempts = failed_attempts + 1, reservation = NULL
         WHERE device_id = ?1 AND reservation = ?2",
    )
    .bind(device_id)
    .bind(reservation)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Clear the throttle after a successful attempt.
///
/// Deletes rather than resetting: a device that has never failed has no row,
/// which is the same state, and it keeps "no row" meaning exactly one thing.
pub async fn clear_attempt(
    conn: &mut SqliteConnection,
    device_id: &str,
    reservation: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM recovery_attempt WHERE device_id = ?1 AND reservation = ?2")
        .bind(device_id)
        .bind(reservation)
        .execute(&mut *conn)
        .await?;
    Ok(result.rows_affected() == 1)
}
