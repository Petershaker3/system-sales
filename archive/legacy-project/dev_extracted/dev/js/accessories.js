// ═══════════════════════════════════════════════════════════
// accessories.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function addCA(){const nm=g('ca-n');if(!nm)return;catA.push({name:nm,mainCat:g('ca-cat')||'أخري',buy:n(g('ca-b')),sell:n(g('ca-s'))});saveCA();clr('ca-n','ca-b','ca-s');}

function delCA(i){catA.splice(i,1);saveCA();}

function qsAcc(i){const it=catA[i];$('acc-n').value=it.name;$('acc-b').value=it.buy||'';$('acc-s').value=it.sell||'';setTimeout(()=>$('acc-s').focus(),60);}

function rCatQ(type){const el=$('cat-q-'+type);if(!el)return;if(!catU.length){el.innerHTML='';return;}let h=`<div class="cat-quick"><div class="cqlbl"><span>⚡ كتالوج</span><a onclick="goSettings()">إدارة ›</a></div><div class="chips">`;catU.forEach((it,i)=>h+=`<div class="chip" onclick="qsUsed(${i})"><div>${esc(it.name)}</div><div class="chip-sub">بيع: ${fmt(it.sell)} ج</div></div>`);el.innerHTML=h+'</div></div>';}

function rAccCats(){
  const el=$('acc-main-cats');if(!el)return;
  let h=`<div class="cat-quick"><div class="cqlbl"><span>⚡ الفئات</span><a onclick="goSettings()">إدارة ›</a></div><div class="chips">`;
  accCats.forEach(cat=>{const cnt=catA.filter(i=>i.mainCat===cat).length;h+=`<div class="chip${actCat===cat?' on':''}" onclick="toggleCat('${cat.replace(/'/g,"\\'")}')">${esc(cat)}${cnt?`<span style="font-size:9px;opacity:.6;margin-right:2px">${cnt}</span>`:''}</div>`;});
  el.innerHTML=h+'</div></div>';rSubArea();
}

function toggleCat(cat){actCat=(actCat===cat)?null:cat;addSubMode=false;rAccCats();}

function rSubArea(){
  const el=$('acc-sub-area');if(!el)return;if(!actCat){el.innerHTML='';return;}
  const items=catA.filter(i=>i.mainCat===actCat);
  let h=`<div class="sub-area"><div style="font-size:11px;color:#3b82f6;font-weight:700;margin-bottom:7px">${esc(actCat)}</div><div class="chips">`;
  items.forEach(it=>{const idx=catA.indexOf(it);h+=`<div class="chip" onclick="qsAcc(${idx})"><div>${esc(it.name)}</div><div class="chip-sub">بيع: ${fmt(it.sell)} ج</div></div>`;});
  h+=`<div class="chip chip-add" onclick="toggleAddSub()">+ للكتالوج</div></div>`;
  if(addSubMode)h+=`<div class="sub-mini-form"><div style="font-size:10px;color:#64748b;margin-bottom:6px">إضافة في "${esc(actCat)}"</div><div class="frow"><div class="field"><label>الاسم</label><input id="sub-n" placeholder="${esc(actCat)}..."></div><div class="field fw"><label>شراء</label><input id="sub-b" type="number" placeholder="0"></div><div class="field fw"><label>بيع</label><input id="sub-s" type="number" placeholder="0"></div><button class="abtn" style="background:#3b82f6" onclick="addSubcat()">+ حفظ</button></div></div>`;
  el.innerHTML=h+'</div>';if(addSubMode)setTimeout(()=>{const e=$('sub-n');if(e)e.focus();},60);
}

function toggleAddSub(){addSubMode=!addSubMode;rSubArea();}

function addSubcat(){const nm=g('sub-n');if(!nm)return;catA.push({name:nm,mainCat:actCat,buy:n(g('sub-b')),sell:n(g('sub-s'))});saveCA();addSubMode=false;clr('sub-n','sub-b','sub-s');}

function addAcc(){const nm=g('acc-n'),b=n(g('acc-b')),s=n(g('acc-s')),qRaw=g('acc-q'),qty=qRaw?parseInt(qRaw)||null:null;if(!nm||!s)return;const item={name:nm,mainCat:actCat||'أخري',buy:b,sell:s,profit:s-b,time:ts()};if(qty)item.qty=qty;accessoryTransactionRepo.create(item);clr('acc-n','acc-b','acc-s','acc-q');$('acc-n').focus();ref('acc');checkCondNotes('acc',item);}
