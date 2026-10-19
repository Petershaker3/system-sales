<script setup lang="ts">
// User management, and the re-authentication modal it depends on.
//
// `ManageUsers` requires a freshly proven password, so every action here first
// raises the session through the re-auth modal. The backend refuses the action
// regardless; this is about not letting an operator discover that by way of an
// error message.
//
// Also in scope for the first time: nothing in the application previously called
// `reauthenticate`, so this component is what gives that mechanism a real user.

import { ref } from 'vue';

import * as lifecycle from '../api/lifecycle';
import * as identity from '../api/identity';
import { asCommandError, describeError } from '../api/errors';
import { toLatinDigits } from '../ui/format';
import { skipsPasswordReauth } from '../shell/open-mode';
import type { ManagedUser, Role } from '../api/lifecycle';

const emit = defineEmits<{ reauthenticated: [] }>();

// --- re-authentication modal -----------------------------------------------
const showReauth = ref(false);
const reauthPassword = ref('');
const pendingAction = ref<(() => Promise<void>) | null>(null);
const error = ref('');
const busy = ref(false);

/**
 * Run an action that needs a freshly proven password.
 *
 * The action is held until the modal is satisfied, so the caller does not have to
 * care whether re-authentication already happened.
 */
async function withReauth(action: () => Promise<void>): Promise<void> {
  if (skipsPasswordReauth()) {
    // `ADR-039`: a shop that has not claimed an account has no password to prove,
    // and its session already stands at the assurance this modal exists to reach.
    // Rust decides that; this only keeps the panel from demanding a secret the shop
    // has not got — and from refusing the action when the operator has nothing to
    // type into it.
    await action();
    return;
  }
  pendingAction.value = action;
  reauthPassword.value = '';
  error.value = '';
  showReauth.value = true;
}

