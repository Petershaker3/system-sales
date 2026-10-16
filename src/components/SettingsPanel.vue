<script setup lang="ts">
// Device settings and the Pattern (SP-1b, `plan` Task 11).
//
// Reading settings and every change to them is blanket re-authenticated
// (`ManageSettings`), so this panel opens behind the same re-auth modal user
// management uses — the backend would refuse regardless; this is about not
// letting an operator discover that from an error.
//
// The Pattern section manages the step-up mechanism itself: set it for the
// first time, prove the one in place works, switch protection off, and reset a
// forgotten one with the Manager password — the recovery path, and the only
// one (`plan` Task 9). Nothing here keeps the entered Pattern beyond the input
// binding; it travels once and is dropped.
//
// Saving is a diff against the snapshot the panel was read with: only changed
// keys are written, one audit event each, and the form is not allowed to
// half-apply — parsing happens before the re-auth modal opens.

import { ref } from 'vue';

import * as api from '../api/settings';
import * as patternApi from '../api/pattern';
import * as lifecycle from '../api/lifecycle';
import { describeError } from '../api/errors';
import PatternPrompt from './PatternPrompt.vue';
import type { SettingsSnapshot, DiscountKind } from '../api/settings';
import type { PatternStatus } from '../api/pattern';
import type { CostMethod } from '../api/departments';

// --- re-authentication modal -----------------------------------------------
// Mirrors UserManagement.vue: every read and every write of `ManageSettings`
// territory goes through it.
const showReauth = ref(false);
const reauthPassword = ref('');
const pendingAction = ref<(() => Promise<void>) | null>(null);
const error = ref('');
const busy = ref(false);

