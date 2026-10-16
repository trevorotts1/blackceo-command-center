#!/usr/bin/env bash
# cc-start-launcher-matrix.fixture.sh — real-launcher acceptance matrix.
#
# Runs the real scripts/cc-start.sh against seven isolated build states. Every
# case uses a throwaway app directory, a fake Node/next wrapper, stubbed port
# probes, and a controlled PATH. No production tree, PM2 daemon, port, or network
# is touched.
#
# Cases:
#   1 valid-manifest
#   2 missing-manifest
#   3 corrupt-manifest
#   4 mismatched-manifest-content
#   5 verifier-unavailable-fail-closed
#   6 legitimate-rollback-receipt
#   7 stale-rollback-receipt
#
# A successful launch means cc-start reached its final exec and the stubbed next
# wrapper wrote the marker file. Refusals mean exit 78, no marker, and a durable
# cc-start refusal receipt.
#
# This adapter is intentionally a fixture, not a standalone test. The maintained
# test wrapper is tests/unit/cc-start-launcher-matrix.test.ts.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CC_START="${CC_LAUNCHER_MATRIX_SCRIPT:-$REPO_ROOT/scripts/cc-start.sh}"
INV_LIB="$REPO_ROOT/scripts/lib/build-inventory.sh"

if [[ ! -f "$CC_START" || ! -f "$INV_LIB" ]]; then
  printf '[launcher-matrix] FATAL: required launcher or inventory library is missing\n' >&2
  exit 1
fi

REAL_NODE="$(command -v node)"
if [[ -z "$REAL_NODE" ]]; then
  printf '[launcher-matrix] FATAL: node is required to build and verify fixture manifests\n' >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cc-start-launcher-matrix.XXXXXX")"

# Durable evidence directory. Receipts survive cleanup so the operator can audit
# every case after the throwaway app trees and markers are gone. Override with
# CC_LAUNCHER_MATRIX_RECEIPT_DIR to write to a specific evidence location.
RECEIPTS_DIR="${CC_LAUNCHER_MATRIX_RECEIPT_DIR:-${TMPDIR:-/tmp}/cc-start-launcher-matrix-receipts/run-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
if ! mkdir -p "$RECEIPTS_DIR" 2>/dev/null; then
  printf '[launcher-matrix] FATAL: cannot create durable evidence directory: %s\n' "$RECEIPTS_DIR" >&2
  exit 1
fi
if [[ ! -w "$RECEIPTS_DIR" ]]; then
  printf '[launcher-matrix] FATAL: durable evidence directory is not writable: %s\n' "$RECEIPTS_DIR" >&2
  exit 1
fi

cleanup() {
  "$REAL_NODE" -e 'const fs=require("node:fs"); fs.rmSync(process.argv[1],{recursive:true,force:true});' "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/bin" "$WORK/bin-verifier-failure" "$WORK/markers" "$WORK/apps"

# Fake Node/next wrapper. -e delegates to real Node for the launcher's durable
# receipt writer; the final server exec writes a marker instead of starting.
cat > "$WORK/node-wrapper" <<EOF
#!/usr/bin/env bash
case "\${1:-}" in
  --version)
    printf 'v26.8.1\n'
    exit 0
    ;;
  -p)
    if [[ "\${2:-}" == "process.versions.modules" ]]; then
      printf '127\n'
    else
      printf '\n'
    fi
    exit 0
    ;;
  -e)
    exec "$REAL_NODE" "\$@"
    ;;
  *)
    printf '%s\n' "\$*" > "\${NODE_MARKER_FILE:-/dev/null}"
    exit 0
    ;;
esac
EOF
chmod +x "$WORK/node-wrapper"

# Stub all port probes so free_port never contacts a real host process.
for command_name in lsof fuser python3; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/$command_name"
  chmod +x "$WORK/bin/$command_name"
done

# Verifier-failure case: make both supported hash commands fail.
for command_name in sha256sum shasum; do
  printf '#!/usr/bin/env bash\nexit 1\n' > "$WORK/bin-verifier-failure/$command_name"
  chmod +x "$WORK/bin-verifier-failure/$command_name"
done

PASS=0
FAIL=0
FAILURES=()

pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); FAILURES+=("$1"); printf '  FAIL: %s\n' "$1"; }

# make_app <name>
make_app() {
  local app="$WORK/apps/$1"
  mkdir -p "$app/scripts/lib" "$app/src" "$app/public" "$app/.next" "$app/.cc-state"
  cp "$CC_START" "$app/scripts/cc-start.sh"
  cp "$REPO_ROOT/scripts/lib/rescue-credentials.sh" "$app/scripts/lib/rescue-credentials.sh"
  cp "$INV_LIB" "$app/scripts/lib/build-inventory.sh"
  printf '// launcher-matrix fixture\n' > "$app/scripts/next-service-env.cjs"
  printf '{"name":"launcher-matrix","version":"1.0.0","private":true}\n' > "$app/package.json"
  printf '{"name":"launcher-matrix","version":"1.0.0","lockfileVersion":3}\n' > "$app/package-lock.json"
  printf 'export const launcherMatrix = 1;\n' > "$app/src/a.ts"
  printf 'fixture-launcher-matrix\n' > "$app/public/.keep"
  printf 'fixture-build-id\n' > "$app/.next/BUILD_ID"
  printf '%s' "$app"
}

