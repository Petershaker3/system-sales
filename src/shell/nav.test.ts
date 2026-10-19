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
  assert.ok(seller.includes('pos') && seller.includes('sales'));
});

test('a phone drops «الموبايل», the desktop preview of itself', () => {
  assert.ok(navFor('manager').some((item) => item.id === 'mobile'));
  assert.ok(!navFor('manager', true).some((item) => item.id === 'mobile'));
  assert.deepEqual(
    navFor('sales', true).map((item) => item.id),
    navFor('sales')
      .map((item) => item.id)
      .filter((id) => id !== 'mobile'),
    'a phone loses the preview and nothing else — the till stays first'
  );
  assert.equal(navFor('sales', true)[0]?.id, 'pos');
});

test('every screen id has a title and a place in NAV', () => {
  for (const item of NAV) {
    assert.ok(TITLES[item.id], `${item.id} needs a top-bar title`);
  }
  assert.equal(roleName('manager'), 'المالك');
  assert.equal(roleName('sales'), 'بيّاع');
});
