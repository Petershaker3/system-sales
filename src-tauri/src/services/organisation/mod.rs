//! Organisation use cases: departments (SP-1b, `plan` Task 8), and since
//! ADR-018 the category tree on the same rows.
//!
//! Orchestration across the department repository and the identity session. No
//! SQL here.
//!
//! Every use case follows the same three steps in order — **authorise, then
//! write inside one transaction: domain mutation → repository write → audit →
//! commit** — so a failure at any step leaves no half-recorded department and
//! no audit event for a change that did not happen.

/// The category tree the owner manages (ADR-018 §1), on the same rows.
pub mod categories;
pub mod departments;
