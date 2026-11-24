# Product Identity Catalog — Implementation Plan

**Status:** approved by the Product Owner 2026-10-03. Implementation authorised.
**Governing:** `docs/decisions/ADR-008-v1-local-first-platform-scope.md` ·
`ADR-009-uuid-v7-and-os-secure-session-storage.md` ·
`ADR-010-currency-egp-and-minor-unit.md`
**Spec:** `docs/superpowers/specs/2026-09-28-mobile-shop-system.md`
**Parent plan:** `docs/superpowers/plans/2026-09-28-mobile-shop-system.md` — task 3.1
**Precedes:** the Identity slice, whose boundaries this slice copies unchanged.

---

## 1. Scope

**In:** product create · read · update · archive · typed-barcode lookup.

**Out:** categories · images · wholesale price · purchase cost · stock movements ·
serialized units · barcode generation, printing and scanning · sales-role product
reads · user CRUD.

## 2. Decisions this slice implements

Recorded here because they are decisions, not implementation detail.

| # | Decision | Choice |
|---|---|---|
| D1 | Disposition recorded now | Yes — a column, so existing products are never reclassified |
| D2 | Disposition values | `quantity` \| `serialized` |
| D3 | One barcode per product | Nullable `UNIQUE` column; no `barcodes` table |
| D4 | Typed/pasted barcode lookup | In scope |
| D5 | Price | `sale_price_minor` only; cost deferred |
| D6 | Categories | Out of this slice |
| D7 | Archive | `status`: `active` \| `archived` |
| D8 | Foreign keys, name uniqueness | `ON DELETE RESTRICT`; names are **not** unique |
| Q | Sale price at creation | **Optional / nullable** |

### 2.1 Why the price is nullable

Product identity and product pricing are separate concerns. A phone can be
entered into the catalogue before its selling price is known.

```text
Samsung A07 · quantity · barcode 123456789 · sale price: not set · active
```

and later:

```text
sale_price_minor = 450000
```

**`NULL` means "not set". `0` means "genuinely free".** These are different
facts and the schema must not collapse them. Forcing `0` for an unknown price
would assert that the item costs nothing, which is a false statement about the
shop's pricing.

**Enforcing a price before sale belongs to `pos-sales`**, not to the catalogue
(`spec:31`). The catalogue's only rule is that an unset price is a legitimate
state.

### 2.2 Consequences of D1 worth recording

`disposition` is currently **inert**. This slice creates no `stock_movements`,
no `serialized_units` and no opening-balance rule, so nothing yet enforces the
recorded value. It states intent. A later reader must not assume tracking
exists.

## 3. Domain — `src-tauri/src/domain/catalog/`

```text
ProductId      newtype over Uuid (v7)          ADR-009
ProductName    validated, non-empty after trim
Barcode        optional; non-empty after trim; no symbology validation
Disposition    enum { Quantity, Serialized }   D2
ProductStatus  enum { Active, Archived }       D7
SalePrice      newtype over i64, non-negative; Option<SalePrice> for "not set"
Product        { id, name, disposition, barcode, sale_price, status,
                  created_by, updated_by, created_at, updated_at }
```

**`SalePrice` is load-bearing.** A newtype means a bare `i64` cannot be passed
where a price belongs, and it names the unit — piastres per ADR-010. That makes
the currency decision structural rather than documentary. `Option<SalePrice>`
is what preserves the `NULL` versus `0` distinction: `None` is not set,
`Some(SalePrice(0))` is free.

Decimal places stay derived from the single currency constant and are never
stored per field.

**Rules as pure functions:**

- `ProductName::new` trims, rejects empty
- `Barcode::new` trims, rejects empty; `Option<Barcode>` for absent
- `SalePrice::new_minor` rejects negatives
- `ProductStatus` transitions: `Active -> Archived` and `Archived -> Active`
  both permitted; an archived product is read-only apart from that transition

The domain references no `tauri`, `sqlx`, `SqlitePool` or `keyring`. An existing
architecture test enforces this and fails the build on violation.

## 4. Repositories — `src-tauri/src/data/repositories/catalog/`

`ProductRepository`: `insert` · `find_by_id` · `find_by_barcode` · `list` (by
status) · `update` · `set_status`

Functions take `&mut SqliteConnection`, as in the identity repositories, so the
same code serves a pooled call and a call inside a transaction.

## 5. Services — `src-tauri/src/services/catalog/`

`create_product` · `get_product` · `list_products` · `update_product` ·
`archive_product` · `reactivate_product` · `find_by_barcode`

**`created_by` and `updated_by` come from the resolved `Session`, never from a
parameter.** This is forced, not chosen: an architecture test forbids commands
from accepting a user id, and `spec:177` requires every operation to be
attributed to the executing user.

