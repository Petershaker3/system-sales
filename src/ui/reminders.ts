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

/** A wall of 50 is plenty; beyond it the oldest notes give way. */
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

function asReminder(value: unknown, fallbackId: string): Reminder | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const rawId = raw['id'];
  const rawText = raw['text'];
  const rawDue = raw['dueDate'];
  const rawRepeat = raw['repeat'];
  const rawCreated = raw['createdAtMs'];
  const id = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : fallbackId;
  const text = typeof rawText === 'string' ? rawText.trim().slice(0, 200) : '';
  if (text === '') return null;
  const dueDate = typeof rawDue === 'string' && ISO_DATE.test(rawDue) ? rawDue : null;
  const repeat: ReminderRepeat = REPEATS.includes(rawRepeat as ReminderRepeat)
    ? (rawRepeat as ReminderRepeat)
    : 'none';
  const createdAtMs =
    typeof rawCreated === 'number' && Number.isFinite(rawCreated) && rawCreated >= 0
      ? rawCreated
      : 0;
  return { id, text, dueDate, repeat, createdAtMs };
}

/** Read the stored reminders. Anything unreadable is treated as an empty list. */
export function parseReminders(raw: string | null): Reminder[] {
  if (raw === null || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Reminder[] = [];
  parsed.forEach((entry, index) => {
    const reminder = asReminder(entry, `rm-${index}`);
    if (reminder !== null && out.every((kept) => kept.id !== reminder.id)) out.push(reminder);
  });
  return out.slice(-MAX_REMINDERS);
}

export function serializeReminders(list: readonly Reminder[]): string {
  return JSON.stringify(list);
}

export function addReminder(list: readonly Reminder[], entry: Reminder): Reminder[] {
  return [...list, entry].slice(-MAX_REMINDERS);
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

function readReminders(): Reminder[] {
  try {
    if (typeof window === 'undefined') return [];
    return parseReminders(window.localStorage.getItem(REMINDERS_KEY));
  } catch {
    return [];
  }
}

export const reminders = ref<Reminder[]>(readReminders());

/** The number on the bell. Recomputed with every change of the list. */
export const remindersDue = computed(() => dueCount(reminders.value, todayISO()));

function persist(): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(REMINDERS_KEY, serializeReminders(reminders.value));
  } catch {
    // Private mode or a full disk: the reminders stay for this visit only.
  }
}

/** What the shop's own words are for each repeat, beside the bell's labels. */
export function repeatLabel(repeat: ReminderRepeat): string {
  if (repeat === 'weekly') return 'كل أسبوع';
  if (repeat === 'monthly') return 'كل شهر';
  return 'مرة واحدة';
}

export function pushReminder(text: string, dueDate: string | null, repeat: ReminderRepeat): string {
  const entry: Reminder = {
    id: `rm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text: text.trim().slice(0, 200),
    dueDate: dueDate !== null && ISO_DATE.test(dueDate) ? dueDate : null,
    repeat: dueDate === null ? 'none' : repeat,
    createdAtMs: Date.now(),
  };
  reminders.value = addReminder(reminders.value, entry);
  persist();
  return entry.id;
}

export function completeReminderById(id: string): void {
  reminders.value = completeReminder(reminders.value, id, todayISO());
  persist();
}

export function removeReminderById(id: string): void {
  reminders.value = removeReminder(reminders.value, id);
  persist();
}
