# Product

<!-- impeccable:product-schema 1 -->

> Design-facing product record for UI work (written for the `impeccable` design skill, 2026-10-16).
> The plan of record is [`docs/PLAN.md`](docs/PLAN.md) + [`ADR-016`](docs/decisions/ADR-016-owner-plan-2026-10-16.md). If anything here differs from the plan, the plan wins.

## Platform

web

## Users

- **Primary:** the seller at the counter of one mobile-phone shop in Cairo, Egypt — the owner or one of his one or two sellers. Windows PC with keyboard and mouse; no barcode scanner yet.
- **Only staff look at the screen.** Customers do not see it (owner, 2026-10-16).
- **The job:** ring up a sale while the customer waits — accessories, phones (IMEI optional), recharge cards, wallet transfers and bills, repair intake and delivery — then close the shift.
- **The owner also reads the day** (sales, profit, who sold what) on the desktop and on his Android phone over the shop Wi-Fi.

## Product Purpose

A fast, simple point of sale for a mobile-phone shop. The desktop is the till and the single source of truth and sells with no internet; the Android phone is a connected helper (live sales, price and stock lookup, camera scanner).

Success is measured at the counter:
- accessory ≤ 5 s; phone with IMEI and receipt ≤ 15 s; wallet transfer ≤ 8 s; repair intake ≤ 60 s; shift close ≤ 3 min;
- a real working day with zero difference in the drawer and the stock.

## Positioning

Built around how an Egyptian phone shop actually works, in its own language: phones with optional IMEI, wallets (Vodafone Cash, InstaPay and others) with a commission typed per transaction, recharge cards and bills in the same counter flow, receipts on WhatsApp with no printer, and no dependence on the internet.

## Operating Context

- One sales screen: search, category chips, product tiles, cart, pay, and a services button; several invoices can stay open («انتظار»).
- Keyboard first: `Enter`, `/` search, `F2` quantity, `F3` discount, `F4` customer, `F8` انتظار, `F9` services, `F12` pay, `Ctrl+L` lock.
- A PIN on every user switch; the open invoice stays.
- Receipts go on WhatsApp (receipt image + message). A thermal printer is optional later.
- Screens from 1366×768 up to 1920×1080.
- Arabic, right to left, Egyptian colloquial copy. Mixed-direction strings are everywhere: IMEI, phone numbers, English model names.

## Capabilities and Constraints

- **Layout is agreed** (owner: «زي ماهي في html»). The visual redesign changes **the look only** — colours, type, buttons, spacing. Positions, steps and shortcuts stay (owner, 2026-10-16).
- Light and dark themes with a toggle. Shop name, logo, accent colour, font, text size and digits (Latin or Arabic-Indic) are adjustable in settings.
- Optional product images (192 px).
- A sales screen («المبيعات»): day by day or a range, filtered by product, category, seller and payment, viewed by invoice, product or category; sellers see only their own sales (owner request, 2026-10-16).
- Manual shortages next to the system's reorder suggestions, also addable from the sales search (owner request, 2026-10-16).
- Terminology: «انتظار» (hold), «آجل» (credit), «بيّاع» (seller).
- The mockup must keep working as one offline HTML file; fonts are self-hosted. The real app is a Tauri desktop app (Vue).
- Touch targets ≥ 44 px.

## Brand Commitments

- The owner picks the logo and the colours himself in settings (owner, 2026-10-16: «بالنسبة للوجو والألوان هختارها من الإعدادات»). Every look must work with any colour he picks.
- Two visual looks, switchable in settings: «لافتة الشارع» and «علبة الموبايل» (owner, 2026-10-16). The visual system is in [`DESIGN.md`](DESIGN.md).
- The visual result must be neither crowded with colour nor dull (owner, 2026-10-16).
- Voice: Egyptian colloquial Arabic — short, plain verbs.

## Evidence on Hand

- Mockup v1.2 in `docs/ui/mockup-v1/` — the incumbent look (evidence, not authority, for the redesign).
- All products, customers, wallets and numbers in the mockup are demo data. No real shop data and no real product photos; the logo comes from settings. Do not invent shop facts.

## Product Principles

1. Seconds at the counter decide every screen.
2. The seller is the only viewer: density and scanability come before presentation.
3. Calm, but with character — not loud, not dull.
4. Arabic-first and Egyptian: the shop's words, numbers, wallets and habits are native, not translated.
5. Works without internet and without a printer.

## Accessibility & Inclusion

- Body text contrast ≥ 4.5:1; visible keyboard focus; targets ≥ 44 px.
- A larger text size and Arabic-Indic digits are options in settings.
