//! Organisation use cases: departments (SP-1b, `plan` Task 8).
//!
//! Orchestration across the department repository and the identity session. No
//! SQL here.
//!
//! Every use case follows the same three steps in order — **authorise, then
//! write inside one transaction: domain mutation → repository write → audit →
//! commit** — so a failure at any step leaves no half-recorded department and
//! no audit event for a change that did not happen.

pub mod departments;
