'use strict';
// التشغيل: آخر ملف بيتحمّل في index.html (بعد كل الشاشات). الدليل: docs/ENGINEERING.md
/* ===== تشغيل ===== */
S.mobile.recv = [DATA.makeImei(prod('p5').tac), DATA.makeImei(prod('p5').tac)];
applySettings();
refreshDash();
render();
focusSearch();
