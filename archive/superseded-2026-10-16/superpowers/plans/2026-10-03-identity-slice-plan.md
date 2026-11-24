# خطة شريحة الهوية (Identity Slice) — نظام محل الموبايلات

**الحالة:** مُعتمدة معماريًا، بانتظار اعتماد التنفيذ.
**التاريخ:** 2026-10-03
**المرجع المعماري:** `docs/decisions/ADR-008-v1-local-first-platform-scope.md` · `docs/decisions/ADR-009-uuid-v7-and-os-secure-session-storage.md`
**المرجعSpecifier:** `docs/superpowers/specs/2026-09-28-mobile-shop-system.md`
**الخطة الأم:** `docs/superpowers/plans/2026-09-28-mobile-shop-system.md` — المهمة 2.1 · 2.2 (جزئيًا) · 2.3 · 2.4

> **لماذا الهوية أولًا وليس كتالوج المنتجات:** المواصفة تجعل `catalog-media` معتمدة على `identity-access` (`spec:28`، `spec:39`)، والخطة تقرر أن السجلات تحمل **حقول تدقيق للمنشئ والمعدل** (`plan:143`)، وأن كل أمر Rust يتحقق من **هوية الجلسة ودورها** (`plan:151`). لا يمكن كتابة جدول `products` يحترم ذلك دون `users`. الاعتماد هنا **منطقي لا شكلي**.

---

## 1. النطاق

**داخل الشريحة:**
- إنشاء أول Manager مرة واحدة فقط (first-run setup)
- اختيار المستخدم + كلمة المرور (User Picker + Password)
- إصدار الجلسة والتحقق منها وانتهاؤها
- سياسة القفل بعد المحاولات الفاشلة
- تسجيل الأحداث في `audit_events`
- مستوى التأكيد `Assurance` (تهيّئ لمتطلب الجملة لاحقًا)
- `README.md` + منظومة الاختبار

**خارج الشريحة (مؤجَّل):** إدارة المستخدمين وإضافة حساب مبيعات · تغيير الأدوار · إعادة تعيين كلمة المرور · إعادة تعيين القفل · أي أمر يكشف سعر الجملة · أي حقل مالي.

---

## 2. القرارات المعتمدة في هذه الشريحة

| # | القرار | المصدر |
|---|---|---|
| 1 | كلمة المرور، **وليس** PIN | قرار المالك 2026-10-03 |
| 2 | **Argon2id** لتخزين كلمة المرور | قرار المالك + `plan:151` |
| 3 | الجلسة في **SQLite** مع `token_hash = SHA-256(token)` | قرار المالك |
| 4 | انتهاء: **15 دقيقة خمول** · **12 ساعة كحد أقصى** | قرار المالك |
| 5 | **5 محاولات فاشلة → قفل 15 دقيقة**، وإعادة الضبط لـManager فقط | قرار المالك |
| 6 | `login` / `logout` / `lockout` في `audit_events` | قرار المالك |
| 7 | أول Manager عبر **first-run setup**، مرة واحدة فقط، بلا seed وبلا CLI | قرار المالك |
| 8 | تأجيل إدارة المستخدمين الكاملة | قرار المالك |
| 9 | `README.md` + منظومة الاختبار الآن | `spec:141`، `spec:227`، `plan:135` |
| 10 | **User Picker + Password** — لا `username` | قرار المالك |
| 11 | الرمز في **مخزن الأسرار الأصلي**، **لا تراه JavaScript أبدًا** | قرار المالك + `ADR-009` |
| 12 | `keyring-core` + `windows-native-keyring-store` + `android-native-keyring-store` | قرار المالك + `ADR-009` |
| 13 | **لا `roles` table** — `Role` enum + `users.role` | قرار المالك |
| 14 | `failed_attempts` و`locked_until` **أعمدة على `users`** | قرار المالك |
| 15 | **UUID v7** لمعرّفات الكيانات | قرار المالك + `ADR-009` |
| 16 | Keychain غير متاح → **fail closed**، بلا fallback | قرار المالك + `ADR-009` |
| 17 | كل جهاز مستقل: مستخدموه على SQLite الخاصة به، **بلا sync** | قرار المالك + `ADR-008:12` |

