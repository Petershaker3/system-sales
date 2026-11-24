// ═══════════════════════════════════════════════════════════
// phones.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

const phoneRepo = new PhoneRepository();

function getPhoneSales(modelId,days=30){
  const from=new Date();from.setDate(from.getDate()-days);const fromStr=from.toISOString().split('T')[0];
  let sales=[];
  const dayKeys=Storage.search('mshop_d_');
  dayKeys.forEach(k=>{const date=k.replace('mshop_d_','');if(date<fromStr)return;
  const d=Storage.get(k);if(!d)return;(d.phones||[]).filter(s=>s.modelId===modelId&&!s._rolled).forEach(s=>sales.push({...s,date}));});
  return sales;
}

function getDaysToStockout(phone){const sold30=getPhoneSales(phone.id,30).reduce((t,s)=>t+s.qty,0);if(!sold30||!phone.qty)return null;return Math.round(phone.qty/(sold30/30));}

function getPhoneLabel(ph){return`${ph.brand} ${ph.model} ${ph.ram}/${ph.storage}${ph.color?' ('+ph.color+')':''}`;}

function renderInvWidget(){
  const el=$('inv-widget-area');if(!el)return;
  const active=inventory.filter(p=>!p.archived);
  if(!active.length){el.innerHTML='';return;}
  const total=active.reduce((t,p)=>t+p.qty,0);
  const models=active.length,out=active.filter(p=>p.qty===0).length,low=active.filter(p=>p.qty>0&&p.qty<=2).length;
  const totalVal=active.reduce((t,p)=>t+(p.qty*(p.buyPrice||0)),0);
  el.innerHTML=`<div class="kpi-card" style="border-color:#06b6d440;cursor:pointer" onclick="ST('phones')">
    <div class="kpi-top"><span class="kpi-icon">📦</span><span class="kpi-label">مخزون الهواتف الجديدة</span></div>
    <div class="kpi-val" style="color:#06b6d4">${total} <span style="font-size:11px;font-weight:600;color:#475569">جهاز</span></div>
    <div class="kpi-sub">
      ${models} موديل
      ${out ? ` · <span style="color:#f87171">❌ ${out} منتهي</span>` : ''}
      ${low ? ` · <span style="color:#f59e0b">⚠️ ${low} منخفض</span>` : ''}
    </div>
    <div class="kpi-sub" style="color:${adminUnlocked?'#a78bfa':'#334155'}">${adminUnlocked ? fmt(totalVal)+' ج' : '🔒 اضغط للكشف'}</div>
  </div>`;
}

function renderInvSummary(){
  _lastRender = renderPhones;
  const el=$('inv-summary-row');if(!el)return;
  const total=inventory.reduce((t,p)=>t+p.qty,0),totalVal=inventory.reduce((t,p)=>t+(p.qty*(p.buyPrice||0)),0),low=inventory.filter(p=>p.qty>0&&p.qty<=2).length,out=inventory.filter(p=>p.qty===0).length;
  const frozen=inventory.filter(p=>p.qty&&!getPhoneSales(p.id,60).length).reduce((t,p)=>t+(p.qty*(p.buyPrice||0)),0);
  const prot=(val,cb)=>adminUnlocked?`${fmt(val)} ج`:`<span style="cursor:pointer;color:#475569;letter-spacing:1px;font-size:13px" onclick="${cb}" title="اضغط لإظهار القيمة">••••</span>`;
  el.innerHTML=`<div class="inv-sum-card"><div class="inv-sum-lbl">موديلات</div><div class="inv-sum-val" style="color:#06b6d4">${inventory.filter(p=>!p.archived).length}</div></div><div class="inv-sum-card"><div class="inv-sum-lbl">إجمالي الأجهزة</div><div class="inv-sum-val">${total}</div></div><div class="inv-sum-card" style="${!adminUnlocked?'cursor:pointer':''}" onclick="${!adminUnlocked?'requireAdmin(renderInvSummary)':''}"><div class="inv-sum-lbl">قيمة المخزون ${!adminUnlocked?'🔒':''}</div><div class="inv-sum-val" style="color:#a78bfa;font-size:13px">${prot(totalVal,"requireAdmin(renderInvSummary)")}</div></div><div class="inv-sum-card"><div class="inv-sum-lbl">منخفض ⚠️</div><div class="inv-sum-val" style="color:#f59e0b">${low}</div></div><div class="inv-sum-card"><div class="inv-sum-lbl">منتهي ❌</div><div class="inv-sum-val" style="color:#f87171">${out}</div></div><div class="inv-sum-card" style="${!adminUnlocked?'cursor:pointer':''}" onclick="${!adminUnlocked?'requireAdmin(renderInvSummary)':''}"><div class="inv-sum-lbl">رأس مال مجمد ${!adminUnlocked?'🔒':''}</div><div class="inv-sum-val" style="color:#ef4444;font-size:12px">${prot(frozen,"requireAdmin(renderInvSummary)")}</div></div>`;
  $('ph-cnt').textContent=inventory.length;$('ph-meta').innerHTML=`أجهزة: <b style="color:#06b6d4">${total}</b>`;
}

function openEditPhone(id){const ph=inventory.find(p=>p.id===id);if(!ph)return;editingPhoneId=id;const t=$('add-phone-title');if(t)t.textContent='✏️ تعديل الموديل';$('ph-brand').value=ph.brand;$('ph-model').value=ph.model;$('ph-ram').value=ph.ram;$('ph-storage').value=ph.storage;$('ph-color').value=ph.color||'';$('ph-code').value=ph.internalCode||'';$('ph-qty').value=ph.qty;$('ph-buy').value=ph.buyPrice;$('ph-supplier').value=ph.supplier||'';$('ph-notes').value=ph.notes||'';$('ph-err').textContent='';$('modal-add-phone').style.display='flex';}

function closeAddPhone(){$('modal-add-phone').style.display='none';editingPhoneId=null;}

function deletePhone(id){if(!confirm('حذف هذا الموديل؟'))return;phoneRepo.delete(id);renderPhones();}

function openSellPhone(id){
  const ph=inventory.find(p=>p.id===id);if(!ph||!ph.qty)return;
  sellingPhoneId=id;
  $('sell-phone-info').innerHTML=`<b>${getPhoneLabel(ph)}</b><br>متاح: <b style="color:#4ade80">${ph.qty} قطعة</b> | سعر الشراء: <b>${adminUnlocked?fmt(ph.buyPrice)+' ج':'***'}</b>`;
  $('sell-qty').value='1';$('sell-qty').max=ph.qty;$('sell-price').value='';$('sell-err').textContent='';$('sell-profit-preview').textContent='';
  $('modal-sell-phone').style.display='flex';
  $('sell-price').oninput=()=>{const sp=n($('sell-price').value),q=parseInt($('sell-qty').value)||1;if(sp&&ph.buyPrice&&adminUnlocked){const prof=(sp-ph.buyPrice)*q;$('sell-profit-preview').innerHTML=`ربح متوقع: <b style="color:${prof>=0?'#4ade80':'#f87171'}">${fmt(prof)} ج</b>`;}else $('sell-profit-preview').textContent='';};
  setTimeout(()=>$('sell-price').focus(),100);
}

function closeSellPhone(){$('modal-sell-phone').style.display='none';sellingPhoneId=null;}

function confirmSell(){
  const ph=inventory.find(p=>p.id===sellingPhoneId);if(!ph)return;
  const qty=parseInt(g('sell-qty'))||1,sp=n(g('sell-price'));
  if(!sp){$('sell-err').textContent='أدخل سعر البيع';return;}
  if(qty>ph.qty){$('sell-err').textContent='الكمية أكبر من المتاح';return;}
  const newQty = ph.qty - qty;
  const profit=(sp-ph.buyPrice)*qty;
  phoneTransactionRepo.create({modelId:ph.id,modelName:getPhoneLabel(ph),brand:ph.brand,model:ph.model,qty,buyPrice:ph.buyPrice,sellPrice:sp,profit,date:td(),time:ts()});
  logPhoneEvent(ph.id,{type:'sale',icon:'💰',label:`بيع ${qty} قطعة بسعر ${fmt(sp)} ج — ربح ${fmt(profit)} ج`,date:td(),time:ts(),qty,sellPrice:sp,profit});
  phoneRepo.update(ph.id, { qty: newQty });
  closeSellPhone();renderPhones();renderAll();
  showToast(`✅ تم البيع! ربح: ${fmt(profit)} ج`,'ok');
  checkInvNotifications();
}

