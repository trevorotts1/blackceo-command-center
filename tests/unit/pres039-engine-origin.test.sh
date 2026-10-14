#!/usr/bin/env bash
# pres039-engine-origin.test.sh -- PRES-039 QC check 1 (source-level) test.
#
# POST-UNIFICATION SHAPE (Item 7, B7 two-copies design, Step 3).
# presentation_job/ in this repo is GENERATED OUTPUT from the canonical
# package in trevorotts1/openclaw-onboarding, pinned to the commit recorded
# in presentation_job/PARITY-MANIFEST.json by
# scripts/sync-presentation-engine.sh. The primary protection is therefore
# PARITY (T0). The origin protections (T1-T6) run against the pinned tree's
# own engine_origin module and read their expectations from
# PARITY-MANIFEST.json, never from literals baked into this file:
#
#   - RETIRED: the old T1 literal copy role
#     'vendored-duplicate-non-authoritative'. The generated copy carries
#     canonical's own declared role; the manifest's origin block records it
#     at generation time and T1 asserts the module agrees with the manifest.
#   - RETIRED: the old T4 literal launcher token
#     'DISPATCH_ENGINE_REFUSED = -8'. Canonical renumbered the engine
#     refusal to -12 (its -8 is DISPATCH_OCR_REFUSED, FIX 33) when
#     engine_origin was upstreamed; the pinned tree's
#     engine_origin._check_contract asserts the canonical value, and T4
#     reuses that check instead of re-asserting a number here.
#   - RETIRED: the old T6 literal module floor (39). The census is the
#     parity manifest's own file list: modules on disk must equal it.
#
# While the pin predates the PRES-039 upstream merge (a canonical commit
# whose tree carries no engine_origin.py), T1-T4 and the wiring half of
# T6 SKIP loudly and T0, T5c and T7 carry the gate. A skip is printed and
# counted, never a silent pass; when the pin advances past the upstream
# the origin sections run again unmodified.
#
#   T0 parity: the verifier passes on the live tree (per-file blob SHA +
#      sha256 vs PARITY-MANIFEST, no unlisted files, digest recomputes,
#      contract invariants hold).
#   T1 origin record: distributor / copy role / contract version / cutover
#      agree with the manifest's origin block; the module census over the
#      package minus PARITY-MANIFEST.json equals the manifest digest.
#   T2 stale duplicate on PYTHONPATH: preflight refuses (exit 3,
#      AF-ENGINE-STALE-DUPLICATE) -- fail-closed before dispatch.
#   T3 identical-byte mirror on path: recorded, NOT fatal (exit 0).
#   T4 contract compatibility vs the CC API surface: schema 1, metadata
#      key phase_id agreement, launcher refusal family intact per the
#      pinned tree's own _check_contract (exit 0 live; tampered copy is
#      refused).
#   T5 run records origin: --new writes state.json engine_origin with
#      distributor/digest/commit; --status prints it; diagnose.describe_park
#      reports it. Needs the canonical pipeline manifest (ONBOARDING_CHECKOUT
#      or ~/openclaw-onboarding); skips loudly when unreachable, as in CI.
#   T5c state compatibility: a state.json written by the PRE-SYNC CC copy
#      (tests/fixtures/pres039/state-written-by-pre-sync-cc-copy.json,
#      schema v1) is opened by the pinned engine's --status and diagnose
#      paths without error.
#   T6 census + wiring: .py modules on disk == the manifest's census;
#      engine_origin is imported by __main__ + launcher (when present).
#   T7 import/service search evidence: no active runtime caller imports
#      this copy outside its own package (documents the no-delete
#      rationale). The parity tooling names the package to VERIFY it
#      (scripts/sync-presentation-engine.*) and is excluded by name, like
#      this test itself; any other hit fails.
#
# Usage: bash tests/unit/pres039-engine-origin.test.sh
# Exit 0 = every non-skipped check passed. Any FAIL prints and exits 1.
set -u
WT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$WT/presentation_job/PARITY-MANIFEST.json"
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
skip() { SKIP=$((SKIP+1)); echo "SKIP: $1"; }

