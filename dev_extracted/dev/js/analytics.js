// ═══════════════════════════════════════════════════════════
// analytics.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function getLast30Avg(){
  let totalProfit=0,days=0;for(let i=1;i<=30;i++){const d=new Date();d.setDate(d.getDate()-i);const dk='mshop_d_'+d.toISOString().split('T')[0];const dd=Storage.get(dk,{});if(Object.keys(dd).length>0){totalProfit+=computeFinancialTotals(dd).profit;days++;}}return{avg:days>2?totalProfit/days:null,days};
}

function renderRatingAndInsights(){
  const c=calcTotals(),{avg}=getLast30Avg();
  const dcR=document.getElementById('dc-rating'),dcI=document.getElementById('dc-insights');
  const dcRC=document.getElementById('dc-rating-content'),dcIC=document.getElementById('dc-insights-content');
  // Rating card
  if(avg!==null&&avg>0&&sel===TODAY&&dcR&&dcRC){
    const ratio=c.profit/avg;let rating,color,icon,reason;
    if(ratio>=1.3){rating='ممتاز';color='#4ade80';icon='⭐';reason=`أعلى من المتوسط بـ ${Math.round((ratio-1)*100)}%`;}
    else if(ratio>=1.0){rating='جيد';color='#60a5fa';icon='👍';reason='فوق المتوسط اليومي';}
    else if(ratio>=0.6){rating='متوسط';color='#fbbf24';icon='📊';reason=`أقل من المتوسط بـ ${Math.round((1-ratio)*100)}%`;}
    else{rating='أقل من المتوسط';color='#f87171';icon='📉';reason=`المتوسط: ${fmt(Math.round(avg))} ج`;}
    dcRC.innerHTML=`<div class="kpi-card" style="border-color:${color}40">
      <div class="kpi-top"><span class="kpi-icon">${icon}</span><span class="kpi-label">تقييم أداء اليوم</span></div>
      <div class="kpi-val" style="color:${color}">${rating}</div>
      <div class="kpi-sub" style="color:${color}99">${reason}</div>
    </div>`;
    dcR.style.display='';
  } else if(dcR) dcR.style.display='none';
  // Insights card
  if(sel===TODAY&&dcI&&dcIC){
    const insights=generateInsights();
    if(insights.length){
      dcIC.innerHTML=`<div class="kpi-card" style="border-color:#1e3a5f">
        <div class="kpi-top"><span class="kpi-icon">🤖</span><span class="kpi-label">تحليل ذكي</span></div>
        ${insights.slice(0,2).map(ins=>`<div style="font-size:10px;color:#94a3b8;line-height:1.5">${ins.icon} ${ins.text}</div>`).join('')}
      </div>`;
      dcI.style.display='';
    } else dcI.style.display='none';
  } else if(dcI) dcI.style.display='none';
}

function generateInsights(){
  const insights=[];const dayProfits={};
  for(let i=0;i<30;i++){const d=new Date();d.setDate(d.getDate()-i);const ds=d.toISOString().split('T')[0];const dk='mshop_d_'+ds;const dd=Storage.get(dk,{});if(Object.keys(dd).length>0)dayProfits[ds]=computeFinancialTotals(dd).profit;}
  const days=Object.keys(dayProfits);if(days.length<5)return[];
  const dowSum=Array(7).fill(0),dowCnt=Array(7).fill(0);days.forEach(ds=>{const dw=new Date(ds+'T12:00:00').getDay();dowSum[dw]+=dayProfits[ds];dowCnt[dw]++;});
  const dowAvg=dowSum.map((s,i)=>dowCnt[i]?s/dowCnt[i]:0);const bestDow=dowAvg.indexOf(Math.max(...dowAvg));
  if(dowCnt[bestDow]>1)insights.push({icon:'📅',text:`${DAYS_AR[bestDow]} هو أفضل يوم للمبيعات خلال آخر 30 يوم`});
  const monthData=getMonthData(),c=monthTotals(monthData);
  const secs=[['الموبايلات المستعملة',c.uP],['الاكسسوار',c.aP],['الكاش',c.cT],['السوفت وير',c.sT],['الهواتف الجديدة',c.phP],['الصيانة',c.repP]].filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]);
  if(secs.length)insights.push({icon:'🏆',text:`${secs[0][0]} يحقق أعلى ربح هذا الشهر (${mfmt(secs[0][1])})`});
  const totalP=days.reduce((s,d)=>s+dayProfits[d],0),avgP=totalP/days.length;
  insights.push({icon:'💰',text:`متوسط الربح اليومي خلال آخر 30 يوم: ${mfmt(Math.round(avgP))}`});
  const todayP=calcTotals().profit;if(todayP>avgP*1.5)insights.push({icon:'🔥',text:'أداء اليوم استثنائي مقارنة بالمتوسط!'});
  return insights.slice(0,4);
}

