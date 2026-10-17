<script setup lang="ts">
// Root component.
//
// Three states, decided once at start-up and never guessed:
//   1. first-run setup  — the database has no accounts
//   2. login            — accounts exist, nobody is signed in
//   3. shell            — an operator is signed in (AppShell: rail, top bar,
//                         and the screens of the approved mockup)
//
// The sign-in screens wear the mockup's lock-screen card: pick who is working,
// then the password. (A PIN per user and quick switching are plan item 1.1,
// waiting at the decision gate; until then it is the account password.)
//
// The frontend never decides *authorisation*; it only reflects what Rust
// reports. Hiding a screen is presentation, not security (`spec:210`).

import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import * as api from './api/identity';
import { describeError } from './api/errors';
import type { Session, UserSummary } from './api/identity';
import ForcedPasswordChange from './components/ForcedPasswordChange.vue';
import * as lifecycle from './api/lifecycle';
import AppShell from './shell/AppShell.vue';
import { avatarColour, roleName } from './shell/nav';
import Icon from './ui/Icon.vue';
import Toasts from './ui/Toasts.vue';
import { toast } from './ui/toast';

type View = 'loading' | 'setup' | 'login' | 'forced-change' | 'shell';

/**
 * The recovery panel, present only in a recovery build.
 *
 * Two things matter here, and they are not the same thing:
 *
 *   * The SECURITY control is the Rust `recovery` cargo feature. In a
 *     production build the commands this panel calls do not exist, so the panel
 *     could not perform a recovery even if it were reachable.
 *   * The build flag below is therefore hygiene, not protection: it keeps the
 *     panel and its strings out of the bundle a customer actually receives.
 *
 * The import is dynamic on purpose. A static import would be hoisted into the
 * production bundle whatever the condition evaluated to; behind a condition
 * that the bundler can evaluate to false, it is dropped instead.
 *
 * It is `null` when the flag is absent, so the default production build has
 * no recovery UI at all.
 */
const RecoveryPanel =
  import.meta.env.VITE_RECOVERY === '1'
    ? defineAsyncComponent(() => import('./components/RecoveryPanel.vue'))
    : null;

const view = ref<View>('loading');
const session = ref<Session | null>(null);
const users = ref<UserSummary[]>([]);
const error = ref<string>('');

const displayName = ref('');
const password = ref('');
const selectedId = ref<string>('');
const busy = ref(false);
/**
 * Whether the backend says this account must change its password.
 *
 * Held separately from `view` so it can be refreshed after the change without
 * re-deciding the whole screen, and so the shell does not query for it on every
 * render.
 */
const mustChangePassword = ref(false);

// Rust sends a stable code, never prose. Rendering happens here so the Arabic
// wording lives in one reviewable file (`api/errors.ts`) rather than in domain
// logic, and so another locale needs no Rust change.
function report(err: unknown): void {
  error.value = describeError(err);
}

async function decideView(): Promise<void> {
  try {
    const status = await api.bootstrapStatus();
    if (status.needsSetup) {
      view.value = 'setup';
      return;
    }
  } catch (err) {
    report(err);
    view.value = 'login';
    return;
  }

  // A session lives in the OS credential store, so it can outlive the process.
  // Asking is the only way to know.
  try {
    const current = await api.whoami();
    if (current !== null) {
      session.value = current;
      // A forced password change narrows the session to exactly that one
      // operation, so the shell would refuse every command until it is done.
      mustChangePassword.value = await lifecycle.passwordChangeRequired();
      view.value = mustChangePassword.value ? 'forced-change' : 'shell';
      return;
    }
  } catch {
    // Fall through to the login screen: an unavailable credential store must
    // never be papered over with a fake session.
  }

  view.value = 'login';
  await loadUsers();
}

async function loadUsers(): Promise<void> {
  try {
    users.value = await api.listUsers();
    if (selectedId.value === '' && users.value.length > 0) {
      selectedId.value = users.value[0]?.id ?? '';
    }
  } catch (err) {
    report(err);
  }
}

async function submitSetup(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    session.value = await api.createFirstManager(displayName.value, password.value);
    await enterAfterAuth();
  } catch (err) {
    report(err);
  } finally {
    busy.value = false;
  }
}

async function submitLogin(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    session.value = await api.login(selectedId.value, password.value);
    await enterAfterAuth();
  } catch (err) {
    report(err);
    password.value = '';
  } finally {
    busy.value = false;
  }
}

async function signOut(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api.logout();
    session.value = null;
    password.value = '';
    mustChangePassword.value = false;
    view.value = 'login';
    await loadUsers();
  } catch (err) {
    report(err);
  } finally {
    busy.value = false;
  }
}

/** Enter the shell, or the forced-change gate if one is pending. */
async function enterAfterAuth(): Promise<void> {
  try {
    mustChangePassword.value = await lifecycle.passwordChangeRequired();
  } catch {
    // If the flag cannot be read, fall back to the shell: the backend still
    // enforces the restriction, so showing the gate speculatively would be
    // guessing at state the operator cannot act on.
    mustChangePassword.value = false;
  }
  view.value = mustChangePassword.value ? 'forced-change' : 'shell';
}

