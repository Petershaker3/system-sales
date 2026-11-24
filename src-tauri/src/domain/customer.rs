//! Customer file core (P4, `spec:30`, `spec:178-179`).
//!
//! A customer is a name plus a single optional contact. Nothing more: no
//! address, no national id, no warranty dates (those wait for decision D4 and
//! arrive by additive migration). Sales users may create a customer for an
//! invoice; only managers browse records — that split lives in the service
//! layer, not here.
//!
//! The no-merge rule (`spec:178`) is structural: names carry no uniqueness,
//! and there is deliberately no find-by-name constructor, so two similar
//! names cannot collapse into one record by accident or by query.

use std::fmt;

use serde::{Deserialize, Serialize};

use super::identity::{Timestamp, UserId};

/// Longest accepted customer name.
///
/// Ruling: the spec sets no limit; 120 keeps rows readable on a phone list
/// while never truncating real names. Cost if wrong: one constant change.
pub const MAX_NAME_LEN: usize = 120;

/// Longest accepted contact value (one phone number, one handle, one line).
///
/// Ruling: 64 covers international phone formats with room to spare.
pub const MAX_CONTACT_LEN: usize = 64;

/// A customer record as the domain sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Customer {
    /// UUID v7, generated once at creation.
    pub id: String,
    /// Display name, trimmed, never empty. Non-unique by design.
    pub name: String,
    /// The single optional contact. `None` means none was given.
    pub contact: Option<String>,
    /// Normal-flow archival (ID-04): archived records keep their history.
    pub archived: bool,
    /// Attributing operator, from the resolved session.
    pub created_by: UserId,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Everything the customer domain can refuse. Flattened to one stable code
/// at the command boundary; Arabic wording lives in `src/api/errors.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustomerError {
    /// The name is empty after trimming, or longer than [`MAX_NAME_LEN`].
    NameInvalid,
    /// The contact is longer than [`MAX_CONTACT_LEN`].
    ContactInvalid,
    /// No customer carries this id.
    NotFound,
    /// The record is archived; the operation needs a live one.
    IsArchived,
    /// The debt-settlement payment amount is zero or negative.
    PaymentAmountInvalid,
    /// The debt-settlement payment exceeds the customer's current آجل balance.
    PaymentExceedsBalance,
    /// The debt-settlement method is not one of `cash`, `vf`, `instapay`, `card`.
    PaymentMethodInvalid,
    /// The named wallet does not receive that method (`ADR-041`).
    PaymentWalletInvalid,
    /// The ledger note exceeds 200 characters.
    NoteInvalid,
}

impl CustomerError {
    /// The stable, language-independent code sent to the frontend.
    pub fn code(&self) -> &'static str {
        match self {
            CustomerError::NameInvalid => "CUSTOMER_NAME_INVALID",
            CustomerError::ContactInvalid => "CUSTOMER_CONTACT_INVALID",
            CustomerError::NotFound => "CUSTOMER_NOT_FOUND",
            CustomerError::IsArchived => "CUSTOMER_IS_ARCHIVED",
            CustomerError::PaymentAmountInvalid => "CUSTOMER_PAYMENT_AMOUNT_INVALID",
            CustomerError::PaymentExceedsBalance => "CUSTOMER_PAYMENT_EXCEEDS_BALANCE",
            CustomerError::PaymentMethodInvalid => "CUSTOMER_PAYMENT_METHOD_INVALID",
            CustomerError::PaymentWalletInvalid => "CUSTOMER_PAYMENT_WALLET_INVALID",
            CustomerError::NoteInvalid => "CUSTOMER_NOTE_INVALID",
        }
    }
}

impl fmt::Display for CustomerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            CustomerError::NameInvalid => "customer name is invalid",
            CustomerError::ContactInvalid => "customer contact is invalid",
            CustomerError::NotFound => "customer not found",
            CustomerError::IsArchived => "customer is archived",
            CustomerError::PaymentAmountInvalid => "customer payment amount must be positive",
            CustomerError::PaymentExceedsBalance => {
                "customer payment exceeds current credit balance"
            }
            CustomerError::PaymentMethodInvalid => "customer payment method is invalid",
            CustomerError::PaymentWalletInvalid => "the wallet named for this payment does not receive that method",
            CustomerError::NoteInvalid => "customer ledger note is too long",
        })
    }
}

/// A customer record paired with their current آجل balance in piastres (`ADR-020` §3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomerWithBalance {
    pub customer: Customer,
    pub balance_minor: i64,
}

/// One row of a customer's credit (`آجل`) ledger (`ADR-020` §3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomerLedgerEntry {
    pub id: String,
    pub customer_id: String,
    /// `"credit_sale"`, `"payment"`, or `"sale_reversal"`.
    pub kind: String,
    /// Signed delta in piastres (`+` increases debt, `-` reduces debt).
    pub amount_minor: i64,
    pub method: Option<String>,
    /// The shop wallet that took the money of a `payment` row (`ADR-041`). NULL on the rows that
    /// move no money into a wallet (`credit_sale`, `sale_reversal`).
    pub wallet_id: Option<String>,
    pub sale_id: Option<String>,
    pub note: Option<String>,
    pub actor_id: UserId,
    pub occurred_at: Timestamp,
}

/// Validated input for recording a customer debt payment (`ADR-020` §3).
#[derive(Debug, Clone)]
pub struct NewCustomerPayment {
    pub customer_id: String,
    pub amount_minor: i64,
    pub method: String,
    pub note: Option<String>,
    /// The shop wallet the customer transferred into (`ADR-041`).
    pub wallet_id: Option<String>,
}

impl NewCustomerPayment {
    pub fn cleaned(&self) -> Result<(i64, String, Option<String>, Option<String>), CustomerError> {
        if self.amount_minor <= 0 {
            return Err(CustomerError::PaymentAmountInvalid);
        }
        let method = self.method.trim();
        if !matches!(method, "cash" | "vf" | "instapay" | "card") {
            return Err(CustomerError::PaymentMethodInvalid);
        }
        let note = match self.note.as_deref() {
            None => None,
            Some(raw) => {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    None
                } else if trimmed.chars().count() > 200 {
                    return Err(CustomerError::NoteInvalid);
                } else {
                    Some(trimmed.to_owned())
                }
            }
        };
        let wallet_id = self
            .wallet_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        Ok((self.amount_minor, method.to_owned(), note, wallet_id))
    }
}

impl std::error::Error for CustomerError {}

/// Input for creating a customer. The id, attribution and timestamps are
/// assigned by the service layer, never by the caller.
#[derive(Debug, Clone)]
pub struct NewCustomer {
    pub name: String,
    pub contact: Option<String>,
}

impl NewCustomer {
    /// Trim and validate. Returns the cleaned (name, contact) pair.
    /// An empty contact string is treated as no contact.
    pub fn cleaned(&self) -> Result<(String, Option<String>), CustomerError> {
        let name = self.name.trim().to_string();
        if name.is_empty() || name.chars().count() > MAX_NAME_LEN {
            return Err(CustomerError::NameInvalid);
        }
        let contact = match self.contact.as_deref() {
            None => None,
            Some(raw) => {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    if trimmed.chars().count() > MAX_CONTACT_LEN {
                        return Err(CustomerError::ContactInvalid);
                    }
                    Some(trimmed.to_string())
                }
            }
        };
        Ok((name, contact))
    }
}
