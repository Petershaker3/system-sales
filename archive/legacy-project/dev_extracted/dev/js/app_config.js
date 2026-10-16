// ═══════════════════════════════════════════════════════════════════
// app_config.js — SINGLE application configuration boundary (Phase 3)
// ═══════════════════════════════════════════════════════════════════
// كل إعدادات الاتصال الخارجية تُقرأ من هنا فقط. لا يجوز وضع أي URL أو
// مفتاح داخل أي ملف مصدر آخر — راجع docs/SECURITY_CONFIGURATION_PROPOSAL.md
//
// ⚠️ تنبيه أمني صريح: هذه الحدود للصيانة والتحكم في التوزيع فقط وليست
// حلًا لإدارة الأسرار — أي قيمة يقرأها JavaScript في المتصفح تبقى مرئية
// لكل من يملك نسخة الملف. لا تضع هنا أي credential حقيقي بغرض إخفائه.
//
// GAS_URL — Google Apps Script web-app endpoint (Drive sync).
//   • القيمة فارغة عمدًا: الـ endpoint القديم مُعرَّض ويُعامَل كمسحوب.
//   • المالك يضع الـ endpoint الجديد بعد التدوير حسب
//     docs/GAS_CREDENTIAL_ROTATION_RUNBOOK.md ثم يُعيد البناء عبر build.py.
//   • القيمة الجديدة لا تُحفَظ في أي مستودع — تدخل وقت النشر فقط.

const APP_CONFIG = {
  GAS_URL: '',
};

// Fail-closed accessor — the ONLY way application code reads the endpoint.
// Returns '' when unconfigured so callers must refuse (never send data elsewhere).
function _getGasUrl(){
  try{
    const u = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG && APP_CONFIG.GAS_URL)
      ? String(APP_CONFIG.GAS_URL).trim() : '';
    if(!u) return '';
    if(u.indexOf('PASTE_') !== -1 || u.indexOf('YOUR_') !== -1 || u.indexOf('EXAMPLE') !== -1) return '';
    return u;
  }catch(e){ return ''; }
}
