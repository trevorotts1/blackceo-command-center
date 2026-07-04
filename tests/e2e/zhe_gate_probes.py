#!/usr/bin/env python3
"""
zhe_gate_probes.py — the REAL-enforcer side of the P3-8 prove-zhe web e2e (Wave 5).

This helper is invoked by tests/e2e/prove-zhe-web.e2e.mjs. It exists so the e2e
proves the ZHE gates against the ACTUAL Skill-23 Python enforcers
(build-workforce.py, department-floor.py, list-canonical-departments.py,
prove-zhe.py) — never a re-implementation. Every subcommand loads the live
enforcer module from the resolved Skill-23 scripts dir and calls its real
functions, so a divergence between the web seam (TypeScript) and the build gate
(Python) surfaces here loudly.

SANDBOX CONTRACT: every subcommand that reads/writes interview state honors the
caller's HOME. The Node harness sets HOME to a throwaway temp dir BEFORE spawning
this helper, so build-workforce.py's /data-else-$HOME resolution lands inside the
sandbox. This file NEVER hardcodes ~/.openclaw or ~/.clawdbot.

Subcommands (all print a single-line JSON object on stdout):
  consent   <scripts_dir>
      Call build-workforce._enforce_consent_or_refuse({}) in the current HOME.
      -> {"refused": bool, "exit": int|null}  (exit 87 == INTERVIEW_PENDING)

  decline   <scripts_dir> <state_json>
      Call build-workforce._canonical_decline_set(<state>) on a state file.
      -> {"declined": [...], "rejectedWarning": bool}
      A bare/un-provenanced "no" returns [] AND emits [DECLINE REJECTED] (gate #8).

  floor-count <scripts_dir> <departments_dir>
      Run department-floor.evaluate_floor with an explicit (possibly empty)
      departments dir and NO declines -> the canonical expected floor.
      -> {"expectedFloorCount": int, "expectedFloor": [...]}

  build-zhe-fixture <oc_root> <src_build_state> [n_personas] [n_index_rows]
      Materialize a FULL Zero-Human-Everything oc-root fixture (personas +
      section-tagged index + Command Center board + registered dept agents +
      AGENTS.md doctrine) around a completed interview build-state, so
      prove-zhe.py --local returns overall_pass on the web-built company.
      -> {"ocRoot": ..., "depts": [...], "personas": int, "indexRows": int}
"""
import io
import json
import importlib.util
import os
import sqlite3
import sys
from contextlib import redirect_stderr


