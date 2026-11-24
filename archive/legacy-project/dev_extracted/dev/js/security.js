// ═══════════════════════════════════════════════════════════
// security.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function tryUnlock(){
  try{
    const p=g('pin-inp');
    if(p===cfg.passMain){
      $('pin-inp').value='';$('pin-err').textContent='';
      showScreen('S-main');
      try{renderRatingAndInsights();}catch(e){console.error('rating',e);}
      try{updateBadges();}catch(e){console.error('badges',e);}
      try{checkReminders();}catch(e){console.error('reminders',e);}
      try{checkInvNotifications();}catch(e){console.error('inv',e);}
      try{setTimeout(()=>checkBackupReminder(),1500);}catch(e){}
    }else{
      $('pin-err').textContent='باسورد غلط!';$('pin-inp').value='';$('pin-inp').focus();
    }
  }catch(e){console.error('unlock error',e);showScreen('S-main');}
}

function lockApp(){
  showProfits=false;adminUnlocked=false;clearTimeout(adminLockTimer);
  renderAll();showScreen('S-lock');setTimeout(()=>$('pin-inp').focus(),100);
}

function requireAdmin(cb){
  if(adminUnlocked){extendAdminSession();if(cb)cb();return;}
  pendingAdminCb=cb;
  $('modal-admin').style.display='flex';$('admin-pin').value='';$('admin-err').textContent='';
  setTimeout(()=>$('admin-pin').focus(),100);
}

function confirmAdmin(){
  if(g('admin-pin')===cfg.passAdmin){
    closeAdmin();adminUnlocked=true;showProfits=true;extendAdminSession();
    if(pendingAdminCb){pendingAdminCb();pendingAdminCb=null;}
    // Re-render current screen to replace ••• with actual values
    try{ if(_lastRender) _lastRender(); else renderAll(); }catch(e){}
  }else{$('admin-err').textContent='باسورد الإدارة غلط!';$('admin-pin').value='';$('admin-pin').focus();}
}

function closeAdmin(){$('modal-admin').style.display='none';pendingAdminCb=null;}

function extendAdminSession(){
  if(!adminUnlocked)return;
  clearTimeout(adminLockTimer);
  const mins=parseInt(cfg.adminTimeout||1);
  adminLockTimer=setTimeout(()=>{
    adminUnlocked=false;showProfits=false;
    try{revealedSales?.clear();}catch(e){}
    try{ if(_lastRender) _lastRender(); else renderAll(); }catch(e){ renderAll(); }
    showToast('🔐 تم قفل بيانات الأرباح تلقائياً');
  },mins*60*1000);
}

function changePass(type){
  const sfx=type==='main'?'m':'a',prop=type==='main'?'passMain':'passAdmin';
  const o=g(`set-old-${sfx}`),nw=g(`set-new-${sfx}`),cf2=g(`set-cf-${sfx}`),m=$(`set-pass-msg-${sfx}`);
  if(!m)return;
  if(o!==cfg[prop]){m.style.color='#f87171';m.textContent='الباسورد الحالي غلط';return;}
  if(!nw){m.style.color='#f87171';m.textContent='أدخل الباسورد الجديد';return;}
  if(nw!==cf2){m.style.color='#f87171';m.textContent='الباسورد غير متطابق';return;}
  cfg[prop]=nw;saveCfg();clr(`set-old-${sfx}`,`set-new-${sfx}`,`set-cf-${sfx}`);
  m.style.color='#4ade80';m.textContent='✓ تم التغيير';setTimeout(()=>m.textContent='',2500);
}

function mp(v){
  if(showProfits) return `<span class="imoney ${n(v)>=0?'g':'r'}">${fmt(v)} ج</span>`;
  return `<span class="imoney h" style="cursor:pointer;letter-spacing:1px" onclick="requireAdmin(_lastRender||renderAll)" title="اضغط لإظهار الأرباح">•••</span>`;
}

function mfmt(v){
  if(showProfits) return `<span style="color:${n(v)>=0?'#4ade80':'#f87171'}">${fmt(v)} ج</span>`;
  return `<span style="cursor:pointer;color:#334155;letter-spacing:1px;user-select:none" onclick="requireAdmin(_lastRender||renderAll)" title="اضغط لإظهار الأرباح">•••</span>`;
}

function mtot(v,color){
  if(showProfits) return `<span style="color:${color}">${fmt(v)} ج</span>`;
  return `<span style="color:#334155;letter-spacing:1px;cursor:pointer" onclick="requireAdmin(_lastRender||renderAll)" title="اضغط لإظهار القيمة">••••</span>`;
}
