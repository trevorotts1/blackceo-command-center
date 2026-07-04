#!/usr/bin/env bash
# regen-seam-parity-golden.sh — refresh the pinned golden for the seam-vs-Python
# parity harness (Wave 5 / P3-7) when the onboarding enforcers change.
#
# WHY A WRAPPER: the Skill-23 / build-workforce / department-floor Python resolve
# their state as /data-else-$HOME and IGNORE any workspace override. Running them
# with the operator's real HOME can touch ~/.openclaw / ~/.clawdbot / ~/clawd.
# This wrapper ALWAYS exports a throwaway HOME first, confirms the resolved root is
# inside that temp dir, and never lets the golden generator see a real workspace.
#
# Usage:
#   scripts/regen-seam-parity-golden.sh <path-to-openclaw-onboarding-repo>
#
# If the repo path is omitted it clones a fresh read-only copy to a temp dir.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/src/lib/interview/__fixtures__/parity"
INPUT_JSON="$FIXTURE_DIR/input.json"
GOLDEN_JSON="$FIXTURE_DIR/golden.json"
GENERATOR="$REPO_ROOT/scripts/seam-parity-golden.py"

# ── MANDATORY SANDBOX ────────────────────────────────────────────────────────
SANDBOX_HOME="$(mktemp -d)"
export HOME="$SANDBOX_HOME"
export OPENCLAW_PLATFORM="${OPENCLAW_PLATFORM:-mac}"
echo "[sandbox] HOME=$HOME"
case "$HOME" in
  /var/folders/*|/tmp/*|/private/tmp/*) : ;;
  *) echo "FATAL: sandbox HOME ($HOME) is not a temp dir — refusing to run." >&2; exit 2 ;;
esac
for danger in .openclaw .clawdbot clawd; do
  if [ -e "$HOME/$danger" ]; then
    echo "FATAL: sandbox HOME already contains $danger — refusing." >&2; exit 2
  fi
done
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

echo "[run] python3 seam-parity-golden.py $SCRIPTS_DIR ..."
python3 "$GENERATOR" "$SCRIPTS_DIR" "$INPUT_JSON" "$GOLDEN_JSON"
echo "[done] golden refreshed at $GOLDEN_JSON"
echo "       review 'git diff' before committing; run 'npm run test:vitest' to confirm parity."
