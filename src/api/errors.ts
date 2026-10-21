/**
 * Error codes crossing the Rust → frontend boundary.
 *
 * Rust never sends user-facing prose. It sends one of these stable,
 * language-independent codes, and this module owns the Arabic rendering.
 *
 * The split exists because `spec:127` requires user-facing text to live in
 * Arabic message files rather than being scattered through domain logic. It
 * also keeps the Rust side language-agnostic, so another locale could be added
 * without touching Rust.
 *
 * SECURITY: `INVALID_CREDENTIALS` is deliberately the only code for both "no
 * such account" and "wrong password". If those ever became distinguishable, the
 * response would disclose which user identifiers exist. A test in
 * `src-tauri/tests/architecture` asserts that the Rust side collapses them, and
 * a test below asserts this map has no separate entry for a missing account.
 */

/** Every code Rust can emit. Kept exhaustive so a new code is a compile error. */
export const ErrorCode = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_TEMPORARILY_LOCKED: 'ACCOUNT_TEMPORARILY_LOCKED',
  PASSWORD_DOES_NOT_MEET_POLICY: 'PASSWORD_DOES_NOT_MEET_POLICY',
  PIN_DOES_NOT_MEET_POLICY: 'PIN_DOES_NOT_MEET_POLICY',
  PIN_NOT_SET: 'PIN_NOT_SET',
  OWNER_APPROVAL_REQUIRED: 'OWNER_APPROVAL_REQUIRED',
  BOOTSTRAP_ALREADY_COMPLETED: 'BOOTSTRAP_ALREADY_COMPLETED',
  SESSION_IDLE_EXPIRED: 'SESSION_IDLE_EXPIRED',
  SESSION_LIFETIME_EXPIRED: 'SESSION_LIFETIME_EXPIRED',
  NO_ACTIVE_SESSION: 'NO_ACTIVE_SESSION',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  REAUTHENTICATION_REQUIRED: 'REAUTHENTICATION_REQUIRED',
  LOCAL_STORAGE_UNAVAILABLE: 'LOCAL_STORAGE_UNAVAILABLE',
  SECURE_STORAGE_UNAVAILABLE: 'SECURE_STORAGE_UNAVAILABLE',
  // دواءر المستخدم
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  USERNAME_ALREADY_EXISTS: 'USERNAME_ALREADY_EXISTS',
  USERNAME_INVALID: 'USERNAME_INVALID',
  DISPLAY_NAME_REQUIRED: 'DISPLAY_NAME_REQUIRED',
  CANNOT_DISABLE_LAST_MANAGER: 'CANNOT_DISABLE_LAST_MANAGER',
  CANNOT_DISABLE_SELF: 'CANNOT_DISABLE_SELF',
  ACCOUNT_DATA_INTEGRITY_ERROR: 'ACCOUNT_DATA_INTEGRITY_ERROR',
  RECOVERY_CODE_NOT_SET: 'RECOVERY_CODE_NOT_SET',
  // Catalogue
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  BARCODE_ALREADY_EXISTS: 'BARCODE_ALREADY_EXISTS',
  PRODUCT_NAME_REQUIRED: 'PRODUCT_NAME_REQUIRED',
  BARCODE_EMPTY: 'BARCODE_EMPTY',
  PRICE_NEGATIVE: 'PRICE_NEGATIVE',
  PRODUCT_IS_ARCHIVED: 'PRODUCT_IS_ARCHIVED',
  PRODUCT_CATEGORY_NOT_FOUND: 'PRODUCT_CATEGORY_NOT_FOUND',
  SHOP_CODE_EXHAUSTED: 'SHOP_CODE_EXHAUSTED',
  // Money
  MONEY_NEGATIVE: 'MONEY_NEGATIVE',
  // Departments (product classification)
  DEPARTMENT_NAME_REQUIRED: 'DEPARTMENT_NAME_REQUIRED',
  DEPARTMENT_NOT_FOUND: 'DEPARTMENT_NOT_FOUND',
  DEPARTMENT_IS_ARCHIVED: 'DEPARTMENT_IS_ARCHIVED',
  DEPARTMENT_NOT_ARCHIVED: 'DEPARTMENT_NOT_ARCHIVED',
  DEPARTMENT_ARCHIVE_STATE_INCONSISTENT: 'DEPARTMENT_ARCHIVE_STATE_INCONSISTENT',
  DEPARTMENT_COST_METHOD_REQUIRES_SWITCH:
    'DEPARTMENT_COST_METHOD_REQUIRES_SWITCH',
  VAT_RATE_REQUIRED: 'VAT_RATE_REQUIRED',
  VAT_RATE_NEGATIVE: 'VAT_RATE_NEGATIVE',
  // The category tree (ADR-018 §1)
  CATEGORY_NAME_TAKEN: 'CATEGORY_NAME_TAKEN',
  CATEGORY_PARENT_NOT_MAIN: 'CATEGORY_PARENT_NOT_MAIN',
  CATEGORY_ICON_UNKNOWN: 'CATEGORY_ICON_UNKNOWN',
  CATEGORY_KIND_MISMATCH: 'CATEGORY_KIND_MISMATCH',
  CATEGORY_IS_DEFAULT: 'CATEGORY_IS_DEFAULT',
  CATEGORY_HAS_SUBCATEGORIES: 'CATEGORY_HAS_SUBCATEGORIES',
  CATEGORY_NOT_EMPTY: 'CATEGORY_NOT_EMPTY',
  // Phone brands and a new phone (ADR-018 §2)
  BRAND_NOT_FOUND: 'BRAND_NOT_FOUND',
  BRAND_NAME_REQUIRED: 'BRAND_NAME_REQUIRED',
  BRAND_NAME_TAKEN: 'BRAND_NAME_TAKEN',
  BRAND_IS_DEFAULT: 'BRAND_IS_DEFAULT',
  BRAND_NOT_EMPTY: 'BRAND_NOT_EMPTY',
  BRAND_TYPE_UNKNOWN: 'BRAND_TYPE_UNKNOWN',
  PHONE_MODEL_REQUIRED: 'PHONE_MODEL_REQUIRED',
  PHONE_STORAGE_REQUIRED: 'PHONE_STORAGE_REQUIRED',
  PHONE_KEYPAD_HAS_NO_SPECS: 'PHONE_KEYPAD_HAS_NO_SPECS',
  PHONE_SPEC_INVALID: 'PHONE_SPEC_INVALID',
  PHONE_BRAND_TYPE_MISMATCH: 'PHONE_BRAND_TYPE_MISMATCH',
  PHONE_ALREADY_REGISTERED: 'PHONE_ALREADY_REGISTERED',
  PHONE_CATEGORY_NOT_PHONE: 'PHONE_CATEGORY_NOT_PHONE',
  // Product variants (ADR-018 §4)
  VARIANT_CATEGORY_NOT_ITEM: 'VARIANT_CATEGORY_NOT_ITEM',
  VARIANT_DIMENSION_UNKNOWN: 'VARIANT_DIMENSION_UNKNOWN',
  VARIANT_VALUES_REQUIRED: 'VARIANT_VALUES_REQUIRED',
  VARIANT_VALUE_EMPTY: 'VARIANT_VALUE_EMPTY',
  VARIANT_VALUE_DUPLICATE: 'VARIANT_VALUE_DUPLICATE',
  VARIANT_LIMIT_EXCEEDED: 'VARIANT_LIMIT_EXCEEDED',
  VARIANT_PARENT_ALREADY_EXISTS: 'VARIANT_PARENT_ALREADY_EXISTS',
  VARIANT_PRICE_REQUIRED: 'VARIANT_PRICE_REQUIRED',
  VARIANT_BARCODE_DUPLICATE: 'VARIANT_BARCODE_DUPLICATE',
  VARIANT_ROWS_MISMATCH: 'VARIANT_ROWS_MISMATCH',
  // Product images (ADR-018 §5)
  IMAGE_EMPTY: 'IMAGE_EMPTY',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  IMAGE_NOT_JPEG: 'IMAGE_NOT_JPEG',
  IMAGE_DIMENSIONS_INVALID: 'IMAGE_DIMENSIONS_INVALID',
  IMAGE_NOT_FOUND: 'IMAGE_NOT_FOUND',

  // وحدات IMEI والاستلام (ADR-019)
  IMEI_LENGTH_INVALID: 'IMEI_LENGTH_INVALID',
  IMEI_CHECK_DIGIT_INVALID: 'IMEI_CHECK_DIGIT_INVALID',
  IMEI_ALREADY_REGISTERED: 'IMEI_ALREADY_REGISTERED',
  IMEI_DUPLICATE_IN_BATCH: 'IMEI_DUPLICATE_IN_BATCH',
  IMEI_COUNT_EXCEEDS_QUANTITY: 'IMEI_COUNT_EXCEEDS_QUANTITY',
  IMEI_REQUIRED_FOR_ALL_UNITS: 'IMEI_REQUIRED_FOR_ALL_UNITS',
  IMEI_PRODUCT_NOT_SERIAL_TRACKED: 'IMEI_PRODUCT_NOT_SERIAL_TRACKED',
  IMEI_UNIT_NOT_AVAILABLE: 'IMEI_UNIT_NOT_AVAILABLE',
  IMEI_UNIT_PRODUCT_MISMATCH: 'IMEI_UNIT_PRODUCT_MISMATCH',
  IMEI_NO_UNREGISTERED_STOCK: 'IMEI_NO_UNREGISTERED_STOCK',
  IMEI_SECONDARY_MATCHES_PRIMARY: 'IMEI_SECONDARY_MATCHES_PRIMARY',
  RECEIPT_OPENING_HAS_SUPPLIER: 'RECEIPT_OPENING_HAS_SUPPLIER',
  RECEIPT_KIND_INVALID: 'RECEIPT_KIND_INVALID',
  UNIT_COLOR_TOO_LONG: 'UNIT_COLOR_TOO_LONG',
  UNIT_GRADE_INVALID: 'UNIT_GRADE_INVALID',
  UNIT_BATTERY_HEALTH_INVALID: 'UNIT_BATTERY_HEALTH_INVALID',
  UNIT_NATIONAL_ID_INVALID: 'UNIT_NATIONAL_ID_INVALID',
  UNIT_NOTE_TOO_LONG: 'UNIT_NOTE_TOO_LONG',

  // الإعدادات


  SETTING_UNKNOWN_KEY: 'SETTING_UNKNOWN_KEY',
  SETTING_VALUE_INVALID: 'SETTING_VALUE_INVALID',

  // التكلفة (ADR-013)
  COST_NEGATIVE_QUANTITY: 'COST_NEGATIVE_QUANTITY',
  COST_NEGATIVE_TOTAL: 'COST_NEGATIVE_TOTAL',
  COST_INSUFFICIENT_STOCK: 'COST_INSUFFICIENT_STOCK',
  COST_ZERO_UNITS: 'COST_ZERO_UNITS',
  COST_OVERFLOW: 'COST_OVERFLOW',

  // المخزون (ADR-015)
  STOCK_PRODUCT_NOT_FOUND: 'STOCK_PRODUCT_NOT_FOUND',
  STOCK_COST_AUTHORITY_CONFLICT: 'STOCK_COST_AUTHORITY_CONFLICT',

  // البيع (Sales V1)
  SALE_EMPTY: 'SALE_EMPTY',
  SALE_PRODUCT_ARCHIVED: 'SALE_PRODUCT_ARCHIVED',
  SALE_NOT_FOUND: 'SALE_NOT_FOUND',
  SALE_PRICE_CHANGED: 'SALE_PRICE_CHANGED',
  SALE_DISPOSITION_NOT_SUPPORTED: 'SALE_DISPOSITION_NOT_SUPPORTED',
  SALE_PRICE_NOT_SET: 'SALE_PRICE_NOT_SET',
  SALE_INVALID_QUANTITY: 'SALE_INVALID_QUANTITY',
  SALE_REFERENCE_CONFLICT: 'SALE_REFERENCE_CONFLICT',
  SALE_ALREADY_CANCELLED: 'SALE_ALREADY_CANCELLED',
  SALE_REVERSAL_INCONSISTENT: 'SALE_REVERSAL_INCONSISTENT',
  SALE_BUSY: 'SALE_BUSY',
  SALE_CUSTOMER_ALREADY_LINKED: 'SALE_CUSTOMER_ALREADY_LINKED',
  SALE_LINK_NOT_ALLOWED: 'SALE_LINK_NOT_ALLOWED',
  SALE_WARRANTY_DATE_INVALID: 'SALE_WARRANTY_DATE_INVALID',
  SALE_WARRANTY_RANGE_INVALID: 'SALE_WARRANTY_RANGE_INVALID',
  SALE_PAYMENT_MISSING: 'SALE_PAYMENT_MISSING',
  SALE_PAYMENT_METHOD_INVALID: 'SALE_PAYMENT_METHOD_INVALID',
  SALE_PAYMENT_METHOD_DISABLED: 'SALE_PAYMENT_METHOD_DISABLED',
  SALE_PAYMENT_AMOUNT_INVALID: 'SALE_PAYMENT_AMOUNT_INVALID',
  SALE_PAYMENT_TOTAL_MISMATCH: 'SALE_PAYMENT_TOTAL_MISMATCH',
  SALE_PAYMENT_REFERENCE_INVALID: 'SALE_PAYMENT_REFERENCE_INVALID',
  SALE_INSTALLMENT_PROVIDER_REQUIRED: 'SALE_INSTALLMENT_PROVIDER_REQUIRED',
  SALE_CREDIT_REQUIRES_CUSTOMER: 'SALE_CREDIT_REQUIRES_CUSTOMER',
  SALE_DISCOUNT_INVALID: 'SALE_DISCOUNT_INVALID',
  SALE_RETURN_EMPTY: 'SALE_RETURN_EMPTY',
  SALE_RETURN_LINE_NOT_FOUND: 'SALE_RETURN_LINE_NOT_FOUND',
  SALE_RETURN_QUANTITY_EXCEEDS_REMAINING: 'SALE_RETURN_QUANTITY_EXCEEDS_REMAINING',
  SALE_RETURN_CONDITION_INVALID: 'SALE_RETURN_CONDITION_INVALID',
  SALE_RETURN_REASON_REQUIRED: 'SALE_RETURN_REASON_REQUIRED',
  SALE_PAYMENT_WALLET_INVALID: 'SALE_PAYMENT_WALLET_INVALID',

  // النسخ الاحتياطي المشفّر (ADR-003)
  BACKUP_NOT_A_BACKUP_FILE: 'BACKUP_NOT_A_BACKUP_FILE',
  BACKUP_UNSUPPORTED_VERSION: 'BACKUP_UNSUPPORTED_VERSION',
  BACKUP_UNSUPPORTED_ALGORITHM: 'BACKUP_UNSUPPORTED_ALGORITHM',
  BACKUP_FILE_TRUNCATED: 'BACKUP_FILE_TRUNCATED',
  BACKUP_HEADER_INVALID: 'BACKUP_HEADER_INVALID',
  BACKUP_KDF_PARAMS_INVALID: 'BACKUP_KDF_PARAMS_INVALID',
  BACKUP_PAYLOAD_TOO_LARGE: 'BACKUP_PAYLOAD_TOO_LARGE',
  BACKUP_DECRYPT_FAILED: 'BACKUP_DECRYPT_FAILED',
  BACKUP_MANIFEST_INVALID: 'BACKUP_MANIFEST_INVALID',
  BACKUP_CONTENT_INVALID: 'BACKUP_CONTENT_INVALID',
  BACKUP_UNSAFE_PATH: 'BACKUP_UNSAFE_PATH',
  BACKUP_DUPLICATE_COMPONENT: 'BACKUP_DUPLICATE_COMPONENT',
  BACKUP_MISSING_DATABASE: 'BACKUP_MISSING_DATABASE',
  BACKUP_PASSWORD_REQUIRED: 'BACKUP_PASSWORD_REQUIRED',
  BACKUP_PASSWORD_TOO_WEAK: 'BACKUP_PASSWORD_TOO_WEAK',
  BACKUP_CREATE_FAILED: 'BACKUP_CREATE_FAILED',
  BACKUP_RESTORE_FAILED: 'BACKUP_RESTORE_FAILED',
  BACKUP_RECOVERY_INCOMPLETE: 'BACKUP_RECOVERY_INCOMPLETE',
  BACKUP_USB_NOT_CONNECTED: 'BACKUP_USB_NOT_CONNECTED',
  BACKUP_NOT_FOUND: 'BACKUP_NOT_FOUND',

  // ملف العملاء (P4، spec:178-179)
  CUSTOMER_NAME_INVALID: 'CUSTOMER_NAME_INVALID',

  // اسم المورد على الاستلام (D1)
  SUPPLIER_NAME_REQUIRED: 'SUPPLIER_NAME_REQUIRED',
  SUPPLIER_NAME_TOO_LONG: 'SUPPLIER_NAME_TOO_LONG',
  CUSTOMER_CONTACT_INVALID: 'CUSTOMER_CONTACT_INVALID',
  CUSTOMER_NOT_FOUND: 'CUSTOMER_NOT_FOUND',
  CUSTOMER_IS_ARCHIVED: 'CUSTOMER_IS_ARCHIVED',
  CUSTOMER_PAYMENT_AMOUNT_INVALID: 'CUSTOMER_PAYMENT_AMOUNT_INVALID',
  CUSTOMER_PAYMENT_EXCEEDS_BALANCE: 'CUSTOMER_PAYMENT_EXCEEDS_BALANCE',
  CUSTOMER_PAYMENT_METHOD_INVALID: 'CUSTOMER_PAYMENT_METHOD_INVALID',
  CUSTOMER_PAYMENT_WALLET_INVALID: 'CUSTOMER_PAYMENT_WALLET_INVALID',
  CUSTOMER_NOTE_INVALID: 'CUSTOMER_NOTE_INVALID',

  // الوردية والدرج والمصروفات (البند 1.9، ADR-024)
  SHIFT_ALREADY_OPEN: 'SHIFT_ALREADY_OPEN',
  SHIFT_NOT_OPEN: 'SHIFT_NOT_OPEN',
  SHIFT_OPENING_CASH_INVALID: 'SHIFT_OPENING_CASH_INVALID',
  SHIFT_COUNTED_CASH_INVALID: 'SHIFT_COUNTED_CASH_INVALID',
  SHIFT_CLOSE_NOTE_INVALID: 'SHIFT_CLOSE_NOTE_INVALID',
  SHIFT_CLOSE_FORBIDDEN_FOR_SELLER: 'SHIFT_CLOSE_FORBIDDEN_FOR_SELLER',
  EXPENSE_CATEGORY_INVALID: 'EXPENSE_CATEGORY_INVALID',
  EXPENSE_AMOUNT_INVALID: 'EXPENSE_AMOUNT_INVALID',
  EXPENSE_NOTE_INVALID: 'EXPENSE_NOTE_INVALID',
  EXPENSE_PAID_FROM_INVALID: 'EXPENSE_PAID_FROM_INVALID',
  CASH_MOVEMENT_KIND_INVALID: 'CASH_MOVEMENT_KIND_INVALID',
  CASH_MOVEMENT_AMOUNT_INVALID: 'CASH_MOVEMENT_AMOUNT_INVALID',
  CASH_MOVEMENT_REASON_INVALID: 'CASH_MOVEMENT_REASON_INVALID',

  // المحافظ ودفتر الخدمات (البند 1.10، ADR-025)
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  WALLET_NAME_INVALID: 'WALLET_NAME_INVALID',
  WALLET_NAME_DUPLICATE: 'WALLET_NAME_DUPLICATE',
  WALLET_NUMBER_INVALID: 'WALLET_NUMBER_INVALID',
  WALLET_COMPANY_INVALID: 'WALLET_COMPANY_INVALID',
  WALLET_COLOR_INVALID: 'WALLET_COLOR_INVALID',
  WALLET_LIMIT_INVALID: 'WALLET_LIMIT_INVALID',
  WALLET_PAY_METHOD_INVALID: 'WALLET_PAY_METHOD_INVALID',
  WALLET_DELETE_FORBIDDEN: 'WALLET_DELETE_FORBIDDEN',
  WALLET_INSUFFICIENT_BALANCE: 'WALLET_INSUFFICIENT_BALANCE',
  WALLET_OP_KIND_INVALID: 'WALLET_OP_KIND_INVALID',
  WALLET_OP_AMOUNT_INVALID: 'WALLET_OP_AMOUNT_INVALID',
  WALLET_OP_FEE_INVALID: 'WALLET_OP_FEE_INVALID',
  WALLET_OP_FEE_EXCEEDS_AMOUNT: 'WALLET_OP_FEE_EXCEEDS_AMOUNT',
  WALLET_OP_NOTE_INVALID: 'WALLET_OP_NOTE_INVALID',
  WALLET_OP_NOT_FOUND: 'WALLET_OP_NOT_FOUND',
  WALLET_OP_ALREADY_VOIDED: 'WALLET_OP_ALREADY_VOIDED',
  WALLET_VOID_REASON_REQUIRED: 'WALLET_VOID_REASON_REQUIRED',

  // النواقص (البند 1.15، ADR-030)
  SHORTAGE_NAME_REQUIRED: 'SHORTAGE_NAME_REQUIRED',
  SHORTAGE_QTY_INVALID: 'SHORTAGE_QTY_INVALID',
  SHORTAGE_NOTE_TOO_LONG: 'SHORTAGE_NOTE_TOO_LONG',
  SHORTAGE_CUSTOMER_INVALID: 'SHORTAGE_CUSTOMER_INVALID',
  SHORTAGE_STATUS_INVALID: 'SHORTAGE_STATUS_INVALID',
  SHORTAGE_NOT_FOUND: 'SHORTAGE_NOT_FOUND',
  SHORTAGE_DELETE_FORBIDDEN: 'SHORTAGE_DELETE_FORBIDDEN',

  // الصيانة والسوفت وير (البند 2.1، ADR-031)
  REPAIR_CUSTOMER_REQUIRED: 'REPAIR_CUSTOMER_REQUIRED',
  REPAIR_DEVICE_REQUIRED: 'REPAIR_DEVICE_REQUIRED',
  REPAIR_ISSUE_REQUIRED: 'REPAIR_ISSUE_REQUIRED',
  REPAIR_AMOUNT_INVALID: 'REPAIR_AMOUNT_INVALID',
  REPAIR_STATUS_INVALID: 'REPAIR_STATUS_INVALID',
  REPAIR_PAY_METHOD_INVALID: 'REPAIR_PAY_METHOD_INVALID',
  REPAIR_PAY_WALLET_INVALID: 'REPAIR_PAY_WALLET_INVALID',

  // الربط بين الموبايل والكمبيوتر (`ADR-042`)
  COMPANION_NO_HOST: 'COMPANION_NO_HOST',
  COMPANION_INTAKE_REFUSED: 'COMPANION_INTAKE_REFUSED',
  COMPANION_INTAKE_GONE: 'COMPANION_INTAKE_GONE',
  COMPANION_INTAKE_NOT_RECEIVABLE: 'COMPANION_INTAKE_NOT_RECEIVABLE',
  REPAIR_NOT_FOUND: 'REPAIR_NOT_FOUND',
  REPAIR_ALREADY_DELIVERED: 'REPAIR_ALREADY_DELIVERED',
  REPAIR_ALREADY_CANCELLED: 'REPAIR_ALREADY_CANCELLED'
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** The shape Rust serialises for a failed command. */
export interface CommandError {
  readonly code: string;
}

