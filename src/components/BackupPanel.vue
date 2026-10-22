<script setup lang="ts">
// Backup panel (P2a, ADR-003).
//
// Manager-only screen: both commands require `ManageSettings` (blanket
// re-authenticated), and the backend refuses any other caller regardless of
// what the DOM offers (`spec:210`).
//
// Two rules shape this panel, both learned from a real failed import:
//
//  1. THE PASSWORD IS ASKED FOR, NOT COMPLAINED ABOUT. The backend answers a
//     normal session with `REAUTHENTICATION_REQUIRED` before it reads a single
//     byte, so the panel opens the same «تأكيد الهوية» dialog the settings and
//     stock screens use (`shell/reauth.ts`) instead of printing the refusal.
//
//  2. ONLY A FAILURE THAT CLOSED THE POOL ASKS FOR A RESTART. `restore_backup`
//     authorizes before `pool.close()`, so a refusal on identity or path leaves
//     the app fully usable; saying otherwise sent the operator through a restart
//     and into the identical refusal (`restoreNeedsRestart`).
//
// Restore messaging follows the Product Owner decision 2026-10-15: no automatic
// restart on success — the operator restarts manually. A restore that got past
// authorization closes the pool on both outcomes, so the panel says plainly that
// a manual restart is required before anything else can run.

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import * as api from '../api/backup';
import {
  asCommandError,
  describeError,
  noteRestoreClosedTheDatabase,
} from '../api/errors';
import {
  pickDroppedBackupFile,
  restoreNeedsRestart,
  suggestedBackupFileName,
} from '../screens/settings/backup';
import { useReauth } from '../shell/reauth';
import Modal from '../ui/Modal.vue';

const busy = ref(false);
const error = ref('');
const errorCode = ref('');
const notice = ref('');

const backupOutput = ref(suggestedBackupFileName(new Date()));
const backupPassword = ref('');
const restorePath = ref('');
const restorePassword = ref('');
const needsRestart = ref(false);

const {
  open: reauthOpen,
  reason: reauthReason,
  password: reauthPassword,
  error: reauthError,
  busy: reauthBusy,
  run: runReauth,
  confirm: confirmReauth,
  cancel: cancelReauth,
} = useReauth();

/** What this confirmation is for, said in the dialog the operator is looking at. */
const reauthSub = computed(() => `محتاجة كلمة مرور المدير: ${reauthReason.value}`);

function clearMessages(): void {
  error.value = '';
  errorCode.value = '';
  notice.value = '';
}

/** Remember the backend's stable code next to the Arabic sentence. */
function reportFailure(err: unknown): string | null {
  error.value = describeError(err);
  errorCode.value = asCommandError(err)?.code ?? '';
  return errorCode.value === '' ? null : errorCode.value;
}

async function createBackup(): Promise<void> {
  busy.value = true;
  clearMessages();
  try {
    const report = await api.createBackup(backupOutput.value.trim(), backupPassword.value);
    backupPassword.value = '';
    notice.value =
      `تم إنشاء النسخة الاحتياطية: قاعدة البيانات ${report.databaseLen} بايت، ` +
      `${report.imageCount} صورة. الملف جوّه مجلد بيانات البرنامج باسم «${backupOutput.value.trim()}».`;
    // The next one needs a name of its own, or it silently replaces this one.
    backupOutput.value = suggestedBackupFileName(new Date());
  } catch (err) {
    reportFailure(err);
    backupPassword.value = '';
  } finally {
    busy.value = false;
  }
}

async function restoreBackup(): Promise<void> {
  busy.value = true;
  clearMessages();
  try {
    const outcome = await api.restoreBackup(restorePath.value.trim(), restorePassword.value);
    // The pool is gone until the next process, so every other screen must be
    // told to restart rather than to call a technician.
    noteRestoreClosedTheDatabase();
    restorePassword.value = '';
    needsRestart.value = true;
    notice.value =
      `تم استيراد النسخة الاحتياطية (${outcome.imageCount} صورة). ` +
      `أعد تشغيل التطبيق يدويًا الآن لفتح البيانات المستعادة.`;
  } catch (err) {
    restorePassword.value = '';
    const code = reportFailure(err);
    // Authorized-then-failed: the pool is closed and only a restart reopens it.
    // Refused before authorization: nothing was touched, so promise nothing.
    if (restoreNeedsRestart(code)) {
      noteRestoreClosedTheDatabase();
      needsRestart.value = true;
      notice.value = 'تعذّر الاستيراد. يلزم إعادة تشغيل التطبيق يدويًا قبل أي عمل آخر.';
    } else {
      needsRestart.value = false;
      notice.value =
        code === 'REAUTHENTICATION_REQUIRED'
          ? 'البيانات ما اتلمستش. دوس «استيراد نسخة» تاني وهيسألك كلمة مرور المدير.'
          : 'البيانات ما اتلمستش — العملية اتوقفت قبل أي تعديل.';
    }
  } finally {
    busy.value = false;
  }
}

