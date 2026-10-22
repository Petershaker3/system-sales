// The rail (docs/ui/mockup-v1/app.js, NAV). Only screens that exist in this
// build are listed — no button leads to a screen that is not there yet.
//
// Hiding a screen from a seller is presentation, not security: every command
// behind these screens checks the permission in Rust (`spec:210`).

import type { Role } from '../api/identity';
import type { IconName } from '../ui/icons';

export type ScreenId =
  | 'pos'
  | 'sales'
  | 'wallets'
  | 'repairs'
  | 'store'
  | 'phones'
  | 'reports'
  | 'expenses'
  | 'mobile'
  | 'capture'
  | 'settings'
  | 'guide';

export interface NavItem {
  readonly id: ScreenId;
  readonly label: string;
  readonly icon: IconName;
  /** Shown to the owner (role `manager`) only. */
  readonly ownerOnly: boolean;
  /**
   * Shown on a handset only (`ADR-042`). The phone's capture screen has no
   * desktop twin: the computer's half of that job is the inbox on «الموبايل», and
   * a till that offered both would be the two-systems confusion again.
   */
  readonly phoneOnly?: boolean;
}

export const NAV: readonly NavItem[] = [
  { id: 'pos', label: 'البيع', icon: 'shopping-cart', ownerOnly: false },
  { id: 'sales', label: 'المبيعات', icon: 'receipt-text', ownerOnly: false },
  { id: 'wallets', label: 'المحافظ', icon: 'wallet', ownerOnly: false },
  { id: 'repairs', label: 'الصيانة', icon: 'wrench', ownerOnly: false },
  { id: 'store', label: 'المخزن', icon: 'boxes', ownerOnly: true },
  // The handsets, apart from the rest of the stock: a phone shop's own question
  // — this model, this IMEI, this cost — not a filter inside «المخزن».
  { id: 'phones', label: 'الهواتف', icon: 'smartphone', ownerOnly: true },
  { id: 'reports', label: 'التقارير', icon: 'chart-column', ownerOnly: true },
  // «المصاريف» sits beside «التقارير» because it answers the same question from the
  // other side: what came in is the reports screen, what went out is this one
  // (`ADR-043`). Owner-only, like the reports it belongs with.
  { id: 'expenses', label: 'المصاريف', icon: 'hand-coins', ownerOnly: true },
  { id: 'mobile', label: 'الموبايل', icon: 'smartphone', ownerOnly: false },
  { id: 'capture', label: 'الالتقاط', icon: 'camera', ownerOnly: false, phoneOnly: true },
  { id: 'settings', label: 'الإعدادات', icon: 'settings', ownerOnly: true },
];

export const TITLES: Record<ScreenId, string> = {
  pos: 'البيع',
  sales: 'المبيعات',
  wallets: 'المحافظ',
  repairs: 'الصيانة والسوفت وير',
  store: 'المخزن',
  phones: 'الهواتف',
  reports: 'التقارير',
  expenses: 'المصاريف',
  mobile: 'تطبيق الموبايل',
  capture: 'الالتقاط من الموبايل',
  settings: 'الإعدادات',
  guide: 'دليل السيستم الشامل',
};

/**
 * The rail for one person on one kind of screen.
 *
 * The role decides who may see a screen at all; the device removes «الموبايل» on a
 * phone, because that screen is the desktop's preview of the phone helper (`ADR-037`)
 * and a phone has no reason to look at a picture of itself. Removing a rail button is
 * presentation: the screens behind it are still guarded in Rust (`spec:210`).
 */
export function navFor(role: Role, phone: boolean = false): NavItem[] {
  return NAV.filter(
    (item) =>
      (!item.ownerOnly || role === 'manager') &&
      !(phone && item.id === 'mobile') &&
      (!item.phoneOnly || phone),
  );
}

/**
 * The rail's sections, in the order this build ships.
 *
 * «الإعدادات» is deliberately absent: it is not a section of the shop, it is the
 * one door to the shop's own setup, so it sits alone at the bottom of the rail
 * (`AppShell`). Rust carries the same list in `parse_nav_order`
 * (`domain/settings/appearance.rs`), because a stored order must never name a
 * screen this build has not got.
 */
export const SECTION_ORDER: readonly ScreenId[] = [
  'pos',
  'sales',
  'wallets',
  'repairs',
  'store',
  'phones',
  'reports',
  'expenses',
  'mobile',
  'capture',
];

/** The sections a person may see, without the settings door at the bottom. */
export function navSectionsFor(role: Role, phone: boolean = false): NavItem[] {
  return navFor(role, phone).filter((item) => item.id !== 'settings');
}

/** «الإعدادات», for the button that sits apart from the sections. */
export function settingsNavItem(): NavItem | undefined {
  return NAV.find((item) => item.id === 'settings');
}

/**
 * Read a stored order (`ui.nav_order`) into screen ids.
 *
 * Anything this build does not ship is dropped rather than trusted, and a repeat
 * is dropped too: a stored string can be older than the build that reads it.
 */
export function parseNavOrder(raw: string): ScreenId[] {
  const seen: ScreenId[] = [];
  for (const part of raw.split(',')) {
    const token = part.trim();
    const match = SECTION_ORDER.find((id) => id === token);
    if (match !== undefined && !seen.includes(match)) seen.push(match);
  }
  return seen;
}

/**
 * The rail, in the shop's order.
 *
 * Sections the stored order names come first in that order; anything it left
 * out (a section added by a later build, or a rail the owner never arranged)
 * follows in the built-in order. Nothing is ever lost — a screen missing from
 * the rail would be a shop that cannot reach part of its own till.
 */
export function orderSections(
  items: readonly NavItem[],
  order: readonly ScreenId[],
): NavItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const out: NavItem[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item !== undefined) {
      out.push(item);
      byId.delete(id);
    }
  }
  for (const id of SECTION_ORDER) {
    const item = byId.get(id);
    if (item !== undefined) {
      out.push(item);
      byId.delete(id);
    }
  }
  for (const item of items) {
    if (byId.has(item.id)) out.push(item);
  }
  return out;
}

/** Move one section one place up (`-1`) or down (`+1`) in the stored order. */
export function moveSection(
  order: readonly ScreenId[],
  id: ScreenId,
  delta: -1 | 1,
): ScreenId[] {
  const next = [...order];
  const from = next.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/** «المالك» for the manager role, «بيّاع» for sales — the owner's own words. */
export function roleName(role: Role): string {
  return role === 'manager' ? 'المالك' : 'بيّاع';
}

const AVATAR_COLOURS = ['#1d4f91', '#0f6e5a', '#8a3b12', '#6b2f73', '#0e6170', '#7a5a00', '#2f3437'];

/** A steady colour per person, so the same name always wears the same circle. */
export function avatarColour(id: string): string {
  let h = 2166136261;
  for (const ch of id) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return AVATAR_COLOURS[(h >>> 0) % AVATAR_COLOURS.length] ?? '#1d4f91';
}
