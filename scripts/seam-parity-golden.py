#!/usr/bin/env python3
"""
seam-parity-golden.py — derive the PINNED golden outputs for the CC seam-vs-Python
parity harness (Wave 5 / P3-7).

This is the ONE place the golden values in
  src/lib/interview/__fixtures__/parity/golden.json
are produced. It imports the REAL onboarding enforcers and runs them on the shared
input fixture, so the golden is byte-for-byte what the Python actually computes:

  * canonical_decline.norm            <-> seam.norm
  * build-workforce._expected_decision_ids
                                      <-> seam.computeExpectedDecisionIds
  * canonical_decline.decision_coverage
                                      <-> seam.computeDecisionCoverage (missing/covered)
  * canonical_decline.canonical_decline_set / decline_rejections
                                      <-> seam.computeDecisionCoverage (declined/rejections)
                                          + seam.noUnprovenancedDeclines
  * list-canonical-departments.py --json (the LIVE floor the seam shells to)
                                      -> pinned into golden.canonical for the TS side.

MANDATORY SANDBOX: the onboarding scripts resolve /data-else-$HOME. Run this ONLY
via scripts/regen-seam-parity-golden.sh, which exports a throwaway HOME first.
Do NOT invoke directly against a real workspace.

Usage:
  python3 seam-parity-golden.py <onboarding-scripts-dir> <input.json> <output-golden.json>
"""

import importlib.util
import json
import os
import subprocess
import sys
import warnings


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

    for req in ("canonical_decline.py", "build-workforce.py", "list-canonical-departments.py"):
        if not os.path.isfile(os.path.join(scripts_dir, req)):
            print(f"FATAL: missing {req} in {scripts_dir}", file=sys.stderr)
            sys.exit(2)

    # Sandbox guard: refuse to run against a HOME that looks like a real workspace.
    home = os.environ.get("HOME", "")
    for danger in (".openclaw", ".clawdbot", "clawd"):
        if os.path.exists(os.path.join(home, danger)):
            print(
                f"FATAL: HOME={home} contains a real workspace ({danger}). "
                "Run via scripts/regen-seam-parity-golden.sh with a throwaway HOME.",
                file=sys.stderr,
            )
            sys.exit(2)

    sys.path.insert(0, scripts_dir)
    cd = _load_module(os.path.join(scripts_dir, "canonical_decline.py"), "canonical_decline")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        bw = _load_module(os.path.join(scripts_dir, "build-workforce.py"), "build_workforce")

    with open(input_path, "r", encoding="utf-8") as f:
        fixture = json.load(f)

    # ── canonical snapshot (the LIVE floor the seam shells to at runtime) ──────
    canonical = json.loads(
        subprocess.check_output(
            [sys.executable, os.path.join(scripts_dir, "list-canonical-departments.py"), "--json"],
        )
    )
    # Normalize the source path to a basename so the committed golden is portable
    # (the absolute path is machine-specific and carries no parity signal).
    if isinstance(canonical.get("source"), str):
        canonical["source"] = os.path.basename(canonical["source"])
    # Cross-check: the ids build-workforce._expected_decision_ids unions MUST equal
    # the mandatory + universal ids the canonical script emits (same naming map).
    canon_ids = [d["id"] for d in canonical["mandatory"]] + [
        d["id"] for d in canonical["universal_primary_vertical"]
    ]
    bw_base = bw._expected_decision_ids({})
    if bw_base != canon_ids:
        print(
            "FATAL: build-workforce floor drifted from list-canonical-departments.\n"
            f"  bw   = {bw_base}\n  canon= {canon_ids}",
            file=sys.stderr,
        )
        sys.exit(1)

    # ── norm parity ───────────────────────────────────────────────────────────
    norm_out = [{"in": s, "out": cd.norm(s)} for s in fixture["normInputs"]]

    # ── expected-decision-set parity ──────────────────────────────────────────
    expected_set = []
    for case in fixture["expectedSetCases"]:
        ids = bw._expected_decision_ids(case["departmentsConfig"])
        expected_set.append(
            {
                "name": case["name"],
                "tsCustomDeptIds": case["tsCustomDeptIds"],
                "tsImplicitYesCustomIds": case["tsImplicitYesCustomIds"],
                "ids": ids,
            }
        )

    # ── decision-coverage + canonical-decline-provenance parity ──────────────
    decline = []
    for case in fixture["declineCases"]:
        bs = case["buildState"]
        exp = case["expectedIds"]
        missing, covered = cd.decision_coverage(bs, exp)
        declined_norm = sorted(cd.canonical_decline_set(bs))
        rejections = sorted(r["id"] for r in cd.decline_rejections(bs))
        decline.append(
            {
                "name": case["name"],
                "expectedIds": exp,
                "missing": missing,            # sorted, raw ids
                "covered": covered,            # sorted, raw ids
                "declinedNorm": declined_norm,  # sorted, normalized honored declines
                "rejections": rejections,       # sorted, raw ids of un-provenanced declines
                "noUnprovenancedDeclines": len(rejections) == 0,
            }
        )

    golden = {
        "meta": {
            "generatedBy": "scripts/seam-parity-golden.py",
            "pythonVersion": sys.version.split()[0],
            "namingMapVersion": canonical.get("naming_map_version"),
            "canonicalSource": os.path.basename(str(canonical.get("source", ""))),
            "note": (
                "Regenerate ONLY via scripts/regen-seam-parity-golden.sh (sandboxed HOME). "
                "Do not hand-edit."
            ),
        },
        "canonical": canonical,
        "norm": norm_out,
        "expectedSet": expected_set,
        "decline": decline,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(golden, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"wrote {output_path}")
    print(f"  namingMapVersion={golden['meta']['namingMapVersion']} floor={canonical['floor']}")
    print(f"  norm cases={len(norm_out)} expectedSet cases={len(expected_set)} decline cases={len(decline)}")


if __name__ == "__main__":
    main()
