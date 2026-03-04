#!/usr/bin/env bash
# PR stats for a user across a GitHub org using only the gh CLI.
# Requires: gh auth login (or GITHUB_TOKEN), jq
#
# Usage:
#   ./github-pr-stats-gh.sh [USER] [ORG]
#   ./github-pr-stats-gh.sh              # uses @me and Future-Secure-AI
#   ./github-pr-stats-gh.sh juan         # you, org Future-Secure-AI
#   ./github-pr-stats-gh.sh juan MyOrg   # you, org MyOrg

set -e
AUTHOR="${1:-@me}"
ORG="${2:-Future-Secure-AI}"
LIMIT="${GH_PR_STATS_LIMIT:-1000}"

if ! command -v gh &>/dev/null; then
  echo "Error: gh CLI not found. Install from https://cli.github.com/" >&2
  exit 1
fi
if ! command -v jq &>/dev/null; then
  echo "Error: jq required. Install jq." >&2
  exit 1
fi

echo "Organization: $ORG" >&2
echo "Author: $AUTHOR" >&2
echo "Fetching PRs (limit $LIMIT)..." >&2

# Single search returns state as: open | closed | merged
JSON=$(gh search prs --author="$AUTHOR" --owner="$ORG" -L "$LIMIT" --json number,state,repository)

# Build summary + byRepo in one jq pass to avoid shell quoting issues
result=$(echo "$JSON" | jq -c --arg org "$ORG" --arg author "$AUTHOR" '
  (length) as $total
  | (map(select(.state == "merged")) | length) as $merged
  | (map(select(.state == "closed")) | length) as $closedNotMerged
  | (map(select(.state == "open")) | length) as $open
  | ($total | if . > 0 then (($merged / .) * 100) | tostring + "%" else "N/A" end) as $rate
  | (group_by(.repository.nameWithOwner)
     | map({
         key: .[0].repository.nameWithOwner,
         value: (
           (length) as $t
           | (map(select(.state == "merged")) | length) as $m
           | (map(select(.state == "closed")) | length) as $c
           | (map(select(.state == "open")) | length) as $o
           | { total: $t, merged: $m, closedNotMerged: $c, open: $o }
         )
       })
     | from_entries) as $byRepo
  | {
      organization: $org,
      user: $author,
      totalPRs: $total,
      merged: $merged,
      closedNotMerged: $closedNotMerged,
      open: $open,
      acceptanceRate: $rate,
      byRepo: $byRepo
    }
')

echo "$result" | jq -e . >/dev/null 2>&1 || { echo "No PRs found or gh returned an error." >&2; exit 1; }

# Output JSON
echo "$result" | jq .

# Human-readable summary to stderr
echo "" >&2
echo "--- Summary ---" >&2
echo "$result" | jq -r '
  "Total PRs: \(.totalPRs)",
  "Merged: \(.merged)",
  "Closed (not merged): \(.closedNotMerged)",
  "Open: \(.open)",
  "Acceptance rate (merged/total): \(.acceptanceRate)"
' >&2
