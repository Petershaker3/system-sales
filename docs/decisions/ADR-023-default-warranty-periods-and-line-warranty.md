# ADR-023 — Default Warranty Periods and Sale Line Warranty Dates (Plan Item 1.8)

- **Date:** 2026-10-18
- **Status:** Accepted
- **Scope:** Phase 1, Item 1.8 (`docs/PLAN.md` §16, §19; `ADR-016` #16, #31; `docs/ui/mockup-v1/pos.js` & `views/settings.js`)

## 1. Context

`docs/PLAN.md` §16 and §19 (Item 1.8) specify:
1. **Configurable default warranty periods in Settings:**
   - **New phones (`موبايل جديد`):** default `12` months, configurable in Settings.
   - **Used phones (`موبايل مستعمل`):** default `1` month, configurable in Settings per owner instruction («بس المستعمل مدته في الاعدادات احددها»).
   - **Counted items / accessories (`إكسسوار / بالعدد`):** default `0` months (no warranty), configurable in Settings.
   - **Receipt footer (`ذيل الإيصال`):** already configurable in Settings (`ui.receipt_footer`, `ADR-022`).
2. **Automatic population & per-line editing on the POS sales screen:**
   - Adding a product to an invoice automatically assigns its default warranty months based on its category kind (`phone` → `ui.warranty_new`, `used` → `ui.warranty_used`, `item` → `ui.warranty_item`).
   - Each cart line displays its warranty badge (or a subtle `+ ضمان` button when `0` months) and allows the seller to adjust the warranty months (`0..60` months) for that specific sale line before payment.
3. **Persistence on `sale_lines` (`warranty_start` and `warranty_end`):**
   - Migration `0013_warranty.sql` already defines `warranty_start TEXT NULL` and `warranty_end TEXT NULL` (`YYYY-MM-DD`) on `sale_lines` with triggers enforcing `warranty_end >= warranty_start`.
   - When a sale is recorded (`PayModal` or «كاش بالظبط»), any line with `warrantyMonths > 0` computes `warranty_start = YYYY-MM-DD` (sale date) and `warranty_end = YYYY-MM-DD` (`sale_date + warrantyMonths` calendar months) and persists both columns in `sale_lines`. Lines with `warrantyMonths == 0` persist `NULL` for both columns.
   - No new SQLite migration is required.

## 2. Backend Changes (`src-tauri`)

### 2.1 `Appearance` Keys (`app_settings`, `Permission::ManageCatalog`)

We extend `AppearanceKey` (`src-tauri/src/domain/settings/appearance.rs`, `ALL: [AppearanceKey; 21]`), `services/settings/appearance.rs`, and `AppearanceDto` (`src-tauri/src/commands/settings.rs`) with three keys:
- `ui.warranty_new` (`WarrantyNew`, default `"12"`): integer months `0..=60`.
- `ui.warranty_used` (`WarrantyUsed`, default `"1"`): integer months `0..=60`.
- `ui.warranty_item` (`WarrantyItem`, default `"0"`): integer months `0..=60`.

All three keys return `true` from `AppearanceKey::is_catalog_choice`, so only the owner (`Permission::ManageCatalog`) can update them, while any signed-in seller reads them via `read_appearance`.

## 3. Frontend Changes (`src/`)

1. **`src/screens/pos/warranty.ts` & `src/screens/pos/warranty.test.ts`:**
   - Pure helpers for resolving default warranty months by product/category kind (`defaultWarrantyMonths`), computing ISO `YYYY-MM-DD` start/end dates (`warrantyDatesForMonths`, `toIsoCalendarDate`), and formatting warranty labels.
2. **`src/screens/pos/cart.ts` & `src/screens/pos/WarrantyModal.vue`:**
   - `CartLine` carries `warrantyMonths?: number`.
   - `cart.setLineWarranty(state, lineIndex, months)` updates the line's warranty months (`0..60`).
   - `WarrantyModal.vue` lets the seller pick from quick chips (`بدون ضمان`, `شهر`, `3 شهور`, `6 شهور`, `سنة (12 شهر)`, `سنتين (24 شهر)`) or type a custom number of months (`0..60`), showing the exact end date.
3. **`src/screens/settings/ReceiptSettingsCard.vue`:**
   - Adds the **«الضمان الافتراضي»** section with inputs and quick chips for:
     - `موبايل جديد (شهور)` (`#set-warrantyNew`)
     - `موبايل مستعمل (شهور)` (`#set-warrantyUsed`)
     - `إكسسوار / بالعدد (شهور)` (`#set-warrantyItem`)
   - Live `<ReceiptPreview>` in Settings immediately reflects changes to `warrantyNew`.
4. **`src/screens/pos/PosScreen.vue` & `src/screens/pos/PayModal.vue`:**
   - Both `PayModal.vue` and «كاش بالظبط» pass `warrantyStart` and `warrantyEnd` to `salesApi.recordSale`, and `ReceiptPreview` / WhatsApp message template use the line's actual `warrantyMonths`.
