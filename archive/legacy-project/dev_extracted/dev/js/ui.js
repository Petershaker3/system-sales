// ═══════════════════════════════════════════════════════════
// ui.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function showScreen(id){SCREENS.forEach(s=>{const el=$(s);if(el)el.style.display='none';});const el=$(id);if(el)el.style.display=(id==='S-lock'?'flex':'block');}

function goMain(){showScreen('S-main');renderRatingAndInsights();}

function goMonthly(){selMonth=new Date().toISOString().slice(0,7);extendAdminSession();renderMonthly();showScreen('S-monthly');setTimeout(initCmpUI,80);}

function goAnalytics(){extendAdminSession();populateAnaMonths();renderAnalytics();showScreen('S-analytics');}

function goNotes(){renderNotes();showScreen('S-notes');}

function goNotifications(){renderNotifs();showScreen('S-notifications');}

function goSearch(){showScreen('S-search');doNLPSearch();}

function goSettings(){renderSettingsPage();showScreen('S-settings');}

function goRepairs(){renderRepairList();showScreen('S-repairs');}

// ══ Phase 2B — محرك مالي موحّد (نقطة الحقيقة الوحيدة) ═══════════
// تُستخدم من: لوحة التحكم اليومية (calcTotals)، التقارير الشهرية (monthTotals)،
// والتحليلات الذكية (getLast30Avg/generateInsights) — بلا أي استثناء أو صيغة بديلة.
//
// القواعد المالية الموحّدة (يجب ألا تتغيّر مستقبلًا إلا بقرار صريح):
//  • إجمالي المبيعات (total) = فقط: اكسسوار (قيمة كاملة) + سوفت وير (قيمة كاملة) + كاش (كما هو حاليًا)
//  • لا تدخل قيمة بيع الهواتف الجديدة/المستعملة أو فاتورة الصيانة في إجمالي المبيعات إطلاقًا — الربح فقط
//  • صافي الربح (profit) = كل مصادر الربح مجتمعة، مطروحًا منها المصاريف دائمًا — بنفس الصيغة في كل شاشة
//  • الصيانة الملغاة لا تؤثر على أي إجمالي مالي
function computeFinancialTotals(sections){
  const ok=i=>!i._rolled;
  const acc=(sections.acc||[]).filter(ok), used=(sections.used||[]).filter(ok), cash=(sections.cash||[]).filter(ok),
        sw=(sections.sw||[]).filter(ok), exp=(sections.exp||[]).filter(ok),
        phones=(sections.phones||[]).filter(ok), repairs=(sections.repairs||[]).filter(ok);
  const aS=acc.reduce((s,i)=>s+i.sell,0), aP=acc.reduce((s,i)=>s+i.profit,0);
  const uS=used.reduce((s,i)=>s+i.sell,0), uP=used.reduce((s,i)=>s+i.profit,0);
  const cT=cash.reduce((s,i)=>s+i.amount,0);
  const sT=sw.reduce((s,i)=>s+i.price,0);
  const eT=exp.reduce((s,i)=>s+i.amount,0);
  const phS=phones.reduce((s,i)=>s+(i.sellPrice*(i.qty||1)||0),0), phP=phones.reduce((s,i)=>s+(i.profit||0),0);
  const repS=repairs.reduce((s,i)=>s+(i.servicePrice||0),0);
  const repP=repairs.filter(i=>i.status!=='cancelled').reduce((s,i)=>s+(i.profit||0),0);
  // إجمالي المبيعات: اكسسوار + سوفت وير + كاش فقط (القاعدة الموحّدة المعتمدة)
  const total=aS+sT+cT;
  // صافي الربح: كل مصادر الربح، مطروحًا منها المصاريف — نفس الصيغة يوميًا وشهريًا وفي التحليلات
  const profit=aP+uP+cT+sT+phP+repP-eT;
  return{aS,aP,uP,uS,cT,sT,eT,phS,phP,repS,repP,profit,total};
}

function calcTotals(){
  return computeFinancialTotals(data);
}

