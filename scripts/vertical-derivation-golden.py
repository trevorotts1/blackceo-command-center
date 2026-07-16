#!/usr/bin/env python3
"""
vertical-derivation-golden.py — derive the PINNED golden outputs for the CC
vertical-derivation parity harness (U107 / E5-2, closes G2a).

This is the ONE place the golden values in
  src/lib/routing/__fixtures__/vertical-derivation/golden.json
are produced. It imports the REAL onboarding
vertical-derivation-guard.py and runs its check_add() on the shared input
fixture (src/lib/routing/__fixtures__/vertical-derivation/input.json), so the
golden is byte-for-byte what the Python actually computes — the authority
src/lib/routing/departments.config.ts's checkAddDepartmentSync() (a
synchronous TS mirror, used on the hot loadDepartments() fallback path) is
checked against.

MANDATORY SANDBOX: vertical-derivation-guard.py's load_naming_map() reads
<scripts_dir>/../department-naming-map.json relative to itself — no HOME
resolution, no workspace write in --check-add mode. Still run this ONLY via
scripts/regen-vertical-derivation-golden.sh for consistency with this repo's
other Python-parity generator (scripts/seam-parity-golden.py).

Usage:
  python3 vertical-derivation-golden.py <onboarding-scripts-dir> <input.json> <output-golden.json>
"""

import importlib.util
import json
import os
import sys


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(2)

    scripts_dir = os.path.abspath(sys.argv[1])
    input_path = os.path.abspath(sys.argv[2])
    output_path = os.path.abspath(sys.argv[3])

    guard_path = os.path.join(scripts_dir, "vertical-derivation-guard.py")
    if not os.path.isfile(guard_path):
        print(f"FATAL: missing vertical-derivation-guard.py in {scripts_dir}", file=sys.stderr)
        sys.exit(2)

    vdg = _load_module(guard_path, "vertical_derivation_guard")

    with open(input_path, "r", encoding="utf-8") as f:
        fixture = json.load(f)

    nm = vdg.load_naming_map()
    dept_idx = vdg.dept_pack_index(nm)

    # ── pack-membership snapshot for the 25 CC default dept ids ──────────────
    # What departments.config.ts's VERTICAL_PACK_DEPARTMENTS table SHOULD say,
    # per the live naming map, for every id CC actually ships. Any id present
    # here with universal_primary:false is a REQUIRED key in that TS table;
    # a diff on this block is the drift signal.
    pack_membership = {}
    for did in fixture["deptIds"]:
        meta = dept_idx.get(did)
        if meta is None:
            pack_membership[did] = None
        else:
            pack_membership[did] = {"pack": meta["pack"], "universalPrimary": meta["universal_primary"]}

    # ── check_add() verdict matrix: every dept id x every declared-pack case ─
    cases = []
    for case in fixture["declaredCases"]:
        results = []
        for did in fixture["deptIds"]:
            allowed, error = vdg.check_add(did, case["declaredPacks"], naming_map=nm)
            results.append({"deptId": did, "allowed": allowed, "error": error})
        cases.append({"name": case["name"], "declaredPacks": case["declaredPacks"], "results": results})

    golden = {
        "meta": {
            "generatedBy": "scripts/vertical-derivation-golden.py",
            "pythonVersion": sys.version.split()[0],
            "namingMapVersion": nm.get("version"),
            "note": (
                "Regenerate ONLY via scripts/regen-vertical-derivation-golden.sh. "
                "Do not hand-edit."
            ),
        },
        "packMembership": pack_membership,
        "cases": cases,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(golden, f, indent=2, ensure_ascii=False, sort_keys=True)
        f.write("\n")

    print(f"wrote {output_path}")
    print(f"  namingMapVersion={golden['meta']['namingMapVersion']}")
    print(f"  deptIds={len(fixture['deptIds'])} declaredCases={len(cases)}")


if __name__ == "__main__":
    main()