HAVE_EO=0
[ -f "$WT/presentation_job/engine_origin.py" ] && HAVE_EO=1

# T0: parity against the pin ---------------------------------------------------
T0_OUT="$(cd "$WT" && python3 scripts/sync-presentation-engine.py verify 2>&1)" \
  && ok "T0 parity vs PARITY-MANIFEST ($T0_OUT)" \
  || bad "T0 parity vs PARITY-MANIFEST: $T0_OUT"

if [ "$HAVE_EO" -eq 0 ]; then
  skip "T1-T4 origin protections: pinned tree carries no engine_origin.py (pin predates the PRES-039 upstream merge); they resume unmodified when the pin advances"
  skip "T5 run records origin: no engine_origin in the pinned tree (see T5c for the state check that does run)"
else
# T1: origin record, expectations from PARITY-MANIFEST -------------------------
T1_OUT="$(cd "$WT" && python3 -c "
import json, os, sys, tempfile
from pathlib import Path
sys.path.insert(0, '.')
from presentation_job import engine_origin as eo
man = json.load(open('presentation_job/PARITY-MANIFEST.json'))
origin = man.get('origin')
assert origin, 'manifest carries no origin block but the tree has engine_origin.py'
o = eo.engine_origin()
assert o['distributor'] == origin['distributor'] == 'ONB', (o, origin)
assert o['copy_role'] == origin['copy_role'], (o['copy_role'], origin['copy_role'])
assert o['contract_version'] == origin['contract_version'] == 1, (o, origin)
assert o['cutover_owner'] == origin['cutover_owner'] == 'PRES', (o, origin)
assert o['cutover_task'] == origin['cutover_task'] == 'PRES-049', (o, origin)
assert o['dedup_task'] == origin['dedup_task'] == 'PRES-039', (o, origin)
# Census agreement: the module's own digest over the package minus
# PARITY-MANIFEST.json (a manifest cannot record a digest covering itself)
# must equal the digest the manifest records.
pkg = Path('presentation_job')
with tempfile.TemporaryDirectory() as td:
    census = Path(td) / 'census'; census.mkdir()
    for name in os.listdir(pkg):
        if name == 'PARITY-MANIFEST.json':
            continue
        src = pkg / name
        if src.is_file() and (name.endswith('.py') or name.endswith('.json')):
            (census / name).symlink_to(src.resolve())
    d = eo.package_digest(census)
assert d['digest'] == man['package_digest'], (d['digest'], man['package_digest'])
assert d['file_count'] == man['package_files'], (d['file_count'], man['package_files'])
print('role='+o['copy_role']+' digest='+d['digest'][:12]+' census='+str(d['file_count']))
" 2>&1)" && ok "T1 origin declaration from manifest ($T1_OUT)" || bad "T1 origin declaration: $T1_OUT"

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

# T4: contract compatibility (the pinned tree's own _check_contract) ------------
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
ONB_ROOT="${ONBOARDING_CHECKOUT:-$HOME/openclaw-onboarding}"
ONB_MANIFEST_SRC="$ONB_ROOT/universal-sops/presentation-slide-craft/PIPELINE-MANIFEST.json"
if [ ! -f "$ONB_MANIFEST_SRC" ]; then
  skip "T5 run records origin: canonical pipeline manifest not reachable at $ONB_MANIFEST_SRC (set ONBOARDING_CHECKOUT to an onboarding checkout to run it)"
else
RUN_TMP="$(mktemp -d)/pres039-run-$$"
mkdir -p "$RUN_TMP"
cat > "$RUN_TMP/intake.json" <<'EOF'
{"presentation_type": "from_scratch", "requester": {"chat_id": "qc-probe-039"}}
EOF
# --new needs a manifest passing the engine's own staleness gate
# (>= v51, >= 40 phases). No canonical manifest ships in this repo, so the
# fixture is generated from the live ONB canonical manifest byte-shape
# (version + phase ids), never hand-counted.
python3 - "$RUN_TMP/manifest.json" "$ONB_MANIFEST_SRC" <<'EOF'
import json, sys
src = json.load(open(sys.argv[2]))
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
fi
fi

