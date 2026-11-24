# ADR-037: خادم الشبكة المحلية وتطبيق الموبايل المساعد (`LAN Companion Server & Mobile Helper`)

- **التاريخ:** 2026-10-19
- **الحالة:** مُعتمد ومُنفَّذ (المرحلة الثالثة — البند `3.2`)
- **المراجع:** `docs/PLAN.md` (§15، §16، §19)، `ADR-016` (#2)، `docs/ui/mockup-v1/views/mobile.js`، `docs/ui/mockup-v1/views/settings.js`

---

## السياق

في `docs/PLAN.md` (§15 و§16 و§19 — المرحلة الثالثة، البند `3.2`)، طلبت الخطة:
1. **الكمبيوتر هو مصدر الحقيقة الوحيد (`ADR-016` #2):**
   - قاعدة البيانات (`SQLite`) موجودة على الكمبيوتر فقط.
   - تطبيق الموبايل مجرد نافذة مساعدة وكاميرا على نفس شبكة الـ Wi-Fi المحلية في المحل (`0.0.0.0:8787`) من غير إنترنت، ومفيش أي قاعدة بيانات على الموبايل.
2. **الأجهزة المربوطة وربط موبايل جديد بالـ QR (`Settings → الأجهزة والطابعة`):**
   - عرض الموبايلات المتوصلة بالاسم والموديل وحالة الاتصال (`متصل الآن`) وزرار `فصل`، مع إمكانية `توصيل موبايل جديد` وعرض QR التوصيل المحسوب برمجياً وعنوان السيرفر المحلي (`http://{ip}:8787`).
3. **4 شاشات مساعدة للموبايل (`docs/PLAN.md` §15 و`views/mobile.js`):**
   - **مبيعات النهارده لحظة بلحظة (`salesScreen`):** للمالك (الإجمالي + الربح الصافي + أشرطة كل بيّاع + أرصدة المحافظ + آخر الفواتير)، وللبيّاع (مبيعاته هو بس من غير ربح).
   - **ماسح للكاشير (`scanScreen`):** يقرأ باركود الصنف أو IMEI (15 رقم مطابق لـ Luhn) ويبعته مباشرة لفاتورة البيع المفتوحة على الكمبيوتر أو لشاشة الاستلام.
   - **سعر ومخزون (`lookupScreen`):** بحث فوري بالاسم أو الموديل أو الباركود أو آخر 4 أرقام من الـ IMEI والبيّاع واقف مع الزبون (التكلفة تظهر للمالك بس).
   - **استلام بضاعة وتصوير (`recvScreen`):** استلام موبايلات بمسح الـ IMEI من العلبة أو أصناف بالكمية بنفس قواعد الاستلام على الكمبيوتر، أو تصوير جهاز صيانة/مستعمل وإرساله للتذكرة.
   - **لا بيع من الموبايل في V1.**

---

## القرار

1. **صفر تعديل على مخطط قاعدة البيانات (`Zero Schema Changes`) وصفر قاعدة بيانات على الموبايل:**
   - تخزين إعدادات الأجهزة المقترنة وطابور المسح في مفاتيح `companion.*` داخل `app_settings` (`companion.devices_json`, `companion.scans_json`, `companion.pair_code`) مع تخطي البادئة `COMPANION_PREFIX` داخل `app_settings::load_snapshot` حتى لا تتأثر لقطة إعدادات البيع.
2. **طبقة الـ Domain والـ Service والـ Commands في Rust (`src-tauri/src/{domain,services,commands}/companion.rs`):**
   - `domain::companion`: يعرّف `PairedDevice`, `CompanionScanItem`, `CompanionStatus`, `DEFAULT_COMPANION_PORT = 8787`, ودوال `format_pair_payload` / `parse_pair_payload` بصيغة `MSHOP-PAIR|v1|{shop_name}|{host_ip}:{port}|{pair_code}`.
   - `services::companion`: يشغّل مستمع HTTP محلي خفيف (`spawn_lan_companion_listener`) على `0.0.0.0:8787` عند بدء التطبيق، ويوفر `overview`, `pair_device` (للمالك فقط `Permission::ManageCatalog`), `unpair_device` (للمالك فقط), `push_scan` (`Permission::Sell`), و`consume_scans` (`Permission::Sell`).
3. **واجهة الإعدادات وشاشة الموبايل والكاشير:**
   - تحديث `src/screens/settings/DevicesPrinterCard.vue` بقسم **«الموبايلات المتوصلة وتوصيل موبايل جديد»** (`[data-paired-devices-card]`) مع QR التوصيل (`[data-companion-qr]`) وعنوان السيرفر المحلي (`[data-companion-host-address]`).
   - إضافة شاشة **«الموبايل»** (`src/screens/mobile/MobileCompanionScreen.vue`, `src/screens/mobile/companion.ts`) في الشريط الجانبي (`src/shell/nav.ts`) ومؤشر الأجهزة المتصلة في الشريط العلوي (`src/shell/AppShell.vue`)، وربط طابور المسح بشاشة البيع (`PosScreen.vue` يستهلك `consumeCompanionScans('pos')` وينزّل الصنف أو وحدة الـ IMEI في الفاتورة المفتوحة).
