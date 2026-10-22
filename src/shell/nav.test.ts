// The rail (`shell/nav.ts`): who may see a screen, and which screens a phone has no
// use for. Both halves are presentation — the permission behind every entry is
// enforced in Rust (`spec:210`) — so this test is about the list a person is offered,
// not about authority.
import assert from 'node:assert/strict';
import test from 'node:test';

import { navFor, roleName, TITLES, NAV } from './nav.ts';

test('the owner sees every screen, the seller sees none of the owner-only ones', () => {
  const manager = navFor('manager').map((item) => item.id);
  const seller = navFor('sales').map((item) => item.id);
  assert.ok(manager.includes('settings') && manager.includes('store'));
  assert.ok(!seller.includes('settings') && !seller.includes('store') && !seller.includes('reports'));
  assert.ok(
    !seller.includes('expenses'),
    'the expenses section is the owner’s view of the shop’s money, like the reports beside it',
  );
  assert.ok(seller.includes('pos') && seller.includes('sales'));
});

test('a phone drops «الموبايل» and gains «الالتقاط» (`ADR-042`)', () => {
  // The «الموبايل» screen is the computer's own link panel and preview; the
  // handset gets its capture screen instead. Neither device is offered the
  // other's half, which is the difference between an integrated shop and two
  // systems that each show a picture of themselves.
  assert.ok(navFor('manager').some((item) => item.id === 'mobile'));
  assert.ok(!navFor('manager', true).some((item) => item.id === 'mobile'));
  assert.ok(
    navFor('manager', true).some((item) => item.id === 'capture'),
    'a handset needs its own capture screen',
  );
  assert.ok(
    !navFor('manager').some((item) => item.id === 'capture'),
    'the computer shows the inbox, not a camera',
  );
  assert.deepEqual(
    navFor('manager').map((item) => item.id),
    ['pos', 'sales', 'wallets', 'repairs', 'store', 'reports', 'expenses', 'mobile', 'settings'],
    'the desktop rail, with the phone preview where it always was',
  );
  assert.deepEqual(
    navFor('manager', true).map((item) => item.id),
    ['pos', 'sales', 'wallets', 'repairs', 'store', 'reports', 'expenses', 'capture', 'settings'],
    'the same shop on a phone: preview out, capture in, same place in the rail',
  );
  assert.deepEqual(
    navFor('sales', true).map((item) => item.id),
    ['pos', 'sales', 'wallets', 'repairs', 'capture'],
    'a seller on a phone keeps the till and gains the camera',
  );
  assert.equal(navFor('sales', true)[0]?.id, 'pos', 'the till stays first');
});

test('every screen id has a title and a place in NAV', () => {
  for (const item of NAV) {
    assert.ok(TITLES[item.id], `${item.id} needs a top-bar title`);
  }
  assert.equal(roleName('manager'), 'المالك');
  assert.equal(roleName('sales'), 'بيّاع');
});

test('«الإعدادات» is not a section: it sits apart, at the foot of the rail', async () => {
  const { navSectionsFor, settingsNavItem } = await import('./nav.ts');
  const sections = navSectionsFor('manager').map((item) => item.id);
  assert.ok(!sections.includes('settings'), 'the door to the shop’s setup is not one of its pages');
  assert.equal(settingsNavItem()?.label, 'الإعدادات');
  assert.ok(sections.includes('store') && sections.includes('pos'));
  // A seller has no settings door at all, and no owner screens either.
  assert.ok(!navSectionsFor('sales').some((item) => item.id === 'store'));
});

test('the rail order is the owner’s, and nothing is ever lost', async () => {
  const { orderSections, parseNavOrder, moveSection, SECTION_ORDER } = await import('./nav.ts');
  const { navSectionsFor } = await import('./nav.ts');
  const items = navSectionsFor('manager');

  // An empty stored order is «what this build ships».
  assert.deepEqual(parseNavOrder(''), []);
  assert.deepEqual(
    orderSections(items, parseNavOrder('')).map((i) => i.id),
    items.map((i) => i.id),
  );

  // A stored order puts its sections first, in the given order.
  assert.deepEqual(
    orderSections(items, parseNavOrder('store,pos')).slice(0, 2).map((i) => i.id),
    ['store', 'pos'],
  );

  // A stored order from an older (or newer) build cannot drop a screen, invent
  // one, or repeat one.
  assert.deepEqual(parseNavOrder('store,store,,wat,pos'), ['store', 'pos']);
  assert.deepEqual(parseNavOrder('store'), ['store']);
  const ordered = orderSections(items, parseNavOrder('store')).map((i) => i.id);
  assert.equal(ordered.length, items.length);
  assert.deepEqual([...ordered].sort(), items.map((i) => i.id).sort());

  // Moving is a swap, and the ends are walls rather than corruption.
  const base = [...SECTION_ORDER];
  assert.deepEqual(moveSection(base, 'pos', 1).slice(0, 2), ['sales', 'pos']);
  assert.deepEqual(moveSection(base, 'pos', -1).slice(0, 2), ['pos', 'sales']);
  assert.deepEqual(moveSection(base, 'capture', 1), base);
});
