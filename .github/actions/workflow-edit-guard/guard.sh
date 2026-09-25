#!/usr/bin/env bash
# workflow-edit-guard (REL-1119)
#
# Fails when a pull request produced by coding automation (Google Jules /
# "Bolt") changes CI definitions under .github/workflows/** or
# .github/actions/**. Humans and Dependabot are not affected.
#
# A PR counts as automation when ANY of these hold:
#   - head branch matches ^(jules|bolt)[-/]      (jules-*, jules/*, bolt-*, bolt/*)
#   - PR author is in GUARD_AUTOMATION_ACCOUNTS
#   - any PR commit is authored/committed by an automation account
#     (Jules opens PRs under the human owner's login but commits as
#     google-labs-jules[bot], so the commit check is the reliable signal)
#   - the PR body carries the Jules footer ("PR created automatically by Jules")
#
# Inputs (env):
#   GUARD_HEAD_REF       head branch name
#   GUARD_PR_AUTHOR      PR author login
#   GUARD_BODY_FILE      file containing the PR body (may be empty)
#   GUARD_COMMITS_FILE   JSON array from GET /repos/{r}/pulls/{n}/commits
#   GUARD_FILES_FILE     JSON array from GET /repos/{r}/pulls/{n}/files
#   GUARD_AUTOMATION_ACCOUNTS  optional, space-separated logins
#
# Exit 0 = pass, 1 = blocked, 2 = bad input.
set -euo pipefail

accounts="${GUARD_AUTOMATION_ACCOUNTS:-google-labs-jules[bot] google-labs-jules jules[bot]}"
head_ref="${GUARD_HEAD_REF:-}"
author="${GUARD_PR_AUTHOR:-}"
body_file="${GUARD_BODY_FILE:-/dev/null}"
commits_file="${GUARD_COMMITS_FILE:?GUARD_COMMITS_FILE required}"
files_file="${GUARD_FILES_FILE:?GUARD_FILES_FILE required}"

for f in "$commits_file" "$files_file"; do
  jq -e 'type == "array"' "$f" >/dev/null 2>&1 || { echo "::error::workflow-edit-guard: $f is not a JSON array"; exit 2; }
done

reasons=()

if [[ "$head_ref" =~ ^(jules|bolt)[-/] ]]; then
  reasons+=("head branch '$head_ref' matches jules-*/jules/*/bolt-*/bolt/*")
fi

read -r -a account_list <<<"$accounts"
accounts_json=$(printf '%s\n' "${account_list[@]}" | jq -R . | jq -s .)

if jq -en --arg a "$author" --argjson acc "$accounts_json" '$acc | index($a) != null' >/dev/null; then
  reasons+=("PR author '$author' is an automation account")
fi

bot_commits=$(jq -r --argjson acc "$accounts_json" '
  [ .[]
    | select(
        ([.author.login?, .committer.login?] | map(select(. != null)) | any(. as $l | $acc | index($l) != null))
        or ((.commit.author.email // "") | test("google-labs-jules"; "i"))
        or ((.commit.committer.email // "") | test("google-labs-jules"; "i"))
      )
    | .sha[0:8] ] | join(" ")' "$commits_file")
if [[ -n "$bot_commits" ]]; then
  reasons+=("commit(s) authored by an automation account: $bot_commits")
fi

if grep -qiE 'PR created automatically by Jules|jules\.google\.com/task/' "$body_file" 2>/dev/null; then
  reasons+=("PR body carries the Jules automation footer")
fi

protected=$(jq -r '
  .[] | [.filename, (.previous_filename // empty)] | .[]
  | select(test("^\\.github/(workflows|actions)/"))' "$files_file" | sort -u)

if [[ ${#reasons[@]} -eq 0 ]]; then
  echo "workflow-edit-guard: PASS - not an automation PR (branch='$head_ref', author='$author')."
  exit 0
fi

if [[ -z "$protected" ]]; then
  echo "workflow-edit-guard: PASS - automation PR, but it does not touch .github/workflows/** or .github/actions/**."
  printf '  signal: %s\n' "${reasons[@]}"
  exit 0
fi

echo "::error title=workflow-edit-guard::Automation PRs may not modify CI workflows or actions. Remove these changes, or have a human open the workflow change separately."
echo "workflow-edit-guard: FAIL"
echo "Why this PR is treated as automation:"
printf '  - %s\n' "${reasons[@]}"
echo "Protected files changed (.github/workflows/** or .github/actions/**):"
while IFS= read -r p; do echo "  - $p"; echo "::error file=$p::automation PR modifies protected CI path $p"; done <<<"$protected"
exit 1
