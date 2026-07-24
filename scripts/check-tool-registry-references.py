#!/usr/bin/env python3
"""check-tool-registry-references.py — U094.

WHY THIS EXISTS
---------------
`agents/_shared/TOOLS.md` (the company-wide tool registry, symlinked into every
agent) told agents their per-agent tool-usage rules "live in each agent's
`how-to.md`" and were "listed under each agent's `how-to.md`". But NO per-agent
`how-to.md` exists in any of the 23 agent directories — each agent's `TOOLS.md`
is a symlink back to this same shared registry, and the file-synchronization map
(src/lib/agent-files.ts) has no `how-to.md` field. So the registry pointed every
agent at a policy file that exists for none of them: a dangling reference on the
one document that defines what tools an agent may use.

WHAT IT ENFORCES
----------------
The shared tool registry must not DIRECT agents to a per-agent policy file that
does not exist. Concretely: any positive assertion that per-agent tool rules
"live in" / are "listed under" a named per-agent file (e.g. `how-to.md`) is
checked against the agent directories — if that file exists for no agent, the
check fails. A negation ("there is no separate per-agent `how-to.md`") is fine
and is NOT flagged.

FAIL-VISIBLY CONTRACT
---------------------
Exit 0  → scan RAN and found NO dangling per-agent policy-file reference.
Exit 1  → scan ran and FOUND a reference to a per-agent file that exists for no
          agent (listed).
Exit 2  → scan COULD NOT RUN (shared TOOLS.md or agents/ missing). Never a pass.

USAGE
-----
  scripts/check-tool-registry-references.py             # scan the shared registry
  scripts/check-tool-registry-references.py --self-test  # prove both directions
"""
from __future__ import annotations

import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SHARED_TOOLS = REPO_ROOT / "agents" / "_shared" / "TOOLS.md"
AGENTS_DIR = REPO_ROOT / "agents"

# Positive assertions that per-agent tool rules live in / are listed under a
# named per-agent file. The captured group is the backticked filename. These are
# the shapes that dangle when the named file exists for no agent. A negation
# ("there is no separate per-agent `how-to.md`") does NOT match any of these.
PER_AGENT_CLAIM_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"live in each agent'?s?\s+`([^`]+)`", re.IGNORECASE),
    re.compile(r"listed under each agent'?s?\s+`([^`]+)`", re.IGNORECASE),
    re.compile(r"under each agent'?s?\s+`([^`]+)`", re.IGNORECASE),
    re.compile(r"in each agent'?s?\s+`([^`]+)`\s+Section", re.IGNORECASE),
)


def per_agent_file_exists(filename: str) -> bool:
    """True if `filename` exists in at least one agent directory (agents/*/)."""
    if not AGENTS_DIR.is_dir():
        return False
    return any((agent_dir / filename).exists() for agent_dir in AGENTS_DIR.iterdir()
               if agent_dir.is_dir() and agent_dir.name != "_shared")


def scan_shared_tools(path: pathlib.Path) -> tuple[list[str], list[str]]:
    """Return (problems, blockers) for the shared tool registry."""
    if not path.is_file():
        return [], [f"CANNOT RUN: shared tool registry not found at {path}"]
    if not AGENTS_DIR.is_dir():
        return [], [f"CANNOT RUN: agents directory not found at {AGENTS_DIR}"]

    problems: list[str] = []
    text = path.read_text(encoding="utf-8")
    for lineno, line in enumerate(text.splitlines(), start=1):
        for pattern in PER_AGENT_CLAIM_PATTERNS:
            for m in pattern.finditer(line):
                filename = m.group(1).strip()
                if not per_agent_file_exists(filename):
                    problems.append(
                        f"{path}:{lineno}: registry directs agents to per-agent "
                        f"`{filename}`, but that file exists for no agent -> "
                        f"{line.strip()[:90]}"
                    )
    return problems, []


