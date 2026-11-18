// Pure helpers for pushing item availability and the menu to a delivery
// platform (#59, docs/AGGREGATORS.md 4.6). No I/O here so it is easy to test.
// The item map lives in the connection's `config.itemMap` (menuItemId ->
// platform item id); an unmapped item is sent under our own id.

import { randomUUID } from 'crypto';

export interface AvailabilityChange {
  menuItemId: string;
  available: boolean;
}

export interface PlatformAvailabilityItem {
  externalItemId: string;
  available: boolean;
}

export interface CanonicalMenuItem {
  externalItemId: string;
  name: string;
  description: string | null;
  categoryId: string;
  /** Tax-inclusive selling price, straight from the menu. */
  price: number;
  /** Tax-inclusive half-portion price, when the dish has one. */
  halfPrice: number | null;
  taxRatePercent: number;
  isVeg: boolean;
  available: boolean;
  modifiers: { id: string; name: string; price: number }[];
}

export interface CanonicalMenu {
  generatedAt: string;
  categories: { id: string; name: string }[];
  items: CanonicalMenuItem[];
}

export type ItemMap = Record<string, string>;

export const ITEM_AVAILABILITY_KIND = 'item.availability';
export const MENU_PUSH_KIND = 'menu.push';

export const externalItemId = (map: ItemMap | undefined, menuItemId: string) =>
  map?.[menuItemId] || menuItemId;

/**
 * Outbox keys are `<prefix><uuid>`: unique per queued call. The outbox only
 * coalesces a new edit into a row under the same prefix that is still PENDING
 * and not yet attempted; delivery reads live state, so that row carries the
 * newest edit. A delivered row never swallows a later edit.
 */
export const availabilityKeyPrefix = (menuItemId: string) =>
  `${ITEM_AVAILABILITY_KIND}:${menuItemId}:`;
export const menuPushKeyPrefix = (branchId: string) =>
  `${MENU_PUSH_KIND}:${branchId}:`;
export const queuedKey = (prefix: string) => `${prefix}${randomUUID()}`;

/**
 * The platform outlets a branch's menu goes to. `[null]` = the connection has
 * no outlet map (one outlet per merchant): send without an outlet id. `[]` =
 * the connection maps outlets but none to this branch: send nothing, so one
 * branch never overwrites another branch's outlet.
 */
export function outletsForBranch(
  outlets: Record<string, string> | undefined,
  branchId: string,
): (string | null)[] {
  if (!outlets || Object.keys(outlets).length === 0) return [null];
  return Object.entries(outlets)
    .filter(([, b]) => b === branchId)
    .map(([outletId]) => outletId);
}

export function toPlatformAvailability(
  changes: AvailabilityChange[],
  map: ItemMap | undefined,
): PlatformAvailabilityItem[] {
  // The last change for an item wins.
  const latest = new Map<string, boolean>();
  for (const c of changes) latest.set(c.menuItemId, c.available);
  return [...latest].map(([id, available]) => ({
    externalItemId: externalItemId(map, id),
    available,
  }));
}

interface MenuRow {
  id: string;
  name: string;
  description: string | null;
  categoryId: string;
  price: { toString(): string } | number;
  halfPrice?: { toString(): string } | number | null;
  taxRatePercent: { toString(): string } | number;
  isVeg: boolean;
  isActive: boolean;
  modifierGroups: {
    modifierGroup: {
      modifiers: {
        id: string;
        name: string;
        priceAdjustment: { toString(): string } | number;
      }[];
    };
  }[];
}

export function buildMenu(
  categories: { id: string; name: string }[],
  items: MenuRow[],
  map: ItemMap | undefined,
  now = new Date(),
): CanonicalMenu {
  return {
    generatedAt: now.toISOString(),
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    items: items.map((i) => ({
      externalItemId: externalItemId(map, i.id),
      name: i.name,
      description: i.description,
      categoryId: i.categoryId,
      price: Number(i.price.toString()),
      halfPrice: i.halfPrice == null ? null : Number(i.halfPrice.toString()),
      taxRatePercent: Number(i.taxRatePercent.toString()),
      isVeg: i.isVeg,
      available: i.isActive,
      modifiers: i.modifierGroups.flatMap((g) =>
        g.modifierGroup.modifiers.map((m) => ({
          id: m.id,
          name: m.name,
          price: Number(m.priceAdjustment.toString()),
        })),
      ),
    })),
  };
}

/** True when an item edit changes something a platform shows. */
export function touchesMenu(changed: Record<string, unknown>): boolean {
  return [
    'name',
    'description',
    'price',
    'halfPrice',
    'taxRatePercent',
    'categoryId',
    'isVeg',
    'modifierGroupIds',
  ].some((k) => k in changed);
}
