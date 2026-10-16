<div dir="rtl">

# نموذج واجهة «موبايل ستور» — النسخة 1.5

نموذج **للتصميم بس** (HTML + JavaScript من غير مكتبات) عشان نتفق على الشكل والطريقة قبل كتابة البرنامج الحقيقي.
البيانات تجريبية، ومفيش قاعدة بيانات: الإعدادات والصور بتتحفظ في المتصفح، والمبيعات بتتمسح لما تعمل تحديث للصفحة.

**مكانه في الخطة:** ده مرجع الشكل والطريقة المعتمد للمرحلة 0 — الخطة الحاكمة في [`docs/PLAN.md`](../../PLAN.md).

## تفتحه إزاي

**أسهل طريقة — ملف واحد من غير سيرفر ولا نت:**

1. افتح المستودع على GitHub ← الفرع `arena/332710ba-system-sales` ← `docs/ui/mockup-v1/mockup-offline.html`.
2. اضغط زرار التحميل (Download raw file).
3. دبل كليك على الملف — هيفتح في Chrome أو Edge على طول، وبيشتغل حتى من غير إنترنت.

الإعدادات (الاسم، الألوان، التصنيفات، الصور) بتتحفظ في المتصفح على نفس الجهاز.

**أو بسيرفر محلي (للمطوّر):**

```bash
cd docs/ui/mockup-v1
python3 tools/serve.py --port 4173 --directory .     # أو: python3 -m http.server 4173
# وبعدين افتح http://localhost:4173
```

> رابط المعاينة اللي بيتبعت في المحادثة بيشتغل **بس والجلسة شغالة**؛ لما الجلسة تقف الرابط يقف. الملف الواحد ده هو النسخة الدايمة.

**أرقام سرية للتجربة:** بيتر (المالك) `1111` · يوسف (بيّاع) `2222` · مارينا (بيّاع) `3333`

## الجديد في 1.5 (الشهور والتقارير والاستلام — 16 أكتوبر 2026)

التفاصيل والمراجعة بعد كل مرحلة: [`docs/ui/MONTHS-REPORTS-RECEIVING.md`](../MONTHS-REPORTS-RECEIVING.md).

| طلبك | اللي اتعمل |
|---|---|
| «هو اضافة مخزون بيتم عن طريق الموبايل فقط ولا السيستم كمان» | **الاتنين.** الخطة والبرنامج الحقيقي فيهم الاستلام من الكمبيوتر، لكن النموذج كان بيوديك على الموبايل بس. دلوقتي **المخزن ← «استلام بضاعة»** بيفتح نافذة على الكمبيوتر:<ul><li>المورد (اختياري)، والأصناف بالبحث أو الباركود، والعدد، وتكلفة الوحدة (للمالك بس).</li><li>«التكلفة بعد الاستلام» بالمتوسط المرجح بتبان قبل الحفظ.</li><li>الموبايل بيروح على خانة الـ IMEI على طول، وتمسح بالماسح أو «امسح بالموبايل».</li><li>الصنف اللي في النواقص بيتشال لما يوصل، ولو فيه عميل مستنيه السيستم بيقولك اسمه ورقمه.</li></ul> |
| «عاوز في المبيعات اقدر اشوف مبيعات الشهور الاخري مش ايام فقط» | في **المبيعات**:<ul><li>قايمة **«اختار شهر»** فيها كل الشهور اللي ليها مبيعات، والسهمين بيقلّبوا شهر شهر.</li><li>عرض جديد **«الأيام»**: كل يوم في الشهر في صف، و«أعلى يوم» متعلّم، ولو دوست على أي يوم يفتح فواتيره.</li><li>البيانات التجريبية بقت **14 شهر** بمواسم السوق المصري (العيدين، ورمضان، والمدارس، والجمعة البيضا، ونتيجة الثانوية).</li></ul> |
| «وفي التقارير عاوز تقارير عن الشهر الحالي والشهور الاخري وتقييمات عنها» | **التقارير ← «الشهر»**:<ul><li>أي شهر: المبيعات قصاد الشهر اللي فات وقصاد نفس الشهر السنة اللي فاتت، والربح، والفواتير، والموبايلات، والمتوقع لآخر الشهر.</li><li>**التقييم:** حكم على الشهر (ترتيبه في آخر 12 شهر)، وملاحظات من الأرقام نفسها، كل واحدة «كويس» أو «خلي بالك» أو «معلومة».</li><li>يوم بيوم، والتصنيفات والبيّاعين والأصناف وطرق الدفع بتغيّرهم، وآخر 12 شهر.</li></ul> |
| «عاوزك وانت بتعمل السيستم تعمله يكون جاهز للتطوير والتغييرات بسهولة» | <ul><li>الكود بقى ملف لكل شاشة.</li><li>كل الأرقام بتتحسب في مكان واحد، فالرقم بيطلع هو هو في كل شاشة.</li><li>فحوص بتشتغل مع كل تغيير: 53 قاعدة سريعة و157 فحص للشاشات.</li><li>دليل للمطوّر: [`docs/ENGINEERING.md`](../../ENGINEERING.md).</li></ul> |