function populateAnaMonths(){
  const s=$('ana-month');if(!s)return;
  const months=new Set();Storage.search('mshop_d_').forEach(k=>{const d=k.replace('mshop_d_','');if(d.length>=7)months.add(d.slice(0,7));});
  if(!months.has(selMonth))months.add(selMonth);
  s.innerHTML=[...months].sort().reverse().map(m=>`<option value="${m}" ${m===selMonth?'selected':''}>${getMonthLbl(m)}</option>`).join('');
}

function renderAnalytics(){
  _lastRender = renderAnalytics;
  extendAdminSession();
  const ym=$('ana-month')?.value||selMonth,md=getMonthData(ym),c=monthTotals(md);
  const allItems=[...md.acc,...md.used,...md.cash,...md.sw,...(md.phones||[]),...(md.repairs||[])];
  const ac=$('analytics-content');if(!ac)return;
  if(allItems.length<5){ac.innerHTML=`<div class="m-sec"><div style="text-align:center;padding:20px;color:#475569;font-size:13px">⚠️ البيانات غير كافية — تحتاج على الأقل 5 عمليات</div></div>`;return;}
  const hd=Array(24).fill(0);allItems.forEach(i=>{const h=parseInt((i.time||'00:00').split(':')[0]);if(!isNaN(h)&&h>=0&&h<24)hd[h]++;});
  // Only consider hours with actual transactions
  const activeHours=hd.map((cnt,h)=>({h,cnt})).filter(x=>x.cnt>0).sort((a,b)=>b.cnt-a.cnt);
  const bestHourObj=activeHours[0]||{h:0,cnt:0};
  const bH=bestHourObj.h, bHCnt=bestHourObj.cnt;
  const topHours=activeHours.slice(0,3);
  const dd=Array(7).fill(0);[...md.acc,...md.used,...md.sw].forEach(i=>{try{dd[new Date(i._date+'T12:00:00').getDay()]++;}catch{}});
  const mxD=Math.max(...dd)||1,bD=dd.indexOf(Math.max(...dd));
  const per={e:0,m:0,l:0};allItems.forEach(i=>{const day=parseInt((i._date||'').split('-')[2]);if(day<=10)per.e++;else if(day<=20)per.m++;else per.l++;});
  const catD={};md.acc.forEach(i=>{const c2=i.mainCat||'أخري';if(!catD[c2])catD[c2]={qty:0,profit:0};catD[c2].qty++;catD[c2].profit+=i.profit;});
  const sortedCats=Object.entries(catD).sort((a,b)=>b[1].qty-a[1].qty);
  const days=new Set(allItems.map(i=>i._date)),dc=Math.max(days.size,1);
  const bDay=Object.entries(Object.fromEntries([...days].map(d=>[d,allItems.filter(i=>i._date===d).length]))).sort((a,b)=>b[1]-a[1])[0];
  const total=c.profit+c.eT; // نفس قيمة إجمالي الربح قبل خصم المصاريف — مُشتقة من نتيجة المحرك الموحّد، وليست صيغة منفصلة (كانت مكررة هنا سابقًا بنفس صيغة renderProfitSource)
  const secs=total>0?[['📦 هواتف جديدة',c.phP,'#06b6d4'],['🔧 صيانة',c.repP,'#f97316'],['📱 مستعمل',c.uP,'#8b5cf6'],['🎧 اكسسوار',c.aP,'#3b82f6'],['💳 الكاش',c.cT,'#ef4444'],['⚙️ سوفت وير',c.sT,'#10b981']].filter(s=>s[1]>0).sort((a,b)=>b[1]-a[1]):[];
  ac.innerHTML=`<div class="stat-grid">
    <div class="stat-card"><div class="stat-icon">⏰</div><div class="stat-lbl">أفضل ساعة للبيع</div><div class="stat-val">${bHCnt>0?bH+':00 — '+(bH+1)+':00':'—'}</div><div class="stat-sub">${bHCnt>0?bHCnt+' عملية':'لا بيانات كافية'}</div>${topHours.length>1?`<div style="font-size:9px;color:#475569;margin-top:3px">${topHours.map(x=>x.h+':00 ('+x.cnt+')').join(' · ')}</div>`:''}</div>
    <div class="stat-card"><div class="stat-icon">📅</div><div class="stat-lbl">أفضل يوم الأسبوع</div><div class="stat-val">${DAYS_AR[bD]}</div><div class="stat-sub">${dd[bD]} عملية</div></div>
    <div class="stat-card"><div class="stat-icon">📆</div><div class="stat-lbl">أفضل يوم الشهر</div><div class="stat-val">${bDay?bDay[0].split('-')[2]:'-'}</div><div class="stat-sub">${bDay?bDay[1]+' عمليات':''}</div></div>
    <div class="stat-card"><div class="stat-icon">💰</div><div class="stat-lbl">متوسط مبيعات يومي</div><div class="stat-val">${fmt(Math.round(c.total/dc))}</div><div class="stat-sub">ج/يوم</div></div>
    <div class="stat-card"><div class="stat-icon">📊</div><div class="stat-lbl">متوسط ربح يومي</div><div class="stat-val">${mfmt(Math.round(total/dc))}</div><div class="stat-sub">ج/يوم</div></div>
    <div class="stat-card"><div class="stat-icon">🏆</div><div class="stat-lbl">أكثر فئة اكسسوار</div><div class="stat-val" style="font-size:13px">${sortedCats[0]?sortedCats[0][0]:'—'}</div></div>
  </div>
  ${secs.length?`<div class="m-sec"><div class="m-sec-hdr" style="color:#a78bfa">📊 مصادر الأرباح</div>${secs.map(([lbl,val,col])=>{const pct=Math.round(val/total*100);return`<div class="pbar-row"><div class="pbar-lbl">${lbl}</div><div class="pbar-bg"><div class="pbar-fill" style="width:${pct}%;background:${col}"></div></div><div class="pbar-val">${mfmt(val)} (${pct}%)</div></div>`;}).join('')}</div>`:''}
  <div class="m-sec"><div class="m-sec-hdr" style="color:#10b981">📅 نشاط أيام الأسبوع</div><div class="bar-wrap">${DAYS_AR.map((day,i)=>`<div class="bar-row"><div class="bar-lbl">${day}</div><div class="bar-bg"><div class="bar-fill" style="width:${Math.round(dd[i]/mxD*100)}%;background:${i===bD?'#4ade80':'#10b981'}"></div></div><div class="bar-val">${dd[i]}</div></div>`).join('')}</div></div>`;
}

