//! SQLite repository for Repairs & Software (`الصيانة والسوفت وير`, Plan item 2.1, `ADR-031`).

use std::collections::BTreeMap;

use sqlx::{Row, SqliteConnection};

use crate::domain::repair::{
    RepairError, RepairId, RepairKindFinancialBucket, RepairPayMethod, RepairServiceKind,
    RepairStatus, RepairTechnicianSummary, RepairTicket, RepairsOverview,
};

pub struct NewRepairRow<'a> {
    pub id: &'a RepairId,
    pub ticket_no: &'a str,
    pub service_kind: RepairServiceKind,
    pub customer_name: &'a str,
    pub customer_phone: &'a str,
    pub device_name: &'a str,
    pub imei: Option<&'a str>,
    pub device_lock: &'a str,
    pub issue: &'a str,
    pub accessories: &'a str,
    pub due_label: &'a str,
    pub status: RepairStatus,
    pub estimated_price_minor: i64,
    pub final_price_minor: i64,
    pub parts_cost_minor: i64,
    pub deposit_minor: i64,
    pub pay_method: RepairPayMethod,
    pub technician_name: Option<&'a str>,
    pub warranty_days: i64,
    pub note: &'a str,
    pub created_by: &'a str,
    pub created_at: i64,
    pub delivered_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct RawRepairRow {
    pub id: String,
    pub ticket_no: String,
    pub service_kind: String,
    pub customer_name: String,
    pub customer_phone: String,
    pub device_name: String,
    pub imei: Option<String>,
    pub device_lock: String,
    pub issue: String,
    pub accessories: String,
    pub due_label: String,
    pub status: String,
    pub estimated_price_minor: i64,
    pub final_price_minor: i64,
    pub parts_cost_minor: i64,
    pub deposit_minor: i64,
    pub pay_method: String,
    pub technician_name: Option<String>,
    pub warranty_days: i64,
    pub note: String,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: i64,
    pub delivered_at: Option<i64>,
}

impl RawRepairRow {
    pub fn into_ticket(self, include_cost: bool) -> RepairTicket {
        let collected_minor = match self.status.as_str() {
            "cancelled" => 0,
            "delivered" => self.final_price_minor.max(self.deposit_minor),
            _ => self.deposit_minor,
        };
        let target_price = if self.status == "delivered" || self.final_price_minor > 0 {
            self.final_price_minor
        } else {
            self.estimated_price_minor
        };
        let remaining_minor = if self.status == "delivered" || self.status == "cancelled" {
            0
        } else {
            (target_price - self.deposit_minor).max(0)
        };
        let net_profit = collected_minor - self.parts_cost_minor;
        RepairTicket {
            id: self.id,
            ticket_no: self.ticket_no,
            service_kind: self.service_kind,
            customer_name: self.customer_name,
            customer_phone: self.customer_phone,
            device_name: self.device_name,
            imei: self.imei,
            device_lock: self.device_lock,
            issue: self.issue,
            accessories: self.accessories,
            due_label: self.due_label,
            status: self.status,
            estimated_price_minor: self.estimated_price_minor,
            final_price_minor: self.final_price_minor,
            parts_cost_minor: include_cost.then_some(self.parts_cost_minor),
            net_profit_minor: include_cost.then_some(net_profit),
            deposit_minor: self.deposit_minor,
            collected_minor,
            remaining_minor,
            pay_method: self.pay_method,
            technician_name: self.technician_name,
            warranty_days: self.warranty_days,
            note: self.note,
            created_by: self.created_by,
            created_by_name: self.created_by_name,
            created_at: self.created_at,
            delivered_at: self.delivered_at,
        }
    }
}

fn map_raw_row(r: sqlx::sqlite::SqliteRow) -> RawRepairRow {
    RawRepairRow {
        id: r.get("id"),
        ticket_no: r.get("ticket_no"),
        service_kind: r.get("service_kind"),
        customer_name: r.get("customer_name"),
        customer_phone: r.get("customer_phone"),
        device_name: r.get("device_name"),
        imei: r.get("imei"),
        device_lock: r.get("device_lock"),
        issue: r.get("issue"),
        accessories: r.get("accessories"),
        due_label: r.get("due_label"),
        status: r.get("status"),
        estimated_price_minor: r.get("estimated_price_minor"),
        final_price_minor: r.get("final_price_minor"),
        parts_cost_minor: r.get("parts_cost_minor"),
        deposit_minor: r.get("deposit_minor"),
        pay_method: r.get("pay_method"),
        technician_name: r.get("technician_name"),
        warranty_days: r.get("warranty_days"),
        note: r.get("note"),
        created_by: r.get("created_by"),
        created_by_name: r.get("created_by_name"),
        created_at: r.get("created_at"),
        delivered_at: r.get("delivered_at"),
    }
}