**وكمان:**
- **أي مقارنة فيها النهارده بقت لحد نفس الساعة.** قبل كده، النهارده الساعة 10 الصبح كان بيتقارن بامبارح كله، فيطلع خسارة مش حقيقية.
- **البحث برقم الفاتورة** بقى يجيب الفاتورة دي بس، و**الأرقام العربي** (١٢٣) بقت شغالة في البحث.

## الجديد في 1.4 (المبيعات والنواقص — 16 أكتوبر 2026)

التفاصيل والمراجعات: [`docs/ui/SALES-SHORTAGES.md`](../SALES-SHORTAGES.md).

| طلبك | اللي اتعمل |
|---|---|
| «واجهة أشوف المبيعات... من حيث المنتج والتاريخ، لأني مش عارف فين دلوقتي» | زرار **«المبيعات»** في الشريط الجانبي تحت «البيع». بحث بالصنف أو رقم الفاتورة أو الـ IMEI أو العميل، وفلترة بالتصنيف والبيّاع وطريقة الدفع، والعرض **بالفواتير أو الأصناف أو التصنيفات**، وشريط الإجماليات بمقارنة باليوم أو الفترة اللي قبلها. الدوسة على الفاتورة بتفتح تفاصيلها، وتقدر تبعت الإيصال تاني واتساب. |
| «أقدر أشوف الأيام وأقلّب بينها» | سهمين (اليوم اللي قبله واللي بعده) وتاريخ تختاره، واختصارات: النهارده، امبارح، آخر 7 أيام، الشهر ده. وأسهم الكيبورد بتقلّب برضه. |
| «أضيف ناقص، مش مجرد السيستم يقترح» | **المخزن ← النواقص**: تكتب الصنف (من المخزن أو اسم مش عندك)، والكمية، وملاحظة، وعميل مستني. الحالة «ناقص» ثم «اتطلب»، و«وصل» بيشيله. واقتراحات السيستم تحت بزرار «ضيفه للنواقص». ومن شاشة البيع: لو البحث ما لقاش الصنف أو خلصان، «ضيف للنواقص» من غير ما تسيب الفاتورة. |

**البيّاع** بيشوف مبيعاته هو بس، من غير الربح. **والأرقام** في التقارير والموبايل وشاشة المبيعات بقت من نفس سجل الفواتير، فبتتطابق.

## الجديد في 1.3 (الشكل — 16 أكتوبر 2026)

طلبك: «الواجهة تبقى كأنها مش معمولة بـ AI، وتبقى أجمل» — بالمهارات المناسبة وعلى مراحل ومراجعة بعد كل مرحلة. التفاصيل والمراجعات: [`docs/ui/REDESIGN.md`](../REDESIGN.md)، ونظام الشكل: [`DESIGN.md`](../../../DESIGN.md).

