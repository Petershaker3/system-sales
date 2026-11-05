/**
 * The till's three quick actions, beside the search box (`2026-11-05`).
 *
 * The owner asked for one row: the camera, «إضافة صيانة / سوفت وير», and «فحص
 * الـIMEI» — same shape, same icon language, and a switch in Settings to hide any
 * of them. They are one row of the same thing (read or start something from the
 * invoice in front of you), so the code treats them as one list: the screen
 * renders whatever is not hidden, and Settings toggles the same list.
 *
 * What is stored is what to **hide**, not what to keep. A shop that never opened
 * this setting stores an empty string, so a fourth button added by a later build
 * appears on its own instead of being silently missing from every existing shop.
 */

import type { IconName } from '../../ui/icons.ts';

export type PosQuickAction = 'camera' | 'repair' | 'imei';

export interface PosQuickActionMeta {
  readonly id: PosQuickAction;
  /** Shown on the button and in Settings. */
  readonly label: string;
  /** The icon of the button — the camera and the IMEI check share one on purpose. */
  readonly icon: IconName;
  /** The line under the switch in Settings: what the button is for. */
  readonly hint: string;
}

/**
 * In the order they sit beside the search box.
 *
 * The camera and «فحص IMEI» carry the same `scan-barcode` icon: both read a code
 * with the camera, and two different pictures for one act is what made the row
 * look like three unrelated buttons.
 */
export const POS_QUICK_ACTIONS: readonly PosQuickActionMeta[] = [
  {
    id: 'camera',
    label: 'كاميرا',
    icon: 'scan-barcode',
    hint: 'بتقرا الباركود أو الـIMEI بكاميرا الجهاز وتكتبه في خانة البحث',
  },
  {
    id: 'repair',
    label: 'إضافة صيانة / سوفت وير',
    icon: 'wrench',
    hint: 'بتفتح تذكرة صيانة أو سوفت وير من غير ما تسيب الفاتورة',
  },
  {
    id: 'imei',
    label: 'فحص IMEI',
    icon: 'scan-barcode',
    hint: 'بتفحص رقم جهاز قبل ما تشتريه أو تبيعه',
  },
];

const IDS: readonly string[] = POS_QUICK_ACTIONS.map((action) => action.id);

/**
 * A stored hidden-list, cleaned: known ids only, no repeats, in the canonical
 * order.
 *
 * Unknown tokens are dropped rather than kept: the backend refuses them on write,
 * so the only way one reaches here is a database written by a newer build — and a
 * button this build does not have cannot be hidden on it.
 */
export function hiddenButtonList(raw: string): string {
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase();
    if (token !== '' && IDS.includes(token)) seen.add(token);
  }
  return POS_QUICK_ACTIONS.filter((action) => seen.has(action.id))
    .map((action) => action.id)
    .join(',');
}

/** Whether the till should show this action. */
export function isQuickActionShown(hidden: string, id: PosQuickAction): boolean {
  return !hiddenButtonList(hidden).split(',').includes(id);
}

/**
 * Flip one action, returning the new hidden-list.
 *
 * The list is always canonical, so «did the owner change anything?» is a string
 * compare and two devices that hid the same buttons store the same value.
 */
export function toggleQuickAction(hidden: string, id: PosQuickAction): string {
  const current = hiddenButtonList(hidden);
  const hiddenIds = new Set(current === '' ? [] : current.split(','));
  if (hiddenIds.has(id)) hiddenIds.delete(id);
  else hiddenIds.add(id);
  return POS_QUICK_ACTIONS.filter((action) => hiddenIds.has(action.id))
    .map((action) => action.id)
    .join(',');
}

/** How the row reads in Settings: «الكل ظاهر» or the names of the hidden ones. */
export function hiddenButtonsSummary(hidden: string): string {
  const list = hiddenButtonList(hidden);
  if (list === '') return 'الكل ظاهر';
  const names = POS_QUICK_ACTIONS.filter((action) => list.split(',').includes(action.id)).map(
    (action) => action.label
  );
  return names.length === POS_QUICK_ACTIONS.length ? 'كلهن مخفيين' : `مخفي: ${names.join('، ')}`;
}
