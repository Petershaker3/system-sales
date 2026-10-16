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

use crate::domain::customer::Customer;
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

/// The customer as the frontend sees it: identity only, no attribution
/// metadata. The list is a browsing surface (`spec:18`), so it carries the
/// minimum needed to recognise a record.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomerDto {
    pub id: String,
    pub name: String,
    pub contact: Option<String>,
    pub archived: bool,
}

impl From<Customer> for CustomerDto {
    fn from(customer: Customer) -> Self {
        Self {
            id: customer.id,
            name: customer.name,
            contact: customer.contact,
            archived: customer.archived,
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

/// List live customers. Manager-only; a sales caller is refused in Rust.
#[tauri::command]
pub async fn list_customers(ctx: Ctx<'_>) -> Result<Vec<CustomerDto>, CustomerCommandError> {
    let customers = use_cases::list(&ctx.pool, ctx.tokens.as_ref()).await?;
    Ok(customers.into_iter().map(CustomerDto::from).collect())
}

/// Read one customer. Manager-only.
#[tauri::command]
pub async fn get_customer(
    ctx: Ctx<'_>,
    id: String,
) -> Result<CustomerDto, CustomerCommandError> {
    let customer = use_cases::get(&ctx.pool, ctx.tokens.as_ref(), &id).await?;
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
