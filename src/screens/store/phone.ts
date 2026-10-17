// «موبايل جديد» (ADR-018 §2; the mockup's views/catalog.js, `niPhone`): the
// choices it offers and the name it previews. Rust builds the stored name with
// the same rule (`domain::catalog::phone_title`); both are tested on the same
// examples. Pure, so it is tested without a browser (phone.test.ts).

import type { BrandDeviceType, DeviceType } from '../../api/brands';

/** The storage chips, in GB (1 TB = 1024), as in the mockup. */
export const STORAGE_CHOICES = [32, 64, 128, 256, 512, 1024] as const;
/** The RAM chips, in GB; RAM is optional. */
export const RAM_CHOICES = [2, 3, 4, 6, 8, 12, 16] as const;

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

interface Offered {
  readonly deviceType: BrandDeviceType;
  readonly hidden: boolean;
}

/** The companies «موبايل جديد» offers for a touch or a keypad phone. */
export function brandsFor<B extends Offered>(brands: readonly B[], device: DeviceType): B[] {
  return brands.filter((b) => !b.hidden && (b.deviceType === 'both' || b.deviceType === device));
}
