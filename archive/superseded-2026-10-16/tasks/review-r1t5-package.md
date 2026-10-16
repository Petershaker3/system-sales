# R1-T5 read-only review package — gated recovery panel

Prepared for review only. Nothing here was committed; no APK, no ADB, no device,
no data or credential change. HEAD `7c8506a`, all prior uncommitted work intact.

## 1. What is T5 and what is not

The working tree contains two unrelated bodies of uncommitted work. They are
separated below so the reviewer reads only T5.

**Prior work, NOT part of T5** (already present before this task, unchanged by
it): the stock/costing slice — `src/components/StockPanel.vue`,
`src/api/inventory.ts`, the `StockPanel` import and mount in `src/App.vue`, the
`STOCK_*` error-code additions in `src/api/errors.ts`, the `DepartmentsPanel.vue`
change, and the `rust_error_codes()` edit in the architecture suite.

**T5 only — new files (3):**
- `src/api/recovery.ts`
- `src/components/RecoveryPanel.vue`
- `src/vite-env.d.ts`

**T5 only — modified files (2):**
- `src/App.vue` — three edits, listed exactly in §2.
- `src-tauri/tests/architecture/main.rs` — four appended tests, §3.

**T5 does not touch:** any Rust production source, any migration, any costing or
inventory file, `package.json`, `vite.config.ts`, `tauri.conf.json`.

## 2. `src/App.vue` — the three T5 edits, verbatim

Edit 1, import line 12:
```
- import { onMounted, ref } from 'vue';
+ import { defineAsyncComponent, onMounted, ref } from 'vue';
```

Edit 2, after the `View` type (with its explanatory comment):
```ts
const RecoveryPanel =
  import.meta.env.VITE_RECOVERY === '1'
    ? defineAsyncComponent(() => import('./components/RecoveryPanel.vue'))
    : null;
```

Edit 3, at the end of the login section, after the sign-in form:
```html
<component :is="RecoveryPanel" v-if="RecoveryPanel" />
```

The `StockPanel` import and mount appear in the same file and in the same diff,
but belong to the prior stock/costing slice. They are visible in
`git diff -- src/App.vue` alongside the above and are **not** part of T5.

## 3. Architecture guards — what each one actually proves

Four guards appended to the existing suite. Honest classification, because the
review question is whether they test behaviour or spelling.

| Guard | Kind | What it proves | What it does NOT prove |
|---|---|---|---|
| `the_recovery_panel_is_mounted_only_behind_the_build_flag` | source shape | the gate exists, the import is dynamic, a `null` fallback exists, and the dot form is used | that the bundle omits the panel |
| `the_recovery_panel_opens_no_external_channel` | source shape | no intent/deep-link/URL-scheme/`open` call in the panel or its API | runtime reachability |
| `the_recovery_panel_persists_nothing_and_retries_nothing` | source shape | no web storage, no cookie, no `setTimeout` retry | runtime behaviour |
| `a_built_bundle_carries_no_recovery_call` | **behavioural, on the artifact** | the built output in `dist/` contains no recovery chunk and calls neither command | anything about a bundle that has not been built |

The first three are source-shape guards, consistent with this repository's
architecture suite, which is source-scanning throughout (`code_only`,
`command_parameters`, `impl_body` all read source text). They are a guard
against regression, not proof of the shipping property.

The fourth was added specifically because the first three would all pass while a
recovery panel sat in the bundle. It reads `dist/assets/*.js` and
`dist/index.html`, and skips with a printed note when no bundle exists
(`dist/` is gitignored). When a bundle does exist it must be a production one.

**Both failure paths were proven, not assumed:**
- injecting a `RecoveryPanel-*.js` file → `dist/assets/RecoveryPanel-FAKE.js is
  the recovery panel: the bundle on disk is a RECOVERY build` (`guard-red.log`)
- injecting the command name into a production bundle → `dist/assets/index-*.js
  calls 'stage_recovery_approval'` (`guard-red2.log`)

## 4. Reachability of the recovery calls from a production UI

Three independent reasons, weakest last:

1. **The panel cannot be mounted.** `RecoveryPanel` is `null` when the flag is
   unset, so `v-if` never renders it. Measured: the production bundle contains no
   `RecoveryPanel` chunk, so the component is not merely unreferenced — it is not
   in the artefact.
2. **The API module cannot be reached.** `src/api/recovery.ts` is imported only by
   `RecoveryPanel.vue`. With that module dropped, the invocations are not in the
   bundle either — confirmed by the absence of both command names in production
   `dist/`.
3. **The primary control is Rust, not the frontend.** `stage_recovery_approval`
   and `execute_manager_recovery` exist only under the `recovery` cargo feature.
   In a production build they are not compiled and not registered in `lib.rs`.
   Even a hostile production bundle that somehow invoked them would get a
   missing-command error. This is why the build flag is documented in the code as
   hygiene and explicitly **not** as protection.

## 5. The one finding that changed the implementation

The first implementation used `import.meta.env['VITE_RECOVERY']` (bracket form,
as TypeScript's index-signature rule required). It compiled and typechecked, but
the production build **leaked the panel**: Vite does not reliably statically
replace the bracket form, so the bundler could not prove the guard false and
emitted `RecoveryPanel-*.js` (4.03 kB) into a production build.

Fixed by using the dot form, which Vite replaces statically, plus
`src/vite-env.d.ts` so the dot form typechecks without a cast. That declaration
file is the only addition beyond the three planned files; it is a type
declaration for a documented build flag, not a script and not test
infrastructure. An architecture test now fails the build if the bracket form
returns, so the leak cannot silently come back.

## 6. Measured build separation

| Build | `RecoveryPanel-*.js` | `stage_recovery_approval` | `execute_manager_recovery` |
|---|---|---|---|
| `npm run build` (default) | absent | absent | absent |
| `cmd /c "set VITE_RECOVERY=1 && npm run build"` | present | present | present |

`dist/` was restored to a production build afterwards and carries no recovery
artefact.

## 7. Deferred to R1-T7

Scan the final production APK for recovery symbols. Bundle and `rlib` scans are
supporting evidence only; the APK is the artefact that would ship.

## 8. Out of scope, recorded

The public `verify_pattern` command is still unthrottled
(`services/pattern/mod.rs:209`). Unchanged by T5; separate review.
## 9. Verification actually executed

Both configurations, Windows MSVC host. Zero compiler warnings in both.

| Command | arch | integration | unit | failed |
|---|---|---|---|---|
| cargo test | 75 | 194 (3 ignored) | 89 | 0 |
| cargo test --features recovery | 75 | 208 (3 ignored) | 89 | 0 |

Logs: src-tauri/rev-default.log, src-tauri/rev-recovery.log.
Guard failure evidence: src-tauri/guard-red.log, src-tauri/guard-red2.log.

The architecture count rose 74 -> 75 with the artifact guard, and it ran (not
skipped) because a production bundle is present.

## 10. Final tree state

- HEAD 7c8506a, no commit created, no history rewritten.
- dist/ holds a production build; no recovery artefact.
- No APK, no ADB, no device, no data or credential change.