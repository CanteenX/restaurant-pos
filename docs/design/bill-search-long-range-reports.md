# Bill search and long-range reports (design, #382)

Status: proposed; independent design review required before implementation.

## Current state and goal

Reports require `reports.access`, enforce branch access, and currently reject ranges longer than 366 days (`apps/backend/src/modules/reports/reports.controller.ts`, `reports.service.ts`). Existing order list and detail routes require `orders.create` (`apps/backend/src/modules/orders/orders.controller.ts`), so granting report-only users those routes would broaden write-related authority. Add up to five years of branch-scoped historical reporting, useful date presets, and read-only bill search/detail for authorized report users without granting order creation or editing.

## Data and interface

Reuse existing `Order`, order lines, payment and branch relations. Define bill search and detail projections explicitly: bill number, business date/time, status, totals/tax and item lines; exclude personal identifiers, payment tokens and internal notes unless a separate existing permission and an explicit product decision allow them. Search by bounded bill number and date range with stable cursor pagination, maximum page size and cancellation; never allow unrestricted cross-branch search. Unknown or unauthorized IDs return a non-disclosing 404.

Offer branch-local today, yesterday, week, month, year and custom presets. Validate actual calendar dates and an inclusive maximum of five years server-side, using the branch timezone and correct DST/leap-day handling. Clarify the meaning of sales/bill date versus creation date; show it on screen. Long ranges must not load unbounded rows: use aggregations, pagination, query timeouts and performance budgets measured against representative data. Preserve existing report semantics, financial detail restrictions and `data.export` checks for exports.

## Permissions and migration

Propose a distinct `reports.bills.read` permission, stored and granted as data and enforced together with `reports.access` and branch membership at the API boundary. No role-name checks or automatic escalation: independently review seed/backfill policy and per-user DENY behavior before granting existing users access. Keep all mutation endpoints behind existing permissions. Validate controller inputs with Zod, use parameterized Prisma queries, and project fields deliberately.

MVP can reuse existing order data; no data conversion is needed. Add only query indexes justified by measured plans, via a backward-compatible migration after backup and with a rollback plan. Permission-key rollout must drain old instances before new keys are granted. Existing installations retain their current grants until an explicitly reviewed migration assigns new access.

## Verification and risks

Unit tests cover presets, calendar boundaries, invalid/reversed ranges, leap days, five-year limits and timeout handling. API/database tests seed two restaurants and branches, verify report-only read access and mutation denial, DENY overrides, cross-tenant 404, field redaction, pagination and exports. Performance tests exercise five years of synthetic data and query plans; Playwright verifies presets, bill search/detail, empty/error states, accessibility and no order-edit controls. Test date semantics, data retention and report-type-specific limits before widening each report; do not assume every aggregate is safe at five years.
