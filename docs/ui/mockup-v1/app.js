'use strict';
/* ===== أدوات صغيرة ===== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function icon(name, cls = '') {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
const toLatin = (s) => String(s ?? '').replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 1776);
const parseNum = (s) => { const t = toLatin(s).replace(/[,\s٬]/g, '').replace('٫', '.'); return t === '' ? NaN : Number(t); };

/* ===== الإعدادات (بتتحفظ في المتصفح) ===== */
const SETTINGS_KEY = 'mshop.mockup.settings.v1';
const DEFAULTS = {
  shopName: 'موبايل ستور', phone: '01000000000', address: '12 شارع شبرا، القاهرة', logo: '',
  // الطابع: «plate» = لافتة الشارع · «box» = علبة الموبايل (docs/ui/REDESIGN.md). الخط «auto» = خط الطابع
  theme: 'light', look: 'plate', accent: '#1d4f91', font: 'auto', scale: 'normal', digits: 'latin',
  paper: '80', footer: 'شكرًا لزيارتكم · الاستبدال خلال 14 يوم بالفاتورة والعلبة', showQR: true, receiptMode: 'wa',
  waTemplate: 'أهلاً {الاسم}، دي فاتورتك رقم {رقم} من {المحل}. الضمان لحد {تاريخ_الضمان}.',
  warrantyNew: 12, warrantyUsed: 1, feePct: 1, feeMin: 5, billFee: 5, discountLimit: 5,
  // العمولة: «manual» = البيّاع بيكتبها في كل عملية لأنها مش ثابتة · «auto» = بتتحسب من النسبة والحد الأدنى وتفضل قابلة للتعديل
  feeMode: 'manual',
  // الطابعة: مفيش دلوقتي — الإيصال واتساب بس. لما تتفعّل من الإعدادات ← الأجهزة بترجع «طباعة» و«الاتنين» في شاشة الدفع
  printer: false,
  perms: { seeCost: false, refunds: false, closeShift: true, reports: false, editPrices: false },
  methods: { cash: true, vf: true, instapay: true, card: true, install: true, credit: true },
  // الـ IMEI: «optional» = الموبايل بيتضاف على طول وتسجّل الـ IMEI لو حبيت · «required» = لازم تختار الجهاز بالـ IMEI
  imeiMode: 'optional',
  // صور الأصناف (اختياري): بتظهر في مربعات البيع والبحث وتطبيق الموبايل بدل الأيقونة
  showImages: true,
  // التصنيفات (الترتيب = ترتيب الظهور). بتتعدّل من الإعدادات ← الأصناف والبيع
  cats: DATA.categories.map((c) => ({ id: c.id, name: c.name, icon: c.icon, parent: c.parent || null, hidden: false })),
};
// ألوان جاهزة، و«لون تاني» بيقبل أي لون — الكلام عليه بيتظبط تلقائي
const ACCENTS = ['#1d4f91', '#0f6e5a', '#b3261e', '#0e6170', '#6b2f73', '#a86b00', '#2f3437'];
const LOOKS = ['plate', 'box'], FONT_IDS = ['auto', 'plex', 'cairo', 'tajawal', 'readex'];
function mergeCats(saved) {
  if (!Array.isArray(saved)) return DEFAULTS.cats.map((c) => ({ ...c }));
  const ok = saved.filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string' && c.name.trim());
  const ids = new Set(ok.map((c) => c.id));
  const out = ok.filter((c) => !c.parent || ids.has(c.parent)).map((c) => ({ id: c.id, name: c.name, icon: c.icon || 'tag', parent: c.parent || null, hidden: !!c.hidden, custom: !!c.custom }));
  for (const c of DEFAULTS.cats) if (!ids.has(c.id)) out.push({ ...c });
  return out;
}
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch { saved = {}; }
  // إعدادات من قبل الطابعين: اللون والخط الافتراضيين القدام بيتغيروا للجداد — اللي المالك اختاره بنفسه بيفضل
  if (!('look' in saved)) {
    if (saved.font === 'plex') delete saved.font;
    if (String(saved.accent || '').toLowerCase() === '#2563eb') delete saved.accent;
  }
  return {
    ...DEFAULTS, ...saved,
    perms: { ...DEFAULTS.perms, ...(saved.perms || {}) }, methods: { ...DEFAULTS.methods, ...(saved.methods || {}) },
    imeiMode: saved.imeiMode === 'required' ? 'required' : 'optional', cats: mergeCats(saved.cats),
    feeMode: saved.feeMode === 'auto' ? 'auto' : 'manual', printer: saved.printer === true,
    look: LOOKS.includes(saved.look) ? saved.look : DEFAULTS.look, font: FONT_IDS.includes(saved.font) ? saved.font : DEFAULTS.font,
  };
}
let SET = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SET)); return true; } catch { toast('مساحة التخزين مش كفاية — جرّب لوجو أصغر', 'err'); return false; }
}
/* ===== الإيصال: واتساب بس دلوقتي — الطباعة بترجع لما تتفعّل الطابعة من الإعدادات ===== */
const hasPrinter = () => SET.printer === true;
const receiptOpts = () => (hasPrinter() ? [['print', 'طباعة'], ['wa', 'واتساب'], ['both', 'الاتنين'], ['none', 'بدون']] : [['wa', 'واتساب'], ['none', 'بدون']]);
// الوضع المحفوظ بعد ما نشيل الطباعة لو مفيش طابعة (إعداد قديم «طباعة» = واتساب)
function receiptSetting() { const m = SET.receiptMode; return hasPrinter() ? m : (m === 'none' ? 'none' : 'wa'); }
// المتعلّم في شاشة الدفع: واتساب لو الفاتورة على عميل برقمه — من غير عميل: «بدون» (أو «طباعة» لو فيه طابعة)، والبيّاع يقدر يختار واتساب ويكتب الرقم
function defaultReceipt(inv) { const m = receiptSetting(); return (m === 'wa' || m === 'both') && !(inv.customer && inv.customer.phone) ? (hasPrinter() ? 'print' : 'none') : m; }
const curTheme = () => (SET.theme === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : SET.theme);
/* ===== لون المحل ← ألوان الواجهة =====
   أي لون يختاره المالك: الكلام اللي عليه أو بلونه لازم يعدّي 4.5:1. بنحرّك اللون ناحية الأسود أو الأبيض بأقل قدر لحد ما يعدّي. */
