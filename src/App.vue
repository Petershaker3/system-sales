<script setup lang="ts">
// Root component.
//
// Three states, decided once at start-up and never guessed:
//   1. first-run setup  — the database has no accounts
//   2. login            — accounts exist, nobody is signed in
//   3. shell            — an operator is signed in (AppShell: rail, top bar,
//                         and the screens of the approved mockup)
//
// Signing in wears the mockup's lock card (LockCard): pick who is working, then
// their PIN, or the password for an account with no PIN yet (ADR-017 §2).
// Ctrl+L and «قفل» lock the screen: the session ends and the lock card covers
// the running screens, so open invoices are still there for whoever signs in
// next (`docs/PLAN.md` §4). Switching user from the chip is a PIN sign-in too.
//
// A sensitive operation asks for the owner's PIN through the one approval
// prompt mounted here (`shell/approval.ts`, ADR-017 §3). Locking, switching or
// signing out backs out of a pending request: the session it was for is gone.
//
// The frontend never decides *authorisation*; it only reflects what Rust
// reports. Hiding a screen is presentation, not security (`spec:210`).

import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import * as api from './api/identity';
import { describeError } from './api/errors';
import type { Session, UserSummary } from './api/identity';
import ForcedPasswordChange from './components/ForcedPasswordChange.vue';
import * as lifecycle from './api/lifecycle';
import AppShell from './shell/AppShell.vue';
import ApprovalPrompt from './shell/ApprovalPrompt.vue';
import { dismissApproval, pendingApproval } from './shell/approval';
import LockCard from './shell/LockCard.vue';
import PinSetup from './shell/PinSetup.vue';
import RecoveryCodeShow from './shell/RecoveryCodeShow.vue';
import Toasts from './ui/Toasts.vue';
import { clearToasts, toast } from './ui/toast';

type View = 'loading' | 'setup' | 'login' | 'forced-change' | 'shell';

const view = ref<View>('loading');
const session = ref<Session | null>(null);
const users = ref<UserSummary[]>([]);
const error = ref<string>('');

const displayName = ref('');
const password = ref('');
const busy = ref(false);
/**
 * Whether the backend says this account must change its password.
 *
 * Held separately from `view` so it can be refreshed after the change without
 * re-deciding the whole screen, and so the shell does not query for it on every
 * render.
 */
const mustChangePassword = ref(false);

/** The lock card covers the running screens (Ctrl+L, «قفل»); the session has ended. */
const locked = ref(false);
const lockCard = ref<InstanceType<typeof LockCard> | null>(null);
/** The «اعمل PIN» / «غيّر الـ PIN» window, when open. */
const pinSetup = ref<{ first: boolean; offered: boolean } | null>(null);
/** The first recovery code, made with the owner's account and shown once (ADR-017 §4). */
const firstCode = ref<string | null>(null);

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
      await loadUsers();
      return;
    }
  } catch {
    // Fall through to the login screen: an unavailable credential store must
    // never be papered over with a fake session.
  }

  view.value = 'login';
  await loadUsers();
}

/** The people on the lock card and in the switch menu (no secret material). */
async function loadUsers(): Promise<void> {
  try {
    users.value = await api.listUsers();
  } catch (err) {
    report(err);
  }
}

async function submitSetup(): Promise<void> {
  busy.value = true;
  error.value = '';
  const chosen = password.value;
  try {
    session.value = await api.createFirstManager(displayName.value, chosen);
    password.value = '';
    // The way back in if the password is ever forgotten, made now while the
    // password is in hand, and shown once before anything else.
    try {
      firstCode.value = (await lifecycle.createRecoveryCode(chosen)).code;
    } catch {
      toast('كود الاسترجاع ماتعملش. اعمله من الإعدادات.', 'err');
    }
    if (firstCode.value === null) await afterSignIn('password');
  } catch (err) {
    report(err);
  } finally {
    busy.value = false;
  }
}

/** The first recovery code is written down: carry on into the shop. */
async function afterFirstCode(): Promise<void> {
  firstCode.value = null;
  await afterSignIn('password');
}

/** Someone signed in on the lock card: the first sign-in, or after a lock. */
async function onSignedIn(next: Session, method: 'pin' | 'password'): Promise<void> {
  session.value = next;
  locked.value = false;
  error.value = '';
  await afterSignIn(method);
}

/** Someone else signed in from the user chip; the screens and their invoices stay. */
async function onSwitched(next: Session): Promise<void> {
  dismissApproval();
  session.value = next;
  await enterAfterAuth();
  toast(`${next.displayName} شغّال دلوقتي`, 'info');
}

async function afterSignIn(method: 'pin' | 'password'): Promise<void> {
  await enterAfterAuth();
  await loadUsers();
  // A password sign-in on an account with no PIN: offer one («بعدين» skips it).
  const mine = users.value.find((user) => user.id === session.value?.userId);
  if (method === 'password' && view.value === 'shell' && mine !== undefined && !mine.hasPin) {
    pinSetup.value = { first: true, offered: true };
  }
}

