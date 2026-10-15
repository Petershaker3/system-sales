//! The department aggregate: a product classification.
//!
//! # A department is a classification, not a place
//!
//! A department is the grouping a shop already uses to organise what it sells —
//! phones, accessories, spare parts. It is **not** a warehouse, a branch, a
//! storage area, a shelf or a bin.
//!
//! This module therefore contains no location, no storage area, no bin, no
//! transfer and no stock counter. V1 has exactly one stock counter per product,
//! so a department cannot partition a product's stock; it classifies the product.
//! Anything that would express a physical move between places would need a second
//! dimension that does not exist here on purpose.
//!
//! # `cost_method` is stored, not acted on
//!
//! Both methods are valid configuration and both are accepted. **Neither costing
//! algorithm exists.** `moving_average` arrives with the inventory ledger and
//! `fifo` with its costing engine, so this module never reads the field to
//! compute anything: it validates that a method is present and legal, and stops
//! there. Rejecting `Fifo` here would be inventing a requirement the Product
//! Owner did not make.
//!
//! # No VAT arithmetic
//!
//! `vat_rate_bp` is an integer count of basis points — 1450 means 14.50%. The
//! module validates the shape of a VAT setting and never computes an amount from
//! it. Rounding stays undecided (`spec:239`), and no percentage or
//! floating-point value appears anywhere in this file.

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::identity::UserId;

/// A department identifier. Always a UUID v7; there is no other constructor.
///
/// Mirrors `ProductId` and `UserId`: `spec:109` and `ADR-008:44` forbid deriving
/// identifiers from storage location or a per-device counter, and UUID v7 also
/// sorts in creation order. See ADR-009.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DepartmentId(Uuid);

impl DepartmentId {
    /// Generate a new identifier, time-ordered.
    pub fn generate() -> Self {
        Self(Uuid::now_v7())
    }

    /// Rehydrate an identifier read from storage.
    ///
    /// Deliberately separate from `generate` so that reading a row never silently
    /// mints a new id.
    pub fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }

    pub fn as_str(&self) -> String {
        self.0.to_string()
    }
}

impl fmt::Display for DepartmentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

/// A validated department name.
///
/// Trimming happens here so every stored name is already tidy, and an empty
/// result is refused rather than replaced. A name is never manufactured: if the
/// manager typed whitespace, the department is not created.
///
/// Length is not capped. No maximum has been approved, and inventing one would
/// encode an assumption as a requirement — the same reasoning as `ProductName`.
///
/// Case is **not** folded here. Uniqueness among live departments is
/// case-insensitive, but that is a storage invariant enforced by the partial
/// unique index in migration `0004`, and it is a comparison rule rather than a
/// transformation of the operator's own text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DepartmentName(String);

impl DepartmentName {
    /// Trim, then reject an empty name.
    pub fn new(value: &str) -> Result<Self, DepartmentError> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(DepartmentError::NameRequired);
        }
        Ok(Self(trimmed.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DepartmentName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Archive state. Exactly two states, matching the `departments.status` CHECK.
///
/// `serde` is `snake_case` here so the serialised name and the stored name are
/// the same string. `camelCase` would make `MovingAverage` serialise as
/// `movingAverage` while `as_str` returns `moving_average`, and a mismatch
/// between the wire value and the stored value is a bug waiting for a DTO.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DepartmentStatus {
    Active,
    Archived,
}

impl DepartmentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DepartmentStatus::Active => "active",
            DepartmentStatus::Archived => "archived",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(DepartmentStatus::Active),
            "archived" => Some(DepartmentStatus::Archived),
            _ => None,
        }
    }
}

impl fmt::Display for DepartmentStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl DepartmentStatus {
    /// An archived department is read-only.
    ///
    /// The approved lifecycle is `Active -> Archived -> Active`: archiving is
    /// one-way *per the archive operation* (it cannot be undone by editing), but
    /// a deliberate restore exists as its own named operation
    /// ([`Department::restore`], SP-1b/c plan DoD 3). What stays closed is
    /// editing an archived department — that path never reopens through
    /// [`Department::update`].
    pub fn allows_edit(self) -> bool {
        matches!(self, DepartmentStatus::Active)
    }
}