function openAddStock(id){
  const ph=inventory.find(p=>p.id===id);if(!ph)return;
  stockingPhoneId=id;
  const avgPrice=ph.purchaseHistory?.length ? Math.round(ph.purchaseHistory.reduce((t,h)=>t+(h.price||0)*h.qty,0)/ph.purchaseHistory.reduce((t,h)=>t+h.qty,0)) : ph.buyPrice;
  $('stock-info').innerHTML=`<b>${getPhoneLabel(ph)}</b><br>كمية حالية: <b style="color:#06b6d4">${ph.qty}</b>${avgPrice&&adminUnlocked?` · متوسط الشراء: <b style="color:#fbbf24">${fmt(avgPrice)} ج</b>`:''}`;
  $('stock-qty').value='';$('stock-buy').value=ph.buyPrice||'';$('stock-supplier').value=ph.supplier||'';
  const priceWarn=$('stock-price-warn');if(priceWarn)priceWarn.textContent='';
  $('modal-add-stock').style.display='flex';
  const buyInp=$('stock-buy');
  if(buyInp){buyInp.oninput=()=>{
    const newPrice=n(buyInp.value);
    const warn=$('stock-price-warn');if(!warn||!newPrice||!avgPrice)return;
    const diff=((newPrice-avgPrice)/avgPrice*100).toFixed(1);
    if(Math.abs(diff)>=5){
      warn.innerHTML=`<span style="color:${diff>0?'#f87171':'#4ade80'};font-size:11px">${diff>0?'⬆️':'⬇️'} السعر الجديد ${diff>0?'أعلى':'أقل'} من المتوسط بنسبة <b>${Math.abs(diff)}%</b>${diff>15?'  تنبيه: فرق كبير!':''}</span>`;
    } else warn.textContent='';
  };}
  setTimeout(()=>$('stock-qty').focus(),100);
}

function closeAddStock(){$('modal-add-stock').style.display='none';stockingPhoneId=null;}

function confirmAddStock(){
  const ph=inventory.find(p=>p.id===stockingPhoneId);if(!ph)return;
  const qty=parseInt(g('stock-qty'))||0,buy=n(g('stock-buy')),sup=g('stock-supplier');
  if(!qty){showToast('أدخل الكمية','err');return;}
  const newQty = ph.qty + qty;
  const newBuy = buy || ph.buyPrice;
  const newSup = sup || ph.supplier;
  const newHistory = [...(ph.purchaseHistory||[])];
  newHistory.unshift({price:newBuy,supplier:newSup,date:td(),qty});
  logPhoneEvent(ph.id,{type:'stock',icon:'📦',label:`شراء ${qty} قطعة${buy?` بسعر ${fmt(buy)} ج`:''}${sup?' من '+sup:''}`,date:td(),time:ts(),qty,price:buy,supplier:sup});
  phoneRepo.update(ph.id, { qty: newQty, buyPrice: newBuy, supplier: newSup, lastBuyDate: td(), purchaseHistory: newHistory });
  closeAddStock();renderPhones();
}

function openPhoneDetail(id){detailPhoneId=id;renderPhoneDetail();$('modal-phone-detail').style.display='flex';}

function closePhoneDetail(){$('modal-phone-detail').style.display='none';}

function openShortage(){
  const el=$('shortage-content');if(!el)return;
  const low=inventory.filter(p=>p.qty<=2).sort((a,b)=>a.qty-b.qty);
  el.innerHTML=low.length?low.map(ph=>`<div class="shortage-item${ph.qty===0?' out':''}"><span style="font-size:20px">${ph.qty===0?'❌':'⚠️'}</span><div style="flex:1"><div style="font-size:13px;font-weight:700;color:#e2e8f0">${ph.brand} ${ph.model}</div><div style="font-size:10px;color:#64748b">${ph.ram}/${ph.storage} · مورد: ${ph.supplier||'—'}</div></div><div style="text-align:center"><div style="font-size:16px;font-weight:800;color:${ph.qty===0?'#f87171':'#f59e0b'}">${ph.qty}</div><div style="font-size:9px;color:#64748b">قطعة</div></div><button class="ph-act" style="background:#3b82f6;color:#fff" onclick="$('modal-shortage').style.display='none';openAddStock('${ph.id}')">+ مخزون</button></div>`).join(''):`<div class="empty">✅ لا توجد نواقص!</div>`;
  $('modal-shortage').style.display='flex';
}

function openSuppliers(){
  const el=$('suppliers-content');if(!el)return;
  const sm={};inventory.forEach(ph=>{(ph.purchaseHistory||[]).forEach(h=>{const sup=h.supplier||'غير محدد';if(!sm[sup])sm[sup]={cnt:0,total:0,models:[],lastDate:''};sm[sup].cnt++;sm[sup].total+=(h.price||0)*(h.qty||0);if(!sm[sup].models.includes(ph.brand+' '+ph.model))sm[sup].models.push(ph.brand+' '+ph.model);if(h.date>sm[sup].lastDate)sm[sup].lastDate=h.date;});});
  const sups=Object.entries(sm).sort((a,b)=>b[1].total-a[1].total);
  el.innerHTML=sups.length?sups.map(([name,d])=>`<div class="supplier-card"><div style="font-size:13px;font-weight:800;color:#e2e8f0;margin-bottom:5px">🏭 ${esc(name)}</div><div style="font-size:11px;color:#64748b;line-height:1.7">عدد العمليات: <b>${d.cnt}</b><br>إجمالي المشتريات: <b style="color:${adminUnlocked?'#fbbf24':'#334155'}">${adminUnlocked?fmt(d.total)+' ج':'***'}</b><br>آخر عملية: <b>${d.lastDate||'—'}</b><br>الموديلات: <span style="color:#60a5fa">${d.models.slice(0,3).join(' · ')}</span></div></div>`).join(''):`<div class="empty">لا توجد بيانات موردين</div>`;
  $('modal-suppliers').style.display='flex';
}

function openReorder(){
  const el=$('reorder-content');if(!el)return;
  const suggs=inventory.map(ph=>{const sold30=getPhoneSales(ph.id,30).reduce((t,s)=>t+s.qty,0);const dailyRate=sold30/30;const daysLeft=dailyRate?ph.qty/dailyRate:999;const suggestQty=Math.max(1,Math.round(sold30*1.5));return{ph,daysLeft,suggestQty,sold30,score:daysLeft<=7?3:daysLeft<=14?2:ph.qty<=1?1:0};}).filter(s=>s.score>0).sort((a,b)=>b.score-a.score);
  el.innerHTML=suggs.length?suggs.map(({ph,daysLeft,suggestQty,sold30})=>`<div class="reorder-item"><span style="font-size:18px">${daysLeft<=3?'🔴':daysLeft<=7?'🟡':'🟢'}</span><div style="flex:1"><div style="font-size:12px;font-weight:700;color:#e2e8f0">${ph.brand} ${ph.model} ${ph.ram}/${ph.storage}</div><div style="font-size:10px;color:#64748b">متبقي: ${ph.qty} · مبيع آخر 30 يوم: ${sold30}</div></div><div style="text-align:center"><div style="font-size:13px;font-weight:800;color:#4ade80">${suggestQty}</div><div style="font-size:9px;color:#64748b">مقترح</div></div><button class="ph-act" style="background:#3b82f6;color:#fff" onclick="$('modal-reorder').style.display='none';openAddStock('${ph.id}')">+ طلب</button></div>`).join(''):`<div class="empty">✅ لا توجد اقتراحات دلوقتي</div>`;
  $('modal-reorder').style.display='flex';
}

function setPhonesTab(tab, el) {
  phonesTab = tab;
  // Update tab styles
  ['inv','sales','brand','short','reord','supp'].forEach(t => {
    const b = document.getElementById('pst-' + t);
    const p = document.getElementById('phs-' + t);
    if (b) { b.classList.remove('on'); b.style.background = '#111827'; b.style.borderColor = '#1e293b'; b.style.color = '#64748b'; }
    if (p) p.style.display = 'none';
  });
  if (el) { el.classList.add('on'); el.style.background = '#06b6d4'; el.style.borderColor = '#06b6d4'; el.style.color = '#fff'; }
  const panel = document.getElementById('phs-' + tab);
  if (panel) panel.style.display = 'block';
  // Render selected tab
  if (tab === 'inv')   renderPhones();
  if (tab === 'sales') renderPhonesSales();
  if (tab === 'brand') renderPhonesAnalytics();
  if (tab === 'short') renderPhonesShortage();
  if (tab === 'reord') renderPhonesReorder();
  if (tab === 'supp')  renderPhonesSuppliers();
}

function getMovement(modelId) {
  const s30 = getPhoneSales(modelId, 30).reduce((t, s) => t + s.qty, 0);
  const s60 = getPhoneSales(modelId, 60).reduce((t, s) => t + s.qty, 0);
  if (s60 === 0) return { label:'راكد', cls:'move-slow', icon:'💤', score:0 };
  if (s30 >= 3)  return { label:'سريع الحركة', cls:'move-fast', icon:'🔥', score:3 };
  if (s30 >= 1)  return { label:'متوسط الحركة', cls:'move-med', icon:'📊', score:2 };
  return { label:'بطيء الحركة', cls:'move-slow', icon:'🐌', score:1 };
}

function archivePhone(id) {
  const ph = inventory.find(p => p.id === id);
  if (!ph) return;
  if (!confirm(`أرشفة "${ph.brand} ${ph.model}"؟\nستُحفظ المبيعات والأرباح السابقة.`)) return;
  phoneRepo.update(id, { archived: true });
  renderPhones();
  showToast('تم الأرشفة — يمكن الاستعادة من الإعدادات', 'info');
}

function restorePhone(id) {
  const ph = inventory.find(p => p.id === id);
  if (!ph) return;
  phoneRepo.update(id, { archived: false });
  renderPhones();
  showToast('تمت الاستعادة ✓', 'ok');
}

function revealSaleProfit(key) {
  if (adminUnlocked) { revealedSales.add(key); renderPhonesSales(); return; }
  requireAdmin(() => { revealedSales.add(key); renderPhonesSales(); });
}

