#!/usr/bin/env bash
#
# DEMO STUB — update-interview-state.sh
#
# Kick-free, workspace-pinned replacement for the real Skill-23
# update-interview-state.sh, wired in via OPENCLAW_SKILL23_SCRIPTS. The Command
# Center interview seam (src/lib/interview/seam.ts -> updateInterviewState)
# execFiles this with the SAME flags the Telegram agent presses:
#     --phase <str>  --question-number <int>  --asked-by <str>
#     --phases-complete <csv>  --complete
#
# WHY THIS STUB EXISTS (the confirmed hazard it closes):
#   The REAL update-interview-state.sh has NO --state flag and resolves the
#   workspace ITSELF (/data else $HOME), IGNORING OPENCLAW_WORKSPACE_ROOT. A demo
#   instance that merely set OPENCLAW_WORKSPACE_ROOT and called the real script
#   would still write interview state into the LIVE operator workspace and
#   silently corrupt real Skill-23 state. This stub instead HONORS
#   OPENCLAW_WORKSPACE_ROOT and refuses to run against anything that is not a
#   marked demo workspace, so it can NEVER touch a real workspace.
#
#   It also contains NO build-kick logic whatsoever: `--complete` marks the
#   interview complete + QC pass + build complete directly in the DEMO build
#   state. The real [WORKFORCE-RESUME] multi-agent build is structurally
#   impossible to fire from here.
#
# Fictional / zero-cost / zero-side-effect. Writes only the demo build-state file.
set -euo pipefail

WS="${OPENCLAW_WORKSPACE_ROOT:-}"

# --- Isolation guard (belt AND suspenders) ----------------------------------
# Refuse unless OPENCLAW_WORKSPACE_ROOT is set AND carries the demo marker the
# seeder drops. This makes it impossible for the stub to write to a real
# workspace even if the env were misconfigured.
if [[ -z "$WS" ]]; then
  echo "demo update-interview-state.sh: OPENCLAW_WORKSPACE_ROOT is unset — refusing to run (demo stub is workspace-pinned)." >&2
  exit 1
fi
if [[ ! -f "$WS/.demo-workspace" ]]; then
  echo "demo update-interview-state.sh: '$WS' is not a marked demo workspace (missing .demo-workspace) — refusing to run." >&2
  exit 1
fi

BUILD_STATE="$WS/.workforce-build-state.json"

PHASE=""
QNUM=""
ASKED_BY=""
PHASES_COMPLETE=""
COMPLETE="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="${2:-}"; shift 2 ;;
    --question-number) QNUM="${2:-}"; shift 2 ;;
    --asked-by) ASKED_BY="${2:-}"; shift 2 ;;
    --phases-complete) PHASES_COMPLETE="${2:-}"; shift 2 ;;
    --complete) COMPLETE="1"; shift ;;
    *) shift ;;
  esac
done

BUILD_STATE="$BUILD_STATE" \
PHASE="$PHASE" QNUM="$QNUM" ASKED_BY="$ASKED_BY" \
PHASES_COMPLETE="$PHASES_COMPLETE" COMPLETE="$COMPLETE" \
python3 - <<'PY'
import json, os, sys, tempfile, datetime

path = os.environ["BUILD_STATE"]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

try:
    with open(path, "r", encoding="utf-8") as f:
        state = json.load(f)
    if not isinstance(state, dict):
        state = {}
except (FileNotFoundError, json.JSONDecodeError):
    state = {}

prog = state.get("interviewProgress")
if not isinstance(prog, dict):
    prog = {}

phase = os.environ.get("PHASE", "")
qnum = os.environ.get("QNUM", "")
asked_by = os.environ.get("ASKED_BY", "")
phases_complete = os.environ.get("PHASES_COMPLETE", "")

if phase:
    prog["lastQuestionPhase"] = phase
if qnum:
    try:
        # Monotonic: progress never regresses (the web cards post their structured
        # index, which is lower than the resume position; keep the higher value so
        # the progress rail stays truthful and photogenic).
        prev = prog.get("lastQuestionNumber")
        prev = int(prev) if isinstance(prev, (int, float)) else 0
        prog["lastQuestionNumber"] = max(prev, int(qnum))
    except (ValueError, TypeError):
        pass
if asked_by:
    prog["lastQuestionAskedBy"] = asked_by
prog["lastQuestionAt"] = now
if phases_complete:
    existing = prog.get("phasesComplete")
    if not isinstance(existing, list):
        existing = []
    for p in [x.strip() for x in phases_complete.split(",") if x.strip()]:
        if p not in existing:
            existing.append(p)
    prog["phasesComplete"] = existing

state["interviewProgress"] = prog

if os.environ.get("COMPLETE") == "1":
    # Kick-free completion: mark complete + QC pass + build complete directly.
    # NO [WORKFORCE-RESUME] kick, NO qc subprocess, NO gateway call.
    state["interviewComplete"] = True
    state["interviewCompletedAt"] = now
    qc = state.get("interviewQc")
    if not isinstance(qc, dict):
        qc = {}
    qc["status"] = "pass"
    qc["scoredAt"] = now
    qc["note"] = "demo stub: QC auto-passed (no real workforce build)"
    state["interviewQc"] = qc
    # buildCompletedAt drives the shell-lock reveal + the /onboarding/building
    # screen advancing to 'Open Command Center'. The demo company is pre-seeded,
    # so the build is, in the demo fiction, already complete.
    state["buildCompletedAt"] = now

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".bs.tmp.")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)

if os.environ.get("COMPLETE") == "1":
    print("demo: interview marked complete (QC pass, build complete) — no build kick fired")
else:
    print("demo: interview progress updated")
PY
