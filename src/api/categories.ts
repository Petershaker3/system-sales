/**
 * The category tree (ADR-018 §1): what the settings card and the sales screen
 * read and change. A thin typed wrapper over `invoke`; no token is ever sent,
 * because the backend resolves the operator from the OS credential store.
 */

import { invoke } from '@tauri-apps/api/core';

/** How goods in a category are registered: counted, phone by phone, or used. */
export type CategoryKind = 'item' | 'phone' | 'used';

export interface Category {
  readonly id: string;
  readonly name: string;
  /** `null` for a main category. */
  readonly parentId: string | null;
  readonly kind: CategoryKind;
  readonly icon: string;
  /** The button is not shown on the sales screen; its goods still are. */
  readonly hidden: boolean;
  readonly sortOrder: number;
}

/** One row of the settings list. */
export interface CategoryEntry extends Category {
  /** Live products directly in it (its sub-categories' not counted). */
  readonly products: number;
  /** One of the default tree: renamed, moved and hidden, never deleted. */
  readonly isDefault: boolean;
  /** Empty, not a default, no sub-category: the delete button may show. */
  readonly deletable: boolean;
}

/**
 * The icons a category may have — the domain's `CATEGORY_ICONS`, in the
 * mockup's order. The backend refuses any other.
 */
export const CATEGORY_ICONS = [
  'tag',
  'package',
  'smartphone',
  'watch',
  'headphones',
  'plug-zap',
  'cable',
  'shield',
  'layers',
  'battery-charging',
  'memory-stick',
  'car',
  'wallet-cards',
  'signal',
  'wrench',
  'sparkles',
  'recycle',
] as const;

export function listCategories(): Promise<CategoryEntry[]> {
  return invoke<CategoryEntry[]>('list_categories');
}

export interface NewCategory {
  readonly name: string;
  /** `null` for a main category. */
  readonly parentId: string | null;
  /** A main category's kind; a sub-category takes its parent's (send `null`). */
  readonly kind: CategoryKind | null;
  readonly icon: string;
}

export function createCategory(input: NewCategory): Promise<Category> {
  return invoke<Category>('create_category', {
    name: input.name,
    parentId: input.parentId,
    kind: input.kind,
    icon: input.icon,
  });
}

export function renameCategory(id: string, name: string): Promise<Category> {
  return invoke<Category>('rename_category', { id, name });
}

export function setCategoryHidden(id: string, hidden: boolean): Promise<Category> {
  return invoke<Category>('set_category_hidden', { id, hidden });
}

export function moveCategory(id: string, direction: 'up' | 'down'): Promise<Category> {
  return invoke<Category>('move_category', { id, direction });
}

export function deleteCategory(id: string): Promise<void> {
  return invoke<void>('delete_category', { id });
}