function renderSummary(){
  _lastRender = renderAll;
  const c=calcTotals();
  const pc=$('pcard');if(pc)pc.style.borderColor=c.profit>=0?'#22c55e40':'#ef444440';
  const pv=$('pval');if(pv){pv.textContent=showProfits?fmt(c.profit)+' ج':'•••';pv.style.color=showProfits?(c.profit>=0?'#4ade80':'#f87171'):'#334155';}
  const pe=$('peye');if(pe)pe.textContent=showProfits?'🔓 اضغط للإخفاء':'🔐 اضغط للكشف';
  const sm=$('summary');if(!sm)return;
  // إجمالي = acc(بيع) + cash + sw + used(ربح) + phones(ربح) + repairs(ربح)
  let html=`
    <div class="scard"><div class="scard-lbl">إجمالي اليوم</div><div class="scard-val" style="color:#60a5fa">${mtot(c.total,'#60a5fa')}</div></div>
    <div class="scard"><div class="scard-lbl">🎧 اكسسوار</div><div class="scard-val" style="color:#3b82f6">${mtot(c.aS,'#3b82f6')}</div><div class="scard-sub" style="color:${showProfits?'#4ade80':'#334155'}">ربح: ${mfmt(c.aP)}</div></div>
    <div class="scard"><div class="scard-lbl">📱 مستعمل</div><div class="scard-val" style="color:#a78bfa">${mtot(c.uS,'#a78bfa')}</div><div class="scard-sub" style="color:${showProfits?'#4ade80':'#334155'}">ربح: ${mfmt(c.uP)}</div></div>
    <div class="scard"><div class="scard-lbl">💳 الكاش</div><div class="scard-val" style="color:#f87171">${mtot(c.cT,'#f87171')}</div></div>
    <div class="scard"><div class="scard-lbl">⚙️ سوفت وير</div><div class="scard-val" style="color:#34d399">${mtot(c.sT,'#34d399')}</div></div>
    <div class="scard" style="border-color:#92400e40"><div class="scard-lbl">💸 مصاريف</div><div class="scard-val" style="color:#fbbf24">${mtot(c.eT,'#fbbf24')}</div></div>`;
  if(c.phP>0)html+=`<div class="scard" style="border-color:#06b6d430"><div class="scard-lbl">📦 هواتف جديدة</div><div class="scard-val" style="color:#06b6d4">${mtot(c.phS,'#06b6d4')}</div><div class="scard-sub" style="color:${showProfits?'#4ade80':'#334155'}">ربح: ${mfmt(c.phP)}</div></div>`;
  if(c.repP>0)html+=`<div class="scard" style="border-color:#f9731630"><div class="scard-lbl">🔧 صيانة</div><div class="scard-val" style="color:#f97316">${mtot(c.repS,'#f97316')}</div><div class="scard-sub" style="color:${showProfits?'#4ade80':'#334155'}">ربح: ${mfmt(c.repP)}</div></div>`;
  sm.innerHTML=html;
}

function renderBadges(){
  Object.keys(TC).forEach(id=>{
    const b=document.querySelector(`.tab[data-id="${id}"]`);if(!b)return;
    const c2=TC[id];
    const cnt=id==='phones'?inventory.length:(data[id]?.length||0);
    const badge=cnt>0?`<span class="badge" style="background:${c2.color}30;color:${c2.color}">${cnt}</span>`:'';
    b.innerHTML=`${c2.icon} ${c2.lbl}${badge}`;
  });
}

function ST(id){
  ctab=id;
  Object.keys(TC).forEach(k=>{
    const p=$('panel-'+k),b=document.querySelector(`[data-id="${k}"]`);
    if(!p||!b)return;
    if(k===id){p.classList.add('on');b.classList.add('on');b.style.background=TC[k].color+'22';b.style.borderColor=TC[k].color;b.style.color=TC[k].color;}
    else{p.classList.remove('on');b.classList.remove('on');b.style.background='#111827';b.style.borderColor='#1e293b';b.style.color='#64748b';}
  });
  if(id==='phones'){renderPhones();return;}
  if(id==='repairs'){renderRepairPanel();return;}
  if(id==='cash'){renderCashWalletButtons();renderWalletSummary();renderWalletManageList();return;}
  if(id!=='cash'){const inp=$('panel-'+id)?.querySelector('input:not([type=number])');if(inp)setTimeout(()=>inp.focus(),60);}
}

