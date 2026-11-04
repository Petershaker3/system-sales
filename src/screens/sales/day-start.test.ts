import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  addDays,
  dayEnd,
  dayStart,
  setBusinessDayStartHour,
} from './analytics.ts';

afterEach(() => setBusinessDayStartHour(0));

test('the day starts at midnight by default', () => {
  const night = new Date(2026, 10, 2, 1, 30);
  assert.equal(dayStart(night).getTime(), new Date(2026, 10, 2, 0, 0).getTime());
});

test('from the second day: a sale at 1:30 AM stays on the day that ended', () => {
  // «من أول تاني يوم» with 5 AM: the owner sells at half past midnight while the
  // shop is still open, and that money belongs to yesterday's till.
  setBusinessDayStartHour(5);
  const night = new Date(2026, 10, 2, 1, 30);
  assert.equal(dayStart(night).getTime(), new Date(2026, 10, 1, 5, 0).getTime());
});

test('from the second day: after 5 AM it is the new day', () => {
  setBusinessDayStartHour(5);
  const morning = new Date(2026, 10, 2, 6, 0);
  assert.equal(dayStart(morning).getTime(), new Date(2026, 10, 2, 5, 0).getTime());
});

test('the day ends one millisecond before the next one starts', () => {
  setBusinessDayStartHour(5);
  const noon = new Date(2026, 10, 2, 12, 0);
  const end = dayEnd(noon);
  assert.equal(end.getTime(), new Date(2026, 10, 3, 5, 0).getTime() - 1);
});

test('adding a day keeps the hour, so the window does not slide to midnight', () => {
  const start = new Date(2026, 10, 2, 5, 0);
  assert.equal(addDays(start, 1).getTime(), new Date(2026, 10, 3, 5, 0).getTime());
});

test('a nonsense hour falls back to midnight', () => {
  setBusinessDayStartHour(99);
  const night = new Date(2026, 10, 2, 1, 30);
  assert.equal(dayStart(night).getTime(), new Date(2026, 10, 2, 0, 0).getTime());
});
