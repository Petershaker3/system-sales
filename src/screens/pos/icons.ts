// A quiet icon for a product tile, guessed from its name and department.
// Products carry no icon yet (categories with icons wait for plan item 1.2),
// and a guess is better than the same tag on every tile. Pure.

import { normalize } from '../../ui/arabic.ts';
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

/** The product's own name decides first; its department only when the name says nothing. */
export function iconFor(name: string, departmentName = ''): IconName {
  for (const text of [name, departmentName]) {
    const hay = normalize(text);
    if (hay === '') continue;
    for (const [pattern, icon] of RULES) if (pattern.test(hay)) return icon;
  }
  return 'tag';
}
