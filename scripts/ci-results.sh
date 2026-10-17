#!/usr/bin/env bash
# Show the latest CI run for this branch: each job, its result, and the
# annotations written by scripts/ci-annotate.mjs (test counts, failing tests,
# compiler errors). Works where raw Actions logs cannot be downloaded.
#
#   scripts/ci-results.sh            # latest run of the current branch
#   scripts/ci-results.sh <run-id>   # a specific run
set -euo pipefail

repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
branch=$(git rev-parse --abbrev-ref HEAD)
run=${1:-$(gh run list --branch "$branch" --limit 1 --json databaseId -q '.[0].databaseId')}

gh run view "$run" --json headSha,status,conclusion,displayTitle \
  -q '"run \(.headSha[0:7]) \(.status)/\(.conclusion // "-"): \(.displayTitle)"'

for job in $(gh api "repos/$repo/actions/runs/$run/jobs" -q '.jobs[].id'); do
  gh api "repos/$repo/actions/jobs/$job" \
    -q '"\n== \(.name): \(.status)/\(.conclusion // "-")" + ([.steps[] | select(.conclusion == "failure") | "   failed step: " + .name] | if length > 0 then "\n" + join("\n") else "" end)'
  gh api "repos/$repo/check-runs/$job/annotations" \
    -q '.[] | select(.message | test("Node.js 20") | not) | "[\(.annotation_level)] \(.title)\n\(.message)\n"' || true
done