function setNLP(txt){const el=$('nlp-inp');if(el)el.value=txt;doNLPSearch();}

function parseNLP(text){
  const f={};
  if(/الشهر الماضي|الشهر السابق/.test(text)){const d=new Date();d.setMonth(d.getMonth()-1);f.month=d.toISOString().slice(0,7);}
  else if(/هذا الشهر|الشهر الحالي/.test(text)){f.month=new Date().toISOString().slice(0,7);}
  else if(/هذا الأسبوع|الأسبوع/.test(text)){const d=new Date();d.setDate(d.getDate()-7);f.from=d.toISOString().split('T')[0];f.to=td();}
  else if(/اليوم/.test(text)){f.from=f.to=td();}
  else{const m7=/آخر (\d+) يوم/.exec(text)||/خلال (\d+) يوم/.exec(text);if(m7){const d=new Date();d.setDate(d.getDate()-parseInt(m7[1]));f.from=d.toISOString().split('T')[0];f.to=td();}}
  if(/مستعمل/.test(text))f.type='used';
  else if(/اكسسوار|إكسسوار|جراب|كفر|شاشة/.test(text))f.type='acc';
  else if(/سوفت/.test(text))f.type='sw';
  else if(/كاش|فودافون|اتصالات|اورانج/.test(text))f.type='cash';
  else if(/مصار|مصروف/.test(text))f.type='exp';
  else if(/هاتف جديد|موبايل جديد/.test(text))f.type='phones';
  else if(/صيانة|إصلاح/.test(text))f.type='repairs';
  const minM=/أكبر من\s*(\d+)|أكثر من\s*(\d+)/.exec(text);if(minM)f.minAmount=parseInt(minM[1]||minM[2]);
  const maxM=/(?:في حدود|أقل من|حتى)\s*(\d+)/.exec(text);if(maxM)f.maxAmount=parseInt(maxM[1]);
  let kw=text.replace(/الشهر الماضي|هذا الشهر|هذا الأسبوع|آخر \d+ يوم|اليوم|مستعمل|اكسسوار|سوفت وير|الكاش|مصاريف|هاتف جديد|صيانة|أكبر من \d+|أقل من \d+|في حدود \d+|مبيعات|أرباح|عمليات/g,'').trim();
  if(kw.length>1)f.keyword=kw;
  return f;
}

