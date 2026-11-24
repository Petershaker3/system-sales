<script setup lang="ts">
// «النسخ الاحتياطي التلقائي» settings card (`docs/ui/mockup-v1/views/settings.js` `setBackup()`,
// `docs/PLAN.md` §17, §19; `ADR-016` #14, #31; `ADR-027`).

import { onMounted, ref } from 'vue';
import {
  copyLatestBackupToUsb,
  createAutoBackupNow,
  listSavedBackups,
  restoreSavedBackup,
  type SavedBackupEntry,
} from '../../api/backup';
import { describeError } from '../../api/errors';
import { withOwnerApproval } from '../../shell/approval';
import { appearance, setAppearance } from '../../ui/appearance';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import {
  formatBackupLocation,
  formatBackupSize,
  formatBackupTime,
  formatBackupVerifyBadge,
} from './backup';

type BackupToggleKey =
  | 'backupOnShift'
  | 'backupEvery2h'
  | 'backupUsbAuto'
  | 'backupVerify';

const POLICY_ROWS: ReadonlyArray<{
  readonly key: BackupToggleKey;
  readonly title: string;
  readonly subtitle: string;
}> = [
  {
    key: 'backupOnShift',
    title: 'نسخة مع فتح وقفل الوردية',
    subtitle: 'نسخة أوتوماتيك في أول وآخر كل يوم',
  },
  {
    key: 'backupEvery2h',
    title: 'نسخة كل ساعتين أثناء الشغل',
    subtitle: 'تدوير تلقائي — يحتفظ بآخر 30 نسخة',
  },
  {
    key: 'backupUsbAuto',
    title: 'نسخة أوتوماتيك على فلاشة MSHOP-BACKUP',
    subtitle: 'أول ما تركّب الفلاشة بالاسم ده، ينسخ عليها لوحده',
  },
  {
    key: 'backupVerify',
    title: 'فحص سلامة كل نسخة بعد الإنشاء',
    subtitle: 'يتأكد إن الملف سليم وقابل للاسترجاع قبل ما يعتمد عليه',
  },
];

const savedBackups = ref<SavedBackupEntry[]>([]);
const loading = ref(false);
const creatingNow = ref(false);
const copyingUsb = ref(false);
const restoringId = ref<string | null>(null);

async function refreshBackups(): Promise<void> {
  loading.value = true;
  try {
    savedBackups.value = await listSavedBackups();
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    loading.value = false;
  }
}

function isToggleEnabled(key: BackupToggleKey): boolean {
  return appearance[key] !== 'off';
}

