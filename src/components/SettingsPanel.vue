<script setup lang="ts">
// Device settings (SP-1b, `plan` Task 11).
//
// Reading settings and every change to them is blanket re-authenticated
// (`ManageSettings`), so this panel opens behind the same re-auth modal user
// management uses — the backend would refuse regardless; this is about not
// letting an operator discover that from an error.
//
// The Pattern section that used to live here is gone with the Pattern: a
// sensitive operation now asks for the owner's PIN at the moment it happens
// (ADR-017 §3), and there is nothing left to configure for it.
//
// Saving is a diff against the snapshot the panel was read with: only changed
// keys are written, one audit event each, and the form is not allowed to
// half-apply — parsing happens before the re-auth modal opens.

import { ref } from 'vue';

import * as api from '../api/settings';
import * as lifecycle from '../api/lifecycle';
import { describeError } from '../api/errors';
import type { SettingsSnapshot, DiscountKind } from '../api/settings';
import { skipsPasswordReauth } from '../shell/open-mode';

// --- re-authentication modal -----------------------------------------------
// Mirrors UserManagement.vue: every read and every write of `ManageSettings`
// territory goes through it.
const showReauth = ref(false);
const reauthPassword = ref('');
const pendingAction = ref<(() => Promise<void>) | null>(null);
const error = ref('');
const busy = ref(false);

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
    await action();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- read -------------------------------------------------------------------
const loaded = ref(false);
const baseline = ref<SettingsSnapshot | null>(null);

const invoicePrefix = ref('');
const defaultVatEnabled = ref(false);
const defaultVatRate = ref(''); // percent as typed; '' = never set
const defaultVatInclusive = ref(false);
const maxDiscountKind = ref<DiscountKind>('money');
const maxDiscountValue = ref('0');

async function load(): Promise<void> {
  busy.value = true;
  try {
    const snapshot = await api.readSettings();
    baseline.value = snapshot;
    invoicePrefix.value = snapshot.invoicePrefix;
    defaultVatEnabled.value = snapshot.defaultVatEnabled;
    defaultVatRate.value =
      snapshot.defaultVatRateBp === null
        ? ''
        : String(snapshot.defaultVatRateBp / 100);
    defaultVatInclusive.value = snapshot.defaultVatInclusive;
    maxDiscountKind.value = snapshot.maxDiscountKind;
    maxDiscountValue.value = String(snapshot.maxDiscountValue);
    loaded.value = true;
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- save (diff against the read snapshot) ----------------------------------
async function submitSettings(): Promise<void> {
  // Parse before any write: an invalid field must not half-apply, and the
  // operator should not prove a password just to be told the field is wrong.
  const rateRaw = defaultVatRate.value.trim();
  let vatRateBp: number | null = null;
  if (rateRaw !== '') {
    const percent = Number(rateRaw);
    if (!Number.isFinite(percent) || percent < 0) {
      error.value = 'نسبة ضريبة القيمة المضافة غير صالحة.';
      return;
    }
    vatRateBp = Math.round(percent * 100);
  }

  const discountRaw = maxDiscountValue.value.trim();
  if (!/^\d+$/.test(discountRaw)) {
    error.value = 'قيمة خصم القصوى يجب أن تكون عددًا غير سالب.';
    return;
  }

  await withReauth(() => saveSettings(vatRateBp, discountRaw));
}

async function saveSettings(vatRateBp: number | null, discountRaw: string): Promise<void> {
  const snapshot = baseline.value;
  if (snapshot === null) return;

  const changes: Array<[api.SettingKey, string]> = [];
  if (invoicePrefix.value !== snapshot.invoicePrefix) {
    changes.push(['invoice_prefix', invoicePrefix.value]);
  }
  if (defaultVatEnabled.value !== snapshot.defaultVatEnabled) {
    changes.push(['default_vat_enabled', defaultVatEnabled.value ? '1' : '0']);
  }
  // The empty string clears back to "never set"; "0" is a recorded zero —
  // two different states the domain keeps apart.
  if (vatRateBp !== snapshot.defaultVatRateBp) {
    changes.push([
      'default_vat_rate_bp',
      vatRateBp === null ? '' : String(vatRateBp),
    ]);
  }
  if (defaultVatInclusive.value !== snapshot.defaultVatInclusive) {
    changes.push(['default_vat_inclusive', defaultVatInclusive.value ? '1' : '0']);
  }
  if (maxDiscountKind.value !== snapshot.maxDiscountKind) {
    changes.push(['max_discount_kind', maxDiscountKind.value]);
  }
  if (discountRaw !== String(snapshot.maxDiscountValue)) {
    changes.push(['max_discount_value', discountRaw]);
  }

  busy.value = true;
  try {
    for (const [key, value] of changes) {
      await api.updateSetting(key, value);
    }
    await load(); // session is freshly re-authenticated from the modal
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

</script>

<template>
  <section class="settings">
    <h2 class="settings-title">إعدادات الجهاز</h2>

    <!-- Reading requires a freshly proven password, so nothing is fetched
         until the operator answers the prompt. -->
    <div v-if="!loaded" class="gate">
      <p class="hint">
        قراءة الإعدادات تتطلب تأكيد هوية المدير.
      </p>
      <button type="button" :disabled="busy" @click="withReauth(load)">
        قراءة الإعدادات
      </button>
    </div>

    <form v-else class="form" @submit.prevent="submitSettings">
      <label class="field">
        <span>بادئة رقم الفاتورة</span>
        <input v-model="invoicePrefix" autocomplete="off" />
      </label>

      <label class="field">
        <span>نسبة الضريبة الافتراضية (%)</span>
        <input
          v-model="defaultVatRate"
          inputmode="decimal"
          autocomplete="off"
          placeholder="اتركها فارغة لعدم التحديد"
        />
      </label>
      <p class="hint">
        الفارغة تعني «لم تُحدد» — مختلفة عن صفر مسجّل. لتغييرها لاحقًا احذف
        النص.
      </p>

      <label class="check">
        <input v-model="defaultVatEnabled" type="checkbox" />
        <span>الضريبة مفعّلة افتراضيًا</span>
      </label>
      <label class="check">
        <input
          v-model="defaultVatInclusive"
          type="checkbox"
          :disabled="!defaultVatEnabled"
        />
        <span>السعر المعروض يشمل الضريبة</span>
      </label>

      <label class="field">
        <span>نوع الخصم الأقصى</span>
        <select v-model="maxDiscountKind">
          <option value="money">قيمة ثابتة</option>
          <option value="percentage">نسبة مئوية</option>
        </select>
      </label>

      <label class="field">
        <span>أقصى قيمة خصم</span>
        <input v-model="maxDiscountValue" inputmode="numeric" autocomplete="off" />
      </label>

      <button type="submit" :disabled="busy">حفظ التغييرات</button>
    </form>

    <p v-if="loaded" class="hint approvals">
      العمليات الحسّاسة — رصيد البداية وإلغاء الفاتورة — تطلب PIN المالك في
      كل مرة.
    </p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- Re-authentication for reading and writing the settings themselves. -->
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
/* Minimal, matching UserManagement.vue. */
.settings {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #ddd;
}
.settings-title {
  font-size: 1.05rem;
  margin: 0 0 0.75rem;
}
.gate {
  margin-bottom: 1rem;
}
.approvals {
  margin-top: 1.25rem;
}
.check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.form {
  margin: 1rem 0;
  padding: 0.75rem;
  border: 1px solid #ddd;
}
.row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 10;
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
