<script setup lang="ts">
// Backup panel (P2a, ADR-003).
//
// Manager-only screen: both commands require `ManageSettings` (blanket
// re-authenticated), and the backend refuses any other caller regardless of
// what the DOM offers (`spec:210`).
//
// Restore messaging follows the Product Owner decision 2026-10-15: no
// automatic restart on success — the operator restarts manually. A failed
// restore closes the pool, so the panel says plainly that a manual restart
// is required before anything else can run, instead of letting later
// command errors accumulate unexplained.

import { ref } from 'vue';

import * as api from '../api/backup';
import { describeError } from '../api/errors';

const busy = ref(false);
const error = ref('');
const notice = ref('');

const backupOutput = ref('');
const backupPassword = ref('');
const restorePath = ref('');
const restorePassword = ref('');
const needsRestart = ref(false);

async function submitCreate(): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const report = await api.createBackup(
      backupOutput.value.trim(),
      backupPassword.value,
    );
    backupPassword.value = '';
    notice.value =
      `تم إنشاء النسخة الاحتياطية: قاعدة البيانات ${report.databaseLen} بايت، ` +
      `${report.imageCount} صورة.`;
  } catch (err) {
    error.value = describeError(err);
    backupPassword.value = '';
  } finally {
    busy.value = false;
  }
}

async function submitRestore(): Promise<void> {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const outcome = await api.restoreBackup(
      restorePath.value.trim(),
      restorePassword.value,
    );
    restorePassword.value = '';
    needsRestart.value = true;
    notice.value =
      `تم استيراد النسخة الاحتياطية (${outcome.imageCount} صورة). ` +
      `أعد تشغيل التطبيق يدويًا الآن لفتح البيانات المستعادة.`;
  } catch (err) {
    error.value = describeError(err);
    restorePassword.value = '';
    needsRestart.value = true;
    notice.value =
      'تعذّر الاستيراد. يلزم إعادة تشغيل التطبيق يدويًا قبل أي عمل آخر.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="panel">
    <h3 class="panel-title">النسخ الاحتياطي</h3>
    <p class="hint">
      نسخة مشفرة محمولة: قاعدة البيانات والصور معًا. كلمة المرور ثمانية أحرف
      على الأقل، ولا تُحفظ في أي مكان.
    </p>

    <form @submit.prevent="submitCreate">
      <label class="field">
        <span>مسار ملف النسخة (داخل مجلد بيانات التطبيق)</span>
        <input v-model="backupOutput" autocomplete="off" required />
      </label>
      <label class="field">
        <span>كلمة مرور النسخة</span>
        <input
          v-model="backupPassword"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
        />
      </label>
      <button type="submit" :disabled="busy">إنشاء نسخة</button>
    </form>

    <form @submit.prevent="submitRestore">
      <label class="field">
        <span>مسار ملف النسخة للاستيراد</span>
        <input v-model="restorePath" autocomplete="off" required />
      </label>
      <label class="field">
        <span>كلمة مرور النسخة</span>
        <input
          v-model="restorePassword"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
        />
      </label>
      <button type="submit" :disabled="busy">استيراد نسخة</button>
    </form>

    <p v-if="needsRestart" class="hint">
      أعد تشغيل التطبيق يدويًا الآن — لا يعمل أي أمر قبل إعادة التشغيل.
    </p>
    <p v-if="notice" class="hint">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>
