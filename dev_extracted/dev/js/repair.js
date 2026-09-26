// ═══════════════════════════════════════════════════════════
// repair.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function getNextRepairNo(){repairCounter++;return'REP-'+String(repairCounter).padStart(4,'0');}

function openAddRepair(editId=null){
  editingRepairId=editId;
  const modal=$('modal-add-repair');if(!modal)return;
  // rep-fault is now an input+datalist — just populate suggestions
  populateRepairSuggestions();
  if(editId){
    const rep=data.repairs.find(r=>r.id===editId);if(!rep){showToast('العملية غير موجودة','err');return;}
    const set=(id,v)=>{const el=$(id);if(el)el.value=v||'';};
    set('rep-client-name',rep.clientName);set('rep-client-phone',rep.clientPhone);
    set('rep-brand',rep.brand);set('rep-model',rep.model);
    set('rep-fault',rep.faultType);set('rep-part-name',rep.partName);
    set('rep-part-buy',rep.partBuyPrice);set('rep-service-price',rep.servicePrice);
    set('rep-supplier',rep.supplier);set('rep-notes',rep.notes);
    const dt=$('rep-device-type');if(dt)dt.value=rep.deviceType||'موبايل';
    const rs=$('rep-status');if(rs)rs.value=rep.status||'inProgress';
  }else{
    ['rep-client-name','rep-client-phone','rep-brand','rep-model','rep-fault',
     'rep-part-name','rep-part-buy','rep-service-price','rep-supplier','rep-notes']
      .forEach(id=>{const el=$(id);if(el)el.value='';});
    const dt=$('rep-device-type');if(dt)dt.value='موبايل';
    const rs=$('rep-status');if(rs)rs.value='inProgress';
  }
  updateRepairProfit();$('rep-err').textContent='';modal.style.display='flex';setTimeout(()=>$('rep-brand').focus(),100);
}

function closeAddRepair(){const m=$('modal-add-repair');if(m)m.style.display='none';editingRepairId=null;}

function updateRepairProfit(){
  const buy=n(g('rep-part-buy')),service=n(g('rep-service-price'));
  const el=$('rep-profit-preview');if(!el)return;
  if(service){const profit=service-buy;el.innerHTML=`ربح متوقع: <b style="color:${profit>=0?'#4ade80':'#f87171'}">${fmt(profit)} ج</b>`;}
  else el.textContent='';
}

function saveRepair(){
  const brand=g('rep-brand'),model=g('rep-model'),service=n(g('rep-service-price'));
  if(!brand){$('rep-err').textContent='أدخل الشركة';return;}
  if(!model){$('rep-err').textContent='أدخل الموديل';return;}
  const buy=n(g('rep-part-buy')),profit=service-buy;
  const status=$('rep-status')?.value||'inProgress';
  if(editingRepairId){
    const rep=data.repairs.find(r=>r.id===editingRepairId);if(!rep)return;
    const changes={clientName:g('rep-client-name'),clientPhone:g('rep-client-phone'),brand,model,deviceType:$('rep-device-type')?.value||'موبايل',faultType:g('rep-fault'),partName:g('rep-part-name'),partBuyPrice:buy,servicePrice:service,profit,supplier:g('rep-supplier'),notes:g('rep-notes'),status};
    const newHistory=[...(rep.statusHistory||[]),{status,date:td(),time:ts()}];
    if(rep.id){
      repairTransactionRepo.update(rep.id,{...changes,statusHistory:newHistory},{date:sel});
    }else{
      Object.assign(rep,changes);rep.statusHistory=newHistory;save();
    }
  }else{
    const rep={id:'rep_'+Date.now(),no:getNextRepairNo(),clientName:g('rep-client-name'),clientPhone:g('rep-client-phone'),brand,model,deviceType:$('rep-device-type')?.value||'موبايل',faultType:g('rep-fault'),partName:g('rep-part-name'),partBuyPrice:buy,servicePrice:service,profit,supplier:g('rep-supplier'),notes:g('rep-notes'),status:'inProgress',fixed:false,delivered:false,paid:false,time:ts(),statusHistory:[{status:'inProgress',date:td(),time:ts()}]};
    repairTransactionRepo.create(rep);
    checkCondNotes('repairs',{name:brand+' '+model,servicePrice:service});
    if(g('rep-part-name')){const part=repairParts.find(p=>p.name===g('rep-part-name'));if(part&&part.qty>0){repairPartRepo.update(part.id,{qty:part.qty-1});}}
  }
  updateRepairSuggestions();
  closeAddRepair();renderRepairPanel();ref('repairs');checkRepairNotifications();
}