const rgbOf = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const hexOf = (c) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
const lumOf = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const WHITE = [255, 255, 255], BLACK = [0, 0, 0], INK = [17, 19, 23];
// أقل تحريك للون ناحية «toward» لحد ما يعدّي التباين مع كل الخلفيات
function fitOn(c, bgs, toward, target = 4.5) {
  // بنختبر اللون بعد التقريب لأرقام صحيحة (اللي هيتكتب فعلًا)، عشان التقريب ما ينزّلش التباين تحت الحد
  for (let i = 0; i <= 50; i++) { const x = mixRgb(c, toward, i / 50).map(Math.round); if (bgs.every((b) => ratio(x, b) >= target)) return x; }
  return toward;
}
// لون محسوب فعلًا من متغيّر في الـ CSS (بعد color-mix) — بنقراه من عنصر مخفي
function cssColor(name) {
  const el = document.createElement('i'); el.style.cssText = `position:absolute;visibility:hidden;color:var(${name})`;
  document.body.appendChild(el); const v = getComputedStyle(el).color; el.remove();
  let m = /rgba?\(([\d.]+),?\s*([\d.]+),?\s*([\d.]+)/.exec(v); if (m) return [+m[1], +m[2], +m[3]];
  m = /color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)/.exec(v); if (m) return [m[1] * 255, m[2] * 255, m[3] * 255];
  return WHITE;
}
// الكلام على خلفية بلون المحل: أبيض أو حبر غامق، اللي أوضح
function onAccent(hex) { const c = rgbOf(hex) || rgbOf(DEFAULTS.accent); return ratio(WHITE, c) >= ratio(INK, c) ? '#ffffff' : hexOf(INK); }
function accentTokens(hex, dark) {
  const a = rgbOf(hex) || rgbOf(DEFAULTS.accent);
  const grounds = ['--bg', '--surface', '--surface-2', '--surface-3'].map(cssColor);
  let fill = a, on = rgbOf(onAccent(hexOf(a)));
  if (ratio(on, fill) < 4.5) { fill = fitOn(a, [WHITE], BLACK); on = WHITE; }
  // لون المحل ككلام: مقروء على كل الأسطح. والتظليل بيتعمل منه (مش من اللون الخام) عشان يبان حتى لو اللون فاتح جدًا أو غامق جدًا
  const toward = dark ? WHITE : BLACK;
  let text = fitOn(a, grounds, toward);
  const weak = mixRgb(grounds[1], text, dark ? 0.22 : 0.12);
  if (ratio(text, weak) < 4.5) text = fitOn(text, [...grounds, weak], toward);
  return { '--accent-fill': hexOf(fill), '--on-accent': hexOf(on), '--accent-text': hexOf(text), '--accent-weak': hexOf(weak) };
}
function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = curTheme(); r.dataset.look = SET.look; r.dataset.font = SET.font; r.dataset.scale = SET.scale;
  r.style.setProperty('--accent', SET.accent);
  const t = accentTokens(SET.accent, r.dataset.theme === 'dark');
  for (const k in t) r.style.setProperty(k, t[k]);
  document.title = `${SET.shopName} — نموذج الواجهة`;
}