function renderPhonesSales() {
  _lastRender = renderPhonesSales;
  const el = document.getElementById('ph-sales-content'); if (!el) return;
  const allSales = [];
  const dayKeys = Storage.search('mshop_d_');
  dayKeys.forEach(k => {
    const date = k.replace('mshop_d_', '');
    const d = Storage.get(k); if (!d) return;
    (d.phones || []).forEach((s,dayIdx) => allSales.push({...s, date, _dayIdx:dayIdx}));
  });
  allSales.sort((a, b) => b.date.localeCompare(a.date));

  // ── بحث وفلترة (قسم المبيعات) ──────────────────────────────
  const q = (document.getElementById('ph-sales-search')?.value || '').toLowerCase().trim();
  const dateFilter = document.getElementById('ph-sales-filter')?.value || 'all';
  const today = td(), monthPrefix = today.slice(0, 7);
  let sales = allSales;
  if (q) sales = sales.filter(s => [s.modelName, s.date].filter(Boolean).join(' ').toLowerCase().includes(q));
  if (dateFilter === 'today')  sales = sales.filter(s => s.date === today);
  else if (dateFilter === 'month')  sales = sales.filter(s => s.date.startsWith(monthPrefix));
  else if (dateFilter === 'rolled') sales = sales.filter(s => s._rolled);

  const activeSales = sales.filter(s => !s._rolled);
  const totalProfit = adminUnlocked ? activeSales.reduce((t, s) => t + (s.profit || 0), 0) : null;
  if (!allSales.length) { el.innerHTML = `<div class="empty">لا توجد مبيعات بعد</div>`; return; }

  // ── تقسيم ثابت: اليوم / الشهر / الإجمالي (بمعزل عن فلتر البحث) ──
  const allActive = allSales.filter(s => !s._rolled);
  const periodStats = (list) => ({ cnt: list.length, qty: list.reduce((t,s)=>t+(s.qty||1),0), profit: list.reduce((t,s)=>t+(s.profit||0),0) });
  const todayStats = periodStats(allActive.filter(s => s.date === today));
  const monthStats = periodStats(allActive.filter(s => s.date.startsWith(monthPrefix)));
  const totalStats = periodStats(allActive);
  const periodCard = (lbl, st, color) => `<div class="inv-sum-card"><div class="inv-sum-lbl">${lbl}</div><div class="inv-sum-val" style="color:${color}">${st.cnt} <span style="font-size:10px;color:#64748b">عملية</span></div><div style="font-size:10px;color:#64748b">أجهزة: ${st.qty}</div><div style="font-size:11px;color:#4ade80">${mfmt(st.profit)}</div></div>`;
  const periodBreakdownHtml = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:9px">
      ${periodCard('📅 اليوم', todayStats, '#06b6d4')}
      ${periodCard('🗓️ الشهر', monthStats, '#a78bfa')}
      ${periodCard('📊 الإجمالي', totalStats, '#60a5fa')}
    </div>`;

  if (!sales.length) { el.innerHTML = periodBreakdownHtml + `<div class="empty">🔍 لا توجد نتائج مطابقة للبحث</div>`; return; }
  el.innerHTML = periodBreakdownHtml + `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:11px">
      <div class="inv-sum-card"><div class="inv-sum-lbl">عمليات البيع (حسب الفلتر)</div><div class="inv-sum-val" style="color:#06b6d4">${activeSales.length}</div></div>
      <div class="inv-sum-card"><div class="inv-sum-lbl">إجمالي الأجهزة</div><div class="inv-sum-val" style="color:#e2e8f0">${activeSales.reduce((t,s)=>t+(s.qty||1),0)}</div></div>
      <div class="inv-sum-card"><div class="inv-sum-lbl">إجمالي الأرباح</div><div class="inv-sum-val" style="color:#4ade80;font-size:12px">${mfmt(totalProfit??0)}</div></div>
    </div>
    ${sales.slice(0, 100).map((s,idx) => {
      const rolled = s._rolled;
      const saleKey = `${s.date}_${s._dayIdx}`;
      const revealed = adminUnlocked || revealedSales.has(saleKey);
      const profitHtml = revealed
        ? `<span style="color:#4ade80;font-size:11px">${fmt(s.profit||0)} ج</span>`
        : `<span style="cursor:pointer;color:#334155;letter-spacing:1px;font-size:11px" onclick="revealSaleProfit('${saleKey}')" title="اضغط لإظهار الربح">•••</span>`;
      return `<div class="item" style="${rolled?'opacity:.45;background:#0a0f1e':''}">
        <span class="iname" style="${rolled?'text-decoration:line-through':''}">${esc(s.modelName||'')} <span style="font-size:10px;color:#64748b">×${s.qty||1}</span></span>
        <span style="font-size:11px;color:#94a3b8">${fmt(s.sellPrice||0)} ج</span>
        ${rolled ? `<span style="font-size:10px;color:#f87171;padding:1px 5px;background:#450a0a;border-radius:4px">↩ متراجع</span>` : profitHtml}
        <span class="itime">${s.date}</span>
        ${!rolled ? `<button class="delbtn" style="background:#1c1200;color:#f59e0b;border:1px solid #92400e" onclick="rollbackTransaction('phones',${s._dayIdx},'${s.date}')" title="تراجع عن البيع">↩</button>` : ''}
      </div>`;
    }).join('')}`;
}

function openBrandDetail(brand) {
  const phs = inventory.filter(p => !p.archived && p.brand === brand);
  const allSales = [];
  phs.forEach(ph => { getPhoneSales(ph.id, 3650).forEach(s => allSales.push({...s, model:ph.model, ph})); });
  const totalSales  = allSales.reduce((t, s) => t + s.qty, 0);
  const totalProfit = allSales.reduce((t, s) => t + (s.profit || 0), 0);
  const totalValue  = phs.reduce((t, p) => t + p.qty * (p.buyPrice || 0), 0);
  const modelSales  = {};
  allSales.forEach(s => { if (!modelSales[s.model]) modelSales[s.model] = {qty:0,profit:0}; modelSales[s.model].qty += s.qty; modelSales[s.model].profit += (s.profit||0); });
  const mdl = document.getElementById('modal-brand-detail');
  const ttl = document.getElementById('brand-detail-title');
  const cnt = document.getElementById('brand-detail-content');
  if (!mdl || !ttl || !cnt) return;
  ttl.textContent = '📱 ' + brand;
  cnt.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:12px">
      <div class="inv-sum-card"><div class="inv-sum-lbl">موديلات</div><div class="inv-sum-val" style="color:#06b6d4">${phs.length}</div></div>
      <div class="inv-sum-card"><div class="inv-sum-lbl">في المخزون</div><div class="inv-sum-val">${phs.reduce((t,p)=>t+p.qty,0)}</div></div>
      <div class="inv-sum-card"><div class="inv-sum-lbl">إجمالي مبيع</div><div class="inv-sum-val" style="color:#4ade80">${totalSales}</div></div>
      <div class="inv-sum-card" onclick="${!adminUnlocked?'requireAdmin(()=>openBrandDetail(\''+brand+'\'))':''}" style="${!adminUnlocked?'cursor:pointer':''}">
        <div class="inv-sum-lbl">قيمة المخزون${!adminUnlocked?' 🔒':''}</div>
        <div class="inv-sum-val" style="color:#fbbf24;font-size:11px">${adminUnlocked?fmt(totalValue)+' ج':'<span style="letter-spacing:1px;color:#475569">••••</span>'}</div>
      </div>
      <div class="inv-sum-card" style="grid-column:span 2" onclick="${!adminUnlocked?'requireAdmin(()=>openBrandDetail(\''+brand+'\'))':''}" style="${!adminUnlocked?'cursor:pointer':''}">
        <div class="inv-sum-lbl">إجمالي الأرباح${!adminUnlocked?' 🔒':''}</div>
        <div class="inv-sum-val" style="color:#4ade80;font-size:11px">${adminUnlocked?fmt(totalProfit)+' ج':'<span style="letter-spacing:1px;color:#475569">••••</span>'}</div>
      </div>
    </div>
    <div style="font-size:11px;font-weight:700;color:#e2e8f0;margin-bottom:8px">الموديلات</div>
    ${phs.map(ph => {
      const mv = getMovement(ph.id);
      const ms = modelSales[ph.model] || {qty:0, profit:0};
      return `<div class="phone-card" style="margin-bottom:6px">
        <div class="phone-hdr">
          <div class="phone-title" style="font-size:12px">${ph.model}</div>
          <span class="phone-spec">${ph.ram}/${ph.storage}</span>
          <span class="move-badge ${mv.cls}">${mv.icon}</span>
          <span class="ph-qty-badge" style="background:${ph.qty?'#052e16':'#450a0a'};color:${ph.qty?'#4ade80':'#f87171'}">${ph.qty}</span>
        </div>
        <div style="display:flex;gap:10px;font-size:11px;color:#64748b;margin-top:4px">
          <span>مبيع: <b style="color:#4ade80">${ms.qty}</b></span>
          <span>ربح: <b style="color:${adminUnlocked?'#fbbf24':'#334155'}">${adminUnlocked?fmt(ms.profit)+' ج':'***'}</b></span>
          ${ph.supplier?`<span>مورد: <b style="color:#60a5fa">${esc(ph.supplier)}</b></span>`:''}
        </div>
        <div style="display:flex;gap:5px;margin-top:6px">
          <button class="ph-act" style="background:#4ade80;color:#000" onclick="document.getElementById('modal-brand-detail').style.display='none';openSellPhone('${ph.id}')" ${ph.qty?'':'disabled style="opacity:.4"'}>💰 بيع</button>
          <button class="ph-act" style="background:#3b82f6;color:#fff" onclick="document.getElementById('modal-brand-detail').style.display='none';openAddStock('${ph.id}')">+ مخزون</button>
          <button class="ph-act" style="background:#06b6d4;color:#000" onclick="document.getElementById('modal-brand-detail').style.display='none';openPhoneDetail('${ph.id}')">📋</button>
        </div>
      </div>`;
    }).join('')}`;
  mdl.style.display = 'flex';
}

