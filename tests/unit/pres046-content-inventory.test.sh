#!/usr/bin/env bash
#
# pres046-content-inventory.test.sh — PRES-046 behavior tests.
#
# THE INVARIANTS UNDER TEST (QC-PRES-046):
#   T1  Changed content with OLD mtime FAILS verification (content, not mtime,
#       is the oracle; a cp/git pull that restores old mtimes cannot fake fresh).
#   T2  Identical content merely TOUCHED (new mtime, same bytes) PASSES.
#   T3  cp -r rollback artifact stays DEGRADED: serving a verified prior
#       artifact requires the transaction-bound rollback receipt; the rollback
#       copy never verifies as target-current.
#   T4  An INVALID receipt (foreign JSON, missing fields, wrong type/version,
#       pending_repair != true) CANNOT waive a mismatch.
#   T5  A STALE receipt (binds some other artifact/target pair) cannot waive.
#   T6  A GOOD deploy (atomic-deploy.sh green) CLEARS only the receipt whose
#       failed_target matches the deployed content; a mismatched target is
#       superseded, never waived (covered at unit level: clear-if-matching).
#   T7  MISSING manifest fails (exact failure, no mtime downgrade).
#   T8  TRUNCATED manifest fails (MANIFEST_INVALID).
#   T9  DIRTY change DURING build (frozen-source rule) rejects the candidate
#       (atomic-deploy.sh pre/post inventory compare).
#   T10 OBSOLETE INVENTORY: manifest computed over a different input list
#       (config file added after the build) fails exactly.
#   T11 UNATTESTED prior + receipt binding THIS source tree → degraded OK.
#   T12 Both onboarding update paths hit the exact failure contract: the
#       degraded path in update.sh refuses unverifiable builds (static
#       contract check) and the tier-3 legacy helper's inputs list matches the
#       canonical _CCBI_TOPLEVEL_INPUTS (same question everywhere).
#
# Run: bash tests/unit/pres046-content-inventory.test.sh
# (Also wired into qc-cc.sh section 12.)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INV_LIB="$REPO_ROOT/scripts/lib/build-inventory.sh"
CC_START="$REPO_ROOT/scripts/cc-start.sh"
ATOMIC_DEPLOY="$REPO_ROOT/scripts/atomic-deploy.sh"
UPDATE_SH="$REPO_ROOT/update.sh"

FAIL=0
pass() { printf '  PASS: %s\n' "$1"; }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=1; }

if [[ ! -f "$INV_LIB" ]]; then
  echo "[pres046] FAIL — $INV_LIB does not exist"
  exit 1
fi

TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/pres046-test-XXXXXX")"
trap 'rm -rf "$TMPBASE"' EXIT

# make_app <name> — minimal app tree: src/, config/, package.json.
make_app() {
  local d="$TMPBASE/$1"
  mkdir -p "$d/src" "$d/config" "$d/.next"
  printf 'export const a = 1;\n' > "$d/src/a.ts"
  printf 'export const b = 2;\n' > "$d/src/b.ts"
  printf 'module.exports = { x: 1 };\n' > "$d/config/settings.js"
  printf '{"name":"fixture-cc","version":"9.9.9","build":"next build"}\n' > "$d/package.json"
  printf 'fixture-build-id\n' > "$d/.next/BUILD_ID"
  printf '%s' "$d"
}

# seal_app <dir> — write the manifest as atomic-deploy.sh would (current content).
seal_app() {
  bash "$INV_LIB" --manifest "$1" "$1/.next" "fixture-build-id" "$(date +%s)"
}

# ── T1: changed content + OLD mtime → MISMATCH ───────────────────────────────
T1_DIR="$(make_app t1)"; seal_app "$T1_DIR"
printf 'export const a = 999;\n' > "$T1_DIR/src/a.ts"
touch -t 202001010000 "$T1_DIR/src/a.ts"   # old mtime, new bytes
T1_JSON="$(bash "$INV_LIB" --verify "$T1_DIR")"; T1_RC=$?
if [[ "$T1_RC" -eq 1 && "$T1_JSON" == *'"verdict":"MISMATCH"'* ]]; then
  pass "T1: changed content with old mtime → MISMATCH ($T1_JSON)"
