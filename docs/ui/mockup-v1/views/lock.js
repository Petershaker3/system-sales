'use strict';
// شاشة «شاشة القفل». الكود متقسم ملف لكل شاشة — الترتيب في index.html، والدليل: docs/ENGINEERING.md
/* ===== شاشة القفل: اختيار المستخدم ثم PIN من 4 أرقام ===== */
function viewLock() {
  const u = S.lockUser;
  const body = !u
    ? `<div class="muted">مين هيشتغل دلوقتي؟</div>
       <div class="users">${DATA.users.map((x) => `<button type="button" class="user-card" data-act="lockPick" data-id="${x.id}">${avatar(x, 'lg')}<b>${esc(x.name)}</b><small>${roleName(x)}</small></button>`).join('')}</div>`
    : `<div class="row" style="justify-content:center;margin-top:12px">${avatar(u, 'lg')}</div>
       <div style="margin-top:6px"><b>${esc(u.name)}</b> <span class="muted">· ${roleName(u)}</span></div>
       <div class="pin-dots">${[0, 1, 2, 3].map((i) => `<i class="${i < S.pin.length ? 'on' : ''}"></i>`).join('')}</div>
       <div class="err-msg">${esc(S.pinErr)}</div>
       <div class="numpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-act="pinKey" data-k="${n}">${num(n)}</button>`).join('')}
         <button type="button" data-act="lockBack" title="رجوع (Esc)">${icon('arrow-right')}</button>
         <button type="button" data-act="pinKey" data-k="0">${num(0)}</button>
         <button type="button" data-act="pinKey" data-k="del" title="مسح">${icon('delete')}</button></div>`;
  return `<div class="lock"><div class="lock-card ${S.pinErr ? 'shake' : ''}">
    ${logoHTML()}<h1>${esc(SET.shopName)}</h1>${body}
    <div class="demo-hint">للتجربة بس: ${DATA.users.map((x) => `${esc(x.name)} <bdi dir="ltr" class="mono">${x.pin}</bdi>`).join('، ')}</div>
  </div></div>`;
}
function digitFromKey(e) {
  if (/^Digit[0-9]$/.test(e.code)) return +e.code.slice(5);
  if (/^Numpad[0-9]$/.test(e.code)) return +e.code.slice(6);
  const t = toLatin(e.key);
  return /^[0-9]$/.test(t) ? +t : null;
}
function lockKey(e) {
  const d = digitFromKey(e);
  if (!S.lockUser) { if (d && d <= DATA.users.length) { e.preventDefault(); S.lockUser = DATA.users[d - 1]; render(); } return; }
  if (d !== null) { e.preventDefault(); pinPress(String(d)); return; }
  if (e.key === 'Backspace') { e.preventDefault(); pinPress('del'); return; }
  if (e.key === 'Escape') { S.lockUser = null; S.pin = ''; S.pinErr = ''; render(); }
}
function pinPress(k) {
  if (!S.lockUser) return;
  if (k === 'del') { S.pin = S.pin.slice(0, -1); S.pinErr = ''; render(); return; }
  if (S.pin.length >= 4) return;
  S.pin += k; S.pinErr = '';
  if (S.pin.length === 4) {
    if (S.pin === S.lockUser.pin) { unlockAs(S.lockUser); return; }
    S.pinErr = 'الـ PIN غلط. جرّب تاني'; S.pin = ''; beep();
  }
  render();
}
function unlockAs(u) {
  Object.assign(S, { user: u, locked: false, lockUser: null, pin: '', pinErr: '' });
  const n = NAV.find((x) => x.id === S.view);
  if (n && n.owner && u.role !== 'owner') S.view = 'pos';
  render(); focusSearch(); toast(`أهلاً يا ${u.name}`);
}
Object.assign(ACT, {
  lockPick: (d) => { S.lockUser = DATA.users.find((u) => u.id === d.id); S.pin = ''; S.pinErr = ''; render(); },
  pinKey: (d) => pinPress(d.k),
  lockBack: () => { S.lockUser = null; S.pin = ''; S.pinErr = ''; render(); },
});