def run_scan(root: pathlib.Path) -> tuple[int, list[str], list[str]]:
    """Scan the shared registry. Returns (exit_code, problems, notes)."""
    global SHARED_TOOLS, AGENTS_DIR
    shared = root / "agents" / "_shared" / "TOOLS.md"
    agents = root / "agents"
    # Point the module-level helpers at the scan root (for self-test temp trees).
    SHARED_TOOLS, AGENTS_DIR = shared, agents

    notes = [f"shared registry: {shared}"]
    problems, blockers = scan_shared_tools(shared)
    if blockers:
        return 2, blockers + problems, notes
    if problems:
        return 1, problems, notes
    return 0, [], notes


def self_test() -> int:
    """Prove the guard fails on a reintroduced dangling reference and passes on
    the clean tree (mutation proof)."""
    script = pathlib.Path(__file__).resolve()
    failures: list[str] = []

    with tempfile.TemporaryDirectory() as tmp:
        clean = pathlib.Path(tmp)
        # Copy the shared registry + a minimal agents tree (no how-to.md anywhere).
        (clean / "agents" / "_shared").mkdir(parents=True)
        shutil.copy2(REPO_ROOT / "agents" / "_shared" / "TOOLS.md",
                     clean / "agents" / "_shared" / "TOOLS.md")
        for agent in ("agent-a", "agent-b"):
            (clean / "agents" / agent).mkdir(parents=True)
            (clean / "agents" / agent / "IDENTITY.md").write_text("# id\n", encoding="utf-8")
            (clean / "agents" / agent / "SOUL.md").write_text("# soul\n", encoding="utf-8")

        code, problems, _ = run_scan(clean)
        if code != 0:
            failures.append(
                f"DIRECTION 1 (clean tree must PASS) got exit {code}: {problems[:3]}"
            )
        else:
            print("  ✓ direction 1 — clean registry passes (exit 0)")

        # Mutation: reintroduce the dangling per-agent how-to.md claim.
        victim = clean / "agents" / "_shared" / "TOOLS.md"
        victim.write_text(
            victim.read_text(encoding="utf-8")
            + "\nPer-agent tool usage rules live in each agent's `how-to.md`.\n",
            encoding="utf-8",
        )
        code, problems, _ = run_scan(clean)
        if code != 1 or not any("how-to.md" in p for p in problems):
            failures.append(
                f"DIRECTION 2 (reintroduced dangling reference must FAIL) got exit "
                f"{code}, problems={problems[:3]}"
            )
        else:
            print(f"  ✓ direction 2 — reintroduced dangling reference fails (exit 1): {problems[0]}")

    # The script must also pass end-to-end against the real repo.
    proc = subprocess.run([sys.executable, str(script)], capture_output=True, text=True)
    if proc.returncode != 0:
        failures.append(
            f"DIRECTION 3 (real repo must PASS) exit {proc.returncode}:\n{proc.stdout}{proc.stderr}"
        )
    else:
        print("  ✓ direction 3 — the real repository passes (exit 0)")

    if failures:
        print("\nSELF-TEST FAILED")
        for f in failures:
            print(f"  ✗ {f}")
        return 1
    print("\nSELF-TEST PASSED (3 directions)")
    return 0


def main() -> int:
    if "--self-test" in sys.argv[1:]:
        return self_test()

    code, problems, notes = run_scan(REPO_ROOT)
    print("tool-registry reference guard (U094)")
    for note in notes:
        print(f"  · {note}")
    if code == 0:
        print("✅ the shared tool registry directs agents only to files that exist")
        print("   (no dangling per-agent policy-file reference)")
        return 0
    header = (
        "❌ GUARD COULD NOT RUN — reporting as a failure, never as a pass"
        if code == 2
        else "❌ shared registry references a per-agent policy file that exists for no agent"
    )
    print(header)
    for problem in problems:
        print(f"  ✗ {problem}")
    return code


if __name__ == "__main__":
    sys.exit(main())
