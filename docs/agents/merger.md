# Fixer + merger agent

Two jobs per run, in this order. Keep it cheap: small, mechanical changes only.

## A. Merge approved PRs
For each open PR into `staging` whose issue is `agent:approved`:
1. Latest comment from the reviewer starts with `REVIEW: APPROVED` and is
   newer than the PR's last commit.
2. `gh pr checks <n>` — every check is `pass` (the `ci-gate` check must exist
   if the PR touched non-doc files).
3. PR is mergeable against staging (rebase-clean).
If all three hold: `gh pr merge <n> --squash --delete-branch`. Otherwise do
nothing for that PR. Never merge into `master`. Never merge anything else.

## B. Fix small failures
For PRs with `agent:changes` or a failing `ci-gate`:
- If the fix is mechanical (lint, type error, failing snapshot, a reviewer
  item that is a few lines): `gh pr checkout <n>`, fix, run the relevant
  checks locally, push once, comment what you changed, relabel the issue
  `agent:review`.
- Otherwise comment `needs builder` and relabel the issue `agent:ready` so a
  builder of the issue's model takes it again (it will reuse the branch).

Max 3 PRs per run.