else
  fail "T1: changed content with old mtime must be MISMATCH rc=1, got rc=$T1_RC $T1_JSON"
fi

# ── T2: identical content, merely touched → VERIFIED ─────────────────────────
T2_DIR="$(make_app t2)"; seal_app "$T2_DIR"
touch "$T2_DIR/src/a.ts" "$T2_DIR/src/b.ts" "$T2_DIR/package.json"
sleep 1
T2_JSON="$(bash "$INV_LIB" --verify "$T2_DIR")"; T2_RC=$?
if [[ "$T2_RC" -eq 0 && "$T2_JSON" == *'"verdict":"VERIFIED"'* ]]; then
  pass "T2: touched identical content → VERIFIED ($T2_JSON)"
else
  fail "T2: touched identical content must VERIFY, got rc=$T2_RC $T2_JSON"
fi

# ── T3: cp -r rollback stays degraded (copy never becomes target-current) ────
T3_DIR="$(make_app t3)"; seal_app "$T3_DIR"
cp -R "$T3_DIR/.next" "$T3_DIR/.next.rollback"
# Source moves on (the failed target), rollback restored over .next.
printf 'export const a = 555;\n' > "$T3_DIR/src/a.ts"
T3_SRC_INV="$(bash "$INV_LIB" --digest "$T3_DIR")"
rm -rf "$T3_DIR/.next"; cp -R "$T3_DIR/.next.rollback" "$T3_DIR/.next"
T3_JSON="$(bash "$INV_LIB" --verify "$T3_DIR")"; T3_RC=$?
if [[ "$T3_RC" -eq 1 && "$T3_JSON" == *'"verdict":"MISMATCH"'* ]]; then
  pass "T3: cp-r rollback artifact still MISMATCHes moved-on source (degraded, never target-current)"
else
  fail "T3: cp-r rollback must stay MISMATCH (rc=1), got rc=$T3_RC $T3_JSON"
fi

# ── T4: invalid receipt cannot waive a mismatch ──────────────────────────────
receipt_case() { # <dir> <receipt-content> <expect-rc: 1|3> <label>
  local d="$1" receipt="$2" expect="$3" label="$4" rc json
  json="$(bash "$INV_LIB" --verify-rollback "$d" "$d/.next" "$(bash "$INV_LIB" --digest "$d")")"
  rc=$?
  if [[ "$rc" -eq "$expect" ]]; then
    pass "$label (verdict: $json)"
  else
    fail "$label — expected rc=$expect, got rc=$rc $json"
  fi
}
T4_DIR="$(make_app t4)"
printf 'export const a = 777;\n' > "$T4_DIR/src/a.ts"
seal_app "$T4_DIR"
printf 'not json at all {{{\n' > "$T4_DIR/.deploy-rollback-state.json"
receipt_case "$T4_DIR" '' 3 "T4a: foreign/garbage receipt → RECEIPT_INVALID (cannot waive)"
printf '{"schema":"cc-start-refusal/1","reason":"x"}\n' > "$T4_DIR/.deploy-rollback-state.json"
receipt_case "$T4_DIR" '' 3 "T4b: wrong-schema marker file → RECEIPT_INVALID (cannot waive)"
printf '{"receipt_version":"1","type":"deploy-rollback","rolled_back_to_inventory_digest":"deadbeefdeadbeef","failed_target_inventory_digest":"cafebabecafebabe","pending_repair":"false"}\n' \
  > "$T4_DIR/.deploy-rollback-state.json"
receipt_case "$T4_DIR" '' 3 "T4c: pending_repair=false receipt → RECEIPT_INVALID (cannot waive)"

