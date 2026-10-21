/**
 * The GSMArena page of a registered phone (owner request 2026-10-21).
 *
 * Every phone the shop registers is stored with a name built from its details
 * («Samsung Galaxy A54 128GB», «iPhone 13 مستعمل فئة A»). GSMArena's quick
 * search takes exactly that kind of name, so the mark beside a phone needs no
 * new data — only the store's name minus the words GSMArena does not search by:
 * the storage size, and the shop's own used-phone grade.
 *
 * Pure functions on purpose: the term a phone is searched by is a rule, and a
 * rule is testable without a browser or a network.
 */

/** Storage and RAM tokens («128GB», «8 GB», «1TB») are not part of a model name. */
const STORAGE_TOKEN = /\b\d+(?:\.\d+)?\s?(?:gb|tb)\b/gi;

/**
 * The shop's own words on a used phone's name — GSMArena knows neither.
 * No `\b` around the Arabic words: JavaScript's word boundary is ASCII, and an
 * Arabic letter never forms one.
 */
const SHOP_WORDS = /(?:مستعمل|فئة)\s*[ABC]?/gi;

/**
 * The model name GSMArena is asked for: the stored product name without the
 * storage size, the RAM word, the used-grade tail, and doubled spaces.
 */
export function gsmArenaSearchTerm(productName: string): string {
  return productName
    .replace(STORAGE_TOKEN, ' ')
    .replace(/\bram\b/gi, ' ')
    .replace(SHOP_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The GSMArena quick-search address for one registered phone, or `''` when its
 * name leaves nothing to search for.
 *
 * `results.php3?sQuickSearch=yes&sName=…` is GSMArena's own search box as a
 * URL: it lists the matching models, and the shopkeeper taps the one in hand —
 * the app never claims to know the exact page of a device.
 */
export function gsmArenaUrl(productName: string): string {
  const term = gsmArenaSearchTerm(productName);
  if (term === '') return '';
  return `https://www.gsmarena.com/results.php3?sQuickSearch=yes&sName=${encodeURIComponent(term)}`;
}
