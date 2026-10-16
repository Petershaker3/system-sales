---
version: 1
slug: "docs-ui-mockup-v1-index-html"
primary_target: "docs/ui/mockup-v1/index.html"
related_targets: ["docs/ui/mockup-v1/styles.css","docs/ui/mockup-v1/app.js","docs/ui/mockup-v1/pos.js","docs/ui/mockup-v1/views.js"]
---

# Surface brief — mobile-shop POS mockup (desktop till)

Scope: every screen of `docs/ui/mockup-v1/` (sales, services, pay, reports, inventory, repairs, settings, lock, phone preview). Mode: **Operate**. Build path: code-led (Operate surface).

Audience and job: the seller at one Cairo phone-shop counter (owner + 1–2 sellers), keyboard + mouse, the customer waiting; only staff see the screen. Rings up accessories, phones (IMEI optional), wallets, cards, bills and repairs; closes the shift.

Constraints (owner, 2026-10-16): the look only — positions, steps and shortcuts stay; not crowded with colour and not dull; both directions below ship and the owner picks one in settings; the shop logo and accent colour come from settings, so every colour that carries text is derived from the chosen accent with WCAG contrast checks; light and dark; offline single HTML file; Arabic RTL.

Roll: concept-seed ran **degraded** (roll service unreachable, no challengers). Assigned index 5 of the grounded list (Cairo street/metro wayfinding) — its palette material translated to the owner's accent (brand commitment), carried as direction A. The owner chose to have A and the pick B both available, switchable in settings.

## Direction contract — A «لافتة الشارع» (enamel street plate)

THESIS: the shop colour is an enamel plate — one solid field that carries the shell and the money action, framed by a thin inset keyline; it refuses the grey screen with a blue accent and the soft-shadow card kit.
OWN-WORLD: accent field (rail + pay button) with an inset keyline in the plate's text colour; cool neutral ground lightly tinted by the accent; flat white work surfaces with 1px lines; Changa (condensed Kufi sign lettering) for everything, prices at 700 with tabular figures; radii 6px (keyline 3px); no shadows except overlays.
STORY: the seller finds the item, sees the cart and the total at a glance, and the pay plate is the one place the eye lands to finish.
FIRST VIEWPORT: right rail = full-height plate with the logo in a light frame and nav in plate text, active item inverted; top bar quiet text with hairline separators; search, rectangular category chips, flat tiles; cart on the left with hairline-separated lines; big ink total; pay button = plate with keyline.
FORM: grounded list position 5 (assigned), translated; seed: a0fab187a5dac87d
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Direction contract — B «علبة الموبايل» (retail phone box)

THESIS: the interface is the retail box — white, ink and precise hairlines; the shop colour appears once as a band, and unit-identifying data sits on box stickers; it refuses the tinted-grey dashboard and pill chips.
OWN-WORLD: white surfaces on a neutral light ground; ink #18191b text; 1px hairlines, ink hairlines for stickers and key caps; accent as a 4px top band, the pay button and the current selection; Vazirmatn throughout with tabular figures; radii 4px (stickers 3px); dark = graphite box where stickers stay light paper labels.
STORY: the seller reads the screen like a spec label — what, how many, how much — and checks a phone's IMEI on its sticker before paying.
FIRST VIEWPORT: white rail with an ink-outlined active item; accent band across the top edge; flat tiles with hairlines; cart lines with IMEI stickers; big ink total; solid accent pay button.
FORM: grounded list position 1 (impeccable's pick, chosen by the owner alongside A); seed: a0fab187a5dac87d
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Unresolved: none for the visual system. Later product work (owner's request, after the design): a sales view filtered by product, category and date with day navigation; manual shortage entries.
