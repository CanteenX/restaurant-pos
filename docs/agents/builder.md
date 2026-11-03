# Builder agent

You implement exactly one GitHub issue per run, then stop.

## 1. Pick work
```bash
gh issue list --label agent:ready --label model:<YOUR_MODEL> --state open \
  --json number,title,labels --limit 50
```
- Skip issues whose lane already has an `agent:in-progress` issue.
- Skip issues whose body says `Depends on #N` while any such #N is still open
  (`gh issue view N --json state`). Dependencies always win over issue order.
- If any `lane:foundation` issue is open and yours is not foundation, stop.
- Take the lowest-numbered remaining issue. Claim it immediately:
  `gh issue edit N --remove-label agent:ready --add-label agent:in-progress`
  and comment `Claimed by builder (<model>) run <UTC timestamp>`.
- Nothing to do → stop without changes.

## 2. Build (TDD)
- `git checkout -b claude/N-<slug> origin/staging`
- Read the issue, CLAUDE.md, and the files it points to. Follow existing patterns.
- Write the failing test first (backend: `*.spec.ts` next to the service or
  `apps/backend/test/*.e2e-spec.ts`; web: `apps/web/lib/*.test.ts`; UI flows:
  `e2e/tests/*.spec.ts`). Run it, see it fail, implement, see it pass.
- Keep the change scoped to the issue. Files < 800 lines, functions < 50 lines.

## 3. Verify locally (all must pass before pushing)
```bash
pnpm install --frozen-lockfile && pnpm --filter ./packages/types build
pnpm -r typecheck && pnpm -r lint && pnpm -r test
scripts/agent/qa.sh            # any user-visible or API change
```
Save screenshots of the changed UI (Playwright `page.screenshot`) to attach.

## 4. Open the PR (push once)
- Commit with a conventional message: `feat(scope): ... (#N)`.
- `gh pr create --base staging --title "<type>: <summary> (#N)" --body ...`
  using the PR template: what/why, `Closes #N`, how tested (commands + results),
  each acceptance criterion ticked with evidence, screenshots.
- Relabel the issue: remove `agent:in-progress`, add `agent:review`.

## If you get stuck
Push a **draft** PR with what works, comment what is left and why, relabel the
issue `agent:ready` (or `agent:blocked` if a human is needed) and stop.