function doNLPSearch(){
  const raw=g('nlp-inp'),f=raw?parseNLP(raw):{};
  const fd=$('nlp-filter-display');
  const parts=[];
  if(f.type){const tn={acc:'اكسسوار',used:'مستعمل',cash:'كاش',sw:'سوفت وير',exp:'مصاريف',phones:'هواتف جديدة',repairs:'صيانة'};parts.push('القسم: '+tn[f.type]);}
  if(f.month)parts.push('الشهر: '+getMonthLbl(f.month));
  if(f.from)parts.push('من: '+f.from+(f.to?' حتى: '+f.to:''));
  if(f.minAmount)parts.push('أكبر من: '+fmt(f.minAmount)+' ج');
  if(f.keyword)parts.push('كلمة: "'+f.keyword+'"');
  if(fd){if(parts.length){fd.style.display='block';fd.innerHTML='🔍 '+parts.join(' · ');}else fd.style.display='none';}
  let res=getAllData();
  if(f.type)res=res.filter(r=>r.type===f.type);
  if(f.month)res=res.filter(r=>r.date.startsWith(f.month));
  if(f.from)res=res.filter(r=>r.date>=f.from);
  if(f.to)res=res.filter(r=>r.date<=f.to);
  if(f.minAmount)res=res.filter(r=>r.amount>=f.minAmount);
  if(f.maxAmount)res=res.filter(r=>r.amount<=f.maxAmount);
  if(f.keyword){const kw=f.keyword.toLowerCase();res=res.filter(r=>r.name.toLowerCase().includes(kw));}
  const ss=$('search-stats');if(ss)ss.textContent=raw?`وُجد ${res.length} نتيجة`:'';
  const sr=$('search-results-adv');if(sr)sr.innerHTML=res.length?res.slice(0,300).map(r=>`<div class="item"><span class="ibadge" style="background:${r.c}30;color:${r.c}">${r.typeAr}</span><span class="iname">${esc(r.name)}</span><span class="imoney" style="color:#94a3b8">${fmt(r.amount)} ج</span><span class="itime">${r.date} ${r.time}</span></div>`).join(''):`<div class="empty">لا توجد نتائج مطابقة</div>`;
}

