// ═══════════════════════════════════════════════════════════
// usedPhones.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function addCU(){const nm=g('cu-n');if(!nm)return;catU.push({name:nm,buy:n(g('cu-b')),sell:n(g('cu-s'))});saveCU();clr('cu-n','cu-b','cu-s');}

function delCU(i){catU.splice(i,1);saveCU();}

function qsUsed(i){const it=catU[i];$('used-n').value=it.name;$('used-b').value=it.buy||'';$('used-s').value=it.sell||'';setTimeout(()=>$('used-s').focus(),60);}

function addUsed(){const nm=g('used-n'),b=n(g('used-b')),s=n(g('used-s')),nt=g('used-note');if(!nm||!s)return;const item={name:nm,buy:b,sell:s,profit:s-b,note:nt,time:ts()};usedPhoneTransactionRepo.create(item);clr('used-n','used-b','used-s','used-note');$('used-n').focus();ref('used');checkCondNotes('used',item);}
