# Builder agent

You implement exactly one GitHub issue per run, then stop.

**GitHub access:** GraphQL is blocked in cloud sessions, so `gh issue …` and
`gh pr …` fail. Use `source scripts/agent/gh-rest.sh` (REST helpers) or the
GitHub MCP tools (`mcp__github__issue_read`, `issue_write`, `add_issue_comment`,
`create_pull_request`, `pull_request_read`). Start Docker with `ensure_docker`.

## 1. Pick work
```bash
source scripts/agent/gh-rest.sh
issues_with_labels "agent:ready,model:<YOUR_MODEL>"      # number, title, labels
issues_with_labels "agent:in-progress"                    # busy lanes
issues_with_labels "lane:foundation"                      # foundation gate
```
- Skip issues whose lane already has an `agent:in-progress` issue.
- If any `lane:foundation` issue is open and yours is not foundation, stop.
- Skip issues whose body says `Depends on #N` while any such #N is still open
  (`issue_state N`). Dependencies always win over issue order.
- Take the lowest-numbered remaining issue. Claim it immediately:
  `set_state N agent:in-progress` and
  `comment N "Claimed by builder (<model>) at $(date -u +%FT%TZ)"`.
- Nothing to do → stop without changes.

## 2. Build (TDD)
- `git fetch origin && git checkout -b claude/N-<slug> origin/staging`
  (if `origin/claude/N-*` already exists from an earlier run, continue on it).
- Read the issue (`issue_body N`), CLAUDE.md, and the files it points to.
- Write the failing test first (backend: `*.spec.ts` next to the service or
  `apps/backend/test/*.e2e-spec.ts`; web: `apps/web/lib/*.test.ts`; UI flows:
  `e2e/tests/*.spec.ts`). Run it, see it fail, implement, see it pass.
- Keep the change scoped to the issue. Files < 800 lines, functions < 50 lines.

## 3. Verify locally (all must pass before pushing)
```bash
corepack enable && pnpm install --frozen-lockfile && pnpm --filter ./packages/types build
pnpm --filter ./apps/backend exec prisma generate
pnpm -r typecheck && pnpm -r lint && pnpm -r test
ensure_docker && scripts/agent/qa.sh      # any user-visible or API change
```
Backend e2e needs Postgres: `docker run -d --name pg -e POSTGRES_USER=ci -e POSTGRES_PASSWORD=ci -e POSTGRES_DB=ci -p 5432:5432 postgres:16-alpine`,
then `DATABASE_URL=postgresql://ci:ci@localhost:5432/ci JWT_SECRET=ci-only-secret-ci-only-secret pnpm --filter ./apps/backend exec prisma migrate deploy && … test:e2e`.
Save screenshots of changed UI (Playwright `page.screenshot`) and describe them.

## 4. Open the PR (push once)
- Commit: `feat(scope): ... (#N)` (conventional commits).
- `git push -u origin claude/N-<slug>`
- Write the body to a file using `.github/PULL_REQUEST_TEMPLATE.md`: what/why,
  `Closes #N`, commands run + results, each acceptance criterion ticked with
  evidence, screenshot notes. Then `open_pr claude/N-<slug> "<type>: <summary> (#N)" body.md`.
- `set_state N agent:review`.

## If you get stuck
Push and `open_pr … body.md true` (draft) with what works, comment what is
left and why, `set_state N agent:ready` (or add `agent:blocked` if a human is
needed) and stop.
