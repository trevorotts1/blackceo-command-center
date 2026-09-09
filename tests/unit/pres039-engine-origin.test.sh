#!/usr/bin/env bash
# pres039-engine-origin.test.sh — PRES-039 QC check 1 (source-level) test.
#
# Proves, against the live worktree (never mocks of the module under test):
#   T1 module origin + version all expected (distributor ONB, vendored role,
#      contract v1, cutover owner PRES/PRES-049, digest stable).
#   T2 stale duplicate on PYTHONPATH: preflight detects (exit 3,
#      AF-ENGINE-STALE-DUPLICATE) — fail-closed before dispatch.
#   T3 identical-byte mirror on path: recorded, NOT fatal (exit 0).
#   T4 adapter version compatibility vs CC API contract: schema 1, metadata
#      key phase_id agreement (engine board.py + src/lib TS), launcher
#      refusal family -4..-8 intact (exit 0 live; exit 7 on tampered copy).
#   T5 run records origin: --new writes state.json engine_origin with
#      distributor/digest/commit; --status prints it; diagnose.describe_park
#      reports it.
#   T6 no dead-code removal: engine_origin.py is imported by __main__ +
#      launcher (grep proof), CC duplicate retained on disk (39 modules).
#   T7 import/service search evidence: no active runtime caller imports the
#      CC copy outside its own package (documents the no-delete rationale).
#
# Usage: bash tests/unit/pres039-engine-origin.test.sh
# Exit 0 = all pass. Any FAIL prints and exits 1.
set -u
WT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# T1: origin record -----------------------------------------------------------
T1_OUT="$(cd "$WT" && python3 -c "
import sys; sys.path.insert(0,'.')
from presentation_job import engine_origin as eo
o = eo.engine_origin()
assert o['distributor']=='ONB', o
assert o['copy_role']=='vendored-duplicate-non-authoritative', o
assert o['contract_version']==1, o
assert o['cutover_owner']=='PRES' and o['cutover_task']=='PRES-049', o
assert o['dedup_task']=='PRES-039', o
assert len(o['package_digest'])==64 and o['package_files']>=40, o
print('digest='+o['package_digest'][:12]+' files='+str(o['package_files']))
" 2>&1)" && ok "T1 origin declaration ($T1_OUT)" || bad "T1 origin declaration: $T1_OUT"

# T2: stale duplicate detected -------------------------------------------------
STALE="$(mktemp -d)/pres039-stale-$$"
mkdir -p "$STALE/presentation_job"
cp "$WT/presentation_job/__init__.py" "$WT/presentation_job/engine_origin.py" \
   "$WT/presentation_job/state.py" "$WT/presentation_job/board.py" \
   "$WT/presentation_job/launcher.py" "$STALE/presentation_job/"
python3 - "$STALE/presentation_job/state.py" <<'EOF' 2>/dev/null
import sys
p = sys.argv[1]
s = open(p).read().replace("STATE_SCHEMA_VERSION = 1", "STATE_SCHEMA_VERSION = 999")
open(p, "w").write(s)
EOF
T2_OUT="$(cd "$WT" && python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.append('$STALE')
from presentation_job import engine_origin as eo
code, rep = eo.preflight()
assert code==3, (code, rep)
assert rep.get('autofail')=='AF-ENGINE-STALE-DUPLICATE', rep
print(rep['autofail'])
" 2>&1)" && ok "T2 stale duplicate refused ($T2_OUT)" || bad "T2 stale duplicate: $T2_OUT"
rm -rf "$(dirname "$STALE")"

# T3: identical mirror tolerated ------------------------------------------------
MIRR="$(mktemp -d)/pres039-mirror-$$"
mkdir -p "$MIRR" && cp -r "$WT/presentation_job" "$MIRR/presentation_job"
T3_OUT="$(cd "$WT" && python3 -c "
import sys; sys.path.insert(0,'.'); sys.path.append('$MIRR')
from presentation_job import engine_origin as eo
code, rep = eo.preflight()
assert code==0, (code, rep)
print('notes='+str(rep.get('notes')))
" 2>&1)" && ok "T3 identical mirror tolerated ($T3_OUT)" || bad "T3 identical mirror: $T3_OUT"
rm -rf "$(dirname "$MIRR")"

# T4: contract compatibility ----------------------------------------------------
T4_OUT="$(cd "$WT" && python3 -c "
import sys; sys.path.insert(0,'.')
from presentation_job import engine_origin as eo
code, rep = eo.preflight()
assert code==0, (code, rep)
assert rep['contract_problems']==[], rep
print('contract-holds')
" 2>&1)" && ok "T4 live contract holds ($T4_OUT)" || bad "T4 live contract: $T4_OUT"