/* ===== صور الأصناف (اختياري) — صورة صغيرة لكل صنف، بتتحفظ في المتصفح ===== */
const IMG_KEY = 'mshop.mockup.images.v1';
let IMGS = (() => { try { return JSON.parse(localStorage.getItem(IMG_KEY) || '{}') || {}; } catch { return {}; } })();
function saveImages() {
  try { localStorage.setItem(IMG_KEY, JSON.stringify(IMGS)); return true; } catch { toast('مساحة التخزين مش كفاية للصورة دي', 'err'); return false; }
}
const prodImg = (p) => (SET.showImages ? IMGS[p.id] || null : null);
// صورة الصنف لو موجودة، وإلا الأيقونة
const prodVisual = (p) => { const src = prodImg(p); return src ? `<img src="${src}" alt="">` : icon(p.icon); };

/* ===== الأرقام والتواريخ ===== */
const AR_DIG = '٠١٢٣٤٥٦٧٨٩';
const dg = (s) => (SET.digits === 'arabic' ? String(s).replace(/[0-9]/g, (d) => AR_DIG[d]) : String(s));
const NF = { latin: new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }), arabic: new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 }) };
const num = (n) => NF[SET.digits === 'arabic' ? 'arabic' : 'latin'].format(n);
const money = (n) => `${num(Math.round(n * 100) / 100)} ج.م`;
const locale = () => (SET.digits === 'arabic' ? 'ar-EG' : 'ar-EG-u-nu-latn');
const fmtTime = (d = new Date()) => new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit' }).format(d);
const fmtDate = (d = new Date()) => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'numeric', year: 'numeric' }).format(d);
const fmtLong = (d = new Date()) => new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
const fmtDay = (d) => new Intl.DateTimeFormat(locale(), { weekday: 'long' }).format(d);
const addMonths = (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };
const monthsTxt = (n) => (n === 1 ? 'شهر' : n === 2 ? 'شهرين' : n <= 10 ? `${num(n)} شهور` : `${num(n)} شهر`);

