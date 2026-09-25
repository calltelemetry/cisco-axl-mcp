#!/usr/bin/env bash
# Fixture self-test for guard.sh (REL-1119). Proves the guard FAILS on planted
# workflow/action edits by automation and PASSES everything else.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

human_commit='[{"sha":"aaaaaaaa11","author":{"login":"calltelemetry-jason"},"committer":{"login":"web-flow"},"commit":{"author":{"email":"dev@example.com"},"committer":{"email":"noreply@github.com"}}}]'
jules_commit='[{"sha":"bbbbbbbb22","author":{"login":"google-labs-jules[bot]"},"committer":{"login":"google-labs-jules[bot]"},"commit":{"author":{"email":"161369871+google-labs-jules[bot]@users.noreply.github.com"},"committer":{"email":"161369871+google-labs-jules[bot]@users.noreply.github.com"}}}]'
dependabot_commit='[{"sha":"cccccccc33","author":{"login":"dependabot[bot]"},"committer":{"login":"web-flow"},"commit":{"author":{"email":"49699333+dependabot[bot]@users.noreply.github.com"},"committer":{"email":"noreply@github.com"}}}]'
wf_edit='[{"filename":".github/workflows/bot-reviews-gate.yaml","status":"modified"}]'
action_edit='[{"filename":".github/actions/setup/action.yml","status":"modified"}]'
rename_out='[{"filename":"scripts/gate.yaml","previous_filename":".github/workflows/gate.yaml","status":"renamed"}]'
src_edit='[{"filename":"src/app.ts","status":"modified"},{"filename":".github/dependabot.yml","status":"modified"}]'

pass=0; fail=0
run() { # name expected_exit branch author body commits files
  local name="$1" want="$2"
  printf '%s' "$5" >"$tmp/body"; printf '%s' "$6" >"$tmp/commits.json"; printf '%s' "$7" >"$tmp/files.json"
  set +e
  GUARD_HEAD_REF="$3" GUARD_PR_AUTHOR="$4" GUARD_BODY_FILE="$tmp/body" \
    GUARD_COMMITS_FILE="$tmp/commits.json" GUARD_FILES_FILE="$tmp/files.json" \
    bash "$here/guard.sh" >"$tmp/out" 2>&1
  local got=$?
  set -e
  if [[ "$got" == "$want" ]]; then pass=$((pass+1)); echo "ok   - $name (exit $got)";
  else fail=$((fail+1)); echo "FAIL - $name: want exit $want, got $got"; sed 's/^/       /' "$tmp/out"; fi
}

# Negative proof: planted workflow/action edits by automation must be blocked.
run "jules-* branch edits workflow"            1 "jules-123-abc"            "calltelemetry-jason" "" "$human_commit" "$wf_edit"
run "jules/ branch edits workflow"             1 "jules/upgrade"            "calltelemetry-jason" "" "$human_commit" "$wf_edit"
run "bolt-* branch edits action"               1 "bolt-perf-1"              "calltelemetry-jason" "" "$human_commit" "$action_edit"
run "bolt/ branch renames workflow out"        1 "bolt/zero-copy"           "calltelemetry-jason" "" "$human_commit" "$rename_out"
run "neutral branch, Jules bot commits"        1 "chore/upgrade-deps-99"    "calltelemetry-jason" "" "$jules_commit" "$wf_edit"
run "neutral branch, Jules body footer"        1 "update-yarn-modules-1"    "calltelemetry-jason" "*PR created automatically by Jules for task [1](https://jules.google.com/task/1)*" "$human_commit" "$wf_edit"
run "bot account is PR author"                 1 "feature/x"                "google-labs-jules[bot]" "" "$human_commit" "$wf_edit"
# Positive controls: must pass.
run "human edits workflow"                     0 "ci/REL-1-fix-gate"        "calltelemetry-jason" "" "$human_commit" "$wf_edit"
run "dependabot github-actions bump"           0 "dependabot/github_actions/actions/checkout-6" "dependabot[bot]" "" "$dependabot_commit" "$wf_edit"
run "jules branch, non-CI files only"          0 "jules-123-abc"            "calltelemetry-jason" "" "$jules_commit" "$src_edit"
run "human, no files"                          0 "fix/API-1-x"              "calltelemetry-jason" "" "$human_commit" "[]"
# Bad input is an error, never a silent pass.
run "malformed files json"                     2 "jules-1"                  "x" "" "$human_commit" "not-json"

echo "workflow-edit-guard self-test: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
