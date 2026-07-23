#!/usr/bin/env bash
# fix-cron-delivery.test.sh — U012 verification.
#
# Tests scripts/fix-cron-delivery.sh: it gives the fleet-heartbeat and
# mission-control-standup OpenClaw crons an explicit delivery route (channel=
# telegram + to=<chat_id>) so they stop failing closed. Application is a Named
# Stop; the default is a DRY-RUN that prints the edits without executing them.
#
# Usage:
#   bash scripts/fix-cron-delivery.test.sh
#
# Pass criteria (all must hold):
#   1. bash -n scripts/fix-cron-delivery.sh passes (AC#1).
#   2. AC#1: --dry-run prints the two `openclaw cron edit` commands with
#      --channel telegram + --to <chat_id>, and applies none (exit 0).
#   3. AC#2: the edit is IN-PLACE (`cron edit`, never `cron add`/append) so it
#      is idempotent — re-running sets the same fields.
#   4. AC#3: the chat_id is read from the environment, NEVER hardcoded — the
#      script carries no literal chat id, and different env values flow through.
#   5. Edge: no chat_id -> fail closed (exit 2, no edits).
#   6. Edge: no standup cron id + no openclaw CLI -> fail closed (exit 2).
#
# The script is exercised with a stubbed `openclaw` on PATH so the test is
# hermetic (never touches a real cron) and so `--apply` can be observed safely.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/fix-cron-delivery.sh"

pass() { echo "[PASS] $*"; }
fail() { echo "[FAIL] $*" >&2; exit 1; }

# ─── GUARD 1: bash -n (AC#1) ─────────────────────────────────────────────────
bash -n "$SCRIPT" || fail "bash -n fix-cron-delivery.sh failed (AC#1)"
pass "bash -n fix-cron-delivery.sh passes (AC#1)"

# ─── Hermetic harness: stub openclaw + temp dirs ─────────────────────────────
TMPDIR_FIXTURE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_FIXTURE"' EXIT
STUB_BIN="$TMPDIR_FIXTURE/bin"
mkdir -p "$STUB_BIN"
# Stub openclaw: records every invocation so we can assert what --apply ran.
cat > "$STUB_BIN/openclaw" <<'STUB'
#!/usr/bin/env bash
echo "openclaw $*" >> "${OPENCLAW_STUB_LOG:-/dev/null}"
# `cron list` returns a standup line so id-discovery has something to find.
if [ "$1" = "cron" ] && [ "$2" = "list" ]; then
  echo "mission-control-standup  11111111-2222-3333-4444-555555555555  0 9 * * *"
fi
exit 0
STUB
chmod +x "$STUB_BIN/openclaw"
export PATH="$STUB_BIN:$PATH"

CHAT_ID="999000111"
export TREVOR_TELEGRAM_CHAT_ID="$CHAT_ID"
export MISSION_CONTROL_STANDUP_CRON_ID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
export OPENCLAW_STUB_LOG="$TMPDIR_FIXTURE/openclaw.log"

# ─── AC#1: --dry-run prints 2 edits, applies none ────────────────────────────
: > "$OPENCLAW_STUB_LOG"
rc=0
out="$("$SCRIPT" --dry-run 2>/dev/null)" || rc=$?
[ "$rc" -eq 0 ] || fail "AC#1: --dry-run must exit 0, got $rc"
[ "$(printf '%s\n' "$out" | grep -c 'openclaw cron edit')" -eq 2 ] \
  || fail "AC#1: --dry-run must print exactly 2 'openclaw cron edit' lines, got: $out"
printf '%s\n' "$out" | grep -q -- "--channel telegram" \
  || fail "AC#1: edits must set --channel telegram, got: $out"
printf '%s\n' "$out" | grep -q -- "--to $CHAT_ID" \
  || fail "AC#1: edits must set --to <chat_id>, got: $out"
