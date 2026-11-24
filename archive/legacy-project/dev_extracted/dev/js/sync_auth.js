// [Phase 3 — Supabase Sync Foundation]
// Minimal Supabase authentication + SyncManager owner-identity wiring.
//
// What this file does:
//   • Creates the Supabase JS client using public config (sync_supabase_config.js).
//   • Listens for auth-state changes and calls SyncManager.init() with the
//     authenticated user's id (= auth.uid() server-side) as the owner identity.
//   • Renders a minimal sign-in / sign-out UI into #sync-auth-container.
//
// What this file deliberately does NOT do:
//   • Does NOT enqueue or upload any existing local data.
//   • Does NOT modify any verified Sync algorithm in sync.js.
//   • Does NOT trust any client-supplied owner identifier — owner id always
//     comes from the authenticated Supabase session (session.user.id).

let _supabaseClient = null;

function _syncAuthInit() {
  if (typeof supabase === 'undefined') {
    console.warn('[sync-auth] Supabase SDK not available — auth layer inactive');
    return;
  }
  if (typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') {
    console.warn('[sync-auth] SUPABASE_URL / SUPABASE_ANON_KEY not defined');
    return;
  }

  _supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Auth state listener — fires immediately with current session, then on every change.
  // Owner identity is sourced exclusively from session.user.id (= auth.uid() on server).
  // SyncManager.enabled is set true on authenticated session, false on sign-out.
  _supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session && session.user) {
      const provider = (typeof createSupabaseSyncProvider === 'function')
        ? createSupabaseSyncProvider(_supabaseClient)
        : null;
      if (typeof SyncManager !== 'undefined') {
        SyncManager.init(provider, session.user.id);
        SyncManager.enabled = true;
        SyncManager.startAutoSync();
      }
    } else {
      // Signed out or session expired — disable Sync and clear provider/owner identity.
      if (typeof SyncManager !== 'undefined') {
        SyncManager.enabled = false;
        SyncManager.init(null, null);
      }
    }
    if (typeof renderSyncStatus === 'function') renderSyncStatus();
    _syncAuthRender();
  });
}

function _syncAuthRender() {
  const container = document.getElementById('sync-auth-container');
  if (!container || !_supabaseClient) return;
  _supabaseClient.auth.getSession().then(({ data: { session } }) => {
    if (session && session.user) {
      container.innerHTML =
        `<div style="display:flex;align-items:center;gap:8px;margin-top:6px">` +
        `<span style="font-size:12px;color:#4ade80">✅ ${session.user.email}</span>` +
        `<button onclick="_syncAuthSignOut()" style="padding:3px 10px;background:#ef4444;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:12px">تسجيل الخروج</button>` +
        `</div>`;
    } else {
      container.innerHTML =
        `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px">` +
        `<input id="sync-email-inp" type="email" placeholder="البريد الإلكتروني" ` +
        `style="padding:5px 8px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#f1f5f9;font-size:12px;width:180px">` +
        `<input id="sync-pw-inp" type="password" placeholder="كلمة المرور" ` +
        `style="padding:5px 8px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#f1f5f9;font-size:12px;width:140px">` +
        `<button onclick="_syncAuthSignIn()" ` +
        `style="padding:5px 12px;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px">تسجيل الدخول</button>` +
        `<span id="sync-auth-err" style="color:#f87171;font-size:11px"></span>` +
        `</div>`;
    }
  });
}

async function _syncAuthSignIn() {
  if (!_supabaseClient) return;
  const email    = (document.getElementById('sync-email-inp')?.value || '').trim();
  const password = document.getElementById('sync-pw-inp')?.value || '';
  const errEl    = document.getElementById('sync-auth-err');
  if (!email || !password) {
    if (errEl) errEl.textContent = 'أدخل البريد وكلمة المرور';
    return;
  }
  if (errEl) errEl.textContent = '⏳ جاري...';
  const { error } = await _supabaseClient.auth.signInWithPassword({ email, password });
  if (error && errEl) errEl.textContent = error.message;
}

async function _syncAuthSignOut() {
  if (!_supabaseClient) return;
  await _supabaseClient.auth.signOut();
}

window.addEventListener('DOMContentLoaded', _syncAuthInit);
