// The rules a delivery has to satisfy before it is sent to Rust (`0035`).
//
// Kept out of the screen so they can be tested without a browser, and kept *here*
// rather than only in Rust because the shopkeeper needs the refusal while he is
// still looking at the box he typed in: a round trip that comes back with
// `RECEIPT_DATE_INVALID` after a modal has closed is a worse answer than the field
// turning red.
//
// The rules themselves are the ones `0035` enforces in `ReceiptPaperwork::validate`
// and `receive_document`:
//
//   - a quantity is 1 or more whole pieces,
//   - a unit cost is piastres, never negative,
//   - a purchase day is a real calendar day, not just `YYYY-MM-DD` shaped,
//   - a supplier invoice reference is at most 60 characters after trimming,
//   - a note is at most 300 characters after trimming,
//   - an empty box means «none typed», which is not the same as an invalid value —
//     the first is allowed for every paper field, the second is never accepted,
//   - IMEIs, when they are given, are 15 digits that pass Luhn, unique in the
//     delivery, and never more than the pieces being received.

/** The longest supplier invoice reference the ledger column holds. */
export const REFERENCE_MAX_CHARS = 60;

/** The longest note the ledger column holds. */
export const NOTE_MAX_CHARS = 300;

/**
 * A whole number of pieces typed into a box, or `null`.
 *
 * Deliberately not `parseInt`: «2.5» and «٢ ثلاث» are not quantities, and rounding
 * either of them to 2 would record a delivery the shop did not take.
 */
export function parsePieces(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** Why this quantity cannot be received, or `''`. */
export function piecesProblem(raw: string): string {
  const quantity = parsePieces(raw);
  if (quantity === null) return 'الكمية لازم تكون عدد صحيح.';
  if (quantity < 1) return 'الكمية لازم تكون قطعة واحدة على الأقل.';
  return '';
}

/**
 * Why this purchase date cannot be recorded, or `''`.
 *
 * An empty box is fine — most deliveries arrive with no paper at all. A *typed* day
 * has to exist: «2026-02-31» matches the shape of a date and is not one, and storing
 * it would put a purchase on a day that never happened.
 */
export function purchaseDateProblem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return 'التاريخ بالشكل ده: 2026-11-05.';
  const year = Number(trimmed.slice(0, 4));
  const month = Number(trimmed.slice(5, 7));
  const day = Number(trimmed.slice(8, 10));
  if (year < 1900 || year > 2999) return 'السنة مش منطقية.';
  if (month < 1 || month > 12) return 'الشهر لازم يكون من 1 لـ 12.';
  const lastDay = new Date(year, month, 0).getDate();
  if (day < 1 || day > lastDay) return 'اليوم ده مش موجود في الشهر ده.';
  return '';
}

/** Why this invoice reference cannot be saved, or `''`. */
export function referenceProblem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed.length > REFERENCE_MAX_CHARS) {
    return `رقم الفاتورة أطول من ${REFERENCE_MAX_CHARS} حرف.`;
  }
  return '';
}

/** Why this note cannot be saved, or `''`. */
export function noteProblem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed.length > NOTE_MAX_CHARS) return `الملاحظة أطول من ${NOTE_MAX_CHARS} حرف.`;
  return '';
}

/**
 * Whether a delivery of `quantity` pieces may carry these IMEIs.
 *
 * The shop's rule is that an IMEI is never mandatory (`ADR-019`), so `0` serials for
 * `5` pieces is the ordinary case. What is refused is a *count* that could not be
 * true: more serials than pieces, or — when the shop asked for every piece to carry
 * one — fewer.
 */
export function imeiCountProblem(
  imeiCount: number,
  quantity: number,
  required: boolean
): string {
  if (imeiCount > quantity) return 'عدد أرقام الـ IMEI أكبر من الكمية.';
  if (required && imeiCount !== quantity) {
    return `وضع الـ IMEI إلزامي: سجّل ${quantity} رقم IMEI قبل الحفظ.`;
  }
  return '';
}

/**
 * The first thing wrong with the delivery form, in the order the form is read.
 *
 * One message at a time, because a shopkeeper fixes one field at a time: a list of
 * five errors beside five boxes is a refusal to say where to start.
 */
export interface DeliveryFormFacts {
  /** Whether the line names a product already on the shelf. */
  readonly existingProduct: boolean;
  /** Whether a product was actually chosen (`existingProduct` only). */
  readonly hasProduct: boolean;
  /** Whether a brand-new thing is being described (phone or counted item). */
  readonly creating: boolean;
  readonly newNameProblem?: string;
  readonly quantity: string;
  readonly unitCost: string;
  readonly purchaseDate: string;
  readonly reference: string;
  readonly note: string;
  readonly imeiCount: number;
  readonly imeiRequired: boolean;
  /** Whether the chosen product is tracked by serial. */
  readonly serial: boolean;
}

export function deliveryFormProblem(facts: DeliveryFormFacts): string {
  const quantityWhy = piecesProblem(facts.quantity);
  if (quantityWhy !== '') return quantityWhy;
  const quantity = parsePieces(facts.quantity) ?? 0;

  const cost = facts.unitCost.trim();
  if (cost === '') return 'اكتب سعر الوحدة.';
  // The cost is read as money elsewhere; what this checks is only that something was
  // typed. A zero is allowed — a gift or a write-off can genuinely cost nothing.
  if (!/^\d+(\.\d{1,2})?$/.test(cost.replace(/[,\s]/g, ''))) {
    return 'سعر الوحدة لازم يكون رقم، مثال: 40 أو 40.50.';
  }

  if (!facts.existingProduct && !facts.creating) return 'اختار الصنف الأول.';
  if (facts.existingProduct && !facts.hasProduct) return 'اختار الصنف الأول.';
  if (facts.creating && (facts.newNameProblem ?? '') !== '') return facts.newNameProblem ?? '';

  const dateWhy = purchaseDateProblem(facts.purchaseDate);
  if (dateWhy !== '') return dateWhy;
  const referenceWhy = referenceProblem(facts.reference);
  if (referenceWhy !== '') return referenceWhy;
  const noteWhy = noteProblem(facts.note);
  if (noteWhy !== '') return noteWhy;

  if (facts.serial) {
    const imeiWhy = imeiCountProblem(facts.imeiCount, quantity, facts.imeiRequired);
    if (imeiWhy !== '') return imeiWhy;
  }
  return '';
}
