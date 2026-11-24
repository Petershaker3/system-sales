# DESIGN.md — Mobile Shop System UI

> The visual system of the approved mockup (`docs/ui/mockup-v1/`, v1.3), written at the end of the 2026-10-16 redesign, and extended for the screens added in v1.4 and v1.5.
> Product facts: [`PRODUCT.md`](PRODUCT.md). Plan of record: [`docs/PLAN.md`](docs/PLAN.md). How it was built and reviewed, phase by phase: [`docs/ui/REDESIGN.md`](docs/ui/REDESIGN.md).
> The source of truth for values is `docs/ui/mockup-v1/styles.css` (tokens at the top) and `accentTokens()` in `app.js`. The real app (items 1.6 and 1.13) should port these, not re-invent them. **Ported (2026-10-17):** `src/styles/*.css` (the same tokens and classes, split by area) and `accentTokens()` in `src/ui/color.ts`. Change a value in both places, then run `npm run test:unit` and `scripts/demo-smoke.mjs`.

## Principles

- **Operate surface.** The seller is mid-task with a customer waiting, and only staff see the screen. Scanability, density and familiar controls beat expression. The style lends only type, palette, density and one signature move. It never changes layout, navigation or controls.
- **The look only.** Positions, steps and shortcuts are owner-approved («زي ماهي في الـ HTML»). Visual work must not move them.
- **Not loud, not dull** (owner). One strong colour in a few deliberate places; character comes from type and the signature move.
- **Any shop colour works.** The owner picks the accent and logo in settings. Every colour that carries text is derived from the accent and checked.

## Two looks — Settings → الشكل → الطابع

| | «لافتة الشارع» `data-look="plate"` (default) | «علبة الموبايل» `data-look="box"` |
|---|---|---|
| Idea | An enamel street plate: one solid field, light lettering, a thin inset keyline | The retail phone box: white, ink, precise hairlines; the colour appears once as a band |
| Shop colour | The rail (a full-height plate) and the pay button (a second plate) | A 4px band across the top, the pay button, the current selection |
| Signature | The inset keyline (1.5px, `on-accent` at 55%, inset 5px) inside the rail and the pay button | The box sticker: IMEI on a white label with an ink border and tabular digits |
| Font | **Changa**: condensed Kufi, like sign lettering | **Vazirmatn**: precise, with regular digits |
| Radii (`--r-xs/s/m/l`) | 3 / 6 / 6 / 10 | 2 / 4 / 4 / 8 |
| Active page in the rail | Inverted: surface field, `--accent-text` text | Ink outline, accent icon |
| Dark | The plate at night: ground tinted with the shop colour | Graphite box; the sticker stays light paper |

