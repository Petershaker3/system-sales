// ═══════════════════════════════════════════════════════════
// notifications.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function markAllNotifsRead(){notifs.forEach(n=>n.read=true);saveNotifs();renderNotifs();}

function setNotifFilter(f,el){notifFilter=f;document.querySelectorAll('[id^="nof-"]').forEach(b=>{b.classList.remove('on');b.style.background='';b.style.color='';});if(el){el.classList.add('on');el.style.background='#3b82f6';el.style.color='#fff';}renderNotifs();}

function renderNotifs(){
  const el=$('notifs-list');if(!el)return;
  let filtered=notifs.filter(n=>{if(notifFilter==='unread'&&n.read)return false;if(notifFilter!=='all'&&notifFilter!=='unread'&&n.type!==notifFilter)return false;return true;});
  if(!filtered.length){el.innerHTML=`<div class="empty">لا توجد إشعارات</div>`;return;}
  const typeIcon={reminder:'⏰',conditional:'⚡',system:'🔔',inventory:'📦',repair:'🔧'};
  el.innerHTML=filtered.map(ntf=>`<div class="notif-card${ntf.read?'':' unread'}"><div class="notif-card-hdr"><span class="notif-icon">${typeIcon[ntf.type]||'🔔'}</span><span class="notif-title">${esc(ntf.title)}</span>${!ntf.read?'<span class="unread-dot"></span>':''}<span class="notif-time">${(ntf.created||'').slice(0,16)}</span></div><div class="notif-body">${esc(ntf.body||'')}</div>${ntf.matchInfo?`<div style="font-size:10px;color:#60a5fa;margin-bottom:4px">📦 ${esc(ntf.matchInfo)}</div>`:''}<div style="display:flex;gap:5px">${!ntf.read?`<button class="note-act-btn" onclick="notifs[${notifs.indexOf(ntf)}].read=true;saveNotifs();renderNotifs()">✓ مقروء</button>`:''}<button class="note-act-btn" style="color:#f87171" onclick="notifs.splice(${notifs.indexOf(ntf)},1);saveNotifs();renderNotifs()">حذف</button></div></div>`).join('');
}

function showNotifPopup(notif,extra={}){
  currentNotifPopup={notif,extra};
  const ei=$('np-icon'),et=$('np-title'),eb=$('np-body'),etime=$('np-time'),em=$('np-match');
  if(!et)return;
  if(ei)ei.textContent=notif.type==='reminder'?'⏰':notif.type==='conditional'?'⚡':notif.type==='repair'?'🔧':'🔔';
  et.textContent=notif.title||'إشعار جديد';
  if(eb)eb.textContent=notif.body||'';
  if(etime)etime.textContent=(notif.created||'').slice(0,16)||ts();
  if(em){if(extra.matchDisplay){em.style.display='block';em.textContent='📦 '+extra.matchDisplay;}else em.style.display='none';}
  const m=$('modal-np');if(m)m.style.display='flex';
}

async function npAction(action){
  if(action==='done'&&currentNotifPopup?.notif?.noteId){const nt=notes.find(x=>x.id===currentNotifPopup.notif.noteId);if(nt){await noteRepo.update(nt.id,{done:true,doneDate:td()+' '+ts()});}}
  if(action==='snooze'&&currentNotifPopup?.notif?.noteId){const nt=notes.find(x=>x.id===currentNotifPopup.notif.noteId);if(nt&&nt.type==='reminder'){const d=new Date();d.setHours(d.getHours()+1);await noteRepo.update(nt.id,{dueDate:d.toISOString().split('T')[0],dueTime:d.toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'})});}}
  const m=$('modal-np');if(m)m.style.display='none';currentNotifPopup=null;
}

function checkReminders(){
  const now=new Date(),nowStr=now.toISOString().slice(0,16).replace('T',' ');
  notes.filter(nt=>nt.type==='reminder'&&!nt.done&&nt.dueDate).forEach(nt=>{
    const dueStr=(nt.dueDate+(nt.dueTime?' '+nt.dueTime:''));
    if(dueStr<=nowStr){const existing=notifs.find(n=>n.noteId===nt.id&&n.type==='reminder'&&!n.read);if(!existing){const notif={id:Date.now(),type:'reminder',title:nt.title,body:nt.content||'موعد التذكير حل',noteId:nt.id,created:new Date().toISOString(),read:false};notifs.unshift(notif);saveNotifs();showNotifPopup(notif);}}
  });
}

function checkInvNotifications(){
  const stagnantDays = parseInt(Storage.getRaw('mshop_stagnant_days')||'30');
  inventory.forEach(ph=>{
    if(ph.archived) return;
    if(ph.qty===0){const ex=notifs.find(n=>n.noteId==='inv_'+ph.id+'_out'&&!n.read);if(!ex){const notif={id:Date.now(),type:'inventory',title:'نفاد المخزون',body:`${ph.brand} ${ph.model} — نفذ من المخزون`,noteId:'inv_'+ph.id+'_out',created:new Date().toISOString(),read:false};notifs.unshift(notif);saveNotifs();}}
    else if(ph.qty<=2){const days=getDaysToStockout(ph);if(days!==null&&days<=5){const ex=notifs.find(n=>n.noteId==='inv_'+ph.id+'_low'&&!n.read);if(!ex){const notif={id:Date.now(),type:'inventory',title:'تحذير نفاد قريب',body:`${ph.brand} ${ph.model} — متبقي ${ph.qty} قطعة، نفاد ~${days} أيام`,noteId:'inv_'+ph.id+'_low',created:new Date().toISOString(),read:false};notifs.unshift(notif);saveNotifs();}}}
    // Stagnant alert
    const mv=getMovement(ph.id);
    if(mv.score===0&&ph.qty>0){
      const lastSales=getPhoneSales(ph.id,365);
      const lastSaleDate=lastSales[0]?.date||ph.lastBuyDate||'';
      if(lastSaleDate){const daysSince=Math.round((new Date()-new Date(lastSaleDate+'T12:00:00'))/86400000);
        if(daysSince>=stagnantDays){const ex=notifs.find(n=>n.noteId==='inv_'+ph.id+'_stag'&&!n.read);if(!ex){const notif={id:Date.now(),type:'inventory',title:'موديل راكد 💤',body:`${ph.brand} ${ph.model} — لم يُباع منذ ${daysSince} يومًا (${ph.qty} قطعة بالمخزون)`,noteId:'inv_'+ph.id+'_stag',created:new Date().toISOString(),read:false};notifs.unshift(notif);saveNotifs();}}}
    }
  });updateBadges();
}

function checkRepairNotifications(){
  const all=getAllRepairs();
  const now=new Date();
  all.filter(r=>r.status==='inProgress').forEach(r=>{
    const addDate=new Date(r._date+'T12:00:00');const diffDays=Math.round((now-addDate)/86400000);
    if(diffDays>=3){const ex=notifs.find(n=>n.noteId==='rep_'+r.id+'_delay'&&!n.read);if(!ex){const notif={id:Date.now(),type:'repair',title:'تأخر إصلاح',body:`${r.brand} ${r.model} — جاري الإصلاح منذ ${diffDays} أيام`,noteId:'rep_'+r.id+'_delay',matchInfo:r.clientName?'العميل: '+r.clientName:'',created:new Date().toISOString(),read:false};notifs.unshift(notif);saveNotifs();}}
  });updateBadges();
}
