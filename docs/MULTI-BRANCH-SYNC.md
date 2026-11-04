# Multi-branch sync — audit and design

Status: design (issue #80); capture and outbox implemented in #81 (see §8).
Still to come: #82 (apply, conflict rules, agent loop) and #83 (two-instance
convergence test).

## 1. Goal

A restaurant with several branches runs one Nventra POS install per branch
(often on a local PC that loses internet for hours) plus one **HQ** install.
The menu, customers and stock must stay consistent:

- HQ edits the menu, prices, roles and staff once; every branch gets them.
- Each branch keeps selling, receiving stock and adding customers while
  offline; HQ gets everything once the link is back, with nothing lost and
  nothing double-counted.
- A branch can never change another branch's data or HQ-owned data.

## 2. What exists today (`apps/backend/src/sync`)

| Piece | Where | What it does |
|---|---|---|
| Change capture | migration `20261026000000_server_sync` | `sync_log` AFTER INSERT/UPDATE/DELETE row trigger on **every** table except those listed by `sync_is_synced_table()`. Writes the full row as JSONB to `sync_changes` (`seq` BIGSERIAL, `tbl`, `pk`, `pkKey`, `op` U/D, `row`, `ts`, `origin`). Nothing is logged while `sync_state.enabled = false`. Triggers are (re)installed at every boot, so new tables are covered automatically. |
| Seed | `sync_seed()` | Copies every existing row into the log with `ts = epoch` so any real edit wins. Used by `merge` mode and by the server on first boot. |
| Roles | `sync_state.role` | `server` when `SYNC_API_KEY` is set in the env; otherwise `client`. One server, any number of clients (hub and spoke). |
| Peer API | `SyncPeerController` `/api/v1/sync-peer/{ping,pull,push}` | `ping` returns the schema version (newest applied Prisma migration). `pull?since=&device=` pages the server log by `seq` (500), filtering out the caller's own changes. `push` applies a client's batch. |
| Auth | `SyncKeyGuard` | One shared `SYNC_API_KEY`, `x-sync-key` header, constant-time compare. |
| Client loop | `SyncService.cycle()` every 30 s | ping + schema check → pull pages → apply → push pages of 200 → record `lastPullSeq`/`lastPushSeq` → prune own log entries already pushed and older than 1 day. |
| Apply | `applyChanges()` / `applyOne()` | `compact()` keeps the newest change per row; **last-writer-wins by `ts`**, the server wins exact ties. Upsert via `jsonb_populate_record` + `ON CONFLICT (pk) DO UPDATE`; deletes after upserts; FK violations retried for up to 6 passes; other errors recorded as conflicts (last 50 kept in `sync_state.conflicts`). Applied changes are re-logged with the sender as `origin` so the server relays them to other clients. |
| Enable | `PUT /v1/sync/settings` (`settings.manage`) | `adopt` truncates every synced table and takes the server's data (refused if VERI\*FACTU records exist); `merge` seeds local rows and merges both sides. |
| UI | `apps/web/app/(dashboard)/settings/sync`, `hooks/use-sync.ts` | Status, pending count, last error, conflict list, test/enable/run/disable. |
| Standalone phone POS | `apps/backend/src/standalone` | Separate path: snapshot of one branch's menu/tables, then offline sales replayed through `OrdersService` with server-side repricing and idempotency (`clientRequestId`). Not row replication — this is the model to copy for money rows. |

Today's sync is therefore **whole-database replication of one restaurant
between devices**, designed for "one shop, a PC plus a cloud copy". It is not
branch-aware.

## 3. Gaps