---

## 3. شكل المعمارية

```text
Vue ──▶ commands/identity/ ──▶ services/identity/ ──▶ domain/identity/ ──▶ repositories/identity/ ──▶ SQLite
        حدود نقل فقط          تنسيق                       قواعد/types          تنفيذ SQLx
                             (تقرأ المخزن الأصلي)                          + keyring-core
```

### 3.1 `domain/identity/` — بلا Tauri وبلا SQLx وبلا SQLite وبلا keyring

| النوع | الغرض |
|---|---|
| `UserId` | newtype فوق `Uuid` (v7) — ثابت، غير مشتق من التخزين (`spec:109`) |
| `Role` | `Manager` \| `Sales` (`spec:17-18`) |
| `Assurance` | `Normal` \| `Reauthenticated` — يحمل `plan:151`(Id-6) إلى شريحة المنتجات |
| `CredentialVerifier` | سلسلة PHC لـArgon2id؛ معتمة هنا، **لا تُحلَّل** |
| `User` | id, display_name, role, verifier, failed_attempts, locked_until |
| `Session` | user_id, role, assurance, issued_at, last_seen_at, absolute_expires_at |
| `SessionToken` | غلاف للرمز السري |

**آلية الإلزام المعماري.** حقل `Session` **خاص** ولا يوجد له `public` constructor، ويُعرَّف داخل `domain::identity`. حسب خصوصية Rust لا يستطيع `commands/` إنشاء نسخة منه — **المحرّر يرفض البناء**. `plan:151` يفرض أصلًا أن Rust لا يثق بالأدوار من الواجهة؛ وهذا يحوّل مخالفة ذلك من **اختبارٍ منسي** إلى **خطأ ترجمة**. كل ذلك يخدم `spec:210` الذي يشترط اختبار الصلاحيات في طبقة التطبيق/البيانات لا بإخفاء عناصر الواجهة. `domain::identity` يعرّض `pub(crate) fn from_verified(...)` واحدًا فقط تستدعيه `services`.

### 3.2 `services/identity/`

| الدالة | المسؤولية |
|---|---|
| `bootstrap_status()` | هل يحتاج التطبيق إلى first-run setup؟ **استرشادي للواجهة فقط** |
| `create_first_manager()` | البوابة أحادية الاستخدام — **معاملة واحدة** |
| `authenticate(user_id, password)` | التحقق + سياسة القفل + إصدار الجلسة |
| `resolve_session()` | قراءة الرمز من المخزن الأصلي → hashing → التحقق من SQLite → بناء `Session` |
| `reauthenticate()` | ترقية `Assurance` إلى `Reauthenticated` |
| `logout()` | حذف الجلسة + تدقيق |

### 3.3 `repositories/identity/`

- `UserRepository` — `count_all`, `insert`, `find_by_id`, `record_failed_attempt`, `reset_failed_attempts`
- `SessionRepository` — `insert`, `find_by_token_hash`, `delete`, `touch_last_seen`
- `AuditRepository` — `append`
- **`SecureTokenStore`** — تجريد `keyring-core` خلف trait، وحيد يعرف المخزن الأصلي

> **موقع `SecureTokenStore`:** في `data/` وليس `domain/` — النطاق لا يعرف شيئًا عن نظام التشغيل أو `keyring` (`spec:99`، ADR-008:121). `domain` يرى `SessionToken` مجرد قيمة.

### 3.4 `commands/identity/`

`bootstrap_status` · `create_first_manager` · `list_users_for_picker` · `login` · `logout` · `whoami` · `reauthenticate`

كلها **مسمّاة**، وبلا `executeSql`/`selectSql` (`plan:157`، `spec:148`).

> **`list_users_for_picker` ليست ثقة:** يُرجع `id` و`display_name` و`role` **فقط** — لا `verifier` ولا `failed_attempts` ولا `locked_until`. اختيار المستخدم واجهة، وليس تفويضًا؛ التفويض يأتي من كلمة المرور.

