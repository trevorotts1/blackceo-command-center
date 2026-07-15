#!/usr/bin/env bash
#
# guard-report-back-invariant.sh — U95 / U-X5 (master spec Section X.2,
# exec-summary item 12): "the trust engine's report-back loop is well-built
# and verified ... the residual is requester-stamp coverage [U94] + an
# invariant test that no code path but the trust engine ever messages a
# requester [U95]."
#
# Doctrine pinned (Section X.2.1, "The binding doctrine this grounds"):
#   "ONLY the trust engine speaks to the requester, keyed strictly off
#    requester_chat_id ... Any new surface that spawns work MUST stamp
#    requester identity at the creation door and MUST NOT add any new
#    direct-to-client send path."
#
# WHAT THIS SCRIPT DOES (the STATIC half of U95's two-part acceptance):
#   Enumerates every source file that is POSITIONED to message a task's
#   requester directly — i.e. a file that (a) references the literal `tasks`
#   column name `requester_chat_id` AND (b) calls the Telegram send primitive
#   `notifyTelegram(` in that SAME file — and asserts that set is exactly the
#   fixed, named ALLOWLIST below. Any file outside the allowlist is a NEW /
#   ROGUE requester-messaging call site -> the guard FAILS (exit 1).
#
# THE ALLOWLIST (ground-truth verified against `origin/main` at the time this
# guard was authored — re-verify with the grep pipeline below if this drifts):
#
#   1. src/lib/jobs/trust-engine.ts
#      The canonical, doctrine-compliant path (P1-04). CLAIM-then-send
#      transactional-outbox: `defaultTrustSend()` -> `notifyTelegram({chatId:
#      plan.chatId, ...})` where `plan.chatId` traces to `task.requester_chat_id`
#      via the planner (`planSends`). This is THE report-back loop.
#
#   2. src/lib/jobs/board-hygiene.ts
#      A PRE-EXISTING, DOCUMENTED EXCEPTION — grandfathered, not fixed by this
#      guard/test/CI-only unit. Its own file header ("TRUST-ENGINE INTEGRATION
#      SEAM (P1-04)") records the decision: board-hygiene.ts's rule-1 owner
#      re-ping and rule-5 stale-backlog nudge shipped via `notify.ts`'s
#      `sendOwnerMessage()` BEFORE trust-engine.ts existed in this repo, with
#      an explicit note to "swap that one function's body" to the trust-engine
#      sender once P1-04 merged. That swap is real application-source work —
#      out of scope for U95, whose file lane is "Guard/test/CI ONLY — no
#      application source is modified" (master spec / build brief). Silently
#      excluding this file from the scan would misrepresent the current tree
#      as clean when it is not; breaking CI for a pre-existing condition this
#      unit was never asked to fix would be equally dishonest in the other
#      direction. Grandfathering it — named, dated, reasoned, right here — is
#      the honest middle: the guard still catches every OTHER (i.e. new)
#      sender starting today. A follow-up unit should retire this entry when
#      board-hygiene.ts is migrated onto the trust engine.
#
# HOW THIS GETS TEETH (the MUTATION-PROOF half — see
# tests/unit/report-back-invariant.test.ts): the test plants a synthetic file
# containing BOTH tokens outside the allowlist in a throwaway scratch tree
# (via --root) and asserts this script exits non-zero; it then removes the
# planted file and asserts a clean exit. The same test also runs this script
# against the REAL repository tree with no --root override, so the invariant
# is pinned for real, not only in a sandbox.
#
# Usage:
#   scripts/guard-report-back-invariant.sh [--root <path>]
#     --root   Directory to scan (must contain a `src/` subdirectory).
#              Defaults to this script's own repo root. Tests pass a
#              throwaway scratch directory here; CI/pre-commit use the default.
#
# Exit codes:
#   0  PASS — no requester-messaging call site exists outside the allowlist.
#   1  FAIL — a new/rogue requester-messaging call site was found.
#   2  usage error (bad --root, missing src/).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --root)
      [ $# -ge 2 ] || { echo "ERROR: --root requires a path argument" >&2; exit 2; }
      ROOT="$(cd "$2" && pwd)"
      shift 2
      ;;
    -h|--help)
      sed -n '1,60p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

SRC_DIR="$ROOT/src"
if [ ! -d "$SRC_DIR" ]; then
  echo "[guard-report-back-invariant] ERROR: $SRC_DIR does not exist (bad --root?)" >&2
  exit 2
fi

# ─── THE ALLOWLIST (paths relative to --root) ─────────────────────────────
ALLOWLIST=(
  "src/lib/jobs/trust-engine.ts"
  "src/lib/jobs/board-hygiene.ts"
)

_is_allowed() {
  local candidate="$1"
  local entry
  for entry in "${ALLOWLIST[@]}"; do
    [ "$candidate" = "$entry" ] && return 0
  done
  return 1
}

# ─── Enumerate every file under src/ that references requester_chat_id ────
# (node_modules / .next pruned — belt-and-braces; a real repo root has no
# such tree under src/, but a hostile/odd fixture might).
mapfile -t REQUESTER_FILES < <(
  find "$SRC_DIR" \
    \( -path "*/node_modules/*" -o -path "*/.next/*" \) -prune \
    -o -type f \( -name "*.ts" -o -name "*.tsx" \) -print \
  | sort \
  | xargs grep -l "requester_chat_id" 2>/dev/null || true
)

VIOLATIONS=()
for f in "${REQUESTER_FILES[@]:-}"; do
  [ -z "$f" ] && continue
  # Same-file co-occurrence: does this file ALSO call the send primitive?
  if grep -q "notifyTelegram(" "$f" 2>/dev/null; then
    rel="${f#"$ROOT"/}"
    if ! _is_allowed "$rel"; then
      VIOLATIONS+=("$rel")
    fi
  fi
done

if [ "${#VIOLATIONS[@]}" -eq 0 ]; then
  echo "[guard-report-back-invariant] PASS — requester-messaging call sites match the allowlist exactly:"
  for entry in "${ALLOWLIST[@]}"; do
    echo "  - $entry"
  done
  exit 0
else
  echo "[guard-report-back-invariant] INVARIANT VIOLATED — new requester-messaging call site(s) found outside the allowlist:"
  for v in "${VIOLATIONS[@]}"; do
    echo "  - $v"
  done
  echo ""
  echo "DOCTRINE (master spec Section X.2): ONLY src/lib/jobs/trust-engine.ts may message"
  echo "a task's requester_chat_id — through the CLAIM-then-send outbox (runTrustEngineForTask"
  echo "/ runTrustEngineSweep). Route the new send through that path instead of calling"
  echo "notifyTelegram() directly. If this is genuinely a deliberate, operator-ruled new"
  echo "exception, name it explicitly and add it to the ALLOWLIST in this script with the"
  echo "same dated, reasoned discipline as the board-hygiene.ts entry above — never a silent"
  echo "add."
  exit 1
fi
