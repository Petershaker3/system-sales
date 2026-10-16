// ═══════════════════════════════════════════════════════════
// reports.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function getMonthLbl(ym){const[y,m]=ym.split('-');return new Date(y,parseInt(m)-1,1).toLocaleDateString('ar-EG',{month:'long',year:'numeric'});}

function prevMonth(){const[y,m]=selMonth.split('-');selMonth=new Date(y,parseInt(m)-2,1).toISOString().slice(0,7);renderMonthly();}

function nextMonth(){const[y,m]=selMonth.split('-');selMonth=new Date(y,parseInt(m),1).toISOString().slice(0,7);renderMonthly();}

function getMonthData(ym=selMonth){
  const agg={acc:[],used:[],cash:[],sw:[],exp:[],phones:[],repairs:[]};
  Storage.search('mshop_d_'+ym).forEach(k=>{
    const d=Storage.get(k);if(!d)return;const date=k.replace('mshop_d_','');
    Object.keys(agg).forEach(cat=>{if(d[cat])d[cat].forEach((it,dayIdx)=>agg[cat].push({...it,_date:date,_dayIdx:dayIdx}));});
  });
  return agg;
}

function monthTotals(md){
  const t=computeFinancialTotals(md);
  const ops=md.acc.length+md.used.length+md.cash.length+md.sw.length+(md.phones||[]).length+(md.repairs||[]).length;
  return{...t,ops};
}

function renderProfitSource(c){
  const el=$('profit-source-chart');if(!el)return;
  const total=c.profit+c.eT; // إجمالي الربح قبل خصم المصاريف (لتوزيع النسب فقط) — مُشتق من نفس نتيجة المحرك الموحّد، وليس صيغة منفصلة
  if(total<=0){el.innerHTML=`<div class="empty">لا توجد أرباح هذا الشهر</div>`;return;}
  const secs=[['📦 هواتف جديدة',c.phP,'#06b6d4'],['📱 مستعمل',c.uP,'#8b5cf6'],['🎧 اكسسوار',c.aP,'#3b82f6'],['💳 الكاش',c.cT,'#ef4444'],['⚙️ سوفت وير',c.sT,'#10b981'],['🔧 صيانة',c.repP,'#f97316']].filter(s=>s[1]>0).sort((a,b)=>b[1]-a[1]);
  el.innerHTML=secs.map(([lbl,val,col])=>{const pct=Math.round(val/total*100);return`<div class="pbar-row"><div class="pbar-lbl">${lbl}</div><div class="pbar-bg"><div class="pbar-fill" style="width:${pct}%;background:${col}"></div></div><div class="pbar-val">${mfmt(val)} (${pct}%)</div></div>`;}).join('');
}