/**
 * Arabic messages, keyed by code.
 *
 * Recorded here rather than inline so the wording is reviewable in one place and
 * a translator can work on this file alone.
 */
const MESSAGES_AR: Readonly<Record<ErrorCodeValue, string>> = {
  // اسم المورد على الاستلام (D1) — مثبّت في أول الجدول حتى يبقى كل كود له رسالة
  [ErrorCode.SUPPLIER_NAME_REQUIRED]:
    'اسم المورد لازم يكون مكتوب فعلًا. سيبه فاضي لو مش عارف المورد.',
  [ErrorCode.SUPPLIER_NAME_TOO_LONG]:
    'اسم المورد طويل جدًا. اختصره.',
  [ErrorCode.INVALID_CREDENTIALS]: 'بيانات الدخول غير صحيحة',
  [ErrorCode.ACCOUNT_TEMPORARILY_LOCKED]:
    'الحساب مقفل مؤقتًا بسبب محاولات دخول فاشلة. حاول مرة أخرى بعد قليل.',
  [ErrorCode.PASSWORD_DOES_NOT_MEET_POLICY]:
    'كلمة المرور لا تحقق الحد المطلوب، ثمانية أحرف على الأقل.',
  [ErrorCode.PIN_DOES_NOT_MEET_POLICY]: 'الـPIN لازم يكون من 4 لـ6 أرقام.',
  [ErrorCode.PIN_NOT_SET]: 'الحساب ده لسه ماعندوش PIN. ادخل بكلمة السر وحطّ PIN.',
  [ErrorCode.OWNER_APPROVAL_REQUIRED]: 'العملية دي محتاجة موافقة المالك بالـPIN.',
  [ErrorCode.BOOTSTRAP_ALREADY_COMPLETED]:
    'تم إعداد هذا الجهاز بالفعل ولا يمكن إنشاء حساب آخر.',
  [ErrorCode.SESSION_IDLE_EXPIRED]:
    'انتهت الجلسة بسبب عدم النشاط. يُرجى تسجيل الدخول مرة أخرى.',
  [ErrorCode.SESSION_LIFETIME_EXPIRED]:
    'انتهت مدة الجلسة القصوى. يُرجى تسجيل الدخول مرة أخرى.',
  [ErrorCode.NO_ACTIVE_SESSION]: 'لا توجد جلسة نشطة. يُرجى تسجيل الدخول.',
  [ErrorCode.PERMISSION_DENIED]: 'ليست لديك صلاحية للقيام بهذا الإجراء.',
  [ErrorCode.REAUTHENTICATION_REQUIRED]:
    'يلزم إعادة إدخال كلمة المرور لعرض هذه البيانات.',
  [ErrorCode.LOCAL_STORAGE_UNAVAILABLE]:
    'تعذّر الوصول إلى قاعدة بيانات المحل. يُرجى إبلاغ المسؤول الفني.',
  [ErrorCode.SECURE_STORAGE_UNAVAILABLE]:
    'تعذّر الوصول إلى مخزن الأمان في الجهاز. لم يتم تسجيل الدخول.',

  // دواءر المستخدم
  [ErrorCode.PASSWORD_CHANGE_REQUIRED]:
    'مملوم تغيير كلمة المرور قبل الاستخدام.',
  [ErrorCode.ACCOUNT_DISABLED]:
    'هذا الحساب معطّل. ليُقد المدير بتعادية إعادة تشغيله.',
  [ErrorCode.USERNAME_ALREADY_EXISTS]:
    'هذا اسم المستخدم محجوز.',
  [ErrorCode.USERNAME_INVALID]:
    'اسم المستخدم غير صحيح. استخدم أحرف وأرقام ونقط مادة من 3 إلى 32.',
  [ErrorCode.DISPLAY_NAME_REQUIRED]: 'اسم المعرض مطلوب.',
  [ErrorCode.CANNOT_DISABLE_LAST_MANAGER]:
    'لا يُمكن تعطيل المدير الوحيد لأنه المصدر الوحيد للإدارة الجهاز.',
  [ErrorCode.CANNOT_DISABLE_SELF]:
    'لا يُمكن تعطيل حسابك الشخصي.',
  [ErrorCode.ACCOUNT_DATA_INTEGRITY_ERROR]:
    'بيانات هذا الحساب غير مكتملة. كلّم المسؤول الفني عن الجهاز.',
  [ErrorCode.RECOVERY_CODE_NOT_SET]:
    'الحساب ده ماعندوش كود استرجاع. الكود بيتعمل من الإعدادات وانت فاكر كلمة السر.',

  // الكتالوغ
  [ErrorCode.PRODUCT_NOT_FOUND]: 'المنتج غير موجود.',
  [ErrorCode.BARCODE_ALREADY_EXISTS]:
    'هذا الباركود مستخدم لمنتج آخر.',
  [ErrorCode.PRODUCT_NAME_REQUIRED]: 'اسم المنتج مطلوب.',
  [ErrorCode.BARCODE_EMPTY]: 'الباركود لا يُقبل فارغاً.',
  [ErrorCode.PRICE_NEGATIVE]: 'لا يُقبل أن يكون السعر سالبي.',
  [ErrorCode.PRODUCT_IS_ARCHIVED]:
    'هذا المنتج مؤرشف. لا يُمكن تعديله ما لم يُرشف من الأرشيف.',
  [ErrorCode.PRODUCT_CATEGORY_NOT_FOUND]:
    'التصنيف ده مش موجود دلوقتي. حدّث الصفحة واختار تصنيف تاني.',
  [ErrorCode.SHOP_CODE_EXHAUSTED]:
    'أكواد المحل الداخلية خلصت. اكتب باركود بنفسك.',

  // المال
  // Currently unreachable from a command: a catalogue price converts a negative
  // into PRICE_NEGATIVE before it crosses the boundary. Declared because the
  // architecture guard scans the code table in both directions against the Rust
  // source, and would fail the build on a code it can see but has no message for.
  [ErrorCode.MONEY_NEGATIVE]: 'لا يُقبل أن يكون المبلغ سالبًا.',

  // الأقسام (تصنيف المنتجات)
  [ErrorCode.DEPARTMENT_NOT_FOUND]: 'التصنيف ده مش موجود. حدّث الصفحة.',
  [ErrorCode.DEPARTMENT_NAME_REQUIRED]: 'اكتب اسم التصنيف.',
  [ErrorCode.DEPARTMENT_IS_ARCHIVED]:
    'التصنيف ده مؤرشف، ومش بيتعدّل.',
  [ErrorCode.DEPARTMENT_NOT_ARCHIVED]:
    'هذا القسم نشط بالفعل. لا يوجد ما يسترجعه.',
  [ErrorCode.DEPARTMENT_ARCHIVE_STATE_INCONSISTENT]:
    'بيانات القسم غير مكتملة. كلّم المسؤول الفني عن الجهاز.',
  [ErrorCode.DEPARTMENT_COST_METHOD_REQUIRES_SWITCH]:
    'طريقة حساب التكلفة ثابتة: كل الأصناف بالعدد بتتحسب بالمتوسط المرجح، ومفيش تغيير ليها.',
  [ErrorCode.VAT_RATE_REQUIRED]:
    'يجب تحديد نسبة ضريبة قبل تفعيل الضريبة على القسم.',
  [ErrorCode.VAT_RATE_NEGATIVE]: 'لا يُقبل أن تكون نسبة الضريبة سالبة.',

  // التصنيفات
  [ErrorCode.CATEGORY_NAME_TAKEN]: 'فيه تصنيف بالاسم ده بالفعل.',
  [ErrorCode.CATEGORY_PARENT_NOT_MAIN]: 'التصنيف الفرعي بيبقى تحت تصنيف رئيسي بس.',
  [ErrorCode.CATEGORY_ICON_UNKNOWN]: 'اختار أيقونة من اللي ظاهرين.',
  [ErrorCode.CATEGORY_KIND_MISMATCH]: 'التصنيف الفرعي بيتسجّل زي الرئيسي بتاعه.',
  [ErrorCode.CATEGORY_IS_DEFAULT]: 'ده من التصنيفات الأساسية: تقدر تغيّر اسمه أو تخفيه، بس مش بيتمسح.',
  [ErrorCode.CATEGORY_HAS_SUBCATEGORIES]: 'التصنيف ده تحته تصنيفات. امسحهم الأول.',
  [ErrorCode.CATEGORY_NOT_EMPTY]: 'التصنيف ده فيه أصناف. انقلها لتصنيف تاني الأول.',

  // شركات الموبايلات والموبايل الجديد
  [ErrorCode.BRAND_NOT_FOUND]: 'الشركة دي مش موجودة. حدّث الصفحة.',
  [ErrorCode.BRAND_NAME_REQUIRED]: 'اكتب اسم الشركة.',
  [ErrorCode.BRAND_NAME_TAKEN]: 'فيه شركة بالاسم ده بالفعل.',
  [ErrorCode.BRAND_IS_DEFAULT]: 'دي من الشركات الأساسية: تقدر تغيّر اسمها أو تخفيها، بس مش بتتمسح.',
  [ErrorCode.BRAND_NOT_EMPTY]: 'الشركة دي ليها موبايلات متسجّلة، فمش بتتمسح. تقدر تخفيها.',
  [ErrorCode.BRAND_TYPE_UNKNOWN]: 'اختار تاتش أو زراير أو الاتنين.',
  [ErrorCode.PHONE_MODEL_REQUIRED]: 'اكتب الموديل.',
  [ErrorCode.PHONE_STORAGE_REQUIRED]: 'اختار المساحة.',
  [ErrorCode.PHONE_KEYPAD_HAS_NO_SPECS]: 'الموبايل الزراير ملوش مساحة ولا رام.',
  [ErrorCode.PHONE_SPEC_INVALID]: 'المساحة أو الرام لازم رقم أكبر من صفر.',
  [ErrorCode.PHONE_BRAND_TYPE_MISMATCH]: 'الشركة دي مش بتعمل النوع ده من الموبايلات (من الإعدادات).',
  [ErrorCode.PHONE_ALREADY_REGISTERED]: 'الموبايل ده متسجّل بالفعل بنفس الشركة والموديل والمساحة والرام.',
  [ErrorCode.PHONE_CATEGORY_NOT_PHONE]: 'الموبايل بيتسجّل في تصنيف «جهاز جهاز بالـ IMEI».',

  // تفرعات الأصناف (ADR-018 §4)
  [ErrorCode.VARIANT_CATEGORY_NOT_ITEM]: 'التفرعات للأصناف بالعدد بس.',
  [ErrorCode.VARIANT_DIMENSION_UNKNOWN]: 'اختار التفرع من القائمة.',
  [ErrorCode.VARIANT_VALUES_REQUIRED]: 'اكتب نوع واحد على الأقل ودوس Enter بعد كل واحد.',
  [ErrorCode.VARIANT_VALUE_EMPTY]: 'اكتب اسم النوع.',
  [ErrorCode.VARIANT_VALUE_DUPLICATE]: 'النوع ده مكتوب بالفعل.',
  [ErrorCode.VARIANT_LIMIT_EXCEEDED]: 'الأنواع كتير على صنف واحد (الحد 60). قسّمه لأكتر من صنف.',
  [ErrorCode.VARIANT_PARENT_ALREADY_EXISTS]: 'الصنف ده متسجّل بالفعل في نفس التصنيف.',
  [ErrorCode.VARIANT_PRICE_REQUIRED]: 'اكتب سعر البيع.',
  [ErrorCode.VARIANT_BARCODE_DUPLICATE]: 'نفس الباركود مكتوب على أكتر من نوع.',
  [ErrorCode.VARIANT_ROWS_MISMATCH]: 'عدد صفوف الأنواع مش مطابق للأنواع المكتوبة. حدّث الصفحة وجرّب تاني.',

  // صور الأصناف (ADR-018 §5)
  [ErrorCode.IMAGE_EMPTY]: 'اختر صورة للصنف.',
  [ErrorCode.IMAGE_TOO_LARGE]: 'حجم الصورة كبير. الصنف بيقبل صورة 192×192 لحد 64 ك.ب.',
  [ErrorCode.IMAGE_NOT_JPEG]: 'ملف الصورة مش شغّال. اختار صورة تانية.',
  [ErrorCode.IMAGE_DIMENSIONS_INVALID]: 'الصورة لازم تكون مربع 192×192.',
  [ErrorCode.IMAGE_NOT_FOUND]: 'الصنف ده ملوش صورة متسجّلة.',

  // وحدات IMEI والاستلام (ADR-019)
  [ErrorCode.IMEI_LENGTH_INVALID]: 'الـ IMEI لازم يكون 15 رقم بالظبط.',
  [ErrorCode.IMEI_CHECK_DIGIT_INVALID]: 'رقم الـ IMEI فيه رقم غلط (فحص Luhn). راجع العلبة أو اكتب *#06#.',
  [ErrorCode.IMEI_ALREADY_REGISTERED]: 'الـ IMEI ده متسجّل بالفعل في المحل.',
  [ErrorCode.IMEI_DUPLICATE_IN_BATCH]: 'نفس الـ IMEI مكتوب مرتين.',
  [ErrorCode.IMEI_COUNT_EXCEEDS_QUANTITY]: 'عدد أرقام الـ IMEI أكتر من الكمية المستلمة.',
  [ErrorCode.IMEI_REQUIRED_FOR_ALL_UNITS]: 'وضع الـ IMEI إلزامي: سجّل IMEI لكل جهاز.',
  [ErrorCode.IMEI_PRODUCT_NOT_SERIAL_TRACKED]: 'الصنف ده بيتعد بالعدد بس وملوش IMEI.',
  [ErrorCode.IMEI_UNIT_NOT_AVAILABLE]: 'الجهاز ده مباع أو متشال من المخزن ومش متاح للبيع.',
  [ErrorCode.IMEI_UNIT_PRODUCT_MISMATCH]: 'الـ IMEI ده متسجّل تحت موبايل تاني.',
  [ErrorCode.IMEI_NO_UNREGISTERED_STOCK]: 'كل الأجهزة المتاحة من الموبايل ده متسجّل ليها IMEI بالفعل — اختار واحد من القائمة.',
  [ErrorCode.RECEIPT_OPENING_HAS_SUPPLIER]: 'رصيد أول المدة بضاعة موجودة عندك ومينفعش يتحط ليها اسم مورد.',
  [ErrorCode.RECEIPT_KIND_INVALID]: 'نوع الاستلام غير معروف.',
  [ErrorCode.UNIT_COLOR_TOO_LONG]: 'اسم اللون طويل زيادة عن اللزوم.',


  // الإعدادات


  [ErrorCode.SETTING_UNKNOWN_KEY]: 'إعداد غير معروف.',
  [ErrorCode.SETTING_VALUE_INVALID]: 'قيمة الإعداد غير صحيحة.',

  // التكلفة (ADR-013)
  [ErrorCode.COST_NEGATIVE_QUANTITY]:
    'كمية غير صحيحة. لا يُقبل أن تكون الكمية سالبة أو صفرًا عند الخصم.',
  [ErrorCode.COST_NEGATIVE_TOTAL]: 'إجمالي تكلفة غير صحيح. لا يُقبل أن يكون سالبًا.',
  [ErrorCode.COST_INSUFFICIENT_STOCK]:
    'الكمية المطلوبة أكبر من الكمية المتوفرة في المخزن.',
  [ErrorCode.COST_ZERO_UNITS]: 'لا يُقبل حذف صفر وحدات من المخزن.',
  [ErrorCode.COST_OVERFLOW]:
    'قيمة التكلفة أكبر من الحد المسموح. راجع الكمية أو سعر التوريد.',

  // المخزون (ADR-015)
  [ErrorCode.STOCK_PRODUCT_NOT_FOUND]:
    'المنتج غير موجود، فلا يمكن تسجيل حركة مخزون له.',
  [ErrorCode.STOCK_COST_AUTHORITY_CONFLICT]:
    'بيانات تكلفة الصنف ده مش متسقة، فالعملية اترفضت ومحصلش أي تغيير. كلّم المسؤول الفني عن الجهاز.',

  // البيع (Sales V1)
  [ErrorCode.SALE_EMPTY]: 'لا يمكن تسجيل عملية بيع بدون بنود.',
  [ErrorCode.SALE_PRODUCT_ARCHIVED]:
    'هذا المنتج مؤرشف ولا يمكن بيعه.',
  [ErrorCode.SALE_NOT_FOUND]: 'لا توجد عملية بيع بهذا المعرّف.',
  [ErrorCode.SALE_PRICE_CHANGED]:
    'تغيّر السعر بعد تأكيد الإجمالي. راجع الأسعار وأكّد من جديد.',
  [ErrorCode.SALE_DISPOSITION_NOT_SUPPORTED]:
    'لا يمكن بيع هذا النوع من المنتجات في هذه النسخة.',
  [ErrorCode.SALE_PRICE_NOT_SET]:
    'لا يوجد سعر بيع لهذا المنتج. حدّد السعر أولاً.',
  [ErrorCode.SALE_INVALID_QUANTITY]: 'الكمية غير صحيحة. لا بد أن تكون أكبر من صفر.',
  [ErrorCode.SALE_REFERENCE_CONFLICT]:
    'تعذّر توليد رقم الفاتورة لهذا اليوم. راجع إعداد بادئة الفاتورة.',
  [ErrorCode.SALE_ALREADY_CANCELLED]: 'تم إلغاء عملية البيع هذه من قبل.',
  [ErrorCode.SALE_REVERSAL_INCONSISTENT]:
    'تعذّر إلغاء العملية: المخزن أو طريقة التكلفة تغيّرا منذ البيع. كلّم المسؤول الفني عن الجهاز.',
  [ErrorCode.SALE_BUSY]:
    'المحل مشغول بكتابة أخرى. أعد المحاولة بعد لحظة.',
  [ErrorCode.SALE_CUSTOMER_ALREADY_LINKED]:
    'عملية البيع هذه مرتبطة بعميل بالفعل. لا يمكن تغيير الارتباط.',
  [ErrorCode.SALE_LINK_NOT_ALLOWED]:
    'فقط فاتورة البيع الأصلية تقبل عميلًا. المرتجعات تتبع الأصل.',
  [ErrorCode.SALE_WARRANTY_DATE_INVALID]:
    'تاريخ الضمان غير صحيح. اكتبه بالصيغة سنة-شهر-يوم مثل 2027-03-15.',
  [ErrorCode.SALE_WARRANTY_RANGE_INVALID]:
    'نهاية الضمان قبل بدايته. راجع التاريخين.',
  [ErrorCode.SALE_PAYMENT_MISSING]:
    'اختار طريقة دفع واحدة على الأقل.',
  [ErrorCode.SALE_PAYMENT_METHOD_INVALID]:
    'طريقة الدفع دي غير معروفة.',
  [ErrorCode.SALE_PAYMENT_METHOD_DISABLED]:
    'طريقة الدفع دي مقفولة من الإعدادات.',
  [ErrorCode.SALE_PAYMENT_AMOUNT_INVALID]:
    'مبلغ الدفع لازم يكون أكبر من صفر.',
  [ErrorCode.SALE_PAYMENT_TOTAL_MISMATCH]:
    'مجموع المدفوع مش بيساوي المطلوب في الفاتورة.',
  [ErrorCode.SALE_PAYMENT_REFERENCE_INVALID]:
    'مرجع عملية الدفع طويل زيادة عن اللزوم.',
  [ErrorCode.SALE_INSTALLMENT_PROVIDER_REQUIRED]:
    'اختار شركة التقسيط الأول.',
  [ErrorCode.SALE_CREDIT_REQUIRES_CUSTOMER]:
    'البيع الآجل لازم يتربط بعميل متسجّل.',
  [ErrorCode.SALE_DISCOUNT_INVALID]:
    'قيمة الخصم غير صالحة أو أكبر من إجمالي الصنف أو الفاتورة.',
  [ErrorCode.SALE_RETURN_EMPTY]:
    'اختار صنف واحد على الأقل للمرتجع.',
  [ErrorCode.SALE_RETURN_LINE_NOT_FOUND]:
    'سطر الفاتورة المطلوب إرجاعه مش موجود في الفاتورة دي.',
  [ErrorCode.SALE_RETURN_QUANTITY_EXCEEDS_REMAINING]:
    'الكمية المرتجعة أكبر من الكمية المتبقية في سطر الفاتورة.',
  [ErrorCode.SALE_RETURN_CONDITION_INVALID]:
    'حالة الصنف المرتجع غير صحيحة — اختار سليم أو تالف.',
  [ErrorCode.SALE_RETURN_REASON_REQUIRED]:
    'اكتب سبب المرتجع قبل الحفظ.',
  [ErrorCode.SALE_PAYMENT_WALLET_INVALID]:
    'الرقم اللي اخترته ما بيستقبلش الطريقة دي — اختار رقم تاني، أو سيبه فاضي يتسجّل على الأساسي.',

  // النسخ الاحتياطي المشفّر (ADR-003)
  [ErrorCode.BACKUP_NOT_A_BACKUP_FILE]:
    'هذا الملف ليس نسخة احتياطية صالحة لهذا البرنامج.',
  [ErrorCode.BACKUP_UNSUPPORTED_VERSION]:
    'إصدار النسخة الاحتياطية أحدث من أن يقرأه هذا الجهاز.',
  [ErrorCode.BACKUP_UNSUPPORTED_ALGORITHM]:
    'تشفير هذه النسخة الاحتياطية غير معروف لهذا الجهاز.',
  [ErrorCode.BACKUP_FILE_TRUNCATED]:
    'ملف النسخة الاحتياطية ناقص أو غير مكتمل.',
  [ErrorCode.BACKUP_HEADER_INVALID]:
    'ترويسة النسخة الاحتياطية تالفة.',
  [ErrorCode.BACKUP_KDF_PARAMS_INVALID]:
    'إعدادات استخلاص المفتاح في النسخة الاحتياطية غير مقبولة.',
  [ErrorCode.BACKUP_PAYLOAD_TOO_LARGE]:
    'حجم النسخة الاحتياطية أكبر من الحد المسموح.',
  [ErrorCode.BACKUP_DECRYPT_FAILED]:
    'تعذّر فتح النسخة الاحتياطية: كلمة المرور غير صحيحة أو الملف معدّل أو تالف.',
  [ErrorCode.BACKUP_MANIFEST_INVALID]:
    'فهرس محتوى النسخة الاحتياطية غير صالح.',
  [ErrorCode.BACKUP_CONTENT_INVALID]:
    'محتوى النسخة الاحتياطية غير مطابق لفهرسها. لم يتم تغيير بيانات الجهاز.',
  [ErrorCode.BACKUP_UNSAFE_PATH]:
    'تحتوي النسخة الاحتياطية على مسار غير آمن. لم يتم تغيير بيانات الجهاز.',
  [ErrorCode.BACKUP_DUPLICATE_COMPONENT]:
    'تحتوي النسخة الاحتياطية على نفس الملف أكثر من مرة.',
  [ErrorCode.BACKUP_MISSING_DATABASE]:
    'النسخة الاحتياطية لا تحتوي على قاعدة بيانات المحل.',
  [ErrorCode.BACKUP_PASSWORD_REQUIRED]:
    'كلمة مرور النسخة الاحتياطية مطلوبة.',
  [ErrorCode.BACKUP_PASSWORD_TOO_WEAK]:
    'كلمة مرور النسخة الاحتياطية قصيرة جدًا. استخدم ثمانية أحرف على الأقل.',
  [ErrorCode.BACKUP_CREATE_FAILED]:
    'تعذّر إنشاء النسخة الاحتياطية. لم تكتمل العملية.',
  [ErrorCode.BACKUP_RESTORE_FAILED]:
    'تعذّر استيراد النسخة الاحتياطية. تمت إعادة بيانات الجهاز كما كانت.',
  [ErrorCode.BACKUP_RECOVERY_INCOMPLETE]:
    'توقفت عملية استيراد سابقة في منتصفها وتعذّر إكمالها. راجع المسؤول الفني عن الجهاز.',
  [ErrorCode.BACKUP_USB_NOT_CONNECTED]:
    'وصّل فلاشة USB باسم MSHOP-BACKUP الأول وجرب تاني.',
  [ErrorCode.BACKUP_NOT_FOUND]:
    'النسخة الاحتياطية المطلوبة غير موجودة على الجهاز.',

  // ملف العملاء (P4)
  [ErrorCode.CUSTOMER_NAME_INVALID]:
    'اسم العميل غير صالح. أدخل اسمًا غير فارغ.',
  [ErrorCode.CUSTOMER_CONTACT_INVALID]:
    'بيانات التواصل طويلة جدًا. اختصرها.',
  [ErrorCode.CUSTOMER_NOT_FOUND]:
    'لا يوجد عميل بهذا السجل.',
  [ErrorCode.CUSTOMER_IS_ARCHIVED]:
    'سجل العميل هذا مؤرشف ولا يقبل عمليات جديدة.',
  [ErrorCode.CUSTOMER_PAYMENT_AMOUNT_INVALID]:
    'مبلغ السداد لازم يكون أكبر من صفر.',
  [ErrorCode.CUSTOMER_PAYMENT_EXCEEDS_BALANCE]:
    'مبلغ السداد أكبر من الرصيد الآجل اللي على العميل.',
  [ErrorCode.CUSTOMER_PAYMENT_METHOD_INVALID]:
    'طريقة تحصيل الآجل غير مسموحة.',
  [ErrorCode.CUSTOMER_PAYMENT_WALLET_INVALID]:
    'الرقم اللي اخترته ما بيستقبلش الطريقة دي — اختار رقم تاني، أو سيبه فاضي يتسجّل على الأساسي.',
  [ErrorCode.CUSTOMER_NOTE_INVALID]:
    'الملاحظة طويلة زيادة عن اللزوم.',

  // الوردية والدرج والمصروفات (البند 1.9، ADR-024)
  [ErrorCode.SHIFT_ALREADY_OPEN]:
    'فيه وردية مفتوحة بالفعل دلوقتي.',
  [ErrorCode.SHIFT_NOT_OPEN]:
    'مفيش وردية مفتوحة دلوقتي. افتح الوردية الأول.',
  [ErrorCode.SHIFT_OPENING_CASH_INVALID]:
    'رصيد فتح الدرج لازم يكون صفر أو أكبر.',
  [ErrorCode.SHIFT_COUNTED_CASH_INVALID]:
    'المعدود في الدرج لازم يكون صفر أو أكبر.',
  [ErrorCode.SHIFT_CLOSE_NOTE_INVALID]:
    'ملاحظة تقفيل الوردية طويلة زيادة عن اللزوم.',
  [ErrorCode.SHIFT_CLOSE_FORBIDDEN_FOR_SELLER]:
    'تقفيل الوردية للمالك بس. كلّم المالك يقفّلها أو يفعّلها من الإعدادات.',
  [ErrorCode.EXPENSE_CATEGORY_INVALID]:
    'اختار أو اكتب بند المصروف الأول.',
  [ErrorCode.EXPENSE_AMOUNT_INVALID]:
    'مبلغ المصروف لازم يكون أكبر من صفر.',
  [ErrorCode.EXPENSE_NOTE_INVALID]:
    'ملاحظة المصروف طويلة زيادة عن اللزوم.',
  [ErrorCode.EXPENSE_PAID_FROM_INVALID]:
    'قول المصروف خرج من الدرج ولا من برّاه — ده اللي بيحدد إذا كان بيتخصم من الدرج ولا لأ.',
  [ErrorCode.CASH_MOVEMENT_KIND_INVALID]:
    'نوع حركة الدرج غير معروف.',
  [ErrorCode.CASH_MOVEMENT_AMOUNT_INVALID]:
    'مبلغ حركة الدرج لازم يكون أكبر من صفر.',
  [ErrorCode.CASH_MOVEMENT_REASON_INVALID]:
    'اكتب سبب حركة الدرج الأول.',

  // المحافظ ودفتر الخدمات (البند 1.10، ADR-025)
  [ErrorCode.WALLET_NOT_FOUND]:
    'المحفظة دي مش موجودة دلوقتي.',
  [ErrorCode.WALLET_NAME_INVALID]:
    'اسم المحفظة لازم يكون مكتوب ومايزيدش عن 80 حرف.',
  [ErrorCode.WALLET_NAME_DUPLICATE]:
    'فيه محفظة بالاسم ده بالفعل.',
  [ErrorCode.WALLET_NUMBER_INVALID]:
    'رقم المحفظة طويل زيادة عن اللزوم.',
  [ErrorCode.WALLET_COMPANY_INVALID]:
    'اسم الشركة طويل زيادة عن اللزوم.',
  [ErrorCode.WALLET_COLOR_INVALID]:
    'لون المحفظة غير صالح.',
  [ErrorCode.WALLET_LIMIT_INVALID]:
    'رصيد أو حد المحفظة لازم يكون صفر أو أكبر.',
  [ErrorCode.WALLET_PAY_METHOD_INVALID]:
    'طريقة دفع البيع للمحفظة غير صالحة.',
  [ErrorCode.WALLET_DELETE_FORBIDDEN]:
    'المحفظة دي مينفعش تتمسح لأنها افتراضية أو عليها عمليات متسجّلة. اخفيها بدل ما تمسحها.',
  [ErrorCode.WALLET_INSUFFICIENT_BALANCE]:
    'رصيد المحفظة مش كفاية للعملية دي. اشحن المحفظة الأول أو اختار محفظة تانية.',
  [ErrorCode.WALLET_OP_KIND_INVALID]:
    'نوع عملية المحفظة أو الخدمة غير معروف.',
  [ErrorCode.WALLET_OP_AMOUNT_INVALID]:
    'اكتب مبلغ العملية بشكل صحيح (أكبر من صفر).',
  [ErrorCode.WALLET_OP_FEE_INVALID]:
    'اكتب العمولة أو الرسوم، ولو مفيش اكتب 0.',
  [ErrorCode.WALLET_OP_FEE_EXCEEDS_AMOUNT]:
    'عمولة السحب مينفعش تكون أكبر من مبلغ السحب.',
  [ErrorCode.WALLET_OP_NOTE_INVALID]:
    'الملاحظة أو السبب طويل زيادة عن اللزوم.',
  [ErrorCode.WALLET_OP_NOT_FOUND]:
    'العملية دي مش موجودة.',
  [ErrorCode.WALLET_OP_ALREADY_VOIDED]:
    'العملية دي اتلغت قبل كده بالفعل.',
  [ErrorCode.WALLET_VOID_REASON_REQUIRED]:
    'اكتب سبب إلغاء العملية الأول.',

  // النواقص (البند 1.15، ADR-030)
  [ErrorCode.SHORTAGE_NAME_REQUIRED]:
    'اكتب اسم الصنف أو اختاره من المخزن.',
  [ErrorCode.SHORTAGE_QTY_INVALID]:
    'الكمية لازم تبقى رقم 1 أو أكتر.',
  [ErrorCode.SHORTAGE_NOTE_TOO_LONG]:
    'الملاحظة طويلة زيادة عن اللزوم.',
  [ErrorCode.SHORTAGE_CUSTOMER_INVALID]:
    'بيانات العميل المستني غير صحيحة.',
  [ErrorCode.SHORTAGE_STATUS_INVALID]:
    'حالة الناقص غير صحيحة.',
  [ErrorCode.SHORTAGE_NOT_FOUND]:
    'الناقص ده مش موجود في القايمة.',
  [ErrorCode.SHORTAGE_DELETE_FORBIDDEN]:
    'اللي ضاف الناقص أو المالك بس اللي يقدر يمسحه.',

  // الصيانة والسوفت وير (البند 2.1، ADR-031)
  [ErrorCode.REPAIR_CUSTOMER_REQUIRED]:
    'اكتب اسم العميل ورقم تليفونه.',
  [ErrorCode.REPAIR_DEVICE_REQUIRED]:
    'اكتب موديل الجهاز الأول.',
  [ErrorCode.REPAIR_ISSUE_REQUIRED]:
    'حدد العطل أو عملية السوفت وير المطلوبة.',
  [ErrorCode.REPAIR_AMOUNT_INVALID]:
    'المبلغ أو البيان المدخل غير صحيح.',
  [ErrorCode.REPAIR_STATUS_INVALID]:
    'حالة التذكرة غير صحيحة.',
  [ErrorCode.REPAIR_PAY_METHOD_INVALID]:
    'طريقة التحصيل غير صحيحة.',
  [ErrorCode.REPAIR_PAY_WALLET_INVALID]:
    'الرقم اللي اخترته ما بيستقبلش الطريقة دي — اختار رقم تاني، أو سيبه فاضي يتسجّل على الأساسي.',
  // الموبايل والكمبيوتر: أربع حالات تخص اللي ماسك الموبايل في إيده (`ADR-042`).
  [ErrorCode.COMPANION_NO_HOST]:
    'الموبايل لسه ما عرفش عنوان الكمبيوتر — امسح باركود الربط اللي على الكمبيوتر الأول.',
  [ErrorCode.COMPANION_INTAKE_REFUSED]:
    'المسودة ما اتقبلتش: ناقصها اسم الصنف أو الكمية، أو كود الربط مش بتاع الكمبيوتر ده.',
  [ErrorCode.COMPANION_INTAKE_GONE]:
    'المسودة دي مش في صندوق الوارد: في حد قدام الكمبيوتر سجّلها في الاستلام أو رفضها قبل لحظات.',
  [ErrorCode.COMPANION_INTAKE_NOT_RECEIVABLE]:
    'المسودة دي ما تنفعش تستلمها (صنف مرة واحدة، أو من غير كمية) — ارفضها وابلّغ اللي صوّرها.',
  [ErrorCode.REPAIR_NOT_FOUND]:
    'تذكرة الصيانة دي مش موجودة.',
  [ErrorCode.REPAIR_ALREADY_DELIVERED]:
    'التذكرة دي اتسلّمت أو اتلغت قبل كده.',
  [ErrorCode.REPAIR_ALREADY_CANCELLED]:
    'التذكرة دي اتراجع عنها قبل كده — الفلوس رجعت مرة واحدة بس.',

  // الموبايلات المستعملة وفحص الـ IMEI (البند 2.2، ADR-032)
  [ErrorCode.IMEI_SECONDARY_MATCHES_PRIMARY]:
    'الـ IMEI التاني لازم يكون مختلف عن الـ IMEI الأولاني.',
  [ErrorCode.UNIT_GRADE_INVALID]:
    'اختار حالة الجهاز المستعمل (A أو B أو C).',
  [ErrorCode.UNIT_BATTERY_HEALTH_INVALID]:
    'نسبة البطارية لازم تكون رقم من 1 لـ 100.',
  [ErrorCode.UNIT_NATIONAL_ID_INVALID]:
    'رقم البطاقة القومي لازم يكون 14 رقم بالظبط.',
  [ErrorCode.UNIT_NOTE_TOO_LONG]:
    'البيان أو الملاحظات أطول من الحد المسموح.'
};

/** Shown when Rust sends something this build does not know about. */
const UNKNOWN_CODE_MESSAGE = 'حدث خطأ غير متوقع. يُرجى المحاولة مرة أخرى.';

/**
 * Render a code as Arabic.
 *
 * An unrecognised code deliberately falls back to a generic message rather than
 * printing the raw code: an unexpected internal value should not appear to an
 * operator as machine text.
 */
export function messageFor(code: string): string {
  const known = MESSAGES_AR as Readonly<Record<string, string>>;
  return known[code] ?? UNKNOWN_CODE_MESSAGE;
}

/** Narrow an unknown thrown value to a `CommandError`, if it is one. */
export function asCommandError(value: unknown): CommandError | null {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string') {
      return { code };
    }
  }
  return null;
}

/**
 * Turn anything thrown by `invoke` into an Arabic sentence.
 *
 * A non-command failure (a transport problem, for instance) has no code, and
 * falls back to the generic message.
 */
export function describeError(value: unknown): string {
  const error = asCommandError(value);
  return error === null ? UNKNOWN_CODE_MESSAGE : messageFor(error.code);
}