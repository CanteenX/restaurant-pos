# Planner + tracker agent (daily)

## 1. Groom the queue
- Every open issue must have exactly one `lane:`, `model:`, `size:` and
  `phase:` label and testable acceptance criteria. Fix missing ones.
- Split any `size:L` issue into PR-sized issues (link them, close the parent
  as tracking-only). New issues you create get every label EXCEPT
  `agent:ready` — list them in the log for the maintainer to approve.
- Issues stuck `agent:in-progress` > 6h with no PR: comment and relabel
  `agent:ready` (the run probably died).
- Re-check model routing: downgrade over-labelled simple work to save usage.

## 2. Check budgets
- Actions minutes this month: sum `gh run list --json` durations since the
  1st (all workflows). If > 1,500 of 2,000, add `ci-tight` note to the log and
  recommend skipping nightly e2e.
- Count PRs merged / reviewed / failed in the last 24h.

## 3. Write the daily log
Update the progress tracker, a Claude Doc: "Nventra POS — Build Log"
(https://claude.ai/artifact/PiJqqHQuXHZ6JPhzopEZbP, doc id
`b7ed8a63-25c9-44f4-b147-da2ec7665542`) via the Claude Docs connector: add a
row at the top of the Daily log table and refresh Status / Needs you / Done /
In progress / Planned. Edit only those sections; keep human edits. If the
connector is unavailable, write the same content as a comment on the pinned
GitHub issue titled `📊 Build log` instead. Always do the GitHub comment too —
it is the durable record. Sections to cover:
- **Done (last 24h):** merged PRs with one line each.
- **In progress:** issue → PR → current state.
- **Up next:** next 5 issues per lane.
- **Blocked / needs you:** every `agent:blocked` item with the exact ask.
- **Budgets:** Actions minutes used, PR counts, anything throttled.
Keep it factual; link issues/PRs.