| طلبك | اللي اتعمل |
|---|---|
| «في الإعدادات اعمل واختار بينهم» | **الإعدادات ← الشكل ← الطابع**: «لافتة الشارع» (لون المحل لوح بإطار رفيع جوّه، وخط Changa) أو «علبة الموبايل» (أبيض وحبر وخطوط رفيعة، وشريط بلون المحل، والـ IMEI ستيكر، وخط Vazirmatn). الاتنين فاتح وغامق. |
| «اللوجو والألوان هختارها من الإعدادات» | أي لون تختاره (الجاهز أو «لون تاني») الكلام عليه وبلونه بيتظبط لوحده عشان يفضل مقروء. ولو اللوجو بنفس لون المحل بيتحط في إطار فاتح. |
| «الشكل بس» | الأماكن والخطوات والاختصارات زي ما هي بالظبط. |
| «مش زحمة ومش ممل» | لون واحد قوي في أماكن محددة، والباقي هادي؛ الشخصية من الخط والعلامة المميزة. |
| علامات الـ AI | اتشالت: الأزرق الافتراضي، والظلال تحت كل كارت، وتدوير كل حاجة بنفس الدرجة، والإطار الملوّن على جنب، والتوهّج، والأيقونة قبل كل عنوان، والكلام المتوصل بـ«·» و«—». كاشف `impeccable`: **صفر** في كل الشاشات (كان 323). |

**وكمان:** مكان QR الإيصال الإلكتروني بقى مقفول افتراضيًا (مفتاحه في الإعدادات ← الإيصال)، ورسالة استلام جهاز الصيانة بقت «اتبعت على واتساب» بدل «بيطبع».

## الجديد في 1.2 (قرارات الجولة التانية — 16 أكتوبر 2026)

| قرارك | اللي اتعمل في النموذج |
|---|---|
| «شاشة البيع زي ماهي في الـ HTML» | مربعات + فاتورة زي ما هي، من غير تغيير. |
| «الفيزا والتقسيط والآجل اختياري من الإعدادات» | **الإعدادات ← المحافظ والدفع ← طرق الدفع**: كل طريقة ليها زرار تشغيل وإيقاف (الكاش ثابت)، واللي تقفله يختفي من شاشة الدفع. كلهم شغالين دلوقتي — اقفل اللي مش بتستخدمه. |
| «واتساب حاليًا فقط» | مفيش طابعة: الإيصال **واتساب** (صورة الإيصال + الرسالة)، وفي شاشة الدفع الاختيار «واتساب» أو «بدون». الفاتورة على عميل ← واتساب على رقمه لوحده. من غير عميل (إكسسوار سريع) ← «بدون» عشان ما نطلبش رقم في كل بيعة، وتقدر تختار واتساب وتكتب الرقم. وبعد الدفع لو العميل طلب الإيصال: «ابعت الإيصال واتساب» واكتب رقمه. فوق مكتوب «الإيصال: واتساب». ولما تجيب طابعة: **الإعدادات ← الأجهزة والطابعة ← عندي طابعة إيصالات**. |
| «العمولة تتكتب في كل عملية لأنها مش ثابتة، أو تتظبط في الإعدادات» | في الخدمات (F9) خانة **«العمولة»** فاضية: البيّاع بيكتب اللي اتفق عليه (ولو مفيش يكتب 0)، والإجمالي بيتحسب قدامه، ولو نسيها البرنامج بيرجّعه عليها. نفس الكلام لرسوم الفواتير. ولو حبيت: **الإعدادات ← المحافظ والدفع ← العمولة والرسوم ← «محسوبة تلقائي»** (نسبة + أقل عمولة + رسوم الفواتير)، والبيّاع يقدر يغيّرها في العملية. |
| «الضمان وآخر الإيصال يتظبطوا من الإعدادات» | موجودين في **الإعدادات ← الإيصال والضمان**: شهور ضمان الجديد والمستعمل، والجملة اللي في آخر الإيصال، ورسالة الواتساب. |
| «انتظار» بدل «تعليق» | زرار **«انتظار F8»** وشريط الاختصارات وتبويب الفاتورة («انتظار» والمبلغ جنبها) والرسايل. «آجل» و«بيّاع» زي ما هم. |

## الجديد في 1.1 (من ملاحظات المالك — 16 أكتوبر 2026)

