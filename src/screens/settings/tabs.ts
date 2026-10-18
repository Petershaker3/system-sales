/**
 * Pure helpers and tab definitions for the 8 Settings screens
 * (`docs/PLAN.md` §16, §19; `ADR-028`; `docs/ui/mockup-v1/views/settings.js` `S_TABS` & `setDevices`).
 */

import type { ReceiptModeChoice, ReceiptPaperChoice } from '../../ui/appearance.ts';
import type { IconName } from '../../ui/icons.ts';

export type SettingsTabId =
  | 'shop'
  | 'look'
  | 'catalog'
  | 'users'
  | 'pay'
  | 'receipt'
  | 'backup'
  | 'devices';

export type SettingsViewTab = 'all' | SettingsTabId;

export interface SettingsTabMeta {
  readonly id: SettingsTabId;
  readonly icon: IconName;
  readonly label: string;
}

export const SETTINGS_TABS: readonly SettingsTabMeta[] = [
  { id: 'shop', icon: 'store', label: 'المحل' },
  { id: 'look', icon: 'palette', label: 'الشكل' },
  { id: 'catalog', icon: 'tags', label: 'الأصناف والبيع' },
  { id: 'users', icon: 'users', label: 'المستخدمين والصلاحيات' },
  { id: 'pay', icon: 'wallet', label: 'المحافظ والدفع' },
  { id: 'receipt', icon: 'receipt', label: 'الإيصال والضمان' },
  { id: 'backup', icon: 'database', label: 'النسخ الاحتياطي' },
  { id: 'devices', icon: 'wifi', label: 'الأجهزة والطابعة' },
];

export function isTabSectionVisible(
  activeTab: SettingsViewTab,
  sectionTab: SettingsTabId,
): boolean {
  return activeTab === 'all' || activeTab === sectionTab;
}

export function selectSettingsTab(
  current: SettingsViewTab,
  clicked: SettingsViewTab,
): SettingsViewTab {
  if (clicked === 'all') return 'all';
  return current === clicked ? 'all' : clicked;
}

export function buildPrinterTogglePatch(
  enabled: boolean,
  currentReceiptMode: ReceiptModeChoice,
): {
  readonly printerEnabled: 'on' | 'off';
  readonly receiptMode?: ReceiptModeChoice;
} {
  const printerEnabled: 'on' | 'off' = enabled ? 'on' : 'off';
  if (
    !enabled &&
    (currentReceiptMode === 'print' || currentReceiptMode === 'both')
  ) {
    return { printerEnabled, receiptMode: 'wa' };
  }
  return { printerEnabled };
}

export function formatPrinterStatusSummary(
  printerEnabled: 'on' | 'off',
  paperWidthMm: ReceiptPaperChoice,
): {
  readonly title: string;
  readonly subtitle: string;
  readonly badge: string;
  readonly ready: boolean;
} {
  if (printerEnabled === 'on') {
    return {
      title: 'XP-80 (USB)',
      subtitle: `طابعة حرارية ${paperWidthMm} مم، والطباعة كصورة`,
      badge: 'جاهزة',
      ready: true,
    };
  }
  return {
    title: 'مفيش طابعة دلوقتي',
    subtitle:
      'الإيصال بيتبعت للعميل على واتساب: صورة الإيصال + رسالة الواتساب اللي في إعدادات الإيصال',
    badge: 'واتساب بس',
    ready: false,
  };
}
