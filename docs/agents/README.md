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

## Cloud session facts (verified 3 Nov 2026)
- GitHub GraphQL is blocked: `gh issue …`/`gh pr …` fail. Use
  `source scripts/agent/gh-rest.sh` (REST via `gh api`) or the GitHub MCP
  tools. `GH_TOKEN` is provided; the identity is the maintainer's (Deep1012).
- Docker is installed but not running: call `ensure_docker` (from
  gh-rest.sh) before any `docker`/`install.sh`/`qa.sh`.
- Chrome for Testing is at `$CHROME_PATH`; npm and Docker Hub are reachable;
  ghcr.io is not.
- Progress is published to the tracker page through the ArtifactData tool
  (planner only). Claude Docs is not available in cloud sessions.

## Pacing
Runs at hourly cadence until 2026-11-05 08:00 UTC (cloud credit). After
that, builder runs at an odd UTC hour stop immediately without doing work
(effective every 2 hours), to stay inside the weekly plan limit.

## Live tracker (every role)
Whenever you change an issue's `agent:*` state (claim, PR opened, review
verdict, merge, blocked), also update its row on the tracker page with the
ArtifactData tool (load it with ToolSearch `select:ArtifactData`) on
https://claude.ai/artifact/UPwdzfrnLQB9qKV2L9PD8Y: `get` collection
`tracker` doc `board` (note its `version`), then `update` that doc with
`if_version` = that version and only your row, nested:
`{"rows": {"i<N>": {"state": …, "pr": …, "note": …, "updated_at": "<ISO UTC>"}}}`
(nested objects merge, so other rows are untouched). State is `in_progress`
(claimed), `review` (PR open / changes / approved), `done` (merged),
`blocked`; `note` ≤ 80 chars. On a version conflict, get + update once more;
if it fails again or ArtifactData is unavailable, skip it — the hourly
tracker-sync agent rebuilds the whole board from GitHub anyway. Only the
planner writes `tracker/status`, `needs` and `log`; only tracker-sync writes
the whole `tracker/board`.

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
All lanes run in PARALLEL. Up to two in-progress issues per lane at a time
(the second must not touch the same files as the first):
`lane:foundation` (rebrand, SMTP), `lane:web` (apps/web), `lane:backend`
(apps/backend, packages/types), `lane:integrations` (payments, Tally,
aggregators, i18n infra).
- Conflicts are expected while the rebrand lands. Before opening or updating a
  PR: `git fetch origin && git rebase origin/staging`, resolve conflicts, re-run
  checks, then push (`git push --force-with-lease` on your OWN `claude/*`
  branch is allowed only right after a rebase; never on any other branch).
- New code always uses the names already on `staging` (package scope, image,
  cookie, DB names) — never the old Nodedr names.

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