# seal_app <app-dir>
seal_app() {
  local app="$1"
  CC_NODE_BIN="$WORK/node-wrapper" bash "$app/scripts/lib/build-inventory.sh" \
    --manifest "$app" "$app/.next" "fixture-build-id" "$(date +%s)" >/dev/null
}

manifest_inventory_digest() {
  "$REAL_NODE" -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(manifest.inventory_digest));
  ' "$1/.next/build-inventory.json"
}

source_inventory_digest() {
  CC_NODE_BIN="$WORK/node-wrapper" bash "$1/scripts/lib/build-inventory.sh" --digest "$1"
}

write_rollback_receipt() {
  local app="$1" prior="$2" target="$3" target_bid="$4"
  "$REAL_NODE" -e '
    const fs = require("node:fs");
    const [out, prior, target, targetBid] = process.argv.slice(1);
    fs.writeFileSync(out, JSON.stringify({
      receipt_version: "1",
      type: "deploy-rollback",
      rolled_back_to_inventory_digest: prior,
      rolled_back_to_build_id: "fixture-build-id",
      failed_target_inventory_digest: target,
      failed_target_build_id: targetBid,
      reason: "launcher-matrix fixture rollback",
      pending_repair: "true",
      timestamp: new Date().toISOString(),
      recovery: "Rebuild and deploy with scripts/atomic-deploy.sh."
    }, null, 2) + "\n");
  ' "$app/.deploy-rollback-state.json" "$prior" "$target" "$target_bid"
}

record_case() {
  local case_name="$1" exit_code="$2" launched="$3" receipt_path="$4"
  local receipt_file="$RECEIPTS_DIR/$case_name.json"
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! "$REAL_NODE" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [out, caseName, exitCode, launched, receiptPath, timestamp] = process.argv.slice(1);
    let refusalReceipt = null;
    let refusalReceiptFile = null;
    if (receiptPath !== "null") {
      if (!fs.existsSync(receiptPath)) {
        process.stderr.write(`[launcher-matrix] FATAL: refusal receipt missing before durable copy: ${receiptPath}\n`);
        process.exit(1);
      }
      refusalReceiptFile = path.join(path.dirname(out), `${caseName}.refusal.json`);
      fs.copyFileSync(receiptPath, refusalReceiptFile);
      refusalReceipt = JSON.parse(fs.readFileSync(refusalReceiptFile, "utf8"));
    }
    fs.writeFileSync(out, JSON.stringify({
      schema: "cc-start-launcher-matrix/2",
      case: caseName,
      exit_code: Number(exitCode),
      launched: launched === "true",
      receipt_path: receiptPath === "null" ? null : receiptPath,
      receipt_exists: receiptPath !== "null" && fs.existsSync(receiptPath),
      refusal_receipt_file: refusalReceiptFile,
      refusal_receipt: refusalReceipt,
      timestamp
    }, null, 2) + "\n");
  ' "$receipt_file" "$case_name" "$exit_code" "$launched" "$receipt_path" "$timestamp"; then
    printf '[launcher-matrix] FATAL: failed to persist durable case evidence: %s\n' "$receipt_file" >&2
    exit 1
  fi
  if [[ ! -f "$receipt_file" ]]; then
    printf '[launcher-matrix] FATAL: failed to write durable receipt: %s\n' "$receipt_file" >&2
    exit 1
  fi
  printf '  receipt: %s\n' "$receipt_file"
}

# run_case <case> <app-dir> <expected-exit> <expect-launch> [extra-bin-dir]
run_case() {
  local case_name="$1" app="$2" expected_exit="$3" expected_launch="$4" extra_bin="${5:-}"
  local marker="$WORK/markers/$case_name.marker"
  local receipt_path="$app/.cc-state/cc-start-refused.json"
  local path="$WORK/bin:/usr/bin:/bin"
  if [[ -n "$extra_bin" ]]; then
    path="$extra_bin:$path"
  fi

  (
    cd "$app" || exit 99
    export PATH="$path"
    export CC_NODE_BIN="$WORK/node-wrapper"
    export CC_PORT=43210
    export CC_PORT_OVERRIDE_ACK=1
    export NODE_ENV=production
    export NODE_MARKER_FILE="$marker"
    export RESCUE_RANGERS_WEBHOOK_SECRET='launcher-matrix-fixture-secret'
    bash "$app/scripts/cc-start.sh"
  )
  local exit_code=$?
  local launched=false
  if [[ -f "$marker" ]]; then launched=true; fi

  if [[ "$exit_code" -ne "$expected_exit" ]]; then
    fail "$case_name: expected exit $expected_exit, got $exit_code"
  else
    pass "$case_name: exit code $exit_code"
  fi

  if [[ "$expected_launch" == "true" ]]; then
    if [[ "$launched" == "true" ]]; then
      pass "$case_name: stubbed next reached final exec and wrote marker"
    else
      fail "$case_name: expected launch marker, but none was written"
    fi
  else
    if [[ "$launched" == "false" ]]; then
      pass "$case_name: server was not launched"
    else
      fail "$case_name: server unexpectedly launched"
    fi
  fi

  if [[ "$expected_exit" -eq 78 ]]; then
    if [[ -f "$receipt_path" ]]; then
      pass "$case_name: durable refusal receipt exists at $receipt_path"
    else
      fail "$case_name: durable refusal receipt is missing"
    fi
    record_case "$case_name" "$exit_code" "$launched" "$receipt_path"
  else
    if [[ -f "$receipt_path" ]]; then
      fail "$case_name: unexpected refusal receipt exists at $receipt_path"
    else
      pass "$case_name: no refusal receipt"
    fi
    record_case "$case_name" "$exit_code" "$launched" "null"
  fi
}