function renderMonthly(){
  _lastRender = renderMonthly;
  extendAdminSession();
  $('month-lbl').textContent=getMonthLbl(selMonth);
  const md=getMonthData(),c=monthTotals(md);
  const mt=$('month-totals');if(!mt)return;
  mt.innerHTML=`
    <div class="scard"><div class="scard-lbl">إجمالي</div><div class="scard-val" style="color:#60a5fa">${mtot(c.total,'#60a5fa')}</div></div>
    <div class="scard"><div class="scard-lbl">صافي الربح</div><div class="scard-val" style="color:${c.profit>=0?'#4ade80':'#f87171'}">${mfmt(c.profit)}</div></div>
    <div class="scard"><div class="scard-lbl">🎧 اكسسوار</div><div class="scard-val" style="color:#3b82f6">${mtot(c.aS,'#3b82f6')}</div><div class="scard-sub" style="color:${showProfits?'#4ade80':'#334155'}">ربح: ${mfmt(c.aP)}</div></div>
    <div class="scard"><div class="scard-lbl">📱 مستعمل</div><div class="scard-val" style="color:#a78bfa">${mtot(c.uS,'#a78bfa')}</div><div class="scard-sub" style="color:${showProfits?'#4ade80':'#334155'}">ربح: ${mfmt(c.uP)}</div></div>
    <div class="scard"><div class="scard-lbl">💳 الكاش</div><div class="scard-val" style="color:#f87171">${mtot(c.cT,'#f87171')}</div></div>
    <div class="scard"><div class="scard-lbl">⚙️ سوفت وير</div><div class="scard-val" style="color:#34d399">${mtot(c.sT,'#34d399')}</div></div>
    <div class="scard"><div class="scard-lbl">💸 مصاريف</div><div class="scard-val" style="color:#fbbf24">${mtot(c.eT,'#fbbf24')}</div></div>
    <div class="scard"><div class="scard-lbl">📦 هواتف جديدة</div><div class="scard-val" style="color:#06b6d4">${mtot(c.phS,'#06b6d4')}</div><div class="scard-sub" style="color:${showProfits?'#4ade80':'#334155'}">ربح: ${mfmt(c.phP)}</div></div>
    <div class="scard"><div class="scard-lbl">🔧 صيانة</div><div class="scard-val" style="color:#f97316">${mtot(c.repS,'#f97316')}</div><div class="scard-sub" style="color:${showProfits?'#4ade80':'#334155'}">ربح: ${mfmt(c.repP)}</div></div>
    <div class="scard"><div class="scard-lbl">العمليات</div><div class="scard-val" style="color:#94a3b8">${c.ops}</div></div>`;
  renderProfitSource(c);
  // ── Build collapsible detail sections ──────────────────────
  const openSecs = JSON.parse(sessionStorage.getItem('mshop_mon_open')||'{}');
  function mSec(id, icon, color, title, count, html) {
    const isOpen = openSecs[id] || false;
    return `<div class="m-sec" style="padding:0;overflow:hidden">
      <div class="m-sec-hdr" style="color:${color};cursor:pointer;padding:11px 13px;margin:0;display:flex;align-items:center;justify-content:space-between;background:#0a0f1e;user-select:none"
           onclick="toggleMonSec('${id}',this)">
        <span>${icon} ${title}</span>
        <div style="display:flex;align-items:center;gap:7px">
          <span style="font-size:10px;color:#475569">${count}</span>
          <span style="font-size:12px;transition:transform .2s;display:inline-block;transform:rotate(${isOpen?'0':'-90deg'}deg)">▼</span>
        </div>
      </div>
      <div class="mon-sec-body" style="display:${isOpen?'block':'none'};padding:0 13px 11px">${html}</div>
    </div>`;
  }
  let det='';

  if(md.acc.length){
    const byN={};md.acc.forEach(i=>{if(!byN[i.name])byN[i.name]={qty:0,sell:0,profit:0,cat:i.mainCat||''};byN[i.name].qty++;byN[i.name].sell+=i.sell;byN[i.name].profit+=i.profit;});
    const sorted=Object.entries(byN).sort((a,b)=>b[1].qty-a[1].qty);
    const top10=sorted.slice(0,10);
    const html=`${top10.length?`<div style="margin-bottom:9px"><div style="font-size:10px;color:#475569;margin-bottom:5px">🏆 الأكثر مبيعًا</div>${top10.map(([nm,v],i)=>`<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #0f172a"><span style="font-size:11px;color:#475569;min-width:16px">${i+1}</span><span style="flex:1;font-size:11px;color:#e2e8f0">${esc(nm)}</span><span style="font-size:10px;color:#64748b">${esc(v.cat)}</span><span style="font-size:11px;color:#06b6d4;min-width:30px;text-align:center">${v.qty}</span><span style="font-size:11px;color:#4ade80;min-width:60px;text-align:left">${mfmt(v.profit)}</span></div>`).join('')}</div>`:''}
    <table class="m-tbl"><thead><tr><th>القطعة</th><th>الفئة</th><th>كمية</th><th>البيع</th><th>الربح</th><th></th></tr></thead><tbody>${sorted.map(([nm,v])=>`<tr><td>${esc(nm)}</td><td style="color:#64748b">${esc(v.cat)}</td><td>${v.qty}</td><td>${fmt(v.sell)} ج</td><td style="color:${showProfits?'#4ade80':'#334155'}">${mfmt(v.profit)}</td><td></td></tr>`).join('')}</tbody></table>
    <div style="margin-top:8px">${md.acc.map((i,x)=>i._rolled?`<div style="font-size:10px;color:#f87171;opacity:.5;padding:2px 5px;text-decoration:line-through">${esc(i.name)} — ${i._date}</div>`:``).join('')}</div>`;
    det+=mSec('acc','🎧','#3b82f6','إكسسوار',`${md.acc.length} عملية`,html);
  }

  if(md.used.length){
    const html=`<table class="m-tbl"><thead><tr><th>الموبايل</th><th>بيع</th><th>ربح</th><th>التاريخ</th><th></th></tr></thead><tbody>${md.used.map((i,x)=>`<tr style="${i._rolled?'opacity:.4;text-decoration:line-through':''}"><td>${esc(i.name)}</td><td>${fmt(i.sell)} ج</td><td style="color:${showProfits&&!i._rolled?'#4ade80':'#334155'}">${mfmt(i.profit)}</td><td style="color:#334155;font-size:10px">${i._date}</td><td>${i._rolled?`<span style="font-size:10px;color:#f87171">↩ متراجع</span>`:`<button onclick="rollbackFromMonthly('used',${x},'${i._date}')" style="background:#1c1200;border:1px solid #92400e;border-radius:5px;color:#f59e0b;padding:2px 7px;font-size:10px;cursor:pointer;font-family:inherit">↩</button>`}</td></tr>`).join('')}</tbody></table>`;
    det+=mSec('used','📱','#8b5cf6','مستعمل',`${md.used.filter(i=>!i._rolled).length} عملية`,html);
  }

  if(md.phones?.length){
    const touchSales=md.phones.filter(i=>{const ph=inventory.find(p=>p.id===i.modelId);return !ph||ph.deviceType!=='keypad';});
    const keypadSales=md.phones.filter(i=>{const ph=inventory.find(p=>p.id===i.modelId);return ph?.deviceType==='keypad';});
    const tQ=touchSales.reduce((s,i)=>s+(i.qty||1),0),kQ=keypadSales.reduce((s,i)=>s+(i.qty||1),0);
    const tP=touchSales.reduce((s,i)=>s+(i.profit||0),0),kP=keypadSales.reduce((s,i)=>s+(i.profit||0),0);
    const html=`<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:10px">
      ${tQ>0?`<div class="inv-sum-card"><div class="inv-sum-lbl">📱 تاتش</div><div class="inv-sum-val" style="color:#06b6d4">${tQ} جهاز</div><div style="font-size:10px;color:${showProfits?'#4ade80':'#334155'}">${mfmt(tP)}</div></div>`:''}
      ${kQ>0?`<div class="inv-sum-card"><div class="inv-sum-lbl">⌨️ زراير</div><div class="inv-sum-val" style="color:#a78bfa">${kQ} جهاز</div><div style="font-size:10px;color:${showProfits?'#4ade80':'#334155'}">${mfmt(kP)}</div></div>`:''}
      <div class="inv-sum-card"><div class="inv-sum-lbl">الإجمالي</div><div class="inv-sum-val" style="color:#06b6d4">${tQ+kQ} جهاز</div><div style="font-size:10px;color:${showProfits?'#4ade80':'#334155'}">${mfmt(tP+kP)}</div></div>
    </div>
    <table class="m-tbl"><thead><tr><th>الموديل</th><th>النوع</th><th>كمية</th><th>البيع</th><th>الربح</th><th>التاريخ</th></tr></thead>
    <tbody>${md.phones.map((i,x)=>{const ph=inventory.find(p=>p.id===i.modelId);const typeLabel=ph?.deviceType==='keypad'?'⌨️':'📱';const rollIdx=i._dayIdx??x;return`<tr style="${i._rolled?'opacity:.4;text-decoration:line-through':''}"><td>${esc(i.modelName||i.brand+' '+i.model)}</td><td style="color:#64748b">${typeLabel}</td><td>${i.qty||1}</td><td>${fmt(i.sellPrice||0)} ج</td><td style="color:${showProfits&&!i._rolled?'#4ade80':'#334155'}">${mfmt(i.profit)}</td><td style="color:#334155;font-size:10px">${i._date}</td><td>${i._rolled?`<span style="font-size:10px;color:#f87171">↩</span>`:`<button onclick="rollbackFromMonthly('phones',${rollIdx},'${i._date}')" style="background:#1c1200;border:1px solid #92400e;border-radius:5px;color:#f59e0b;padding:2px 7px;font-size:10px;cursor:pointer;font-family:inherit">↩</button>`}</td></tr>`;}).join('')}</tbody></table>`;
    det+=mSec('phones','📦','#06b6d4','هواتف جديدة',`${md.phones.length} عملية`,html);
  }

  if(md.repairs?.length){
    const html=`<table class="m-tbl"><thead><tr><th>الجهاز</th><th>العطل</th><th>الخدمة</th><th>الربح</th><th>الحالة</th></tr></thead><tbody>${md.repairs.map(i=>`<tr><td>${esc(i.brand+' '+i.model)}</td><td style="color:#64748b">${esc(i.faultType||'')}</td><td>${fmt(i.servicePrice||0)} ج</td><td style="color:${showProfits?'#4ade80':'#334155'}">${mfmt(i.profit||0)}</td><td>${REPAIR_STATUS[i.status]?.icon||''} ${REPAIR_STATUS[i.status]?.lbl||i.status}</td></tr>`).join('')}</tbody></table>`;
    det+=mSec('repairs','🔧','#f97316','صيانة',`${md.repairs.length} عملية`,html);
  }

  if(md.sw.length){
    const html=`<table class="m-tbl"><thead><tr><th>الخدمة</th><th>السعر</th><th>التاريخ</th></tr></thead><tbody>${md.sw.map(i=>`<tr><td>${esc(i.name)}</td><td>${fmt(i.price)} ج</td><td style="color:#334155;font-size:10px">${i._date}</td></tr>`).join('')}</tbody></table>`;
    det+=mSec('sw','⚙️','#10b981','سوفت وير',`${md.sw.length} عملية`,html);
  }

  if(md.cash.length){
    const deps=md.cash.filter(i=>i.cashType==='deposit'||i.cashType==='إيداع'||!i.cashType);
    const withs=md.cash.filter(i=>i.cashType==='withdraw'||i.cashType==='سحب');
    const dTotal=deps.reduce((s,i)=>s+i.amount,0),wTotal=withs.reduce((s,i)=>s+i.amount,0);
    const bySvc={};md.cash.forEach(i=>{const k2=(i.service||'—')+' ('+( i.cashType||'إيداع')+')';if(!bySvc[k2])bySvc[k2]={cnt:0,total:0,color:SVC_C[i.service]||'#94a3b8'};bySvc[k2].cnt++;bySvc[k2].total+=i.amount;});
    const html=`<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:9px">
      <div class="inv-sum-card"><div class="inv-sum-lbl">💚 إيداع</div><div class="inv-sum-val" style="color:#4ade80;font-size:13px">${fmt(dTotal)} ج</div><div style="font-size:10px;color:#64748b">${deps.length} عملية</div></div>
      <div class="inv-sum-card"><div class="inv-sum-lbl">🔴 سحب</div><div class="inv-sum-val" style="color:#f87171;font-size:13px">${fmt(wTotal)} ج</div><div style="font-size:10px;color:#64748b">${withs.length} عملية</div></div>
      <div class="inv-sum-card"><div class="inv-sum-lbl">الأرباح الكلية</div><div class="inv-sum-val" style="color:#fbbf24;font-size:13px">${mfmt(c.cT)}</div></div>
    </div>
    ${Object.entries(bySvc).map(([sv,v])=>`<div class="srow2"><span style="color:${v.color}">${esc(sv)}</span><span>${v.cnt} عملية — <b style="color:#4ade80">${fmt(v.total)} ج</b></span></div>`).join('')}`;
    det+=mSec('cash','💳','#ef4444','الكاش',`${md.cash.length} عملية`,html);
  }

  if(md.exp.length){
    const byCat={};md.exp.forEach(i=>{if(!byCat[i.category])byCat[i.category]={cnt:0,total:0};byCat[i.category].cnt++;byCat[i.category].total+=i.amount;});
    const html=`${Object.entries(byCat).sort((a,b)=>b[1].total-a[1].total).map(([cat,v])=>`<div class="srow2"><span style="color:#fbbf24">${esc(cat)}</span><span>${v.cnt} مرة — <b style="color:#fbbf24">${fmt(v.total)} ج</b></span></div>`).join('')}`;
    det+=mSec('exp','💸','#f59e0b','مصاريف',`${md.exp.length} بند`,html);
  }
  const md2=$('monthly-detail');if(md2)md2.innerHTML=det||`<div class="empty" style="padding:28px">لا توجد بيانات لهذا الشهر</div>`;
  const mi=$('msearch-inp');if(mi)mi.value='';const mr=$('msearch-results');if(mr)mr.innerHTML='';
}