function renderPhonesAnalytics() {
  _lastRender = renderPhonesAnalytics;
  const el = document.getElementById('ph-brand-content'); if (!el) return;
  const activeInv = inventory.filter(p => !p.archived);
  // Gather all-time sales
  const allSales = [];
  Storage.search('mshop_d_').forEach(k => {
    const d = Storage.get(k); if (!d) return;
    (d.phones||[]).forEach(s => allSales.push({...s}));
  });
  // Movement breakdown
  const fast = activeInv.filter(p => getMovement(p.id).score === 3);
  const med  = activeInv.filter(p => getMovement(p.id).score === 2);
  const slow = activeInv.filter(p => getMovement(p.id).score === 1);
  const stag = activeInv.filter(p => getMovement(p.id).score === 0);
  // Brand stats
  const bMap = {};
  activeInv.forEach(ph => {
    if (!bMap[ph.brand]) bMap[ph.brand] = {models:0, qty:0, value:0, sales:0, profit:0, devices:0};
    bMap[ph.brand].models++;
    bMap[ph.brand].qty += ph.qty;
    bMap[ph.brand].value += ph.qty * (ph.buyPrice || 0);
  });
  allSales.forEach(s => {
    const ph = inventory.find(p => p.id === s.modelId);
    if (!ph || !bMap[ph.brand]) return;
    bMap[ph.brand].sales += s.qty;
    bMap[ph.brand].profit += (s.profit || 0);
  });
  const brands = Object.entries(bMap).sort((a, b) => b[1].sales - a[1].sales);
  const totalVal = Object.values(bMap).reduce((t, b) => t + b.value, 0) || 1;
  const totalSalesAll = brands.reduce((t, [,b]) => t + b.sales, 0) || 1;
  // Model stats
  const mMap = {};
  allSales.forEach(s => {
    if (!mMap[s.modelId]) mMap[s.modelId] = {name: s.modelName||s.modelId, qty:0, profit:0};
    mMap[s.modelId].qty += s.qty;
    mMap[s.modelId].profit += (s.profit || 0);
  });
  const topSales  = Object.values(mMap).sort((a,b) => b.qty - a.qty).slice(0,5);
  const topProfit = Object.values(mMap).sort((a,b) => b.profit - a.profit).slice(0,5);
  const bar = (val, max, color) => `<div style="flex:1;background:#1e293b;border-radius:4px;height:7px;overflow:hidden"><div style="width:${Math.max(3,Math.round(val/max*100))}%;height:100%;background:${color};border-radius:4px"></div></div>`;

  el.innerHTML = `
  <!-- حركة الموديلات -->
  <div style="background:#0a0f1e;border:1px solid #1e293b;border-radius:12px;padding:11px;margin-bottom:11px">
    <div style="font-size:11px;font-weight:700;color:#06b6d4;margin-bottom:9px;letter-spacing:.5px">📊 حركة الموديلات</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">
      <div class="inv-sum-card" style="cursor:pointer;border-color:#4ade8030" onclick="document.getElementById('ph-filter').value='fast';setPhonesTab('inv',document.getElementById('pst-inv'))">
        <div class="inv-sum-lbl">🔥 سريع</div><div class="inv-sum-val" style="color:#4ade80">${fast.length}</div></div>
      <div class="inv-sum-card" style="cursor:pointer;border-color:#60a5fa30" onclick="document.getElementById('ph-filter').value='medium';setPhonesTab('inv',document.getElementById('pst-inv'))">
        <div class="inv-sum-lbl">📊 متوسط</div><div class="inv-sum-val" style="color:#60a5fa">${med.length}</div></div>
      <div class="inv-sum-card" style="cursor:pointer;border-color:#fbbf2430" onclick="document.getElementById('ph-filter').value='slow';setPhonesTab('inv',document.getElementById('pst-inv'))">
        <div class="inv-sum-lbl">🐌 بطيء</div><div class="inv-sum-val" style="color:#fbbf24">${slow.length}</div></div>
      <div class="inv-sum-card" style="cursor:pointer;border-color:#f8717130" onclick="document.getElementById('ph-filter').value='stagnant';setPhonesTab('inv',document.getElementById('pst-inv'))">
        <div class="inv-sum-lbl">💤 راكد</div><div class="inv-sum-val" style="color:#f87171">${stag.length}</div></div>
    </div>
  </div>
  <!-- أكثر الموديلات مبيعًا -->
  ${topSales.length ? `<details style="background:#0a0f1e;border:1px solid #1e293b;border-radius:12px;margin-bottom:11px" open>
    <summary style="font-size:11px;font-weight:700;color:#4ade80;padding:11px;cursor:pointer;list-style:none">🏆 أكثر الموديلات مبيعًا</summary>
    <div style="padding:0 11px 11px">
    ${topSales.map((m,i)=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="font-size:13px;min-width:16px">${['🥇','🥈','🥉','4️⃣','5️⃣'][i]}</span>
      <span style="flex:1;font-size:11px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</span>
      ${bar(m.qty, topSales[0].qty, '#4ade80')}
      <span style="font-size:11px;color:#4ade80;min-width:52px;text-align:left">${m.qty} جهاز</span>
    </div>`).join('')}
    </div>
  </details>` : ''}
  <!-- أعلى الموديلات ربحًا -->
  ${topProfit.length ? `<details style="background:#0a0f1e;border:1px solid #1e293b;border-radius:12px;margin-bottom:11px">
    <summary style="font-size:11px;font-weight:700;color:#fbbf24;padding:11px;cursor:pointer;list-style:none">💰 أعلى الموديلات ربحًا</summary>
    <div style="padding:0 11px 11px">
    ${adminUnlocked ? topProfit.map((m,i)=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="font-size:13px;min-width:16px">${['🥇','🥈','🥉','4️⃣','5️⃣'][i]}</span>
      <span style="flex:1;font-size:11px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</span>
      ${bar(m.profit, topProfit[0].profit, '#fbbf24')}
      <span style="font-size:11px;color:#fbbf24;min-width:65px;text-align:left">${fmt(m.profit)} ج</span>
    </div>`).join('') :
    `<div style="text-align:center;padding:12px 0"><span style="cursor:pointer;color:#475569;font-size:22px;letter-spacing:3px" onclick="requireAdmin(renderPhonesAnalytics)">••••••</span><br><span style="font-size:10px;color:#334155;cursor:pointer" onclick="requireAdmin(renderPhonesAnalytics)">اضغط لإظهار بيانات الأرباح</span></div>`}
    </div>
  </details>` : ''}
  <!-- تحليل الشركات -->
  ${brands.length ? `<div style="margin-bottom:5px">
    <div style="font-size:11px;font-weight:700;color:#06b6d4;margin-bottom:9px">🏢 تحليل الشركات</div>
    ${brands.map(([name, d]) => {
      const salePct = Math.round(d.sales / totalSalesAll * 100);
      const valPct  = Math.round(d.value / totalVal * 100);
      return `<div class="supplier-card" style="cursor:pointer;margin-bottom:8px" onclick="openBrandDetail('${name}')">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div style="font-size:13px;font-weight:800;color:#e2e8f0">📱 ${esc(name)}</div>
          <div style="display:flex;gap:5px">
            <span class="ibadge" style="background:#4ade8020;color:#4ade80">${d.sales} مبيع</span>
            <span class="ibadge" style="background:#06b6d420;color:#06b6d4">${d.models} موديل</span>
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:#64748b;margin-bottom:7px">
          <span>في المخزون: <b style="color:#e2e8f0">${d.qty}</b></span>
          <span>قيمة المخزون: <b style="color:${adminUnlocked?'#fbbf24':'#475569'}">${adminUnlocked?fmt(d.value)+' ج':`<span style="cursor:pointer;letter-spacing:1px" onclick="event.stopPropagation();requireAdmin(renderPhonesAnalytics)">••••</span>`}</b></span>
          <span>ربح: <b style="color:${adminUnlocked?'#4ade80':'#475569'}">${adminUnlocked?fmt(d.profit)+' ج':`<span style="cursor:pointer;letter-spacing:1px" onclick="event.stopPropagation();requireAdmin(renderPhonesAnalytics)">••••</span>`}</b></span>
        </div>
        <div style="margin-bottom:5px">
          <div style="display:flex;justify-content:space-between;font-size:9px;color:#475569;margin-bottom:3px"><span>نسبة المبيعات</span><span>${salePct}%</span></div>
          ${bar(d.sales, totalSalesAll, '#4ade80')}
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:9px;color:#475569;margin-bottom:3px"><span>نسبة قيمة المخزون</span><span>${valPct}%</span></div>
          ${bar(d.value, totalVal, '#06b6d4')}
        </div>
        <div style="font-size:9px;color:#334155;margin-top:6px;text-align:left">اضغط للتفاصيل ›</div>
      </div>`;
    }).join('')}
  </div>` : `<div class="empty">لا توجد بيانات بعد</div>`}`;
}