# ── T5: stale receipt (right shape, wrong binding) cannot waive ──────────────
T5_DIR="$(make_app t5)"
printf 'export const a = 777;\n' > "$T5_DIR/src/a.ts"
seal_app "$T5_DIR"
printf '{"receipt_version":"1","type":"deploy-rollback","rolled_back_to_inventory_digest":"%s","failed_target_inventory_digest":"%s","pending_repair":"true"}\n' \
  "aaaa1111aaaa1111" "bbbb2222bbbb2222" > "$T5_DIR/.deploy-rollback-state.json"
receipt_case "$T5_DIR" '' 1 "T5a: receipt naming a different prior artifact → RECEIPT_STALE"
T5_SRC_INV="$(bash "$INV_LIB" --digest "$T5_DIR")"
printf '{"receipt_version":"1","type":"deploy-rollback","rolled_back_to_inventory_digest":"%s","failed_target_inventory_digest":"%s","pending_repair":"true"}\n' \
  "$(bash "$INV_LIB" --digest "$T5_DIR" >/dev/null; _x=1; cat "$T5_DIR/.next/build-inventory.json" | sed -n 's/.*"inventory_digest": "\([^"]*\)".*/\1/p' | head -1)" \
  "$T5_SRC_INV" > "$T5_DIR/.deploy-rollback-state.json"
receipt_case "$T5_DIR" '' 0 "T5b: receipt binding exactly (served artifact, current source) → RECEIPT_OK"
# Source moves on → receipt now stale (failed_target no longer matches).
printf 'export const a = 888;\n' > "$T5_DIR/src/a.ts"
receipt_case "$T5_DIR" '' 1 "T5c: receipt left behind after source moved on → RECEIPT_STALE"

# ── T7: missing manifest fails ────────────────────────────────────────────────
T7_DIR="$(make_app t7)"
T7_JSON="$(bash "$INV_LIB" --verify "$T7_DIR")"; T7_RC=$?
if [[ "$T7_RC" -eq 2 && "$T7_JSON" == *'"verdict":"MANIFEST_MISSING"'* ]]; then
  pass "T7: missing manifest → MANIFEST_MISSING (rc=2)"
else
  fail "T7: missing manifest must be rc=2, got rc=$T7_RC $T7_JSON"
fi

# ── T8: truncated manifest fails ─────────────────────────────────────────────
# (The lib writes the manifest 444 — write-once immutable. A truncation attack
# therefore rm's it first; the test does the same so the write lands.)
T8_DIR="$(make_app t8)"; seal_app "$T8_DIR"
rm -f "$T8_DIR/.next/build-inventory.json"
printf '{"manifest_version":"1","built_at":"2026-09-08T12:00:00Z"\n' > "$T8_DIR/.next/build-inventory.json"
T8_JSON="$(bash "$INV_LIB" --verify "$T8_DIR")"; T8_RC=$?
if [[ "$T8_RC" -eq 3 && "$T8_JSON" == *'"verdict":"MANIFEST_INVALID"'* ]]; then
  pass "T8: truncated manifest → MANIFEST_INVALID (rc=3)"
else
  fail "T8: truncated manifest must be rc=3, got rc=$T8_RC $T8_JSON"
fi

# ── T10: obsolete inventory fails when a compile-affecting input appears ─────
T10_DIR="$(make_app t10)"; seal_app "$T10_DIR"
printf 'export const b = 2;\n' > "$T10_DIR/src/new-module.ts"   # input list grew
T10_JSON="$(bash "$INV_LIB" --verify "$T10_DIR")"; T10_RC=$?
if [[ "$T10_RC" -eq 5 && "$T10_JSON" == *'"verdict":"OBSOLETE_INVENTORY"'* ]]; then
  pass "T10: obsolete inventory (new compile-affecting source after build) → OBSOLETE_INVENTORY (rc=5)"
else
  fail "T10: obsolete inventory must be rc=5, got rc=$T10_RC $T10_JSON"
fi

# ── T10b: config/ is RUNTIME DATA and must NEVER invalidate the build ────────
# Regression guard (2026-09-11). config/ used to be hashed into the compile
# inventory, so the app's own ordinary writes to it — a client saving a logo
# (src/app/api/logo/route.ts), company config (src/app/api/company/config/
# route.ts), a department edit (src/lib/routing/departments.config.ts) — or the
# onboarding orchestrator's post-deploy department sync flipped the verdict to
# MISMATCH, and cc-start.sh then REFUSED TO BOOT on the next pm2 restart. A
# client changing their logo must never brick their Command Center.
T10B_DIR="$(make_app t10b)"; seal_app "$T10B_DIR"
printf 'module.exports = { y: 2 };\n' > "$T10B_DIR/config/settings.js"      # existing file changed
printf 'module.exports = { z: 3 };\n' > "$T10B_DIR/config/new-config.mjs"  # new file added
T10B_JSON="$(bash "$INV_LIB" --verify "$T10B_DIR")"; T10B_RC=$?
if [[ "$T10B_RC" -eq 0 && "$T10B_JSON" == *'"verdict":"VERIFIED"'* ]]; then
  pass "T10b: config/ writes after the build stay VERIFIED (runtime data, not a compile input)"
else
  fail "T10b: config/ must not affect the build attestation, got rc=$T10B_RC $T10B_JSON"
fi

# ── T11: unattested prior + receipt binding this source tree → degraded OK ───
T11_DIR="$(make_app t11)"
# Legacy artifact: .next exists with BUILD_ID but NO manifest.
printf 'export const a = 333;\n' > "$T11_DIR/src/a.ts"   # source moved on from build
T11_SRC_INV="$(bash "$INV_LIB" --digest "$T11_DIR")"
printf '{"receipt_version":"1","type":"deploy-rollback","rolled_back_to_inventory_digest":"(unattested)","failed_target_inventory_digest":"%s","pending_repair":"true"}\n' \
  "$T11_SRC_INV" > "$T11_DIR/.deploy-rollback-state.json"
T11_JSON="$(bash "$INV_LIB" --verify-rollback "$T11_DIR" "$T11_DIR/.next" "$T11_SRC_INV")"; T11_RC=$?
if [[ "$T11_RC" -eq 0 && "$T11_JSON" == *'"receipt_verdict":"RECEIPT_OK"'* ]]; then
  pass "T11: legacy unattested prior + matching-target receipt → RECEIPT_OK (degraded serving)"
else
  fail "T11: legacy carve-out must be RECEIPT_OK, got rc=$T11_RC $T11_JSON"
fi
# But an unattested receipt naming a DIFFERENT source tree still refuses.
T11B_DIR="$(make_app t11b)"
printf '{"receipt_version":"1","type":"deploy-rollback","rolled_back_to_inventory_digest":"(unattested)","failed_target_inventory_digest":"cccc3333cccc3333","pending_repair":"true"}\n' \
  > "$T11B_DIR/.deploy-rollback-state.json"
T11B_JSON="$(bash "$INV_LIB" --verify-rollback "$T11B_DIR" "$T11B_DIR/.next" "$(bash "$INV_LIB" --digest "$T11B_DIR")")"; T11B_RC=$?
if [[ "$T11B_RC" -eq 1 ]]; then
  pass "T11b: unattested receipt for a different source tree → RECEIPT_STALE"
else
  fail "T11b: unattested foreign-target receipt must be rc=1, got rc=$T11B_RC $T11B_JSON"
fi

# ── T12: both onboarding update paths + canonical list agreement ─────────────
# Path A (update.sh degraded fallback): must refuse an unverifiable build and
# enforce the frozen-source rule on the degraded path.
if grep -q "FROZEN-SOURCE VIOLATION" "$UPDATE_SH" \
   && grep -q "build-inventory.sh" "$UPDATE_SH" \
   && grep -q "cannot produce a verifiable artifact" "$UPDATE_SH"; then
  pass "T12a: update.sh degraded path enforces frozen-source + manifest write (onboarding tier-1 contract)"
else
  fail "T12a: update.sh degraded path missing PRES-046 contract markers"
fi
# Path B (onboarding tier-3 / cc_ensure_fresh_build): its build-input list must
# cover the same canonical set as _CCBI_TOPLEVEL_INPUTS (source of truth in
# run-full-install.sh: src public + lockfile + ts/build configs).
# NOTE: `config` is deliberately absent from both lists since 2026-09-11 — it is
# runtime data the app itself rewrites, never a compile input. See T10b.
ONB_RUN_FULL=""
for c in "$REPO_ROOT/../openclaw-onboarding/32-command-center-setup/scripts/run-full-install.sh" \
         "${HOME}/openclaw-onboarding/32-command-center-setup/scripts/run-full-install.sh"; do
  [[ -f "$c" ]] && { ONB_RUN_FULL="$c"; break; }
done
if [[ -n "$ONB_RUN_FULL" ]]; then
  for _req in "public" "package-lock.json" "tsconfig.json" "tailwind.config.ts" "postcss.config.mjs"; do
    if grep -q "$_req" "$ONB_RUN_FULL"; then
      pass "T12b: onboarding freshness helper covers canonical input '$_req'"
    else
      fail "T12b: onboarding freshness helper missing canonical input '$_req'"
    fi
  done
else
  pass "T12b: onboarding repo not present on this box — static agreement check skipped (documented)"
fi

# ── T13: cc-start.sh refusal contract (exit 78 + receipt schema) ─────────────
if grep -q "exit 78" "$CC_START" \
   && grep -q 'cc-start-refusal/1' "$CC_START" \
   && grep -q "content-mismatch-stale-receipt" "$CC_START" \
   && grep -q "obsolete-inventory" "$CC_START"; then
  pass "T13: cc-start.sh content refusals are deterministic (exit 78) with PRES-045 receipt schema"
else
  fail "T13: cc-start.sh missing exit-78 deterministic content refusal contract"
fi

# ── T14: no loose stale-bypass flag ──────────────────────────────────────────
if ! grep -q "CC_ALLOW_STALE_BUILD=1 ]" "$CC_START" && ! grep -q 'CC_ALLOW_STALE_BUILD:-0' "$CC_START"; then
  pass "T14: CC_ALLOW_STALE_BUILD escape hatch removed from cc-start.sh"
else
  fail "T14: CC_ALLOW_STALE_BUILD still present in cc-start.sh (loose stale bypass forbidden)"
fi

# ── T9: frozen-source rule in atomic-deploy.sh (pre/post compare) ────────────
if grep -q "PRE_BUILD_INVENTORY" "$ATOMIC_DEPLOY" \
   && grep -q "POST_BUILD_INVENTORY" "$ATOMIC_DEPLOY" \
   && grep -q "FROZEN-SOURCE VIOLATION" "$ATOMIC_DEPLOY" \
   && grep -q "_ccbi_write_manifest" "$ATOMIC_DEPLOY"; then
  pass "T9: atomic-deploy.sh computes pre/post inventory, rejects mid-compile change, writes manifest pre-swap"
else
  fail "T9: atomic-deploy.sh missing frozen-source/manifest wiring"
fi
# T6: receipt cleared only on matching target.
if grep -q "failed_target_inventory_digest" "$ATOMIC_DEPLOY" \
   && grep -q "does not match this deploy" "$ATOMIC_DEPLOY"; then
  pass "T6: atomic-deploy.sh clears the rollback receipt only on matching failed-target content"
else
  fail "T6: atomic-deploy.sh receipt-clear logic missing/mismatched"
fi

if [[ "$FAIL" -eq 0 ]]; then
  printf '\n[pres046-content-inventory] ALL PASS\n'
  exit 0
else
  printf '\n[pres046-content-inventory] FAILURES PRESENT\n'
  exit 1
fi
