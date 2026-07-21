#!/usr/bin/env python3
"""validate-workflow-json.py — T2-39 / A46.

WHY THIS EXISTS
---------------
`agents/n8n-workflow-builder/IDENTITY.md` promises "All N8N JSON output MUST be
valid and importable" and "No triple backticks in JSON output". Nothing in the
agent's directory parsed, validated or attempted an import, so the promise was
enforced by nobody and the failure surfaced at import time inside the client's
automation host. The deliverable's validity is binary and cheap to check.

WHAT IT CHECKS (in order — the first failing class stops the run)
-----------------------------------------------------------------
1. FENCED OUTPUT — a leading/trailing markdown code fence (``` or ```json) or any
   prose outside the JSON document. n8n's importer takes a raw document.
2. PARSE — the payload is a single JSON object.
3. SHAPE — `nodes` is a non-empty array, `connections` is an object.
4. NODES — every node carries a non-empty string `name`, a non-empty string
   `type`, a two-number `position`, and an object `parameters`; node names are
   unique (n8n keys connections by node NAME, so a duplicate silently drops a
   branch on import).
5. CONNECTIONS — every source key and every destination `node` names a node that
   exists; every destination carries an integer `index` and a string `type`.

WHAT IT DELIBERATELY DOES NOT DO
--------------------------------
It does not invent a verdict it cannot support. A live non-mutating import check
against a configured n8n endpoint is a separate, credential-bearing step; when no
endpoint is configured this script reports "static validation only" rather than
claiming importability it did not observe.

EXIT CODES
----------
0 → the document passed every static check that ran.
1 → the document FAILED a check (every violation is listed).
2 → the check COULD NOT RUN (no input). Never treated as a pass.

USAGE
-----
  validate-workflow-json.py path/to/workflow.json
  cat workflow.json | validate-workflow-json.py -
  validate-workflow-json.py --self-test
"""
from __future__ import annotations

import json
import pathlib
import sys

FENCE_MARKERS = ("```", "~~~")


def check_unfenced(raw: str) -> list[str]:
    problems: list[str] = []
    stripped = raw.strip()
    if not stripped:
        return ["empty payload — nothing to validate"]
    for marker in FENCE_MARKERS:
        if marker in raw:
            problems.append(
                f"output is FENCED: contains {marker!r}. n8n imports a raw JSON "
                "document; a code fence makes the file unparseable."
            )
    if not stripped.startswith("{"):
        problems.append(
            f"output does not begin with '{{' (starts with {stripped[:20]!r}) — "
            "prose or a fence precedes the JSON document."
        )
    if not stripped.endswith("}"):
        problems.append(
            f"output does not end with '}}' (ends with {stripped[-20:]!r}) — "
            "trailing prose or a fence follows the JSON document."
        )
    return problems


def check_schema(doc: object) -> list[str]:
    problems: list[str] = []
    if not isinstance(doc, dict):
        return [f"top level is {type(doc).__name__}, expected a JSON object"]

    nodes = doc.get("nodes")
    if not isinstance(nodes, list):
        problems.append("'nodes' is missing or is not an array")
        nodes = []
    elif not nodes:
        problems.append("'nodes' is an empty array — a workflow with no nodes imports as a blank canvas")

    connections = doc.get("connections")
    if not isinstance(connections, dict):
        problems.append("'connections' is missing or is not an object")
        connections = {}

    names: list[str] = []
    for i, node in enumerate(nodes):
        where = f"nodes[{i}]"
        if not isinstance(node, dict):
            problems.append(f"{where} is {type(node).__name__}, expected an object")
            continue
        name = node.get("name")
        if not isinstance(name, str) or not name.strip():
            problems.append(f"{where} has no non-empty string 'name'")
        else:
            names.append(name)
            where = f"nodes[{i}] ({name!r})"
        if not isinstance(node.get("type"), str) or not node.get("type", "").strip():
            problems.append(f"{where} has no non-empty string 'type'")
        position = node.get("position")
        if (
            not isinstance(position, list)
            or len(position) != 2
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in position)
        ):
            problems.append(f"{where} 'position' is not a two-number array")
        if not isinstance(node.get("parameters"), dict):
            problems.append(f"{where} 'parameters' is missing or is not an object")

    duplicates = sorted({n for n in names if names.count(n) > 1})
    for dup in duplicates:
        problems.append(
            f"duplicate node name {dup!r} — n8n keys connections by node NAME, so "
            "a duplicate silently drops a branch on import"
        )

    known = set(names)
    for source, outputs in connections.items():
        if source not in known:
            problems.append(f"connections[{source!r}] names a node that does not exist in 'nodes'")
        if not isinstance(outputs, dict):
            problems.append(f"connections[{source!r}] is {type(outputs).__name__}, expected an object")
            continue
        for out_type, branches in outputs.items():
            if not isinstance(branches, list):
                problems.append(
                    f"connections[{source!r}][{out_type!r}] is "
                    f"{type(branches).__name__}, expected an array of branches"
                )
                continue
            for b, branch in enumerate(branches):
                if not isinstance(branch, list):
                    problems.append(
                        f"connections[{source!r}][{out_type!r}][{b}] is "
                        f"{type(branch).__name__}, expected an array of destinations"
                    )
                    continue
                for d, dest in enumerate(branch):
                    where = f"connections[{source!r}][{out_type!r}][{b}][{d}]"
                    if not isinstance(dest, dict):
                        problems.append(f"{where} is {type(dest).__name__}, expected an object")
                        continue
                    target = dest.get("node")
                    if not isinstance(target, str) or target not in known:
                        problems.append(f"{where} 'node' = {target!r} does not exist in 'nodes'")
                    if not isinstance(dest.get("type"), str):
                        problems.append(f"{where} has no string 'type'")
                    index = dest.get("index")
                    if not isinstance(index, int) or isinstance(index, bool):
                        problems.append(f"{where} has no integer 'index'")
    return problems