function renderPhonesReorder() {
  const el = document.getElementById('ph-reord-content'); if (!el) return;
  const suggs = inventory.filter(p => !p.archived).map(ph => {
    const sold30 = getPhoneSales(ph.id, 30).reduce((t, s) => t + s.qty, 0);
    const sold7  = getPhoneSales(ph.id,  7).reduce((t, s) => t + s.qty, 0);
    const dailyRate = sold30 / 30;
    const daysLeft  = dailyRate ? ph.qty / dailyRate : 999;
    const suggestQty = Math.max(2, Math.round(sold30 * 1.5));
    let score = 0, reasons = [];
    if (ph.qty === 0)       { score = 4; reasons.push({lbl:'نفد من المخزون',   color:'#f87171', icon:'❌'}); }
    else if (daysLeft <= 7) { score = 3; reasons.push({lbl:'سينفد خلال أسبوع', color:'#f87171', icon:'🔴'}); }
    else if (daysLeft <= 14){ score = 2; reasons.push({lbl:'منخفض المخزون',    color:'#fbbf24', icon:'🟡'}); }
    else if (ph.qty <= 1)   { score = 1; reasons.push({lbl:'كمية حرجة',        color:'#fbbf24', icon:'⚠️'}); }
    if (sold30 >= 5) reasons.push({lbl:'مبيعات مرتفعة آخر 30 يوم', color:'#4ade80', icon:'📈'});
    if (sold7  >= 3) reasons.push({lbl:'حركة سريعة هذا الأسبوع',   color:'#06b6d4', icon:'⚡'});
    return {ph, daysLeft, suggestQty, sold30, sold7, score, reasons};
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score || b.sold30 - a.sold30);
  if (!suggs.length) { el.innerHTML = `<div class="empty">✅ المخزون في حالة جيدة — لا توجد اقتراحات</div>`; return; }
  el.innerHTML = `<div style="font-size:10px;color:#64748b;margin-bottom:8px;padding:7px;background:#0f172a;border-radius:7px;border:1px solid #1e293b">
    📋 ${suggs.length} موديل يحتاج إعادة طلب — مرتبة حسب الأولوية
  </div>` + suggs.map(({ph, daysLeft, suggestQty, sold30, reasons}) => `
  <div class="reorder-item">
    <span style="font-size:20px">${ph.qty===0?'❌':daysLeft<=7?'🔴':'🟡'}</span>
    <div style="flex:1;min-width:0">
      <div style="font-size:12px;font-weight:700;color:#e2e8f0;margin-bottom:3px">${ph.brand} ${ph.model} <span style="color:#64748b;font-weight:400">${ph.ram}/${ph.storage}</span></div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:4px">
        ${reasons.map(r=>`<span style="font-size:9px;background:${r.color}20;color:${r.color};padding:1px 6px;border-radius:10px">${r.icon} ${r.lbl}</span>`).join('')}
      </div>
      <div style="font-size:10px;color:#64748b">
        متبقي: <b style="color:${ph.qty===0?'#f87171':ph.qty<=2?'#fbbf24':'#e2e8f0'}">${ph.qty}</b>
        · مبيع/30 يوم: <b style="color:#4ade80">${sold30}</b>
        · ${daysLeft<999?'نفاد خلال ~<b style="color:#fbbf24">'+Math.round(daysLeft)+'</b> يوم':'حركة بطيئة'}
      </div>
    </div>
    <div style="text-align:center;min-width:40px">
      <div style="font-size:15px;font-weight:800;color:#4ade80">${suggestQty}</div>
      <div style="font-size:9px;color:#64748b">مقترح</div>
    </div>
    <button class="ph-act" style="background:#3b82f6;color:#fff;white-space:nowrap" onclick="openAddStock('${ph.id}')">+ طلب</button>
  </div>`).join('');
}

function renderPhonesSuppliers() {
  const el = document.getElementById('ph-supp-content'); if (!el) return;
  const sm = {};
  inventory.filter(p => !p.archived).forEach(ph => {
    (ph.purchaseHistory || []).forEach(h => {
      const sup = h.supplier || ph.supplier || 'غير محدد';
      if (!sm[sup]) sm[sup] = {ops:0, totalDevices:0, totalVal:0, models:[], lastDate:'', brands:{}};
      sm[sup].ops++;
      sm[sup].totalDevices += (h.qty || 0);
      sm[sup].totalVal += (h.price||0) * (h.qty||0);
      const mk = ph.brand + ' ' + ph.model;
      if (!sm[sup].models.includes(mk)) sm[sup].models.push(mk);
      if (!sm[sup].brands[ph.brand]) sm[sup].brands[ph.brand] = 0;
      sm[sup].brands[ph.brand] += (h.qty||0);
      if ((h.date||'') > sm[sup].lastDate) sm[sup].lastDate = h.date||'';
    });
  });
  const sups = Object.entries(sm).sort((a, b) => b[1].totalDevices - a[1].totalDevices);
  if (!sups.length) { el.innerHTML = `<div class="empty">لا توجد بيانات موردين</div>`; return; }
  const maxDev = Math.max(1, ...sups.map(([,d])=>d.totalDevices));
  el.innerHTML = `<div style="font-size:10px;color:#64748b;margin-bottom:9px;padding:7px;background:#0f172a;border-radius:7px;border:1px solid #1e293b">
    🏭 ${sups.length} مورد — مرتبة حسب عدد الأجهزة
  </div>` + sups.map(([name, d]) => {
    const topBrands = Object.entries(d.brands).sort((a,b)=>b[1]-a[1]).slice(0,3);
    const pct = Math.round(d.totalDevices / maxDev * 100);
    return `<div class="supplier-card" style="margin-bottom:9px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
        <div style="font-size:13px;font-weight:800;color:#e2e8f0">🏭 ${esc(name)}</div>
        <div style="display:flex;gap:5px">
          <span class="ibadge" style="background:#06b6d420;color:#06b6d4">${d.totalDevices} جهاز</span>
          <span class="ibadge" style="background:#1e293b;color:#64748b">${d.ops} عملية</span>
        </div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:#64748b;margin-bottom:7px">
        <span>الموديلات المختلفة: <b style="color:#e2e8f0">${d.models.length}</b></span>
        <span>آخر شراء: <b style="color:#e2e8f0">${d.lastDate||'—'}</b></span>
        <span>إجمالي المشتريات: <b style="color:${adminUnlocked?'#fbbf24':'#475569'}">${adminUnlocked?fmt(d.totalVal)+' ج':`<span style="cursor:pointer;letter-spacing:1px" onclick="requireAdmin(renderPhonesSuppliers)">••••</span>`}</b></span>
      </div>
      ${topBrands.length ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px">
        ${topBrands.map(([br,cnt])=>`<span style="font-size:10px;background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:2px 7px;color:#94a3b8">${br} <b style="color:#06b6d4">${cnt}</b></span>`).join('')}
      </div>` : ''}
      <div style="background:#0f172a;border-radius:5px;height:6px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#06b6d4,#3b82f6);border-radius:5px"></div>
      </div>
    </div>`;
  }).join('');
}

function openJard() {
  const el = document.getElementById('modal-jard'); if (!el) return;
  const si = document.getElementById('jard-search'); if (si) si.value = '';
  renderJard();
  el.style.display = 'flex';
  el.style.alignItems = 'flex-end';
  el.style.justifyContent = 'center';
}

function renderJard() {
  const el = document.getElementById('jard-list'); if (!el) return;
  const q = (document.getElementById('jard-search')?.value || '').trim().toLowerCase();
  let list = inventory.filter(p => !p.archived);
  if (q) list = list.filter(p => [p.brand,p.model,p.ram,p.storage,p.color].filter(Boolean).join(' ').toLowerCase().includes(q));
  if (!list.length) { el.innerHTML = `<div class="empty">لا توجد موديلات</div>`; return; }
  const jardLog = Storage.get('mshop_jard', {});
  el.innerHTML = list.map(ph => {
    const je = jardLog[ph.id] || {};
    const done = je.actual !== undefined;
    const diff = done ? je.actual - ph.qty : null;
    const diffColor = diff === 0 ? '#4ade80' : diff > 0 ? '#60a5fa' : '#f87171';
    return `<div style="background:${done?'#0a0f1e':'#0a0f1e'};border:1px solid ${done?(diff===0?'#4ade8030':'#f8717130'):'#1e293b'};border-radius:10px;padding:10px 11px;margin-bottom:7px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;color:#e2e8f0">${ph.brand} ${ph.model}</div>
          <div style="font-size:10px;color:#64748b">${ph.ram}/${ph.storage}${ph.color?' · '+ph.color:''}</div>
        </div>
        <div style="text-align:center;background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:5px 10px;min-width:44px">
          <div style="font-size:9px;color:#64748b">بالنظام</div>
          <div style="font-size:15px;font-weight:800;color:#06b6d4">${ph.qty}</div>
        </div>
        ${done ? `<div style="text-align:center;background:${diff===0?'#052e16':diff>0?'#1e3a5f':'#450a0a'};border:1px solid ${diffColor};border-radius:8px;padding:5px 10px;min-width:44px">
          <div style="font-size:9px;color:#64748b">الفعلي</div>
          <div style="font-size:15px;font-weight:800;color:${diffColor}">${je.actual}</div>
        </div>` : ''}
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <input type="number" id="jard-inp-${ph.id}" placeholder="الكمية الفعلية..." value="${done ? je.actual : ''}"
          style="width:90px;background:#0f172a;border:1px solid #1e293b;border-radius:7px;padding:6px 8px;color:#e2e8f0;font-size:14px;direction:ltr;text-align:center;font-weight:700" min="0">
        <input id="jard-note-${ph.id}" placeholder="ملاحظة / سبب الفرق..." value="${je.note||''}"
          style="flex:1;background:#0f172a;border:1px solid #1e293b;border-radius:7px;padding:6px 8px;color:#e2e8f0;font-size:11px;direction:rtl">
        <button onclick="saveJardEntry('${ph.id}')" style="background:#06b6d4;border:none;border-radius:7px;color:#000;padding:7px 12px;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap">✓ حفظ</button>
      </div>
      ${done ? `<div style="font-size:10px;margin-top:6px;color:${diffColor};display:flex;align-items:center;gap:5px">
        <span>${diff===0?'✅ متطابق':diff>0?`📈 زيادة +${diff}`:`📉 نقص ${diff}`}</span>
        ${je.note?`<span style="color:#64748b">· ${esc(je.note)}</span>`:''}
        <span style="color:#334155;margin-right:auto">· ${je.date||''}</span>
      </div>` : ''}
    </div>`;
  }).join('');
  // Summary
  const done   = list.filter(ph => jardLog[ph.id]?.actual !== undefined).length;
  const diffs  = list.filter(ph => jardLog[ph.id]?.actual !== undefined && jardLog[ph.id].actual !== ph.qty).length;
  const surp   = list.filter(ph => jardLog[ph.id]?.actual !== undefined && jardLog[ph.id].actual > ph.qty).length;
  const lack   = list.filter(ph => jardLog[ph.id]?.actual !== undefined && jardLog[ph.id].actual < ph.qty).length;
  const sum = document.getElementById('jard-summary');
  if (sum) sum.innerHTML = `<b style="color:#e2e8f0">${done}</b> / ${list.length} تم جردهم &nbsp;·&nbsp; `
    + (lack  ? `<span style="color:#f87171">نقص في ${lack} موديل</span> &nbsp;·&nbsp; ` : '')
    + (surp  ? `<span style="color:#60a5fa">زيادة في ${surp} موديل</span> &nbsp;·&nbsp; ` : '')
    + (done > 0 && diffs === 0 ? `<span style="color:#4ade80">✅ لا فروق</span>` : '')
    + (done === 0 ? `ابدأ بإدخال الكميات الفعلية` : '');
}

function saveJardEntry(id) {
  const inp = document.getElementById('jard-inp-' + id); if (!inp) return;
  const actual = parseInt(inp.value);
  if (isNaN(actual) || actual < 0) { showToast('أدخل كمية صحيحة', 'err'); return; }
  const ph = inventory.find(p => p.id === id); if (!ph) return;
  const note = (document.getElementById('jard-note-' + id)?.value || '').trim();
  const jardLog = Storage.get('mshop_jard', {});
  jardLog[id] = { actual, note, date: td(), systemQty: ph.qty };
  Storage.save('mshop_jard', jardLog);
  const diff = actual - ph.qty;
  if (diff === 0) showToast('✅ متطابق — تم الحفظ', 'ok');
  else if (diff > 0) showToast(`📈 زيادة +${diff} — تم التسجيل`, 'info');
  else showToast(`📉 نقص ${diff} — تم التسجيل`, 'err');
  renderJard();
}

function logPhoneEvent(id, event) {
  const ph = inventory.find(p => p.id === id); if (!ph) return;
  const newLog = [...(ph.eventLog || [])];
  newLog.unshift(event);
  if (newLog.length > 100) newLog.splice(100);
  phoneRepo.update(id, { eventLog: newLog });
}

function toggleFavorite(id, e) {
  if (e) e.stopPropagation();
  const ph = inventory.find(p => p.id === id); if (!ph) return;
  const nextFav = !ph.favorite;
  logPhoneEvent(id, {type:'edit', icon:'⭐', label: nextFav ? 'أضيف للمفضلة' : 'أُزيل من المفضلة', date:td(), time:ts()});
  phoneRepo.update(id, { favorite: nextFav });
  renderPhonesList();
}

function initCollapsedBrands() {
  if (collapsedBrands !== null) return;
  // First call: collapse all existing brands
  collapsedBrands = new Set(inventory.filter(p=>!p.archived).map(p=>p.brand));
}

function toggleBrandGroup(brand) {
  if (!collapsedBrands) initCollapsedBrands();
  if (collapsedBrands.has(brand)) collapsedBrands.delete(brand);
  else collapsedBrands.add(brand);
  renderPhonesList();
}

function renderPhonesList() {
  const el = document.getElementById('phones-list'); if (!el) return;
  const q      = (document.getElementById('ph-search')?.value||'').toLowerCase().trim();
  const filter = document.getElementById('ph-filter')?.value || 'all';
  let list = inventory.filter(p => !p.archived);
  if (q) list = list.filter(p => [p.brand,p.model,p.ram,p.storage,p.color,p.supplier,p.internalCode].filter(Boolean).join(' ').toLowerCase().includes(q));
  if (currentBrandFilter) list = list.filter(p => p.brand === currentBrandFilter);
  if (filter === 'fav')      list = list.filter(p => p.favorite);
  else if (filter === 'fast')     list = list.filter(p => getMovement(p.id).score === 3);
  else if (filter === 'medium')   list = list.filter(p => getMovement(p.id).score === 2);
  else if (filter === 'slow')     list = list.filter(p => getMovement(p.id).score === 1);
  else if (filter === 'stagnant') list = list.filter(p => getMovement(p.id).score === 0);
  else if (filter === 'low')      list = list.filter(p => p.qty > 0 && p.qty <= 2);
  else if (filter === 'out')      list = list.filter(p => p.qty === 0);

  if (!list.length) {
    el.innerHTML = `<div class="empty">📱 ${inventory.filter(p=>!p.archived).length?'لا توجد موديلات في هذه الفئة':'أضف أول موديل!'}</div>`;
    return;
  }

  // Flat search/filter → no grouping
  const isFlat = q || filter !== 'all' || currentBrandFilter;
  if (isFlat) {
    list.sort((a,b)=>(b.favorite?1:0)-(a.favorite?1:0)||b.qty-a.qty);
    el.innerHTML = list.map(ph => renderPhoneCard(ph)).join('');
    return;
  }

  // ── Hierarchical brand groups ───────────────────────────────
  initCollapsedBrands();
  // Sync: add any new brand that appeared to collapsed set
  const brandOrder = [...new Set(list.map(p=>p.brand))].sort((a,b)=>{
    const afav = list.some(p=>p.brand===a&&p.favorite)?1:0;
    const bfav = list.some(p=>p.brand===b&&p.favorite)?1:0;
    return bfav-afav || a.localeCompare(b, 'ar');
  });

  el.innerHTML = brandOrder.map(brand => {
    const models = list.filter(p=>p.brand===brand).sort((a,b)=>(b.favorite?1:0)-(a.favorite?1:0)||b.qty-a.qty);
    const totalQty  = models.reduce((t,p)=>t+p.qty,0);
    const outCnt    = models.filter(p=>p.qty===0).length;
    const lowCnt    = models.filter(p=>p.qty>0&&p.qty<=2).length;
    const favCnt    = models.filter(p=>p.favorite).length;
    const isCollapsed = collapsedBrands.has(brand);
    const statusColor = outCnt ? '#f87171' : lowCnt ? '#fbbf24' : '#4ade80';

    return `<div class="brand-group" style="margin-bottom:10px">
      <!-- Brand header -->
      <div onclick="toggleBrandGroup('${brand}')" style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0f172a;border:1px solid #1e293b;border-radius:${isCollapsed?'10px':'10px 10px 0 0'};cursor:pointer;user-select:none;transition:background .15s"
           onmouseenter="this.style.background='#141e35'" onmouseleave="this.style.background='#0f172a'">
        <span style="font-size:14px;transition:transform .2s;display:inline-block;transform:rotate(${isCollapsed?'-90deg':'0deg'})"
              style="flex-shrink:0">▼</span>
        <div style="font-size:14px;font-weight:800;color:#e2e8f0;flex:1">${esc(brand)}</div>
        ${favCnt?`<span style="font-size:11px;color:#f59e0b">⭐ ${favCnt}</span>`:''}
        <span style="font-size:11px;color:#64748b">${models.length} موديل</span>
        <span style="font-size:12px;font-weight:700;background:${outCnt?'#450a0a':lowCnt?'#1c1200':'#052e16'};color:${statusColor};border-radius:6px;padding:3px 8px">${totalQty} قطعة</span>
        ${outCnt?`<span style="font-size:10px;color:#f87171">❌${outCnt}</span>`:''}
      </div>
      <!-- Models list -->
      ${isCollapsed?'':
        `<div style="border:1px solid #1e293b;border-top:none;border-radius:0 0 10px 10px;overflow:hidden">
          ${models.map((ph,i) => renderPhoneCard(ph, i===models.length-1)).join('')}
        </div>`
      }
    </div>`;
  }).join('');
}

function renderPhoneCard(ph, isLast=false) {
  const mv = getMovement(ph.id), days = getDaysToStockout(ph);
  const isLow = ph.qty > 0 && ph.qty <= 2, isOut = ph.qty === 0;
  const qtyColor = isOut?'#f87171':isLow?'#f59e0b':'#4ade80';
  const qtyBg    = isOut?'#450a0a':isLow?'#1c1200':'#052e16';
  const stagnantDays = parseInt(Storage.getRaw('mshop_stagnant_days')||'30');
  const isStag = mv.score===0&&ph.qty>0;
  const lastSale = isStag?(getPhoneSales(ph.id,365)[0]?.date||ph.lastBuyDate||''):'';
  const stagDays = isStag&&lastSale?Math.round((new Date()-new Date(lastSale+'T12:00:00'))/86400000):0;
  const showStagWarn = isStag&&stagDays>=stagnantDays;
  const hasSpec = ph.ram || ph.storage;
  return `<div class="phone-card${isOut?' out-stock':isLow?' low-stock':''}" style="border-radius:0;border-left:none;border-right:none;border-top:none;${isLast?'border-bottom:none':''}">
    <div class="phone-hdr">
      <button style="background:none;border:none;cursor:pointer;font-size:15px;padding:0 3px 0 0;line-height:1;flex-shrink:0" onclick="toggleFavorite('${ph.id}',event)">${ph.favorite?'⭐':'☆'}</button>
      <div class="phone-title" style="font-size:13px">${ph.model}</div>
      ${hasSpec?`<span class="phone-spec">${[ph.ram,ph.storage].filter(Boolean).join('/')}</span>`:''}
      ${ph.color?`<span class="phone-spec" style="color:#a78bfa">${esc(ph.color)}</span>`:''}
      <span class="move-badge ${mv.cls}">${mv.icon}</span>
      <span class="ph-qty-badge" style="background:${qtyBg};color:${qtyColor}">${ph.qty}</span>
    </div>
    ${showStagWarn?`<div style="font-size:10px;color:#fbbf24;background:#1c1200;border-radius:5px;padding:2px 7px;margin-bottom:5px">💤 لم يُباع منذ ${stagDays} يومًا</div>`:''}
    <div class="phone-stats">
      <span class="ph-stat">شراء: <b>${adminUnlocked?fmt(ph.buyPrice)+' ج':`<span style="cursor:pointer;color:#475569;letter-spacing:1px" onclick="requireAdmin(renderPhones)">••••</span>`}</b></span>
      ${ph.supplier?`<span class="ph-stat">مورد: <b>${esc(ph.supplier)}</b></span>`:''}
      ${days!==null?`<span style="font-size:10px;color:#f59e0b">⏳~${days}ي</span>`:''}
    </div>
    <div class="phone-acts">
      <button class="ph-act" style="background:#06b6d4;color:#000" onclick="openPhoneDetail('${ph.id}')">📋</button>
      <button class="ph-act" style="background:#4ade80;color:#000" onclick="openSellPhone('${ph.id}')" ${isOut?'disabled':''}>${isOut?'نفد':'💰 بيع'}</button>
      <button class="ph-act" style="background:#3b82f6;color:#fff" onclick="openAddStock('${ph.id}')">+ مخزون</button>
      <button class="ph-act" style="background:#334155;color:#94a3b8" onclick="openEditPhone('${ph.id}')">✏️</button>
      <button class="ph-act" style="background:#1c1200;color:#f59e0b" onclick="archivePhone('${ph.id}')">📂</button>
    </div>
  </div>`;
}

function renderPhones() {
  renderInvSummary();
  renderQuickKPI();
  renderBrandFilterBar();
  renderPhonesList();
  renderBadges();
  addBrandsManagerBtn();
}

function renderPhoneDetailFull() {
  const ph = inventory.find(p => p.id === detailPhoneId); if (!ph) return;
  $('detail-title').textContent = ph.brand + ' ' + ph.model;
  const allSales = getPhoneSales(ph.id, 3650);
  const totalSold   = allSales.reduce((t,s)=>t+s.qty, 0);
  const totalRev    = allSales.reduce((t,s)=>t+(s.sellPrice*s.qty||0), 0);
  const totalProfit = allSales.reduce((t,s)=>t+(s.profit||0), 0);
  const mv = getMovement(ph.id), days = getDaysToStockout(ph), lastSale = allSales[0];
  // Weighted average buy price
  const hist = ph.purchaseHistory || [];
  const totalBoughtQty = hist.reduce((t,h)=>t+h.qty, 0);
  const avgBuyPrice = totalBoughtQty ? Math.round(hist.reduce((t,h)=>t+(h.price||0)*h.qty, 0)/totalBoughtQty) : ph.buyPrice;
  // Stagnant warning
  const isStag = mv.score === 0 && ph.qty > 0;
  const lastSaleDate = allSales[0]?.date || '';
  const stagDays = isStag && lastSaleDate ? Math.round((new Date()-new Date(lastSaleDate+'T12:00:00'))/86400000) : 0;
  const prot = (val, cb) => adminUnlocked ? `${fmt(val)} ج` : `<span style="cursor:pointer;color:#475569;letter-spacing:1px" onclick="${cb}">••••</span>`;
  // Build timeline from eventLog + purchases + sales
  const timeline = [...(ph.eventLog||[])].sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));

  $('phone-detail-content').innerHTML = `
  <!-- Stats grid -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:11px">
    <div class="inv-sum-card"><div class="inv-sum-lbl">الكمية الحالية</div><div class="inv-sum-val" style="color:#06b6d4">${ph.qty}</div></div>
    <div class="inv-sum-card"><div class="inv-sum-lbl">إجمالي المباع</div><div class="inv-sum-val" style="color:#4ade80">${totalSold}</div></div>
    <div class="inv-sum-card"><div class="inv-sum-lbl">إجمالي الإيرادات</div><div class="inv-sum-val" style="color:#a78bfa;font-size:12px">${mfmt(totalRev)}</div></div>
    <div class="inv-sum-card"><div class="inv-sum-lbl">إجمالي الأرباح</div><div class="inv-sum-val" style="color:#4ade80;font-size:12px">${mfmt(totalProfit)}</div></div>
    <div class="inv-sum-card" onclick="${!adminUnlocked?'requireAdmin(renderPhoneDetailFull)':''}" style="${!adminUnlocked?'cursor:pointer':''}">
      <div class="inv-sum-lbl">آخر سعر شراء${!adminUnlocked?' 🔒':''}</div>
      <div class="inv-sum-val" style="color:#fbbf24;font-size:12px">${prot(ph.buyPrice,'requireAdmin(renderPhoneDetailFull)')}</div>
    </div>
    <div class="inv-sum-card" onclick="${!adminUnlocked?'requireAdmin(renderPhoneDetailFull)':''}" style="${!adminUnlocked?'cursor:pointer':''}">
      <div class="inv-sum-lbl">متوسط سعر الشراء${!adminUnlocked?' 🔒':''}</div>
      <div class="inv-sum-val" style="color:#f97316;font-size:12px">${prot(avgBuyPrice,'requireAdmin(renderPhoneDetailFull)')}</div>
    </div>
  </div>
  <!-- Info block -->
  <div style="background:#0f172a;border-radius:9px;padding:10px;margin-bottom:10px;font-size:12px;line-height:1.9;color:#94a3b8">
    <b style="color:#e2e8f0">المواصفات:</b> ${ph.ram} رام · ${ph.storage}${ph.color?' · '+ph.color:''}<br>
    <b style="color:#e2e8f0">المورد:</b> ${ph.supplier||'—'} · <b style="color:#e2e8f0">آخر شراء:</b> ${ph.lastBuyDate||'—'}<br>
    <b style="color:#e2e8f0">حركة المخزون:</b> <span class="move-badge ${mv.cls}">${mv.icon} ${mv.label}</span>
    ${isStag && stagDays >= 30 ? `<br><span style="color:#fbbf24">💤 لم يُباع منذ ${stagDays} يومًا</span>` : ''}
    ${days!==null?`<br><b style="color:#f59e0b">⏳ نفاد متوقع خلال ~${days} يوم`:''}
    ${lastSale?`<br><b style="color:#e2e8f0">آخر بيع:</b> ${lastSale.date}`:''}
    ${ph.notes?`<br><b style="color:#e2e8f0">ملاحظات:</b> ${esc(ph.notes)}`:''}
  </div>
  <!-- Favorite button -->
  <button onclick="toggleFavorite('${ph.id}');renderPhoneDetailFull()" style="width:100%;background:${ph.favorite?'#1c1200':'#0f172a'};border:1px solid ${ph.favorite?'#f59e0b':'#1e293b'};border-radius:8px;color:${ph.favorite?'#f59e0b':'#64748b'};padding:7px;font-size:12px;cursor:pointer;font-family:inherit;margin-bottom:10px">${ph.favorite?'⭐ إزالة من المفضلة':'☆ إضافة للمفضلة'}</button>
  <!-- Purchase price history -->
  ${hist.length ? `
  <details style="background:#0f172a;border-radius:9px;overflow:hidden;margin-bottom:10px">
    <summary style="font-size:11px;font-weight:700;color:#06b6d4;padding:9px 9px 0;cursor:pointer;list-style:none">📦 سجل أسعار الشراء (${hist.length})</summary>
    <div style="margin-top:7px">
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:0;font-size:9px;color:#475569;padding:5px 9px;border-bottom:1px solid #1e293b">
      <span>التاريخ</span><span>المورد</span><span>الكمية</span><span>السعر</span>
    </div>
    ${hist.map((h,i) => `<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;font-size:10px;padding:6px 9px;border-bottom:1px solid #0f172a20;background:${i%2?'#0a0f1e':'#0f172a20'};color:#94a3b8">
      <span>${h.date}</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.supplier||'—')}</span>
      <span style="color:#06b6d4">${h.qty}</span>
      <span style="color:${adminUnlocked?'#fbbf24':'#475569'}">${adminUnlocked?fmt(h.price)+' ج':'<span style="cursor:pointer;letter-spacing:1px" onclick="requireAdmin(renderPhoneDetailFull)">••••</span>'}</span>
    </div>`).join('')}
    <div style="font-size:10px;padding:6px 9px;color:#64748b;border-top:1px solid #1e293b">
      إجمالي مشتريات: <b style="color:#06b6d4">${totalBoughtQty} قطعة</b>
      · متوسط السعر: <b style="color:${adminUnlocked?'#f97316':'#475569'}">${prot(avgBuyPrice,'requireAdmin(renderPhoneDetailFull)')}</b>
    </div>
    </div>
  </details>` : ''}
  <!-- Recent Sales -->
  ${allSales.length ? `
  <div style="font-size:11px;font-weight:700;color:#4ade80;margin-bottom:7px">💰 آخر المبيعات</div>
  <div style="background:#0f172a;border-radius:9px;overflow:hidden;margin-bottom:10px">
    ${allSales.slice(0,10).map((s,i)=>`<div style="display:grid;grid-template-columns:1fr 1fr 1fr;font-size:10px;padding:6px 9px;border-bottom:1px solid #0a0f1e;background:${i%2?'#0a0f1e':'transparent'};color:#94a3b8">
      <span>${s.date}</span>
      <span style="color:#e2e8f0">${s.qty} قطعة × ${mfmt(s.sellPrice)}</span>
      <span style="color:#4ade80">${mfmt(s.profit)}</span>
    </div>`).join('')}
  </div>` : ''}
  <!-- Timeline -->
  ${timeline.length ? `
  <details style="margin-bottom:9px">
    <summary style="font-size:11px;font-weight:700;color:#a78bfa;cursor:pointer;list-style:none">🕐 سجل الحركة (${timeline.length})</summary>
    <div style="position:relative;padding-right:18px;margin-top:9px">
    <div style="position:absolute;right:7px;top:0;bottom:0;width:2px;background:#1e293b;border-radius:2px"></div>
    ${timeline.map(ev=>`<div style="position:relative;margin-bottom:10px">
      <div style="position:absolute;right:-14px;top:3px;width:10px;height:10px;background:#1e293b;border:2px solid #475569;border-radius:50%"></div>
      <div style="font-size:10px;font-weight:700;color:#e2e8f0">${ev.icon||'•'} ${ev.label||ev.type}</div>
      <div style="font-size:9px;color:#475569">${ev.date||''}${ev.time?' · '+ev.time:''}</div>
    </div>`).join('')}
    </div>
  </details>` : ''}`;
}

function renderPhoneDetail() { renderPhoneDetailFull(); }

function setPhoneType(type, el) {
  currentPhoneType = type;
  ['touch','keypad'].forEach(t => {
    const b = document.getElementById('ptype-'+t);
    if (!b) return;
    const active = t === type;
    b.style.background = active ? '#06b6d4' : '#111827';
    b.style.color = active ? '#000' : '#64748b';
    b.style.borderColor = active ? '#06b6d4' : '#1e293b';
  });
  const ramRow = document.getElementById('ph-ram-storage-row');
  if (ramRow) ramRow.style.display = type === 'keypad' ? 'none' : '';
  updatePhoneBrandSelect(type);
}

function openBrandsManager() {
  currentBrandTab = 'touch'; currentBrandView = 'active';
  setBrandTab('touch');
  const el = document.getElementById('modal-brands');
  el.style.display = 'flex'; el.style.alignItems = 'flex-end'; el.style.justifyContent = 'center';
}

function setBrandTab(type) {
  currentBrandTab = type;
  ['touch','keypad'].forEach(t => {
    const b = document.getElementById('bm-tab-'+t); if (!b) return;
    b.style.background = t===type ? '#06b6d4' : '#1e293b';
    b.style.color      = t===type ? '#000'     : '#64748b';
  });
  renderBrandManager();
}

function setBrandView(view) {
  currentBrandView = view;
  ['active','archived'].forEach(v => {
    const b = document.getElementById('bm-show-'+v); if (!b) return;
    b.style.borderColor = v===view ? '#3b82f6' : '#1e293b';
    b.style.color       = v===view ? '#60a5fa' : '#475569';
    b.style.background  = v===view ? '#0f172a' : '#0a0f1e';
  });
  renderBrandManager();
}

function renderBrandManager() {
  const el = document.getElementById('bm-list'); if (!el) return;
  const data = getBrandsData(currentBrandTab);
  const list = data.filter(b => currentBrandView==='active' ? !b.archived : b.archived);
  // Model count per brand in inventory
  const modCount = {};
  inventory.filter(p=>!p.archived).forEach(p=>{modCount[p.brand]=(modCount[p.brand]||0)+1;});
  if (!list.length) {
    el.innerHTML = `<div class="empty">${currentBrandView==='active'?'لا توجد شركات نشطة':'لا توجد شركات مؤرشفة'}</div>`;
    return;
  }
  el.innerHTML = list.map(b => {
    const mc = modCount[b.name] || 0;
    const isArchived = b.archived;
    return `<div class="brand-chip-item" style="${isArchived?'opacity:.6':''}">
      <span style="font-size:15px">${isArchived?'📂':'📱'}</span>
      <div id="bm-label-${b.name}" style="flex:1;font-weight:700;color:#e2e8f0;font-size:13px" onclick="startRenameBrand('${b.name}')">${esc(b.name)}</div>
      ${mc>0?`<span style="font-size:10px;color:#4ade80;background:#052e16;border-radius:5px;padding:2px 7px">${mc} موديل</span>`:''}
      <button onclick="startRenameBrand('${b.name}')" style="background:#1e293b;border:1px solid #334155;border-radius:6px;color:#94a3b8;padding:4px 8px;font-size:11px;cursor:pointer;font-family:inherit" title="تعديل الاسم">✏️</button>
      ${isArchived
        ? `<button onclick="restoreBrand('${b.name}')" style="background:#052e16;border:1px solid #4ade80;border-radius:6px;color:#4ade80;padding:4px 8px;font-size:11px;cursor:pointer;font-family:inherit">استعادة</button>`
        : `<button onclick="archiveBrand('${b.name}')" style="background:#1c1200;border:1px solid #92400e;border-radius:6px;color:#f59e0b;padding:4px 8px;font-size:11px;cursor:pointer;font-family:inherit">أرشفة</button>`
      }
      ${mc===0 ? `<button onclick="permDeleteBrand('${b.name}')" style="background:none;border:none;color:#374151;cursor:pointer;font-size:18px;padding:0 2px" title="حذف نهائي">×</button>` : ''}
    </div>
    <div id="bm-rename-${b.name}" style="display:none;margin-bottom:6px;display:none">
      <div style="display:flex;gap:5px;background:#0a0f1e;border:1px solid #3b82f6;border-radius:8px;padding:6px 8px">
        <input id="bm-rename-inp-${b.name}" value="${esc(b.name)}" style="flex:1;background:transparent;border:none;color:#e2e8f0;font-size:13px;font-family:inherit;direction:rtl" onkeydown="if(event.key==='Enter')confirmRenameBrand('${b.name}');if(event.key==='Escape')cancelRenameBrand('${b.name}')">
        <button onclick="confirmRenameBrand('${b.name}')" style="background:#4ade80;border:none;border-radius:5px;color:#000;padding:4px 10px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">✓</button>
        <button onclick="cancelRenameBrand('${b.name}')" style="background:#334155;border:none;border-radius:5px;color:#94a3b8;padding:4px 8px;font-family:inherit;font-size:12px;cursor:pointer">✕</button>
      </div>
    </div>`;
  }).join('');
}

function startRenameBrand(name) {
  const renRow = document.getElementById('bm-rename-'+name);
  const inp = document.getElementById('bm-rename-inp-'+name);
  if (!renRow) return;
  renRow.style.display = 'block';
  if (inp) { inp.value = name; setTimeout(() => inp.focus(), 60); }
}

function cancelRenameBrand(name) {
  const renRow = document.getElementById('bm-rename-'+name);
  if (renRow) renRow.style.display = 'none';
}

function confirmRenameBrand(oldName) {
  const inp = document.getElementById('bm-rename-inp-'+oldName);
  const newName = inp?.value.trim();
  if (!newName || newName === oldName) { cancelRenameBrand(oldName); return; }
  const data = getBrandsData(currentBrandTab);
  if (data.find(b=>b.name===newName)) { showToast('الاسم موجود مسبقًا','err'); return; }
  // Update brand name in inventory via PhoneRepository
  inventory.filter(ph => ph.brand === oldName).forEach(ph => {
    phoneRepo.update(ph.id, { brand: newName });
  });
  // Update brands list
  data.forEach(b => { if (b.name === oldName) b.name = newName; });
  saveBrandsData(currentBrandTab, data);
  renderBrandManager(); updatePhoneBrandSelect(currentPhoneType);
  renderBrandFilterBar(); renderPhonesList();
  showToast(`✅ تم تغيير الاسم إلى "${newName}"`, 'ok');
}

function archiveBrand(name) {
  const mc = inventory.filter(p=>!p.archived&&p.brand===name).length;
  if (mc > 0 && !confirm(`"${name}" لديها ${mc} موديل في المخزون.\nالأرشفة ستخفيها من القائمة فقط — البيانات محفوظة.\nهل تريد الأرشفة؟`)) return;
  const data = getBrandsData(currentBrandTab);
  data.forEach(b=>{ if(b.name===name) b.archived=true; });
  saveBrandsData(currentBrandTab, data);
  renderBrandManager(); updatePhoneBrandSelect(currentPhoneType);
  showToast(`📂 تم أرشفة "${name}"`, 'info');
}

function restoreBrand(name) {
  const data = getBrandsData(currentBrandTab);
  data.forEach(b=>{ if(b.name===name) b.archived=false; });
  saveBrandsData(currentBrandTab, data);
  renderBrandManager(); updatePhoneBrandSelect(currentPhoneType);
  showToast(`✅ تمت استعادة "${name}"`, 'ok');
}

function permDeleteBrand(name) {
  const mc = inventory.filter(p=>p.brand===name).length;
  if (mc > 0) { showToast('لا يمكن حذف شركة لها موديلات في المخزون','err'); return; }
  if (!confirm(`حذف نهائي لـ "${name}"؟`)) return;
  const data = getBrandsData(currentBrandTab).filter(b=>b.name!==name);
  saveBrandsData(currentBrandTab, data);
  renderBrandManager(); updatePhoneBrandSelect(currentPhoneType);
  showToast('تم الحذف','ok');
}

function addBrand() {
  const inp = document.getElementById('bm-new-input'); if (!inp) return;
  const name = inp.value.trim(); if (!name) { showToast('أدخل اسم الشركة','err'); return; }
  const data = getBrandsData(currentBrandTab);
  if (data.find(b=>b.name===name)) { showToast('الشركة موجودة مسبقًا','err'); return; }
  data.unshift({name, archived:false});
  saveBrandsData(currentBrandTab, data);
  inp.value = ''; renderBrandManager();
  updatePhoneBrandSelect(currentPhoneType);
  showToast('✅ تمت إضافة الشركة','ok');
}

function updatePhoneBrandSelect(type) {
  const sel = document.getElementById('ph-brand'); if (!sel) return;
  const list = getBrands(type || currentPhoneType);
  const cur = sel.value;
  sel.innerHTML = list.map(b=>`<option value="${esc(b)}">${esc(b)}</option>`).join('') + `<option value="أخري">أخري</option>`;
  if ([...sel.options].find(o=>o.value===cur)) sel.value = cur;
}

function populatePhoneSuggestions() {
  // Model names from existing inventory
  const models = [...new Set(inventory.map(p => p.model))].sort();
  const dlM = document.getElementById('dl-ph-models');
  if (dlM) dlM.innerHTML = models.map(m => `<option value="${esc(m)}">`).join('');
  // Supplier names
  const sups = [...new Set(inventory.map(p => p.supplier).filter(Boolean))].sort();
  const dlS = document.getElementById('dl-ph-suppliers');
  if (dlS) dlS.innerHTML = sups.map(s => `<option value="${esc(s)}">`).join('');
  // Also for stock-supplier
  const dlSS = document.getElementById('dl-stock-suppliers');
  if (dlSS) dlSS.innerHTML = sups.map(s => `<option value="${esc(s)}">`).join('');
}

function openAddPhone() {
  editingPhoneId = null;
  const t = $('add-phone-title'); if (t) t.textContent = '📦 إضافة موديل جديد';
  setPhoneType('touch', document.getElementById('ptype-touch'));
  updatePhoneBrandSelect('touch');
  ['ph-model','ph-color','ph-code','ph-supplier','ph-notes'].forEach(id => { const el=$(id); if(el) el.value=''; });
  const ram = $('ph-ram'); if(ram) ram.value = '6GB';
  const storage = $('ph-storage'); if(storage) storage.value = '128GB';
  const qty = $('ph-qty'); if(qty) qty.value = '';
  const buy = $('ph-buy'); if(buy) buy.value = '';
  $('ph-err').textContent = '';
  populatePhoneSuggestions();
  $('modal-add-phone').style.display = 'flex';
  setTimeout(() => $('ph-model').focus(), 100);
}

function savePhoneNew() {
  const model = g('ph-model'); if (!model) { $('ph-err').textContent = 'أدخل اسم الموديل'; return; }
  const qty = parseInt(g('ph-qty')) || 0;
  const buy = n(g('ph-buy'));
  const isKeypad = currentPhoneType === 'keypad';
  if (editingPhoneId) {
    const ph = inventory.find(p => p.id === editingPhoneId); if (!ph) return;
    const changes = {
      brand: g('ph-brand'), model,
      ram: isKeypad ? '' : ($('ph-ram')?.value || ''),
      storage: isKeypad ? '' : ($('ph-storage')?.value || ''),
      color: isKeypad ? '' : g('ph-color'),
      internalCode: g('ph-code'),
      supplier: g('ph-supplier'), notes: g('ph-notes'),
      deviceType: currentPhoneType
    };
    if (qty > 0) changes.qty = qty;
    if (buy) changes.buyPrice = buy;
    logPhoneEvent(ph.id, {type:'edit',icon:'✏️',label:'تعديل بيانات الموديل',date:td(),time:ts()});
    phoneRepo.update(ph.id, changes);
  } else {
    const ph = {
      id: 'ph_'+Date.now(), brand: g('ph-brand'), model, deviceType: currentPhoneType,
      ram: isKeypad ? '' : ($('ph-ram')?.value || ''),
      storage: isKeypad ? '' : ($('ph-storage')?.value || ''),
      color: isKeypad ? '' : g('ph-color'),
      internalCode: g('ph-code'), qty, buyPrice: buy,
      supplier: g('ph-supplier'), notes: g('ph-notes'),
      addedDate: td(), lastBuyDate: td(),
      purchaseHistory: [{price:buy, supplier:g('ph-supplier'), date:td(), qty}],
      eventLog: [{type:'add',icon:'📦',label:`أُضيف للمخزون — ${qty} قطعة`,date:td(),time:ts()}]
    };
    phoneRepo.create(ph);
    checkCondNotes('phones', {name:ph.brand+' '+ph.model, price:buy, qty});
  }
  closeAddPhone(); renderPhones(); populatePhoneSuggestions();
  showToast('✅ تم الحفظ','ok');
}

function savePhone() { savePhoneNew(); }

function renderPhonesShortageFixed() {
  const el = document.getElementById('ph-short-content'); if (!el) return;
  const out = inventory.filter(p => !p.archived && p.qty === 0);
  if (!out.length) { el.innerHTML = `<div class="empty">✅ لا توجد موديلات نافدة</div>`; return; }
  el.innerHTML = `<div style="font-size:10px;color:#64748b;margin-bottom:8px;padding:7px;background:#0f172a;border-radius:7px;border:1px solid #1e293b">
    ❌ ${out.length} موديل نفد من المخزون — منخفض الكمية يظهر في الإشعارات والتحليلات
  </div>` + out.map(ph => `<div class="shortage-item out">
    <span style="font-size:22px">❌</span>
    <div style="flex:1">
      <div style="font-size:13px;font-weight:700;color:#e2e8f0">${ph.brand} ${ph.model}</div>
      <div style="font-size:10px;color:#64748b">${[ph.ram,ph.storage].filter(Boolean).join('/')+'  '} مورد: ${esc(ph.supplier||'—')} · ${ph.lastBuyDate||'—'}</div>
    </div>
    <div style="display:flex;gap:5px">
      <button class="ph-act" style="background:#3b82f6;color:#fff" onclick="openAddStock('${ph.id}')">+ مخزون</button>
      <button class="ph-act" style="background:#0f172a;color:#64748b" onclick="openPhoneDetail('${ph.id}')">📋</button>
    </div>
  </div>`).join('');
}

function renderPhonesShortage() { renderPhonesShortageFixed(); }

function addBrandsManagerBtn() {
  const el = document.getElementById('ph-meta'); if (!el || el.querySelector('.bm-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'bm-btn';
  btn.style.cssText = 'background:#1e293b;border:1px solid #334155;border-radius:7px;color:#94a3b8;padding:4px 9px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit';
  btn.textContent = '🏢 الشركات';
  btn.onclick = openBrandsManager;
  el.appendChild(btn);
}