DRIFT="$(mktemp -d)/pres039-drift-$$"
mkdir -p "$DRIFT/presentation_job"
cp "$WT"/presentation_job/*.py "$DRIFT/presentation_job/" 2>/dev/null
cp "$WT"/presentation_job/*.json "$DRIFT/presentation_job/" 2>/dev/null
python3 - "$DRIFT/presentation_job/launcher.py" <<'EOF' 2>/dev/null
import sys
p = sys.argv[1]
s = open(p).read().replace("DISPATCH_NOTIFY_REFUSED = -7", "DISPATCH_NOTIFY_REFUSED = -70")
open(p, "w").write(s)
EOF
T4B_OUT="$(cd "$WT" && python3 -c "
import sys; sys.path.insert(0,'.')
from presentation_job import engine_origin as eo
from pathlib import Path
# contract check direct (preflight-from-cwd would flag the live copy as the
# shadow; _check_contract isolates the drift verdict for the tampered dir).
ok, probs = eo._check_contract(Path('$DRIFT/presentation_job'))
assert not ok, probs
assert any('DISPATCH_NOTIFY_REFUSED' in p for p in probs), probs
print('AF-ENGINE-CONTRACT-DRIFT')
" 2>&1)" && ok "T4b drifted copy refused ($T4B_OUT)" || bad "T4b drifted copy: $T4B_OUT"
rm -rf "$(dirname "$DRIFT")"

# T5: run records origin ---------------------------------------------------------
RUN_TMP="$(mktemp -d)/pres039-run-$$"
mkdir -p "$RUN_TMP"
cat > "$RUN_TMP/intake.json" <<'EOF'
{"presentation_type": "from_scratch", "requester": {"chat_id": "qc-probe-039"}}
EOF
# --new needs a manifest passing the engine's own staleness gate
# (>= v51, >= 40 phases). No canonical manifest ships in the CC tree, so the
# fixture is generated from the live ONB canonical manifest byte-shape
# (version + phase ids), never hand-counted.
python3 - "$RUN_TMP/manifest.json" <<'EOF'
import json, sys
src = json.load(open('/Users/blackceomacmini/openclaw-onboarding/universal-sops/presentation-slide-craft/PIPELINE-MANIFEST.json'))
json.dump({"manifest_version": src["manifest_version"],
           "phases": [{"id": p["id"], "order": p.get("order", 0)} for p in src["phases"]],
           "autofails": src.get("autofails", []),
           "deliverables_required": src.get("deliverables_required", [])},
          open(sys.argv[1], "w"))
print("fixture phases:", len(src["phases"]), "v:", src["manifest_version"])
EOF
T5_NEW="$(cd "$WT" && python3 -c "
import sys; sys.path.insert(0,'.')
from presentation_job.__main__ import cmd_new
import argparse
args = argparse.Namespace(manifest='$RUN_TMP/manifest.json', run_dir=__import__('pathlib').Path('$RUN_TMP/job1'), intake=__import__('pathlib').Path('$RUN_TMP/intake.json'))
from pathlib import Path
import presentation_job.__main__ as m
# cmd_new signature: (args, scripts_dir)
rc = m.cmd_new(args, Path('.'))
print('rc='+str(rc))
" 2>&1)"
if echo "$T5_NEW" | grep -q "engine origin: distributor=ONB"; then
  EO_DIGEST="$(python3 -c "import json; print(json.load(open('$RUN_TMP/job1/state.json'))['engine_origin']['package_digest'][:12])" 2>&1)"
  ok "T5 --new records origin (digest=$EO_DIGEST)"
else
  bad "T5 --new records origin: $T5_NEW"
fi
T5_STATUS="$(cd "$WT" && python3 -c "
import sys; sys.path.insert(0,'.')
import presentation_job.__main__ as m, argparse
from pathlib import Path
rc = m.cmd_status(argparse.Namespace(run_dir=Path('$RUN_TMP/job1'), json=False))
" 2>&1)"
echo "$T5_STATUS" | grep -q "engine   : distributor=ONB" \
  && ok "T5 --status prints origin" || bad "T5 --status prints origin: $T5_STATUS"
T5_DIAG="$(cd "$WT" && python3 -c "
import sys, json; sys.path.insert(0,'.')
from presentation_job import diagnose
st = json.load(open('$RUN_TMP/job1/state.json'))
print('\n'.join(diagnose.describe_park(st)))
" 2>&1)"
echo "$T5_DIAG" | grep -q "engine   : distributor=ONB" \
  && ok "T5 diagnose reports origin" || bad "T5 diagnose reports origin: $T5_DIAG"
rm -rf "$(dirname "$RUN_TMP")"

# T6: no dead-code removal --------------------------------------------------------
grep -q "engine_origin" "$WT/presentation_job/__main__.py" \
  && grep -q "engine_origin" "$WT/presentation_job/launcher.py" \
  && ok "T6 engine_origin wired into __main__ + launcher" \
  || bad "T6 wiring grep failed"
CC_COUNT="$(ls "$WT"/presentation_job/*.py | wc -l | tr -d ' ')"
[ "$CC_COUNT" -ge 39 ] \
  && ok "T6 CC duplicate retained ($CC_COUNT modules, nothing deleted)" \
  || bad "T6 module count $CC_COUNT < 39 — code was deleted"

# T7: import/service search evidence ----------------------------------------------
# Own test file is excluded: it names the package by necessity (sys.path +
# module import), not as a production runtime caller.
T7_HITS="$(cd "$WT" && git grep -l "presentation_job" -- ':!presentation_job' -- ':/src' ':/scripts' ':/tests' ':/package.json' 2>/dev/null | grep -v "pres039-engine-origin" | head -n 20)"
T7_CODE_HITS="$(echo "$T7_HITS" | grep -vE '\.ts$|\.test\.ts$' || true)"
if [ -z "$T7_CODE_HITS" ]; then
  ok "T7 no active runtime importer outside package (refs only in comments/TS docs)"
else
  bad "T7 unexpected runtime importer: $T7_CODE_HITS"
fi
echo "$T7_HITS" | grep -q . && echo "  (doc-only refs kept: $(echo "$T7_HITS" | tr '\n' ' '))"

echo "---- pres039-engine-origin: $PASS passed, $FAIL failed ----"
[ "$FAIL" -eq 0 ]