async function confirmReauth(): Promise<void> {
  const action = pendingAction.value;
  if (action === null) return;

  busy.value = true;
  error.value = '';
  try {
    await lifecycle.reauthenticate(reauthPassword.value);
    showReauth.value = false;
    reauthPassword.value = '';
    emit('reauthenticated');
    await action();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- list ------------------------------------------------------------------
const accounts = ref<ManagedUser[]>([]);
const loaded = ref(false);
/** Accounts that have a daily PIN (ADR-017), from the sign-in picker: the fact only. */
const withPin = ref<Set<string>>(new Set());

/** Load the accounts. `prompt`: asked for by the owner («تحديث»), so a stale password opens the password window. */
async function load(prompt = false): Promise<void> {
  busy.value = true;
  try {
    accounts.value = await lifecycle.listUsersForManagement();
    withPin.value = new Set((await identity.listUsers()).filter((u) => u.hasPin).map((u) => u.id));
    loaded.value = true;
    error.value = '';
  } catch (err) {
    // Listing accounts is `ManageUsers` too. When the owner asked («تحديث»), ask for
    // the password and load; the silent load on opening Settings never pops a window.
    if (prompt && asCommandError(err)?.code === 'REAUTHENTICATION_REQUIRED') await withReauth(() => load());
    else error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- create ----------------------------------------------------------------
const creating = ref(false);
const newDisplayName = ref('');
const newUsername = ref('');
const newRole = ref<Role>('sales');
const newPassword = ref('');

async function create(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await lifecycle.createUser({
      displayName: newDisplayName.value,
      username: newUsername.value,
      role: newRole.value,
      password: newPassword.value,
    });
    creating.value = false;
    newDisplayName.value = '';
    newUsername.value = '';
    newPassword.value = '';
    newRole.value = 'sales';
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- per-account actions ---------------------------------------------------
const pinFor = ref<ManagedUser | null>(null);
const pinValue = ref('');

function startPin(user: ManagedUser): void {
  pinFor.value = user;
  pinValue.value = '';
  error.value = '';
}

/** The owner sets an account's daily PIN (ADR-017 §1); the password was just proven. */
async function performPin(): Promise<void> {
  const target = pinFor.value;
  if (target === null) return;

  busy.value = true;
  error.value = '';
  try {
    await lifecycle.setUserPin(target.userId, toLatinDigits(pinValue.value.trim()));
    pinFor.value = null;
    pinValue.value = '';
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const resetFor = ref<ManagedUser | null>(null);
const resetPassword = ref('');
const renameFor = ref<ManagedUser | null>(null);
const renameValue = ref('');

function startReset(user: ManagedUser): void {
  resetFor.value = user;
  resetPassword.value = '';
  error.value = '';
}

async function performReset(): Promise<void> {
  const target = resetFor.value;
  if (target === null) return;

  busy.value = true;
  error.value = '';
  try {
    await lifecycle.resetUserPassword(target.userId, resetPassword.value);
    resetFor.value = null;
    resetPassword.value = '';
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

function startRename(user: ManagedUser): void {
  renameFor.value = user;
  renameValue.value = user.username;
  error.value = '';
}

async function performRename(): Promise<void> {
  const target = renameFor.value;
  if (target === null) return;

  busy.value = true;
  error.value = '';
  try {
    await lifecycle.setUsername(target.userId, renameValue.value);
    renameFor.value = null;
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function setRole(user: ManagedUser, role: Role): Promise<void> {
  await withReauth(async () => {
    try {
      await lifecycle.changeUserRole(user.userId, role);
      await load();
    } catch (err) {
      error.value = describeError(err);
    }
  });
}

async function setDisabled(user: ManagedUser, disabled: boolean): Promise<void> {
  await withReauth(async () => {
    try {
      if (disabled) {
        await lifecycle.disableUser(user.userId);
      } else {
        await lifecycle.enableUser(user.userId);
      }
      await load();
    } catch (err) {
      error.value = describeError(err);
    }
  });
}

function roleLabel(role: Role): string {
  return role === 'manager' ? 'مدير' : 'مبيعات';
}

// Loaded without the re-auth gate: `PERMISSION_DENIED` here is a genuine answer
// for a sales user who reached this component, not a failure. Administrative
// *actions* go through `withReauth`; reading the list does not.
void load();
</script>

<template>
  <section class="users">
    <h2 class="users-title">إدارة المستخدمين</h2>

    <p v-if="!loaded" class="hint">جارٍ التحميل…</p>
    <p v-else-if="accounts.length === 0" class="hint">لا يوجد مستخدمون.</p>

    <ul v-else class="list">
      <li v-for="user in accounts" :key="user.userId" class="item">
        <div class="item-main">
          <span class="item-name">{{ user.displayName }}</span>
          <!--
            The username is shown because the display name is deliberately not
            unique: two operators may share a name, and without this line the list
            would show two identical rows with no way to tell them apart.
          -->
          <span class="hint">{{ user.username }} · {{ roleLabel(user.role) }}</span>
          <span v-if="user.integrityFault" class="hint status-fault">
            بيانات الحساب ناقصة — كلّم المسؤول الفني
          </span>
          <span v-if="user.disabled" class="hint status-offline">معطّل</span>
          <span v-if="!withPin.has(user.userId)" class="hint status-warn">من غير PIN: بيدخل بكلمة السر</span>
          <span v-if="user.mustChangePassword" class="hint status-warn">
            يجب تغيير كلمة المرور
          </span>
        </div>

        <div class="row">
          <button type="button" :disabled="busy" @click="startRename(user)">
            تغيير الاسم
          </button>
          <button type="button" :disabled="busy" @click="startPin(user)">
            PIN الدخول
          </button>
          <button type="button" :disabled="busy" @click="startReset(user)">
            إعادة تعيين كلمة المرور
          </button>
          <button
            type="button"
            :disabled="busy"
            @click="setRole(user, user.role === 'manager' ? 'sales' : 'manager')"
          >
            {{ user.role === 'manager' ? 'إزالة الإشراف' : 'ترقية إلى مدير' }}
          </button>
          <button
            type="button"
            :disabled="busy"
            @click="setDisabled(user, !user.disabled)"
          >
            {{ user.disabled ? 'إعادة التفعيل' : 'تعطيل' }}
          </button>
        </div>
      </li>
    </ul>

    <div class="row">
      <button type="button" :disabled="busy" @click="creating = !creating">
        {{ creating ? 'إلغاء' : 'إضافة مستخدم' }}
      </button>
      <button type="button" :disabled="busy" @click="load(true)">تحديث</button>
    </div>

    <form v-if="creating" class="form" @submit.prevent="withReauth(create)">
      <label class="field">
        <span>الاسم الظاهر</span>
        <input v-model="newDisplayName" required autocomplete="off" />
      </label>

      <label class="field">
        <span>اسم الدخول</span>
        <input
          v-model="newUsername"
          required
          autocomplete="off"
          placeholder="حروف إنجليزية وأرقام و . _ - فقط"
        />
      </label>
      <p class="hint">من 3 إلى 32 حرفًا. الاسم الظاهر يمكن أن يتكرر.</p>

      <label class="field">
        <span>الدور</span>
        <select v-model="newRole">
          <option value="sales">مبيعات</option>
          <option value="manager">مدير</option>
        </select>
      </label>

      <label class="field">
        <span>كلمة المرور</span>
        <input
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
        />
      </label>
      <p class="hint">ثمانية أحرف على الأقل.</p>

      <button type="submit" :disabled="busy">إضافة</button>
    </form>

    <!-- Password reset: the manager chooses a temporary password and never sees it again. -->
    <form v-if="pinFor !== null" class="form" @submit.prevent="withReauth(performPin)">
      <p class="hint">
        PIN من 4 لـ6 أرقام لـ{{ pinFor.displayName }}. بيه هيدخل ويبدّل بسرعة، وبيتغيّر من هنا لو اتنسى.
      </p>
      <label class="field">
        <span>الـ PIN</span>
        <input
          id="user-pin"
          v-model="pinValue"
          type="password"
          inputmode="numeric"
          autocomplete="off"
          required
          minlength="4"
          maxlength="6"
        />
      </label>
      <button type="submit" :disabled="busy">حفظ الـ PIN</button>
    </form>

    <form v-if="resetFor !== null" class="form" @submit.prevent="withReauth(performReset)">
      <p class="hint">
        كلمة مرور مؤقتة لـ{{ resetFor.displayName }}. سيُطلب منه تغييرها عند أول دخول.
      </p>
      <label class="field">
        <span>كلمة المرور المؤقتة</span>
        <input
          v-model="resetPassword"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
        />
      </label>
      <button type="submit" :disabled="busy">إعادة التعيين</button>
    </form>

    <!-- Username change: manager-only, and audited on both sides of the change. -->
    <form v-if="renameFor !== null" class="form" @submit.prevent="withReauth(performRename)">
      <p class="hint">اسم دخول جديد لـ{{ renameFor.displayName }}.</p>
      <label class="field">
        <span>اسم الدخول</span>
        <input v-model="renameValue" required autocomplete="off" />
      </label>
      <button type="submit" :disabled="busy">حفظ</button>
    </form>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!--
      Re-authentication. Opened by any action that manages users, because the
      backend requires a freshly proven password for all of them.
    -->
    <div v-if="showReauth" class="overlay">
      <form class="modal" @submit.prevent="confirmReauth">
        <h3 class="modal-title">تأكيد الهوية</h3>
        <p class="hint">أدخل كلمة مرور المدير للمتابعة.</p>

        <label class="field">
          <span>كلمة المرور</span>
          <input
            v-model="reauthPassword"
            type="password"
            autocomplete="current-password"
            required
            autofocus
          />
        </label>

        <button type="submit" :disabled="busy">تأكيد</button>
      </form>
    </div>
  </section>
</template>

<style scoped>
/* Minimal, matching App.vue and CatalogPanel.vue. */
.users {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #ddd;
}
.users-title {
  font-size: 1.05rem;
  margin: 0 0 0.75rem;
}
.list {
  list-style: none;
  margin: 0 0 1rem;
  padding: 0;
}
.item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0;
  border-bottom: 1px solid #eee;
  flex-wrap: wrap;
}
.item-main {
  display: flex;
  flex-direction: column;
}
.item-name {
  font-weight: 600;
}
.status-offline {
  color: #a00;
}
.status-warn {
  color: #a60;
}
.status-fault {
  color: #a00;
  font-weight: 600;
}
.row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}
.form {
  margin: 1rem 0;
  padding: 0.75rem;
  border: 1px solid #ddd;
}
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.modal {
  background: #fff;
  padding: 1rem;
  max-width: 22rem;
  width: 100%;
}
.modal-title {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
</style>