def _load_enforcer(scripts_dir, module_basename):
    """Import a Skill-23 enforcer module from its file path (hyphenated name)."""
    path = os.path.join(scripts_dir, module_basename)
    spec = importlib.util.spec_from_file_location(
        "zhe_enforcer_" + module_basename.replace("-", "_").replace(".py", ""), path
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def cmd_consent(scripts_dir):
    """Run the REAL owner-consent gate (build-workforce._enforce_consent_or_refuse).

    Returns refused=True + the exit code when the build would be refused. Exit 87
    (EXIT_INTERVIEW_PENDING) is the fabrication-guard's "no genuine transcript /
    no consent" refusal. This reads the genuine transcript + build-state from the
    caller's HOME, so a synthetic-header / thin transcript is correctly refused.
    """
    bw = _load_enforcer(scripts_dir, "build-workforce.py")
    buf = io.StringIO()
    try:
        with redirect_stderr(buf):
            bw._enforce_consent_or_refuse({})
        return {"refused": False, "exit": None}
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else 1
        return {"refused": True, "exit": code}


def cmd_decline(scripts_dir, state_json):
    """Run the REAL provenance-gated decline classifier on a state file.

    build-workforce._canonical_decline_set honors a "no" ONLY when it carries the
    full provenance object {decision,source,decidedAt,decidedBy}. A bare string
    "no" (or an object missing fields) is IGNORED and a [DECLINE REJECTED] warning
    is printed to stderr — the dept stays in the floor (fail-safe-to-larger).
    """
    bw = _load_enforcer(scripts_dir, "build-workforce.py")
    with open(state_json) as f:
        state = json.load(f)
    buf = io.StringIO()
    with redirect_stderr(buf):
        declined = bw._canonical_decline_set(state)
    stderr_text = buf.getvalue()
    return {
        "declined": sorted(declined),
        "rejectedWarning": "[DECLINE REJECTED]" in stderr_text,
    }


def cmd_floor_count(scripts_dir, departments_dir):
    """Canonical expected floor via the REAL department-floor.evaluate_floor.

    Called with an explicit departments dir and no declines, so expected_floor is
    the full canonical set (mandatory + universal-primary) — the number the web
    seam's computeExpectedDecisionIds must equal (version-safety / no hardcode).
    """
    df = _load_enforcer(scripts_dir, "department-floor.py")
    from pathlib import Path
    verdict = df.evaluate_floor(departments_dir=Path(departments_dir), build_state={})
    return {
        "expectedFloorCount": verdict["expected_floor_count"],
        "expectedFloor": verdict["expected_floor"],
    }


# --------------------------------------------------------------------------- #
# Full Zero-Human-Everything fixture builder (for prove-zhe --local overall_pass)
# --------------------------------------------------------------------------- #

_FIXTURE_DEPTS = ["marketing", "sales", "operations"]

_AGENTS_MD = """# AGENTS.md — Fixture Workforce Doctrine (P3-8 prove-zhe web e2e)

<!-- CEO_ORCHESTRATOR_RULE_V1 / CEO_ROUTING_NO_LOOPHOLES_V1 -->
The CEO orchestrator routes the task to the right department — always. It never
does the work itself; it delegates.

<!-- PERSONA_REFLEX_V1 -->
Persona reflex: every task first persona-matches to the department's governing
coach/leadership persona before any work begins.

<!-- FULL_CONTEXT_HANDOFF_V1 -->
Full-context handoff: hand off pointer references to where the documentation and
source live, never a lossy summary.

<!-- OWNER_REPORTING_V1 / REPORTING_RULES_V1 -->
Reporting to the owner: report back to the owner in plain language, unprompted,
after each stage.

<!-- PLATFORM_FACTS_V1 -->
Platform facts: here is WHERE your environments file and canonical state live on
this box, so every agent resolves the same paths.
"""


def cmd_build_zhe_fixture(oc_root, src_build_state, n_personas, n_index_rows):
    """Materialize a full ZHE oc-root so prove-zhe.py --local returns overall_pass.

    Builds the four wrappings prove-zhe asserts for an interview-completed box:
      (a) floor departments built-as-files AND registered as agents (dept-<slug>),
      (b) 54 canonical personas + persona-categories.json + a section-tagged
          gemini-index.sqlite (>= floor rows, mode + section_number columns),
      (c) a Command Center mission-control.db with a live `workspaces` board lane
          per department,
      (d) AGENTS.md carrying all five doctrine markers.
    The build-state is copied from the completed web-path interview (so
    interviewComplete=true drives prove-zhe past the EXEMPT branch).
    """
    depts = list(_FIXTURE_DEPTS)
    ws = os.path.join(oc_root, "workspace")
    os.makedirs(ws, exist_ok=True)

    # build-state (completed interview) — copied from the web-path sandbox.
    with open(src_build_state) as f:
        state = json.load(f)
    state["interviewComplete"] = True
    with open(os.path.join(ws, ".workforce-build-state.json"), "w") as f:
        json.dump(state, f, indent=2)

    # openclaw.json — register each dept as agent id "dept-<slug>".
    cfg = {
        "agents": {
            "defaults": {"workspace": ws},
            "list": [{"id": f"dept-{slug}", "name": slug.title()} for slug in depts],
        }
    }
    with open(os.path.join(oc_root, "openclaw.json"), "w") as f:
        json.dump(cfg, f, indent=2)

    # (a) department folders built-as-files.
    for slug in depts:
        os.makedirs(os.path.join(ws, "departments", slug), exist_ok=True)

    # (d) AGENTS.md doctrine.
    with open(os.path.join(ws, "AGENTS.md"), "w") as f:
        f.write(_AGENTS_MD)

    # (b) personas: 54 dirs + categories + section-tagged index.
    cp = os.path.join(ws, "data", "coaching-personas")
    personas_dir = os.path.join(cp, "personas")
    os.makedirs(personas_dir, exist_ok=True)
    for i in range(n_personas):
        os.makedirs(os.path.join(personas_dir, f"persona-{i:03d}"), exist_ok=True)
    categories = {
        "domainTags": ["leadership", "coaching", "operations", "sales", "marketing"],
        "personas": {f"persona-{i:03d}": {"domain": "leadership"} for i in range(n_personas)},
    }
    with open(os.path.join(cp, "persona-categories.json"), "w") as f:
        json.dump(categories, f)

    index_db = os.path.join(cp, "gemini-index.sqlite")
    conn = sqlite3.connect(index_db)
    cur = conn.cursor()
    cur.execute(
        "CREATE TABLE embeddings (id INTEGER PRIMARY KEY, chunk TEXT, "
        "mode TEXT DEFAULT 'both', section_number INTEGER)"
    )
    modes = ["leadership", "coaching", "both"]
    rows = []
    for i in range(n_index_rows):
        # Genuinely section-tagged: section_number NOT NULL (the true "tagging ran"
        # signal prove-zhe counts) and a real mode mix (leadership/coaching present).
        rows.append((i, f"chunk-{i}", modes[i % 3], (i % 8) + 1))
    cur.executemany(
        "INSERT INTO embeddings (id, chunk, mode, section_number) VALUES (?,?,?,?)", rows
    )
    conn.commit()
    conn.close()

    # (c) Command Center board with a lane per department.
    ccdb = os.path.join(ws, "mission-control.db")
    conn = sqlite3.connect(ccdb)
    cur = conn.cursor()
    cur.execute(
        "CREATE TABLE workspaces (id INTEGER PRIMARY KEY, slug TEXT, name TEXT, lane TEXT)"
    )
    cur.executemany(
        "INSERT INTO workspaces (id, slug, name, lane) VALUES (?,?,?,?)",
        [(i, slug, slug.title(), f"dept-{slug}") for i, slug in enumerate(depts)],
    )
    conn.commit()
    conn.close()

    return {
        "ocRoot": oc_root,
        "depts": depts,
        "personas": n_personas,
        "indexRows": n_index_rows,
    }


def main(argv):
    if not argv:
        print("usage: zhe_gate_probes.py <subcommand> ...", file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "consent":
        out = cmd_consent(rest[0])
    elif cmd == "decline":
        out = cmd_decline(rest[0], rest[1])
    elif cmd == "floor-count":
        out = cmd_floor_count(rest[0], rest[1])
    elif cmd == "build-zhe-fixture":
        n_personas = int(rest[2]) if len(rest) > 2 else 54
        n_index_rows = int(rest[3]) if len(rest) > 3 else 4413
        out = cmd_build_zhe_fixture(rest[0], rest[1], n_personas, n_index_rows)
    else:
        print(f"unknown subcommand: {cmd}", file=sys.stderr)
        return 2
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