async function onTogglePolicy(key: BackupToggleKey): Promise<void> {
  const nextVal = isToggleEnabled(key) ? 'off' : 'on';
  try {
    await setAppearance({ [key]: nextVal });
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function onCreateBackupNow(): Promise<void> {
  if (creatingNow.value) return;
  creatingNow.value = true;
  try {
    const entry = await createAutoBackupNow();
    await refreshBackups();
    toast(
      entry.verified
        ? 'تم أخذ نسخة وفحص سلامتها'
        : 'تم أخذ نسخة احتياطية الآن',
      'ok',
    );
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    creatingNow.value = false;
  }
}

async function onCopyLatestToUsb(): Promise<void> {
  if (copyingUsb.value) return;
  copyingUsb.value = true;
  try {
    await copyLatestBackupToUsb();
    await refreshBackups();
    toast('تم نسخ أحدث نسخة على الفلاشة MSHOP-BACKUP', 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    copyingUsb.value = false;
  }
}

async function onRestoreBackup(entry: SavedBackupEntry): Promise<void> {
  if (restoringId.value) return;
  restoringId.value = entry.id;
  try {
    const outcome = await withOwnerApproval(
      () => restoreSavedBackup(entry.id),
      `استرجاع نسخة احتياطية (${entry.reason})`,
    );
    if (outcome.status === 'cancelled') return;
    toast(
      'تم تحضير استرجاع النسخة وفحص سلامتها — اقفل البرنامج وافتحه تاني لتفعيلها',
      'ok',
    );
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    restoringId.value = null;
  }
}

onMounted(() => {
  void refreshBackups();
});
</script>

<template>
  <div class="backup-policy-stack" data-backup-policy-card>
    <section class="card">
      <div class="backup-card-head">
        <div>
          <h3 style="margin: 0">النسخ الاحتياطي التلقائي</h3>
          <small class="muted">نسخ مشفّرة ومفحوصة أوتوماتيك عشان بياناتك ماتضيعش أبدًا</small>
        </div>
        <div class="backup-head-actions">
          <button
            type="button"
            class="btn"
            data-backup-usb-btn
            :disabled="copyingUsb || creatingNow"
            @click="onCopyLatestToUsb"
          >
            <Icon name="usb" />
            <span>{{ copyingUsb ? 'جاري النسخ...' : 'انسخ على فلاشة' }}</span>
          </button>
          <button
            type="button"
            class="btn primary"
            data-backup-now-btn
            :disabled="creatingNow || copyingUsb"
            @click="onCreateBackupNow"
          >
            <Icon name="hard-drive-download" />
            <span>{{ creatingNow ? 'جاري الحفظ...' : 'خد نسخة دلوقتي' }}</span>
          </button>
        </div>
      </div>

      <div
        v-for="row in POLICY_ROWS"
        :key="row.key"
        class="s-row"
        :data-backup-policy-row="row.key"
      >
        <div class="t">
          <b><bdi dir="auto">{{ row.title }}</bdi></b>
          <small>{{ row.subtitle }}</small>
        </div>
        <label class="switch" :aria-label="row.title" :data-backup-toggle="row.key">
          <input
            type="checkbox"
            :checked="isToggleEnabled(row.key)"
            @change="onTogglePolicy(row.key)"
          />
          <span />
        </label>
      </div>
    </section>

    <section class="card" data-saved-backups-card>
      <div class="backup-history-head">
        <h3 style="margin: 0">آخر النسخ المحفوظة</h3>
        <span class="muted" style="font-size: 0.8rem">تقدر تسترجع أي نسخة بموافقة المالك</span>
      </div>
      <div class="table-wrap">
        <table class="t" data-saved-backups-table>
          <thead>
            <tr>
              <th>الوقت</th>
              <th>السبب</th>
              <th>المكان</th>
              <th>الحجم</th>
              <th>الفحص</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="savedBackups.length === 0">
              <td colspan="6" class="muted" style="text-align: center; padding: 18px">
                {{ loading ? 'جاري تحميل النسخ...' : 'لا توجد نسخ محفوظة بعد — اضغط «خد نسخة دلوقتي».' }}
              </td>
            </tr>
            <tr
              v-for="b in savedBackups"
              :key="b.id"
              class="hov"
              :data-saved-backup-row="b.id"
            >
              <td><bdi dir="auto">{{ formatBackupTime(b.createdAtUnixMs) }}</bdi></td>
              <td><bdi dir="auto">{{ b.reason }}</bdi></td>
              <td class="muted"><bdi dir="auto">{{ formatBackupLocation(b.usbCopied) }}</bdi></td>
              <td class="mono" dir="ltr">{{ formatBackupSize(b.totalLen) }}</td>
              <td>
                <span
                  :class="['tag', formatBackupVerifyBadge(b.verified).ok ? 'ok' : '']"
                  :data-backup-verified="b.verified ? 'true' : 'false'"
                >
                  <Icon v-if="b.verified" name="check" />
                  <span>{{ b.verified ? 'سليمة' : formatBackupVerifyBadge(b.verified).text }}</span>
                </span>
              </td>
              <td>
                <button
                  type="button"
                  class="btn sm"
                  data-backup-restore-btn
                  :disabled="restoringId === b.id"
                  @click="onRestoreBackup(b)"
                >
                  {{ restoringId === b.id ? 'جاري...' : 'استرجاع' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.backup-policy-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.backup-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.backup-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.backup-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
</style>
