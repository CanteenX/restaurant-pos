/**
 * Multi-branch sync classification (docs/MULTI-BRANCH-SYNC.md §4.2–4.3).
 *
 * Every Prisma table is listed here exactly once, either in SYNC_TABLES or
 * in LOCAL_TABLES. tables.spec.ts fails when a model is missing, so a new
 * table must be decided explicitly. The capture SQL (capture-sql.ts) is
 * generated from this file at boot, so this is the single source of truth.
 */

/** Who may write the row: HQ (server) or the install owning its branch. */
export type SyncOwner = 'hq' | 'branch';

/** lww = whole-row last-writer-wins; append = insert-only ledger/log rows. */
export type SyncRule = 'lww' | 'append';

/**
 * How a row's branch is found:
 *  - `{ col }`       the row's own column (`branches` uses its `id`);
 *  - `{ via, fk }`   the branch of the parent row `via` referenced by `fk`;
 *  - `null`          restaurant-wide (no branch; routed to every branch).
 */
export type BranchPath = { col: string } | { via: string; fk: string } | null;

export interface SyncTable {
  owner: SyncOwner;
  rule: SyncRule;
  branch: BranchPath;
  /** Cached totals recomputed from a ledger after apply (#82); never LWW. */
  derived?: string[];
  /** Columns never captured: sealed with this install's key (G11). */
  strip?: string[];
  /** Rows reference `permissions.id`, which differs per install (G5). */
  permissionKeyed?: boolean;
}

const hq = (branch: BranchPath, extra: Partial<SyncTable> = {}): SyncTable => ({
  owner: 'hq',
  rule: 'lww',
  branch,
  ...extra,
});
const br = (
  branch: BranchPath,
  rule: SyncRule = 'lww',
  extra: Partial<SyncTable> = {},
): SyncTable => ({ owner: 'branch', rule, branch, ...extra });
const col = (c = 'branchId') => ({ col: c });
const via = (parent: string, fk: string) => ({ via: parent, fk });

export const SYNC_TABLES: Readonly<Record<string, SyncTable>> = {
  // ---- HQ-owned: HQ -> every branch of the restaurant --------------------
  restaurants: hq(null),
  branches: hq(col('id')),
  departments: hq(null),
  roles: hq(null),
  role_permissions: hq(null, { permissionKeyed: true }),
  user_permission_overrides: hq(null, { permissionKeyed: true }),
  users: hq(null, { strip: ['twoFactorSecret'] }),
  user_branches: hq(col()),
  menu_categories: hq(col()),
  menu_items: hq(col()),
  modifier_groups: hq(col()),
  modifiers: hq(via('modifier_groups', 'groupId')),
  menu_item_modifier_groups: hq(via('menu_items', 'menuItemId')),
  combo_components: hq(via('menu_items', 'comboItemId')),
  recipe_ingredients: hq(via('menu_items', 'menuItemId')),
  kitchen_stations: hq(col()),
  floors: hq(col()),
  tables: hq(via('floors', 'floorId')),
  delivery_zones: hq(col()),
  coupons: hq(col()),
  promotions: hq(col()),
  campaigns: hq(col()),
  membership_tiers: hq(null),
  suppliers: hq(col()),
  verifactu_settings: hq(col()),
  report_schedules: hq(col()),
  budgets: hq(col()),
  staff_pay: hq(null),
  payroll_runs: hq(col()),
  payroll_lines: hq(via('payroll_runs', 'runId')),
  documents: hq(col()),
  document_files: hq(via('documents', 'documentId')),

  // ---- Branch-owned: branch -> HQ ----------------------------------------
  orders: br(col()),
  order_items: br(via('orders', 'orderId')),
  order_item_modifiers: br(via('order_items', 'orderItemId')),
  kots: br(via('orders', 'orderId')),
  kot_items: br(via('kots', 'kotId')),
  payments: br(via('orders', 'orderId'), 'append'),
  refunds: br(via('orders', 'orderId'), 'append'),
  gateway_payments: br(col(), 'append'),
  order_item_stock_returns: br(via('order_items', 'orderItemId'), 'append'),
  customers: br(col(), 'lww', { derived: ['loyaltyPoints', 'walletBalance'] }),
  customer_addresses: br(via('customers', 'customerId')),
  customer_memberships: br(via('customers', 'customerId')),
  points_ledger: br(col(), 'append'),
  referrals: br(col(), 'append'),
  gift_cards: br(col(), 'lww', { derived: ['balance'] }),
  gift_card_redemptions: br(via('gift_cards', 'giftCardId'), 'append'),
  ingredients: br(col(), 'lww', { derived: ['currentStock'] }),
  stock_movements: br(col(), 'append'),
  // FIFO consumption updates quantityRemaining in place, so the batch row is
  // LWW and the remaining quantity is recomputed from stock_movements.
  stock_batches: br(col(), 'lww', { derived: ['quantityRemaining'] }),
  waste_logs: br(col(), 'append'),
  purchase_requests: br(col()),
  purchase_request_items: br(via('purchase_requests', 'purchaseRequestId')),
  purchase_orders: br(col()),
  purchase_order_items: br(via('purchase_orders', 'purchaseOrderId')),
  goods_receipts: br(col()),
  goods_receipt_items: br(via('goods_receipts', 'goodsReceiptId')),
  supplier_quotations: br(col()),
  supplier_quotation_items: br(
    via('supplier_quotations', 'supplierQuotationId'),
  ),
  supplier_invoices: br(col()),
  supplier_payments: br(col()),
  stock_transfers: br(col('fromBranchId'), 'append'),
  reservations: br(col()),
  waitlist_entries: br(col()),
  table_requests: br(col()),
  attendance: br(col()),
  shifts: br(col()),
  leave_requests: br(col()),
  expenses: br(col()),
  cash_closings: br(col()),
  bank_transactions: br(col()),
  equipment: br(col()),
  service_logs: br(via('equipment', 'equipmentId')),
  audit_logs: br(null, 'append'),
};

/** Never leave this install (table -> reason). */
export const LOCAL_TABLES: Readonly<Record<string, string>> = {
  _prisma_migrations: 'migration bookkeeping of this database',
  sync_state: 'sync bookkeeping',
  sync_changes: 'the outbox itself',
  sync_versions: 'per-row version registry of this install',
  sync_cursors: 'pull positions of this server’s clients',
  verifactu_records: 'append-only hash chain per installation',
  backups: 'backups belong to the machine',
  backup_config: 'backup target of this machine',
  local_backup_config: 'USB/NAS path on this PC (G10)',
  webhook_deliveries: 'delivery attempts made by this install',
  integration_logs: 'delivery attempts made by this install',
  integration_outbox: 'delivery queue for this install’s connections',
  download_stats: 'install telemetry',
  permissions: 'seeded per install, matched by key (G5)',
  integration_connections: 'credentials sealed with this install’s key (G11)',
  webhook_endpoints: 'signing secret sealed per install (G11)',
  staff_api_keys: 'bearer-token hashes stay on this machine',
  integration_api_keys: 'bearer-token hashes stay on this machine',
  device_tokens: 'push tokens belong to the sending install',
  notifications: 'the bell belongs to this install',
};

export function syncTable(tbl: string): SyncTable | undefined {
  return Object.prototype.hasOwnProperty.call(SYNC_TABLES, tbl)
    ? SYNC_TABLES[tbl]
    : undefined;
}