function updateRepairSuggestions(){
  const log=getRepairLog();
  const fields={brand:g('rep-brand'),model:g('rep-model'),fault:g('rep-fault'),part:g('rep-part-name'),supplier:g('rep-supplier'),client:g('rep-client-name')};
  Object.entries(fields).forEach(([k,v])=>{if(!v)return;if(!log[k])log[k]={};log[k][v]=(log[k][v]||0)+1;});
  saveRepairLog(log);
}

function populateRepairSuggestions(){
  const log=getRepairLog();
  // Also gather from existing repairs
  const allReps=data.repairs||[];
  const fromReps=(field)=>{const m={};allReps.forEach(r=>{const v=r[field];if(v)m[v]=(m[v]||0)+1;});return m;};
  const merge=(logKey,fromField)=>{const a=log[logKey]||{};const b=fromReps(fromField);const merged={...b,...a};return Object.entries(merged).sort((x,y)=>y[1]-x[1]).map(([v])=>v);};
  const brands=merge('brand','brand');
  const models=merge('model','model');
  const faults=[...(log.fault?Object.entries(log.fault).sort((a,b)=>b[1]-a[1]).map(([v])=>v):[]),...(faultTypes||[]).map(f=>f.name)].filter((v,i,a)=>a.indexOf(v)===i);
  const parts=merge('part','partName');
  const sups=merge('supplier','supplier');
  const clients=merge('client','clientName');
  setDl('dl-rep-brand',brands);setDl('dl-rep-model',models);setDl('dl-rep-fault',faults);setDl('dl-rep-part',parts);setDl('dl-rep-sup',sups);setDl('dl-rep-client',clients);
}

function setDl(id,items){const el=document.getElementById(id);if(el)el.innerHTML=items.slice(0,20).map(v=>`<option value="${esc(v)}">`).join('');}

function clearRepairSuggestions(){Storage.remove('mshop_rep_log');showToast('تم مسح سجل الاقتراحات','ok');}

function deleteRepair(idx){if(!confirm('حذف عملية الصيانة؟'))return;const item={...data.repairs[idx],_origDate:sel,_origType:'repairs',_deletedAt:td()+' '+ts()};trash.unshift({id:Date.now(),item});saveTrash();const rep=data.repairs[idx];if(rep.id){repairTransactionRepo.delete(rep.id,{date:sel});}else{data.repairs.splice(idx,1);save();}renderRepairPanel();ref('repairs');}

function updateRepairStatus(idx,status){
  const rep=data.repairs[idx];if(!rep)return;
  const newHistory=[...(rep.statusHistory||[]),{status,date:td(),time:ts()}];
  if(rep.id){
    repairTransactionRepo.update(rep.id,{status,statusHistory:newHistory},{date:sel});
  }else{
    rep.status=status;rep.statusHistory=newHistory;save();
  }
  renderRepairPanel();ref('repairs');
}

function getAllRepairs(){
  const all=[];
  Storage.search('mshop_d_').forEach(k=>{const date=k.replace('mshop_d_','');const d=Storage.get(k);if(!d)return;(d.repairs||[]).forEach(r=>all.push({...r,_date:date}));});
  return all.sort((a,b)=>(b._date||'').localeCompare(a._date||''));
}