| الملاحظة | اللي اتعمل |
|---|---|
| «عاوز باقي التصنيفات زي الإكسسوار وغيرها يكونوا موجودين» | «إكسسوارات» بقت تصنيف رئيسي، وتحته صف فرعي (جرابات، اسكرينات، شواحن، كابلات، سماعات، باور بانك وميموري، حوامل) + «ساعات ذكية». جنب كل تصنيف عدد أصنافه، والبحث بـ«اكسسوار» بيجيب كله. **الإعدادات ← الأصناف والبيع**: إضافة تصنيف (رئيسي أو فرعي) وتغيير الاسم والترتيب والإخفاء. |
| «مش عاوز تسجيل IMEI يكون أساسي في كل شيء» | الـ IMEI **اختياري** افتراضيًا: الموبايل بيتضاف على طول، وفي السطر زرار «سجّل IMEI». ممكن تسجّل IMEI جديد وقت البيع لجهاز اتسلّم بالعدد، ومسح العلبة بعد إضافة الموبايل بيسجّل الـ IMEI على نفس السطر. الاستلام «بالـ IMEI» أو «بالعدد». ولو حبيت، فيه اختيار «إجباري للموبايلات». |
| «قايمة المستخدم فوق: عند التأشير يظهر باقي البياعين لسرعة التبديل مع الاحتفاظ بالرقم السري» | تأشّر على اسمك فوق ← تظهر باقي الأسماء ← تختار ← تكتب **الرقم السري بتاعه** ← اتبدّلت، والفاتورة المفتوحة زي ما هي. |
| «لو سجلت مبيعات هتظهر في التليفون؟» | أيوه، على Wi-Fi المحل. صفحة «الموبايل» فيها تليفون «مبيعات النهارده» بيتحدّث مع كل بيعة: المالك يشوف الإجمالي والربح ومين باع كام، والبيّاع مبيعاته بس. من برّه المحل = مرحلة المزامنة على الإنترنت (لسه). |
| «أقدر أضيف صور للمنتجات؟ وده عملي؟» | أيوه، **اختياري**: من المخزن دوس على أيقونة الصنف واختار صورة؛ بتتقص مربع وتتصغّر لوحدها (حوالي 15 ك.ب). بتظهر في مربعات البيع والبحث وتطبيق الموبايل، وفيه زرار في الإعدادات يخفيها. |

</div>

---

## Technical notes (for developers / agents)

**What this is:** a static, dependency-free, RTL Arabic UI prototype of the desktop POS + an in-shop mobile helper.
It is the **visual/behavioural reference** for the real app in this repository (`src/` + `src-tauri/`: Tauri 2 + Vue 3 +
Rust + SQLite). Scope and priorities live in [`docs/PLAN.md`](../../PLAN.md); the decisions behind it in
[`ADR-016`](../../decisions/ADR-016-owner-plan-2026-10-16.md).
It is **not** product code: no persistence of sales, mock data only, no security.

### Files