Both looks exist in light and dark (`data-theme`), with font override (`data-font`: `auto` = the look's font) and text size (`data-scale`).

## Colour

**Strategy:** restrained. Tinted neutrals plus the shop colour; state colours only where they carry meaning.

**Semantic tokens** (per look × theme in `styles.css`): `--bg` ground · `--surface`, `--surface-2`, `--surface-3` layers · `--border`, `--border-strong` · `--text`, `--text-2`, `--muted` · `--ok`, `--warn`, `--danger` · `--shadow` (overlays only) · `--c0…--c4` data series (5 shades of the shop colour).

**Accent engine** (`accentTokens()` in `app.js`, run by `applySettings()`):

| Token | Use | Rule |
|---|---|---|
| `--accent` | The owner's raw colour | Only for light tints of neutrals |
| `--accent-fill` | Backgrounds that carry text (pay, chips, plates, selection) | Kept as chosen if white or ink text reaches 4.5:1; otherwise darkened just enough |
| `--on-accent` | Text on `--accent-fill` | White or ink, whichever contrasts more |
| `--accent-text` | The shop colour used as text, borders and the focus ring | Moved toward black (light) or white (dark) until ≥ 4.5:1 on every ground and on the selection tint |
| `--accent-weak` | Selection tint | Mixed from `--accent-text` (not the raw colour), so it stays visible for near-white or near-black colours |
| `--muted` | Secondary text | The look's value, adjusted to ≥ 4.5:1 on every ground and the tint (light colours brighten dark surfaces) |

Contrast is tested **after rounding** to hex. Coloured buttons and chips get a border in `--accent-text`, so they stay visible when the accent is close to the background. On the plate rail the focus ring uses `--on-accent`.

## Type

- One family per look (Changa / Vazirmatn), self-hosted woff2 (Arabic + Latin subsets). Owner alternatives in settings: IBM Plex Sans Arabic, Cairo, Tajawal, Readex Pro.
- Base 15px (17px in «كبير»). **Floor 12px** (`.8rem`), no smaller text anywhere.
- Heading roles, each step 1.25×: page title `h1` 1.5rem · windows and page sections `h2` 1.2rem · card titles `h3` 0.96rem bold. Window titles are `h2` with the detail as a small line below. **No icon before a heading.**
- Money and counts use tabular figures. IMEI and phone numbers are monospace, LTR in `<bdi>`, last four digits bold.

## Space, shape, depth

- Spacing on a 4px base; tight inside groups, generous between them.
- Three radius steps per look; switches stay pills; circles only for avatars and dots.
- **No shadows on page surfaces** (tiles, cards, tickets). Only overlays (windows, menus, toasts, the lock card) get `--shadow`.
- Separation by hairlines and ground/surface contrast, not boxes inside boxes.

## Components (summary)

- **Top bar:** page `h1`, shop name after a hairline, status as quiet text separated by hairlines (no pills).
- **Tiles:** flat surface, 1px border, small muted icon (no tinted square), price bold, stock muted (`warn` when low).
- **Cart lines:** hairline-separated rows; selected row = `--accent-weak`; details as quiet text; only the IMEI is boxed (sticker in box, label in plate).
- **Category chips:** rectangles; active = `--accent-fill`; count is a plain muted number.
- **Keycaps:** flat, 1px border; arrow keys drawn as icons (fonts may lack the glyphs).
- **Reports:** KPIs as one hairline-divided strip; today's bar in `--accent-fill`, other days a light shade.
- **Repairs:** columns are headers with a rule, not cards; status is the column (no coloured side borders); delivered tickets use a quieter ground, never opacity.
- **Receipt preview:** white paper with dashed tear lines top and bottom (it stands for the WhatsApp receipt image).
- **Toasts:** ink box in light themes, layered surface in dark; beside an open window, never over its text.
- **Sales screen:** day navigator (older on the right, newer on the left, as Arabic reads) with the native date picker under the label, and quick ranges; one filter row; the totals strip; three views as a segmented control. With a product or category filter the amounts are for the matching lines, and the screen says so.
- **Sales screen, months (v1.5):** a «اختار شهر» list beside the quick ranges (a jump menu: it always reads «اختار شهر», the title says where you are, the shown month is marked «المعروض» inside); month arrows; a «الأيام» view with one row per day, the best day tagged, a share bar relative to the best day, and a click that opens the day.
- **Month report (v1.5):** tabs «النهارده | الشهر» in the page head. KPIs strip with up to two change lines (vs last month, vs the same month last year). An evaluation card: a verdict line (icon + bold sentence + a muted basis line), then one row per observation with a fixed-width tag column («كويس» = `ok`, «خلي بالك» = `warn`, «معلومة» = neutral). Daily bars for the whole month: days still to come are dashed empty ghosts, the best day is `--accent-fill` with its value, the other values live in the bar's title; every bar is a button that opens that day. Twelve-month bars with the live month's projection as a dashed segment on top, and a table under them. Tables show change as arrow + %, zero muted without an arrow, and a huge change on a tiny base as a multiple («×79»).
- **Receiving window (v1.5):** a wide modal: supplier (with suggestions) beside the product search, results as the sales-search rows, then a table with inline number inputs (count, unit cost for the owner) and the cost after receiving. A phone line has an IMEI row on `--surface-2`: the scan box, «امسح بالموبايل», the count «2 من 2 بالـ IMEI», an inline error, and IMEI chips with a remove button. The footer sums pieces and cost; closing with unsaved lines warns first.
- **New item (v1.6):** a 780px modal over the receiving window. Step one: three kind buttons (icon tile, title, one-line description, `1/2/3` keys). Step two: labelled rows; choices as chips (brand, storage, RAM, colour, grade), a dashed «+» chip opens an inline add; free values as tags inside one bordered field (Enter or comma adds, suggestions under it); a muted name preview line; a variants table with compact inputs (barcode, quantity, cost, price; empty = the value above). Enter on a chip presses it; the first Esc with typed data only warns.
- **Variant picker (v1.6):** a family is one sale tile with a «N أنواع» corner tag; the picker is a grid of variant buttons (label, price, stock); a sold-out variant is dashed and disabled, never dimmed by opacity. Arrows + Enter.
- **Empty shop (v1.6):** the store opens on a first-day card (three kind cards, three numbered steps); empty tables say so in a muted row; a dashed «محل فاضي للتجربة» status in the top bar leads to settings.
- **Wallets (v1.6):** cards with the balance as the largest figure, a 6px meter towards the maximum (state colour from `--ok/--warn/--danger`, a 2px marker at the minimum), the shop's number in mono, today's line. A period segment, a per-wallet table with a totals row, and a log with signed wallet and drawer movements; a cancelled row is struck through with its reason as a danger tag. The deposit/withdraw segment carries a one-line description of the money flow under each label; a withdrawal shows the shop's number large on `--accent-weak`. Settings rows are divided by lines inside the card, never cards in a card.
- **Shortages:** an add row with labelled fields (quantity, note, waiting customer) and inventory matches under the name; the list with a «ناقص / اتطلب» segment and «وصل»; suggestions with a suggested quantity.
- **Motion:** 150–250ms state changes only; `prefers-reduced-motion` turns animation off.

## Writing

- Egyptian colloquial, plain verbs, the shop's own words («انتظار»، «آجل»، «بيّاع»، «المخزن»). Owner's replacements: «انتظار» not «تعليق» (round 2), **«المخزن» not «المخزون»** (2026-10-17). `tools/unit.mjs` fails if a replaced word comes back in any mockup file.
- **No joins with « · » or « — ».** Two ideas = two sentences; a detail = «،» or a subtitle line; a list = «و».
- Errors say what happened and how to fix it: «الرقم ده مش IMEI صحيح: رقم المراجعة غلط. راجع الرقم».
- An action keeps its name through the flow (the button «ادفع» → the screen «تم البيع»).
- **Counts agree with the number** (`pcsWord`): «قطعة»، «قطعتين»، «5 قطع»، «12 قطعة».
- **Short figures over bars** are words, not «k»: «2.37 مليون»، «171.5 ألف».
- **Payment split:** at most 5 parts, the shades `--c0`…`--c4`; more methods fold their smallest into «تاني» (`paySplit`).
- **Comparisons say against what:** «عن امبارح لنفس الساعة»، «عن نفس الوقت من سبتمبر»، «عن أكتوبر 2025». A category inside a sentence goes in «» («مبيعات «مستعمل» قلّت 28%»).
- **The evaluation states facts from the figures, never opinions,** and gives the reason only when the figures show it («لأن الموبايلات بقت 87% من المبيعات»).

## Do not (from the skills used)

Default palettes (Tailwind blue, slate greys) · identical rounded cards with soft shadows · one radius on everything · coloured side borders on cards, tickets or alerts · zero-offset glows (focus included) · gradient decoration · icon before every heading · eyebrow labels · emoji or Unicode glyphs as icons · opacity to show "done" · pill inside a pill · text under 12px · light or dark chosen by category instead of the scene.

## Verification

- `tools/qa.mjs`: 222 behaviour checks (v1.6), including contrast with 6 hard shop colours × 2 looks × 2 themes, visible focus on the plate rail, the payment split bar, overflow in both looks, migration of old settings.
- `tools/snapshots.mjs` + `tools/detect-snapshots.sh`: 24 screens × 2 looks × 2 themes through the `impeccable` detector. Result at v1.5: **0 findings** on 96 snapshots (the old design had 323 per look on its 17 screens). At v1.5 it caught dimmed day numbers (opacity, 2.4:1) under the month chart; they now keep the muted colour. At v1.6: **0 findings on 124 snapshots** (31 screens); it caught wallet boxes nested as cards in the settings card and a squeezed button, both fixed.
- Rasters: everything in `screens/` is a screenshot of the mockup itself made by `tools/final.mjs`. No generated imagery ships with the mockup.
