# Autonomous agent pipeline

Claude cloud scheduled tasks build Nventra POS around the clock. GitHub is the
only shared state: issues are the queue, labels are the state machine, PRs are
the work. Any agent can crash or be skipped; the next run picks up from labels.

## Roles (one scheduled task each)
| Role | File | Model | Cadence |
|---|---|---|---|
| Builder (opus) | builder.md | Opus 5.5 | every 3h |
| Builder (sonnet) ×2 | builder.md | Sonnet 5.5 | hourly / 2h |
| Builder (haiku) | builder.md | Haiku 5.5 | hourly / 2h |
| Reviewer | reviewer.md | Sonnet 5.5 (Opus for `risk:high`) | hourly |
| Fixer + merger | merger.md | Haiku 5.5 | hourly |
| Planner + tracker | planner.md | Opus 5.5 | daily 03:30 UTC |

## Model routing (set on every issue by the planner)
- `model:opus` — architecture, auth/security, money/payments, DB migrations,
  cross-cutting refactors (rebrand), anything `risk:high` or `size:L`.
- `model:sonnet` — standard features inside one module with clear criteria.
- `model:haiku` — docs, copy, config, small UI tweaks, simple CI/lint fixes.
A builder only takes issues whose `model:` label matches its own model. If a
task turns out harder than its label, relabel it up (haiku→sonnet→opus) with a
comment explaining why, and stop.

## Issue state machine (labels)
`agent:ready` → `agent:in-progress` → `agent:review` → (`agent:changes` ↔ fixer)
→ `agent:approved` → merged (issue closed by "Closes #N").
`agent:blocked` = needs a human (credentials, hardware, business decision).
Only maintainers add `agent:ready`. Never add it yourself.

## Lanes (avoid merge conflicts)
`lane:foundation` runs alone; while any foundation issue is open, other lanes
do not start new work. Otherwise one in-progress issue per lane at a time:
`lane:web` (apps/web), `lane:backend` (apps/backend, packages/types),
`lane:integrations` (payments, Tally, aggregators, i18n infra).

## Budgets (hard rules)
- **Claude usage:** stop early, never loop. One issue per builder run. If a run
  is going long, push what you have as a draft PR and comment where you stopped.
- **GitHub Actions: 2,000 min/month shared by the whole org.** Do not push
  more than needed: batch commits, push once when tests pass locally. Draft PRs
  do not run CI; mark ready only when done. Never add workflows or triggers.
- Run browser QA in your own VM (`scripts/agent/qa.sh`), not in Actions.

## Human handoff
Anything needing credentials, real hardware, a purchase, a legal/business call,
or the maintainer's laptop: label `agent:blocked`, write exactly what is needed
in a comment, and move on. The planner surfaces these in the daily log.

## Definition of done (every PR)
1. Tests written first and passing (unit; backend e2e if backend changed).
2. `pnpm -r typecheck` and `pnpm -r lint` clean.
3. Browser QA passed in-VM for any user-visible change; screenshots in the PR.
4. Acceptance criteria from the issue each ticked with evidence.
5. Docs updated if behaviour or setup changed. No secrets committed.
