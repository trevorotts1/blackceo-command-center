#!/usr/bin/env bash
# verify-ghl-hybrid.sh — the ONE focused WF22 verification entrypoint (Command Center).
#
# Scope (Document 1 sections 17.4 and 33, Document 2 WF22):
#   * command-center side of the shared fake scenarios (receipt-backed card
#     truth, stale/unknown visibility, old+new producer mix, one-way
#     CC -> Projects projection, board-outage outbox);
#   * cross-repository contract parity (hash-checked local copy).
#
# Offline by default: no network, no DB, no owner notification, no GoHighLevel
# write. The repo's own suite-wide mutes are imported first; the test files
# import only dependency-free modules. There is deliberately no live-canary
# flag: no safe hybrid canary authorization exists here.
#
# USAGE
#   scripts/verify-ghl-hybrid.sh [--quiet]
#
# EXIT
#   0 = selected tests passed and the contract fixture manifest matches
#   1 = a selected test failed, zero tests were collected, or the manifest stale
#   2 = the supported environment is missing (setup instruction printed)

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 2

QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet|-q) QUIET=1 ;;
    -h|--help) sed -n '2,36p' "$0"; exit 0 ;;
    *) printf 'verify-ghl-hybrid.sh: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
stop() { printf 'CANNOT RUN  %s\n' "$*" >&2; exit 2; }

command -v node >/dev/null 2>&1 || stop "Node.js is required (^20.19.0, ^22.13.0, or >=24). Install Node 24 LTS."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
case "$NODE_MAJOR" in
  20|22|24|25|26) ;;
  *) stop "Node $NODE_MAJOR is outside the supported engines (^20.19.0 || ^22.13.0 || >=24). Use Node 24 LTS." ;;
esac

[ -f "node_modules/tsx/package.json" ] || stop \
  "dev dependencies are missing (tsx not installed). Run: npm ci"

FIXTURES="tests/fixtures/ghl-hybrid"
TESTS=(
  "tests/unit/wf22-ghl-hybrid-e2e.test.ts"
  "tests/unit/wf22-ghl-hybrid-contract-parity.test.ts"
)
for path in "${TESTS[@]}" "$FIXTURES/contracts/contract-manifest.json"; do
  [ -e "$path" ] || stop "required path is missing: $path"
done

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cc-wf22-verify.XXXXXX")" || stop "cannot create a temp directory"
trap 'rm -rf "$WORK_DIR"' EXIT

say "=== verify-ghl-hybrid (blackceo-command-center) ==="

# 1. Contract fixture manifest must match the copied schema files.
node - "$FIXTURES/contracts" <<'JS' || fail "contract fixture manifest is stale (regenerate contract-manifest.json)"
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dir = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'contract-manifest.json'), 'utf8'));
const actual = {};
for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.schema.json')).sort()) {
  actual[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
}
const declared = manifest.files || {};
const names = new Set([...Object.keys(actual), ...Object.keys(declared)]);
for (const name of names) {
  if (actual[name] !== declared[name]) {
    console.error(`manifest/file hash mismatch: ${name}`);
    process.exit(1);
  }
}
console.log(`PASS  contract fixture manifest (${Object.keys(actual).length} schemas)`);
JS

# 2. Zero collected tests is a failure, never a pass.
TEST_LOG="$WORK_DIR/tests.log"
env -i PATH="$PATH" HOME="$WORK_DIR" TMPDIR="$WORK_DIR" \
  node --import tsx \
    --import ./tests/setup/no-owner-telegram.ts \
    --import ./tests/setup/tmp-sandbox.ts \
    --test "${TESTS[@]}" >"$TEST_LOG" 2>&1
TEST_RC=$?
cat "$TEST_LOG"
[ "$TEST_RC" -eq 0 ] || fail "selected tests failed (exit $TEST_RC)"

PASS_COUNT="$(node -e '
const fs = require("fs");
const text = fs.readFileSync(process.argv[1], "utf8");
const m = text.match(/(?:^|\n)\s*(?:ℹ|#)\s*pass\s+(\d+)/);
process.stdout.write(m ? m[1] : "0");
' "$TEST_LOG")"
TOTAL_COUNT="$(node -e '
const fs = require("fs");
const text = fs.readFileSync(process.argv[1], "utf8");
const m = text.match(/(?:^|\n)\s*(?:ℹ|#)\s*tests\s+(\d+)/);
process.stdout.write(m ? m[1] : "0");
' "$TEST_LOG")"
[ "$TOTAL_COUNT" -gt 0 ] || fail "the requested selection collected zero tests"
[ "$PASS_COUNT" -gt 0 ] || fail "the requested selection reported zero passing tests"

COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
DIRTY=""
git -C "$REPO_ROOT" diff --quiet 2>/dev/null || DIRTY=" (dirty worktree)"
say "command: node --import tsx ... --test ${TESTS[*]}"
say "result: PASS (${TOTAL_COUNT} tests, ${PASS_COUNT} passed, exit 0)"
say "commit: ${COMMIT}${DIRTY}"