---

## 4. مخطط القاعدة — 3 جداول

```sql
CREATE TABLE users (
  id               TEXT PRIMARY KEY,          -- UUID v7
  display_name     TEXT NOT NULL,
  role             TEXT NOT NULL,             -- 'manager' | 'sales'
  verifier         TEXT NOT NULL,             -- Argon2id PHC string
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until     TEXT,                      -- NULL = not locked
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash         TEXT PRIMARY KEY,        -- SHA-256(token)، لا الرمز نفسه
  user_id            TEXT NOT NULL REFERENCES users(id),
  assurance          TEXT NOT NULL,
  issued_at          TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,                           -- NULL إذا كان الفاعل مجهولًا
  event_type  TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  detail      TEXT                            -- JSON، لا أسرار أبدًا
);
```

**انحراف مقصود عن `plan:141`:** لا `roles` table (قرار 13)، ولا `categories`/`products`/… لأن جداول `plan:141` الأخرى تخص شريحات مختلفة لها معانٍ محسومة مختلفة، فتُنشأ مع شريحتها.

**تعارض مُصلَح:** `plan:141` كان يذكر `sync_outbox` و`sync_cursors`، وهو ممنوع في V1 (`ADR-008`، `plan:199`). حُذف في Step 6A.

---

## 5. السلوك

### 5.1 بوابة first-run (مرة واحدة)

عدّاد المستخدمين + الإدخال **في معاملة SQLx واحدة**:

```rust
let mut tx = pool.begin().await?;
let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&mut *tx).await?;
if n > 0 { return Err(Error::BootstrapAlreadyCompleted); }
// insert user + audit + session في نفس tx
tx.commit().await?;
```

البوابة **في Rust لا في Vue** (`spec:210`). `bootstrap_status()` استرشادي للعرض فقط؛ حتى لو أُخفيت شاشة الإعداد، Attempts ثانية تفشل عند المعاملة.

### 5.2 تسجيل الدخول

```
1. اقرأ المستخدم بـ id                       → غير موجود: خطأ موحّد + تدقيق user_id=NULL
2. إن locked_until > now                      → رفض "مقفل" + تدقيق account_locked
3. تحقّق من Argon2id
4. فشل → failed_attempts += 1
         إن بلغت 5 → locked_until = now + 15د، تصفير العدّاد، تدقيق account_locked
         تدقيق login_failed
5. نجح → تصفير العدّاد و locked_until
         توليد 32 بايت عشوائية (base64url)
         تخزين SHA-256(رمز) في SQLite + الرمز نفسه في مخزن الأسرار الأصلي
         تدقيق login_succeeded
         إرجاع { user_id, display_name, role }   ← بلا رمز
```

**مقاومة التعداد (تكلفة 3 أسطر):** عند عدم وجود المستخدم يُنفَّذ Argon2 على قيمة وهمية، وتُعاد رسالة وخطأ متطابقان، حتى لا يكشف التوقيت وجود الحساب. **مقترح — يتطلّب موافقة.**

### 5.3 الجلسة

| القاعدة | القيمة |
|---|---|
| خمول | 15 دقيقة — `last_seen_at` يُحدَّث عند كل أمر مُصادَق |
| مطلق | 12 ساعة — `absolute_expires_at` **لا يُمدَّد أبدًا** |
| عبر إعادة التشغيل | نعم — الرمز في المخزن الأصلي |
| عند `logout` | حذف من SQLite + من المخزن الأصلي |

> **كلفة:** `last_seen_at` كتابة عند كل أمر. معدّل الأوامر في POS منخفض، فالمقايضة مقبولة. إن كبر لاحقًا يمكن تحديثه دوريًا بدل كل نداء.

### 5.4 Assurance

`Normal` افتراضيًا. أمر `reauthenticate` يرقّيها إلى `Reauthenticated`. شريحة المنتجات ستفرض `Reauthenticated` على أي أمر يكشف سعر الجملة (`plan:151`). **الآلية تُبنى الآن** لأن retrofittingها لاحقًا يعني لمس كل أمر.