function renderRepairList(){
  const all=getAllRepairs(),el=$('all-repairs-list');if(!el)return;
  const q=($('rep-search')?.value||'').toLowerCase(),sf=$('rep-status-filter')?.value||'all';
  let filtered=all;
  if(q)filtered=filtered.filter(r=>(r.brand+' '+r.model).toLowerCase().includes(q)||(r.clientName||'').toLowerCase().includes(q)||(r.faultType||'').toLowerCase().includes(q));
  if(sf!=='all')filtered=filtered.filter(r=>r.status===sf);
  const rc=$('repair-list-cnt');if(rc)rc.textContent=filtered.length+' عملية';
  const totRev=filtered.filter(r=>r.status!=='cancelled').reduce((s,r)=>s+(r.servicePrice||0),0);
  const totProfit=filtered.filter(r=>r.status!=='cancelled').reduce((s,r)=>s+(r.profit||0),0);
  const rm=$('repair-list-meta');if(rm)rm.innerHTML=`إيرادات: <b style="color:#f97316">${fmt(totRev)} ج</b> ربح: <b>${adminUnlocked?fmt(totProfit)+' ج':'***'}</b>`;
  if(!filtered.length){el.innerHTML=`<div class="empty">لا توجد عمليات صيانة</div>`;return;}
  el.innerHTML=filtered.map(r=>{
    const st=REPAIR_STATUS[r.status]||REPAIR_STATUS.inProgress;
    return`<div class="repair-card"><div class="repair-hdr"><div class="repair-title">${esc(r.brand)} ${esc(r.model)}</div><span class="ibadge" style="background:${st.color}20;color:${st.color}">${st.icon} ${st.lbl}</span><span class="itime">${r._date}</span></div>${r.clientName?`<div style="font-size:11px;color:#64748b;margin-bottom:4px">👤 ${esc(r.clientName)}${r.clientPhone?' · 📞 '+esc(r.clientPhone):''}</div>`:''}<div style="font-size:11px;color:#64748b">🔧 ${esc(r.faultType||'—')} · خدمة: <b style="color:#f97316">${fmt(r.servicePrice||0)} ج</b> · ربح: <b style="color:${showProfits?'#4ade80':'#334155'}">${mfmt(r.profit||0)}</b></div>${r.notes?`<div style="font-size:10px;color:#475569;margin-top:3px">📌 ${esc(r.notes)}</div>`:''}</div>`;
  }).join('');
}

function setRepairFilter(f, el) {
  repairPanelFilter = f;
  document.querySelectorAll('[id^="rft-"]').forEach(b => {
    b.classList.remove('on'); b.style.background = '#111827'; b.style.borderColor = '#1e293b'; b.style.color = '#64748b';
  });
  if (el) { el.classList.add('on'); el.style.background = '#f97316'; el.style.borderColor = '#f97316'; el.style.color = '#fff'; }
  renderRepairPanel();
}

function getRepairStatus(r) {
  if (r.fixed && r.delivered && r.paid) return {lbl:'مكتملة',color:'#4ade80',icon:'🏁'};
  if (r.delivered) return {lbl:'تم التسليم',color:'#3b82f6',icon:'📦'};
  if (r.fixed)     return {lbl:'تم الإصلاح',color:'#06b6d4',icon:'✅'};
  return {lbl:'تحت الصيانة',color:'#f59e0b',icon:'🔧'};
}

function toggleRepairField(idx, field) {
  const rep = data.repairs[idx]; if (!rep) return;
  if(rep.id){
    repairTransactionRepo.update(rep.id,{[field]:!rep[field]},{date:sel});
  }else{
    data.repairs[idx][field]=!data.repairs[idx][field];save();
  }
  renderRepairPanel(); ref('repairs');
}