function initCmpUI() {
  // Populate year select
  const ySel = document.getElementById('cmp-year-sel'); if (!ySel) return;
  const years = new Set();
  Storage.search('mshop_d_').forEach(k => years.add(k.replace('mshop_d_','').slice(0,4)));
  const curYear = new Date().getFullYear();
  [curYear-1, curYear, curYear+1].forEach(y => years.add(String(y)));
  ySel.innerHTML = [...years].sort().reverse().map(y => `<option value="${y}">${y}</option>`).join('');
  ySel.value = String(curYear);
  // Set default month
  const mSel = document.getElementById('cmp-month-sel');
  if (mSel) { const [,m] = selMonth.split('-'); mSel.value = m === selMonth.split('-')[1] ? (parseInt(m)===1?'12':String(parseInt(m)-1).padStart(2,'0')) : m; }
  // Populate multi-month checkboxes
  populateCmpMulti();
}

function populateCmpMulti() {
  const el = document.getElementById('cmp-multi-checks'); if (!el) return;
  const available = new Set();
  Storage.search('mshop_d_').forEach(k => available.add(k.replace('mshop_d_','').slice(0,7)));
  const months = [...available].sort().reverse().slice(0, 12);
  el.innerHTML = months.map(ym => `<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#94a3b8;background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:4px 8px;cursor:pointer">
    <input type="checkbox" value="${ym}" ${ym===selMonth?'disabled':''} style="accent-color:#7c3aed"> ${getMonthLbl(ym)}
  </label>`).join('');
}