async function withReauth(action: () => Promise<void>): Promise<void> {
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
const defaultCostMethod = ref<CostMethod>('moving_average');
const defaultVatEnabled = ref(false);
const defaultVatRate = ref(''); // percent as typed; '' = never set
const defaultVatInclusive = ref(false);
const maxDiscountKind = ref<DiscountKind>('money');
const maxDiscountValue = ref('0');

const status = ref<PatternStatus | null>(null);
const verified = ref(false);

async function load(): Promise<void> {
  busy.value = true;
  try {
    const snapshot = await api.readSettings();
    baseline.value = snapshot;
    invoicePrefix.value = snapshot.invoicePrefix;
    defaultCostMethod.value = snapshot.defaultCostMethod;
    defaultVatEnabled.value = snapshot.defaultVatEnabled;
    defaultVatRate.value =
      snapshot.defaultVatRateBp === null
        ? ''
        : String(snapshot.defaultVatRateBp / 100);
    defaultVatInclusive.value = snapshot.defaultVatInclusive;
    maxDiscountKind.value = snapshot.maxDiscountKind;
    maxDiscountValue.value = String(snapshot.maxDiscountValue);
    status.value = await patternApi.getPatternStatus();
    loaded.value = true;
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function refreshStatus(): Promise<void> {
  try {
    status.value = await patternApi.getPatternStatus();
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
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
  if (defaultCostMethod.value !== snapshot.defaultCostMethod) {
    changes.push(['default_cost_method', defaultCostMethod.value]);
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

// --- Pattern: first set -----------------------------------------------------
const showSetForm = ref(false);
const newPattern = ref('');
const newPatternConfirm = ref('');

async function saveNewPattern(): Promise<void> {
  if (newPattern.value !== newPatternConfirm.value) {
    error.value = 'النمطان غير متطابقين.';
    return;
  }

  busy.value = true;
  error.value = '';
  try {
    await patternApi.setPattern(newPattern.value);
    newPattern.value = '';
    newPatternConfirm.value = '';
    showSetForm.value = false;
    await refreshStatus();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- Pattern: prove / reset / disable --------------------------------------
const showPrompt = ref(false);

function afterVerified(): void {
  showPrompt.value = false;
  verified.value = true;
  error.value = '';
}

const showReset = ref(false);
const resetPassword = ref('');

function startReset(): void {
  resetPassword.value = '';
  error.value = '';
  showReset.value = true;
}

async function performReset(): Promise<void> {
  await withReauth(async () => {
    busy.value = true;
    error.value = '';
    try {
      await patternApi.resetPattern(resetPassword.value);
      showReset.value = false;
      resetPassword.value = '';
      await refreshStatus();
    } catch (err) {
      error.value = describeError(err);
    } finally {
      busy.value = false;
    }
  });
}

async function disableProtection(): Promise<void> {
  verified.value = false;
  await withReauth(async () => {
    busy.value = true;
    error.value = '';
    try {
      await patternApi.disablePattern();
      await refreshStatus();
    } catch (err) {
      error.value = describeError(err);
    } finally {
      busy.value = false;
    }
  });
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
        <span>طريقة حساب التكلفة الافتراضية</span>
        <select v-model="defaultCostMethod">
          <option value="moving_average">متوسط التكلفة المتحرك</option>
          <option value="fifo">وارد أولاً يخرج أولاً (FIFO)</option>
        </select>
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

    <div v-if="loaded && status !== null" class="pattern-block">
      <h3 class="pattern-title">نمط التأكيد</h3>

      <p class="hint">
        {{
          status.enabled
            ? 'الحماية مفعّلة: العمليات الحسّاسة تطلب النمط قبل الخمس دقائق من آخر تأكيد.'
            : status.configured
              ? 'الحماية معطّلة حاليًا. عيّن نمطًا جديدًا لتفعيلها.'
              : 'لا يوجد نمط بعد.'
        }}
      </p>
      <p v-if="verified" class="hint verified">النمط صحيح — التأكيد ساري للدقائق الخمس القادمة.</p>

      <div class="row">
        <button
          v-if="status.enabled"
          type="button"
          :disabled="busy"
          @click="showPrompt = true"
        >
          تأكيد النمط
        </button>
        <button
          v-if="status.enabled"
          type="button"
          :disabled="busy"
          @click="disableProtection"
        >
          تعطيل الحماية
        </button>
        <button v-if="status.configured" type="button" :disabled="busy" @click="startReset">
          إعادة تعيين النمط
        </button>
        <button
          v-if="!status.enabled && !showSetForm"
          type="button"
          :disabled="busy"
          @click="showSetForm = true"
        >
          {{ status.configured ? 'تعيين نمط جديد' : 'تعيين نمط' }}
        </button>
      </div>

      <form
        v-if="showSetForm || !status.enabled"
        class="form"
        @submit.prevent="withReauth(saveNewPattern)"
      >
        <p class="hint">
          {{
            status.configured
              ? 'النمط الحالي سيُستبدل ويُفعّل الحماية.'
              : 'ثمانية أحرف على الأقل — النمط يحمي العمليات الحسّاسة ولا يمكن استرجاعه إلا بكلمة مرور المدير.'
          }}
        </p>
        <label class="field">
          <span>النمط الجديد</span>
          <input
            v-model="newPattern"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
          />
        </label>
        <label class="field">
          <span>تأكيد النمط</span>
          <input
            v-model="newPatternConfirm"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
          />
        </label>
        <button type="submit" :disabled="busy">حفظ النمط</button>
      </form>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- Step-up prompt: permissionless by design, so no re-auth in front of it. -->
    <PatternPrompt :visible="showPrompt" @verified="afterVerified" @cancelled="showPrompt = false" />

    <!-- Reset: the Manager password is re-proved here on purpose — losing the
         Pattern must cost exactly as much as losing the password. -->
    <div v-if="showReset" class="overlay">
      <form class="modal" @submit.prevent="performReset">
        <h3 class="modal-title">إعادة تعيين النمط</h3>
        <p class="hint">
          النمط الحالي سيُحذف. أدخل كلمة مرور المدير للمتابعة.
        </p>
        <label class="field">
          <span>كلمة مرور المدير</span>
          <input
            v-model="resetPassword"
            type="password"
            autocomplete="current-password"
            required
            autofocus
          />
        </label>
        <div class="row">
          <button type="submit" :disabled="busy">إعادة التعيين</button>
          <button type="button" :disabled="busy" @click="showReset = false">إلغاء</button>
        </div>
      </form>
    </div>

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
.pattern-block {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid #eee;
}
.pattern-title {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}
.verified {
  color: #070;
  font-weight: 600;
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
