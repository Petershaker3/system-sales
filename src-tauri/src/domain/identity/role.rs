//! Roles and what each role is permitted to do.
//!
//! `spec:17-18` defines exactly two roles. The model is a closed enum rather
//! than a `roles` table: nothing in V1 makes roles mutable data, and ADR-009
//! records that deliberate deviation from `plan:141`.
//!
//! The rule that matters for security is `spec:54` / `plan:151`: a sales user
//! must never receive wholesale or cost data. That is expressed here once, as
//! data, instead of being re-implemented in each command.

use std::fmt;

use serde::{Deserialize, Serialize};

/// A capability the application can gate on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    /// Create, edit and archive products.
    ManageCatalog,
    /// Receive wholesale price, purchase cost and profit figures.
    ///
    /// Gated twice over: by role, and by assurance level. `plan:151` requires
    /// re-authentication when wholesale data is revealed, so a manager who has
    /// only logged in still cannot see it.
    ViewCostAndProfit,
    /// Create and manage user accounts.
    ///
    /// Requires a freshly proven password. Creating an account, resetting a
    /// password, changing a role or disabling an operator are all ways to alter
    /// who can do what on the device, so none of them may run on the strength of
    /// a session that was established hours ago.
    ManageUsers,
    /// Change one's own password.
    ///
    /// Deliberately exempt from the re-authentication requirement. A user who
    /// arrives from a manager reset has only a fresh login, never a
    /// re-authentication, so requiring one here would make the forced change
    /// impossible to complete and would brick the account instead of recovering
    /// it. Proof of the *current* password is required by the service layer
    /// instead, which is a stronger check than assurance level anyway.
    ChangeOwnPassword,
    /// Record sales.
    Sell,
    /// Create the very first manager account.
    ///
    /// Not role-derived. It is granted only while the user table is empty, and
    /// the real gate lives in `services::identity::bootstrap` inside the same
    /// transaction as the insert.
    PerformFirstRunSetup,

    /// Manage inventory: opening balances, receipts, adjustments, stocktakes and
    /// department transfers.
    ///
    /// Separate from `ManageCatalog` on purpose. The catalogue is product
    /// *identity*; inventory is *money*. A sales user who may rename a product must
    /// not thereby be able to write its cost, and collapsing the two would make a
    /// cost field editable by anyone permitted to edit a name.
    ///
    /// Not in `requires_reauthenticated`: this permission is a mix. Receiving a
    /// carton is routine; opening a balance declares what the shop is worth. The
    /// two are separated by `require_sensitivity` at the operation, the same way
    /// `change_own_password` is.
    ManageInventory,

    /// Create, edit, order, archive and restore departments (product
    /// classifications).
    ///
    /// Also a mix: naming a classification is routine, changing its costing method
    /// is not. Not blanket re-authenticated for the same reason as
    /// `ManageInventory`.
    ManageDepartments,

    /// Read and change device settings: costing default, invoice prefix, VAT
    /// defaults, maximum Sales discount, and the Pattern itself.
    ///
    /// Blanket re-authenticated. Unlike the two above, this is **not** a mix: every
    /// settings change is sensitive, so a per-permission rule costs nothing and
    /// removes the chance that an operation forgets to ask.
    ManageSettings,

    /// Cancel a recorded transaction.
    ///
    /// Cancellation restores inventory and preserves the cancelled document, so it
    /// is an inventory operation as much as a sales one. Not blanket
    /// re-authenticated; gated per operation so the Pattern can be required
    /// without a password prompt on every manager action.
    CancelTransaction,
}

impl Permission {
    pub fn requires_reauthenticated(self) -> bool {
        matches!(
            self,
            Permission::ViewCostAndProfit
                | Permission::ManageUsers
                | Permission::ManageSettings
        )
    }

    /// Whether any signed-in account may hold this, regardless of role.
    ///
    /// `ChangeOwnPassword` qualifies: a sales user must be able to change their
    /// own password, including while a manager reset is pending.
    pub fn is_self_service(self) -> bool {
        matches!(self, Permission::ChangeOwnPassword)
    }
}

/// The two roles defined by `spec:17-18`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// Runs the shop: products, inventory, wholesale figures, users, reports.
    Manager,
    /// Records sales. No wholesale, no catalog management.
    Sales,
}

impl Role {
    /// Whether this role holds the permission, ignoring session assurance.
    pub fn allows(self, permission: Permission) -> bool {
        // Self-service permissions are not a property of a role. A sales user who
        // cannot change their own password would be trapped: the only way out
        // would be a manager, and a shop may have exactly one manager.
        if permission.is_self_service() {
            return true;
        }
        match self {
            // `PerformFirstRunSetup` is intentionally absent for both roles.
            // It is not a property of a role: it is a property of an empty
            // user table, checked transactionally at bootstrap time.
            Role::Manager => matches!(
                permission,
                Permission::ManageCatalog
                    | Permission::ViewCostAndProfit
                    | Permission::ManageUsers
                    | Permission::ManageInventory
                    | Permission::ManageDepartments
                    | Permission::ManageSettings
                    | Permission::CancelTransaction
                    | Permission::Sell
            ),
            Role::Sales => matches!(permission, Permission::Sell),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Manager => "manager",
            Role::Sales => "sales",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "manager" => Some(Role::Manager),
            "sales" => Some(Role::Sales),
            _ => None,
        }
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}