function renderList(id){
  const items=data[id]||[],cnt=items.length;
  const cntEl=$(`${id}-cnt`);if(cntEl)cntEl.textContent=cnt;
  if(cnt===0){const l=$(`${id}-list`);if(l)l.innerHTML=`<div class="empty">📋 لا توجد عناصر</div>`;const m=$(`${id}-meta`);if(m)m.innerHTML='';return;}
  let h='';
  const ft=computeFinancialTotals(data); // نفس المحرك الموحّد — بدل إعادة حساب الجمع محليًا لكل قسم
  if(id==='acc'){const s=ft.aS,p=ft.aP;const m=$('acc-meta');if(m)m.innerHTML=`مبيعات: <b style="color:#3b82f6">${fmt(s)} ج</b> ربح: <b>${mfmt(p)}</b>`;items.forEach((i,x)=>{const rolled=i._rolled;const buyHtml=adminUnlocked?`<span style="font-size:10px;color:#64748b">شراء: <b style="color:#fbbf24">${fmt(i.buy||0)} ج</b></span>`:`<span style="font-size:10px;color:#334155;cursor:pointer;letter-spacing:1px" onclick="requireAdmin(()=>ref('acc'))" title="اضغط لإظهار سعر الشراء">شراء: ••••</span>`;h+=`<div class="item" style="${rolled?'opacity:.45;background:#0a0f1e':''}"><span class="iname" style="${rolled?'text-decoration:line-through':''}">${esc(i.name)}${i.qty?` <span style="font-size:10px;color:#64748b">×${i.qty}</span>`:''}</span>${buyHtml}<span style="font-size:11px;color:#475569">بيع: <b>${fmt(i.sell)} ج</b></span>${rolled?`<span style="font-size:10px;color:#f87171;padding:1px 5px;background:#450a0a;border-radius:4px">↩ متراجع عنه</span>`:mp(i.profit)}<span class="itime">${i.time}</span>${!rolled?`<button class="delbtn" style="background:#1c1200;color:#f59e0b;border:1px solid #92400e" onclick="rollbackTransaction('acc',${x})" title="تراجع">↩</button>`:''}<button class="delbtn" onclick="softDel('acc',${x})">×</button></div>`;});}
  if(id==='used'){const s=ft.uS,p=ft.uP;const m=$('used-meta');if(m)m.innerHTML=`مبيعات: <b style="color:#8b5cf6">${fmt(s)} ج</b> ربح: <b>${mfmt(p)}</b>`;items.forEach((i,x)=>{const rolled=i._rolled;h+=`<div class="item" style="${rolled?'opacity:.45;background:#0a0f1e':''}"><span class="iname" style="${rolled?'text-decoration:line-through':''}">${esc(i.name)}</span><span style="font-size:11px;color:#475569">بيع: <b>${fmt(i.sell)} ج</b></span>${rolled?`<span style="font-size:10px;color:#f87171;padding:1px 5px;background:#450a0a;border-radius:4px">↩ متراجع عنه</span>`:mp(i.profit)}`;if(i.note)h+=`<span style="font-size:10px;color:#64748b;width:100%;margin-top:2px">📌 ${esc(i.note)}</span>`;h+=`<span class="itime">${i.time}</span>${!rolled?`<button class="delbtn" style="background:#1c1200;color:#f59e0b;border:1px solid #92400e" onclick="rollbackTransaction('used',${x})" title="تراجع">↩</button>`:''}<button class="delbtn" onclick="softDel('used',${x})">×</button></div>`;});}
  if(id==='cash'){const t=ft.cT;const m=$('cash-meta');if(m)m.innerHTML=`إجمالي: <b style="color:#4ade80">${fmt(t)} ج</b>`;items.forEach((i,x)=>{const rolled=i._rolled;const sc=SVC_C[i.service]||'#64748b',tc=i.cashType==='ايداع'?'#4ade80':'#f87171',ti=i.cashType==='ايداع'?'⬆️':'⬇️';h+=`<div class="item" style="${rolled?'opacity:.45;background:#0a0f1e':''}"><span class="ibadge" style="color:${tc};background:${tc}20">${ti} ${esc(i.cashType)}</span><span class="ibadge" style="background:${sc}20;color:${sc}">${esc(i.service)}</span><span style="flex:1"></span>${rolled?`<span style="font-size:10px;color:#f87171;padding:1px 5px;background:#450a0a;border-radius:4px">↩ متراجع</span>`:`<span class="imoney g">${fmt(i.amount)} ج</span>`}<span class="itime">${i.time}</span>${!rolled?`<button class="delbtn" style="background:#1c1200;color:#f59e0b;border:1px solid #92400e" onclick="rollbackTransaction('cash',${x})" title="تراجع">↩</button>`:''}<button class="delbtn" onclick="softDel('cash',${x})">×</button></div>`;});renderWalletSummary();}
  if(id==='sw'){const t=ft.sT;const m=$('sw-meta');if(m)m.innerHTML=`إجمالي: <b style="color:#4ade80">${fmt(t)} ج</b>`;items.forEach((i,x)=>{const rolled=i._rolled;h+=`<div class="item" style="flex-wrap:wrap${rolled?';opacity:.45;background:#0a0f1e':''}"><span class="iname" style="${rolled?'text-decoration:line-through':''}">${esc(i.name)}</span>${rolled?`<span style="font-size:10px;color:#f87171;padding:1px 5px;background:#450a0a;border-radius:4px">↩ متراجع</span>`:`<span class="imoney g">${fmt(i.price)} ج</span>`}<span style="width:100%;display:flex;gap:12px;margin-top:5px;flex-wrap:wrap"><label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#64748b;cursor:pointer"><input type="checkbox" ${i.paid?'checked':''} onchange="toggleSwField(${x},'paid')"> ✅ تم الدفع</label><label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#64748b;cursor:pointer"><input type="checkbox" ${i.delivered?'checked':''} onchange="toggleSwField(${x},'delivered')"> 📤 تم التسليم</label>${i.note?`<span style="font-size:10px;color:#64748b">📌 ${esc(i.note)}</span>`:''}</span><span class="itime">${i.time}</span>${!rolled?`<button class="delbtn" style="background:#1c1200;color:#f59e0b;border:1px solid #92400e" onclick="rollbackTransaction('sw',${x})" title="تراجع">↩</button>`:''}<button class="delbtn" onclick="softDel('sw',${x})">×</button></div>`;});}
  if(id==='exp'){const t=ft.eT;const m=$('exp-meta');if(m)m.innerHTML=`إجمالي: <b style="color:#fbbf24">${fmt(t)} ج</b>`;items.forEach((i,x)=>{h+=`<div class="item"><span class="iname">${esc(i.category)}</span><span class="imoney y">${fmt(i.amount)} ج</span><span class="itime">${i.time}</span><button class="delbtn" onclick="softDel('exp',${x})">×</button></div>`;});}
  const el=$(`${id}-list`);if(el)el.innerHTML=h;
}