function renderRepairPanel() {
  const items = data.repairs || [], cnt = items.length;
  const cntEl = document.getElementById('repairs-cnt'); if (cntEl) cntEl.textContent = cnt;
  let filtered = items;
  if (repairPanelFilter === 'prog')  filtered = items.filter(r => !r.fixed && !r.delivered);
  if (repairPanelFilter === 'fixed') filtered = items.filter(r => r.fixed && !r.delivered);
  if (repairPanelFilter === 'undel') filtered = items.filter(r => r.fixed && !r.delivered);
  if (repairPanelFilter === 'unpay') filtered = items.filter(r => !r.paid);
  if (repairPanelFilter === 'done')  filtered = items.filter(r => r.fixed && r.delivered && r.paid);
  const total = filtered.filter(r=>!(!r.fixed&&!r.delivered&&!r.paid&&r.servicePrice===0)).reduce((s,r)=>s+(r.servicePrice||0),0);
  const totalP = filtered.reduce((s,r)=>s+(r.profit||0),0);
  const metaEl = document.getElementById('repairs-meta');
  if (metaEl) metaEl.innerHTML = `إيرادات: <b style="color:#f97316">${fmt(total)} ج</b> ربح: <b>${mfmt(totalP)}</b>`;
  const el = document.getElementById('repairs-list-panel'); if (!el) return;
  if (!filtered.length) { el.innerHTML = `<div class="empty">🔧 لا توجد عمليات في هذه الفئة</div>`; return; }
  el.innerHTML = filtered.map((r, x) => {
    const actualIdx = items.indexOf(r);
    const st = getRepairStatus(r);
    return `<div class="repair-card">
      <div class="repair-hdr"><div class="repair-title">${esc(r.brand)} ${esc(r.model)}</div>
        <span class="ibadge" style="background:${st.color}20;color:${st.color}">${st.icon} ${st.lbl}</span>
        <span class="itime">${r.time||''}</span></div>
      ${r.clientName?`<div style="font-size:11px;color:#64748b;margin-bottom:4px">👤 ${esc(r.clientName)}${r.clientPhone?' · 📞 '+esc(r.clientPhone):''}</div>`:''}
      <div style="font-size:11px;color:#64748b;margin-bottom:6px">🔧 ${esc(r.faultType||'—')} ${r.partName?'· قطعة: '+esc(r.partName):''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:7px">
        <span class="ph-stat">الخدمة: <b style="color:#f97316">${fmt(r.servicePrice||0)} ج</b></span>
        <span class="ph-stat">ربح: ${mp(r.profit||0)}</span>
        ${r.supplier?`<span class="ph-stat">مورد: <b>${esc(r.supplier)}</b></span>`:''}
      </div>
      ${r.notes?`<div style="font-size:10px;color:#64748b;margin-bottom:7px">📌 ${esc(r.notes)}</div>`:''}
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:7px">
        <label style="display:flex;align-items:center;gap:5px;font-size:11px;cursor:pointer;color:${r.fixed?'#4ade80':'#64748b'}">
          <input type="checkbox" ${r.fixed?'checked':''} onchange="toggleRepairField(${actualIdx},'fixed')"> ☑ تم الإصلاح</label>
        <label style="display:flex;align-items:center;gap:5px;font-size:11px;cursor:pointer;color:${r.delivered?'#06b6d4':'#64748b'}">
          <input type="checkbox" ${r.delivered?'checked':''} onchange="toggleRepairField(${actualIdx},'delivered')"> 📦 تم التسليم</label>
        <label style="display:flex;align-items:center;gap:5px;font-size:11px;cursor:pointer;color:${r.paid?'#fbbf24':'#64748b'}">
          <input type="checkbox" ${r.paid?'checked':''} onchange="toggleRepairField(${actualIdx},'paid')"> 💰 تم الدفع</label>
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="ph-act" style="background:#334155;color:#94a3b8" onclick="openAddRepair('${r.id}')">✏️ تعديل</button>
        <button class="ph-act" style="background:#450a0a;color:#f87171" onclick="deleteRepair(${actualIdx})">🗑</button>
      </div>
    </div>`;
  }).join('');
}
