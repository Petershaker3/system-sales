<div dir="rtl">

# نموذج واجهة «موبايل ستور» — النسخة 1.1

نموذج **للتصميم بس** (HTML + JavaScript من غير مكتبات) عشان نتفق على الشكل والطريقة قبل كتابة البرنامج الحقيقي.
البيانات تجريبية، ومفيش قاعدة بيانات: الإعدادات والصور بتتحفظ في المتصفح، والمبيعات بتتمسح لما تعمل تحديث للصفحة.

## تفتحه إزاي

```bash
cd docs/ui/mockup-v1
python3 tools/serve.py --port 4173 --directory .     # أو: python3 -m http.server 4173
# وبعدين افتح http://localhost:4173
```

**أرقام سرية للتجربة:** بيتر (المالك) `1111` · يوسف (بيّاع) `2222` · مارينا (بيّاع) `3333`

## الجديد في 1.1 (من ملاحظات المالك — 16 أكتوبر 2026)

| الملاحظة | اللي اتعمل |
|---|---|
| «عاوز باقي التصنيفات زي الإكسسوار وغيرها يكونوا موجودين» | «إكسسوارات» بقت تصنيف رئيسي، وتحته صف فرعي (جرابات، اسكرينات، شواحن، كابلات، سماعات، باور بانك وميموري، حوامل) + «ساعات ذكية». جنب كل تصنيف عدد أصنافه، والبحث بـ«اكسسوار» بيجيب كله. **الإعدادات ← الأصناف والبيع**: إضافة تصنيف (رئيسي أو فرعي) وتغيير الاسم والترتيب والإخفاء. |
| «مش عاوز تسجيل IMEI يكون أساسي في كل شيء» | الـ IMEI **اختياري** افتراضيًا: الموبايل بيتضاف على طول، وفي السطر زرار «سجّل IMEI». ممكن تسجّل IMEI جديد وقت البيع لجهاز اتسلّم بالعدد، ومسح العلبة بعد إضافة الموبايل بيسجّل الـ IMEI على نفس السطر. الاستلام «بالـ IMEI» أو «بالعدد». ولو حبيت، فيه اختيار «إجباري للموبايلات». |
| «قايمة المستخدم فوق: عند التأشير يظهر باقي البياعين لسرعة التبديل مع الاحتفاظ بالرقم السري» | تأشّر على اسمك فوق ← تظهر باقي الأسماء ← تختار ← تكتب **الرقم السري بتاعه** ← اتبدّلت، والفاتورة المفتوحة زي ما هي. |
| «لو سجلت مبيعات هتظهر في التليفون؟» | أيوه، على Wi-Fi المحل. صفحة «الموبايل» فيها تليفون «مبيعات النهارده» بيتحدّث مع كل بيعة: المالك يشوف الإجمالي والربح ومين باع كام، والبيّاع مبيعاته بس. من برّه المحل = مرحلة المزامنة على الإنترنت (لسه). |
| «أقدر أضيف صور للمنتجات؟ وده عملي؟» | أيوه، **اختياري**: من المخزون دوس على أيقونة الصنف واختار صورة؛ بتتقص مربع وتتصغّر لوحدها (حوالي 15 ك.ب). بتظهر في مربعات البيع والبحث وتطبيق الموبايل، وفيه زرار في الإعدادات يخفيها. |

</div>

---

## Technical notes (for developers / agents)

**What this is:** a static, dependency-free, RTL Arabic UI prototype of the desktop POS + an in-shop mobile helper.
It is the **visual/behavioural reference** for the real app (Tauri 2 + Vue 3 + Rust + SQLite on branch `review/r1-bundle`).
It is **not** product code: no persistence of sales, mock data only, no security.

### Files

| File | Contents |
|---|---|
| `index.html` | Pre-paint theme script; loads `icons.js → data.js → app.js → pos.js → views.js` (order matters, plain scripts). |
| `styles.css` | Design tokens (light/dark), `html[data-theme|data-font|data-scale]`, all components. |
| `fonts.css`, `fonts/` | 30 woff2 files (IBM Plex Sans Arabic, Cairo, Readex Pro, Tajawal; arabic + latin subsets). Licenses: `fonts/LICENSES.txt` (SIL OFL 1.1). |
| `icons.js` | 133 Lucide icons (ISC), inlined as SVG bodies. |
| `data.js` | Mock data (seeded PRNG → stable Luhn-valid IMEIs). Category tree (`parent`), phones with `stock` = IMEI units + units received without IMEI. |
| `app.js` | Helpers, settings (`localStorage: mshop.mockup.settings.v1`), product images (`mshop.mockup.images.v1`), state `S`, render loop, rail/topbar, **user switcher**, delegated events (`data-act` / `data-input` / `data-change`). |
| `pos.js` | Search (Arabic normalisation, transliterated keywords, last-4 IMEI, SKU), categories bar, cart/invoices/hold, optional-IMEI logic, keyboard map, modals: IMEI, customer, qty, discount (owner PIN over limit), pay (split / credit / instalments / receipt), done + receipt, services (wallets, recharge cards, bills), shift close. |
| `views.js` | Reports, repairs board + intake, inventory (+ product images), settings (8 tabs incl. *الأصناف والبيع*), lock screen, mobile preview (live today's sales, scanner, lookup, receiving by IMEI or quantity). Startup at the end. |
| `screens/` | Reference screenshots (1366×768). |
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
- Money in the mockup is plain numbers; the real app uses integer piastres (see `review/r1-bundle` rules).

### Tooling

```bash
cd docs/ui/mockup-v1/tools
npm install                 # fonts, icons, puppeteer-core, @sparticuz/chromium (no system browser needed)
node build-assets.mjs ..    # regenerate fonts/, fonts.css, icons.js (offline)
python3 serve.py --bind 0.0.0.0 --port 4173 --directory ..   # preview server: always 200, no-store, CORS *
node smoke.mjs              # title / tiles / focus / console errors
node qa.mjs                 # 71 behaviour checks + layout-overflow detection (1366, 1920, large text, dark); shots → /tmp/shots
node final.mjs              # regenerate screens/
```

`launch.mjs` unpacks Chromium's shared libs + fonts to `/tmp/al2023x` on first run (needed on minimal Linux sandboxes).
Last QA run: **71 passed, 0 failed, 0 console errors** (2026-10-16).