function updateCmpUI() {
  const mode = document.getElementById('cmp-mode')?.value;
  document.getElementById('cmp-single-row').style.display = mode === 'one' ? '' : 'none';
  document.getElementById('cmp-multi-row').style.display = mode === 'multi' ? '' : 'none';
}

function doComparison() {
  const mode = document.getElementById('cmp-mode')?.value || 'one';
  let months = [selMonth];
  if (mode === 'one') {
    const m = document.getElementById('cmp-month-sel')?.value;
    const y = document.getElementById('cmp-year-sel')?.value;
    if (!m || !y) { showToast('اختر الشهر والسنة','err'); return; }
    months.push(`${y}-${m}`);
  } else if (mode === 'multi') {
    const checks = document.querySelectorAll('#cmp-multi-checks input:checked');
    if (!checks.length) { showToast('اختر شهراً واحداً على الأقل','err'); return; }
    months = [selMonth, ...[...checks].map(c => c.value)];
  } else { // all
    const all = new Set();
    Storage.search('mshop_d_').forEach(k => all.add(k.replace('mshop_d_','').slice(0,7)));
    months = [...all].sort().reverse().slice(0,6);
    if (!months.includes(selMonth)) months.unshift(selMonth);
  }
  months = [...new Set(months)].sort().reverse();
  const data = months.map(ym => ({ ym, c: monthTotals(getMonthData(ym)) }));
  const cr = document.getElementById('cmp-result'); if (!cr) return;
  const bar = (val, max, color) => `<div style="background:#1e293b;border-radius:3px;height:5px;margin-top:3px"><div style="width:${max?Math.round(val/max*100):0}%;height:100%;background:${color};border-radius:3px"></div></div>`;
  const maxP = Math.max(...data.map(d => d.c.profit));
  const maxT = Math.max(...data.map(d => d.c.total));
  const COLORS = ['#3b82f6','#8b5cf6','#06b6d4','#10b981','#f97316','#ef4444'];
  cr.innerHTML = `
    <div style="overflow-x:auto;scrollbar-width:none">
      <div style="display:flex;gap:7px;min-width:max-content;padding-bottom:4px">
        ${data.map((d,i) => `<div style="background:#0f172a;border:1px solid ${COLORS[i%COLORS.length]}30;border-radius:11px;padding:9px 11px;min-width:130px;flex:0 0 auto">
          <div style="font-size:10px;font-weight:700;color:${COLORS[i%COLORS.length]};margin-bottom:6px">${getMonthLbl(d.ym)}</div>
          <div style="font-size:10px;color:#64748b">إجمالي</div>
          <div style="font-size:13px;font-weight:700;color:#60a5fa">${fmt(d.c.total)} ج</div>
          ${bar(d.c.total, maxT, '#3b82f6')}
          <div style="font-size:10px;color:#64748b;margin-top:5px">صافي الربح</div>
          <div style="font-size:13px;font-weight:700;color:${d.c.profit>=0?'#4ade80':'#f87171'}">${mfmt(d.c.profit)}</div>
          ${bar(d.c.profit, maxP, '#4ade80')}
          <div style="font-size:10px;color:#64748b;margin-top:5px">عمليات</div>
          <div style="font-size:11px;font-weight:700;color:#e2e8f0">${d.c.ops}</div>
          <div style="font-size:10px;color:#64748b;margin-top:5px">متوسط الربح</div>
          <div style="font-size:11px;font-weight:700;color:#fbbf24">${d.c.ops>0?mfmt(Math.round(d.c.profit/d.c.ops)):'—'}</div>
        </div>`).join('')}
      </div>
    </div>
    ${data.length >= 2 ? `<div style="margin-top:10px;background:#0a0f1e;border-radius:10px;padding:9px 11px">
      <div style="font-size:11px;font-weight:700;color:#a78bfa;margin-bottom:7px">📊 نسب التغيير</div>
      ${data.slice(0,-1).map((d,i) => {
        const next = data[i+1]; const diff = d.c.profit - next.c.profit;
        const pct = next.c.profit ? ((diff/Math.abs(next.c.profit))*100).toFixed(1) : '∞';
        return `<div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid #1e293b">
          <span style="color:#64748b">${getMonthLbl(next.ym)} → ${getMonthLbl(d.ym)}</span>
          <span style="color:${diff>=0?'#4ade80':'#f87171'};font-weight:700">${diff>=0?'+':''}${pct}%</span>
        </div>`;
      }).join('')}
    </div>` : ''}`;
}

