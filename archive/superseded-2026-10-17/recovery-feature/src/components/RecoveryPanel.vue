<script setup lang="ts">
// One-time supervised manager-password recovery panel (plan R1, Design B).
//
// Present only in a recovery build. The security control is the Rust `recovery`
// feature, not this screen: if the commands are absent, every call here fails
// whatever this component renders.
//
// Two deliberate constraints:
//   * No automatic retry anywhere. A throttled attempt must surface as the
//     Arabic "wait" message; retrying on a loop would turn the throttle back
//     into a guessing loop.
//   * Secrets live in component state only, are cleared as soon as the step
//     completes or the panel unmounts, and are never written anywhere.

import { onUnmounted, ref } from 'vue';
import { describeError } from '../api/errors';
import { listUsers, type UserSummary } from '../api/identity';
import { executeManagerRecovery, stageRecoveryApproval } from '../api/recovery';

type Step = 'stage' | 'execute' | 'done';

const step = ref<Step>('stage');
const busy = ref(false);
const error = ref('');
const outcome = ref('');

const users = ref<UserSummary[]>([]);
const targetUserId = ref('');
const reference = ref('');
const deviceId = ref('');
const reason = ref('');
const approvedBy = ref('');
const pattern = ref('');
const newPassword = ref('');

/** The staged reference, so the execute step cannot be pointed elsewhere. */
let stagedReference = '';

function forgetSecrets(): void {
  pattern.value = '';
  newPassword.value = '';
}

function roleLabel(role: string): string {
  return role === 'manager' ? 'مدير' : 'مبيعات';
}

async function loadTargets(): Promise<void> {
  try {
    users.value = await listUsers();
    // Managers only: recovery is defined for the manager account, and the
    // backend refuses any other target, so offering one would be a dead end.
    targetUserId.value = users.value.find((user) => user.role === 'manager')?.id ?? '';
  } catch (err) {
    error.value = describeError(err);
  }
}

async function submitStage(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await stageRecoveryApproval({
      reference: reference.value,
      deviceId: deviceId.value,
      targetUserId: targetUserId.value,
      reason: reason.value,
      approvedBy: approvedBy.value,
      pattern: pattern.value,
    });
    // Only what the next step needs survives the transition.
    stagedReference = reference.value;
    pattern.value = '';
    step.value = 'execute';
  } catch (err) {
    // No retry: a refusal is evidence, including a throttle refusal.
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function submitExecute(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const target = await executeManagerRecovery(
      stagedReference,
      deviceId.value,
      newPassword.value,
    );
    outcome.value = target;
    step.value = 'done';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

void loadTargets();

onUnmounted(forgetSecrets);
</script>

<template>
  <section class="recovery">
    <h2 class="panel-title">استرداد كلمة مرور المدير</h2>
    <p class="hint">
      إجراء لمرة واحدة. يتطلب موافقة المالك والنمط الحالي، ولا يمكن تكراره.
    </p>

    <template v-if="step === 'stage'">
      <label class="field">
        <span>الحساب المستهدف</span>
        <select v-model="targetUserId">
          <option v-for="user in users" :key="user.id" :value="user.id">
            {{ user.displayName }} — {{ user.username }} — {{ roleLabel(user.role) }}
          </option>
        </select>
      </label>

      <label class="field">
        <span>مرجع الموافقة</span>
        <input v-model="reference" autocomplete="off" required />
      </label>

      <label class="field">
        <span>معرّف الجهاز</span>
        <input v-model="deviceId" autocomplete="off" required />
      </label>

      <label class="field">
        <span>السبب</span>
        <input v-model="reason" autocomplete="off" required />
      </label>

      <label class="field">
        <span>المعتمد</span>
        <input v-model="approvedBy" autocomplete="off" required />
      </label>

      <form @submit.prevent="submitStage">
        <label class="field">
          <span>النمط الحالي</span>
          <input v-model="pattern" type="password" autocomplete="off" required minlength="8" />
        </label>
        <button type="submit" :disabled="busy">تسجيل الموافقة</button>
      </form>
    </template>

    <template v-else-if="step === 'execute'">
      <p class="hint">
        سُجّلت الموافقة. اكتب كلمة مرور مؤقتة — سيُطلب تغييرها فور أول دخول.
      </p>

      <form @submit.prevent="submitExecute">
        <label class="field">
          <span>كلمة المرور المؤقتة</span>
          <input
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
          />
        </label>
        <p class="hint">ثمانية أحرف على الأقل.</p>
        <button type="submit" :disabled="busy">تنفيذ الاسترداد</button>
      </form>
    </template>

    <template v-else>
      <p class="hint">
        تم الاسترداد. سجّل الدخول بكلمة المرور المؤقتة، ثم غيّرها فورًا.
      </p>
      <p class="hint">{{ outcome }}</p>
      <button type="button" @click="forgetSecrets">مسح الحقول</button>
    </template>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
/* Visual design is a later slice; the requirement here is only that the panel
   is legible and clearly separate from the login form it sits beside. */
.recovery {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid #ddd;
}
</style>