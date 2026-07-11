#!/usr/bin/env bash
# standup-count-task-ids.test.sh
#
# REGRESSION GUARD for the standup task-counting bug.
#
# scripts/standup-heartbeat.sh counts tasks in each Kanban column from the JSON
# the API returns. Four columns are counted. Two of them (INBOX, TESTING) used the
# correct count_task_ids() helper; the other two (IN_PROGRESS at :91, ASSIGNED at
# :97) still used the raw pattern:
#
#     COUNT=$(echo "$TASKS" | grep -c '"id"' || echo "0")
#
# which carries TWO distinct bugs:
#
#   1. MISCOUNT. `grep -c` counts matching *LINES*, not occurrences. The API
#      returns single-line JSON, so any non-empty response counts as exactly 1 —
#      10 in-progress tasks report as "1".
#
#   2. "0\n0" CORRUPTION. On zero matches `grep -c` prints "0" AND exits 1, so the
#      `|| echo "0"` ALSO fires. COUNT becomes the two-line string "0\n0". The
#      alert test at :105 — `[ "$ASSIGNED_COUNT" -gt 0 ]` — then dies with
#      "integer expression expected", so the rework alert is broken exactly when
#      the queue is empty.
#
# Both call sites now use count_task_ids() (grep -o '"id"' | wc -l), which counts
# occurrences and yields a clean single "0".
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HEARTBEAT="$REPO_ROOT/scripts/standup-heartbeat.sh"

FAILED=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; echo "  $2"; FAILED=1; }

# Pull count_task_ids() out of the real script so we test the SHIPPING helper,
# not a copy that could drift from it.
eval "$(sed -n '/^count_task_ids()/,/^}/p' "$HEARTBEAT")"

if ! declare -F count_task_ids >/dev/null; then
  echo "not ok - could not extract count_task_ids() from $HEARTBEAT"
  exit 1
fi

# ── Bug 1: miscount on single-line JSON ──────────────────────────────────────
THREE='[{"id":"a","title":"x"},{"id":"b","title":"y"},{"id":"c","title":"z"}]'
got="$(count_task_ids "$THREE")"
if [ "$got" = "3" ]; then
  pass "3 tasks in single-line JSON -> 3 (not 1)"
else
  fail "3 tasks in single-line JSON -> 3 (not 1)" "expected 3, got '$got'"
fi

# The precise old-vs-new contrast: the buggy pattern returns 1 here.
old="$(printf '%s' "$THREE" | grep -c '"id"' || echo "0")"
if [ "$old" = "1" ] && [ "$got" = "3" ]; then
  pass "regression pinned: buggy 'grep -c' yields 1 where count_task_ids yields 3"
else
  fail "regression pinned: buggy 'grep -c' yields 1 where count_task_ids yields 3" \
       "grep -c gave '$old', count_task_ids gave '$got'"
fi

# ── Bug 2: empty response must yield a CLEAN single "0", never "0\n0" ─────────
for empty in '[]' ''; do
  got="$(count_task_ids "$empty")"
  lines="$(printf '%s' "$got" | wc -l | tr -d ' ')"
  if [ "$got" = "0" ] && [ "$lines" = "0" ]; then
    pass "empty response ('${empty}') -> clean single '0'"
  else
    fail "empty response ('${empty}') -> clean single '0'" \
         "got '$(printf '%s' "$got" | tr '\n' '/')' (must be exactly one line)"
  fi

  # The count must survive an arithmetic test — this is what broke at :105.
  if [ "$got" -gt 0 ] 2>/dev/null || [ "$got" -eq 0 ] 2>/dev/null; then
    pass "empty response ('${empty}') -> count is a valid integer for [ -gt ]"
  else
    fail "empty response ('${empty}') -> count is a valid integer for [ -gt ]" \
         "'[ \"$got\" -gt 0 ]' raised 'integer expression expected'"
  fi
done

# ── The fix is actually WIRED IN: no raw grep -c call sites remain ───────────
if grep -qE "grep -c '\"id\"'" "$HEARTBEAT"; then
  fail "no raw \"grep -c '\\\"id\\\"'\" call sites remain in standup-heartbeat.sh" \
       "still present at: $(grep -nE "grep -c '\"id\"'" "$HEARTBEAT" | cut -d: -f1 | tr '\n' ' ')"
else
  pass "no raw \"grep -c '\\\"id\\\"'\" call sites remain in standup-heartbeat.sh"
fi

# All four columns must go through the helper.
uses="$(grep -c 'count_task_ids "' "$HEARTBEAT")"
if [ "$uses" -ge 4 ]; then
  pass "all 4 task columns count via count_task_ids() (found $uses call sites)"
else
  fail "all 4 task columns count via count_task_ids()" "only $uses call site(s) found, expected >= 4"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "PASS — standup task counting is correct at every call site."
  exit 0
else
  echo "FAIL — standup task counting regressed."
  exit 1
fi
