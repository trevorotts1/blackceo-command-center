#!/usr/bin/env python3
"""validate-workflow-json.py — T2-39 / A46 / U091.

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
import os
import pathlib
import sys
import urllib.error
import urllib.request

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


def check_importable_on_live(doc: dict, n8n_url: str, api_key: str | None = None,
                              _urlopen=None) -> list[str]:
    """Non-mutating import check: validate node types against a live n8n instance.
    Calls GET /rest/node-types (read-only). Never POSTs, PATCHes, or DELETEs."""
    if _urlopen is None:
        _urlopen = urllib.request.urlopen
    problems: list[str] = []
    base = n8n_url.rstrip("/")
    headers: dict[str, str] = {"Accept": "application/json"}
    if api_key:
        headers["X-N8N-API-KEY"] = api_key
    probe_url = f"{base}/rest/workflows?limit=1"
    try:
        req = urllib.request.Request(probe_url, headers=headers)
        with _urlopen(req, timeout=15) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        s = ""
        try:
            s = exc.read().decode("utf-8", errors="replace")[:200]
        except OSError:
            pass
        problems.append(f"n8n returned HTTP {exc.code} on probe ({probe_url}): {s}")
        return problems
    except urllib.error.URLError as exc:
        problems.append(f"cannot reach n8n ({probe_url}): {exc.reason}")
        return problems
    except OSError as exc:
        problems.append(f"network error contacting n8n ({probe_url}): {exc}")
        return problems
    node_types_url = f"{base}/rest/node-types"
    try:
        req = urllib.request.Request(node_types_url, headers=headers)
        with _urlopen(req, timeout=15) as resp:
            node_types_data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        s = ""
        try:
            s = exc.read().decode("utf-8", errors="replace")[:200]
        except OSError:
            pass
        problems.append(f"n8n node-types HTTP {exc.code} ({node_types_url}): {s}")
        return problems
    except urllib.error.URLError as exc:
        problems.append(f"cannot reach node-types ({node_types_url}): {exc.reason}")
        return problems
    except OSError as exc:
        problems.append(f"network error fetching node-types ({node_types_url}): {exc}")
        return problems
    installed: set[str] = set()
    if isinstance(node_types_data, dict) and isinstance(node_types_data.get("data"), list):
        for nt in node_types_data["data"]:
            if isinstance(nt, dict) and isinstance(nt.get("name"), str):
                installed.add(nt["name"])
    elif isinstance(node_types_data, list):
        for nt in node_types_data:
            if isinstance(nt, dict) and isinstance(nt.get("name"), str):
                installed.add(nt["name"])
    if not installed:
        problems.append("n8n returned empty/unrecognized node-types payload")
        return problems
    for i, node in enumerate(doc.get("nodes", [])):
        if not isinstance(node, dict):
            continue
        node_type = node.get("type", "")
        if not isinstance(node_type, str) or not node_type.strip():
            continue
        if node_type not in installed:
            name = node.get("name", f"nodes[{i}]")
            problems.append(
                f"nodes[{i}] ({name!r}) type={node_type!r} is NOT installed "
                f"on {n8n_url}. Known types: {len(installed)} installed."
            )
    return problems


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

    # Import check tests (mock HTTP)
    failures.extend(_self_test_import_check())

    if failures:
        print("\nSELF-TEST FAILED")
        for f in failures:
            print(f"  ✗ {f}")
        return 1
    print(f"\nSELF-TEST PASSED ({len(cases)} cases: 1 accept, {len(cases) - 1} reject)")
    return 0


def _self_test_import_check() -> list[str]:
    """Self-test for check_importable_on_live using mock HTTP responses."""
    from contextlib import contextmanager
    from io import BytesIO
    failures: list[str] = []
    installed_node_types = {
        "data": [
            {"name": "n8n-nodes-base.webhook"},
            {"name": "n8n-nodes-base.set"},
            {"name": "n8n-nodes-base.httpRequest"},
        ]
    }

    @contextmanager
    def _mock_urlopen(request, timeout=15):
        url = request.full_url if hasattr(request, "full_url") else request.get_full_url()
        body = BytesIO()
        if "/rest/workflows" in url:
            body.write(b"{}")
        elif "/rest/node-types" in url:
            body.write(json.dumps(installed_node_types).encode("utf-8"))
        body.seek(0)
        yield body

    problems = check_importable_on_live(VALID_WORKFLOW, "https://localhost:5678", _urlopen=_mock_urlopen)
    if problems:
        failures.append("import check (all types installed): expected PASS, got " + str(problems))
    else:
        print("  OK import check (all types installed): passed")

    bad_workflow = json.loads(json.dumps(VALID_WORKFLOW))
    bad_workflow["nodes"].append({"name": "Unknown Node", "type": "n8n-nodes-base.nonexistent", "position": [400, 0], "parameters": {}})
    problems = check_importable_on_live(bad_workflow, "https://localhost:5678", _urlopen=_mock_urlopen)
    if not problems:
        failures.append("import check (unknown node type): expected FAIL, got PASS")
    elif "NOT installed" not in str(problems[0]):
        failures.append(f"import check (unknown node type): wrong reason, got {problems}")
    else:
        print("  OK import check (unknown node type): rejected correctly")

    @contextmanager
    def _mock_http_error(request, timeout=15):
        url = request.full_url if hasattr(request, "full_url") else request.get_full_url()
        if "/rest/workflows" in url:
            raise urllib.error.HTTPError(url, 502, "Bad Gateway", {}, BytesIO(b"upstream error"))
        body = BytesIO()
        body.seek(0)
        yield body

    problems = check_importable_on_live(VALID_WORKFLOW, "https://localhost:5678", _urlopen=_mock_http_error)
    if not problems:
        failures.append("import check (HTTP error): expected FAIL, got PASS")
    elif "HTTP 502" not in str(problems[0]):
        failures.append(f"import check (HTTP error): wrong reason, got {problems}")
    else:
        print("  OK import check (HTTP 502 on probe): rejected correctly")

    @contextmanager
    def _mock_unreachable(request, timeout=15):
        url = request.full_url if hasattr(request, "full_url") else request.get_full_url()
        raise urllib.error.URLError("connection refused")

    problems = check_importable_on_live(VALID_WORKFLOW, "https://localhost:9999", _urlopen=_mock_unreachable)
    if not problems:
        failures.append("import check (URLError): expected FAIL, got PASS")
    elif "cannot reach" not in str(problems[0]):
        failures.append(f"import check (URLError): wrong reason, got {problems}")
    else:
        print("  OK import check (unreachable endpoint): rejected correctly")

    api_key_observed: list[str] = []

    @contextmanager
    def _mock_capture_headers(request, timeout=15):
        hi = {k.lower(): v for k, v in request.header_items()}
        api_key_observed.append(hi.get("x-n8n-api-key", ""))
        body = BytesIO()
        url = request.full_url if hasattr(request, "full_url") else request.get_full_url()
        if "/rest/workflows" in url:
            body.write(b"{}")
        elif "/rest/node-types" in url:
            body.write(json.dumps(installed_node_types).encode("utf-8"))
        body.seek(0)
        yield body

    check_importable_on_live(VALID_WORKFLOW, "https://localhost:5678", api_key="n8n_api_test123", _urlopen=_mock_capture_headers)
    if not any("test123" in val for val in api_key_observed):
        failures.append(f"import check (api key): header not sent, got {api_key_observed}")
    else:
        print("  OK import check (api key): header sent correctly")

    return failures


def _parse_args(argv: list[str]) -> tuple[str | None, str | None, list[str]]:
    n8n_url: str | None = None
    api_key: str | None = os.environ.get("N8N_API_KEY", "").strip() or None
    positional: list[str] = []
    i = 0
    while i < len(argv):
        if argv[i] == "--n8n-url" and i + 1 < len(argv):
            i += 1
            n8n_url = argv[i]
        elif argv[i] == "--n8n-api-key" and i + 1 < len(argv):
            i += 1
            api_key = argv[i]
        elif argv[i] == "--self-test":
            positional.append(argv[i])
        elif argv[i].startswith("--"):
            i += 1
            continue
        else:
            positional.append(argv[i])
        i += 1
    if n8n_url is None:
        env_host = os.environ.get("N8N_HOST", "").strip()
        if env_host:
            n8n_url = env_host
    return n8n_url, api_key, positional


def main() -> int:
    n8n_url, api_key, positional = _parse_args(sys.argv[1:])
    if "--self-test" in positional:
        return self_test()
    if not positional:
        print(
            "CHECK COULD NOT RUN -- no workflow given.\n"
            "   usage: validate-workflow-json.py <file.json> | - (stdin)"
            " | --self-test [--n8n-url URL]",
            file=sys.stderr,
        )
        return 2
    source = positional[0]
    if source == "-":
        raw = sys.stdin.read()
        label = "<stdin>"
    else:
        path_ = pathlib.Path(source)
        if not path_.is_file():
            print(f"CHECK COULD NOT RUN -- no such file: {source}", file=sys.stderr)
            return 2
        raw = path_.read_text(encoding="utf-8")
        label = source
    problems = validate(raw)
    if problems:
        print(f"FAIL {label}: NOT importable -- {len(problems)} problem(s)")
        for problem in problems:
            print(f"  X {problem}")
        return 1
    if n8n_url:
        print(f"\nRunning non-mutating import check against {n8n_url} ...")
        doc = json.loads(raw)
        live_problems = check_importable_on_live(doc, n8n_url, api_key=api_key)
        if live_problems:
            print(f"\nWARN {label}: static checks PASSED, but live import check found "
                  f"{len(live_problems)} issue(s) against {n8n_url}")
            for problem in live_problems:
                print(f"  X {problem}")
            return 1
        print(f"OK {label}: live import check passed on {n8n_url}")
    extra = f", live import check passed against {n8n_url}" if n8n_url else " (static validation only)"
    print(f"OK {label}: parses, unfenced, schema-valid{extra}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
