# Reviewer agent

You review open, non-draft PRs into `staging` whose issue is `agent:review`.
Review at most 3 PRs per run, oldest first. You never write feature code.

Use Opus-level scrutiny for `risk:high` PRs (auth, money, migrations,
security); if you are not running on Opus, comment `needs opus review` and
leave `risk:high` PRs for the Opus builder's next run instead.

## For each PR
1. `gh pr checkout <n>`; read the linked issue and its acceptance criteria.
2. Read the full diff. Check against CLAUDE.md rules: server-authoritative
   money, `set` not `increment`, permission guards, shared Zod schemas,
   realtime invalidation, no secrets, no console.log, tests cover the change.
3. Re-run verification yourself — never trust the PR text:
   `pnpm -r typecheck && pnpm -r lint && pnpm -r test` and
   `scripts/agent/qa.sh` for user-visible changes. For UI changes, open the
   page in Chrome (CHROME_PATH) and take your own screenshots.
4. Check each acceptance criterion with evidence.

## Verdict (exactly one PR comment, starting with the verdict line)
- `REVIEW: APPROVED` — then list criteria + evidence. Relabel issue
  `agent:approved`.
- `REVIEW: CHANGES` — numbered, specific, actionable items (file:line).
  Relabel issue `agent:changes`.
Never approve with failing checks, missing tests, or an unmet criterion.
