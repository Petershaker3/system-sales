<script setup lang="ts">
// «حساب المالك» in الإعدادات ← المستخدمين والصلاحيات (`ADR-039`).
//
// The shop opens without an account, and this card is where the account is made
// afterwards — from inside a running till, not in front of a door it has to pass
// through first. The form asks for the same two things the old first-run screen did
// (a name, a password of `policy::MIN_PASSWORD_LEN` or more) and ends the same way,
// with a recovery code written on paper, because the password is in hand exactly
// once.
//
// What is different is that nothing here is required. The card says so, and the till
// carries on behind it: an invoice is never held up waiting for a signature. Whether
// the claim may happen at all is decided in Rust (`services/identity/open_mode.rs`);
// a shop that already has an account is answered `BOOTSTRAP_ALREADY_COMPLETED`, and
// the card does not try to know better.
import { computed, ref } from 'vue';

import * as api from '../../api/identity';
import { describeError } from '../../api/errors';
import * as lifecycle from '../../api/lifecycle';
import RecoveryCodeShow from '../../shell/RecoveryCodeShow.vue';
import { openMode, readOpenMode } from '../../shell/open-mode';
import { toast } from '../../ui/toast';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { accountStateLine, ownerAccountProblem } from './account';

const open = computed(() => openMode.value.active);
const stateLine = computed(() => accountStateLine(open.value, openMode.value.displayName));

const asking = ref(false);
const name = ref('');
const password = ref('');
const confirm = ref('');
const error = ref('');
const busy = ref(false);
/** The code the claim offers to make, shown once (`ADR-017` §4). */
const code = ref<string | null>(null);

const problem = computed(() =>
  ownerAccountProblem({ displayName: name.value, password: password.value, confirm: confirm.value }, busy.value),
);
/** The error the form reports: what went wrong last, or what is wrong now. */
const line = computed(() => {
  if (error.value !== '') return error.value;
  if (name.value === '' && password.value === '') return '';
  return problem.value ?? '';
});

function ask(): void {
  name.value = '';
  password.value = '';
  confirm.value = '';
  error.value = '';
  asking.value = true;
}

function close(): void {
  asking.value = false;
  error.value = '';
}

async function claim(): Promise<void> {
  if (busy.value) return;
  if (problem.value !== null) {
    error.value = problem.value;
    return;
  }
  busy.value = true;
  error.value = '';
  const chosen = password.value;
  try {
    // The claim signs the owner in with the password just chosen, so the till never
    // stops at a lock card for having finished its setup.
    await api.claimOpenAccount(name.value, chosen);
    name.value = '';
    password.value = '';
    confirm.value = '';
    asking.value = false;
    try {
      readOpenMode(await api.bootstrapStatus());
    } catch {
      // The banner is presentation. Rust has already closed the open mode; the next
      // start-up reads the truth and the line goes away with it.
    }
    try {
      code.value = (await lifecycle.createRecoveryCode(chosen)).code;
    } catch {
      toast('ما قدرناش نعمل كود الاسترجاع. اعمله من الكارت اللي تحت.', 'err');
    }
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function afterShown(): Promise<void> {
  code.value = null;
  toast('الحساب بقى شغال. الدخول من هنا بكلمة السر، والـ PIN اختياري.', 'ok');
}
</script>

<template>
  <section class="card owner-card" data-owner-account-card>
    <h3><Icon name="user-plus" /> حساب المالك</h3>
    <div class="s-row">
      <div class="t">
        <b>{{ open ? 'السيستم شغال من غير حساب' : 'الحساب موجود' }}</b>
        <small>{{ stateLine }}</small>
      </div>
      <button
        v-if="open"
        type="button"
        class="btn primary"
        data-owner-account-btn
        @click="ask"
      >
        اعمل حساب المالك
      </button>
    </div>
    <div v-if="open" class="note">
      <Icon name="info" />
      <span>
        الحساب مش لازم دلوقتي: البيع والفواتير والمخزن شغالين من غير قفل ولا PIN. اللي بيضيفه
        الحساب هو قفل الشاشة، وPIN للبائع، وكود استرجاع كلمة السر، وتحديد مين يشوف إيه.
      </span>
    </div>
    <p v-if="error !== '' && !asking" class="err-msg" role="alert">{{ error }}</p>
  </section>

  <Modal v-if="asking" title="اعمل حساب المالك" sub="السيستم هيفضل شغال على حاله" size="sm" @close="close">
    <form class="stack" @submit.prevent="claim">
      <div class="field">
        <label for="oa-name">اسم صاحب المحل</label>
        <input id="oa-name" v-model="name" autocomplete="off" data-autofocus />
      </div>
      <div class="field">
        <label for="oa-pass">كلمة السر</label>
        <input id="oa-pass" v-model="password" type="password" autocomplete="new-password" minlength="8" />
      </div>
      <div class="field">
        <label for="oa-confirm">كلمة السر تاني</label>
        <input id="oa-confirm" v-model="confirm" type="password" autocomplete="new-password" minlength="8" />
      </div>
      <span class="hint">ثمانية حروف على الأقل. بعدها هيظهر كود استرجاع تكتبه على ورقة.</span>
      <div class="err-msg" role="alert">{{ line }}</div>
      <button type="submit" class="btn primary block" :disabled="busy || problem !== null">
        اعمل الحساب <kbd>Enter</kbd>
      </button>
      <button type="button" class="btn block" :disabled="busy" @click="close">مش دلوقتي</button>
    </form>
  </Modal>

  <RecoveryCodeShow
    v-if="code"
    :code="code"
    title="كود استرجاع كلمة السر"
    sub="طريقك الوحيد لو نسيت كلمة السر"
    @done="afterShown"
  />
</template>

<style scoped>
.owner-card .note {
  margin-top: 10px;
}
.owner-card .hint {
  font-size: 0.8rem;
  color: var(--muted);
}
</style>