# Dry-run must NOT have invoked openclaw (applied nothing).
[ ! -s "$OPENCLAW_STUB_LOG" ] || fail "AC#1: --dry-run must apply nothing, but openclaw was called: $(cat "$OPENCLAW_STUB_LOG")"
pass "AC#1: --dry-run prints 2 edits (channel=telegram, to=<chat_id>), applies none"

# ─── AC#2: the edit is in-place (cron edit, never cron add) => idempotent ────
grep -q 'cron edit' "$SCRIPT" || fail "AC#2: script must use 'cron edit' (in-place)"
if grep -qE 'cron (add|create|append)' "$SCRIPT"; then
  fail "AC#2: script must NOT use 'cron add/create/append' (would duplicate, not idempotent)"
fi
pass "AC#2: edit is in-place ('cron edit', never add/append) — idempotent"

# ─── AC#3: chat_id from env, never hardcoded ─────────────────────────────────
# The script must reference the env var and must NOT contain the literal chat id.
grep -q 'TREVOR_TELEGRAM_CHAT_ID' "$SCRIPT" \
  || fail "AC#3: script must read the chat id from TREVOR_TELEGRAM_CHAT_ID"
if grep -q "$CHAT_ID" "$SCRIPT"; then
  fail "AC#3: script must NOT hardcode a chat id (found literal '$CHAT_ID')"
fi
# Different env value flows through to the printed edit.
out2="$(TREVOR_TELEGRAM_CHAT_ID=555666777 "$SCRIPT" --dry-run 2>/dev/null)"
printf '%s\n' "$out2" | grep -q -- "--to 555666777" \
  || fail "AC#3: a different env chat_id must flow through, got: $out2"
pass "AC#3: chat_id read from env, never hardcoded; env value flows through"

# ─── Edge: no chat_id -> fail closed (exit 2, no edits) ──────────────────────
: > "$OPENCLAW_STUB_LOG"
rc=0
out="$(env -u TREVOR_TELEGRAM_CHAT_ID -u RESCUE_RANGERS_CHAT_ID "$SCRIPT" --apply 2>&1)" || rc=$?
[ "$rc" -eq 2 ] || fail "edge: missing chat_id must exit 2 (fail closed), got $rc: $out"
[ ! -s "$OPENCLAW_STUB_LOG" ] || fail "edge: missing chat_id must apply nothing"
pass "edge: no chat_id -> fail closed (exit 2), no edits"

# ─── Edge: no standup cron id + no openclaw CLI -> fail closed (exit 2) ──────
# A PATH that has the standard utilities the script needs (bash, date, grep,
# head) but NOT openclaw, so id discovery fails. Unset the standup id so the
# script must discover it.
NOCLI_BIN="$TMPDIR_FIXTURE/noclibin"
mkdir -p "$NOCLI_BIN"
for tool in bash date grep head; do
  ln -sf "$(command -v "$tool")" "$NOCLI_BIN/$tool"
done
rc=0
out="$(env -u MISSION_CONTROL_STANDUP_CRON_ID PATH="$NOCLI_BIN" bash "$SCRIPT" --dry-run 2>&1)" || rc=$?
[ "$rc" -eq 2 ] || fail "edge: undiscoverable standup cron id must exit 2 (fail closed), got $rc: $out"
pass "edge: no standup cron id + no openclaw CLI -> fail closed (exit 2)"

# ─── --apply runs the two edits through the (stub) CLI ───────────────────────
: > "$OPENCLAW_STUB_LOG"
"$SCRIPT" --apply >/dev/null 2>&1 || fail "--apply must succeed against the stub CLI"
[ "$(grep -c 'cron edit' "$OPENCLAW_STUB_LOG")" -eq 2 ] \
  || fail "--apply must run exactly 2 'cron edit' calls, got: $(cat "$OPENCLAW_STUB_LOG")"
pass "--apply runs the two 'cron edit' calls through the CLI"

echo ""
echo "All U012 tests passed."
