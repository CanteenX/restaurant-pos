// Pure petty-cash maths (#72), kept apart from the database code for tests.
import { BadRequestException } from '@nestjs/common';
import { round2 } from './accounting.calc';

export type PettyKind = 'TOP_UP' | 'PAYOUT' | 'ADJUST';

export interface PettyMovement {
  kind: PettyKind;
  /** Signed amount as stored: + into the float, - out of it. */
  amount: number;
  fromTill: boolean;
}

/** DTO amounts are positive for top-ups/payouts; adjustments carry a sign. */
export function signedAmount(kind: PettyKind, amount: number): number {
  if (kind === 'TOP_UP') return round2(Math.abs(amount));
  if (kind === 'PAYOUT') return round2(-Math.abs(amount));
  return round2(amount);
}

/** Balance after one movement; the float can never go below zero. */
export function applyEntry(
  balance: number,
  kind: PettyKind,
  amount: number,
): number {
  const next = round2(balance + signedAmount(kind, amount));
  if (next < 0) {
    throw new BadRequestException(
      `Petty cash holds ${round2(balance)}; this would leave ${next}`,
    );
  }
  return next;
}

/** Cash taken out of the till drawer to top up the float. */
export function tillTopUps(entries: PettyMovement[]): number {
  return round2(
    entries
      .filter((e) => e.kind === 'TOP_UP' && e.fromTill)
      .reduce((s, e) => s + e.amount, 0),
  );
}

export function pettyDaySummary(
  openingBalance: number,
  entries: PettyMovement[],
) {
  const sum = (k: PettyKind) =>
    round2(
      entries.filter((e) => e.kind === k).reduce((s, e) => s + e.amount, 0),
    );
  const topUps = sum('TOP_UP');
  const payouts = round2(-sum('PAYOUT'));
  const adjustments = sum('ADJUST');
  return {
    openingBalance: round2(openingBalance),
    topUps,
    payouts,
    adjustments,
    closingBalance: round2(openingBalance + topUps - payouts + adjustments),
  };
}
