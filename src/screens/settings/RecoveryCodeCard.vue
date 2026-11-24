<script setup lang="ts">
// «كود الاسترجاع» in the owner's settings (ADR-017 §4): whether there is one
// and since when, and making a new one with the password. The new code is
// shown once, and the old one stops working at once.
import { computed, onMounted, ref } from 'vue';

import { describeError } from '../../api/errors';
import * as lifecycle from '../../api/lifecycle';
import RecoveryCodeShow from '../../shell/RecoveryCodeShow.vue';
import { fmtDate } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';

const createdAt = ref<number | null>(null);
const loaded = ref(false);
const asking = ref(false);
const password = ref('');
const error = ref('');
const busy = ref(false);
const shown = ref<string | null>(null);

const madeOn = computed(() => (createdAt.value === null ? '' : fmtDate(new Date(createdAt.value))));

async function load(): Promise<void> {
  try {
    createdAt.value = (await lifecycle.recoveryCodeStatus()).createdAt;
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loaded.value = true;
  }
}

function ask(): void {
  password.value = '';
  error.value = '';
  asking.value = true;
}

async function make(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const made = await lifecycle.createRecoveryCode(password.value);
    password.value = '';
    asking.value = false;
    shown.value = made.code;
  } catch (err) {
    error.value = describeError(err);
    password.value = '';
  } finally {
    busy.value = false;
  }
}

async function afterShown(): Promise<void> {
  shown.value = null;
  toast('اتعمل كود استرجاع جديد، والقديم بطّل يشتغل.', 'ok');
  await load();
}

onMounted(load);
</script>

<template>
  <section class="card recovery-card">
    <h3><Icon name="shield-check" /> كود الاسترجاع</h3>
    <div class="s-row">
      <div class="t">
        <b>{{ !loaded ? 'لحظة…' : createdAt === null ? 'لسه مفيش كود' : `اتعمل ${madeOn}` }}</b>
        <small>لو نسيت كلمة السر، الكود اللي على الورقة بيرجّعك. بيظهر مرة واحدة بس، والكود الجديد بيلغي القديم</small>
      </div>
      <button type="button" class="btn" :class="{ primary: loaded && createdAt === null }" :disabled="!loaded" @click="ask">
        {{ createdAt === null ? 'اعمل كود' : 'اعمل كود جديد' }}
      </button>
    </div>
    <div v-if="loaded && createdAt === null" class="note warn">
      <Icon name="triangle-alert" />
      <span>من غير كود، لو نسيت كلمة السر مش هتقدر تفتح الإعدادات والمستخدمين والنسخ الاحتياطي.</span>
    </div>
    <p v-if="error && !asking" class="err-msg" role="alert">{{ error }}</p>
  </section>

  <Modal v-if="asking" title="كود استرجاع جديد" sub="محتاج كلمة السر بتاعتك" size="sm" @close="asking = false">
    <form class="stack" @submit.prevent="make">
      <div class="field">
        <label for="rc-current">كلمة السر</label>
        <input id="rc-current" v-model="password" type="password" autocomplete="current-password" data-autofocus />
      </div>
      <div class="err-msg" role="alert">{{ error }}</div>
      <button type="submit" class="btn primary block" :disabled="busy">اعمل الكود <kbd>Enter</kbd></button>
    </form>
  </Modal>

  <RecoveryCodeShow v-if="shown" :code="shown" title="كود استرجاع جديد" sub="القديم بطّل يشتغل من دلوقتي" @done="afterShown" />
</template>

<style scoped>
.recovery-card .note {
  margin-top: 10px;
}
</style>
