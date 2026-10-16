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
}

impl CustomerError {
    /// The stable, language-independent code sent to the frontend.
    pub fn code(&self) -> &'static str {
        match self {
            CustomerError::NameInvalid => "CUSTOMER_NAME_INVALID",
            CustomerError::ContactInvalid => "CUSTOMER_CONTACT_INVALID",
            CustomerError::NotFound => "CUSTOMER_NOT_FOUND",
            CustomerError::IsArchived => "CUSTOMER_IS_ARCHIVED",
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
        })
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
