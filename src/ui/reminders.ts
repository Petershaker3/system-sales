// Reminders and notes for the system as a whole (owner request 2026-10-22):
// «يفكرني إني أسد إيجار المحل أو أدفع النت أو أشتري النواقص».
//
// A reminder is a line of text with an optional due date and an optional
// repeat. They live on this device (`localStorage`) like the pinned expense
// bills: no schema, no server, nothing to migrate — and nothing money-like:
// a reminder that pays the rent is still an expense row the owner records.
//
// The pure half of this module is tested in Node (`reminders.test.ts`); the
// reactive half is what the bell in the topbar renders.

import { computed, ref } from 'vue';

/** How a bill comes back: once, every week, or every month. */
export type ReminderRepeat = 'none' | 'weekly' | 'monthly';

export interface Reminder {
  id: string;
  text: string;
  /** Local `YYYY-MM-DD`, or `null` for a note with no date at all. */
  dueDate: string | null;
  repeat: ReminderRepeat;
  createdAtMs: number;
}

export const REMINDERS_KEY = 'mshop.reminders.v1';

/** Adding stops at 50; existing notes are never silently discarded. */
export const MAX_REMINDERS = 50;

const REPEATS: readonly ReminderRepeat[] = ['none', 'weekly', 'monthly'];

/** The shop's local today, as the calendar day the bell compares against. */
export function todayISO(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `iso + days`, staying on the local calendar (the string, not a timezone). */
export function addDaysISO(iso: string, days: number): string {
  const parts = ISO_DATE.exec(iso);
  if (parts === null) return iso;
  const d = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]) + days);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** `iso + months`, clamped: the rent of the 31st comes back on the 28th. */
