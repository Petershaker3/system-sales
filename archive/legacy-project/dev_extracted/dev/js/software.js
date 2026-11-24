// ═══════════════════════════════════════════════════════════
// software.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function addSw(){const nm=g('sw-n'),p=n(g('sw-p')),nt=g('sw-note');if(!nm||!p)return;const item={name:nm,price:p,note:nt,paid:false,delivered:false,time:ts()};softwareTransactionRepo.create(item);clr('sw-n','sw-p','sw-note');$('sw-n').focus();ref('sw');checkCondNotes('sw',item);}

function toggleSwField(idx,field){const item=data.sw[idx];if(!item)return;if(item.id){softwareTransactionRepo.update(item.id,{[field]:!item[field]},{date:sel});}else{data.sw[idx][field]=!data.sw[idx][field];save();}renderList('sw');}
