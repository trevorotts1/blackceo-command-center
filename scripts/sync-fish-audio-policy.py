#!/usr/bin/env python3
"""Vendor the reviewed Skill 30 production policy, with provenance and a digest."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source-root", required=True, type=Path)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
source_path = "30-fish-audio-api-reference/production-policy.json"
data = (args.source_root / source_path).read_bytes()
policy = json.loads(data)
if policy.get("schema_version") != 1:
    sys.exit("Unsupported Fish Audio policy schema")
target = Path(__file__).resolve().parents[1] / "config/fish-audio-policy.vendored.json"
digest = hashlib.sha256(data).hexdigest()
fingerprint = target.with_suffix(".json.sha256")
provenance = target.with_suffix(".source.json")
if args.check:
    record = json.loads(provenance.read_text())
    if target.read_bytes() != data or fingerprint.read_text().strip() != digest or record["sha256"] != digest:
        sys.exit("Fish Audio policy differs from the reviewed Skill 30 source")
    print("Fish Audio policy matches Skill 30 and its pinned fingerprint")
else:
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.source_root, text=True).strip()
    tracked = subprocess.check_output(["git", "show", "HEAD:" + source_path], cwd=args.source_root)
    if tracked != data:
        sys.exit("Commit the reviewed Skill 30 policy before vendoring it")
    target.write_bytes(data)
    fingerprint.write_text(digest + "\n")
    provenance.write_text(json.dumps({"repository": "trevorotts1/openclaw-onboarding", "commit": commit,
                                      "path": source_path, "sha256": digest}, indent=2) + "\n")
    print("Fish Audio policy, source provenance and fingerprint updated")