---

## 6. الاعتماديات

### 6.1 المباشرة الجديدة

| الحزمة | الإصدار المثبّت | الغرض | الترخيص |
|---|---|---|---|
| `argon2` | `=0.6.0` | Argon2id | MIT OR Apache-2.0 |
| `password-hash` | `=0.6.1` | صيغة PHC | MIT OR Apache-2.0 |
| `uuid` | `=1.27.0` | معرّفات v7 | Apache-2.0 OR MIT |
| `getrandom` | `=0.4.3` | CSPRNG | MIT OR Apache-2.0 |
| `sha2` | `=0.11.0` | تجزئة الرمز | MIT OR Apache-2.0 |
| `subtle` | `=2.6.1` | مقارنة ثابتة الزمن | BSD-3-Clause |
| `keyring-core` | `=1.0.0` | تجريد المخزن | MIT OR Apache-2.0 |
| `windows-native-keyring-store` | `=1.1.0` | Credential Manager | MIT OR Apache-2.0 |
| `android-native-keyring-store` | `=1.0.0` | Android Keystore | MIT OR Apache-2.0 |

> `argon2` يسحب `password-hash`، لكن يُصرَّح به صراحةً لأننا نتعامل مع سلسلة PHC مباشرة.

### 6.2 الميزات المطلوبة
- `uuid`: **`v7`** (مُتحقَّق منه في السجل)
- `sha2`: `sha2` (SHA-256)
- `argon2`: `alloc` + `password-hash`

### 6.3 `[dev-dependencies]` جديدة
`tempfile` (قاعدة SQLite مؤقتة للاختبار) · `tokio` (`macros`, `rt-multi-thread`, للاختبارات) — **`tokio` يُستخدم أيضًا في بيئة الاختبار.**

### 6.4 نتيجة فحص التراخيص
تم الفحص من crates.io API بتاريخ 2026-10-03 — **لا يوجد أي copyleft**. 15 اعتمادية غير مباشرة جديدة كلها مسموحة. الاستثناء الوحيد: `subtle` بترخيص **BSD-3-Clause** (التزام إشعار إسناد). **لا OpenSSL في الشجرة** — وهذا مهم عمليًا لأن بناء Android المتقاطع هشّش أصلًا، وإضافة OpenSSL كانت ستضيف خطوة بناء كاملة جديدة.

---

## 7. الاختبارات — المخرَج لا الحِمل الإضافي

### 7.1 وحدات (`tests/unit/` — بلا SQLite)
- صلاحيات الأدوار حسب الدور
- حدود انتهاء الجلسة: خمول عند 15 دقيقة بالضبط، مطلق عند 12 ساعة بالضبط
- آلة حالات القفل: عند 5 بالضبط، لا قبلها
- `bootstrap` مسموح مرة واحدة فقط
- **اختبار ترجمة:** بناء جهازي محاولة ينشئان `Session` مباشرة **يفشل** — إثبات `plan:151` بنيويًا

### 7.2 تكامل (`tests/integration/` — SQLite حقيقي، لا mocks)
- `bootstrap` الثاني يترك **صفر** مستخدمين إضافيين
- فشل بعد الإدراج يترك **صفر** أثر (rollback)
- القفل **يصمد** بعد إعادة فتح المخزن
- `verifier` لا يساوي كلمة المرور أبدًا
- `token_hash` لا يساوي الرمز أبدًا
- **`users` فارغة ← `SELECT COUNT(*)` يساوي 0**
- جلسة مبيعات على أمر Manager-ONLY **مرفوضة**
- **فشل keyring ⇒ لا جلسة** (fail closed، لا fallback)

### 7.3 تحقّق
`cargo test` · `npm run typecheck` · `npm run build` · `cargo check` · بناء Android + تثبيت وتشغيل على SM-N976N

---

## 8. الواجهة

| الشاشة | المحتوى |
|---|---|
| First-run setup | إنشاء أول Manager — تظهر فقط عند `bootstrap_status() == false` |
| User Picker + Password | قائمة المستخدمين + حقل كلمة المرور |
| Shell | يُظهر المستخدم والدور الحالي وزر خروج |

