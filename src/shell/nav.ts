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
  | 'reports'
  | 'mobile'
  | 'settings'
  | 'guide';

export interface NavItem {
  readonly id: ScreenId;
  readonly label: string;
  readonly icon: IconName;
  /** Shown to the owner (role `manager`) only. */
  readonly ownerOnly: boolean;
}

export const NAV: readonly NavItem[] = [
  { id: 'pos', label: 'البيع', icon: 'shopping-cart', ownerOnly: false },
  { id: 'sales', label: 'المبيعات', icon: 'receipt-text', ownerOnly: false },
  { id: 'wallets', label: 'المحافظ', icon: 'wallet', ownerOnly: false },
  { id: 'repairs', label: 'الصيانة', icon: 'wrench', ownerOnly: false },
  { id: 'store', label: 'المخزن', icon: 'boxes', ownerOnly: true },
  { id: 'reports', label: 'التقارير', icon: 'chart-column', ownerOnly: true },
  { id: 'mobile', label: 'الموبايل', icon: 'smartphone', ownerOnly: false },
  { id: 'settings', label: 'الإعدادات', icon: 'settings', ownerOnly: true },
];

export const TITLES: Record<ScreenId, string> = {
  pos: 'البيع',
  sales: 'المبيعات',
  wallets: 'المحافظ',
  repairs: 'الصيانة والسوفت وير',
  store: 'المخزن',
  reports: 'التقارير',
  mobile: 'تطبيق الموبايل',
  settings: 'الإعدادات',
  guide: 'دليل السيستم الشامل',
};

export function navFor(role: Role): NavItem[] {
  return NAV.filter((item) => !item.ownerOnly || role === 'manager');
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
