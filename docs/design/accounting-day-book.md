# Design: accounting day book and approval gaps (#384)

Status: discovery proposal, awaiting independent design review. This proposes a reporting view rather than replacing existing accounting or importing upstream code.

## Existing behaviour and actual gap

Expenses already support branch-scoped pending queues and approve/reject routes (`apps/backend/src/modules/accounting/accounting.controller.ts:51`, `:70`, `:81`, `:101`); approval uses `expenses.approve`, and the service prevents the recorder deciding their own expense (`accounting.service.ts:93`). Threshold rules exist in `expense-approval.ts`; petty-cash payouts and float management already exist in `petty-cash.service.ts`, with transaction-bound audit for payouts. Audit listing exists behind `audit_log.view` (`apps/backend/src/audit/audit.controller.ts:13`). Cash-closing calculations exist in `accounting.calc.ts`. The candidate gap is a single chronological, reconciled day-book view across eligible financial sources, with clear drill-through and permission boundaries. It is not evidence that approvals, petty cash, or an audit log are missing.

## Data and behaviour

Start with a read-only projection over existing branch-scoped sales/payments, refunds, approved expenses, petty-cash entries and cash-closing records. Define source eligibility, event date versus business day, sign conventions, treatment of voided/rejected/pending events, returns and top-ups so money is not counted twice. Include source type and stable source ID; link to an authorised detail view without exposing its payload to users lacking that source's permission. Return paginated deterministic ordering by timestamp, source type and ID, totals only across authorised sources, and an explicit incomplete/permission-limited indicator. Keep audit events separate from accounting entries; no new mutable journal or financial authority is introduced. Query boundaries must filter restaurant and branch before aggregation and exports. Specify timezone and rounding before implementation, including DST-independent business-day tests.

## Permissions and migration

Use existing data-driven permission grants (`accounting.manage`, `expenses.approve`, `petty_cash.manage`, `reports.financial.view`, `audit_log.view`) and live DENY semantics; never role-name checks. Resolve during independent design review whether a new independently grantable `accounting.daybook.view` is required, and require both it and each source's read permission where applicable. Preserve Admin lock and grant ceilings. All request inputs use Zod; verify branch access server-side and use parameterised queries. Initial projection needs no data migration; if performance requires indexes, add them through an additive Prisma migration with populated-install upgrade/rollback tests and a backup prerequisite. Never rewrite historical expenses or audit rows.

## Tests and open design questions

Unit tests cover source eligibility, signs, timezone boundaries, rounding and non-double-counting. PostgreSQL/API tests cover cross-restaurant IDs, per-source permission/DENY combinations, deterministic pagination, aggregates matching visible rows, concurrent changes and export fences. Browser tests cover a permission-limited day book, date filter and source navigation. Before implementation agree which financial sources and statuses belong, whether partial results may be shown, business-day cutoff/timezone, adjustment/refund treatment and whether a separate read-only permission is necessary. Security review should check information leaks through totals and drill-through, approval segregation and audit semantics. No new approval workflow should be built without a demonstrated gap.
