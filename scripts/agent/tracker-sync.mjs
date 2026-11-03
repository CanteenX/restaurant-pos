#!/usr/bin/env node
// Rebuild the tracker board from GitHub's real state (issues, PRs, CI, review
// verdicts) and write it as ONE document body for the tracker page:
//   tracker/board = { synced_at, counts, rows: { i<N>: {num,title,lane,model,
//                     phase,state,pr,note,updated_at} } }
// Usage: node scripts/agent/tracker-sync.mjs [current.json] > /tmp/board.json
//   current.json (optional) = the existing tracker/board body; human/agent
//   notes are kept when the state did not change.
// Needs `gh` with GH_TOKEN (REST only; works in Claude cloud sessions).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = process.env.GH_REPO || "CanteenX/restaurant-pos";
const SKIP = new Set([2]); // the build-log issue

function gh(path) {
  const out = execFileSync("gh", ["api", "--paginate", path], { encoding: "utf8", maxBuffer: 64 << 20 });
  // --paginate concatenates JSON arrays as "][": normalise into one array.
  return JSON.parse(`[${out.trim().replace(/^\[|\]$/g, "").replace(/\]\s*\[/g, ",")}]`);
}
function ghOne(path) {
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
}
const label = (labels, prefix) => (labels.find((l) => l.startsWith(prefix)) || "").slice(prefix.length);

function linkedIssue(pr) {
  const m = /^claude\/(\d+)-/.exec(pr.head?.ref || "") || /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(pr.body || "");
  return m ? Number(m[1]) : null;
}

function ciState(sha) {
  try {
    const runs = ghOne(`repos/${REPO}/commits/${sha}/check-runs?per_page=50`).check_runs || [];
    if (!runs.length) return "no CI";
    if (runs.some((r) => r.status !== "completed")) return "CI running";
    return runs.every((r) => ["success", "skipped", "neutral"].includes(r.conclusion)) ? "CI pass" : "CI fail";
  } catch { return "CI ?"; }
}

function lastVerdict(prNumber) {
  try {
    const cs = gh(`repos/${REPO}/issues/${prNumber}/comments?per_page=100`);
    const v = [...cs].reverse().find((c) => /^REVIEW: (APPROVED|CHANGES)/.test(c.body || ""));
    return v ? (v.body.startsWith("REVIEW: APPROVED") ? "approved" : "changes requested") : "awaiting review";
  } catch { return ""; }
}

function main() {
  let current = {};
  if (process.argv[2]) {
    try { current = JSON.parse(readFileSync(process.argv[2], "utf8")).rows || {}; } catch { current = {}; }
  }
  const issues = gh(`repos/${REPO}/issues?state=all&per_page=100`).filter((i) => !i.pull_request && !SKIP.has(i.number));
  const prs = gh(`repos/${REPO}/pulls?state=all&per_page=100`);
  const prByIssue = new Map();
  for (const pr of prs) {
    const n = linkedIssue(pr);
    if (!n) continue;
    const prev = prByIssue.get(n);
    // Prefer an open PR, then the most recently updated one.
    if (!prev || (pr.state === "open" && prev.state !== "open") || (pr.state === prev.state && pr.updated_at > prev.updated_at)) prByIssue.set(n, pr);
  }

  const rows = {};
  const counts = { done: 0, review: 0, in_progress: 0, blocked: 0, planned: 0 };
  const now = new Date().toISOString();
  for (const i of issues) {
    const L = i.labels.map((l) => l.name);
    const pr = prByIssue.get(i.number) || null;
    let state = "planned";
    if (i.state === "closed") state = "done";
    else if (L.includes("agent:blocked")) state = "blocked";
    else if (L.includes("agent:in-progress")) state = "in_progress";
    else if (L.some((x) => ["agent:review", "agent:changes", "agent:approved"].includes(x)) || (pr && pr.state === "open")) state = "review";

    let note = "";
    if (state === "done") note = pr && pr.merged_at ? `merged PR #${pr.number}` : "closed";
    else if (state === "review" && pr) note = [pr.draft ? "draft" : "", ciState(pr.head.sha), lastVerdict(pr.number)].filter(Boolean).join(" · ");
    else if (state === "in_progress") note = "builder working";
    else if (state === "blocked") note = "needs a human (see issue)";

    const key = `i${i.number}`;
    const old = current[key];
    const changed = !old || old.state !== state || (old.pr ?? null) !== (pr ? pr.number : null) || old.note !== note;
    rows[key] = {
      num: i.number, title: i.title, lane: label(L, "lane:"), model: label(L, "model:"), phase: label(L, "phase:"),
      state, pr: pr ? pr.number : null, note: note.slice(0, 80),
      updated_at: changed ? now : (old.updated_at || now),
    };
    counts[state] += 1;
  }
  process.stdout.write(JSON.stringify({ synced_at: now, counts, rows }));
  process.stderr.write(`synced ${issues.length} issues: ${JSON.stringify(counts)}\n`);
}

main();