/// How the stock in a department is costed.
///
/// Both values are legitimate configuration and both are stored inertly. See the
/// module documentation: no costing arithmetic exists here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CostMethod {
    MovingAverage,
    Fifo,
}

impl CostMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            CostMethod::MovingAverage => "moving_average",
            CostMethod::Fifo => "fifo",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "moving_average" => Some(CostMethod::MovingAverage),
            "fifo" => Some(CostMethod::Fifo),
            _ => None,
        }
    }
}

impl fmt::Display for CostMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A VAT rate as an integer count of basis points.
///
/// 1450 basis points is 14.50%. An integer because a percentage is not an
/// integer and a floating-point value would break the project's rule that money
/// and rates are stored exactly (`spec:56`, ADR-010).
///
/// This type stores a *rate*, never an amount. It is not a money type and it
/// never multiplies anything; amounts are [`Piastres`](crate::domain::money::Piastres).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VatRate(i64);

impl VatRate {
    /// Rejects a negative rate. A negative percentage is not a rate.
    pub fn new(basis_points: i64) -> Result<Self, DepartmentError> {
        if basis_points < 0 {
            return Err(DepartmentError::VatRateNegative);
        }
        Ok(Self(basis_points))
    }

    pub fn as_basis_points(&self) -> i64 {
        self.0
    }
}

/// A department's VAT configuration.
///
/// A value object rather than three loose fields, so the one invalid
/// combination — VAT switched on with no rate to apply — cannot be represented at
/// all rather than merely being discouraged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DepartmentVat {
    enabled: bool,
    rate: Option<VatRate>,
    inclusive: bool,
}

