<script setup lang="ts">
// «التذكيرات والملاحظات» (owner request 2026-10-22): the bell's window.
//
// One list for the whole system — the rent, the internet, the shortages. A
// line is text with an optional date and an optional repeat; «تم» on a
// repeating bill moves it to its next date instead of deleting it. All of it
// lives on this device (`ui/reminders.ts`), and nothing here touches money:
// paying the rent is still an expense row in «المصاريف».

import { computed, ref } from 'vue';

import { dg, fmtDate } from '../ui/format';
import Icon from '../ui/Icon.vue';
import Modal from '../ui/Modal.vue';
import {
  isDue,
  pushReminder,
  completeReminderById,
  reminders,
  reminderProblem,
  removeReminderById,
  repeatLabel,
  sortReminders,
  todayISO,
  type Reminder,
  type ReminderRepeat,
} from '../ui/reminders';
import { toast } from '../ui/toast';

const emit = defineEmits<{ close: [] }>();

const text = ref('');
const dueDate = ref('');
const repeat = ref<ReminderRepeat>('monthly');

const today = todayISO();
const list = computed(() => sortReminders(reminders.value, today));
const dueNow = computed(() => list.value.filter((entry) => isDue(entry, today)).length);

function isoToLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as number[];
  return fmtDate(new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function dueWord(entry: Reminder): string {
  if (entry.dueDate === null) return 'ملاحظة من غير ميعاد';
  if (entry.dueDate === today) return 'مستحق النهارده';
  if (entry.dueDate < today) return `متأخر من ${isoToLabel(entry.dueDate)}`;
  return `ميعاده ${isoToLabel(entry.dueDate)}`;
}

function add(): void {
  const problem = reminderProblem(text.value);
  if (problem !== '') {
    toast(problem, 'err');
    return;
  }
  pushReminder(text.value, dueDate.value === '' ? null : dueDate.value, repeat.value);
  toast('اتضاف التذكير', 'ok', 2500);
  text.value = '';
  dueDate.value = '';
}

function done(entry: Reminder): void {
  completeReminderById(entry.id);
  if (entry.dueDate !== null && entry.repeat !== 'none') {
    toast(`«${entry.text}» اتأجّل لـ${repeatLabel(entry.repeat)} الجاي`, 'ok', 3500);
  }
}
</script>

<template>
  <Modal
    title="التذكيرات والملاحظات"
    sub="يفكرك بإيجار المحل، النت، النواقص — أي حاجة. على جهازك، ومفيش منها فلوس بتتحرك."
    size="md"
    @close="emit('close')"
  >
    <div class="stack reminders" data-reminders-modal>
      <div class="reminder-add">
        <input
          v-model="text"
          type="text"
          maxlength="200"
          placeholder="مثال: أسد إيجار المحل"
          autocomplete="off"
          data-reminder-text
          data-autofocus
          @keydown.enter.prevent="add"
        />
        <input v-model="dueDate" type="date" data-reminder-due aria-label="ميعاد التذكير" />
        <select v-model="repeat" data-reminder-repeat aria-label="يتكرر إزاي">
          <option value="none">مرة واحدة</option>
          <option value="weekly">كل أسبوع</option>
          <option value="monthly">كل شهر</option>
        </select>
        <button type="button" class="btn primary sm" data-reminder-add @click="add">
          <Icon name="plus" /> ضيف
        </button>
      </div>
      <p v-if="dueDate === ''" class="muted hint" style="margin: 0">
        الميعاد والتكرار اختياري — من غير ميعاد بتفضل ملاحظة في القايمة.
      </p>

      <p v-if="list.length === 0" class="muted" data-reminders-empty style="margin: 6px 0 0">
        مفيش تذكيرات — ضيف أول واحدة فوق.
      </p>
      <div v-else class="reminder-list">
        <div
          v-for="entry in list"
          :key="entry.id"
          class="reminder-row"
          :class="{ due: isDue(entry, today) }"
          :data-reminder-row="entry.id"
        >
          <span class="reminder-body">
            <b><bdi dir="auto">{{ entry.text }}</bdi></b>
            <span class="muted" style="font-size: 0.8rem">
              {{ dueWord(entry) }}
              <template v-if="entry.dueDate !== null && entry.repeat !== 'none'">
                · {{ repeatLabel(entry.repeat) }}
              </template>
            </span>
          </span>
          <button
            type="button"
            class="btn sm soft"
            :data-reminder-done="entry.id"
            :title="entry.repeat !== 'none' && entry.dueDate !== null ? 'تم — ويتأجل للميعاد الجاي' : 'تم — وتشيله من القايمة'"
            @click="done(entry)"
          >
            <Icon name="check" /> تم
          </button>
          <button
            type="button"
            class="icon-btn sm ghost"
            :data-reminder-remove="entry.id"
            title="شيل التذكير"
            aria-label="شيل التذكير"
            @click="removeReminderById(entry.id)"
          >
            <Icon name="x" />
          </button>
        </div>
      </div>
    </div>
    <template #foot>
      <span class="muted" style="font-size: 0.82rem">
        المستحق النهارده أو متأخر: <b class="num" data-reminders-due-count>{{ dg(dueNow) }}</b>
      </span>
    </template>
  </Modal>
</template>

<style scoped>
.reminders {
  gap: 10px;
}
.reminder-add {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  gap: 8px;
  align-items: center;
}
.reminder-add input[type='text'] {
  min-width: 0;
}
@media (max-width: 640px) {
  .reminder-add {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .reminder-add input[type='text'] {
    grid-column: 1 / -1;
  }
}
.reminder-list {
  display: grid;
  gap: 6px;
  max-height: 50vh;
  overflow-y: auto;
}
.reminder-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.reminder-row.due {
  border-color: var(--danger, #c0392b);
}
.reminder-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