| # | Gap | Effect today | Fixed in |
|---|---|---|---|
| G1 | **No ownership.** Any key holder may push any row of any table. | A branch PC can overwrite HQ menu prices, roles, other branches' orders, or another user's `passwordHash`. | #82 |
| G2 | **No branch filter on pull.** The server relays every change to every client. | Each branch downloads every other branch's orders, customers, staff hashes, API key hashes and audit log. Data exposure and bandwidth. | #81/#82 |
| G3 | **LWW on running balances.** `ingredients.currentStock`, `gift_cards.balance`, `customers.loyaltyPoints` / `walletBalance` are cached totals; LWW keeps one side's total and silently drops the other side's movements. | Stock or a gift-card balance is wrong after concurrent offline use (breaks the "rounded read-modify-write" rule's intent). | #82 |
| G4 | **Per-branch numbers collide.** `orders.orderNumber` (`YYYYMMDD-NNNN`, `@@unique([branchId, orderNumber])`), PO/GRN/request/quotation/invoice numbers are computed as "max + 1" locally. Two devices of the same branch offline both create `…-0007`. | Second row hits a unique violation → recorded as a conflict and **not applied** (lost sale on HQ). | #81 (rule), #82 |
| G5 | **Permissions have per-install ids.** `permissions` rows are upserted by `key` with a fresh `cuid()` per install; `role_permissions` reference the id. | `merge` mode: unique violation on `permissions.key`; role grants point at missing ids. | #81 |
| G6 | **Wall-clock LWW.** `ts` is the writer's `clock_timestamp()`. | A branch PC with a clock 10 min fast wins every edit for 10 min, including HQ menu edits. | #82 |
| G7 | **History lost on the client.** The client prunes its own log after 1 day; `applyOne` decides "is the incoming change newer?" only from `sync_changes`. | After pruning, an older incoming change can overwrite a newer local row. | #81 |
| G8 | **Server log never pruned.** | `sync_changes` on HQ grows without bound. | #81 |
| G9 | **Schema skew is all-or-nothing.** `ping` compares the newest migration name; any difference stops sync completely. | Branches must all upgrade at the same minute; an offline branch that missed an upgrade cannot sync until updated (acceptable, but the UI must say so and keep queuing). | #82 |
| G10 | **Device-local tables are synced.** `local_backup_config` (a USB/NAS path on that PC), `device_tokens`, `notifications` (per-branch bell), `integration_logs`, `audit_logs` all replicate. | A branch inherits HQ's backup folder; push tokens fire from the wrong install. | #81 |
| G11 | **Encrypted secrets don't travel.** `integration_connections` credentials (`integration-hub/secret-box.ts`), `users.twoFactorSecret`, `webhook_endpoints.secret` (`auth/totp.ts` `sealSecret`) and the VERI*FACTU certificate in `verifactu_settings` (`verifactu.service.ts`, `VERIFACTU_KEY`) are sealed with a key derived from each install's `INTEGRATION_SECRET_KEY`/`JWT_SECRET`. | A synced row can't be decrypted on the other install: 2FA logins, webhook signing and AEAT submission break there. | #81 (exclude / strip) |
| G12 | **Device id is self-declared.** `pull?device=` / `push.device` are trusted as sent. | A key holder can claim another device's id to receive its echo or hide its own changes. | #82 |
| G13 | **Single shared key**, stored in plaintext in `sync_state.apiKey`, no per-branch revocation. | Losing one branch PC means rotating the key on every install. | #82 (per-branch keys) |
| G14 | **Offline duration** is unbounded but untested; pages are 200/500 rows with no total cap or progress. | A week offline = tens of thousands of rows in one cycle; one bad row blocks nothing but gives no progress signal. | #81 (outbox), #83 (test) |
| G15 | **Branch-scoped customers.** `customers.branchId` is required; `referralCode` and `gift_cards.code` are globally unique. | The same phone number becomes one customer per branch; a gift card sold at branch A can't be redeemed at branch B. | Out of scope (business decision, see §7). |

## 4. Chosen design

Keep the existing trigger-based change log, hub-and-spoke topology, peer API
and settings UI. Add **ownership**, **branch-scoped routing**, and
**ledger-based merging for balances**. Do not invent a new transport.

### 4.1 Topology and identity

- HQ = the `server` role (one per restaurant). Branch installs = `client`.
- Each client is registered at HQ as a **sync peer** bound to exactly the
  branch ids it owns (`sync_peers`: `id`, `branchIds[]`, `keyHash`,
  `lastSeenAt`, `revokedAt`). The device id comes from the authenticated peer
  record, never from the request (G12). Keys are per peer, stored hashed at
  HQ, revocable one at a time (G13). The existing `SYNC_API_KEY` stays as the
  bootstrap key used once to register a peer.
- A single-branch shop with "PC + cloud copy" is the degenerate case: one
  peer owning the only branch. Today's behaviour stays.

### 4.2 Data ownership

Every synced table is classified by **owner** and **merge rule**. The
classification lives in code (`apps/backend/src/sync/tables.ts`, #81) as a
typed map — not inferred — and a unit test fails when a Prisma model is not
classified, so new tables must be decided explicitly. Owners:

- **HQ-owned** — written at HQ, read-only at branches. A branch push is
  rejected with a conflict entry; the branch UI should hide edit buttons when
  sync is on (follow-up UI issue).
- **Branch-owned** — written only by the install that owns the row's
  `branchId` (directly or through its parent row). HQ receives everything;
  each branch receives only its own rows back (for restore) plus nothing from
  other branches.
- **Local** — never leaves the install.

Merge rules:

- **LWW** — whole-row last-writer-wins, using a hybrid logical clock (§4.4).
- **Append** — insert-only rows (ledgers, logs); never updated by sync, so
  conflicts are impossible; duplicates are ignored by primary key.
- **Derived** — a cached total recomputed from its ledger after apply; the
  column itself is not taken from the wire (G3).

### 4.3 Table list

`R` = restaurantId column, `B` = branchId column, `→parent` = scoped through
its parent's branch.

#### HQ-owned (HQ → all branches of the restaurant)

| Table | Rule | Reason |
|---|---|---|
| `restaurants` | LWW | Brand, tax settings, receipt text are set once. |
| `branches` | LWW | Branch identity, address, kiosk token; created at HQ so ids are global. |
| `departments` (R) | LWW | Org structure is restaurant-wide. |
| `roles` (R), `role_permissions` | LWW | Permissions are central policy. `role_permissions` is shipped with the **permission key**, not id (G5). |
| `user_permission_overrides` | LWW | Same, keyed by permission key. |
| `users` (R) | LWW | Staff are hired centrally and may work at several branches, so every branch of the restaurant receives all users. Password/PIN hashes travel so staff can log in at any branch while offline; `twoFactorSecret` is sealed per install (G11), so it is stripped on the wire and 2FA users sign in at HQ or re-enrol per branch (#81). |
| `user_branches` (B) | LWW | Which branch a user may use; HQ grants it. |
| `menu_categories` (B), `menu_items` (B), `modifier_groups` (B), `modifiers` →group, `menu_item_modifier_groups`, `combo_components`, `recipe_ingredients` | LWW | Menu and prices are HQ-controlled per branch (rows already carry `branchId`, so HQ can price per branch). Selling price is money: branches must not change it. |
| `kitchen_stations` (B), `floors` (B), `tables` →floor | LWW | Set up per branch by HQ; rarely change. Table *status* is not stored here (orders are). |
| `delivery_zones` (B) | LWW | Pricing input (delivery fee). |
| `coupons` (B), `promotions` (B), `campaigns` (B), `membership_tiers` (R) | LWW | Discounts are money rules; marketing is central. |
| `suppliers` (B) | LWW | Central vendor list. |
| `report_schedules` (B), `budgets` (B) | LWW | Finance planning is HQ's. |
| `staff_pay` →user, `payroll_runs` (B), `payroll_lines` →run | LWW | Payroll is run at HQ. |
| `documents` (B), `document_files` →document | LWW | Policies/contracts uploaded centrally. File blobs are not synced in v1 (path only). |

#### Branch-owned (branch → HQ)

| Table | Rule | Reason |
|---|---|---|
| `orders` (B), `order_items`, `order_item_modifiers`, `kots`, `kot_items` →order | LWW per row, numbering rule §4.5 | Sales happen at the branch; HQ reports on them. An order is edited only at its branch. |
| `payments`, `refunds`, `gateway_payments` (RB), `order_item_stock_returns` →order | Append (+ LWW for status fields) | Money records; idempotent by id / `clientRequestId`. Totals stay server-authoritative at the branch that took the payment. |
| `customers` (B), `customer_addresses` →customer, `customer_memberships` →customer | LWW, balances **Derived** | Customers are branch-scoped in the schema today (G15). `loyaltyPoints` derived from `points_ledger`, `walletBalance` from its ledger (#82). |
| `points_ledger` (B), `referrals` (B) | Append | Ledger; `idempotencyKey` already unique. |
| `gift_cards` (B), `gift_card_redemptions` →card | LWW / Append, `balance` **Derived** | Balance recomputed from redemptions. |
| `ingredients` (B) | LWW, `currentStock` **Derived** | Ingredient definitions are created at the branch (stock is per branch). `currentStock` is recomputed from `stock_movements`. |
| `stock_movements` (B), `stock_batches` (B), `waste_logs` (B) | Append | The stock ledger — the source of truth for G3. |
| `purchase_requests`, `purchase_orders`, `goods_receipts`, `supplier_quotations`, `supplier_invoices`, `supplier_payments` (B); `purchase_request_items`, `purchase_order_items`, `goods_receipt_items`, `supplier_quotation_items` →parent | LWW, numbering rule §4.5 | Purchasing is done by the branch. |
| `stock_transfers` (R, from/to branch) | Append, owned by `fromBranchId` | The receiving branch gets the row because it names `toBranchId` (special routing rule). |
| `reservations`, `waitlist_entries`, `table_requests` (B) | LWW | Front-of-house state of that branch. |
| `attendance`, `shifts`, `leave_requests` (B) | LWW | Clock-in happens at the branch (advisory-locked locally). |
| `expenses`, `cash_closings`, `bank_transactions` (B) | LWW | Branch till and day-end; `cash_closings` unique per business date. |
| `equipment`, `service_logs` (B) | LWW | Branch assets. |
| `audit_logs` | Append | HQ keeps the full trail; branches don't receive others'. |

#### Local (never synced)

| Table | Reason |
|---|---|
| `_prisma_migrations`, `sync_state`, `sync_changes` | Bookkeeping of this install. (excluded today) |
| `verifactu_records` | Append-only hash chain per installation; cannot be merged. (excluded today) |
| `verifactu_settings` | The certificate is sealed with this install's key (G11), and `nextNumber` / `nextRefundNumber` continue this install's own chain: an HQ copy would break AEAT submission or roll a counter back into duplicate invoice numbers. Each install configures its own VERI*FACTU (#81 audit). |
| `backups`, `backup_config`, `local_backup_config` | Backups and their target folder belong to the machine. (`local_backup_config` is synced today — G10) |
| `webhook_deliveries`, `integration_logs` | Delivery attempts made by this install. |
| `download_stats` | Install telemetry. (excluded today) |
| `permissions` | Seeded by every install from `packages/types/src/permissions.ts`; matched by `key` (G5). |
| `integration_connections` | Credentials are sealed with this install's key (G11); each branch connects its own aggregator/payment accounts. |
| `webhook_endpoints` | Signing secret is sealed per install (G11); webhooks fire from the install where the event happens, so each install configures its own. |
| `staff_api_keys`, `integration_api_keys` | Bearer-token hashes must not be copied to other machines; issue per install. |
| `device_tokens`, `notifications` | Push tokens and the bell belong to the install that will send them. |

### 4.4 Conflict rules

1. **Ownership first.** A change for a row the sender does not own is
   rejected (conflict entry `not-owner`) and never applied. This removes
   almost all real conflicts: HQ-owned rows are written in one place, and a
   branch-owned row is written by one install.
2. **Ordering = hybrid logical clock.** Replace raw wall-clock `ts` with an
   HLC `(physical ms, counter, peerId)` stamped by the trigger; each install
   advances its HLC past every timestamp it receives. Ties break by `peerId`
   with HQ winning (keeps today's "server wins ties"). Clock skew then only
   reorders concurrent edits; it cannot make a stale edit win after it has
   been seen (G6).
3. **LWW is per row** for remaining same-owner conflicts (e.g. two tills of
   one branch both offline editing the same reservation — only possible when
   a branch runs several installs, which v1 does not support; see §6).
4. **Deletes are tombstones** with an HLC. A delete beats any update with an
   older HLC; an update newer than the delete resurrects the row
   (delete/update scenario in #83 asserts the newest action wins on both
   sides). Tombstones are kept until every peer's acknowledged position has
   passed them, then pruned (G7, G8).
5. **Balances are never LWW.** Ledger rows are append-only; after a batch is
   applied, every touched cached total (`currentStock`, `balance`,
   `loyaltyPoints`, `walletBalance`) is recomputed from its ledger with the
   same rounding as the services, using a read-modify-write `set` (never
   `increment`, per CONTRIBUTING). Wire values for those columns are ignored.
6. **Unique-key conflicts on natural keys** (e.g. `ingredients.(branchId,
   name)`, `coupons.(branchId, code)`) are reported, not auto-merged: the
   incoming row is parked in `sync_state.conflicts` with both ids, and the
   settings page shows it. No silent data loss.
7. **Money is not re-derived from the wire.** Orders and payments arrive as
   already-settled records from the branch whose server priced them; HQ does
   not reprice, and branches never accept order rows for other branches.

### 4.5 Numbering

`orderNumber` and the purchasing numbers stay unique per branch because a
branch is owned by exactly one install (rule 1). If a branch later runs more
than one install, numbers get a short per-install prefix (`YYYYMMDD-A-0007`);
until then a second install for the same branch is refused at peer
registration.

### 4.6 Schema version skew

- `ping` keeps returning the newest migration; the client keeps **capturing**
  while versions differ but pauses pull/push and shows "Update this branch to
  version X" (today it errors every 30 s).
- A change carries its schema version; HQ refuses to apply rows from an older
  schema, so a lagging branch can never write columns it doesn't know about
  as NULLs (`jsonb_populate_record` would do that silently).
- Upgrade order: HQ first, then branches. Documented in `docs/UPGRADING.md`
  when #82 lands.

### 4.7 Offline duration

- No hard limit. The outbox (#81) is durable and ordered by `seq`; entries are
  removed only after HQ acknowledges them.
- Batches stay paged (200 push / 500 pull) and each page commits its cursor,
  so a network drop mid-batch resumes at the next page (#83 failure
  injection).
- Target: 7 days offline for a busy branch (~2,000 orders/day ≈ 150k rows)
  drains in under 10 minutes on a 2 Mbit/s link. #83 measures it.

### 4.8 Security

- Per-peer keys, hashed at HQ, revocable; transport must be HTTPS when the
  server URL is not on a private network (warn in UI).
- Pull responses are filtered by the peer's branch ids at the SQL level.
- Branches never receive `staff_api_keys`, `integration_api_keys`,
  `integration_connections`, `webhook_endpoints`, sealed 2FA secrets, or other branches' customers,
  orders and audit logs.
- Every apply runs with ownership checks before any SQL touches the row; the
  generic `jsonb_populate_record` path is kept but limited to classified
  tables and classified columns.
- `settings.manage` continues to gate the local sync settings endpoints.

## 5. Follow-up scope per issue

**#81 — capture and outbox**
- `sync/tables.ts`: typed classification of every table (owner, rule, branch
  path, derived columns, local); unit test fails on an unclassified model.
- Move `local_backup_config`, `integration_logs`, `integration_connections`,
  `webhook_endpoints`, `staff_api_keys`, `integration_api_keys`,
  `device_tokens`, `notifications`, `permissions` to Local (G5, G10, G11);
  strip `users.twoFactorSecret` from captured rows.
- Migration: HLC column(s) on `sync_changes`, branch id on each change,
  schema version; outbox is pruned only on acknowledgement (G7, G8).
- `role_permissions`/`user_permission_overrides` changes carry the
  permission key.
- `outbox.spec.ts`: ordering, tombstones, idempotent replay; e2e: offline
  writes accumulate and drain in order.

**#82 — apply, conflict rules, agent loop**
- `sync_peers` table, registration with bootstrap key, per-peer hashed key,
  device id from auth (G12, G13).
- Ownership enforcement on push; branch filter on pull (G1, G2).
- HLC comparison and tombstone handling (G6).
- Derived-column recompute for stock, gift cards, points, wallet (G3).
- Schema skew: keep capturing, pause transfer, clear UI message (G9).
- Retry/backoff (30 s → 10 min cap) and status/last error via the existing
  `/v1/sync/status`.
- `apply.spec.ts` (conflicts, ownership, version skew) and
  `sync-apply.e2e-spec.ts` (duplicate and out-of-order changes converge).

**#83 — two-instance convergence**
- Script two backends with separate Postgres DBs; create/create,
  update/update, delete/update scenarios plus stock movements on both sides
  and a network drop mid-batch; assert identical rows and correct derived
  totals.

## 6. Out of scope (v1)

- More than one install per branch (multi-till offline peer-to-peer). Tills
  in one branch share that branch's server over the LAN, as today.
- Peer-to-peer between branches; everything goes through HQ.
- Syncing uploaded files (`document_files` blobs, menu photos) — paths only.
- Merging data of two restaurants (tenants).

## 7. Decisions needed from the maintainer

These don't block #81–#83 (the design defaults are in brackets) but change
the table list if answered differently:

1. Should customers, loyalty and gift cards be **restaurant-wide** (one
   customer across branches, redeem a gift card anywhere)? [Default: stay
   branch-scoped as the schema is today; revisit as its own issue because it
   needs a schema migration and a merge rule for the same phone at two
   branches.]
2. Is the menu always HQ-controlled, or may a branch manager edit items for
   their own branch? [Default: HQ-owned; a per-branch "local edits allowed"
   flag can be added later.]

## 8. Implementation status

### #81 — capture and outbox (done)

- **Classification** lives in `apps/backend/src/sync/tables.ts`
  (`SYNC_TABLES` with owner, rule, branch path, derived and stripped
  columns; `LOCAL_TABLES` with a reason). `tables.spec.ts` parses
  `schema.prisma` and fails on any unclassified or stale table. Unknown
  tables never sync. Additions to §4.3: `integration_outbox` (delivery queue
  for this install's connections) and the new `sync_versions` /
  `sync_cursors` are Local; `stock_batches` is LWW with `quantityRemaining`
  Derived, because FIFO consumption updates it in place; `purchase_returns` /
  `purchase_return_items` (#63) are Branch-owned LWW like goods receipts, and
  `ingredient_unit_conversions` (#69 pack sizes) is Branch-owned LWW via its
  ingredient.
- **Capture SQL is generated** from that file at every boot
  (`capture-sql.ts`: `sync_is_synced_table`, `sync_branch_of`,
  `sync_capture_row`), then `sync_install_triggers()` adds the row trigger
  to synced tables and drops it from Local ones.
- **Outbox** (`sync_changes`, migration `20261104130000_sync_outbox`): every
  entry carries `seq` (order), a per-row **HLC** `hlc = (ms << 16) + counter`
  that never goes backwards for a row, the writing `peer` (device id), the
  row's `branchId` (followed through parent rows; kept from the last version
  for deletes) and the `schemaVersion` it was written with. Deletes are
  tombstone entries.
- **`sync_versions`** keeps the newest version of every row (and delete
  tombstones). Apply compares against it, not the outbox, so pruning can't
  let an older change win (G7). Same HLC from the same peer = replay →
  skipped; same HLC from another peer → server wins.
- **Pruning on acknowledgement**: the client deletes a push page in the same
  transaction that advances `lastPushSeq`; a crash replays at most that page.
- **Rejected changes are kept, not pruned**: conflicts carry the change's
  `seq`. Whatever the server rejected on push (malformed, unknown table, FK
  still failing after the retry passes), and whatever this install rejected
  on pull before moving `lastPullSeq` past it, is written to the local
  `sync_rejected` table (`side` = `push` / `pull`, the full change and the
  error) in the same transaction. `GET /sync/status` reports the count as
  `rejectedChanges`. Replaying them is an admin action (#82).
- **Cursors never pass an open writer**: `seq` is assigned at insert, not at
  commit, so an entry can become visible after a higher one. Each
  transaction that writes outbox entries first reads the sequence head and
  holds a shared advisory lock on `2^40 + head` until it ends.
  `sync_safe_seq()` reads the head, then those locks, and returns a bound
  below every open writer's entries. Server pull and client push only read
  `seq <= bound` (bound read in its own statement first), so `nextSeq`,
  `lastPushSeq` and the client's `DELETE … seq <= pushedTo` only move over
  entries that are already visible. `pg_locks` is cluster-wide, so only
  locks of the current database count; writers in another database on the
  same Postgres never stall this one.
- **One apply per row at a time**: before the LWW check, apply recomputes
  the row key with `sync_pk()` on the wire `pk` (as the sender's trigger
  did) and rejects a change whose `pkKey` differs (`pkKey does not match
  pk`), or whose update row has other key values than `pk` (`row does not
  match pk`), so LWW and tombstones always key the row the DML writes. It
  then takes a transaction advisory lock on (`sync_row`, table + key), held
  until commit, so two concurrent pushes of one row are serialised and the
  older HLC is skipped instead of overwriting the newer one. A deadlock
  between two such pushes is retried in the next pass.
- **An apply never beats an open local write**: local POS writes don't take
  that advisory lock, so apply also locks the target row (`FOR UPDATE`)
  before the LWW check. A local edit still open on the row commits first,
  and the check then sees its version. The lock order (row, then
  `sync_versions` in the trigger) is the same as a local `UPDATE`'s, so the
  two can't deadlock. A row that was absent is only inserted (`ON CONFLICT
  DO NOTHING`); if a local writer created it meanwhile, apply locks it and
  re-checks. As a backstop, neither the trigger nor apply ever lowers a
  row's `sync_versions.hlc`, and server compaction keeps each row's
  highest-HLC entry, not its highest seq.
- **A PC with a wrong clock pauses, it never drops data**: HLCs come from
  each PC's own clock, so `ping` returns the server's `now` and every client
  cycle (and the settings page's connection test) compares it with this
  PC's clock, at the middle of the round trip. More than 5 min apart
  (`MAX_CLOCK_SKEW_MS`) and the cycle stops before pulling or pushing, with
  `lastError` = "This PC's clock is 6 min ahead of the server; fix the time
  to resume sync." Cursors don't move and nothing is pruned or
  dead-lettered; the queued changes go out once the clock is fixed.
- **Incoming HLCs are bounded**: a change whose HLC is at the bigint limit
  (the trigger's `hlc + 1` would overflow and lock the row everywhere), or
  more than 24 h (`MAX_HLC_FUTURE_MS`) ahead of the receiver's clock, is
  malformed: rejected and dead-lettered. The 24 h ceiling is deliberately
  loose: devices that each pass the 5 min clock check can still carry HLCs
  up to ~10 min apart (HLCs keep the highest clock seen), and those must
  apply normally.
- **Upgrade path**: entries queued before this migration (no HLC, no peer)
  are backfilled by `sync_backfill_legacy()`: HLC from their `ts`, strictly
  increasing per row in outbox order; peer = this device for local entries,
  the sending device for entries relayed on a server; and each row's newest
  version is recorded in `sync_versions`. Old seed entries keep HLC 0 and get
  peer `seed`.
- **Server compaction** (G8): pulls record each client's position in
  `sync_cursors`; below the lowest position, superseded entries and
  tombstones are dropped, while the newest upsert of each row is kept so a
  new client can still join from 0.
- `users.twoFactorSecret` is never captured and an incoming row never
  overwrites it; `role_permissions` / `user_permission_overrides` travel
  with `permissionKey` (pk and row) and are mapped to the local id on apply.
- Fixed: outbox pages were ordered by `seq::text` (the output alias), so
  `1000` sorted before `999` and a page boundary could skip changes.

Not yet: ownership enforcement, branch-filtered pull, HLC-advance on
receive across rows, derived-column recompute, per-peer keys (#82).

Known limits, to address in #82:
- A stale `sync_cursors` row (decommissioned or reset device) pins the
  compaction floor, so the server log stops compacting. Cursors need to
  expire by `seenAt`, or an admin needs to be able to drop a device.
- `sync_versions` tombstones are never pruned.
- Compaction drops tombstones below the floor, so a device that joins later
  in `merge` mode with its own copy of a deleted row never receives that
  delete and will push the row back.
- Legacy `role_permissions` / `user_permission_overrides` entries backfilled
  by `sync_backfill_legacy()` still carry the sender's `permissionId`, not
  `permissionKey`. They fail on FK elsewhere and are dead-lettered.
- The trigger reads and upserts `sync_versions` on every captured write;
  measure this on the order hot path when #82 adds the apply side.
- `sync_safe_seq()` stops at the oldest open writer, so one connection left
  idle in a transaction after writing a synced row stalls pull and push for
  every device until it ends. Consider `idle_in_transaction_session_timeout`
  on the app role, or a "waiting on an open transaction" status.
