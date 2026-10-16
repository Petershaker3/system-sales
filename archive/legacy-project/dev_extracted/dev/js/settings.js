// ═══════════════════════════════════════════════════════════
// settings.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function renderSettingsPage(){
  try{renderDriveConnStatus();}catch(e){}
  $('logo-opts').innerHTML=LOGOS_LIST.map(l=>`<div class="logo-opt${cfg.logo===l&&!cfg.logoImg?' on':''}" onclick="pickLogo('${l}')">${l}</div>`).join('');
  $('set-name').value=cfg.name;
  const tsel=$('set-admin-timeout');if(tsel)tsel.value=cfg.adminTimeout||1;
  updateLogoPreviewSetting();populateCatSelect();rCatMgmt();rCatL('a');rCatL('u');rCatL('e');renderTrash();renderFaultTypesSettings();renderRepairPartsSettings();
  // Backup status
  const bs=$('backup-status');if(bs){const lb=Storage.getRaw('mshop_last_backup');bs.innerHTML=lb?`آخر نسخة: <b style="color:#4ade80">${lb}</b>`:`<span style="color:#f87171">لم يتم عمل نسخة احتياطية بعد ⚠️</span>`;}
  const brt=$('backup-reminder-toggle');if(brt)brt.checked=Storage.getRaw('mshop_backup_reminder_dismissed')!=='1';
  const bhl=$('backup-history-list');
  if(bhl){
    const hist=Storage.get('mshop_backup_history_log',[]);
    if(!hist.length){bhl.innerHTML='لا يوجد سجل نسخ احتياطية بعد';}
    else{
      bhl.innerHTML='<b style="color:#94a3b8">آخر 10 نسخ:</b><br>'+hist.map(h=>{
        const icon=h.success?'✅':'❌';
        const enc=h.encrypted?'🔒':'⚠️';
        const kb=((h.sizeBytes||0)/1024).toFixed(1);
        return `${icon} ${h.date} ${h.time} ${enc} (${kb} KB)`;
      }).join('<br>');
    }
  }
  // Tab order list
  try { loadTabOrder(); renderTabOrderList(); } catch(e) {}
}

function pickLogo(l){cfg.logoImg=null;cfg.logo=l;saveCfg();applyId();renderSettingsPage();}

function uploadLogo(inp){const file=inp.files[0];if(!file)return;const r=new FileReader();r.onload=e=>{cfg.logoImg=e.target.result;cfg.logo='';saveCfg();applyId();updateLogoPreviewSetting();};r.readAsDataURL(file);inp.value='';}

function clearLogo(){cfg.logoImg=null;saveCfg();applyId();renderSettingsPage();}

function updateLogoPreviewSetting(){const w=$('logo-img-wrap'),img=$('logo-preview'),btn=$('logo-clear-btn');if(!w)return;if(cfg.logoImg){w.style.display='block';img.src=cfg.logoImg;btn.style.display='inline-block';}else{w.style.display='none';btn.style.display='none';}}

function saveIdentity(){cfg.name=g('set-name')||cfg.name;saveCfg();applyId();showToast('✓ تم الحفظ','ok');}

function saveAdminTimeout(){const v=parseInt($('set-admin-timeout')?.value)||1;cfg.adminTimeout=v;saveCfg();showToast(`✓ سيتم القفل بعد ${v} دقيقة`,'ok');}

function applyId(){
  const small=cfg.logoImg?`<img src="${cfg.logoImg}" style="width:28px;height:28px;object-fit:contain;border-radius:4px">`:cfg.logo;
  const large=cfg.logoImg?`<img src="${cfg.logoImg}" style="width:58px;height:58px;object-fit:contain;border-radius:8px">`:cfg.logo;
  $('lk-logo').innerHTML=large;$('main-logo').innerHTML=small;
  $('lk-name').textContent=$('main-name').textContent=cfg.name;document.title=cfg.name;
}

function rCatMgmt(){const el=$('cat-tags-mgmt');if(!el)return;el.innerHTML=accCats.map((c,i)=>`<div class="cat-tag"><button class="mv" onclick="moveCat(${i},-1)">◀</button>${esc(c)}<button class="mv" onclick="moveCat(${i},1)">▶</button><button onclick="delCatDyn(${i})">×</button></div>`).join('');}

function addCatDyn(){const nm=g('new-cat-inp');if(!nm||accCats.includes(nm))return;accCats.push(nm);saveCats();$('new-cat-inp').value='';}

function delCatDyn(i){if(!confirm(`حذف "${accCats[i]}"؟`))return;accCats.splice(i,1);saveCats();}

function moveCat(i,dir){const j=i+dir;if(j<0||j>=accCats.length)return;[accCats[i],accCats[j]]=[accCats[j],accCats[i]];saveCats();}