/// Generate the next sequential ticket number (`R-1001`, `R-1002`, ...).
pub async fn next_ticket_no(conn: &mut SqliteConnection) -> Result<String, sqlx::Error> {
    let max_seq: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(CAST(SUBSTR(ticket_no, 3) AS INTEGER)) FROM repairs WHERE ticket_no LIKE 'R-%'",
    )
    .fetch_one(&mut *conn)
    .await?;
    let next_num = max_seq.unwrap_or(1000).max(1000) + 1;
    Ok(format!("R-{next_num}"))
}

pub async fn find_raw_by_id(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<RawRepairRow>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT r.id, r.ticket_no, r.service_kind, r.customer_name, r.customer_phone,
                r.device_name, r.imei, r.device_lock, r.issue, r.accessories,
                r.due_label, r.status, r.estimated_price_minor, r.final_price_minor,
                r.parts_cost_minor, r.deposit_minor, r.pay_method, r.technician_name,
                r.warranty_days, r.note, r.created_by,
                COALESCE(u.display_name, r.created_by) AS created_by_name,
                r.created_at, r.delivered_at
           FROM repairs r
           LEFT JOIN users u ON u.id = r.created_by
          WHERE r.id = ?1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(map_raw_row))
}

pub async fn insert(
    conn: &mut SqliteConnection,
    row: NewRepairRow<'_>,
) -> Result<RawRepairRow, sqlx::Error> {
    sqlx::query(
        "INSERT INTO repairs (
            id, ticket_no, service_kind, customer_name, customer_phone,
            device_name, imei, device_lock, issue, accessories,
            due_label, status, estimated_price_minor, final_price_minor,
            parts_cost_minor, deposit_minor, pay_method, technician_name,
            warranty_days, note, created_by, created_at, delivered_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14,
            ?15, ?16, ?17, ?18,
            ?19, ?20, ?21, ?22, ?23
         )",
    )
    .bind(row.id.as_str())
    .bind(row.ticket_no)
    .bind(row.service_kind.as_str())
    .bind(row.customer_name)
    .bind(row.customer_phone)
    .bind(row.device_name)
    .bind(row.imei)
    .bind(row.device_lock)
    .bind(row.issue)
    .bind(row.accessories)
    .bind(row.due_label)
    .bind(row.status.as_str())
    .bind(row.estimated_price_minor)
    .bind(row.final_price_minor)
    .bind(row.parts_cost_minor)
    .bind(row.deposit_minor)
    .bind(row.pay_method.as_str())
    .bind(row.technician_name)
    .bind(row.warranty_days)
    .bind(row.note)
    .bind(row.created_by)
    .bind(row.created_at)
    .bind(row.delivered_at)
    .execute(&mut *conn)
    .await?;

    find_raw_by_id(conn, row.id.as_str())
        .await?
        .ok_or(sqlx::Error::RowNotFound)
}

