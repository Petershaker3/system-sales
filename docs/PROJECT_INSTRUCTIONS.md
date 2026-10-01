# Project Instructions

Standing guidance for every contributor and agent working in this repository.
These rules are project-wide and take precedence over an individual task brief.

## 1. Product Owner Authority

The **Product Owner makes the final decision** on:

- scope
- architecture
- product behavior
- migration and reference-data boundaries
- significant trade-offs

No other party — including an implementation engineer or agent — may decide these
on the Owner's behalf, and no such decision may be inferred from silence.

When an instruction from the Owner appears to conflict with a lower-level
instruction, the Owner's most recent explicit statement wins. If two Owner
statements genuinely conflict, stop and ask.

## 2. Legacy Data Policy

The legacy shop system is **historical reference material only**.

- Legacy data is **not** being migrated into the new system.
- **No legacy schema becomes** the new operational schema.
- **No legacy operational entity is imported** — no products, customers, sales,
  invoices, repairs, wallets, payments, stock, or media.
- **No legacy business logic becomes** the new system's business logic unless the
  Owner explicitly approves reproducing it.
- Historical reference numbers **must not constrain** the architecture, data model,
  or workflows of the new system.
- The legacy system is never the source of truth for the new operational domain.

Intended relationship:

```text
Legacy System
    ↓
Historical Reference Numbers
    ↓
Read-only historical reference        (context, not a foundation)

New System
    ↓
Independent operational system
```

If a design choice can only be explained as "the legacy system worked this way",
that is a signal to stop and ask — not a justification.

### Scope priority

When effort is contested:

```text
NEW SYSTEM > HISTORICAL REFERENCE > LEGACY DETAILS
```

The legacy system is not the product. The new system is the product.

## 3. Decision Gate Rule

> If a discovered issue or question would require meaningful additional work, or
> could change architecture, scope, product behavior, or data interpretation,
> **STOP and ask the Product Owner before proceeding.**

These require Owner input whenever they are not already explicitly decided:

- "Should we investigate this legacy key?"
- "Should we support another legacy format?"
- "Should we preserve this legacy entity?"
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

- Do not investigate unrelated legacy behavior merely because it exists.
- Investigate legacy behavior **only** when it is necessary to obtain the
  historical reference numbers the Owner explicitly requested.
- An unknown is not automatically a research task.
- Do not optimize for completeness at the expense of the actual product goal.
- Do not preserve legacy structure because it already works.

## 7. Safety Rules

- Treat all data under `dev_extracted/`, `archive/`, and any legacy export as
  **read-only**. Never edit, normalize, or rewrite it.
- Real exports may contain credentials in plaintext. Never copy such content into
  the repository, into fixtures, or into reports. Name the risk instead.
- Never commit secrets. Never place a real export inside the repository.
- A refused or blocked migration is a correct outcome. Never work around a
  refusal by weakening a check.

## 8. Reporting

- State what was verified and how, not what is believed.
- Report failing, skipped, and untested work explicitly — never imply coverage
  that does not exist.
- If a required input does not exist (for example, a reference report to
  reconcile against), say `UNVERIFIED` rather than inventing confirmation.
- Do not present an unreconciled number as validated.