// ═══════════════════════════════════════════════════════════
// calculator.js — تم توليده تلقائيًا أثناء إعادة التنظيم (Phase 1 Refactor)
// كل الدوال هنا منقولة حرفيًا بدون أي تغيير في المنطق أو السلوك
// ═══════════════════════════════════════════════════════════

function toggleCalc(){calcVis=!calcVis;const m=$('modal-calc');if(m)m.style.display=calcVis?'flex':'none';if(calcVis)resetCalc();}

function resetCalc(){CS={expr:'',cur:'0',op:null,prev:null,nn:true};rCalc();}

function rCalc(){const ce=$('calc-expr'),cr=$('calc-res');if(ce)ce.textContent=CS.expr;if(cr)cr.textContent=CS.cur;}

function apOp(a,b,op){switch(op){case'+':return a+b;case'−':return a-b;case'×':return a*b;case'÷':return b?a/b:0;}return b;}

function CI(k){
  let{expr,cur,op,prev,nn}=CS;
  if(k==='C'){resetCalc();return;}if(k==='⌫'){cur=cur.length>1?cur.slice(0,-1):'0';CS.cur=cur;rCalc();return;}if(k==='±'){CS.cur=String(-parseFloat(cur)||0);rCalc();return;}if(k==='%'){CS.cur=String(parseFloat(cur)/100);rCalc();return;}
  if(['÷','×','−','+'].includes(k)){if(op&&!nn){const r=apOp(parseFloat(prev),parseFloat(cur),op);cur=String(Math.round(r*1e10)/1e10);}prev=cur;op=k;nn=true;expr=cur+' '+k;CS={expr,cur,op,prev,nn};rCalc();return;}
  if(k==='.'){if(nn){cur='0.';nn=false;}else if(!cur.includes('.'))cur+='.';CS={expr,cur,op,prev,nn:false};rCalc();return;}
  if(k==='='){if(op){const r=apOp(parseFloat(prev),parseFloat(cur),op);const exS=prev+' '+op+' '+cur+' =';const res=String(Math.round(r*1e10)/1e10);calcHist.unshift({id:Date.now(),expr:exS,result:res,date:td(),time:ts()});if(calcHist.length>100)calcHist=calcHist.slice(0,100);saveCalcHist();if(calcHistVis)rCalcHist();expr=exS;cur=res;op=null;prev=null;nn=true;}CS={expr,cur,op,prev,nn:true};rCalc();return;}
  if(nn){cur=k;nn=false;}else{cur=cur==='0'?k:cur+k;}CS={expr,cur,op,prev,nn:false};rCalc();
}

function toggleCalcHist(){calcHistVis=!calcHistVis;const p=$('hist-panel');if(p){p.style.display=calcHistVis?'block':'none';if(calcHistVis)rCalcHist();}}

function rCalcHist(){const p=$('hist-panel');if(!p)return;if(!calcHist.length){p.innerHTML=`<div style="text-align:center;color:#334155;font-size:11px;padding:10px">السجل فارغ</div>`;return;}p.innerHTML=`<div style="display:flex;justify-content:flex-end;margin-bottom:6px"><button onclick="calcHist=[];saveCalcHist();rCalcHist()" style="background:none;border:1px solid #334155;border-radius:6px;color:#64748b;padding:3px 9px;font-family:inherit;font-size:10px;cursor:pointer">مسح الكل</button></div>`+calcHist.map((h,i)=>`<div class="hist-item"><div class="hist-expr">${esc(h.expr)}</div><div class="hist-res">${esc(h.result)}</div><div class="hist-time">${h.time}</div><button onclick="try{navigator.clipboard.writeText('${h.result}');}catch{}" style="background:none;border:none;color:#334155;cursor:pointer;font-size:11px;padding:0 2px">📋</button><button class="delbtn" onclick="calcHist.splice(${i},1);saveCalcHist();rCalcHist()" style="font-size:14px">×</button></div>`).join('');}
