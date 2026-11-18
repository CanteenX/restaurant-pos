# Planner + tracker agent (daily)

GitHub: `source scripts/agent/gh-rest.sh` (REST; `gh issue …`/`gh pr …` are
blocked in cloud sessions) or the GitHub MCP tools.

## 1. Groom the queue
- Every open issue must have exactly one `lane:`, `model:`, `size:` and
  `phase:` label and testable acceptance criteria. Fix missing ones.
- Split any issue that proved too big into PR-sized issues (link them). New
  issues you create get every label EXCEPT `agent:ready` — list them under
  "Needs you" for the maintainer to approve.
- Issues stuck `agent:in-progress` > 6h with no PR: comment and
  `set_state N agent:ready` (the run probably died).
- PRs whose reviewer wrote `needs opus review`: make sure the issue carries
  `model:opus` so the Opus builder/reviewer pass picks it up.
- Re-check model routing: downgrade over-labelled simple work (opus→sonnet,
  sonnet→haiku) to save usage; never downgrade `risk:high`.

## 2. Check budgets
- Actions minutes this month: sum run durations since the 1st,
  `gh api "repos/CanteenX/restaurant-pos/actions/runs?created=>=$(date -u +%Y-%m-01)&per_page=100" --paginate --jq '.workflow_runs[] | (.run_started_at + " " + .updated_at)'`
  (approximate each run as updated_at − run_started_at). Over 1,500 of
  2,000 → say so in the log and in Needs you.
- Count PRs merged / reviewed / failed in the last 24h.

## 3. Update the build tracker (ArtifactData tool)
Tracker page: https://claude.ai/artifact/UPwdzfrnLQB9qKV2L9PD8Y — every
ArtifactData call takes this `url`. Read before you write and pass the
document's `version` as `if_version` (required on existing documents).
Collections and fields (keep exactly these names):
- `tracker` / `status`: `{phase, headline, agents, claude_usage,
  actions_minutes, updated_at}` (strings; `updated_at` ISO UTC).
- `tracker` / `board`: one document `{synced_at, counts, rows: {i<N>: {num, title, lane, model, phase, state, pr, note, updated_at}}}`, rebuilt hourly by the tracker-sync agent (`node scripts/agent/tracker-sync.mjs`). The planner does not write it.
- `needs` / `<short-id>`: `{order, open, issue, text}` — one per thing only
  the maintainer can do. Set `open: false` when resolved; never delete.
- `log` / `<YYYY-MM-DD>` (today, UTC): `{date, done: [..], next: [..],
  blocked: [..], budgets}` — one line per item, link-free plain text with
  issue/PR numbers. Create today's doc; never rewrite older days.


## 4. Durable mirror
Also post the same daily summary as a comment on GitHub issue #2
(`📊 Build log`) with `comment 2 "<markdown>"`. If ArtifactData fails, the
GitHub comment is the record — say in it that the tracker was not updated.