function renderAll(){renderSummary();['acc','used','cash','sw','exp'].forEach(renderList);renderBadges();renderCashWalletButtons();}

function ref(id){renderList(id);renderSummary();renderBadges();}

function updateBadges(){
  const unread=notifs.filter(n=>!n.read).length;
  const activeNotes=notes.filter(n=>!n.done).length;
  const nb=$('nb-notes'),nn=$('nb-notifs');
  if(nb){nb.style.display=activeNotes>0?'flex':'none';nb.textContent=activeNotes>9?'9+':activeNotes;}
  if(nn){nn.style.display=unread>0?'flex':'none';nn.textContent=unread>9?'9+':unread;}
}

function dateLbl(d){const t=new Date().toISOString().split('T')[0],y=new Date(Date.now()-86400000).toISOString().split('T')[0],dt=new Date(d+'T12:00:00');if(d===t)return'اليوم · '+dt.toLocaleDateString('ar-EG',{day:'numeric',month:'short'});if(d===y)return'الأمس · '+dt.toLocaleDateString('ar-EG',{day:'numeric',month:'short'});return dt.toLocaleDateString('ar-EG',{weekday:'short',day:'numeric',month:'short'});}

function changeDate(nd){sel=nd;loadData();renderAll();updateDateUI();renderRatingAndInsights();}

function prevDay(){const d=new Date(sel+'T12:00:00');d.setDate(d.getDate()-1);changeDate(d.toISOString().split('T')[0]);}

function nextDay(){const d=new Date(sel+'T12:00:00');d.setDate(d.getDate()+1);changeDate(d.toISOString().split('T')[0]);}

function goToday(){changeDate(TODAY);}

function updateDateUI(){$('date-label').textContent=dateLbl(sel);$('dpick').value=sel;$('today-btn').style.display=sel===TODAY?'none':'inline-block';const b=$('past-banner');if(b){if(sel!==TODAY){b.style.display='block';b.textContent='⚠️ تعرض بيانات '+new Date(sel+'T12:00:00').toLocaleDateString('ar-EG',{weekday:'long',day:'numeric',month:'long'});}else b.style.display='none';}}