function populateCatSelect(){const s=$('ca-cat');if(!s)return;s.innerHTML=accCats.map(c=>`<option value="${esc(c)}">${c}</option>`).join('');}

function renderFaultTypesSettings(){
  const el=$('fault-types-list');if(!el)return;
  el.innerHTML=faultTypes.map(f=>{const nm=f.name;const hidden=f.hidden;return`<div class="item${hidden?' opacity-50':''}"><span class="iname">${esc(nm)}</span><button class="note-act-btn" onclick="toggleFaultType('${f.id}')">${hidden?'تفعيل':'إيقاف'}</button><button class="delbtn" onclick="deleteFaultType('${f.id}')">×</button></div>`;}).join('');
}

function addFaultType(){const nm=g('new-fault-inp');if(!nm)return;faultTypeRepo.create({id:`ft_${generateOperationIdempotencyKey()}`,name:nm,hidden:false});$('new-fault-inp').value='';renderFaultTypesSettings();}

function deleteFaultType(id){faultTypeRepo.delete(id).then(()=>renderFaultTypesSettings());}

function toggleFaultType(id){const f=faultTypes.find(x=>x.id===id);if(f){faultTypeRepo.update(id,{hidden:!f.hidden}).then(()=>renderFaultTypesSettings());}}

function renderRepairPartsSettings(){
  const el=$('repair-parts-list');if(!el)return;
  if(!repairParts.length){el.innerHTML=`<div class="empty">لا توجد قطع مضافة</div>`;return;}
  el.innerHTML=repairParts.map((p,i)=>`<div class="item"><span class="iname">${esc(p.name)}</span><span style="font-size:11px;color:#475569">متوافق: ${esc(p.compatible||'—')}</span><span class="ph-qty-badge" style="background:${p.qty>0?'#052e16':'#450a0a'};color:${p.qty>0?'#4ade80':'#f87171'}">${p.qty}</span><span style="font-size:11px;color:${adminUnlocked?'#fbbf24':'#334155'}">${adminUnlocked?fmt(p.buyPrice)+' ج':'***'}</span><button class="delbtn" onclick="repairPartRepo.delete('${p.id}').then(()=>renderRepairPartsSettings())">×</button></div>`).join('');
}

function addRepairPart(){const nm=g('rp-name');if(!nm)return;repairPartRepo.create({id:'rp_'+Date.now(),name:nm,compatible:g('rp-compat'),qty:parseInt(g('rp-qty'))||1,buyPrice:n(g('rp-buy')),supplier:g('rp-supplier')});clr('rp-name','rp-compat','rp-qty','rp-buy','rp-supplier');renderRepairPartsSettings();}

function runHealthCheck() {
  const issues = [], warnings = [];
  // Check inventory
  inventory.filter(p=>!p.archived).forEach(ph => {
    if (ph.qty < 0) issues.push(`❌ كمية سالبة: ${ph.brand} ${ph.model} (${ph.qty})`);
    if (ph.buyPrice < 0) issues.push(`❌ سعر شراء سالب: ${ph.brand} ${ph.model}`);
    if (!ph.brand || !ph.model) warnings.push(`⚠️ موديل بدون بيانات كاملة: ${ph.id}`);
  });
  // Check for duplicate models
  const modelKeys = inventory.filter(p=>!p.archived).map(p=>`${p.brand}|${p.model}|${p.ram}|${p.storage}`);
  const dupModels = modelKeys.filter((k,i)=>modelKeys.indexOf(k)!==i);
  if (dupModels.length) warnings.push(`⚠️ موديلات مكررة محتملة: ${dupModels.length}`);
  // Check day data for anomalies
  let totalDays = 0, anomalyDays = 0;
  Storage.search('mshop_d_').forEach(k => {
    totalDays++;
    const r = Storage.tryGet(k);
    if (r.corrupt) { issues.push(`❌ بيانات تالفة في: ${k}`); return; }
    (r.value?.acc||[]).forEach(x => { if (x.profit < 0) anomalyDays++; });
  });
  const el = document.getElementById('health-result'); if (!el) return;
  if (!issues.length && !warnings.length) {
    el.innerHTML = `<div style="color:#4ade80;font-size:13px;padding:10px;background:#052e16;border-radius:9px;text-align:center">✅ البيانات سليمة — ${totalDays} يوم مسجّل، ${inventory.filter(p=>!p.archived).length} موديل نشط</div>`;
  } else {
    el.innerHTML = `<div style="background:#0a0f1e;border-radius:9px;padding:10px">
      ${issues.map(i=>`<div style="color:#f87171;font-size:11px;padding:3px 0">${i}</div>`).join('')}
      ${warnings.map(w=>`<div style="color:#fbbf24;font-size:11px;padding:3px 0">${w}</div>`).join('')}
    </div>`;
  }
}