## 6. Commands — `src-tauri/src/commands/catalog/`

`create_product` · `get_product` · `list_products` · `update_product` ·
`archive_product` · `reactivate_product` · `find_product_by_barcode`

Every command resolves the session and calls
`session.authorize(Permission::ManageCatalog)`. That permission already exists
and is already role-gated, so a sales user is refused with no new permission
type and no change to the identity slice.

No command accepts a token, a user id or a role. No `executeSql`. Errors are
returned as stable codes, never prose.

## 7. Migration `0002_catalog.sql`

```sql
CREATE TABLE products (
    id               TEXT    PRIMARY KEY NOT NULL,
    name             TEXT    NOT NULL,
    disposition      TEXT    NOT NULL CHECK (disposition IN ('quantity', 'serialized')),
    barcode          TEXT    UNIQUE,
    sale_price_minor INTEGER CHECK (sale_price_minor IS NULL OR sale_price_minor >= 0),
    status           TEXT    NOT NULL CHECK (status IN ('active', 'archived')),
    created_by       TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    updated_by       TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_products_status      ON products (status);
CREATE INDEX idx_products_disposition ON products (disposition);
CREATE INDEX idx_products_created_by  ON products (created_by);
```

Forward-only. No `Down` script: `plan:143` fixes the recovery model as restore
a backup then fix forward.

Four deliberate choices:

- `CHECK` constraints mirror the identity migration, so the enums are enforced
  by storage and not only by Rust.
- `ON DELETE RESTRICT` per D8. Losing the attribution of a product is worse
  than blocking a user deletion, and V1 has no user deletion anyway.
- **No barcode format validation.** Accepting only digits would require
  symbology knowledge, which belongs to the still-blocked barcode decision.
  Any non-empty trimmed string is accepted.
- No cost, no wholesale, no synchronisation table.

## 8. Error codes and Arabic

New codes: `PRODUCT_NOT_FOUND` · `BARCODE_ALREADY_EXISTS` ·
`PRODUCT_NAME_REQUIRED` · `PRODUCT_IS_ARCHIVED`.

Each needs an Arabic message in `src/api/errors.ts`. The existing drift-guard
architecture test fails the build when a code has no message, so this is
enforced rather than remembered.

The login enumeration defence is unaffected; it is a login concern.

## 9. Tests

**Unit, domain only:** name trimming and rejection · barcode optional and
empty-rejected · `SalePrice` rejects negatives · `None` and `Some(0)` are
distinct · status transitions including re-activation · UUID v7 ordering.

**Integration, real SQLite:**

- a duplicate barcode is **rejected** (`plan:167`)
- **several products with a `NULL` barcode are permitted** — this proves the
  SQLite `UNIQUE`-with-`NULL` behaviour the schema depends on, instead of
  assuming it
- **`NULL` price and `0` price are distinguishable** after a round trip
- a sales session is refused on every product command
- `created_by` equals the session's user and cannot be supplied by the caller
- archived products are excluded from the default listing but still retrievable
  by id
- an archived product rejects edits; re-activation restores it
- `ON DELETE RESTRICT` actually blocks deleting a referenced user
- a barcode lookup finds exactly one product, and an unknown barcode returns
  `PRODUCT_NOT_FOUND`

**Architecture:** the product domain names no infrastructure · commands accept no
token, role or user · no cost, wholesale or synchronisation column exists.

> The existing `no_price_cost_or_sync_table_exists_yet` test currently forbids
> **any** price column. It must be narrowed deliberately to forbid `cost` and
> `wholesale` while permitting `sale_price_minor`, rather than deleted.

## 10. Frontend

`src/api/catalog.ts` — named commands, no token. Product list with a status
filter, a create form, an edit form, an archive action, and a typed-barcode
search field. Arabic, minimal styling; visual design stays deferred.

## 11. Sequence

Dependencies → migration → domain and unit tests → repositories → services →
commands → frontend → tests → verification.

Verification: `cargo test` · `npm run typecheck` · `npm run build`, then a stop
for review before any Android build or device verification.

## 12. Open items this slice does not resolve

| # | Item | Why it stays open |
|---|---|---|
| 1 | Wholesale price field | Not covered by D5's rounding rationale. A shop selling both retail and wholesale will need it |
| 2 | `disposition` is unenforced | No tracking exists yet |
| 3 | Name maximum length | Only non-empty is enforced |
| 4 | Barcode symbology validation | Belongs to the blocked barcode decision |
| 5 | Sales-role product reads | Belongs to `pos-sales` (`spec:31`) |
| 6 | Categories | Deferred by D6 |
| 7 | Images | `spec:192-193, 220` settled the storage rule; file lifecycle is not in this slice |
| 8 | Requiring a price before sale | Belongs to `pos-sales` |