function doMonthSearch(){
  const q=g('msearch-inp').toLowerCase();if(q.length<2){const mr=$('msearch-results');if(mr)mr.innerHTML='';return;}
  const md=getMonthData();let res=[];
  md.acc.forEach(i=>{if(i.name.toLowerCase().includes(q))res.push({type:'اكسسوار',c:'#3b82f6',lbl:i.name,amt:'بيع: '+fmt(i.sell)+' ج',date:i._date});});
  md.used.forEach(i=>{if(i.name.toLowerCase().includes(q))res.push({type:'مستعمل',c:'#8b5cf6',lbl:i.name,amt:fmt(i.sell)+' ج',date:i._date});});
  md.cash.forEach(i=>{if(i.service.toLowerCase().includes(q))res.push({type:'كاش',c:'#ef4444',lbl:i.service,amt:fmt(i.amount)+' ج',date:i._date});});
  md.sw.forEach(i=>{if(i.name.toLowerCase().includes(q))res.push({type:'سوفت',c:'#10b981',lbl:i.name,amt:fmt(i.price)+' ج',date:i._date});});
  md.phones?.forEach(i=>{if((i.modelName||'').toLowerCase().includes(q))res.push({type:'هاتف',c:'#06b6d4',lbl:i.modelName||'',amt:fmt(i.sellPrice||0)+' ج',date:i._date});});
  md.repairs?.forEach(i=>{if((i.brand+' '+i.model).toLowerCase().includes(q)||(i.clientName||'').toLowerCase().includes(q))res.push({type:'صيانة',c:'#f97316',lbl:i.brand+' '+i.model,amt:fmt(i.servicePrice||0)+' ج',date:i._date});});
  md.exp.forEach(i=>{if(i.category.toLowerCase().includes(q))res.push({type:'مصروف',c:'#f59e0b',lbl:i.category,amt:fmt(i.amount)+' ج',date:i._date});});
  const mr=$('msearch-results');if(mr)mr.innerHTML=res.length?res.map(r=>`<div class="item"><span class="ibadge" style="background:${r.c}30;color:${r.c}">${r.type}</span><span class="iname">${esc(r.lbl)}</span><span style="font-size:11px;color:#94a3b8">${r.amt}</span><span class="itime">${r.date}</span></div>`).join(''):`<div style="font-size:12px;color:#475569;padding:8px">لا توجد نتائج</div>`;
}