function softDel(id,idx){const item={...data[id][idx],_origDate:sel,_origType:id,_deletedAt:td()+' '+ts()};trash.unshift({id:Date.now(),item});saveTrash();data[id].splice(idx,1);save();ref(id);}

function restoreTrash(idx){const t=trash[idx];if(!t)return;const{_origDate,_origType,...item}=t.item;const dk='mshop_d_'+_origDate;const r=Storage.tryGet(dk);if(!r.corrupt){const dd=r.value||{};if(!dd[_origType])dd[_origType]=[];dd[_origType].push(item);Storage.save(dk,dd);if(_origDate===sel){loadData();renderAll();}}trash.splice(idx,1);saveTrash();renderTrash();}

function permDelTrash(idx){trash.splice(idx,1);saveTrash();renderTrash();}

function clearOldTrash(){const cutoff=new Date();cutoff.setDate(cutoff.getDate()-30);const cutStr=cutoff.toISOString().split('T')[0];trash=trash.filter(t=>{const d=(t.item._deletedAt||'').split(' ')[0]||'';return d>cutStr;});saveTrash();renderTrash();}

function renderTrash(){const el=$('trash-list');if(!el)return;if(!trash.length){el.innerHTML=`<div class="empty">سلة المحذوفات فارغة</div>`;return;}const tn={acc:'اكسسوار',used:'مستعمل',cash:'كاش',sw:'سوفت وير',exp:'مصروف',phones:'هاتف جديد',repairs:'صيانة'};el.innerHTML=trash.map((t,i)=>{const it=t.item,nm=it.name||it.category||it.service||it.model||'غير محدد';return`<div class="trash-item"><span class="ibadge" style="background:#1e293b;color:#94a3b8">${tn[it._origType]||it._origType||'غير محدد'}</span><span style="flex:1">${esc(nm)}</span><span style="font-size:10px;color:#334155">${it._origDate||''}</span><button class="abtn" style="background:#059669;padding:4px 9px;font-size:10px" onclick="restoreTrash(${i})">استعادة</button><button class="delbtn" onclick="permDelTrash(${i})">×</button></div>`;}).join('');}

function checkCondNotes(type,item){
  const matching=notes.filter(nt=>nt.type==='conditional'&&!nt.done);
  matching.forEach(nt=>{
    const cd=nt.conditionData||{};
    if(cd.section&&cd.section!==type)return;
    const price=item.sell||item.price||item.amount||item.servicePrice||0;
    if(cd.minPrice&&price<cd.minPrice)return;
    if(cd.maxPrice&&price>cd.maxPrice)return;
    if(cd.keyword&&!(item.name||item.model||'').toLowerCase().includes(cd.keyword.toLowerCase()))return;
    const notif={id:Date.now(),type:'conditional',title:nt.title,body:`تحقق شرط: ${(nt.content||'').slice(0,80)}`,noteId:nt.id,matchInfo:`${item.name||item.model||item.category||item.service||''} — ${fmt(price)} ج`,created:new Date().toISOString(),read:false};
    notifs.unshift(notif);saveNotifs();showNotifPopup(notif,{matchDisplay:notif.matchInfo});
  });
}

function applyTabOrder() {
  const nav = document.getElementById('main-nav'); if (!nav) return;
  const tabs = [...nav.querySelectorAll('.main-tab')];
  // Build order map
  tabOrder.forEach((id, i) => {
    const btn = tabs.find(t => t.dataset.id === id);
    if (btn) nav.appendChild(btn); // re-append in new order
  });
}

function renderTabOrderList() {
  const el = document.getElementById('tab-order-list'); if (!el) return;
  el.innerHTML = tabOrder.map((id, i) => {
    const t = TC[id]; if (!t) return '';
    return `<div class="to-item brand-chip-item" data-id="${id}" style="justify-content:space-between">
      <span style="font-size:16px">${t.icon}</span>
      <span style="flex:1;font-weight:700;color:#e2e8f0;margin:0 8px">${t.lbl}</span>
      <div style="display:flex;gap:4px">
        <button onclick="moveTab('${id}',-1)" style="background:#1e293b;border:1px solid #334155;border-radius:6px;color:#94a3b8;width:28px;height:28px;cursor:pointer;font-size:13px" ${i===0?'disabled style="opacity:.3"':''}>↑</button>
        <button onclick="moveTab('${id}',+1)" style="background:#1e293b;border:1px solid #334155;border-radius:6px;color:#94a3b8;width:28px;height:28px;cursor:pointer;font-size:13px" ${i===tabOrder.length-1?'disabled style="opacity:.3"':''}>↓</button>
      </div>
    </div>`;
  }).join('');
}