/** The forced change succeeded; the session is usable again. */
function afterForcedChange(): void {
  mustChangePassword.value = false;
  view.value = 'shell';
  error.value = '';
}

/** The browser demo's sign-in hint; an empty string (and no text) in real builds. */
const demoHint =
  import.meta.env.VITE_DEMO === '1'
    ? 'للتجربة بس: كلمة السر لكل الحسابات 1234. البيانات وهمية ومش بتتحفظ.'
    : '';

/** Users who can sign in, in the order Rust lists them. */
const loginUsers = computed(() => users.value.filter((user) => !user.disabled));
const selectedUser = computed(() => users.value.find((user) => user.id === selectedId.value) ?? null);
/** Login step: pick a person first, then the password (mockup lock screen). */
const picked = ref(false);

function pickUser(id: string): void {
  selectedId.value = id;
  picked.value = true;
  password.value = '';
  error.value = '';
}

function backToPeople(): void {
  picked.value = false;
  password.value = '';
  error.value = '';
}

async function afterSignOut(): Promise<void> {
  picked.value = false;
  await signOut();
  if (view.value === 'login') toast('اتسجّل الخروج', 'info');
}

onMounted(decideView);
</script>

<template>
  <AppShell
    v-if="view === 'shell' && session"
    :session="session"
    :busy="busy"
    @sign-out="afterSignOut"
  />

  <div v-else class="lock">
    <div class="lock-card" :class="{ shake: error !== '' && view === 'login' && picked }">
      <div class="logo" aria-hidden="true">م</div>
      <h1>نقطة البيع</h1>

      <p v-if="view === 'loading'" class="muted">لحظة واحدة…</p>

      <!-- State 1: no accounts exist yet. One-time only; Rust enforces that. -->
      <form v-else-if="view === 'setup'" class="stack auth-form" @submit.prevent="submitSetup">
        <div class="muted">أول تشغيل على الجهاز ده: اعمل حساب المالك.</div>
        <div class="field">
          <label for="setup-name">اسم المالك</label>
          <input id="setup-name" v-model="displayName" autocomplete="off" required />
        </div>
        <div class="field">
          <label for="setup-pass">كلمة السر</label>
          <input id="setup-pass" v-model="password" type="password" autocomplete="new-password" required minlength="8" />
          <span class="hint">ثمانية حروف على الأقل.</span>
        </div>
        <button type="submit" class="btn primary lg block" :disabled="busy">اعمل الحساب وادخل</button>
      </form>

      <!-- State 2: accounts exist, nobody signed in. Pick a person, then the password. -->
      <template v-else-if="view === 'login'">
        <template v-if="!picked || !selectedUser">
          <div class="muted">مين هيشتغل دلوقتي؟</div>
          <div class="users">
            <button
              v-for="user in loginUsers"
              :key="user.id"
              type="button"
              class="user-card"
              @click="pickUser(user.id)"
            >
              <span class="avatar lg" :style="{ background: avatarColour(user.id) }">{{ user.displayName.charAt(0) }}</span>
              <b>{{ user.displayName }}</b>
              <small>{{ roleName(user.role) }} · <bdi dir="ltr">{{ user.username }}</bdi></small>
            </button>
          </div>
        </template>
        <form v-else class="stack auth-form" @submit.prevent="submitLogin">
          <div class="who-row">
            <button type="button" class="icon-btn sm" title="رجوع" @click="backToPeople"><Icon name="arrow-right" /></button>
            <span class="avatar lg" :style="{ background: avatarColour(selectedUser.id) }">{{ selectedUser.displayName.charAt(0) }}</span>
            <span class="t"><b>{{ selectedUser.displayName }}</b><small>{{ roleName(selectedUser.role) }}</small></span>
          </div>
          <div class="field">
            <label for="login-pass">كلمة السر</label>
            <input
              id="login-pass"
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              autofocus
            />
          </div>
          <button type="submit" class="btn primary lg block" :disabled="busy">دخول</button>
        </form>

        <!--
          Recovery builds only. `RecoveryPanel` is null in a default production
          build, so this renders nothing there; the guard is that the Rust commands
          do not exist at all.
        -->
        <component :is="RecoveryPanel" v-if="RecoveryPanel" />
      </template>

      <!--
        State 3: signed in, but the backend requires a password change first. The
        backend refuses every other command in this state, so this screen is not a
        convenience and has no exit by design.
      -->
      <div v-else-if="view === 'forced-change'" class="legacy-panel auth-form">
        <ForcedPasswordChange @changed="afterForcedChange" />
      </div>

      <p v-if="error" class="err-msg auth-error" role="alert">{{ error }}</p>
      <div v-if="demoHint && view === 'login'" class="demo-hint">{{ demoHint }}</div>
    </div>
  </div>

  <Toasts />
</template>

<style scoped>
.auth-form {
  text-align: start;
  margin-top: 16px;
}
.who-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.who-row .t {
  display: grid;
  line-height: 1.25;
}
.who-row small {
  color: var(--muted);
}
.auth-error {
  margin-top: 12px;
}
.hint {
  font-size: 0.8rem;
  color: var(--muted);
}
</style>