function printMonthPDF(){
  const md=getMonthData(),c=monthTotals(md);const w=window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{box-sizing:border-box}body{font-family:Arial,sans-serif;direction:rtl;padding:20px;color:#111;font-size:12px}h1{font-size:17px;margin-bottom:4px}h2{font-size:13px;margin:12px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:12px}.card{border:1px solid #ddd;border-radius:5px;padding:7px;text-align:center}.lbl{font-size:9px;color:#666;margin-bottom:2px}.val{font-size:14px;font-weight:700}table{width:100%;border-collapse:collapse;margin-bottom:9px}th,td{border:1px solid #ddd;padding:4px 6px;text-align:right}th{background:#f0f0f0;font-size:9px}td{font-size:10px}@media print{button{display:none}}<\/style></head><body><h1>${cfg.name} — ${getMonthLbl(selMonth)}</h1><p style="font-size:9px;color:#666;margin-bottom:10px">${new Date().toLocaleDateString('ar-EG',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p><div class="grid"><div class="card"><div class="lbl">إجمالي المبيعات</div><div class="val">${fmt(c.total)} ج</div></div><div class="card"><div class="lbl">المصاريف</div><div class="val">${fmt(c.eT)} ج</div></div><div class="card"><div class="lbl">صافي الربح</div><div class="val" style="color:${c.profit>=0?'green':'red'}">${fmt(c.profit)} ج</div></div><div class="card"><div class="lbl">عدد العمليات</div><div class="val">${c.ops}</div></div></div>`);
  if(md.repairs?.length)w.document.write(`<h2>🔧 الصيانة (${md.repairs.length})</h2><table><tr><th>الجهاز</th><th>العطل</th><th>الخدمة</th><th>الربح</th><th>الحالة</th><th>التاريخ</th></tr>${md.repairs.map(i=>`<tr><td>${esc(i.brand+' '+i.model)}</td><td>${esc(i.faultType||'')}</td><td>${fmt(i.servicePrice||0)} ج</td><td>${fmt(i.profit||0)} ج</td><td>${REPAIR_STATUS[i.status]?.lbl||''}</td><td>${i._date}</td></tr>`).join('')}</table>`);
  if(md.phones?.length)w.document.write(`<h2>📦 هواتف جديدة (${md.phones.length})</h2><table><tr><th>الموديل</th><th>كمية</th><th>البيع</th><th>الربح</th></tr>${md.phones.map(i=>`<tr><td>${esc(i.modelName||'')}</td><td>${i.qty||1}</td><td>${fmt(i.sellPrice||0)} ج</td><td>${fmt(i.profit||0)} ج</td></tr>`).join('')}</table>`);
  w.document.write(`<div style="margin-top:16px;font-size:9px;color:#999;text-align:center">${cfg.name} — نظام إدارة المحل</div><br><button onclick="window.print()" style="padding:7px 18px;font-size:12px;cursor:pointer">🖨️ طباعة</button><\/body><\/html>`);
  w.document.close();
}

function toggleMonSec(id, hdr) {
  const body = hdr?.nextElementSibling;
  if (!body) return;
  const open = body.style.display === 'block';
  body.style.display = open ? 'none' : 'block';
  const arrow = hdr.querySelector('span:last-child');
  if (arrow) arrow.style.transform = open ? 'rotate(-90deg)' : 'rotate(0deg)';
  // Persist to sessionStorage
  const saved = JSON.parse(sessionStorage.getItem('mshop_mon_open')||'{}');
  saved[id] = !open;
  sessionStorage.setItem('mshop_mon_open', JSON.stringify(saved));
}
