/**
 * Derived balances (docs/MULTI-BRANCH-SYNC.md rule 5): cached totals that a
 * receiving install recomputes from their append-only ledger after a batch
 * is applied, so the wire value never decides them. Each formula is the one
 * the owning services maintain, with the same rounding:
 *
 * - customers.walletBalance = sum(customer_wallet_entries.delta), 2 dp. The
 *   ledger is written with every store-credit change (wallet-ledger.ts) and
 *   was opened with each customer's balance by migration
 *   20261105100000_sync_apply (audit note on #82: there was no ledger).
 * - gift_cards.balance = initialValue - sum(gift_card_redemptions.amount),
 *   2 dp. Issue sets balance = initialValue; redemption is the only debit.
 * - petty_cash_floats.balance = sum(petty_cash_entries.amount), 2 dp, keyed
 *   by branchId. The float opens at 0 and every movement (petty-cash.service
 *   move()) books one entry with the same signed, rounded amount, so the sum
 *   reproduces its guarded `set` (#209 audit).
 *
 * Totals whose services clamp or set them without a matching ledger row
 * (ingredients.currentStock, stock_batches.quantityRemaining,
 * customers.loyaltyPoints) are `ownerTotals` in tables.ts instead: only the
 * owning branch writes those rows (rule 1), so its value is authoritative.
 */
export interface DerivedSpec {
  table: string;
  column: string;
  /** Primary-key column of `table` (the ledger's `fk` points at it). */
  key: string;
  /** Ledger table and its column referencing `table.id`. */
  ledger: string;
  fk: string;
  /** SQL for the new value; `t` is the target row. */
  expr: string;
}

export const DERIVED: readonly DerivedSpec[] = [
  {
    table: 'customers',
    column: 'walletBalance',
    key: 'id',
    ledger: 'customer_wallet_entries',
    fk: 'customerId',
    expr: `round(coalesce((SELECT sum(l.delta) FROM customer_wallet_entries l WHERE l."customerId" = t.id), 0), 2)`,
  },
  {
    table: 'gift_cards',
    column: 'balance',
    key: 'id',
    ledger: 'gift_card_redemptions',
    fk: 'giftCardId',
    expr: `round(t."initialValue" - coalesce((SELECT sum(l.amount) FROM gift_card_redemptions l WHERE l."giftCardId" = t.id), 0), 2)`,
  },
  {
    table: 'petty_cash_floats',
    column: 'balance',
    key: 'branchId',
    ledger: 'petty_cash_entries',
    fk: 'branchId',
    expr: `round(coalesce((SELECT sum(l.amount) FROM petty_cash_entries l WHERE l."branchId" = t."branchId"), 0), 2)`,
  },
];