printf '[launcher-matrix] syntax check\n'
if bash -n "$CC_START"; then
  pass 'launcher syntax check: bash -n scripts/cc-start.sh'
else
  fail 'launcher syntax check: bash -n scripts/cc-start.sh'
fi

printf '[launcher-matrix] case 1: valid manifest\n'
APP1="$(make_app valid-manifest)"
seal_app "$APP1"
run_case valid-manifest "$APP1" 0 true

printf '[launcher-matrix] case 2: missing manifest\n'
APP2="$(make_app missing-manifest)"
run_case missing-manifest "$APP2" 78 false

printf '[launcher-matrix] case 3: corrupt manifest\n'
APP3="$(make_app corrupt-manifest)"
seal_app "$APP3"
chmod 644 "$APP3/.next/build-inventory.json"
printf '{"manifest_version":"1","built_at":"2026-09-18T12:00:00Z"\n' > "$APP3/.next/build-inventory.json"
chmod 444 "$APP3/.next/build-inventory.json"
run_case corrupt-manifest "$APP3" 78 false

printf '[launcher-matrix] case 4: mismatched manifest/content\n'
APP4="$(make_app mismatched-manifest-content)"
seal_app "$APP4"
printf 'export const launcherMatrix = 2;\n' > "$APP4/src/a.ts"
run_case mismatched-manifest-content "$APP4" 78 false

printf '[launcher-matrix] case 5: failed verifier execution\n'
APP5="$(make_app verifier-unavailable-fail-closed)"
seal_app "$APP5"
run_case verifier-unavailable-fail-closed "$APP5" 78 false "$WORK/bin-verifier-failure"

printf '[launcher-matrix] case 6: legitimate rollback receipt\n'
APP6="$(make_app legitimate-rollback-receipt)"
seal_app "$APP6"
PRIOR_INV="$(manifest_inventory_digest "$APP6")"
printf 'export const launcherMatrix = 3;\n' > "$APP6/src/a.ts"
TARGET_INV="$(source_inventory_digest "$APP6")"
write_rollback_receipt "$APP6" "$PRIOR_INV" "$TARGET_INV" "fixture-build-id"
run_case legitimate-rollback-receipt "$APP6" 0 true

printf '[launcher-matrix] case 7: stale rollback receipt\n'
APP7="$(make_app stale-rollback-receipt)"
seal_app "$APP7"
printf 'export const launcherMatrix = 4;\n' > "$APP7/src/a.ts"
TARGET_INV="$(source_inventory_digest "$APP7")"
write_rollback_receipt "$APP7" "0000000000000000000000000000000000000000000000000000000000000000" "$TARGET_INV" "fixture-build-id"
run_case stale-rollback-receipt "$APP7" 78 false

printf '[launcher-matrix] writing summary\n'
"$REAL_NODE" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = process.argv[1];
  const names = [
    "valid-manifest",
    "missing-manifest",
    "corrupt-manifest",
    "mismatched-manifest-content",
    "verifier-unavailable-fail-closed",
    "legitimate-rollback-receipt",
    "stale-rollback-receipt"
  ];
  const rows = names.map((name) => JSON.parse(fs.readFileSync(path.join(dir, name + ".json"), "utf8")));
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({
    schema: "cc-start-launcher-matrix-summary/1",
    launcher_syntax_verified: true,
    cases: rows,
    timestamp: new Date().toISOString()
  }, null, 2) + "\n");
' "$RECEIPTS_DIR"
if [[ ! -f "$RECEIPTS_DIR/summary.json" ]]; then
  printf '[launcher-matrix] FATAL: failed to write durable summary receipt: %s\n' "$RECEIPTS_DIR/summary.json" >&2
  exit 1
fi
printf '  summary receipt: %s\n' "$RECEIPTS_DIR/summary.json"
printf '[launcher-matrix] durable evidence directory: %s\n' "$RECEIPTS_DIR"

printf '[launcher-matrix] %d passed, %d failed\n' "$PASS" "$FAIL"
if (( FAIL > 0 )); then
  printf '[launcher-matrix] FAILURES PRESENT\n'
  for failure in "${FAILURES[@]}"; do
    printf '  - %s\n' "$failure"
  done
  exit 1
fi
printf '[launcher-matrix] ALL PASS\n'
