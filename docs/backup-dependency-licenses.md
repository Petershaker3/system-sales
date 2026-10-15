# Backup slice — dependencies and licences

**Recorded:** 2026-10-14.
**Scope:** the crates this change adds, plus a licence scan of the whole resolved
tree.
**Decision:** `ADR-003`.

`ADR-003:17` requires the crypto and KDF libraries to be chosen before
implementation and their licences reviewed. This file is that review's evidence.
Re-run it after any dependency change; the commands are at the bottom.

## 1. Direct additions

Two crates are declared directly in `src-tauri/Cargo.toml` for this slice.

| Crate | Version (pinned) | Declared licence |
|---|---|---|
| `chacha20poly1305` | `0.11.0` | `Apache-2.0 OR MIT` |
| `zeroize` | `1.9.0` | `Apache-2.0 OR MIT` |

`chacha20poly1305` is built with `default-features = false, features = ["alloc"]`.
That drops the crate's own RNG and its `std`/`getrandom` path, so nonces and
salts come from the project's single `getrandom` route (already used by the
identity slice), and it keeps the one-shot `Aead::encrypt`/`decrypt` helpers used
for the payload. It is pure Rust: no OpenSSL, so nothing native is added to the
already-fragile Android cross-build.

`zeroize` bounds the lifetime of the derived key and the copied password bytes.

Already-present direct dependencies that the slice also uses, unchanged:
`argon2` `0.6.0`, `sha2` `0.11.0`, `getrandom` `0.4.3`, `sqlx` `0.9.0`
(all `MIT OR Apache-2.0`).

## 2. Crates newly resolved for this change

`chacha20poly1305 0.11.0` pulls its own stack. These versions appear in
`Cargo.lock` only because of this change:

| Crate | Version | Declared licence |
|---|---|---|
| `aead` | 0.6.1 | `MIT OR Apache-2.0` |
| `cipher` | 0.5.2 | `MIT OR Apache-2.0` |
| `poly1305` | 0.9.1 | `Apache-2.0 OR MIT` |
| `chacha20` | 0.10.2 | `MIT OR Apache-2.0` |
| `universal-hash` | 0.6.1 | `MIT OR Apache-2.0` |
| `inout` | 0.2.3 | `MIT OR Apache-2.0` |
| `crypto-common` | 0.2.2 | `MIT OR Apache-2.0` |
| `hybrid-array` | 0.4.15 | `MIT OR Apache-2.0` |

All eight are `Apache-2.0 OR MIT` / `MIT OR Apache-2.0`. `subtle` (BSD-3-Clause)
is used for constant-time comparison inside these crates; it was already in the
tree from the identity slice and is not a new addition.

Note on `crypto-common`: two versions now resolve — `0.1.7` (pre-existing, used
by other crates) and `0.2.2` (new, used by `aead 0.6`). Both are
`MIT OR Apache-2.0`.

## 3. Whole-tree licence scan

The full resolved tree is the relevant surface: a licence obligation on any
transitive crate is an obligation on the shipped binary.

- Resolved packages in `Cargo.lock`: **484**.
- Licence field read from the registry source: **483** (the one not read is
  `mobile-shop-system 0.1.0`, this workspace crate).

Tally by declared licence:

| Count | Licence |
|---|---|
| 241 | MIT OR Apache-2.0 |
| 105 | MIT |
| 39 | Apache-2.0 OR MIT |
| 18 | Unicode-3.0 |
| 17 | Zlib OR Apache-2.0 OR MIT |
| 15 | MIT/Apache-2.0 |
| 9 | Unlicense OR MIT |
| 5 | MPL-2.0 |
| 5 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| 4 | Apache-2.0/MIT |
| 2 each | BSD-3-Clause; `BSD-3-Clause OR MIT OR Apache-2.0`; `MIT OR Zlib OR Apache-2.0`; `MIT OR Apache-2.0 OR LGPL-2.1-or-later`; `Unlicense/MIT`; `Zlib`; `Apache-2.0` |
| 1 each | the remaining singleton strings in the tally (e.g. `(MIT OR Apache-2.0) AND Unicode-3.0`, `0BSD OR MIT OR Apache-2.0`, `CC0-1.0 OR MIT-0 OR Apache-2.0`, `ISC`, `Apache-2.0 OR BSL-1.0 OR MIT`, `Apache-2.0 AND MIT`, `BSD-3-Clause AND MIT`, `BSD-3-Clause/MIT`, `MIT OR Apache-2.0 OR Zlib`) |

**No crate offers only a copyleft licence.** The strings that mention a copyleft
licence are alternatives, and a permissive option is always available:

- `r-efi 5.3.0` / `6.0.0` — `MIT OR Apache-2.0 OR LGPL-2.1-or-later`; we take
  MIT/Apache-2.0.
- `MPL-2.0` (5 crates: `cssparser`, `cssparser-macros`, `dtoa-short`,
  `option-ext`, `selectors`) — file-level copyleft, no source-disclosure duty
  for an unmodified binary. All five arrive through Tauri's HTML/CSS stack, not
  through this slice, and were in the tree before this change.

No GPL, AGPL or SSPL appears anywhere in the tree.

## 4. How to reproduce

Regenerate the resolved-version facts from the lockfile, and the licence facts
from the registry sources (adjust the registry hash to your machine):

```powershell
$src = "$env:USERPROFILE\.cargo\registry\src\<registry-hash>"
$lock = "src-tauri\Cargo.lock"
$text = Get-Content $lock -Raw
$pkgs = [regex]::Matches($text, 'name = "([^"]+)"\r?\nversion = "([^"]+)"')
foreach ($m in $pkgs) {
  $n = $m.Groups[1].Value; $v = $m.Groups[2].Value
  $p = Join-Path $src "$n-$v\Cargo.toml"
  if (Test-Path $p) {
    $l = (Select-String -Path $p -Pattern '^\s*license\s*=\s*"([^"]+)"' | Select-Object -First 1)
    if ($l) { "{0} {1}  {2}" -f $n, $v, $l.Matches[0].Groups[1].Value }
  }
}
```

A `cargo license`-style tool gives the same answer with less scripting; the
manual scan above is recorded because it needs no extra tool installed.