function renderQuickKPI() {
  const el = document.getElementById('quick-kpi'); if (!el) return;
  const activeInv = inventory.filter(p => !p.archived);
  if (!activeInv.length) { el.innerHTML = ''; return; }
  // Monthly sales
  const now = new Date(), thisMonth = now.toISOString().slice(0,7);
  const allSalesMonth = [];
  Storage.search('mshop_d_').forEach(k => {
    const date = k.replace('mshop_d_','');
    if (date.slice(0,7) !== thisMonth) return;
    const d = Storage.get(k); if (!d) return;
    (d.phones||[]).forEach(s => allSalesMonth.push({...s, date}));
  });
  // Best model this month
  const mMap = {};
  allSalesMonth.forEach(s => { if (!mMap[s.modelId]) mMap[s.modelId] = {name:s.modelName||s.modelId,qty:0,profit:0}; mMap[s.modelId].qty+=s.qty; mMap[s.modelId].profit+=(s.profit||0); });
  const bestModel = Object.values(mMap).sort((a,b)=>b.qty-a.qty)[0];
  const bestProfit = Object.values(mMap).sort((a,b)=>b.profit-a.profit)[0];
  // Best brand this month
  const bMap = {};
  allSalesMonth.forEach(s => { const ph=inventory.find(p=>p.id===s.modelId); if(!ph) return; if(!bMap[ph.brand])bMap[ph.brand]=0; bMap[ph.brand]+=s.qty; });
  const bestBrand = Object.entries(bMap).sort((a,b)=>b[1]-a[1])[0];
  // Fastest mover (best score active)
  const fastModels = activeInv.filter(p=>getMovement(p.id).score===3);
  const topFast = fastModels.map(p=>({p, qty:getPhoneSales(p.id,30).reduce((t,s)=>t+s.qty,0)})).sort((a,b)=>b.qty-a.qty)[0];
  const outCnt  = activeInv.filter(p=>p.qty===0).length;
  const stagCnt = activeInv.filter(p=>getMovement(p.id).score===0&&p.qty>0).length;
  const kpis = [
    {icon:'📱',lbl:'أكثر مبيعًا / شهر',  val: bestModel ? bestModel.name.replace(/.*? /,'') : '—',      color:'#4ade80'},
    {icon:'🏢',lbl:'أكثر شركة مبيعًا',   val: bestBrand ? `${bestBrand[0]} (${bestBrand[1]})` : '—',    color:'#06b6d4'},
    {icon:'💰',lbl:'أعلى ربحًا',          val: bestProfit&&adminUnlocked ? bestProfit.name.replace(/.*? /,'') : bestProfit ? '••••' : '—', color:'#fbbf24', click: !adminUnlocked&&bestProfit?'requireAdmin(renderQuickKPI)':''},
    {icon:'🔥',lbl:'أسرع حركة',           val: topFast ? topFast.p.brand+' '+topFast.p.model.split(' ')[0] : '—',  color:'#f97316'},
    {icon:'❌',lbl:'نافدة',               val: outCnt,   color: outCnt?'#f87171':'#4ade80'},
    {icon:'💤',lbl:'راكدة',              val: stagCnt,  color: stagCnt?'#fbbf24':'#4ade80'},
  ];
  el.innerHTML = `<div style="overflow-x:auto;scrollbar-width:none"><div style="display:flex;gap:7px;min-width:max-content;padding-bottom:2px">
    ${kpis.map(k=>`<div style="background:#0a0f1e;border:1px solid #1e293b;border-radius:9px;padding:7px 10px;min-width:95px;flex-shrink:0${k.click?';cursor:pointer':''}" ${k.click?`onclick="${k.click}"`:''}>
      <div style="font-size:9px;color:#475569;margin-bottom:3px">${k.icon} ${k.lbl}</div>
      <div style="font-size:11px;font-weight:700;color:${k.color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90px">${k.val}</div>
    </div>`).join('')}
  </div></div>`;
}

function renderBrandFilterBar() {
  const el = document.getElementById('brand-filter-bar'); if (!el) return;
  const brands = [...new Set(inventory.filter(p=>!p.archived).map(p=>p.brand))].sort();
  if (brands.length < 2) { el.innerHTML = ''; return; }
  const btnStyle = (active) => `cursor:pointer;border:none;border-radius:20px;padding:5px 11px;font-size:11px;font-weight:700;font-family:inherit;white-space:nowrap;transition:all .15s;${active?'background:#06b6d4;color:#000':'background:#1e293b;color:#94a3b8'}`;
  el.innerHTML = [`<button style="${btnStyle(!currentBrandFilter)}" onclick="currentBrandFilter='';renderBrandFilterBar();renderPhonesList()">الكل</button>`,
    ...brands.map(b => `<button style="${btnStyle(currentBrandFilter===b)}" onclick="currentBrandFilter='${b}';renderBrandFilterBar();renderPhonesList()">${b}</button>`)
  ].join('');
}
