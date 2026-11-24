'use strict';
// التشغيل: آخر ملف بيتحمّل في index.html (بعد كل الشاشات). الدليل: docs/ENGINEERING.md
/* ===== تشغيل ===== */
// شاشة الاستلام في الموبايل بتبدأ بجهازين اتمسحوا (بيانات التجربة بس: المحل الفاضي بيبدأ من غير أجهزة)
if (prod('p5')) S.mobile.recv = [DATA.makeImei(prod('p5').tac), DATA.makeImei(prod('p5').tac)];
applySettings();
refreshDash();
render();
focusSearch();