function submitCreate(): void {
  void runReauth(createBackup, 'إنشاء نسخة احتياطية من بيانات المحل');
}

function submitRestore(): void {
  void runReauth(restoreBackup, 'استيراد نسخة احتياطية واستبدال بيانات المحل');
}

// --- dropping the package on the panel --------------------------------------
// Windows hands the WebView absolute paths for dropped files, so the operator
// can pick the backup from Explorer instead of typing a path — and there is no
// extension guessing, because the full name arrives with it.
const dragging = ref(false);
let unlistenDrop: (() => void) | null = null;

onMounted(async () => {
  // The browser demo has no drag-and-drop channel, and asks for nothing.
  if (import.meta.env.VITE_DEMO === '1') return;
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'enter' || payload.type === 'over') {
        dragging.value = true;
        return;
      }
      if (payload.type === 'leave') {
        dragging.value = false;
        return;
      }
      dragging.value = false;
      const file = pickDroppedBackupFile(payload.paths);
      if (file === null) {
        error.value = 'الملف اللي اتسقط مش نسخة احتياطية (المطلوب ملف .msb1).';
        errorCode.value = '';
        return;
      }
      restorePath.value = file;
      clearMessages();
    });
  } catch {
    // A webview without the drag channel still restores by path; the field stays.
    unlistenDrop = null;
  }
});

onBeforeUnmount(() => {
  unlistenDrop?.();
  unlistenDrop = null;
});
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
        <span>اسم ملف النسخة (يتحفظ جوّه مجلد بيانات البرنامج)</span>
        <input id="backup-create-name" v-model="backupOutput" autocomplete="off" required />
      </label>
      <p class="hint">
        الاسم لوحده كفاية — المسار الكامل مرفوض بحماية، والملف بيتحفظ في نفس
        مكان قاعدة البيانات.
      </p>
      <label class="field">
        <span>كلمة مرور النسخة</span>
        <input
          id="backup-create-password"
          v-model="backupPassword"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
        />
      </label>
      <button id="backup-create" type="submit" class="btn primary" :disabled="busy">إنشاء نسخة</button>
    </form>

    <form @submit.prevent="submitRestore">
      <div class="drop-zone" :class="{ 'drop-zone-on': dragging }">
        <strong>اسحب ملف النسخة (.msb1) من المستكشف وافلته هنا</strong>
        <span class="hint">أو الصق المسار في الخانة اللي تحت — الاتنين نفس الحاجة.</span>
      </div>
      <label class="field">
        <span>مسار ملف النسخة للاستيراد</span>
        <input
          id="backup-restore-path"
          v-model="restorePath"
          autocomplete="off"
          required
          placeholder="مثال: D:\backups\shop-2026-10-22.msb1"
        />
      </label>
      <label class="field">
        <span>كلمة مرور النسخة</span>
        <input
          id="backup-restore-password"
          v-model="restorePassword"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
        />
      </label>
      <button id="backup-restore" type="submit" class="btn primary" :disabled="busy">استيراد نسخة</button>
    </form>

    <p v-if="needsRestart" class="hint">
      أعد تشغيل التطبيق يدويًا الآن — لا يعمل أي أمر قبل إعادة التشغيل.
    </p>
    <p v-if="notice" class="hint">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="errorCode" class="hint">الكود: {{ errorCode }}</p>

    <!-- The password the backend demands, asked for where the operator is. -->
    <Modal
      v-if="reauthOpen"
      title="تأكيد الهوية"
      :sub="reauthSub"
      size="sm"
      @close="cancelReauth"
    >
      <form class="stack" @submit.prevent="confirmReauth">
        <div class="field">
          <label for="backup-reauth-password">كلمة مرور المدير</label>
          <input
            id="backup-reauth-password"
            v-model="reauthPassword"
            type="password"
            autocomplete="current-password"
            data-autofocus
          />
        </div>
        <div id="backup-reauth-error" class="err-msg" role="alert">{{ reauthError }}</div>
      </form>
      <template #foot>
        <button id="backup-reauth-confirm" type="button" class="btn primary" :disabled="reauthBusy" @click="confirmReauth">
          تأكيد
        </button>
        <button type="button" class="btn ghost" :disabled="reauthBusy" @click="cancelReauth">
          إلغاء
        </button>
      </template>
    </Modal>
  </section>
</template>

<style scoped>
.drop-zone {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0.75rem 0;
  padding: 1rem;
  border: 2px dashed var(--line, #c9c9c9);
  border-radius: 0.75rem;
  text-align: center;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.drop-zone-on {
  border-color: var(--accent, #0a7c5a);
  background: rgba(10, 124, 90, 0.06);
}
.row {
  display: flex;
  gap: 0.5rem;
}
</style>