def validate(raw: str) -> list[str]:
    problems = check_unfenced(raw)
    if problems:
        return problems
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        return [f"payload is not valid JSON: {exc}"]
    return check_schema(doc)


VALID_WORKFLOW = {
    "name": "example",
    "nodes": [
        {
            "name": "Webhook",
            "type": "n8n-nodes-base.webhook",
            "position": [0, 0],
            "parameters": {"path": "example"},
        },
        {
            "name": "Set",
            "type": "n8n-nodes-base.set",
            "position": [220, 0],
            "parameters": {},
        },
    ],
    "connections": {
        "Webhook": {"main": [[{"node": "Set", "type": "main", "index": 0}]]}
    },
}


def self_test() -> int:
    """Prove the validator accepts a valid workflow and rejects every defect class."""
    good = json.dumps(VALID_WORKFLOW, indent=2)

    fenced = "```json\n" + good + "\n```"

    dup = json.loads(good)
    dup["nodes"][1]["name"] = "Webhook"

    dangling = json.loads(good)
    dangling["connections"]["Webhook"]["main"][0][0]["node"] = "Nonexistent"

    no_params = json.loads(good)
    del no_params["nodes"][0]["parameters"]

    bad_position = json.loads(good)
    bad_position["nodes"][0]["position"] = [0]

    cases: list[tuple[str, str, bool, str]] = [
        ("valid workflow", good, True, ""),
        ("fenced output", fenced, False, "FENCED"),
        ("trailing prose", good + "\n\nHope that helps!", False, "trailing prose"),
        ("not JSON", "{not json at all}", False, "not valid JSON"),
        ("top level array", "[]", False, "does not begin"),
        ("no nodes key", json.dumps({"connections": {}}), False, "'nodes' is missing"),
        ("empty nodes", json.dumps({"nodes": [], "connections": {}}), False, "empty array"),
        ("duplicate node name", json.dumps(dup), False, "duplicate node name"),
        ("dangling connection", json.dumps(dangling), False, "does not exist"),
        ("node without parameters", json.dumps(no_params), False, "'parameters' is missing"),
        ("malformed position", json.dumps(bad_position), False, "two-number array"),
    ]

    failures: list[str] = []
    for label, payload, want_ok, want_substring in cases:
        problems = validate(payload)
        ok = not problems
        if ok != want_ok:
            failures.append(
                f"{label}: expected {'PASS' if want_ok else 'FAIL'}, got "
                f"{'PASS' if ok else 'FAIL'} ({problems})"
            )
        elif not want_ok and not any(want_substring in p for p in problems):
            failures.append(
                f"{label}: failed for the wrong reason — expected a problem "
                f"mentioning {want_substring!r}, got {problems}"
            )
        else:
            verdict = "accepted" if ok else f"rejected — {problems[0][:78]}"
            print(f"  {'✓'} {label}: {verdict}")

    if failures:
        print("\nSELF-TEST FAILED")
        for f in failures:
            print(f"  ✗ {f}")
        return 1
    print(f"\nSELF-TEST PASSED ({len(cases)} cases: 1 accept, {len(cases) - 1} reject)")
    return 0


def main() -> int:
    args = [a for a in sys.argv[1:]]
    if "--self-test" in args:
        return self_test()
    if not args:
        print(
            "❌ CHECK COULD NOT RUN — no workflow given.\n"
            "   usage: validate-workflow-json.py <file.json> | - (stdin) | --self-test",
            file=sys.stderr,
        )
        return 2
    source = args[0]
    if source == "-":
        raw = sys.stdin.read()
        label = "<stdin>"
    else:
        path = pathlib.Path(source)
        if not path.is_file():
            print(f"❌ CHECK COULD NOT RUN — no such file: {source}", file=sys.stderr)
            return 2
        raw = path.read_text(encoding="utf-8")
        label = source

    problems = validate(raw)
    if problems:
        print(f"❌ {label}: NOT importable — {len(problems)} problem(s)")
        for problem in problems:
            print(f"  ✗ {problem}")
        return 1
    print(f"✅ {label}: parses, unfenced, schema-valid (static validation only — no live import attempted)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
