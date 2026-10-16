// ═══════════════════════════════════════════════════════════
// expenses.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function addCE(){const nm=g('ce-n');if(!nm)return;catE.push(nm);saveCE();clr('ce-n');}

function delCE(i){catE.splice(i,1);saveCE();}

function qsExp(nm){$('exp-cat').value=nm;setTimeout(()=>$('exp-a').focus(),60);}

function rExpQ(){const el=$('cat-q-exp');if(!el)return;if(!catE.length){el.innerHTML='';return;}let h=`<div class="cat-quick"><div class="cqlbl"><span>⚡ أصناف</span><a onclick="goSettings()">إدارة ›</a></div><div class="chips">`;catE.forEach(nm=>h+=`<div class="chip" onclick="qsExp('${esc(nm)}')">${esc(nm)}</div>`);el.innerHTML=h+'</div></div>';}

function rCatL(t){
  if(t==='a'){if(!catA.length){$('ca-list').innerHTML=`<div class="empty">الكتالوج فاضي</div>`;return;}$('ca-list').innerHTML=catA.map((i,x)=>`<div class="item"><span class="ibadge" style="background:#3b82f630;color:#3b82f6;font-size:9px">${esc(i.mainCat||'أخري')}</span><span class="iname" style="font-weight:700">${esc(i.name)}</span><span style="font-size:11px;color:#4ade80">بيع: ${fmt(i.sell)} ج</span><button class="delbtn" onclick="delCA(${x})">×</button></div>`).join('');}
  else if(t==='u'){if(!catU.length){$('cu-list').innerHTML=`<div class="empty">الكتالوج فاضي</div>`;return;}$('cu-list').innerHTML=catU.map((i,x)=>`<div class="item"><span class="iname" style="font-weight:700">${esc(i.name)}</span><span style="font-size:11px;color:#475569">شراء: ${fmt(i.buy)} ج</span><span style="font-size:11px;color:#4ade80">بيع: ${fmt(i.sell)} ج</span><button class="delbtn" onclick="delCU(${x})">×</button></div>`).join('');}
  else{if(!catE.length){$('ce-list').innerHTML=`<div class="empty">لا توجد أصناف</div>`;return;}$('ce-list').innerHTML=catE.map((nm,i)=>`<div class="item"><span class="iname">${esc(nm)}</span><button class="delbtn" onclick="delCE(${i})">×</button></div>`).join('');}
}

function addExp(){const cat=g('exp-cat'),a=n(g('exp-a'));if(!cat||!a)return;expenseTransactionRepo.create({category:cat,amount:a,time:ts()});clr('exp-cat','exp-a');$('exp-cat').focus();ref('exp');}
