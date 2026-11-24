//! Customer file commands (P4, `spec:178-179`).
//!
//! Transport boundaries only. No SQL and no business rule appears here, and no
//! command accepts a session, token or role: the operator is resolved from the
//! OS credential store inside the use case.
//!
//! Creating rides on `Sell` (both roles, invoice-time entry); listing,
//! reading and archiving require `ManageCustomers` (manager-only). The split
//! is enforced in `services::customer`, never here.

use serde::Serialize;
use tauri::State;

use crate::domain::customer::{
    Customer, CustomerLedgerEntry, CustomerWithBalance, NewCustomerPayment,
};
use crate::services::customer::{self as use_cases, CustomerServiceError};
use crate::services::identity::IdentityContext;

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure crossing the boundary is a stable code, never prose.
/// `spec:127` keeps user-facing text in Arabic message files on the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerCommandError {
    pub code: &'static str,
}

impl From<CustomerServiceError> for CustomerCommandError {
    fn from(error: CustomerServiceError) -> Self {
        Self { code: error.code() }
    }
}

/// The customer as the frontend sees it, including their current آجل balance
/// in piastres (`ADR-020` §3).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerDto {
    pub id: String,
    pub name: String,
    pub contact: Option<String>,
    pub archived: bool,
    pub balance_minor: i64,
}

impl From<Customer> for CustomerDto {
    fn from(customer: Customer) -> Self {
        Self {
            id: customer.id,
            name: customer.name,
            contact: customer.contact,
            archived: customer.archived,
            balance_minor: 0,
        }
    }
}

impl From<CustomerWithBalance> for CustomerDto {
    fn from(item: CustomerWithBalance) -> Self {
        Self {
            id: item.customer.id,
            name: item.customer.name,
            contact: item.customer.contact,
            archived: item.customer.archived,
            balance_minor: item.balance_minor,
        }
    }
}

/// One row of a customer's credit (`آجل`) ledger as seen by the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerLedgerEntryDto {
    pub id: String,
    pub customer_id: String,
    pub kind: String,
    pub amount_minor: i64,
    pub method: Option<String>,
    pub sale_id: Option<String>,
    pub note: Option<String>,
    pub occurred_at: i64,
}

impl From<CustomerLedgerEntry> for CustomerLedgerEntryDto {
    fn from(entry: CustomerLedgerEntry) -> Self {
        Self {
            id: entry.id,
            customer_id: entry.customer_id,
            kind: entry.kind,
            amount_minor: entry.amount_minor,
            method: entry.method,
            sale_id: entry.sale_id,
            note: entry.note,
            occurred_at: entry.occurred_at.as_millis(),
        }
    }
}

/// Create a customer for an invoice. Both roles may call this; a similar
/// name never merges (`spec:178`).
#[tauri::command]
pub async fn create_customer(
    ctx: Ctx<'_>,
    name: String,
    contact: Option<String>,
) -> Result<CustomerDto, CustomerCommandError> {
    let input = crate::domain::customer::NewCustomer { name, contact };
    let customer = use_cases::create(&ctx.pool, ctx.tokens.as_ref(), input).await?;
    Ok(customer.into())
}

/// List live customers with their current آجل balance (`ADR-020` §3).
#[tauri::command]
pub async fn list_customers(ctx: Ctx<'_>) -> Result<Vec<CustomerDto>, CustomerCommandError> {
    let customers = use_cases::list_with_balances(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(customers.into_iter().map(CustomerDto::from).collect())
}

/// Read one customer with their current آجل balance (`ADR-020` §3).
#[tauri::command]
pub async fn get_customer(
    ctx: Ctx<'_>,
    id: String,
) -> Result<CustomerDto, CustomerCommandError> {
    let customer = use_cases::get_with_balance(&ctx.pool, ctx.tokens.as_ref(), &id).await?;
    Ok(customer.into())
}

/// Archive a customer. Manager-only. History keeps its references (ID-04).
#[tauri::command]
pub async fn archive_customer(
    ctx: Ctx<'_>,
    id: String,
) -> Result<CustomerDto, CustomerCommandError> {
    let customer = use_cases::archive(&ctx.pool, ctx.tokens.as_ref(), &id).await?;
    Ok(customer.into())
}

/// Record a payment from a customer against their آجل balance (`ADR-020` §3).
#[tauri::command]
pub async fn record_customer_payment(
    ctx: Ctx<'_>,
    customer_id: String,
    amount_minor: i64,
    method: String,
    note: Option<String>,
    wallet_id: Option<String>,
) -> Result<CustomerDto, CustomerCommandError> {
    let updated = use_cases::record_payment(
        &ctx.pool,
        ctx.tokens.as_ref(),
        NewCustomerPayment {
            customer_id,
            amount_minor,
            method,
            note,
            wallet_id,
        },
    )
    .await?;
    Ok(updated.into())
}

/// List a customer's credit ledger entries (`ADR-020` §3).
#[tauri::command]
pub async fn list_customer_ledger(
    ctx: Ctx<'_>,
    customer_id: String,
) -> Result<Vec<CustomerLedgerEntryDto>, CustomerCommandError> {
    let entries =
        use_cases::list_ledger(&ctx.pool, ctx.tokens.as_ref(), &customer_id).await?;
    Ok(entries
        .into_iter()
        .map(CustomerLedgerEntryDto::from)
        .collect())
}
