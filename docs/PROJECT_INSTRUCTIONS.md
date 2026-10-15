# Project Instructions

Standing guidance for every contributor and agent working in this repository.
These rules are project-wide and take precedence over an individual task brief.

## 1. Product Owner Authority

The **Product Owner makes the final decision** on:

- scope
- architecture
- product behavior
- data-interoperability and reporting boundaries
- significant trade-offs

No other party — including an implementation engineer or agent — may decide these
on the Owner's behalf, and no such decision may be inferred from silence.

When an instruction from the Owner appears to conflict with a lower-level
instruction, the Owner's most recent explicit statement wins. If two Owner
statements genuinely conflict, stop and ask.

## 2. Independent New System

**Decision of record:** ADR-007 establishes that the new system is independent and
designed from first principles (docs/decisions/ADR-007-independent-new-system.md).

ADR-008 defines the V1 product scope: offline-first local POS on both Android and Windows, each with its own local SQLite; no automatic sync, no central server, and no cloud database in V1; future sync is deliberately deferred.
The new shop system is **designed and built from first principles**. The legacy
shop system is **archival material** — kept for audit and reference only.

- **No legacy source is a dependency** of the new system.
- **No legacy schema, table, column, or key** becomes the new schema.
- **No legacy business logic** — accounting, inventory, cash, reports, or workflow
  rule — becomes the new system's logic, unless the Owner explicitly approves
  reproducing a specific named behaviour for a stated reason.
- **No legacy data is migrated, imported, or converted.** There is no importer,
  no migration path, and no legacy-shaped record in the new data model.
- **No legacy report formula, KPI definition, or total** is reproduced,
  reconciled against, or calibrated with.
- Legacy archives under `dev_extracted/` and `archive/` remain **read-only** and
  are never cited as an acceptance criterion for any slice of the new system.

Required relationship:

```text
NEW SYSTEM
    ↓
Own domain model, business rules, database,
reports, accounting semantics, inventory model,
sales model, backup model, platform adapters

LEGACY SYSTEM
    ↓
Archival material — NOT a dependency,
NOT a source of truth, NOT a compatibility target,
NOT a migration requirement, NOT an architectural constraint
```

The new system must remain able to evolve for years **without** the legacy
system continuing to exist, be available, or be correct.

If a design choice can only be explained as "the legacy system worked this way",
that is **not a justification** — it is a signal to stop and ask.

### Scope priority

When effort is contested:

```text
NEW SYSTEM > OPEN PRODUCT DECISIONS > LEGACY MATERIAL
```

The legacy system is not the product and is not a requirement. The new system
is the product.

### Defining the domain from first principles

The new system answers its own questions: what a sale is, what a sale line is,
what inventory and an inventory movement are, what purchase cost and profit
mean, what a cash movement and an expense and a repair and a customer and a
supplier and a product and a barcode and a return and a backup and an audit
event are.

These definitions are written **per module**, from the new system's own
requirements. They are never copied from legacy behaviour, and a definition is
not accepted merely because it resembles an old implementation.


## 3. Decision Gate Rule

> If a discovered issue or question would require meaningful additional work, or
> could change architecture, scope, product behavior, or data interpretation,
> **STOP and ask the Product Owner before proceeding.**

These require Owner input whenever they are not already explicitly decided:

- Should we preserve this behaviour from an archived implementation?
- Should this become part of the new schema?
- Should we reproduce that rule? If yes, what is the stated reason?
- "Should this become part of the new schema?"
- "Should we reproduce this legacy behavior?"

Required response shape when hitting a gate:

1. Briefly explain what was discovered.
2. Explain why it might matter.
3. Present the available options, if relevant.
4. Ask the Owner for a decision.
5. **STOP.**

Do not resolve a gate with a default, a convenience, or a guess. Prefer
`NEEDS PRODUCT OWNER DECISION` over speculative investigation.

## 4. Evidence Classification

Every non-obvious conclusion carries one of these labels:

- **VERIFIED** — confirmed against the actual source or data, with the reference
  cited.
- **UNVERIFIED** — plausible but not yet confirmed against real behavior or data.
- **ASSUMPTION** — an unproven premise being relied upon.
- **NEEDS PRODUCT OWNER DECISION** — the answer would change scope, architecture,
  or data interpretation.

**Never silently convert an assumption into a requirement.** If code, a schema,
or a test encodes an assumption, say so out loud. Passing tests prove only that the
assumption is implemented consistently — not that it is true.

Prefer reading real code over reading documentation about that code. Prefer real
data over fixtures. A fixture that a test wrote is not evidence.

## 5. Workflow

```text
Audit
  → Report
  → Product Owner Decision
  → Implement
  → Review
  → Test
  → Document
  → STOP
```

**Do not skip decision gates.** Implementation before approval is a process
failure, not an efficiency gain.

Stop at the end of every phase and report: what was verified, what changed, test
results, and the diff. Do not continue into the next phase uninvited.

## 6. Avoid Wasted Work

- Do not investigate archived or legacy behaviour merely because it exists.
- An unknown is not automatically a research task.
- Do not optimise for completeness at the expense of the actual product goal.
- Do not preserve a structure, formula, or pattern merely because it already
works somewhere else.

## 7. Safety Rules

- Treat all data under `dev_extracted/`, `archive/`, and any real export as
  **read-only**. Never edit, normalize, or rewrite it.
- Real exports may contain credentials in plaintext. Never copy such content into
  the repository, into fixtures, or into reports. Name the risk instead.
- Never commit secrets. Never place a real export inside the repository.
- A refused or blocked change is a correct outcome. Never work around a
  refusal by weakening a check.

## 8. Reporting

- State what was verified and how, not what is believed.
- Report failing, skipped, and untested work explicitly — never imply coverage
  that does not exist.
- If a required input does not exist (for example, a reference report to
  reconcile against), say `UNVERIFIED` rather than inventing confirmation.
- Do not present an unreconciled number as validated.