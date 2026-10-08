<script setup lang="ts">
// Root component.
//
// Three states, decided once at start-up and never guessed:
//   1. first-run setup  — the database has no accounts
//   2. login            — accounts exist, nobody is signed in
//   3. shell            — an operator is signed in
//
// The frontend never decides *authorisation*; it only reflects what Rust
// reports. Hiding a screen is presentation, not security (`spec:210`).

import { onMounted, ref } from 'vue';
import * as api from './api/identity';
import { describeError } from './api/errors';
import type { Session, UserSummary } from './api/identity';
import CatalogPanel from './components/CatalogPanel.vue';
import DepartmentsPanel from './components/DepartmentsPanel.vue';
import ForcedPasswordChange from './components/ForcedPasswordChange.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import UserManagement from './components/UserManagement.vue';
import * as lifecycle from './api/lifecycle';

type View = 'loading' | 'setup' | 'login' | 'forced-change' | 'shell';

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

function roleLabel(role: string): string {
  return role === 'manager' ? 'مدير' : 'مبيعات';
}

onMounted(decideView);
</script>

<template>
  <main class="screen">
    <h1 class="title">نظام نقطة البيع</h1>

    <p v-if="view === 'loading'" class="hint">جارٍ التحميل…</p>

    <!-- State 1: no accounts exist yet. One-time only; Rust enforces that. -->
    <section v-else-if="view === 'setup'" class="panel">
      <h2 class="panel-title">الإعداد لأول مرة</h2>
      <p class="hint">
        لا يوجد أي مستخدم على هذا الجهاز. أنشئ حساب المدير الأول.
      </p>

      <form @submit.prevent="submitSetup">
        <label class="field">
          <span>اسم المدير</span>
          <input v-model="displayName" autocomplete="off" required />
        </label>

        <label class="field">
          <span>كلمة المرور</span>
          <input v-model="password" type="password" autocomplete="new-password" required minlength="8" />
        </label>

        <p class="hint">ثمانية أحرف على الأقل.</p>
        <button type="submit" :disabled="busy">إنشاء الحساب</button>
      </form>
    </section>

    <!-- State 2: accounts exist, nobody signed in. -->
    <section v-else-if="view === 'login'" class="panel">
      <h2 class="panel-title">تسجيل الدخول</h2>

      <label class="field">
        <span>اختر المستخدم</span>
        <select v-model="selectedId">
          <option v-for="user in users" :key="user.id" :value="user.id">
            {{ user.displayName }} — {{ user.username }} — {{ roleLabel(user.role) }}
          </option>
        </select>
      </label>

      <form @submit.prevent="submitLogin">
        <label class="field">
          <span>كلمة المرور</span>
          <input v-model="password" type="password" autocomplete="current-password" required />
        </label>
        <button type="submit" :disabled="busy">دخول</button>
      </form>
    </section>

    <!--
      State 3: signed in, but the backend requires a password change first. The
      backend refuses every other command in this state, so this screen is not a
      convenience and has no exit by design.
    -->
    <ForcedPasswordChange
      v-else-if="view === 'forced-change'"
      @changed="afterForcedChange"
    />

    <!-- State 4: an operator is signed in. -->
    <section v-else class="panel">
      <h2 class="panel-title">مرحبًا {{ session?.displayName }}</h2>
      <dl class="facts">
        <dt>الدور</dt>
        <dd>{{ session ? roleLabel(session.role) : '' }}</dd>
        <dt>مستوى التأكيد</dt>
        <dd>{{ session?.assurance === 'reauthenticated' ? 'مُعاد التحقق' : 'عادي' }}</dd>
      </dl>
      <p class="hint">
        تُعرّف هذه الشريحة هوية المستخدمين والمنتجات. أما المخزون والبيع ومسح
        الباركود فتأتي في شريحتين لاحقتين.
      </p>

      <!--
        The catalogue is shown to managers only. Rust refuses a sales user
        regardless (`Permission::ManageCatalog`), so hiding the panel here is
        presentation that matches the enforced rule rather than the rule
        itself — `spec:210` keeps hiding a screen distinct from securing it.
      -->
      <CatalogPanel v-if="session?.role === 'manager'" />

      <UserManagement v-if="session?.role === 'manager'" />

      <DepartmentsPanel v-if="session?.role === 'manager'" />

      <SettingsPanel v-if="session?.role === 'manager'" />

      <button type="button" :disabled="busy" @click="signOut">تسجيل الخروج</button>
    </section>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </main>
</template>

<style>
/* `.field`, `.hint` and `.error` are shared vocabulary — App itself plus every
   panel (CatalogPanel, UserManagement, DepartmentsPanel, SettingsPanel) uses
   them. Scoped styles in this root component never reach a child component's
   markup, so these three rules are global by necessity: an unscoped block is
   the fix for children rendering unstyled. Everything below the next block
   stays scoped because only this screen uses it. */
.field {
  display: block;
  margin-bottom: 0.9rem;
}
.field span {
  display: block;
  margin-bottom: 0.25rem;
}
.field input,
.field select {
  width: 100%;
  padding: 0.5rem;
  font: inherit;
}
.hint {
  color: #555;
  font-size: 0.9rem;
}
.error {
  margin-top: 1rem;
  padding: 0.6rem;
  border: 1px solid #b00;
  color: #b00;
}
</style>

<style scoped>
/* Minimal on purpose. Visual design is a later slice; committing to a look
   now would be deciding something nobody has decided. The only requirement met
   here is legibility of Arabic text at RTL. */
.screen {
  font-family: system-ui, 'Segoe UI', sans-serif;
  padding: 1.5rem;
  max-width: 34rem;
  margin: 0 auto;
}
.title {
  font-size: 1.4rem;
  margin: 0 0 1.5rem;
}
.panel-title {
  font-size: 1.1rem;
  margin: 0 0 0.75rem;
}
.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 1rem;
}
</style>