| File | Contents |
|---|---|
| `index.html` | Pre-paint theme script; loads `icons.js → data.js → app.js → analytics.js → pos.js → views/*.js → boot.js` (order matters, plain scripts; the guide is [`docs/ENGINEERING.md`](../../ENGINEERING.md)). |
| `styles.css` | Design tokens per look × theme (`html[data-look="plate"|"box"][data-theme]`, plus `data-font|data-scale`), all components, look-specific signature rules at the end. See [`DESIGN.md`](../../../DESIGN.md). |
| `fonts.css`, `fonts/` | 48 woff2 files (Changa and Vazirmatn = the looks' fonts; IBM Plex Sans Arabic, Cairo, Readex Pro, Tajawal as options; arabic + latin subsets). Licenses: `fonts/LICENSES.txt` (SIL OFL 1.1). |
| `icons.js` | 133 Lucide icons (ISC), inlined as SVG bodies. |
| `data.js` | Mock data (seeded PRNG → stable Luhn-valid IMEIs). **`history`**: 14 months of demo invoices with lines (own PRNG; from the 1st, 13 months back; growth over the year and Egyptian seasons, both Eids by year; numbered from 1001), the single source for reports, the phone view and the sales screen. **`receipts`**: demo receipts with supplier labels. Category tree (`parent`), phones with `stock` = IMEI units + units received without IMEI. |
| `app.js` | Helpers, settings (`localStorage: mshop.mockup.settings.v1`), product images (`mshop.mockup.images.v1`), state `S`, render loop, rail/topbar, **user switcher**, delegated events (`data-act` / `data-input` / `data-change`). |
| `pos.js` | Search (Arabic normalisation, transliterated keywords, last-4 IMEI, SKU), categories bar, cart/invoices/hold, optional-IMEI logic, keyboard map, modals: IMEI, customer, qty, discount (owner PIN over limit), pay (split / credit / instalments / receipt), done + receipt, services (wallets, recharge cards, bills), shift close. |
| `analytics.js` | **The one computation layer**: dates and periods, comparisons (`prevPeriod`, `comparePeriod` up to the same time, `yearAgo`), grouping (`totalsOf`, `byProduct`, `byCategory`, `bySeller`, `byMethod`, `byDay`, `byMonth`, `withChange`), `monthReport` (totals, comparisons, projection, rank, evaluation), `refreshDash`, `histRecord`, and `receiveCost` (moving average). Pure functions, checked by `tools/unit.mjs`. |
| `views/*.js` | One screen per file: `reports` (today + month report), `repairs`, `inventory`, `receive` (receiving window + `applyReceipt`, also used by the phone), `shortages`, `settings`, `lock`, `mobile`, `sales` (days and months, filters, invoice/day/product/category views, invoice window). |
| `boot.js` | Last file: applies the settings and draws the first screen. (`views.js` was split into `views/` + `boot.js` in v1.5 with no behaviour change, `84a748c`.) |
| `mockup-offline.html` | **Generated** single-file build (all CSS/JS/fonts inlined, ≈ 1.4 MB). Opens from disk (`file://`) with no server and no network. Never edit by hand — rebuild with `tools/build-offline.mjs`. |
| `screens/` | Reference screenshots (1366×768), both looks; made by `tools/final.mjs` from the mockup itself (no generated imagery). |
| `tools/` | Build + QA tooling (below). `node_modules/` is git-ignored. |

### Key behaviours to carry into the real app

- **Optional IMEI:** product `stock` is authoritative; IMEI units are optional records attached to part of the stock.
  A phone line may have `imei = null`; IMEI can be attached later (pick a registered unit or type a new Luhn-valid IMEI if
  the product still has unregistered stock). Scanning an IMEI while the selected line is the same phone without IMEI attaches it.
  Selling without IMEI decrements stock; if registered units then exceed stock, the oldest free unit is retired (FIFO).
  Setting `imeiMode: optional | required`.
- **Categories:** 2-level tree (`parent`), user-editable (name, order, hidden, custom add/delete-if-empty). Search indexes
  category + parent names.
- **Quick switch:** hover (real mouse movement only) or click the user chip → other users → PIN pad. The open invoice is kept
  and attributed to whoever completes it. Menu updates without full re-render (`swSync`) so outside clicks are never lost.
- **Mobile "today's sales":** owner sees shop total, profit, per-seller split, latest invoices; sellers see only their own.
- **Product images:** optional; centre-crop 192×192 JPEG ≈ 10–20 KB; can be hidden globally.
- **Months and month report (v1.5):** the sales screen picks any month (list + month arrows, stops at the first month) and has a «الأيام» view; the reports have a «الشهر» tab built on `monthReport()`. Evaluation thresholds live in `TH` (sales ±3%, average invoice ±5%, margin ±1 point, category ±10%); discount and credit are judged by their share of sales; no judgement without a month before.
- **Comparison rule (v1.5):** a period that includes today is compared with the period before **up to the same clock time** (`comparePeriod`, `inSpan`), on every screen. Today vs yesterday uses `refreshDash().today.vsYesterday` (null when yesterday had no sales).
- **Receiving (v1.5):** `views/receive.js`. Lines `{pid, qty, cost, imeis}`; unit cost for the owner only (a seller receives at the last cost, so the average stays); `receiveCost` = ceil((stock × avg + qty × cost) / (stock + qty)); IMEI units keep their own cost; IMEI checks = 15 digits + Luhn + not registered + not twice; `imeiMode: required` blocks a short line; shortages with that product close and name the waiting customer. `applyReceipt()` is the single path for the computer and the phone. Modals may define `canClose(m)`; the receiving window warns on the first close with unsaved lines.
- **Search ranking:** `rankProducts()` (pos.js) is shared by the sales search and the receiving window (name starts with the first word, then the whole phrase, then best sellers). An exact invoice number wins in the sales screen; Arabic-Indic digits are converted first.
- **Sales record (v1.4):** `DATA.history` holds every invoice (demo + session). `refreshDash()` (analytics.js since v1.5) derives the reports
  and the phone view from it; `completeSale` appends via `histRecord()`. With a product/category filter the sales screen counts
  matching lines only (gross, before invoice discount) and says so.
- **Shortages (v1.4):** `localStorage: mshop.mockup.shortages.v1`; manual entries (product or free text, qty, note, waiting
  customer, `open|ordered`), system suggestions = stock ≤ `min` (suggested qty up to 2× min), quick add from the sales search.
- **Registry guard:** `VIEWS / MODALS / ACT / INPUT / CHANGE` log a console error if a name is defined twice (QA fails on it).
- **Receipts (round 2, ADR-016):** WhatsApp only for now. Setting `printer: false` (default) → pay-modal receipt choices
  are `wa | none`; a customer with a phone pre-selects `wa` with his number; a walk-in pre-selects `none` (no number demanded).
  The done screen can send the receipt afterwards to a typed number. `printer: true` restores `print | both` and the paper
  size. One renderer: the same receipt image is sent on WhatsApp now and printed as a raster later. Old saved
  `receiptMode: 'print'` maps to `wa` while there is no printer.
- **Service commission:** `feeMode: 'manual'` (default) → the commission field is empty and must be typed per transaction
  (0 allowed; a withdrawal fee can't exceed the amount; a missing fee puts the cursor back on it). `'auto'` → pre-filled from
  `feePct`/`feeMin` (wallets) or `billFee` (bills) and still editable. The recorded fee is always the one on screen.
- **Wording:** «انتظار» (hold, F8) replaces «تعليق»; «آجل» (credit) and «بيّاع» (seller) stay.
- Money in the mockup is plain numbers; the real app uses integer piastres (`ADR-010`).

### Tooling

```bash
cd docs/ui/mockup-v1/tools
npm install                 # fonts, icons, puppeteer-core, @sparticuz/chromium (no system browser needed)
node build-assets.mjs ..    # regenerate fonts/, fonts.css, icons.js (offline)
python3 serve.py --bind 0.0.0.0 --port 4173 --directory ..   # preview server: always 200, no-store, CORS *
node smoke.mjs              # title / tiles / focus / console errors
npm run unit                # 53 rules for analytics.js + data.js, no browser, < 1 s (incl. 'every top-level name declared once')
node qa.mjs                 # 157 behaviour checks + layout-overflow detection (1366, 1920, large text, dark, both looks); shots → /tmp/shots
node snapshots.mjs          # static snapshots: 24 screens × 2 looks × 2 themes → /tmp/snap
sh detect-snapshots.sh      # impeccable design detector over the snapshots (needs IMPECCABLE + IMPECCABLE_BROWSER)
node final.mjs              # regenerate screens/ (17 screenshots)
node build-offline.mjs      # rebuild ../mockup-offline.html after ANY change to the mockup sources
node offline-check.mjs      # file:// check: zero network requests, Arabic fonts loaded, no console errors
MOCKUP_URL="file://$(cd .. && pwd)/mockup-offline.html" node qa.mjs   # full QA against the single file
```

`launch.mjs` unpacks Chromium's shared libs + fonts to `/tmp/al2023x` on first run (needed on minimal Linux sandboxes).
Last QA run: **157 passed, 0 failed, 0 console errors** — served (`serve.py`) and single-file (`file://`), 2026-10-16 (v1.5). Unit: **53 passed**.
Last detector run (`impeccable` 0.1.15): **0 findings** on 96 snapshots (24 screens × 2 looks × 2 themes). Single file: 1,419 KB, zero network requests.