# T5c: state written by the PRE-SYNC copy opens under the pinned engine ---------
COMPAT_TMP="$(mktemp -d)/pres039-compat-$$"
mkdir -p "$COMPAT_TMP/job"
cp "$WT/tests/fixtures/pres039/state-written-by-pre-sync-cc-copy.json" "$COMPAT_TMP/job/state.json"
T5C_OUT="$(cd "$WT" && python3 -c "
import sys, json; sys.path.insert(0,'.')
import argparse
from pathlib import Path
import presentation_job.__main__ as m
from presentation_job import diagnose
rc = m.cmd_status(argparse.Namespace(run_dir=Path('$COMPAT_TMP/job'), json=False))
assert rc == 0, rc
st = json.load(open('$COMPAT_TMP/job/state.json'))
lines = diagnose.describe_park(st)
assert isinstance(lines, list) and lines, lines
print('status-ok job='+str(st.get('job_id'))+' describe_lines='+str(len(lines)))
" 2>&1)" && ok "T5c pre-sync state opens under pinned engine ($T5C_OUT)" \
  || bad "T5c pre-sync state compat: $T5C_OUT"
rm -rf "$(dirname "$COMPAT_TMP")"

# T6: census from the manifest (+ wiring when engine_origin is present) ---------
T6_OUT="$(cd "$WT" && python3 -c "
import json, os
man = json.load(open('presentation_job/PARITY-MANIFEST.json'))
listed_py = sorted(f['path'] for f in man['files'] if f['path'].endswith('.py'))
on_disk = []
for root, dirs, names in os.walk('presentation_job'):
    dirs[:] = [d for d in dirs if d != '__pycache__']
    for n in names:
        if n.endswith('.py'):
            on_disk.append(os.path.relpath(os.path.join(root, n), 'presentation_job'))
on_disk.sort()
assert on_disk == listed_py, (len(on_disk), len(listed_py))
print('modules='+str(len(on_disk))+' (manifest census, total files '+str(man['file_count'])+')')
" 2>&1)" && ok "T6 module census matches manifest ($T6_OUT)" || bad "T6 census: $T6_OUT"
if [ "$HAVE_EO" -eq 1 ]; then
  grep -q "engine_origin" "$WT/presentation_job/__main__.py" \
    && grep -q "engine_origin" "$WT/presentation_job/launcher.py" \
    && ok "T6 engine_origin wired into __main__ + launcher" \
    || bad "T6 wiring grep failed"
else
  skip "T6 wiring grep: no engine_origin in the pinned tree to wire"
fi

# T7: import/service search evidence ----------------------------------------------
# Own test file, its fixture, and the parity tooling are excluded by name:
# they name the package to verify it (sys.path + module import in this test;
# the recorded source_path inside the captured pre-sync state.json; per-file
# hash checks in the sync scripts), not as production runtime callers.
T7_HITS="$(cd "$WT" && git grep -l "presentation_job" -- ':!presentation_job' -- ':/src' ':/scripts' ':/tests' ':/package.json' 2>/dev/null | grep -vE "pres039|sync-presentation-engine" | head -n 20)"
T7_CODE_HITS="$(echo "$T7_HITS" | grep -vE '\.ts$|\.test\.ts$' || true)"
if [ -z "$T7_CODE_HITS" ]; then
  ok "T7 no active runtime importer outside package (refs only in comments/TS docs)"
else
  bad "T7 unexpected runtime importer: $T7_CODE_HITS"
fi
echo "$T7_HITS" | grep -q . && echo "  (doc-only refs kept: $(echo "$T7_HITS" | tr '\n' ' '))"

echo "---- pres039-engine-origin: $PASS passed, $FAIL failed, $SKIP skipped ----"
[ "$FAIL" -eq 0 ]
