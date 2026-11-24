// Search text normalisation (docs/ui/mockup-v1/pos.js, «البحث الذكي»).
//
// One spelling for the letters people type interchangeably: أ إ آ ٱ → ا,
// ة → ه, ى → ي, ؤ → و, ئ → ي; no diacritics or tatweel; Latin digits; lower
// case; single spaces. Applied to both the query and the indexed text, so
// «شاحن ايفون» finds «شاحن آيفون» and «١٢» finds «12».

import { toLatinDigits } from './format.ts';

export function normalize(text: string): string {
  return toLatinDigits(text.toLowerCase())
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}
