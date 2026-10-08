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
  // Catalogue
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  BARCODE_ALREADY_EXISTS: 'BARCODE_ALREADY_EXISTS',
  PRODUCT_NAME_REQUIRED: 'PRODUCT_NAME_REQUIRED',
  BARCODE_EMPTY: 'BARCODE_EMPTY',
  PRICE_NEGATIVE: 'PRICE_NEGATIVE',
  PRODUCT_IS_ARCHIVED: 'PRODUCT_IS_ARCHIVED',
  // Money
  MONEY_NEGATIVE: 'MONEY_NEGATIVE',
  // Departments (product classification)
  DEPARTMENT_NAME_REQUIRED: 'DEPARTMENT_NAME_REQUIRED',
  DEPARTMENT_NOT_FOUND: 'DEPARTMENT_NOT_FOUND',
  DEPARTMENT_IS_ARCHIVED: 'DEPARTMENT_IS_ARCHIVED',
  DEPARTMENT_NOT_ARCHIVED: 'DEPARTMENT_NOT_ARCHIVED',
  DEPARTMENT_ARCHIVE_STATE_INCONSISTENT: 'DEPARTMENT_ARCHIVE_STATE_INCONSISTENT',
  VAT_RATE_REQUIRED: 'VAT_RATE_REQUIRED',
  VAT_RATE_NEGATIVE: 'VAT_RATE_NEGATIVE',
  // الخطوة الثانية (النمط / الإعدادات)
  PATTERN_REQUIRED: 'PATTERN_REQUIRED',
  PATTERN_APPROVAL_STALE: 'PATTERN_APPROVAL_STALE',
  PATTERN_NOT_CONFIGURED: 'PATTERN_NOT_CONFIGURED',
  SETTING_UNKNOWN_KEY: 'SETTING_UNKNOWN_KEY',
  SETTING_VALUE_INVALID: 'SETTING_VALUE_INVALID'
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
  [ErrorCode.INVALID_CREDENTIALS]: 'بيانات الدخول غير صحيحة',
  [ErrorCode.ACCOUNT_TEMPORARILY_LOCKED]:
    'الحساب مقفل مؤقتًا بسبب محاولات دخول فاشلة. حاول مرة أخرى بعد قليل.',
  [ErrorCode.PASSWORD_DOES_NOT_MEET_POLICY]:
    'كلمة المرور لا تحقق الحد المطلوب، ثمانية أحرف على الأقل.',
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

  // الكتالوغ
  [ErrorCode.PRODUCT_NOT_FOUND]: 'المنتج غير موجود.',
  [ErrorCode.BARCODE_ALREADY_EXISTS]:
    'هذا الباركود مستخدم لمنتج آخر.',
  [ErrorCode.PRODUCT_NAME_REQUIRED]: 'اسم المنتج مطلوب.',
  [ErrorCode.BARCODE_EMPTY]: 'الباركود لا يُقبل فارغاً.',
  [ErrorCode.PRICE_NEGATIVE]: 'لا يُقبل أن يكون السعر سالبي.',
  [ErrorCode.PRODUCT_IS_ARCHIVED]:
    'هذا المنتج مؤرشف. لا يُمكن تعديله ما لم يُرشف من الأرشيف.',

  // المال
  // Currently unreachable from a command: a catalogue price converts a negative
  // into PRICE_NEGATIVE before it crosses the boundary. Declared because the
  // architecture guard scans the code table in both directions against the Rust
  // source, and would fail the build on a code it can see but has no message for.
  [ErrorCode.MONEY_NEGATIVE]: 'لا يُقبل أن يكون المبلغ سالبًا.',

  // الأقسام (تصنيف المنتجات)
  [ErrorCode.DEPARTMENT_NOT_FOUND]: 'لا يوجد قسم بهذا المعرّف.',
  [ErrorCode.DEPARTMENT_NAME_REQUIRED]: 'اسم القسم مطلوب.',
  [ErrorCode.DEPARTMENT_IS_ARCHIVED]:
    'هذا القسم مؤرشف. لا يُمكن تعديله.',
  [ErrorCode.DEPARTMENT_NOT_ARCHIVED]:
    'هذا القسم نشط بالفعل. لا يوجد ما يسترجعه.',
  [ErrorCode.DEPARTMENT_ARCHIVE_STATE_INCONSISTENT]:
    'بيانات القسم غير مكتملة. كلّم المسؤول الفني عن الجهاز.',
  [ErrorCode.VAT_RATE_REQUIRED]:
    'يجب تحديد نسبة ضريبة قبل تفعيل الضريبة على القسم.',
  [ErrorCode.VAT_RATE_NEGATIVE]: 'لا يُقبل أن تكون نسبة الضريبة سالبة.',

  // الخطوة الثانية (النمط / الإعدادات)
  [ErrorCode.PATTERN_REQUIRED]:
    'هذه العملية حسّاسة وتحتاج تأكيد النمط من جديد.',
  [ErrorCode.PATTERN_APPROVAL_STALE]:
    'انتهت صلاحية تأكيد النمط أو تم تغييره. أكّد النمط من جديد للمتابعة.',
  [ErrorCode.PATTERN_NOT_CONFIGURED]:
    'حماية النمط مُفعّلة ولم يُعيَّن نمط بعد. كلّم مدير المحل.',
  [ErrorCode.SETTING_UNKNOWN_KEY]: 'إعداد غير معروف.',
  [ErrorCode.SETTING_VALUE_INVALID]: 'قيمة الإعداد غير صحيحة.'
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