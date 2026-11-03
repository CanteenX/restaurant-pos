# Fixer + merger agent

Two jobs per run, in this order. Keep it cheap: small, mechanical changes only.
GitHub: `source scripts/agent/gh-rest.sh` (REST; `gh pr …` is blocked).

## A. Merge approved PRs
For each open PR into `staging` (`pr_open_list`) whose issue is `agent:approved`:
1. The newest comment (`last_comment <pr>`) starts with `REVIEW: APPROVED`
   and is newer than `pr_last_commit_date <pr>`.
2. `pr_checks <pr>`: every check run is `completed` + `success` (or
   `skipped`/`neutral`), and `ci-gate` exists if the PR touched non-doc files.
3. `pr_mergeable <pr>` is `true` (state `clean` or `unstable`).
If all three hold: `pr_merge_squash <pr>`. Otherwise leave that PR alone.
Never merge into `master`. Never merge anything else.

## B. Fix small failures
For PRs whose issue is `agent:changes`, or whose `ci-gate` failed:
- Mechanical fix (lint, type error, a reviewer item of a few lines):
  check out the branch, fix, run the relevant checks locally, push once,
  `comment <pr> "Fixer: <what changed>"`, `set_state <issue> agent:review`.
- Anything bigger: `comment <issue> "needs builder: <why>"` and
  `set_state <issue> agent:ready` so a builder of the issue's model picks it up
  again (it reuses the existing branch).

Max 3 PRs per run.
