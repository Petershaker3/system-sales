// A quiet icon for a product tile: its category's (ADR-018 §1), or — for a
// product with no category, or one whose category has the plain tag — a guess
// from its name, which beats the same tag on every tile. Pure.

import { normalize } from '../../ui/arabic.ts';
import { ICONS } from '../../ui/icons.ts';
import type { IconName } from '../../ui/icons.ts';

const RULES: readonly [RegExp, IconName][] = [
  // Order matters. «كارت ميموري» is memory and «كارت شحن» a top-up card; an
  // accessory names its brand too («شاحن سامسونج»), so the phone rule — which
  // also matches brand names — comes last.
  [/ميموري|فلاشه|memory|micro ?sd/, 'memory-stick'],
  [/رصيد|كارت شحن|كروت شحن|فكه/, 'credit-card'],
  [/شاحن|شحن|charger|باور ?بانك|power ?bank/, 'battery-charging'],
  [/كابل|cable|وصله|usb|تايب/, 'cable'],
  [/سماع|ايربودز|هيدفون|headphone|earbuds|airpods/, 'headphones'],
  [/ساعه|watch/, 'watch'],
  [/اسكرينه|اسكرين|شاشه|زجاج|حمايه|screen|glass/, 'shield'],
  [/جراب|كفر|case|cover/, 'package'],
  [/موبايل|تليفون|هاتف|phone|iphone|ايفون|سامسونج|شاومي|ريلمي|اوبو|هواوي|انفنكس|نوكيا/, 'smartphone'],
];

/** A stored icon name, if the app can draw it. */
export function asIconName(name: string): IconName | null {
  return Object.prototype.hasOwnProperty.call(ICONS, name) ? (name as IconName) : null;
}

/** The product's own name decides first; its category's words only when the name says nothing. */
export function iconFor(name: string, categoryWords = ''): IconName {
  for (const text of [name, categoryWords]) {
    const hay = normalize(text);
    if (hay === '') continue;
    for (const [pattern, icon] of RULES) if (pattern.test(hay)) return icon;
  }
  return 'tag';
}

/** A tile's icon: the category's when it says something, else a guess from the name. */
export function tileIcon(name: string, categoryIcon: string | null, categoryWords = ''): IconName {
  const own = categoryIcon === null ? null : asIconName(categoryIcon);
  if (own !== null && own !== 'tag') return own;
  return iconFor(name, categoryWords);
}
