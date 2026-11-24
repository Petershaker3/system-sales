<script setup lang="ts">
// The owner's PIN for one sensitive operation (ADR-017 §3), in the look of the
// switch menu: the approver's card over the same PIN pad. Rust checks the PIN
// and keeps the approval on the session; this window carries the digits once
// and forgets them.
//
// Every active manager who holds a PIN may approve. The first one is chosen and
// the others are one tap away. A shop where no manager has a PIN yet is told
// how to make one, instead of being shown a pad nobody can answer.
import { onBeforeUnmount, onMounted, ref } from 'vue';

import * as api from '../api/identity';
import { asCommandError, describeError, ErrorCode } from '../api/errors';
import type { UserSummary } from '../api/identity';
import Modal from '../ui/Modal.vue';
import PinPad from '../ui/PinPad.vue';
import { avatarColour } from './nav';

defineProps<{ label: string }>();
const emit = defineEmits<{ approved: []; cancel: [] }>();

const demo = import.meta.env.VITE_DEMO === '1';
const DEMO_PINS: Record<string, string> = demo ? { peter: '1111' } : {};

const approvers = ref<UserSummary[]>([]);
const chosen = ref<UserSummary | null>(null);
const loaded = ref(false);
const error = ref('');
const busy = ref(false);
const pad = ref<InstanceType<typeof PinPad> | null>(null);

function choose(user: UserSummary): void {
  chosen.value = user;
  error.value = '';
  pad.value?.clear();
}

async function submit(pin: string): Promise<void> {
  const approver = chosen.value;
  if (approver === null || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.approveWithOwnerPin(approver.id, pin);
    emit('approved');
  } catch (err) {
    // This is an approval, not a sign-in: a wrong PIN is said as one.
    error.value =
      asCommandError(err)?.code === ErrorCode.INVALID_CREDENTIALS ? 'الـ PIN غلط. جرّب تاني.' : describeError(err);
    pad.value?.clear();
  } finally {
    busy.value = false;
  }
}

/**
 * While the prompt is open every key is the pad's and none reaches the screen
 * underneath. Esc is left to the window, which closes on it.
 */
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') return;
  event.stopPropagation();
  if (pad.value?.handleKey(event)) event.preventDefault();
}

onMounted(async () => {
  window.addEventListener('keydown', onKey, true);
  // The pad owns the keyboard; a focused search box must not take the digits.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  try {
    const everyone = await api.listUsers();
    approvers.value = everyone.filter((user) => user.role === 'manager' && !user.disabled && user.hasPin);
    chosen.value = approvers.value[0] ?? null;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loaded.value = true;
  }
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <Modal title="موافقة المالك" :sub="label" size="sm" @close="emit('cancel')">
    <div class="approve">
      <p v-if="!loaded" class="muted">لحظة واحدة…</p>

      <template v-else-if="chosen">
        <div v-if="approvers.length > 1" class="chips approvers" role="radiogroup" aria-label="مين هيوافق">
          <button
            v-for="user in approvers"
            :key="user.id"
            type="button"
            class="chip"
            :class="{ on: user.id === chosen.id }"
            role="radio"
            :aria-checked="user.id === chosen.id"
            @click="choose(user)"
          >
            {{ user.displayName }}
          </button>
        </div>
        <div class="sw-pin-h approver">
          <span class="avatar" :style="{ background: avatarColour(chosen.id) }">{{ chosen.displayName.charAt(0) }}</span>
          <span class="t"><b>{{ chosen.displayName }}</b><small>اكتب الـ PIN بتاعك عشان توافق</small></span>
        </div>
        <PinPad
          ref="pad"
          size="sm"
          go="وافق"
          :error="error"
          :busy="busy"
          :class="{ shake: error !== '' }"
          @submit="submit"
          @back="emit('cancel')"
          @input="error = ''"
        />
        <div v-if="demo && DEMO_PINS[chosen.username]" class="sw-hint">
          للتجربة: {{ chosen.displayName }} <bdi dir="ltr" class="mono">{{ DEMO_PINS[chosen.username] }}</bdi>
        </div>
      </template>

      <template v-else>
        <div class="note warn">
          مفيش مالك عنده PIN لسه. المالك يعمل PIN من قايمة اسمه فوق («اعمل الـ PIN»)، وبعدها يوافق من هنا.
        </div>
        <p v-if="error" class="err-msg" role="alert">{{ error }}</p>
      </template>
    </div>
    <template #foot>
      <button type="button" class="btn ghost" @click="emit('cancel')">رجوع <kbd>Esc</kbd></button>
    </template>
  </Modal>
</template>

<style scoped>
.approve { text-align: center; }
.approvers { justify-content: center; margin-bottom: 12px; }
.approver { justify-content: center; text-align: start; }
.approver .t { flex: 0 1 auto; }
</style>