pub async fn update_status_and_details(
    conn: &mut SqliteConnection,
    id: &str,
    status: RepairStatus,
    technician_name: Option<&str>,
    estimated_price_minor: Option<i64>,
    parts_cost_minor: Option<i64>,
    note: Option<&str>,
) -> Result<RawRepairRow, sqlx::Error> {
    let existing = find_raw_by_id(conn, id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
    let next_tech = technician_name.or(existing.technician_name.as_deref());
    let next_est = estimated_price_minor.unwrap_or(existing.estimated_price_minor);
    let next_parts = parts_cost_minor.unwrap_or(existing.parts_cost_minor);
    let next_note = note.unwrap_or(&existing.note);

    sqlx::query(
        "UPDATE repairs
            SET status = ?1,
                technician_name = ?2,
                estimated_price_minor = ?3,
                parts_cost_minor = ?4,
                note = ?5
          WHERE id = ?6",
    )
    .bind(status.as_str())
    .bind(next_tech)
    .bind(next_est)
    .bind(next_parts)
    .bind(next_note)
    .bind(id)
    .execute(&mut *conn)
    .await?;

    find_raw_by_id(conn, id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
}

pub struct DeliverRepairUpdate<'a> {
    pub id: &'a str,
    pub final_price_minor: i64,
    pub parts_cost_minor: i64,
    pub pay_method: RepairPayMethod,
    pub technician_name: Option<&'a str>,
    pub warranty_days: i64,
    pub note: Option<&'a str>,
    pub delivered_at: i64,
}

pub async fn mark_delivered(
    conn: &mut SqliteConnection,
    update: DeliverRepairUpdate<'_>,
) -> Result<RawRepairRow, sqlx::Error> {
    let existing = find_raw_by_id(conn, update.id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
    let next_tech = update
        .technician_name
        .or(existing.technician_name.as_deref());
    let next_note = update.note.unwrap_or(&existing.note);
    let effective_delivered_at = update.delivered_at.max(existing.created_at);

    sqlx::query(
        "UPDATE repairs
            SET status = 'delivered',
                final_price_minor = ?1,
                parts_cost_minor = ?2,
                pay_method = ?3,
                technician_name = ?4,
                warranty_days = ?5,
                note = ?6,
                delivered_at = ?7
          WHERE id = ?8",
    )
    .bind(update.final_price_minor)
    .bind(update.parts_cost_minor)
    .bind(update.pay_method.as_str())
    .bind(next_tech)
    .bind(update.warranty_days)
    .bind(next_note)
    .bind(effective_delivered_at)
    .bind(update.id)
    .execute(&mut *conn)
    .await?;

    find_raw_by_id(conn, update.id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
}

pub async fn mark_cancelled(
    conn: &mut SqliteConnection,
    id: &str,
    note: Option<&str>,
) -> Result<RawRepairRow, sqlx::Error> {
    let existing = find_raw_by_id(conn, id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
    let next_note = note.unwrap_or(&existing.note);

    sqlx::query("UPDATE repairs SET status = 'cancelled', note = ?1 WHERE id = ?2")
        .bind(next_note)
        .bind(id)
        .execute(&mut *conn)
        .await?;

    find_raw_by_id(conn, id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
}

pub async fn list_all_raw(conn: &mut SqliteConnection) -> Result<Vec<RawRepairRow>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT r.id, r.ticket_no, r.service_kind, r.customer_name, r.customer_phone,
                r.device_name, r.imei, r.device_lock, r.issue, r.accessories,
                r.due_label, r.status, r.estimated_price_minor, r.final_price_minor,
                r.parts_cost_minor, r.deposit_minor, r.pay_method, r.technician_name,
                r.warranty_days, r.note, r.created_by,
                COALESCE(u.display_name, r.created_by) AS created_by_name,
                r.created_at, r.delivered_at
           FROM repairs r
           LEFT JOIN users u ON u.id = r.created_by
          ORDER BY
            CASE r.status
              WHEN 'received' THEN 1
              WHEN 'diagnosing' THEN 2
              WHEN 'waiting' THEN 3
              WHEN 'ready' THEN 4
              WHEN 'delivered' THEN 5
              ELSE 6
            END ASC,
            COALESCE(r.delivered_at, r.created_at) DESC,
            r.id DESC",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(map_raw_row).collect())
}

fn in_window(ts: i64, from_ts: Option<i64>, to_ts: Option<i64>) -> bool {
    if let Some(f) = from_ts {
        if ts < f {
            return false;
        }
    }
    if let Some(t) = to_ts {
        if ts > t {
            return false;
        }
    }
    true
}

fn accumulate_payment(bucket: &mut RepairKindFinancialBucket, method: &str, amount_minor: i64) {
    if amount_minor <= 0 {
        return;
    }
    match method {
        "vf" => bucket.vf_collected_minor += amount_minor,
        "instapay" => bucket.instapay_collected_minor += amount_minor,
        "card" => bucket.card_collected_minor += amount_minor,
        _ => bucket.cash_collected_minor += amount_minor,
    }
}

fn add_to_bucket(
    bucket: &mut RepairKindFinancialBucket,
    row: &RawRepairRow,
    created_in_period: bool,
    delivered_in_period: bool,
    is_open: bool,
) {
    if is_open {
        bucket.open_count += 1;
        if row.status == "ready" {
            bucket.ready_count += 1;
        }
    }
    if (created_in_period || delivered_in_period || is_open) && row.status != "cancelled" {
        bucket.tickets_count += 1;
    }
    if row.status == "cancelled" {
        return;
    }
    // Deposit collected at intake (cash)
    if created_in_period && row.deposit_minor > 0 {
        bucket.deposit_collected_minor += row.deposit_minor;
        bucket.total_revenue_minor += row.deposit_minor;
        accumulate_payment(bucket, "cash", row.deposit_minor);
    }
    // Remaining amount collected on delivery (`pay_method`)
    if row.status == "delivered" && delivered_in_period {
        bucket.delivered_count += 1;
        let delivery_slice = (row.final_price_minor - row.deposit_minor).max(0);
        bucket.delivery_collected_minor += delivery_slice;
        bucket.total_revenue_minor += delivery_slice;
        accumulate_payment(bucket, &row.pay_method, delivery_slice);
        if let Some(ref mut parts) = bucket.parts_cost_minor {
            *parts += row.parts_cost_minor;
        }
    } else if row.status != "delivered" && created_in_period && row.parts_cost_minor > 0 {
        if let Some(ref mut parts) = bucket.parts_cost_minor {
            *parts += row.parts_cost_minor;
        }
    }
    if let (Some(parts), Some(ref mut profit)) =
        (bucket.parts_cost_minor, &mut bucket.net_profit_minor)
    {
        *profit = bucket.total_revenue_minor - parts;
    }
}

pub async fn build_overview(
    conn: &mut SqliteConnection,
    from_ts: Option<i64>,
    to_ts: Option<i64>,
    include_cost: bool,
) -> Result<RepairsOverview, sqlx::Error> {
    let raw_rows = list_all_raw(conn).await?;

    let mut hardware = RepairKindFinancialBucket::empty("hardware", include_cost);
    let mut software = RepairKindFinancialBucket::empty("software", include_cost);
    let mut combined = RepairKindFinancialBucket::empty("all", include_cost);

    #[derive(Default)]
    struct TechAcc {
        hw_count: i64,
        sw_count: i64,
        delivered_count: i64,
        hw_rev: i64,
        sw_rev: i64,
        parts_cost: i64,
    }
    let mut tech_map: BTreeMap<String, TechAcc> = BTreeMap::new();
    let mut visible_tickets = Vec::new();

    for row in raw_rows {
        let is_open = matches!(
            row.status.as_str(),
            "received" | "diagnosing" | "waiting" | "ready"
        );
        let created_in_period = in_window(row.created_at, from_ts, to_ts);
        let delivered_in_period = row
            .delivered_at
            .map(|d| in_window(d, from_ts, to_ts))
            .unwrap_or(false);

        if row.service_kind == "software" {
            add_to_bucket(
                &mut software,
                &row,
                created_in_period,
                delivered_in_period,
                is_open,
            );
        } else {
            add_to_bucket(
                &mut hardware,
                &row,
                created_in_period,
                delivered_in_period,
                is_open,
            );
        }
        add_to_bucket(
            &mut combined,
            &row,
            created_in_period,
            delivered_in_period,
            is_open,
        );

        // Technician breakdown in period
        if row.status != "cancelled" && (created_in_period || delivered_in_period || is_open) {
            if let Some(tech) = row
                .technician_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let entry = tech_map.entry(tech.to_owned()).or_default();
                if row.service_kind == "software" {
                    entry.sw_count += 1;
                } else {
                    entry.hw_count += 1;
                }
                let mut rev_in_period = 0;
                if created_in_period && row.deposit_minor > 0 {
                    rev_in_period += row.deposit_minor;
                }
                if row.status == "delivered" && delivered_in_period {
                    entry.delivered_count += 1;
                    rev_in_period += (row.final_price_minor - row.deposit_minor).max(0);
                    entry.parts_cost += row.parts_cost_minor;
                }
                if row.service_kind == "software" {
                    entry.sw_rev += rev_in_period;
                } else {
                    entry.hw_rev += rev_in_period;
                }
            }
        }

        if is_open || created_in_period || delivered_in_period {
            visible_tickets.push(row.into_ticket(include_cost));
        }
    }

    let mut technicians: Vec<RepairTechnicianSummary> = tech_map
        .into_iter()
        .map(|(technician_name, acc)| {
            let total_revenue_minor = acc.hw_rev + acc.sw_rev;
            let net = total_revenue_minor - acc.parts_cost;
            RepairTechnicianSummary {
                technician_name,
                hardware_count: acc.hw_count,
                software_count: acc.sw_count,
                delivered_count: acc.delivered_count,
                hardware_revenue_minor: acc.hw_rev,
                software_revenue_minor: acc.sw_rev,
                total_revenue_minor,
                parts_cost_minor: include_cost.then_some(acc.parts_cost),
                net_profit_minor: include_cost.then_some(net),
            }
        })
        .collect();
    technicians.sort_by(|a, b| {
        b.total_revenue_minor
            .cmp(&a.total_revenue_minor)
            .then_with(|| a.technician_name.cmp(&b.technician_name))
    });

    Ok(RepairsOverview {
        tickets: visible_tickets,
        hardware,
        software,
        combined,
        technicians,
    })
}

impl From<sqlx::Error> for RepairError {
    fn from(_: sqlx::Error) -> Self {
        RepairError::NotFound
    }
}
