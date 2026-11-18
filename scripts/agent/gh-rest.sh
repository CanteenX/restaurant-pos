#!/usr/bin/env bash
# GitHub helpers for Claude cloud sessions. GraphQL is blocked there, so
# `gh issue ...` / `gh pr ...` subcommands fail; these wrap the REST API via
# `gh api` (GH_TOKEN is provided by the session). Source it:
#   source scripts/agent/gh-rest.sh
# Every function prints compact JSON or plain text and returns non-zero on error.
R="${GH_REPO:-CanteenX/restaurant-pos}"

# issues_with_labels "agent:ready,model:sonnet"  -> "number<TAB>title<TAB>labels"
issues_with_labels() {
  gh api "repos/$R/issues?state=open&per_page=100&labels=$1" --paginate \
    --jq '.[] | select(.pull_request|not) | "\(.number)\t\(.title)\t\([.labels[].name]|join(","))"'
}
issue_body()      { gh api "repos/$R/issues/$1" --jq .body; }
issue_state()     { gh api "repos/$R/issues/$1" --jq .state; }
add_label()       { gh api -X POST "repos/$R/issues/$1/labels" -f "labels[]=$2" >/dev/null; }
remove_label()    { gh api -X DELETE "repos/$R/issues/$1/labels/$(printf %s "$2" | sed 's/:/%3A/g')" >/dev/null 2>&1 || true; }
set_state() {      # set_state N agent:review   (removes the other agent:* state labels)
  local n="$1" new="$2" l
  for l in agent:ready agent:in-progress agent:review agent:changes agent:approved; do
    [ "$l" != "$new" ] && remove_label "$n" "$l"
  done
  add_label "$n" "$new"
}
comment()         { gh api "repos/$R/issues/$1/comments" -f body="$2" --jq .html_url; }
last_comment()    { gh api "repos/$R/issues/$1/comments?per_page=100" --jq 'last | "\(.created_at)\t\(.body)"'; }

# open_pr <head-branch> <title> <body-file> [draft:true|false]
open_pr() {
  gh api "repos/$R/pulls" -f base=staging -f head="$1" -f title="$2" \
    -F body=@"$3" -F draft="${4:-false}" --jq '"\(.number)\t\(.html_url)"'
}
pr_ready()        { gh api -X POST "repos/$R/pulls/$1/ccr/ready_for_review" >/dev/null; }
pr_open_list()    { gh api "repos/$R/pulls?state=open&base=staging&per_page=100" --jq '.[] | "\(.number)\t\(.draft)\t\(.head.ref)\t\(.title)"'; }
pr_head_sha()     { gh api "repos/$R/pulls/$1" --jq .head.sha; }
pr_mergeable()    { gh api "repos/$R/pulls/$1" --jq '"\(.mergeable)\t\(.mergeable_state)"'; }
# pr_checks N -> "name<TAB>status<TAB>conclusion" for the PR head commit
pr_checks() {
  gh api "repos/$R/commits/$(pr_head_sha "$1")/check-runs" \
    --jq '.check_runs[] | "\(.name)\t\(.status)\t\(.conclusion)"'
}
pr_last_commit_date() { gh api "repos/$R/pulls/$1/commits?per_page=100" --jq 'last.commit.committer.date'; }
pr_merge_squash() {
  local n="$1" ref
  ref=$(gh api "repos/$R/pulls/$n" --jq .head.ref)
  gh api -X PUT "repos/$R/pulls/$n/merge" -f merge_method=squash --jq .message &&
    gh api -X DELETE "repos/$R/git/refs/heads/$ref" >/dev/null 2>&1 || true
}
# Docker daemon is not running at session start in cloud VMs.
ensure_docker() {
  docker info >/dev/null 2>&1 && return 0
  (sudo -n dockerd >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 1 40); do docker info >/dev/null 2>&1 && return 0; sleep 1; done
  echo "docker daemon failed to start; see /tmp/dockerd.log" >&2; return 1
}
