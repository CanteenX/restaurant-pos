// Pure mapping from a canonical aggregator order (docs/AGGREGATORS.md 4.5) to
// what OrdersService.createOrder needs. Nothing monetary from the platform is
// trusted: prices, tax and fees are recomputed from the live menu; platform
// figures are only recorded and compared.
import { UnprocessableEntityException } from '@nestjs/common';

export interface InboundModifier {
  modifierId?: string;
  name?: string;
}

export interface InboundItem {
  menuItemId?: string;
  name?: string;
  quantity: number;
  kitchenNote?: string;
  modifiers?: InboundModifier[];
}

export interface MenuEntry {
  id: string;
  name: string;
  /** Modifiers reachable through the item's own modifier groups. */
  modifiers: { id: string; name: string }[];
}

export interface MappedLine {
  menuItemId: string;
  quantity: number;
  modifierIds: string[];
  kitchenNote?: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Matches each line (id first, then case-insensitive name) and each add-on
 * against that dish's own modifiers. Anything that does not match is listed
 * in `unmatched`; the caller refuses the whole order rather than drop it.
 */
export function matchLines(
  items: InboundItem[],
  menu: MenuEntry[],
): { lines: MappedLine[]; unmatched: string[] } {
  const byId = new Map(menu.map((m) => [m.id, m]));
  const byName = new Map(menu.map((m) => [norm(m.name), m]));
  const unmatched: string[] = [];
  const lines: MappedLine[] = [];
  for (const i of items) {
    const dish =
      (i.menuItemId && byId.get(i.menuItemId)) ||
      (i.name && byName.get(norm(i.name)));
    if (!dish) {
      unmatched.push(i.name ?? i.menuItemId ?? '?');
      continue;
    }
    const modifierIds: string[] = [];
    for (const m of i.modifiers ?? []) {
      const hit =
        (m.modifierId && dish.modifiers.find((x) => x.id === m.modifierId)) ||
        (m.name && dish.modifiers.find((x) => norm(x.name) === norm(m.name!)));
      if (hit) modifierIds.push(hit.id);
      else unmatched.push(`${dish.name} + ${m.name ?? m.modifierId ?? '?'}`);
    }
    lines.push({
      menuItemId: dish.id,
      quantity: i.quantity,
      modifierIds,
      kitchenNote: i.kitchenNote,
    });
  }
  return { lines, unmatched };
}

/**
 * Picks our branch: an explicit branchId, else the platform outlet id through
 * the connection's outlet map, else the only branch. The result must always
 * be one of this restaurant's branches.
 */
export function resolveBranch(
  ev: { branchId?: string; outletId?: string },
  branchIds: string[],
  outlets: Record<string, string>,
): string {
  const own = (id: string | undefined, what: string) => {
    if (!id || !branchIds.includes(id)) {
      throw new UnprocessableEntityException(what);
    }
    return id;
  };
  if (ev.branchId) return own(ev.branchId, 'Unknown branchId');
  if (ev.outletId) {
    return own(
      outlets[ev.outletId],
      `Unknown outlet "${ev.outletId}" - map it to a branch in the integration settings`,
    );
  }
  if (branchIds.length === 1) return branchIds[0];
  throw new UnprocessableEntityException(
    'branchId (or a mapped outletId) is required when the restaurant has several branches',
  );
}

export interface PlatformMoney {
  platformTotal?: number;
  packagingCharge?: number;
  platformDiscount?: number;
}

/** Human note of what the platform says it charged - for reference only. */
export function platformMoneyNote(m: PlatformMoney): string {
  const parts: string[] = [];
  const f = (n: number) => n.toFixed(2);
  if (m.platformTotal !== undefined)
    parts.push(`platform total ${f(m.platformTotal)}`);
  if (m.packagingCharge !== undefined)
    parts.push(`packaging ${f(m.packagingCharge)}`);
  if (m.platformDiscount !== undefined)
    parts.push(`platform discount ${f(m.platformDiscount)}`);
  return parts.join(', ');
}

/** True when the platform total drifts from ours by more than 1.00. */
export function isPriceMismatch(
  platformTotal: number | undefined,
  ourTotal: string | number,
): boolean {
  if (platformTotal === undefined) return false;
  const diffPaise = Math.abs(
    Math.round(platformTotal * 100) - Math.round(Number(ourTotal) * 100),
  );
  return diffPaise > 100;
}
