#!/usr/bin/env bash
#
# DEMO STUB — record-dept-decision.sh
#
# Workspace-pinned replacement for the real Skill-23 record-dept-decision.sh,
# wired in via OPENCLAW_SKILL23_SCRIPTS. The Command Center interview seam
# (src/lib/interview/seam.ts -> recordDeptDecision) execFiles this with:
#     --dept <id> --decision <yes|no|later> --source <str> --by <ownerId>
#     --session <id> --state <buildStatePath>
#
# The real script already honors --state; the app pins --state to the demo
# build-state path (buildStatePath() resolves OPENCLAW_WORKSPACE_ROOT), so this
# stub writes the provenanced decision object into the DEMO build-state only.
# A --demo-workspace marker guard makes it impossible to write elsewhere.
#
# It writes canonicalReconciliation.decisions[<dept>] = the SAME provenanced
# object the real script writes: {decision, source, decidedAt, decidedBy, sessionId}
# — so the app's coverage/provenance gates (isProvenanced) are satisfied exactly.
# Zero side effects beyond that single JSON write. Fictional data only.
set -euo pipefail

DEPT="" DECISION="" SOURCE="owner-interview" BY="" SESSION="" STATE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dept) DEPT="${2:-}"; shift 2 ;;
    --decision) DECISION="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --by) BY="${2:-}"; shift 2 ;;
    --session) SESSION="${2:-}"; shift 2 ;;
    --state) STATE="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

# --state is the app-pinned demo build-state; fall back to the env workspace.
if [[ -z "$STATE" && -n "${OPENCLAW_WORKSPACE_ROOT:-}" ]]; then
  STATE="${OPENCLAW_WORKSPACE_ROOT}/.workforce-build-state.json"
fi

if [[ -z "$STATE" ]]; then
  echo "demo record-dept-decision.sh: no --state and no OPENCLAW_WORKSPACE_ROOT — refusing." >&2
  exit 1
fi
STATE_DIR="$(cd "$(dirname "$STATE")" && pwd)"
if [[ ! -f "$STATE_DIR/.demo-workspace" ]]; then
  echo "demo record-dept-decision.sh: '$STATE_DIR' is not a marked demo workspace — refusing." >&2
  exit 1
fi

# Validate inputs the way the real enforcer would (exit 1 → route maps to 400).
if [[ -z "$DEPT" ]]; then echo "missing --dept" >&2; exit 1; fi
case "$DECISION" in yes|no|later) : ;; *) echo "invalid --decision: $DECISION" >&2; exit 1 ;; esac
if [[ -z "$BY" ]]; then
  # An empty decidedBy makes a "no" unhonored by the build enforcer.
  echo "refusing to record a decision with an empty --by (decidedBy)" >&2; exit 1
fi

STATE="$STATE" DEPT="$DEPT" DECISION="$DECISION" SOURCE="$SOURCE" BY="$BY" SESSION="$SESSION" \
python3 - <<'PY'
import json, os, tempfile, datetime

path = os.environ["STATE"]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

try:
    with open(path, "r", encoding="utf-8") as f:
        state = json.load(f)
    if not isinstance(state, dict):
        state = {}
except (FileNotFoundError, json.JSONDecodeError):
    state = {}

recon = state.get("canonicalReconciliation")
if not isinstance(recon, dict):
    recon = {}
decisions = recon.get("decisions")
if not isinstance(decisions, dict):
    decisions = {}

decisions[os.environ["DEPT"]] = {
    "decision": os.environ["DECISION"],
    "source": os.environ["SOURCE"] or "owner-interview",
    "decidedAt": now,
    "decidedBy": os.environ["BY"],
    "sessionId": os.environ.get("SESSION", ""),
}
recon["decisions"] = decisions
state["canonicalReconciliation"] = recon

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".bs.tmp.")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
print(f"demo: recorded {os.environ['DEPT']} = {os.environ['DECISION']} (provenanced)")
PY
