# Archived legacy-project documentation

This directory preserves the handoff notes, audits, reports, and architecture
records for the previous single-file browser application. These documents are
historical context only; their architecture and workflow instructions do not
govern the new Windows and Android application.

Since 2026-10-16 the legacy **source** lives here too: it was moved with
`git mv` from the repository root (Owner: «أرشف اللي ملهوش لازمة»; see
`archive/README.md`). Release archives, diagnostic artifacts and their
distribution-warning sidecars that were never committed stay local-only, as
`.gitignore` requires. No archived document or source artifact was deleted.

Everything here is **read-only** (`docs/PROJECT_INSTRUCTIONS.md` §7) and is never a
dependency, a data source, or an acceptance criterion for the new system
(`ADR-007`).

## Contents

- `handoff/` — prior-session handoff and file index.
- `reports/` — audits, cleanup/security reports, runbooks, and backup inspection.
- `source-docs/dev/docs/` — ADRs belonging to the legacy source tree.
- `dev_extracted/` — the legacy app source (single-file HTML + 27 JS modules,
  `localStorage`), formerly `dev_extracted/` at the repository root. Moved 2026-10-16.
- `dev_phase24_rc_closed_2026-08-18_manifest.txt` — manifest of the legacy
  phase-24 release archive (the archive itself is git-ignored). Moved 2026-10-16.
- `product/` — legacy-derived Rust stack (schema, importer, migration). Never part
  of the new system; archived per `ADR-006` (executed 2026-10-16).
- `spikes/legacy-import/` — read-only legacy import probe (2026-09-28). Legacy
  import is out of scope (`ADR-007`). Moved 2026-10-16.