/* ===== رسائل وأصوات ===== */
function toast(msg, kind = 'ok', ms = 2800) {
  const box = $('#toasts'); if (!box) return;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `${icon(kind === 'err' ? 'circle-alert' : kind === 'info' ? 'info' : 'circle-check')}<span>${esc(msg)}</span>`;
  box.appendChild(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 300);
}
let AC = null;
function beep(freq = 230, dur = 0.13) {
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.04;
    o.connect(g); g.connect(AC.destination); o.start(); o.stop(AC.currentTime + dur);
  } catch { /* مفيش صوت — مش مشكلة */ }
}
function hashStr(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
// شكل QR للعرض بس (مش كود حقيقي)
function fakeQR(seed, px = 84, cls = 'qr') {
  const n = 25; let h = hashStr(seed) || 1;
  const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
  const inFinder = (x, y) => (x < 8 && y < 8) || (x > 16 && y < 8) || (x < 8 && y > 16);
  let rects = '';
  for (const [fx, fy] of [[0, 0], [18, 0], [0, 18]]) {
    rects += `<rect x="${fx}" y="${fy}" width="7" height="7"/><rect x="${fx + 1}" y="${fy + 1}" width="5" height="5" fill="#fff"/><rect x="${fx + 2}" y="${fy + 2}" width="3" height="3"/>`;
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { if (!inFinder(x, y) && rnd() > 0.52) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`; }
  return `<svg class="${cls}" width="${px}" height="${px}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${n}" height="${n}" fill="#fff"/><g fill="#111">${rects}</g></svg>`;
}

/* ===== الحالة ===== */
function newInvoice() { return { id: Math.random().toString(36).slice(2, 8), lines: [], customer: null, discount: null, held: false }; }
const S = {
  user: DATA.users[0], locked: false, lockUser: null, pin: '', pinErr: '',
  view: 'pos', modal: null,
  invoices: [newInvoice()], active: 0, sel: -1,
  q: '', qi: 0, cat: 'top', _res: [],
  nextNo: 10453, sales: [], services: [], showProfit: false,
  inv: { q: '', cat: 'all', low: false, open: {} },
  repairs: DATA.repairs, settingsTab: 'shop',
  mobile: { lookupQ: 'نوت 14', last: null, recvPid: 'p5', recv: [], recvMode: 'imei', recvQty: 1 },
  sw: null, // قايمة تبديل المستخدم فوق: null أو { user, pin, err, pinned }
  catNew: { name: '', parent: '', icon: 'tag' },
};
const isOwner = () => S.user && S.user.role === 'owner';
const roleName = (u) => (u.role === 'owner' ? 'المالك' : 'بيّاع');
const avatar = (u, cls = '') => `<span class="avatar ${cls}" style="background:${u.color}">${esc(u.name.charAt(0))}</span>`;
const logoHTML = (cls = 'logo') => `<div class="${cls}">${SET.logo ? `<img src="${SET.logo}" alt="">` : esc((SET.shopName || 'م').trim().charAt(0))}</div>`;

/* سجلات تتملي من الملفات التانية */
const VIEWS = {}, MODALS = {}, ACT = {}, INPUT = {}, CHANGE = {};

/* ===== الرسم ===== */
function render() {
  const app = $('#app');
  const ae = document.activeElement;
  const fid = ae && ae !== document.body && ae.id ? ae.id : null;
  let s0 = null, s1 = null;
  if (fid && typeof ae.selectionStart === 'number') { s0 = ae.selectionStart; s1 = ae.selectionEnd; }
  const scrolls = {};
  $$('[data-scroll]').forEach((el) => { scrolls[el.dataset.scroll] = [el.scrollTop, el.scrollLeft]; });

  app.innerHTML = S.locked ? viewLock() : shell() + (S.modal ? modalHTML() : '');
  document.body.classList.toggle('has-modal', !!S.modal || S.locked);

  $$('[data-scroll]').forEach((el) => { const v = scrolls[el.dataset.scroll]; if (v) { el.scrollTop = v[0]; el.scrollLeft = v[1]; } });
  if (S.modal && !S.locked && !S.modal._mounted) {
    S.modal._mounted = true;
    const af = $('.modal [data-autofocus]');
    if (af) { af.focus({ preventScroll: true }); if (af.select) af.select(); }
  } else if (fid) {
    const el = document.getElementById(fid);
    if (el) {
      el.focus({ preventScroll: true });
      if (s0 !== null && el.setSelectionRange) { try { el.setSelectionRange(s0, s1); } catch { /* نوع الحقل مش بيدعم */ } }
    }
  }
  if (!S.modal && !S.locked && !(S.sw && S.sw.user) && S.view === 'pos' && (!document.activeElement || document.activeElement === document.body)) focusSearch();
  if (S._scrollSel) { const sel = $('.line.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' }); S._scrollSel = false; }
}
function focusSearch() { const q = $('#q'); if (q && !S.modal && !S.locked && !(S.sw && S.sw.user)) q.focus({ preventScroll: true }); }
function openModal(m) { S.sw = null; S.modal = m; render(); }
function closeModal() {
  const prev = S.modal && S.modal.prev;
  if (prev) { prev._mounted = false; S.modal = prev; render(); return; }
  S.modal = null; render(); focusSearch();
}
function modalHTML() { const def = MODALS[S.modal.type]; return def ? `<div class="overlay" data-act="overlay">${def.html(S.modal)}</div>` : ''; }
const modalHead = (ic, title, sub = '') => `<div class="modal-h"><h3>${icon(ic)} <span class="mt">${title}</span>${sub ? ` <small>${sub}</small>` : ''}</h3><button type="button" class="icon-btn sm" data-act="closeModal" title="إغلاق (Esc)">${icon('x')}</button></div>`;

/* ===== الهيكل: الشريط الجانبي والعلوي ===== */
const NAV = [
  { id: 'pos', label: 'البيع', icon: 'shopping-cart' },
  { id: 'repairs', label: 'الصيانة', icon: 'wrench' },
  { id: 'inventory', label: 'المخزون', icon: 'boxes' },
  { id: 'dashboard', label: 'التقارير', icon: 'chart-column', owner: true },
  { id: 'mobile', label: 'الموبايل', icon: 'smartphone' },
  { id: 'settings', label: 'الإعدادات', icon: 'settings', owner: true },
];
const TITLES = { pos: 'البيع', repairs: 'الصيانة', inventory: 'المخزون', dashboard: 'التقارير', mobile: 'تطبيق الموبايل', settings: 'الإعدادات' };
function shell() {
  return `<div class="shell">${rail()}<main class="main">${topbar()}<div class="content" data-scroll="content-${S.view}">${VIEWS[S.view]()}</div></main></div>`;
}
function rail() {
  const dark = curTheme() === 'dark';
  return `<nav class="rail" aria-label="الأقسام">
    ${logoHTML()}
    ${NAV.map((n) => {
      const locked = n.owner && !isOwner();
      return `<button type="button" class="nav-btn ${S.view === n.id ? 'active' : ''}" data-act="nav" data-v="${n.id}" title="${n.label}${locked ? ' — للمالك بس' : ''}">${icon(n.icon)}<span>${n.label}</span>${locked ? `<span class="lock-badge">${icon('lock')}</span>` : ''}</button>`;
    }).join('')}
    <div class="sp"></div>
    <button type="button" class="nav-btn" data-act="toggleTheme" title="فاتح / غامق">${icon(dark ? 'sun' : 'moon')}<span>${dark ? 'فاتح' : 'غامق'}</span></button>
    <button type="button" class="nav-btn" data-act="lock" title="قفل الشاشة (Ctrl+L)">${icon('lock-keyhole')}<span>قفل</span></button>
  </nav>`;
}
function topbar() {
  const u = S.user;
  return `<header class="topbar">
    <h1>${TITLES[S.view]}</h1><span class="shop hide-sm">· ${esc(SET.shopName)}</span>
    <div class="sp"></div>
    <span class="status" title="الوردية">${icon('clock')} وردية #${num(DATA.shift.no)} مفتوحة · من ${dg(DATA.shift.opened)}</span>
    ${hasPrinter() ? `<span class="status hide-sm" title="الطابعة"><span class="dot"></span>${icon('printer')} الطابعة جاهزة</span>` : `<span class="status hide-sm" title="مفيش طابعة — الإيصال بيتبعت للعميل على واتساب"><span class="dot"></span>${icon('message-circle')} الإيصال: واتساب</span>`}
    <span class="status hide-sm" title="الموبايلات المتصلة بشبكة المحل"><span class="dot"></span>${icon('smartphone')} ${num(DATA.devices.filter((d) => d.online).length)} موبايل متصل</span>
    <span class="status num" id="clock">${fmtTime()}</span>
    <button type="button" class="btn sm" data-act="shiftClose">${icon('calculator')} تقفيل الوردية</button>
    <div class="user-switch ${S.sw ? 'open' : ''}">
      <button type="button" class="user-chip" data-act="swToggle" aria-haspopup="true" aria-expanded="${S.sw ? 'true' : 'false'}" title="بدّل البيّاع">${avatar(u)}<span class="who">${esc(u.name)}<small>${roleName(u)}</small></span>${icon('chevron-down', 'chev')}</button>
      ${S.sw ? swMenuHTML() : ''}
    </div>
  </header>`;
}

/* ===== تبديل البيّاع من فوق: تأشّر على اسمك ← تظهر باقي الأسماء ← تختار ← الرقم السري بتاعه ===== */
function swMenuHTML() {
  const sw = S.sw, me = S.user;
  if (!sw.user) {
    const others = DATA.users.filter((x) => x.id !== me.id);
    return `<div class="sw-menu" role="menu" aria-label="تبديل البيّاع">
      <div class="sw-cur">${avatar(me)}<span class="t"><b>${esc(me.name)}</b><small>${roleName(me)} · شغّال دلوقتي</small></span></div>
      <div class="sw-h">بدّل لـ</div>
      ${others.map((x) => `<button type="button" class="sw-item" role="menuitem" data-act="swPick" data-id="${x.id}">${avatar(x)}<span class="t"><b>${esc(x.name)}</b><small>${roleName(x)}</small></span>${icon('chevron-left')}</button>`).join('')}
      <div class="sw-sep"></div>
      <button type="button" class="sw-item sm" role="menuitem" data-act="lock">${icon('lock-keyhole')}<span class="t">قفل الشاشة</span><kbd>Ctrl+L</kbd></button>
    </div>`;
  }
  const x = sw.user;
  return `<div class="sw-menu pin ${sw.err ? 'shake' : ''}" role="dialog" aria-label="الرقم السري">
    <div class="sw-pin-h"><button type="button" class="icon-btn sm" data-act="swBack" title="رجوع (Esc)">${icon('arrow-right')}</button>${avatar(x)}<span class="t"><b>${esc(x.name)}</b><small>اكتب الرقم السري بتاعه</small></span></div>
    <div class="pin-dots sm">${[0, 1, 2, 3].map((i) => `<i class="${i < sw.pin.length ? 'on' : ''}"></i>`).join('')}</div>
    <div class="err-msg">${esc(sw.err)}</div>
    <div class="numpad sm">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-act="swKey" data-k="${n}">${num(n)}</button>`).join('')}
      <button type="button" data-act="swBack" title="رجوع">${icon('arrow-right')}</button>
      <button type="button" data-act="swKey" data-k="0">${num(0)}</button>
      <button type="button" data-act="swKey" data-k="del" title="مسح">${icon('delete')}</button></div>
    <div class="sw-hint">للتجربة: ${esc(x.name)} <bdi dir="ltr" class="mono">${x.pin}</bdi></div>
  </div>`;
}
// القايمة بتتحدّث لوحدها من غير ما الشاشة كلها تترسم تاني — عشان أي ضغطة برّه (زرار أو مفتاح تشغيل) تكمّل عادي
function swSync() {
  const w = $('.user-switch'); if (!w) return;
  w.classList.toggle('open', !!S.sw);
  const old = w.querySelector('.sw-menu'); if (old) old.remove();
  if (S.sw) w.insertAdjacentHTML('beforeend', swMenuHTML());
  const c = w.querySelector('.user-chip'); if (c) c.setAttribute('aria-expanded', S.sw ? 'true' : 'false');
}
let swHoverBlock = false; // بعد التبديل أو القفل: متفتحش تاني بالتأشير لحد ما الماوس يبعد
function swOpen(pinned = false) { S.sw = { user: null, pin: '', err: '', pinned }; swSync(); }
function swClose() { if (!S.sw) return; const wasPin = !!S.sw.user; S.sw = null; swHoverBlock = true; swSync(); if (wasPin) focusSearch(); }
function swPick(u) {
  if (!u || u.id === S.user.id) return;
  S.sw = { user: u, pin: '', err: '', pinned: true };
  const ae = document.activeElement; if (ae && ae !== document.body && ae.blur) ae.blur();
  swSync();
}
function swPress(k) {
  const sw = S.sw; if (!sw || !sw.user) return;
  if (k === 'del') { sw.pin = sw.pin.slice(0, -1); sw.err = ''; swSync(); return; }
  if (sw.pin.length >= 4) return;
  sw.pin += k; sw.err = '';
  if (sw.pin.length === 4) {
    if (sw.pin === sw.user.pin) { switchUser(sw.user); return; }
    sw.err = 'الرقم السري غلط — جرّب تاني'; sw.pin = ''; beep();
  }
  swSync();
}
function switchUser(u) {
  const keep = cur().lines.length;
  S.user = u; S.sw = null; swHoverBlock = true;
  const n = NAV.find((x) => x.id === S.view);
  if (n && n.owner && u.role !== 'owner') S.view = 'pos';
  render(); focusSearch();
  toast(`بقيت شغّال باسم ${u.name}${keep ? ' — الفاتورة المفتوحة زي ما هي' : ''}`);
}
// بيرجّع true لو الزرار اتعامل معاه هنا
function swKey(e) {
  const sw = S.sw;
  if (!sw.user) { if (e.key === 'Escape') { e.preventDefault(); swClose(); return true; } return false; }
  const d = toLatin(e.key);
  if (/^[0-9]$/.test(d)) { e.preventDefault(); swPress(d); return true; }
  if (e.key === 'Backspace') { e.preventDefault(); swPress('del'); return true; }
  if (e.key === 'Escape') { e.preventDefault(); S.sw = { user: null, pin: '', err: '', pinned: true }; swSync(); return true; }
  return true; // وانت بتكتب الرقم السري، باقي الزراير متتبعتش لشاشة البيع
}
Object.assign(ACT, {
  swToggle: () => { if (!S.sw) swOpen(true); else if (!S.sw.pinned) { S.sw.pinned = true; } else swClose(); },
  swPick: (d) => swPick(DATA.users.find((x) => x.id === d.id)),
  swKey: (d) => swPress(d.k),
  swBack: () => { S.sw = { user: null, pin: '', err: '', pinned: true }; swSync(); },
});
// فتح بالتأشير (بعد لحظة صغيرة عشان مايفتحش لو الماوس معدّي) وقفل لما الماوس يبعد — إلا لو بتكتب الرقم السري.
// الفتح بيحتاج حركة ماوس حقيقية (mousemove): لما الشاشة تترسم تاني والماوس واقف على الاسم، المتصفح بيبعت
// mouseover لوحده — ده مايفتحش القايمة وانت شغّال بالكيبورد.
let swOpenT = 0, swCloseT = 0;
function swHover(e) {
  const inside = !!(e.target.closest && e.target.closest('.user-switch'));
  if (inside) {
    clearTimeout(swCloseT); swCloseT = 0;
    if (e.type === 'mousemove' && !S.sw && !swOpenT && !swHoverBlock && !S.modal && !S.locked) {
      swOpenT = setTimeout(() => { swOpenT = 0; if (!S.sw && !swHoverBlock && !S.modal && !S.locked) swOpen(false); }, 140);
    }
  } else {
    swHoverBlock = false;
    if (swOpenT) { clearTimeout(swOpenT); swOpenT = 0; }
    if (S.sw && !S.sw.user && !S.sw.pinned && !swCloseT) {
      swCloseT = setTimeout(() => { swCloseT = 0; if (S.sw && !S.sw.user && !S.sw.pinned) { S.sw = null; swSync(); } }, 320);
    }
  }
}
document.addEventListener('mouseover', swHover);
document.addEventListener('mousemove', swHover);

/* ===== أفعال عامة ===== */
ACT.nav = (d) => {
  const n = NAV.find((x) => x.id === d.v);
  if (n.owner && !isOwner()) { toast('الصفحة دي للمالك بس — بدّل لحساب المالك من فوق', 'err'); beep(); return; }
  S.view = d.v; S.modal = null; render();
};
ACT.toggleTheme = () => { SET.theme = curTheme() === 'dark' ? 'light' : 'dark'; saveSettings(); applySettings(); render(); };
ACT.lock = () => { S.locked = true; S.lockUser = null; S.pin = ''; S.pinErr = ''; S.modal = null; S.sw = null; render(); };
ACT.closeModal = () => closeModal();
ACT.overlay = (d, el, e) => {
  if (e.target !== el) return;
  if (S.modal.type === 'pay' && S.modal.step === 'done') finishAfterSale(); else closeModal();
};
ACT.soon = () => toast('دي للعرض بس في النموذج', 'info');

/* ===== الأحداث ===== */
document.addEventListener('click', (e) => {
  if (S.sw && !e.target.closest('.user-switch')) { S.sw = null; swSync(); } // ضغطة برّه قايمة البيّاعين بتقفلها (من غير ما تبوّظ الضغطة نفسها)
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (fn) fn(el.dataset, el, e);
});
document.addEventListener('input', (e) => { const el = e.target.closest('[data-input]'); if (el && INPUT[el.dataset.input]) INPUT[el.dataset.input](el, e); });
document.addEventListener('change', (e) => { const el = e.target.closest('[data-change]'); if (el && CHANGE[el.dataset.change]) CHANGE[el.dataset.change](el, e); });
document.addEventListener('keydown', (e) => {
  if (S.locked) { lockKey(e); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyL') { e.preventDefault(); ACT.lock(); return; }
  if (S.sw && swKey(e)) return;
  if (S.modal) { modalKey(e); return; }
  if (S.view === 'pos') posKey(e);
});
setInterval(() => { const c = $('#clock'); if (c) c.textContent = fmtTime(); }, 15000);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (SET.theme === 'auto') { applySettings(); render(); } });
