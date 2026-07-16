#!/usr/bin/env bash
# regen-vertical-derivation-golden.sh — refresh the pinned golden for the
# checkAddDepartmentSync()-vs-Python parity harness (U107 / E5-2, closes G2a)
# when department-naming-map.json or vertical-derivation-guard.py change.
#
# Mirrors scripts/regen-seam-parity-golden.sh's sandbox convention. The
# --check-add code path this generator drives is read-only (load_naming_map()
# + check_add() touch no HOME state), but a throwaway HOME is exported anyway
# for consistency with this repo's other Python-parity generator and as a
# forward guard if vertical-derivation-guard.py's code path here ever grows a
# write.
#
# Usage:
#   scripts/regen-vertical-derivation-golden.sh <path-to-openclaw-onboarding-repo>
#
# If the repo path is omitted it clones a fresh read-only copy to a temp dir.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/src/lib/routing/__fixtures__/vertical-derivation"
INPUT_JSON="$FIXTURE_DIR/input.json"
GOLDEN_JSON="$FIXTURE_DIR/golden.json"
GENERATOR="$REPO_ROOT/scripts/vertical-derivation-golden.py"

# ── MANDATORY SANDBOX ────────────────────────────────────────────────────────
SANDBOX_HOME="$(mktemp -d)"
export HOME="$SANDBOX_HOME"
echo "[sandbox] HOME=$HOME"
case "$HOME" in
  /var/folders/*|/tmp/*|/private/tmp/*) : ;;
  *) echo "FATAL: sandbox HOME ($HOME) is not a temp dir — refusing to run." >&2; exit 2 ;;
esac
trap 'rm -rf "$SANDBOX_HOME"' EXIT

# ── resolve the onboarding scripts dir ───────────────────────────────────────
OB_REPO="${1:-}"
CLONE_TMP=""
if [ -z "$OB_REPO" ]; then
  CLONE_TMP="$(mktemp -d)"
  echo "[clone] no repo path given — cloning openclaw-onboarding (read-only) to $CLONE_TMP"
  git clone --depth 1 https://github.com/trevorotts1/openclaw-onboarding "$CLONE_TMP" >/dev/null 2>&1
  OB_REPO="$CLONE_TMP"
  trap 'rm -rf "$SANDBOX_HOME" "$CLONE_TMP"' EXIT
fi
SCRIPTS_DIR="$OB_REPO/23-ai-workforce-blueprint/scripts"
if [ ! -d "$SCRIPTS_DIR" ]; then
  echo "FATAL: $SCRIPTS_DIR not found (is $OB_REPO the onboarding repo?)" >&2; exit 2
fi

echo "[run] python3 vertical-derivation-golden.py $SCRIPTS_DIR ..."
python3 "$GENERATOR" "$SCRIPTS_DIR" "$INPUT_JSON" "$GOLDEN_JSON"
echo "[done] golden refreshed at $GOLDEN_JSON"
echo "       review 'git diff' before committing; run 'npm run test:unit' to confirm parity."
