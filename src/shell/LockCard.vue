<script setup lang="ts">
// The sign-in card of the approved mockup's lock screen (views/lock.js): pick
// who is working, then their PIN (ADR-017 §2). An account with no PIN yet, or
// someone who forgot theirs, signs in with the password instead.
//
// Used for the first sign-in and for the lock overlay (Ctrl+L), which sits on
// top of the running screens so open invoices survive a lock and a switch
// (`docs/PLAN.md` §4). While mounted it owns the keyboard: every key stops here,
// so nothing reaches a screen underneath.
//
// A manager who forgot the password has «نسيت كلمة السر؟» here (ADR-017 §4):
// the recovery code from the paper and a new password; then the new code is
// shown once, and the card waits for the new password.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import * as api from '../api/identity';
import { asCommandError, describeError } from '../api/errors';
import type { Session, UserSummary } from '../api/identity';
import Icon from '../ui/Icon.vue';
import PinPad from '../ui/PinPad.vue';
import { avatarColour, roleName } from './nav';
import RecoverPassword from './RecoverPassword.vue';
import RecoveryCodeShow from './RecoveryCodeShow.vue';

const props = defineProps<{ users: readonly UserSummary[]; hint?: string }>();
const emit = defineEmits<{ signedIn: [session: Session, method: 'pin' | 'password'] }>();

const pickedId = ref<string | null>(null);
const usePassword = ref(false);
const password = ref('');
const error = ref('');
const busy = ref(false);
const pad = ref<InstanceType<typeof PinPad> | null>(null);
const passwordInput = ref<HTMLInputElement | null>(null);
/** «نسيت كلمة السر؟» is open. */
const recovering = ref(false);
/** The new recovery code after a recovery, until the owner has written it down. */
const newCode = ref<string | null>(null);
/** Said under the password field once the password was replaced. */
const notice = ref('');

const people = computed(() => props.users.filter((user) => !user.disabled));
const picked = computed(() => people.value.find((user) => user.id === pickedId.value) ?? null);
const showPad = computed(() => picked.value !== null && picked.value.hasPin && !usePassword.value);

function pick(user: UserSummary): void {
  pickedId.value = user.id;
  usePassword.value = !user.hasPin;
  password.value = '';
  error.value = '';
  notice.value = '';
  if (usePassword.value) void nextTick(() => passwordInput.value?.focus());
}

function back(): void {
  pickedId.value = null;
  usePassword.value = false;
  password.value = '';
  error.value = '';
  notice.value = '';
}

function onRecovered(code: string): void {
  recovering.value = false;
  newCode.value = code;
}

/** The new code is written down: sign in with the new password. */
function afterNewCode(): void {
  newCode.value = null;
  usePassword.value = true;
  password.value = '';
  error.value = '';
  notice.value = 'اتغيّرت كلمة السر. ادخل بالجديدة.';
  void nextTick(() => passwordInput.value?.focus());
}

function withPassword(): void {
  usePassword.value = true;
  error.value = '';
  void nextTick(() => passwordInput.value?.focus());
}

async function submitPin(pin: string): Promise<void> {
  const user = picked.value;
  if (user === null || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const session = await api.loginWithPin(user.id, pin);
    emit('signedIn', session, 'pin');
  } catch (err) {
    error.value = describeError(err);
    pad.value?.clear();
    if (asCommandError(err)?.code === 'PIN_NOT_SET') withPassword();
  } finally {
    busy.value = false;
  }
}

async function submitPassword(): Promise<void> {
  const user = picked.value;
  if (user === null || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const session = await api.login(user.id, password.value);
    emit('signedIn', session, 'password');
  } catch (err) {
    error.value = describeError(err);
    password.value = '';
  } finally {
    busy.value = false;
  }
}

/** Every key stops here; the pad's keys are the pad's, digits pick a person. */
function onKey(event: KeyboardEvent): void {
  event.stopPropagation();
  // A recovery window is open: it has the keyboard (its Esc and Enter).
  if (recovering.value || newCode.value !== null) return;
  if (picked.value === null) {
    const n = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
    const person = n ? people.value[Number(n[1]) - 1] : undefined;
    if (person !== undefined) {
      event.preventDefault();
      pick(person);
    }
    return;
  }
  if (showPad.value) {
    if (pad.value?.handleKey(event)) event.preventDefault();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    back();
  }
}

onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));

/** Open on a given person (the switch menu sends someone without a PIN here). */
function open(userId: string): void {
  const user = people.value.find((candidate) => candidate.id === userId);
  if (user !== undefined) pick(user);
}

defineExpose({ open });
</script>

<template>
  <div class="lock-card" :class="{ shake: error !== '' }">
    <div class="logo" aria-hidden="true">م</div>
    <h1>نقطة البيع</h1>

    <template v-if="picked === null">
      <div class="muted">مين هيشتغل دلوقتي؟</div>
      <div class="users">
        <button v-for="user in people" :key="user.id" type="button" class="user-card" @click="pick(user)">
          <span class="avatar lg" :style="{ background: avatarColour(user.id) }">{{ user.displayName.charAt(0) }}</span>
          <b>{{ user.displayName }}</b>
          <small>{{ roleName(user.role) }}</small>
        </button>
      </div>
    </template>

    <template v-else>
      <div class="who-row">
        <button type="button" class="icon-btn sm" title="رجوع (Esc)" @click="back"><Icon name="arrow-right" /></button>
        <span class="avatar lg" :style="{ background: avatarColour(picked.id) }">{{ picked.displayName.charAt(0) }}</span>
        <span class="t">
          <b>{{ picked.displayName }}</b>
          <small>{{ showPad ? 'اكتب الـ PIN بتاعك' : 'اكتب كلمة السر' }}</small>
        </span>
      </div>

      <PinPad
        v-if="showPad"
        ref="pad"
        :error="error"
        :busy="busy"
        @submit="submitPin"
        @back="back"
        @input="error = ''"
      />

      <form v-else class="stack auth-form" @submit.prevent="submitPassword">
        <div class="field">
          <label for="login-pass">كلمة السر</label>
          <input
            id="login-pass"
            ref="passwordInput"
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
          />
        </div>
        <button type="submit" class="btn primary lg block" :disabled="busy">دخول</button>
        <p v-if="error" class="err-msg auth-error" role="alert">{{ error }}</p>
        <p v-else-if="notice" class="ok-msg" role="status">{{ notice }}</p>
        <p v-if="!picked.hasPin" class="muted small">
          الحساب ده لسه ماعندوش PIN. بعد الدخول هتقدر تعمل واحد عشان تدخل أسرع.
        </p>
      </form>

      <button v-if="showPad" type="button" class="link-btn" @click="withPassword">دخول بكلمة السر</button>
      <button v-else-if="picked.hasPin" type="button" class="link-btn" @click="usePassword = false">
        الرجوع للـ PIN
      </button>
      <button v-if="!showPad && picked.role === 'manager'" type="button" class="link-btn" @click="recovering = true">
        نسيت كلمة السر؟
      </button>
    </template>

    <RecoverPassword v-if="recovering && picked" :user="picked" @close="recovering = false" @recovered="onRecovered" />
    <RecoveryCodeShow
      v-if="newCode"
      :code="newCode"
      title="كود الاسترجاع الجديد"
      sub="القديم اتحرق. ده اللي هيرجّعك المرة الجاية"
      @done="afterNewCode"
    />

    <div v-if="hint" class="demo-hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.who-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}
.who-row .t {
  display: grid;
  line-height: 1.25;
  text-align: start;
}
.who-row small {
  color: var(--muted);
}
.auth-form {
  text-align: start;
  margin-top: 16px;
}
.auth-error {
  margin-top: 4px;
}
.small {
  font-size: 0.82rem;
}
.link-btn {
  margin-top: 12px;
  border: 0;
  background: none;
  color: var(--accent-text);
  font-weight: 600;
  cursor: pointer;
  padding: 4px 8px;
}
.link-btn:hover {
  text-decoration: underline;
}
.ok-msg {
  margin-top: 4px;
  color: var(--ok);
  font-weight: 600;
  font-size: 0.88rem;
}
</style>