export function addMonthsISO(iso: string, months: number): string {
  const parts = ISO_DATE.exec(iso);
  if (parts === null) return iso;
  const year = Number(parts[1]);
  const month0 = Number(parts[2]) - 1;
  const day = Number(parts[3]);
  const target = new Date(year, month0 + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const month = String(target.getMonth() + 1).padStart(2, '0');
  return `${target.getFullYear()}-${month}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

/** What is missing before a line becomes a reminder. Empty = ready. */
export function reminderProblem(text: string): string {
  if (text.trim() === '') return 'اكتب التذكير الأول';
  return '';
}

/** Due today or overdue — a note with no date is never «due». */
export function isDue(entry: Reminder, today: string): boolean {
  return entry.dueDate !== null && entry.dueDate <= today;
}

export function dueCount(list: readonly Reminder[], today: string): number {
  return list.filter((entry) => isDue(entry, today)).length;
}

/** Strictly read the existing on-device format. Bad data is never normalized
 * into a different record and then written over the original. */
export function parseReminders(raw: string | null): Reminder[] {
  if (raw === null || raw === '') return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('invalid reminders');
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('invalid reminder');
    const row = entry as Record<string, unknown>;
    const id = row['id'];
    const text = row['text'];
    const date = row['dueDate'];
    const repeat = row['repeat'];
    const created = row['createdAtMs'];
    if (typeof id !== 'string' || !id.trim() || ids.has(id) ||
        typeof text !== 'string' || !text.trim() || text.length > 200 ||
        !(date === null || (typeof date === 'string' && isCalendarDate(date))) ||
        !REPEATS.includes(repeat as ReminderRepeat) ||
        typeof created !== 'number' || !Number.isFinite(created) || created < 0) {
      throw new Error('invalid reminder');
    }
    ids.add(id);
    // Preserve additional fields from future versions rather than stripping them.
    return entry as Reminder;
  });
}

export function isCalendarDate(value: string): boolean {
  const parts = ISO_DATE.exec(value);
  if (!parts) return false;
  const y = Number(parts[1]), m = Number(parts[2]), d = Number(parts[3]);
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= (days[m - 1] ?? 0);
}

export function serializeReminders(list: readonly Reminder[]): string {
  return JSON.stringify(list);
}

export function addReminder(list: readonly Reminder[], entry: Reminder): Reminder[] {
  if (list.length >= MAX_REMINDERS) throw new Error('reminder limit');
  return [...list, entry];
}

export function removeReminder(list: readonly Reminder[], id: string): Reminder[] {
  return list.filter((kept) => kept.id !== id);
}

/**
 * «تم»: a repeating bill moves to its next due date instead of going away —
 * counted from the due date it had, so the rent stays on the 1st even when it
 * is paid on the 5th. A one-off (or a dateless note) is removed.
 */
export function completeReminder(
  list: readonly Reminder[],
  id: string,
  today: string
): Reminder[] {
  const out: Reminder[] = [];
  for (const entry of list) {
    if (entry.id !== id) {
      out.push(entry);
      continue;
    }
    if (entry.dueDate === null || entry.repeat === 'none') continue;
    const next =
      entry.repeat === 'weekly'
        ? addDaysISO(entry.dueDate, 7)
        : addMonthsISO(entry.dueDate, 1);
    out.push({ ...entry, dueDate: next < today ? today : next });
  }
  return out;
}

/** Due first (oldest first), then the dated future, then the dateless notes. */
export function sortReminders(
  list: readonly Reminder[],
  today: string
): Reminder[] {
  return [...list].sort((a, b) => {
    const aDue = isDue(a, today);
    const bDue = isDue(b, today);
    if (aDue !== bDue) return aDue ? -1 : 1;
    if (a.dueDate !== null && b.dueDate !== null && a.dueDate !== b.dueDate) {
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    if (a.dueDate !== null && b.dueDate === null) return -1;
    if (a.dueDate === null && b.dueDate !== null) return 1;
    return a.createdAtMs - b.createdAtMs;
  });
}

// --- The reactive half: one list, shared by the bell and the modal ------------

// Refuse writes when stored data cannot be read: a failed read must never turn
// into an apparently empty list that overwrites the original on the next save.
export const remindersStorageError = ref('');
let readFailed = false;
function readReminders(): Reminder[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = window.localStorage.getItem(REMINDERS_KEY);
    if (raw === null || raw === '') return [];
    return parseReminders(raw);
  } catch {
    readFailed = true;
    remindersStorageError.value = 'تعذّرت قراءة التذكيرات المحفوظة. لم يتم تغييرها؛ افحص التخزين وأعد فتح التطبيق.';
    return [];
  }
}

export const reminders = ref<Reminder[]>(readReminders());
export const remindersDue = computed(() => dueCount(reminders.value, todayISO()));

function persist(next: Reminder[]): boolean {
  if (readFailed) return false;
  try {
    if (typeof window === 'undefined') throw new Error('storage unavailable');
    window.localStorage.setItem(REMINDERS_KEY, serializeReminders(next));
    reminders.value = next;
    remindersStorageError.value = '';
    return true;
  } catch {
    remindersStorageError.value = 'تعذّر حفظ التذكيرات على هذا الجهاز؛ لم يتم حفظ التغيير.';
    return false;
  }
}

/** What the shop's own words are for each repeat, beside the bell's labels. */
export function repeatLabel(repeat: ReminderRepeat): string {
  if (repeat === 'weekly') return 'كل أسبوع';
  if (repeat === 'monthly') return 'كل شهر';
  return 'مرة واحدة';
}

export function pushReminder(text: string, dueDate: string | null, repeat: ReminderRepeat): string | null {
  if (reminderProblem(text) || (dueDate !== null && !isCalendarDate(dueDate))) throw new Error('invalid reminder');
  const entry: Reminder = {
    id: `rm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text: text.trim().slice(0, 200),
    dueDate,
    repeat: dueDate === null ? 'none' : repeat,
    createdAtMs: Date.now(),
  };
  return persist(addReminder(reminders.value, entry)) ? entry.id : null;
}

export function completeReminderById(id: string): boolean {
  return persist(completeReminder(reminders.value, id, todayISO()));
}

export function removeReminderById(id: string): boolean {
  return persist(removeReminder(reminders.value, id));
}