/** Lock the screen: cover it first, then end the session. */
async function lockScreen(): Promise<void> {
  if (locked.value || view.value !== 'shell') return;
  locked.value = true;
  pinSetup.value = null;
  dismissApproval();
  clearToasts();
  try {
    await api.logout();
  } catch {
    // The cover is up either way, and the next sign-in replaces any session left.
  }
  await loadUsers();
}

/** The switch menu picked someone with no PIN: lock, and open the card on them. */
async function lockFor(userId: string): Promise<void> {
  await lockScreen();
  await nextTick();
  lockCard.value?.open(userId);
}

async function signOut(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api.logout();
    session.value = null;
    password.value = '';
    mustChangePassword.value = false;
    locked.value = false;
    pinSetup.value = null;
    dismissApproval();
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

function openPinSetup(): void {
  const mine = users.value.find((user) => user.id === session.value?.userId);
  pinSetup.value = { first: !(mine?.hasPin ?? false), offered: false };
}

async function afterPinSaved(): Promise<void> {
  pinSetup.value = null;
  await loadUsers();
}

/** Answer the pending owner-approval request (the prompt reports how it ended). */
function settleApproval(approved: boolean): void {
  pendingApproval.value?.settle(approved);
}

/** The browser demo's sign-in hint; an empty string (and no text) in real builds. */
const demoHint =
  import.meta.env.VITE_DEMO === '1'
    ? 'للتجربة بس: الـ PIN بيتر 1111، يوسف 2222، مارينا 3333، وكلمة السر لكل الحسابات 1234. كود استرجاع بيتر 2345-6789-ABCD-EFGH-JKMN. البيانات وهمية ومش بتتحفظ.'
    : '';

async function afterSignOut(): Promise<void> {
  await signOut();
  if (view.value === 'login') toast('اتسجّل الخروج', 'info');
}

/** Ctrl+L locks from anywhere in the shell (the mockup's shortcut). */
function onGlobalKey(event: KeyboardEvent): void {
  if (view.value !== 'shell' || locked.value) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyL') {
    event.preventDefault();
    event.stopPropagation();
    void lockScreen();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKey, true);
  void decideView();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey, true));
</script>

<template>
  <AppShell
    v-if="view === 'shell' && session"
    :session="session"
    :busy="busy"
    :users="users"
    @sign-out="afterSignOut"
    @lock="lockScreen"
    @switched="onSwitched"
    @set-pin="openPinSetup"
    @open-lock-for="lockFor"
  />

  <!-- The lock: over the running screens, so open invoices survive it. -->
  <div v-if="view === 'shell' && locked" class="lock over">
    <LockCard ref="lockCard" :users="users" :hint="demoHint" @signed-in="onSignedIn" />
  </div>

  <!-- State 2: accounts exist, nobody signed in. -->
  <div v-else-if="view === 'login'" class="lock">
    <div class="stack-center">
      <LockCard :users="users" :hint="demoHint" @signed-in="onSignedIn" />
      <p v-if="error" class="err-msg auth-error" role="alert">{{ error }}</p>
    </div>
  </div>

  <div v-else-if="view !== 'shell'" class="lock">
    <div class="lock-card">
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
          <span class="hint">ثمانية حروف على الأقل. بعدها هيظهر كود استرجاع تكتبه على ورقة، وتعمل PIN للدخول اليومي.</span>
        </div>
        <button type="submit" class="btn primary lg block" :disabled="busy">اعمل الحساب وادخل</button>
      </form>

      <!--
        State 3: signed in, but the backend requires a password change first. The
        backend refuses every other command in this state, so this screen is not a
        convenience and has no exit by design.
      -->
      <div v-else-if="view === 'forced-change'" class="legacy-panel auth-form">
        <ForcedPasswordChange @changed="afterForcedChange" />
      </div>

      <p v-if="error" class="err-msg auth-error" role="alert">{{ error }}</p>
    </div>
  </div>

  <PinSetup
    v-if="pinSetup && view === 'shell' && !locked"
    :first="pinSetup.first"
    :offered="pinSetup.offered"
    @close="pinSetup = null"
    @saved="afterPinSaved"
  />

  <!-- The first recovery code, right after the owner's account (ADR-017 §4). -->
  <RecoveryCodeShow
    v-if="firstCode"
    :code="firstCode"
    sub="ده طريقك الوحيد لو نسيت كلمة السر"
    @done="afterFirstCode"
  />

  <!-- The owner's PIN for one sensitive operation (ADR-017 §3). -->
  <ApprovalPrompt
    v-if="pendingApproval && view === 'shell' && !locked"
    :label="pendingApproval.label"
    @approved="settleApproval(true)"
    @cancel="settleApproval(false)"
  />

  <Toasts />
</template>

<style scoped>
.auth-form {
  text-align: start;
  margin-top: 16px;
}
.auth-error {
  margin-top: 12px;
}
.hint {
  font-size: 0.8rem;
  color: var(--muted);
}
.stack-center {
  display: grid;
  justify-items: center;
  gap: 10px;
}
</style>
