// ═══════════════════════════════════════════════════════════
// cash.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function setCashType(type,el){selCashType=type;document.querySelectorAll('.type-btn').forEach(b=>{b.classList.remove('on');b.style.background='';b.style.borderColor='';b.style.color='';});el.classList.add('on');if(type==='ايداع'){el.style.background='#064e3b';el.style.borderColor='#10b981';el.style.color='#4ade80';}else{el.style.background='#450a0a';el.style.borderColor='#ef4444';el.style.color='#f87171';}}

function selSvc(el){selSvcVal=el.dataset.svc;document.querySelectorAll('.svc-btn').forEach(b=>{b.classList.remove('on');b.style.background='';b.style.borderColor='';b.style.color='';});el.classList.add('on');el.style.background='#ef4444';el.style.borderColor='#ef4444';el.style.color='#fff';setTimeout(()=>$('cash-amt').focus(),60);}

function addCash(){const a=n(g('cash-amt'))||0;const item={cashType:selCashType,service:selSvcVal,amount:a,time:ts()};walletTransactionRepo.create(item);clr('cash-amt');$('cash-amt').focus();ref('cash');checkCondNotes('cash',item);}

function loadWallets(){
  const w=Storage.get('mshop_wallets',{});
  walletOrder=w.order||[...DEFAULT_WALLETS];walletLimits=w.limits||{};walletOpening=w.opening||{};
  DEFAULT_WALLETS.forEach(w=>{if(!walletOrder.includes(w))walletOrder.push(w);});
  if(!walletOrder.includes(selSvcVal))selSvcVal=walletOrder[0];
}

function saveWalletsCfg(fromUI){
  if(fromUI){
    const items=document.querySelectorAll('#wallet-manage-list .wm-item');
    walletOrder=[...items].map(el=>el.dataset.name);
    walletLimits={};walletOpening={};
    items.forEach(el=>{
      const name=el.dataset.name;
      const lim=n(el.querySelector('.wm-limit')?.value);
      const op=n(el.querySelector('.wm-open')?.value);
      if(lim)walletLimits[name]=lim;
      if(op)walletOpening[name]=op;
    });
  }
  Storage.save('mshop_wallets',{order:walletOrder,limits:walletLimits,opening:walletOpening});
  renderCashWalletButtons();renderWalletSummary();
  if(fromUI)showToast('✅ تم حفظ إعدادات المحافظ','ok');
}

function getWalletBalance(name){
  let bal=walletOpening[name]||0;
  const dayKeys=Storage.search('mshop_d_');
  dayKeys.forEach(k=>{
    const d=Storage.get(k);if(!d)return;
    (d.cash||[]).forEach(c=>{if(c._rolled||c.service!==name)return;bal+=c.cashType==='ايداع'?c.amount:-c.amount;});
  });
  return bal;
}

function renderCashWalletButtons(){
  const el=document.getElementById('cash-svc-row');if(!el)return;
  el.innerHTML=walletOrder.map(w=>`<button class="svc-btn${w===selSvcVal?' on':''}" data-svc="${esc(w)}" onclick="selSvc(this)" style="${w===selSvcVal?'background:#ef4444;border-color:#ef4444;color:#fff':''}">${esc(w)}</button>`).join('');
}

function renderWalletSummary(){
  const el=document.getElementById('cash-wallet-summary');if(!el)return;
  const totalBal=walletOrder.reduce((t,w)=>t+getWalletBalance(w),0);
  const overLimit=walletOrder.filter(w=>walletLimits[w]&&getWalletBalance(w)>walletLimits[w]).length;
  el.innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:7px">
      <div class="inv-sum-card"><div class="inv-sum-lbl">💰 إجمالي أرصدة المحافظ</div><div class="inv-sum-val" style="color:#4ade80">${mtot(totalBal,'#4ade80')}</div></div>
      <div class="inv-sum-card"><div class="inv-sum-lbl">⚠️ محافظ تجاوزت الحد</div><div class="inv-sum-val" style="color:${overLimit?'#f87171':'#4ade80'}">${overLimit}</div></div>
    </div>
    <div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:2px">
      ${walletOrder.map(w=>{
        const bal=getWalletBalance(w),lim=walletLimits[w]||0,over=lim&&bal>lim,near=lim&&!over&&bal>=lim*0.9;
        const color=over?'#f87171':near?'#f59e0b':(SVC_C[w]||'#94a3b8');
        return `<div style="flex:0 0 auto;background:#0f172a;border:1px solid ${color}40;border-radius:9px;padding:7px 10px;min-width:98px">
          <div style="font-size:9px;color:#64748b;white-space:nowrap">${esc(w)}</div>
          <div style="font-size:12px;font-weight:700;color:${color}">${mtot(bal,color)}</div>
          ${lim?`<div style="font-size:8px;color:#475569">الحد: ${fmt(lim)} ج${over?' ⚠️':''}</div>`:''}
        </div>`;
      }).join('')}
    </div>`;
}

function renderWalletManageList(){
  const el=document.getElementById('wallet-manage-list');if(!el)return;
  el.innerHTML=walletOrder.map((w,i)=>`
    <div class="wm-item" data-name="${esc(w)}" style="background:#0f172a;border-radius:9px;padding:8px;margin-bottom:6px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <span style="flex:1;font-weight:700;font-size:12px;color:#e2e8f0">${esc(w)}</span>
        <button onclick="moveWallet(${i},-1)" style="background:#1e293b;border:1px solid #334155;border-radius:6px;color:#94a3b8;width:26px;height:26px;cursor:pointer" ${i===0?'disabled style="opacity:.3"':''}>↑</button>
        <button onclick="moveWallet(${i},1)" style="background:#1e293b;border:1px solid #334155;border-radius:6px;color:#94a3b8;width:26px;height:26px;cursor:pointer" ${i===walletOrder.length-1?'disabled style="opacity:.3"':''}>↓</button>
      </div>
      <div style="display:flex;gap:6px">
        <div class="field" style="flex:1"><label style="font-size:9px">الرصيد الافتتاحي</label><input class="wm-open" type="number" value="${walletOpening[w]||''}" placeholder="0"></div>
        <div class="field" style="flex:1"><label style="font-size:9px">حد التنبيه</label><input class="wm-limit" type="number" value="${walletLimits[w]||''}" placeholder="بدون حد"></div>
      </div>
    </div>`).join('');
}

function moveWallet(i,dir){
  const j=i+dir;if(j<0||j>=walletOrder.length)return;
  [walletOrder[i],walletOrder[j]]=[walletOrder[j],walletOrder[i]];
  renderWalletManageList();
}
