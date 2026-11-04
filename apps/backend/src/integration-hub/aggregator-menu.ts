// Pure helpers for pushing item availability and the menu to a delivery
// platform (#59, docs/AGGREGATORS.md 4.6). No I/O here so it is easy to test.
// The item map lives in the connection's `config.itemMap` (menuItemId ->
// platform item id); an unmapped item is sent under our own id.

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

const minuteOf = (now: Date) => Math.floor(now.getTime() / 60_000);

/** Same item, same state, same minute = one queued call. */
export const availabilityDedupeKey = (
  menuItemId: string,
  available: boolean,
  now = new Date(),
) => `${ITEM_AVAILABILITY_KIND}:${menuItemId}:${available}:${minuteOf(now)}`;

/** At most one menu push per branch per minute. */
export const menuPushDedupeKey = (branchId: string, now = new Date()) =>
  `${MENU_PUSH_KIND}:${branchId}:${minuteOf(now)}`;

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
    'taxRatePercent',
    'categoryId',
    'isVeg',
    'modifierGroupIds',
  ].some((k) => k in changed);
}