impl DepartmentVat {
    /// VAT switched off, with no rate recorded. The state a new department has.
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            rate: None,
            inclusive: false,
        }
    }

    /// Build a setting, refusing the meaningless combination.
    ///
    /// A recorded rate is allowed while VAT is off: switching VAT off is a
    /// temporary business decision, and forcing the manager to erase the rate at
    /// the same time would lose it for no benefit.
    pub fn new(
        enabled: bool,
        rate: Option<VatRate>,
        inclusive: bool,
    ) -> Result<Self, DepartmentError> {
        if enabled && rate.is_none() {
            return Err(DepartmentError::VatRateRequired);
        }
        Ok(Self {
            enabled,
            rate,
            inclusive,
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn rate(&self) -> Option<VatRate> {
        self.rate
    }

    /// Whether the recorded price already contains VAT.
    ///
    /// Recorded only. Whether a price is inclusive is a fact about a transaction,
    /// and no amount is derived from it here.
    pub fn is_inclusive(&self) -> bool {
        self.inclusive
    }

    /// Turn VAT on or off, keeping any recorded rate.
    ///
    /// Switching on without a rate is refused, because that is the state the
    /// type cannot represent. Switching off always succeeds and preserves the
    /// rate, which is the whole point of the field being separate from the flag.
    pub fn with_enabled(self, enabled: bool) -> Result<Self, DepartmentError> {
        if enabled && self.rate.is_none() {
            return Err(DepartmentError::VatRateRequired);
        }
        Ok(Self {
            enabled,
            ..self
        })
    }
}

/// A department: a product classification with its costing and VAT defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Department {
    pub id: DepartmentId,
    pub name: DepartmentName,
    pub status: DepartmentStatus,
    /// Never unset. Both values are valid and neither is acted on yet.
    pub cost_method: CostMethod,
    pub vat: DepartmentVat,
    /// Display order for the classification list. The manager decides.
    pub sort_order: i64,
    pub created_by: UserId,
    pub updated_by: UserId,
    pub created_at: i64,
    pub updated_at: i64,
    /// `None` while active, set when archived. A recorded moment rather than a
    /// value derived from `status`, so the archive time survives later reads.
    pub archived_at: Option<i64>,
}

impl Department {
    /// Create a new department, always active and never archived.
    ///
    /// `sort_order` is taken as given. There is no hidden default ordering: the
    /// manager decides how their own list reads.
    pub fn new(
        name: DepartmentName,
        cost_method: CostMethod,
        vat: DepartmentVat,
        sort_order: i64,
        actor: UserId,
        now: i64,
    ) -> Self {
        Self {
            id: DepartmentId::generate(),
            name,
            status: DepartmentStatus::Active,
            cost_method,
            vat,
            sort_order,
            created_by: actor,
            updated_by: actor,
            created_at: now,
            updated_at: now,
            archived_at: None,
        }
    }

    /// Rebuild a department from stored values.
    ///
    /// Refuses a row whose `status` and `archived_at` disagree. That row is
    /// corrupt, and quietly repairing it would erase the evidence that something
    /// wrote a department in a state the domain forbids. Failing loudly is the
    /// same rule `row_to_product` already follows.
    #[allow(clippy::too_many_arguments)]
    pub fn rehydrate(
        id: DepartmentId,
        name: DepartmentName,
        status: DepartmentStatus,
        cost_method: CostMethod,
        vat: DepartmentVat,
        sort_order: i64,
        created_by: UserId,
        updated_by: UserId,
        created_at: i64,
        updated_at: i64,
        archived_at: Option<i64>,
    ) -> Result<Self, DepartmentError> {
        let consistent = matches!(
            (status, archived_at),
            (DepartmentStatus::Active, None) | (DepartmentStatus::Archived, Some(_))
        );
        if !consistent {
            return Err(DepartmentError::ArchiveStateInconsistent);
        }

        Ok(Self {
            id,
            name,
            status,
            cost_method,
            vat,
            sort_order,
            created_by,
            updated_by,
            created_at,
            updated_at,
            archived_at,
        })
    }

    /// Whether this department may be modified in its current state.
    pub fn is_editable(&self) -> bool {
        self.status.allows_edit()
    }

    /// Apply edits, refusing when the department is archived.
    ///
    /// Every field change goes through here, so an archived department has exactly
    /// one way to change and that way is closed.
    pub fn update(
        &mut self,
        name: DepartmentName,
        cost_method: CostMethod,
        vat: DepartmentVat,
        sort_order: i64,
        actor: UserId,
        now: i64,
    ) -> Result<(), DepartmentError> {
        if !self.is_editable() {
            return Err(DepartmentError::IsArchived);
        }
        // The costing method is live as of SP-2, so it cannot ride along on an
        // ordinary edit: switching has to convert the stock that already exists
        // (see `DepartmentError::CostMethodChangeRequiresSwitch`). Unchanged is
        // still fine — the edit form sends every field back.
        if self.cost_method != cost_method {
            return Err(DepartmentError::CostMethodChangeRequiresSwitch);
        }
        self.name = name;
        self.cost_method = cost_method;
        self.vat = vat;
        self.sort_order = sort_order;
        self.updated_by = actor;
        self.updated_at = now;
        Ok(())
    }

    /// Archive the department.
    ///
    /// One-way *as an operation*: there is no edit path that reopens it, and
    /// `archived_at` is set here rather than being a second, hidden way to
    /// express the same state. Archiving an already-archived department is
    /// refused rather than silently restamping it, because that would overwrite
    /// a recorded archive moment with no new fact to justify it. The explicit
    /// counterpart is [`Department::restore`].
    pub fn archive(&mut self, actor: UserId, now: i64) -> Result<(), DepartmentError> {
        if !self.is_editable() {
            return Err(DepartmentError::IsArchived);
        }
        self.status = DepartmentStatus::Archived;
        self.archived_at = Some(now);
        self.updated_by = actor;
        self.updated_at = now;
        Ok(())
    }

    /// Restore an archived department to active.
    ///
    /// The named counterpart to [`Department::archive`], added by the approved
    /// SP-1b/c plan (`DoD: created, edited, ordered, archived and restored`).
    /// It is its own operation rather than a flag on `update`, for the same
    /// reason `archive` is: a department that is closed has exactly one way to
    /// change, and that way is closed until an explicit restore reopens it.
    ///
    /// `archived_at` is cleared rather than kept, because the field records
    /// *when this department was archived* and an active department carrying an
    /// archive timestamp is exactly the state [`Department::rehydrate`] refuses
    /// to read. Restoring a department that is already active is refused: there
    /// is nothing to restore, and pretending otherwise would record an
    /// attribution change for no fact.
    pub fn restore(&mut self, actor: UserId, now: i64) -> Result<(), DepartmentError> {
        if self.is_editable() {
            return Err(DepartmentError::NotArchived);
        }
        self.status = DepartmentStatus::Active;
        self.archived_at = None;
        self.updated_by = actor;
        self.updated_at = now;
        Ok(())
    }
}

/// Why a department change could not be applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DepartmentError {
    /// No department carries the id a caller named.
    ///
    /// Its own variant rather than a collapsed "permission" or generic failure:
    /// a missing department and a forbidden action send an operator to different
    /// places, the same reasoning that gives the catalogue `NoProductWithThisId`.
    NotFound,

    /// The name was empty or entirely whitespace.
    NameRequired,

    /// The department is archived and accepts no further change.
    ///
    /// Covers editing an archived department and archiving one twice, because
    /// both are attempts to change a department that has already been closed.
    IsArchived,

    /// The department is already active, so there is nothing to restore.
    ///
    /// The mirror of [`DepartmentError::IsArchived`]: restoring twice would
    /// record an attribution change for no fact, exactly like restamping an
    /// archive timestamp.
    NotArchived,

    /// VAT was switched on with no rate to apply.
    VatRateRequired,

    /// A negative basis-point rate is not a rate.
    VatRateNegative,

    /// A stored row claims `active` with an archive timestamp, or `archived`
    /// without one. The two must agree.
    ArchiveStateInconsistent,

    /// An ordinary edit tried to change the costing method.
    ///
    /// Its own variant because the costing method is no longer inert
    /// configuration. `ADR-012` stored it while nothing read it; SP-2 gives it
    /// an engine, and switching between `moving_average` and `fifo` has to
    /// convert the stock that already exists — seed a FIFO layer from the
    /// current average, or collapse the layers into a moving-average total.
    /// Accepting the new value here would flip the label while leaving the stock
    /// costed by the old method, which is the "behaviour invented for a value"
    /// that `ADR-012` §7 forbids.
    ///
    /// Passing the *current* method is still allowed, because the edit dialog
    /// round-trips every editable field and refusing an unchanged value would
    /// make renaming a department depend on which tab the operator used.
    CostMethodChangeRequiresSwitch,
}

