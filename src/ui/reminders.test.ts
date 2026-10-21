// Unit tests for the system's reminders & notes (owner request 2026-10-22).
// Run: npm run test:unit
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addDaysISO,
  addMonthsISO,
  addReminder,
  completeReminder,
  dueCount,
  isDue,
  MAX_REMINDERS,
  parseReminders,
  reminderProblem,
  removeReminder,
  serializeReminders,
  sortReminders,
  todayISO,
  type Reminder,
} from './reminders.ts';

const rent: Reminder = {
  id: 'rm-rent',
  text: 'أسد إيجار المحل',
  dueDate: '2026-10-01',
  repeat: 'monthly',
  createdAtMs: 1,
};
const net: Reminder = {
  id: 'rm-net',
  text: 'أدفع النت',
  dueDate: '2026-10-25',
  repeat: 'none',
  createdAtMs: 2,
};
const note: Reminder = {
  id: 'rm-note',
  text: 'أشتري النواقص',
  dueDate: null,
  repeat: 'none',
  createdAtMs: 3,
};

test('the calendar helpers stay on the local calendar', () => {
  assert.equal(todayISO(new Date(2026, 9, 21, 23, 59).getTime()), '2026-10-21');
  assert.equal(addDaysISO('2026-10-30', 7), '2026-11-06', 'a week can cross a month');
  assert.equal(addMonthsISO('2026-01-31', 1), '2026-02-28', 'the rent of the 31st lands on the 28th');
  assert.equal(addMonthsISO('2026-12-15', 1), '2027-01-15', 'and crosses the year');
  assert.equal(addMonthsISO('مش تاريخ', 1), 'مش تاريخ', 'garbage in, garbage out — unchanged');
});

test('a reminder needs words, and only words', () => {
  assert.equal(reminderProblem(''), 'اكتب التذكير الأول');
  assert.equal(reminderProblem('  '), 'اكتب التذكير الأول');
  assert.equal(reminderProblem('أدفع النت'), '');
});

test('reminders round-trip through storage; garbage yields an empty wall', () => {
  assert.deepEqual(parseReminders(serializeReminders([rent, net, note])), [rent, net, note]);
  assert.deepEqual(parseReminders(null), []);
  assert.deepEqual(parseReminders('مش JSON'), []);
  assert.deepEqual(parseReminders('{"text":"x"}'), [], 'an object is not a list');
  assert.deepEqual(parseReminders('[{"id":"a"}]'), [], 'a line without words is not a reminder');
  assert.deepEqual(
    parseReminders('[{"id":"a","text":"إيجار","dueDate":"31/12/2026","repeat":"yearly","createdAtMs":-4}]'),
    [{ id: 'a', text: 'إيجار', dueDate: null, repeat: 'none', createdAtMs: 0 }],
    'a bad date is no date, an unknown repeat is no repeat, a negative time is zero',
  );
  const many: Reminder[] = [];
  for (let i = 0; i < MAX_REMINDERS + 10; i += 1) many.push({ ...note, id: `rm-${i}` });
  const parsed = parseReminders(serializeReminders(many));
  assert.equal(parsed.length, MAX_REMINDERS);
  assert.equal(parsed[0]!.id, 'rm-10', 'when the wall is full the oldest notes give way');
});

test('due is today or earlier, and a note has no due', () => {
  const today = '2026-10-21';
  assert.equal(isDue(rent, today), true, 'the rent of the 1st is overdue');
  assert.equal(isDue(net, today), false, 'the 25th is not here yet');
  assert.equal(isDue(note, today), false, 'a dateless note is never due');
  assert.equal(dueCount([rent, net, note], today), 1);
});

test('«تم» moves a repeating bill to its next date and removes a one-off', () => {
  const today = '2026-10-21';
  const afterRent = completeReminder([rent, net, note], 'rm-rent', today);
  assert.equal(afterRent.length, 3, 'the rent stays on the wall');
  assert.equal(afterRent[0]!.dueDate, '2026-11-01', 'counted from the due date, not from the late payment');
  assert.equal(isDue(afterRent[0]!, today), false);

  const veryLate = completeReminder([{ ...rent, dueDate: '2026-08-01' }], 'rm-rent', today);
  assert.equal(veryLate[0]!.dueDate, today, 'a bill two months late comes back due now, not in the past');

  const afterNet = completeReminder([rent, net, note], 'rm-net', today);
  assert.equal(afterNet.length, 2, 'a one-off goes away when it is done');
  const afterNote = completeReminder([rent, net, note], 'rm-note', today);
  assert.equal(afterNote.length, 2, 'and so does a dateless note');
  assert.deepEqual(completeReminder([rent], 'مش موجود', today), [rent]);
});

test('the list reads: overdue first, then the dated future, then the notes', () => {
  const sorted = sortReminders([note, net, rent], '2026-10-21');
  assert.deepEqual(sorted.map((r) => r.id), ['rm-rent', 'rm-net', 'rm-note']);
});

test('the wall keeps its size as reminders are added and removed', () => {
  let wall: Reminder[] = [];
  for (let i = 0; i < MAX_REMINDERS + 3; i += 1) {
    wall = addReminder(wall, { ...note, id: `rm-${i}` });
  }
  assert.equal(wall.length, MAX_REMINDERS);
  assert.equal(wall[0]!.id, 'rm-3');
  assert.equal(removeReminder(wall, 'rm-4').length, MAX_REMINDERS - 1);
  assert.deepEqual(removeReminder(wall, 'مش موجود'), wall);
});
