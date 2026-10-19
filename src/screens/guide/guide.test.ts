import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUIDE_CATEGORIES,
  GUIDE_TOPICS,
  KEYBOARD_SHORTCUTS,
  filterGuideShortcuts,
  filterGuideTopics,
} from './guide.ts';

describe('In-App System Guide (دليل السيستم الشامل)', () => {
  it('covers all categories and returns all topics under "all"', () => {
    assert.ok(GUIDE_CATEGORIES.length >= 10);
    assert.equal(
      filterGuideTopics(GUIDE_TOPICS, 'all', '').length,
      GUIDE_TOPICS.length,
    );
  });

  it('filters topics by category and multi-word Arabic search query', () => {
    const repairTopics = filterGuideTopics(GUIDE_TOPICS, 'repairs', '');
    assert.equal(repairTopics.length, 1);
    assert.ok(repairTopics[0]!.title.includes('الصيانة والسوفت وير'));

    const searchSw = filterGuideTopics(
      GUIDE_TOPICS,
      'all',
      'فلوس السوفت وير لوحدها',
    );
    assert.ok(searchSw.length >= 2);

    const searchBackup = filterGuideTopics(
      GUIDE_TOPICS,
      'all',
      'MSHOP-BACKUP',
    );
    assert.equal(searchBackup.length, 1);
    assert.equal(searchBackup[0]!.id, 'mobile-companion-and-backups');
  });

  it('lists all F1-F12 keyboard shortcuts and filters them by key or action', () => {
    assert.ok(KEYBOARD_SHORTCUTS.some((s) => s.key === 'F1'));
    assert.ok(KEYBOARD_SHORTCUTS.some((s) => s.key === 'F10'));
    const f10 = filterGuideShortcuts(KEYBOARD_SHORTCUTS, 'مرتجع');
    assert.equal(f10.length, 1);
    assert.equal(f10[0]!.key, 'F10');
  });
});