`src/stores/session.ts` (أو composable) يحتفظ بـ `{ user, role }` فقط. **لا رمز في أي مكان في `src/`** — استدعاء `grep -ri token src/` يجب أن يعطي نتيجة فارغة.

---

## 9. التوثيق

`README.md` — الأوامر الدقيقة:
- `cargo test` · `cargo check`
- `npm run typecheck` · `npm run build`
- `.\scripts\android-build.ps1 -Apk -Device`
- ملاحظة MSVC (`vcvars64.bat`)Requirementللم-calledبالحق

---

## 10. التسلسل

| # | المهمة | تحقّق |
|---|---|---|
| 1 | إضافة الاعتماديات + إعادة توليد `Cargo.lock` + مراجعة تراخيص مُثبَّتة | التراخيص أعلاه مطابقة في الشجرة الفعلية |
| 2 | `README.md` + `[dev-dependencies]` + `tests/` | `cargo test` يعمل (حتى لو فارغًا) |
| 3 | الترحيل 1 | يطبَّق على قاعدة فارغة |
| 4 | `domain/identity/` + اختبارات الوحدة | `cargo test --test unit` |
| 5 | `repositories/identity/` + `SecureTokenStore` | اختبار keyring على جهاز حقيقي |
| 6 | `services/identity/` | اختبارات الوحدة تنجح |
| 7 | `commands/identity/` + ربط `lib.rs` | اختبار translation-فشل |
| 8 | `src/` — Setup + Picker + Shell | `npm run typecheck` |
| 9 | **شريحة المنتجات — لا تبدأ قبل اجتياز اختبارات هذه الشريحة** | — |

---

## 11. بنود مفتوحة تبقى للشريحة التالية

| # | بند | الحالة |
|---|---|---|
| 1 | **O1 — العملة غير مسمّاة** | تعطّل أي عمود سعر/تكلفة. `spec:56` يعرّف `amount_minor` نسبةً إلى عملة **لم تُسمَّ في أي وثيقة** |
| 2 | **O2 — سياسة تقريب العملة الصغرى** | `spec:239` بند 9 |
| 3 | O3 — تصنيف الصنف: كمي أم قطعة IMEI | `spec:175` |
| 4 | O4 — قيم Product disposition | `spec:20`، `spec:221` |
| 5 | O5–O10 — مؤشرات · مدفوعات · ملصقات · مرتجع تالف · ضمانات · استعادة | كما هي |
| 6 | **دعم استعادة الجلسة عند Keychain غير متاح** | `ADR-009` يفرض fail closed؛ **رسالة الخطأ ونوعها قرار تجربة مستخدم** |

---

## 12. سجل القرارات أثناء الصياغة

| القرار | آخر بديل | السبب |
|---|---|---|
| G1 → Password لا PIN | PIN لم يُحسم في الوثائق | محلات صغيرة بعدد مستخدمين قليل، والـPIN القصير قابل للكسر محليًا بلا حدّ محاولات على خادم |
| G3 → `sessions` في SQLite | ذاكرة فقط | طلب بقاء الجلسة بعد إعادة التشغيل |
| P2 → keychain لا `localStorage` | `localStorage` | يجعل اعتمادًا حيًا في متناول JavaScript |
| Q1-A → `keyring-core` + مخازن | Stronghold / plugin wrappers | Stronghold يحتاج كلمة مرور عند التحميل = انسداد معماري؛ والبقية إما `0.1.0` أو تسحب OpenSSL |
| Q2 → Rust فقط | تمرير الرمز للواجهة | يجعل `plan:151` أقوى: الواجهة لا تحمل اعتمادًا إطلاقًا |
| Q4 → fail closed | fallback | لا مسار ضعيف بديل |

**لا يوجد في هذه الخطة أي قرار جديد خارج ما قرّره المالك.** البنود المفتوحة في §11 مُصنَّفة صراحةً ولم تُخمَّن.