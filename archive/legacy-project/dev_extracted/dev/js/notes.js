// ═══════════════════════════════════════════════════════════
// notes.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function openAddNote(editId=null){
  editingNoteId=editId;
  const modal=$('modal-add-note');if(!modal)return;
  if(editId){const nt=notes.find(x=>x.id===editId);if(!nt)return;$('an-title').value=nt.title||'';$('an-body').value=nt.content||'';$('an-pri').value=nt.priority||2;selectNoteType(nt.type,null);if(nt.type==='reminder'){$('an-date').value=nt.dueDate||'';$('an-time').value=nt.dueTime||'';}if(nt.type==='conditional'){const cd=nt.conditionData||{};$('an-cond-sec-val').value=cd.section||'';$('an-cond-min').value=cd.minPrice||'';$('an-cond-max').value=cd.maxPrice||'';$('an-cond-kw').value=cd.keyword||'';}}
  else{clr('an-title','an-body','an-date','an-time','an-cond-min','an-cond-max','an-cond-kw');$('an-pri').value=2;selectNoteType('note',null);}
  $('an-err').textContent='';modal.style.display='flex';setTimeout(()=>$('an-title').focus(),100);
}

function closeAddNote(){const m=$('modal-add-note');if(m)m.style.display='none';editingNoteId=null;}

function selectNoteType(type,el){
  noteTypeAdding=type;
  document.querySelectorAll('.nts').forEach(b=>{b.classList.remove('on');b.style.background='';b.style.color='';});
  if(el){el.classList.add('on');el.style.background=NOTE_TYPE_COLORS[type];el.style.color='#fff';}
  else{document.querySelectorAll('.nts').forEach(b=>{if(b.textContent.includes(type==='note'?'عادية':type==='reminder'?'تذكير':'شرطية')){b.classList.add('on');b.style.background=NOTE_TYPE_COLORS[type];b.style.color='#fff';}});}
  const rs=$('an-reminder-sec'),cs=$('an-cond-sec');
  if(rs)rs.style.display=type==='reminder'?'block':'none';
  if(cs)cs.style.display=type==='conditional'?'block':'none';
}

async function saveNote(){
  const title=g('an-title'),body=g('an-body'),pri=n($('an-pri').value)||2;
  if(!title){$('an-err').textContent='أدخل عنوان الملاحظة';return;}
  const nt={id:editingNoteId||Date.now(),title,content:body,type:noteTypeAdding,priority:pri,created:td(),createdTime:ts(),done:false,doneDate:null};
  if(noteTypeAdding==='reminder'){nt.dueDate=$('an-date').value||null;nt.dueTime=$('an-time').value||null;}
  if(noteTypeAdding==='conditional'){nt.conditionData={section:g('an-cond-sec-val'),minPrice:n(g('an-cond-min'))||null,maxPrice:n(g('an-cond-max'))||null,keyword:g('an-cond-kw')||null};}
  if(editingNoteId){await noteRepo.update(editingNoteId, nt);}
  else await noteRepo.create(nt);
  closeAddNote();renderNotes();
}

async function toggleNotesDone(id){const nt=notes.find(x=>x.id===id);if(!nt)return;const newDone=!nt.done;const newDoneDate=newDone?td()+' '+ts():null;await noteRepo.update(id,{done:newDone,doneDate:newDoneDate});renderNotes();}

async function deleteNote(id){await noteRepo.delete(id);renderNotes();}

function setNoteFilter(f,el){noteFilter=f;document.querySelectorAll('.note-type-btn').forEach(b=>{b.classList.remove('on');b.style.background='';b.style.color='';});if(el){el.classList.add('on');el.style.background='#3b82f6';el.style.color='#fff';}renderNotes();}

function renderNotes(){
  const el=$('notes-list');if(!el)return;
  const q=($('notes-search')?.value||'').toLowerCase();
  let filtered=notes.filter(nt=>{
    if(noteFilter==='done'&&!nt.done)return false;
    if(noteFilter!=='all'&&noteFilter!=='done'&&nt.type!==noteFilter)return false;
    if(noteFilter!=='done'&&nt.done)return false;
    if(q&&!nt.title.toLowerCase().includes(q)&&!(nt.content||'').toLowerCase().includes(q))return false;
    return true;
  });
  filtered.sort((a,b)=>b.priority-a.priority||(b.created||'').localeCompare(a.created||''));
  if(!filtered.length){el.innerHTML=`<div class="empty">لا توجد ملاحظات</div>`;return;}
  const now=td();
  el.innerHTML=filtered.map(nt=>{
    const isOverdue=nt.type==='reminder'&&nt.dueDate&&nt.dueDate<now&&!nt.done;
    let meta='';
    if(nt.type==='reminder'&&nt.dueDate)meta=`<span class="note-due">⏰ ${nt.dueDate}${nt.dueTime?' '+nt.dueTime:''}${isOverdue?' ⚠️':''}</span>`;
    if(nt.type==='conditional'){const cd=nt.conditionData||{};const parts=[];if(cd.section)parts.push({acc:'اكسسوار',used:'مستعمل',cash:'كاش',sw:'سوفت وير',phones:'هواتف جديدة',repairs:'صيانة'}[cd.section]||cd.section);if(cd.minPrice)parts.push('من '+fmt(cd.minPrice)+' ج');if(cd.maxPrice)parts.push('حتى '+fmt(cd.maxPrice)+' ج');if(cd.keyword)parts.push('"'+cd.keyword+'"');meta=`<span class="note-cond">⚡ ${parts.join(' · ')||'أي عنصر'}</span>`;}
    return`<div class="note-card${nt.done?' done':''} pri-${nt.priority}${isOverdue?' overdue-note':''}"><div style="display:flex;align-items:flex-start;gap:8px"><input type="checkbox" ${nt.done?'checked':''} style="margin-top:2px;flex-shrink:0" onchange="toggleNotesDone(${nt.id})"><div style="flex:1"><div class="note-title">${esc(nt.title)}</div>${nt.content?`<div class="note-body">${esc(nt.content)}</div>`:''}<div class="note-meta"><span class="note-type-badge" style="background:${NOTE_TYPE_COLORS[nt.type]}20;color:${NOTE_TYPE_COLORS[nt.type]}">${NOTE_TYPE_LABELS[nt.type]}</span><span class="ibadge" style="background:#1e293b;color:${['','#475569','#3b82f6','#ef4444'][nt.priority]}">${PRI_ICONS[nt.priority]}</span>${meta}<span class="note-date">${nt.created} ${nt.createdTime||''}</span></div><div class="note-actions"><button class="note-act-btn" onclick="openAddNote(${nt.id})">✏️ تعديل</button><button class="note-act-btn" style="color:#f87171" onclick="deleteNote(${nt.id})">🗑 حذف</button></div></div></div></div>`;
  }).join('');
}