function moveTab(id, dir) {
  const i = tabOrder.indexOf(id); if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= tabOrder.length) return;
  [tabOrder[i], tabOrder[j]] = [tabOrder[j], tabOrder[i]];
  renderTabOrderList();
}

function rollbackTransaction(type, idx, date) {
  date = date || sel;
  requireAdmin(() => {
    const dk = 'mshop_d_' + date;
    const dd = Storage.get(dk, {});
    const items = dd[type] || [];
    const item = items[idx];
    if (!item) { showToast('العملية غير موجودة', 'err'); return; }
    if (item._rolled) { showToast('⚠️ تم التراجع عن هذه العملية مسبقًا', 'err'); return; }
    const label = getTransactionLabel(type, item);
    if (!confirm(`↩️ تأكيد التراجع عن العملية:\n\n${label}\n\nسيتم إعادة جميع التأثيرات تلقائيًا.\nلا يمكن التراجع عن هذا الإجراء.`)) return;
    _pendingRollback = { type, idx, date, dk, dd, item };
    const inp = document.getElementById('rollback-reason-inp'); if (inp) inp.value = '';
    const lbl = document.getElementById('rollback-reason-label'); if (lbl) lbl.textContent = label;
    const m = document.getElementById('modal-rollback-reason'); if (m) m.style.display = 'flex';
    setTimeout(() => document.getElementById('rollback-reason-inp')?.focus(), 100);
  });
}

function closeRollbackReasonModal() {
  const m = document.getElementById('modal-rollback-reason'); if (m) m.style.display = 'none';
  _pendingRollback = null;
}

function finishRollback() {
  if (!_pendingRollback) return;
  const { type, dk, dd, item, date } = _pendingRollback;
  const reason = (document.getElementById('rollback-reason-inp')?.value || '').trim();
  // Mark as rolled back
  item._rolled = true;
  item._rollInfo = { at: new Date().toISOString(), reason, date };
  // ── Reverse inventory effects via PhoneRepository ──────────────
  if (type === 'phones') {
    const ph = inventory.find(p => p.id === item.modelId);
    if (ph) {
      const restoredQty = ph.qty + (item.qty || 1);
      logPhoneEvent(ph.id, {type:'rollback', icon:'↩️', label:`تراجع عن بيع ${item.qty||1} قطعة${reason?' — '+reason:''}`, date: td(), time: ts()});
      phoneRepo.update(ph.id, { qty: restoredQty });
    }
  }
  // Save day data
  Storage.save(dk, dd);
  // Reload & re-render everything
  if (date === sel) loadData();
  renderAll();
  try { renderPhones(); } catch(e) {}
  try { renderBadges(); } catch(e) {}
  try { checkInvNotifications(); } catch(e) {}
  try { renderRatingAndInsights(); } catch(e) {}
  showToast(`↩️ تم التراجع عن العملية بنجاح${reason?' — '+reason:''}`, 'ok');
  const m = document.getElementById('modal-rollback-reason'); if (m) m.style.display = 'none';
  _pendingRollback = null;
}

function rollbackFromMonthly(type, idx, date) {
  rollbackTransaction(type, idx, date);
  // Re-render monthly after short delay
  setTimeout(() => { try { renderMonthly(); } catch(e) {} }, 400);
}

function getTransactionLabel(type, item) {
  if (type === 'acc')     return `إكسسوار: ${item.name} — ${fmt(item.sell)} ج`;
  if (type === 'used')    return `مستعمل: ${item.name} — ${fmt(item.sell)} ج`;
  if (type === 'cash')    return `كاش: ${item.service} ${item.cashType} — ${fmt(item.amount)} ج`;
  if (type === 'sw')      return `سوفت وير: ${item.name} — ${fmt(item.price)} ج`;
  if (type === 'phones')  return `هاتف: ${item.modelName||item.brand+' '+item.model} × ${item.qty||1} — ربح ${fmt(item.profit||0)} ج`;
  if (type === 'repairs') return `صيانة: ${item.brand||''} ${item.model||''} — ${fmt(item.servicePrice||0)} ج`;
  return type;
}