impl DepartmentError {
    /// Stable machine code, cross-checked against the frontend's Arabic message
    /// table by the architecture suite in both directions.
    pub fn code(&self) -> &'static str {
        match self {
            DepartmentError::NotFound => "DEPARTMENT_NOT_FOUND",
            DepartmentError::NameRequired => "DEPARTMENT_NAME_REQUIRED",
            DepartmentError::IsArchived => "DEPARTMENT_IS_ARCHIVED",
            DepartmentError::NotArchived => "DEPARTMENT_NOT_ARCHIVED",
            DepartmentError::VatRateRequired => "VAT_RATE_REQUIRED",
            DepartmentError::VatRateNegative => "VAT_RATE_NEGATIVE",
            DepartmentError::ArchiveStateInconsistent => "DEPARTMENT_ARCHIVE_STATE_INCONSISTENT",
            DepartmentError::CostMethodChangeRequiresSwitch => {
                "DEPARTMENT_COST_METHOD_REQUIRES_SWITCH"
            }
        }
    }
}

impl fmt::Display for DepartmentError {
    /// Developer-facing only. The operator reads the Arabic message the frontend
    /// holds, indexed by `code()`; `spec:127` keeps user-facing text out of Rust.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DepartmentError::NotFound => write!(f, "no department with this id"),
            DepartmentError::NameRequired => write!(f, "department name is required"),
            DepartmentError::IsArchived => write!(f, "department is archived"),
            DepartmentError::NotArchived => {
                write!(f, "department is already active; there is nothing to restore")
            }
            DepartmentError::VatRateRequired => {
                write!(f, "enabling VAT requires a rate")
            }
            DepartmentError::VatRateNegative => write!(f, "a VAT rate cannot be negative"),
            DepartmentError::ArchiveStateInconsistent => {
                write!(f, "department status and archive timestamp disagree")
            }
            DepartmentError::CostMethodChangeRequiresSwitch => write!(
                f,
                "changing the costing method needs the dedicated switch operation"
            ),
        }
    }
}

impl std::error::Error for DepartmentError {}