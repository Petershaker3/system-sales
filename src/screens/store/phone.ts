// «موبايل جديد» (ADR-018 §2; the mockup's views/catalog.js, `niPhone`): the
// choices it offers and the name it previews. Rust builds the stored name with
// the same rule (`domain::catalog::phone_title`); both are tested on the same
// examples. Pure, so it is tested without a browser (phone.test.ts).

import type { BrandDeviceType, ConditionGrade, DeviceType } from '../../api/brands';

/** The storage chips, in GB (1 TB = 1024), as in the mockup. */
export const STORAGE_CHOICES = [32, 64, 128, 256, 512, 1024] as const;
/** The RAM chips, in GB; RAM is optional. */
export const RAM_CHOICES = [2, 3, 4, 6, 8, 12, 16] as const;

export const USED_GRADE_CHOICES: readonly {
  readonly code: ConditionGrade;
  readonly label: string;
  readonly hint: string;
}[] = [
  { code: 'A', label: 'A — زي الجديد', hint: 'ممتاز بدون خدوش' },
  { code: 'B', label: 'B — خدوش خفيفة', hint: 'استعمال نظيف' },
  { code: 'C', label: 'C — عيوب واضحة', hint: 'يحتاج توضيح العيب' },
];

export const USED_ACCESSORY_CHOICES: readonly {
  readonly key: string;
  readonly label: string;
}[] = [
  { key: 'box', label: 'علبة' },
  { key: 'charger', label: 'شاحن' },
  { key: 'receipt', label: 'فاتورة' },
];

export function gradeArabicLabel(grade: string | null | undefined): string {
  switch ((grade ?? '').trim().toUpperCase()) {
    case 'A':
      return 'فئة A (زي الجديد)';
    case 'B':
      return 'فئة B (خدوش خفيفة)';
    case 'C':
      return 'فئة C (عيوب واضحة)';
    default:
      return grade ? `فئة ${grade}` : '';
  }
}

/** «128GB», or «1TB» for a whole number of terabytes. */
export function storageLabel(gb: number): string {
  return gb >= 1024 && gb % 1024 === 0 ? `${gb / 1024}TB` : `${gb}GB`;
}

/** A model as the shop writes it: trimmed, inner spaces collapsed. */
export function cleanModel(model: string): string {
  return model.trim().split(/\s+/).filter(Boolean).join(' ');
}

/**
 * The company, the model and the storage — without the company when the model
 * already starts with it or with one of its lines («iPhone 16 128GB»).
 */
export function phoneTitle(brandName: string, lines: readonly string[], model: string, storageGb: number | null): string {
  const m = cleanModel(model);
  const low = m.toLowerCase();
  const brand = brandName.trim();
  const bare = brand === '' || low.startsWith(`${brand.toLowerCase()} `) || lines.some((l) => low.startsWith(l.toLowerCase()));
  return [bare ? '' : brand, m, storageGb === null ? '' : storageLabel(storageGb)].filter((p) => p !== '').join(' ');
}

/**
 * Auto-generated used-phone title matching `views/catalog.js` (`niUsed`) and
 * Rust `domain::unit::used_phone_title`:
 * `<Brand> <Model> <Storage> مستعمل فئة <A/B/C>`.
 */
export function usedPhoneTitle(
  brandName: string,
  lines: readonly string[],
  model: string,
  storageGb: number | null,
  grade: ConditionGrade,
): string {
  const base = phoneTitle(brandName, lines, model, storageGb);
  if (!base) return '';
  return `${base} مستعمل فئة ${grade}`;
}

/** Validate an optional 14-digit Egyptian National ID. */
export function isValidNationalId(raw: string): boolean {
  const digits = raw.trim().replace(/[\s-]/g, '');
  if (!digits) return true;
  return /^\d{14}$/.test(digits);
}

interface Offered {
  readonly deviceType: BrandDeviceType;
  readonly hidden: boolean;
}

/** The companies «موبايل جديد» offers for a touch or a keypad phone. */
export function brandsFor<B extends Offered>(brands: readonly B[], device: DeviceType): B[] {
  return brands.filter((b) => !b.hidden && (b.deviceType === 'both' || b.deviceType === device));
}
