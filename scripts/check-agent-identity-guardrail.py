#!/usr/bin/env python3
"""check-agent-identity-guardrail.py — T1-09 / A44.

WHY THIS EXISTS
---------------
`src/lib/persona-dispatch.ts` injects `STYLE_INSPIRED_GUARDRAIL` into every
voice-blend directive and re-injects it at the render layer: a persona is a
CRAFT LENS, never an identity to assume. Twenty-two agent `IDENTITY.md` files
carried the exact opposite instruction ("Act AS IF you ARE the persona ...") and
the generator reproduced it for every new agent, so the instruction sitting
closest to the agent contradicted the platform's advertised safety guarantee on
client-facing authorship.

WHAT IT ENFORCES
----------------
1. No agent `IDENTITY.md` carries a persona-ASSUMPTION directive.
2. Every agent `IDENTITY.md` positively CARRIES the guardrail — detected by the
   same two load-bearing markers `ensureBlendGuardrail()` uses
   ("style-inspired" + "impersonation"). Absence of the bad phrase is not
   enough; the good rule must be present.
3. The generator (`scripts/migrate-agents-to-zhc.py`) reproduces the guardrail
   in BOTH persona-governance templates, so new agents inherit the correct rule.
4. `src/lib/persona-dispatch.ts` still exports `STYLE_INSPIRED_GUARDRAIL` and it
   still carries both markers — if the dispatch-layer guarantee is renamed or
   gutted, this check reports it rather than silently continuing to pass.
5. U060: no agent `SOUL.md` still carries the unresolved generator-template
   placeholders ("Define this agent's personality..." / "What this agent should
   and should not do."). That template text is the agent's active personality
   and safety boundary, so an agent carrying it has neither and must not be
   activated.

FAIL-VISIBLY CONTRACT
---------------------
Exit 0  → every check RAN and PASSED.
Exit 1  → a check ran and FAILED (violations listed).
Exit 2  → a check COULD NOT RUN (missing file / unparseable input). This is
          never treated as a pass.

USAGE
-----
  scripts/check-agent-identity-guardrail.py            # scan the repo
  scripts/check-agent-identity-guardrail.py --self-test  # prove both directions
"""
from __future__ import annotations

import ast
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent

# Persona-ASSUMPTION directives. Matched against a whitespace-normalised,
# lower-cased rendering of the file so a re-wrap cannot smuggle one back in.
BANNED_DIRECTIVES = (
    "act as if you are the persona",
    "act as that persona",
    "act as the persona",
    "embody it for the task",
    "embody the persona",
    "you are the persona for the duration",
    "pretend to be the persona",
)

# The two load-bearing markers `ensureBlendGuardrail()` detects in
# src/lib/persona-dispatch.ts. Kept identical on purpose.
REQUIRED_MARKERS = ("style-inspired", "impersonation")

# U060: unresolved generator-template placeholders. The agent generator ships
# SOUL.md whose ## Personality / ## Boundaries sections still hold the literal
# fill-in prompts below. That template text IS the agent's active personality
# and safety boundary, so an agent carrying it has NO real personality and NO
# real guardrails. No agent may be activated while its SOUL.md still matches the
# template. Matched against the raw file text (the placeholders are exact).
UNRESOLVED_SOUL_PLACEHOLDERS = (
    "Define this agent's personality, communication style, and values here.",
    "What this agent should and should not do.",
)

DISPATCH_REL = "src/lib/persona-dispatch.ts"
GENERATOR_REL = "scripts/migrate-agents-to-zhc.py"
GENERATOR_TEMPLATE_NAMES = ("STANDARD_DEFERRAL", "CEO_DEFERRAL")


def normalise(text: str) -> str:
    """Lower-case and collapse every whitespace run to one space."""
    return re.sub(r"\s+", " ", text).strip().lower()


def scan_text(label: str, text: str) -> list[str]:
    """Return the list of problems in one blob of prose."""
    problems: list[str] = []
    flat = normalise(text)
    for banned in BANNED_DIRECTIVES:
        if banned in flat:
            problems.append(f"{label}: carries persona-ASSUMPTION directive {banned!r}")
    missing = [m for m in REQUIRED_MARKERS if m not in flat]
    if missing:
        problems.append(
            f"{label}: missing style-inspired guardrail marker(s) "
            f"{', '.join(repr(m) for m in missing)}"
        )
    return problems


def scan_soul(label: str, text: str) -> list[str]:
    """U060: return problems for one SOUL.md — any unresolved generator-template
    placeholder means the agent has no real personality/boundaries and must not
    be activated."""
    problems: list[str] = []
    for placeholder in UNRESOLVED_SOUL_PLACEHOLDERS:
        if placeholder in text:
            problems.append(
                f"{label}: SOUL.md still carries the unresolved generator template "
                f"{placeholder!r} — agent has no real personality/boundaries"
            )
    return problems


def read_generator_templates(root: pathlib.Path) -> tuple[dict[str, str], list[str]]:
    """Pull the persona-governance template constants out of the generator by AST.

    Returns (templates, blockers). A non-empty `blockers` means the check COULD
    NOT RUN and the caller must exit 2.
    """
    path = root / GENERATOR_REL
    if not path.is_file():
        return {}, [f"CANNOT RUN: generator not found at {GENERATOR_REL}"]
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except SyntaxError as exc:  # pragma: no cover - defensive
        return {}, [f"CANNOT RUN: {GENERATOR_REL} does not parse ({exc})"]

    found: dict[str, str] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id in GENERATOR_TEMPLATE_NAMES:
                if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                    found[target.id] = node.value.value

    blockers = [
        f"CANNOT RUN: {GENERATOR_REL} no longer defines a string constant {name}"
        for name in GENERATOR_TEMPLATE_NAMES
        if name not in found
    ]
    return found, blockers


def read_dispatch_guardrail(root: pathlib.Path) -> tuple[str, list[str]]:
    """Extract the exported STYLE_INSPIRED_GUARDRAIL literal from the dispatch layer."""
    path = root / DISPATCH_REL
    if not path.is_file():
        return "", [f"CANNOT RUN: dispatch layer not found at {DISPATCH_REL}"]
    src = path.read_text(encoding="utf-8")
    match = re.search(
        r"export\s+const\s+STYLE_INSPIRED_GUARDRAIL\s*=(.*?);", src, re.DOTALL
    )
    if not match:
        return "", [
            f"CANNOT RUN: {DISPATCH_REL} no longer exports STYLE_INSPIRED_GUARDRAIL "
            "— the guardrail this check is anchored to has moved or been removed"
        ]
    return match.group(1), []


def run_scan(root: pathlib.Path) -> tuple[int, list[str], list[str]]:
    """Scan one repository tree. Returns (exit_code, problems, notes)."""
    problems: list[str] = []
    blockers: list[str] = []
    notes: list[str] = []

    identity_files = sorted((root / "agents").glob("*/IDENTITY.md"))
    if not identity_files:
        blockers.append("CANNOT RUN: no agents/*/IDENTITY.md files found")
    notes.append(f"agent identity files scanned: {len(identity_files)}")

    for path in identity_files:
        rel = path.relative_to(root)
        problems.extend(scan_text(str(rel), path.read_text(encoding="utf-8")))

    # U060: no agent may carry an unresolved SOUL.md generator template.
    soul_files = sorted((root / "agents").glob("*/SOUL.md"))
    notes.append(f"agent soul files scanned: {len(soul_files)}")
    for path in soul_files:
        rel = path.relative_to(root)
        problems.extend(scan_soul(str(rel), path.read_text(encoding="utf-8")))

    templates, gen_blockers = read_generator_templates(root)
    blockers.extend(gen_blockers)
    for name, body in sorted(templates.items()):
        problems.extend(scan_text(f"{GENERATOR_REL}:{name}", body))
    notes.append(f"generator templates scanned: {len(templates)}")

    guardrail, dispatch_blockers = read_dispatch_guardrail(root)
    blockers.extend(dispatch_blockers)
    if guardrail:
        flat = normalise(guardrail)
        missing = [m for m in REQUIRED_MARKERS if m not in flat]
        if missing:
            problems.append(
                f"{DISPATCH_REL}: STYLE_INSPIRED_GUARDRAIL no longer carries "
                f"marker(s) {', '.join(repr(m) for m in missing)}"
            )
        notes.append("dispatch-layer guardrail: present")

    if blockers:
        return 2, blockers + problems, notes
    if problems:
        return 1, problems, notes
    return 0, [], notes


def self_test() -> int:
    """Prove the check fails on a reintroduced directive and passes on a clean tree."""
    script = pathlib.Path(__file__).resolve()
    failures: list[str] = []

    with tempfile.TemporaryDirectory() as tmp:
        clean = pathlib.Path(tmp) / "clean"
        shutil.copytree(REPO_ROOT / "agents", clean / "agents")
        (clean / "scripts").mkdir()
        shutil.copy2(REPO_ROOT / GENERATOR_REL, clean / GENERATOR_REL)
        (clean / "src" / "lib").mkdir(parents=True)
        shutil.copy2(REPO_ROOT / DISPATCH_REL, clean / DISPATCH_REL)

        code, problems, _ = run_scan(clean)
        if code != 0:
            failures.append(
                "DIRECTION 1 (clean tree must PASS) failed with exit "
                f"{code}: {problems}"
            )
        else:
            print("  ✓ direction 1 — clean tree passes (exit 0)")

        # Mutation: reintroduce the directive into exactly one identity file.
        victim = sorted((clean / "agents").glob("*/IDENTITY.md"))[0]
        victim.write_text(
            victim.read_text(encoding="utf-8")
            + "\nAct AS IF you ARE the persona for the duration of the task.\n",
            encoding="utf-8",
        )
        code, problems, _ = run_scan(clean)
        if code != 1:
            failures.append(
                f"DIRECTION 2 (reintroduced directive must FAIL) got exit {code}, "
                f"expected 1. problems={problems}"
            )
        elif not any("persona-ASSUMPTION directive" in p for p in problems):
            failures.append(
                f"DIRECTION 2 failed for the wrong reason: {problems}"
            )
        else:
            print(f"  ✓ direction 2 — reintroduced directive fails (exit 1): {problems[0]}")

        # Mutation: strip the guardrail from the generator template.
        gen = clean / GENERATOR_REL
        gen.write_text(
            gen.read_text(encoding="utf-8").replace(
                "STYLE-INSPIRED ONLY — NEVER IMPERSONATION", "Be inspired"
            ),
            encoding="utf-8",
        )
        code, problems, _ = run_scan(clean)
        if code != 1 or not any(GENERATOR_REL in p for p in problems):
            failures.append(
                f"DIRECTION 3 (generator without guardrail must FAIL) got exit "
                f"{code}, problems={problems}"
            )
        else:
            print("  ✓ direction 3 — generator without the guardrail fails (exit 1)")

        # Mutation: remove the dispatch-layer anchor → CANNOT RUN, never a pass.
        shutil.copy2(REPO_ROOT / GENERATOR_REL, gen)
        victim.write_text(
            victim.read_text(encoding="utf-8").replace(
                "\nAct AS IF you ARE the persona for the duration of the task.\n", ""
            ),
            encoding="utf-8",
        )
        (clean / DISPATCH_REL).unlink()
        code, problems, _ = run_scan(clean)
        if code != 2:
            failures.append(
                f"DIRECTION 4 (missing dispatch anchor must report CANNOT RUN) got "
                f"exit {code}, expected 2. problems={problems}"
            )
        else:
            print("  ✓ direction 4 — missing dispatch anchor reports CANNOT RUN (exit 2)")

        # U060 DIRECTION 5: reintroduce an unresolved SOUL.md template → FAIL.
        shutil.copy2(REPO_ROOT / DISPATCH_REL, clean / DISPATCH_REL)
        soul_victim = sorted((clean / "agents").glob("*/SOUL.md"))[0]
        soul_victim.write_text(
            "# Agent\n\n## Personality\n"
            "Define this agent's personality, communication style, and values here.\n\n"
            "## Boundaries\nWhat this agent should and should not do.\n",
            encoding="utf-8",
        )
        code, problems, _ = run_scan(clean)
        if code != 1 or not any("unresolved generator template" in p for p in problems):
            failures.append(
                f"DIRECTION 5 (unresolved SOUL.md template must FAIL) got exit {code}, "
                f"problems={problems}"
            )
        else:
            print(f"  ✓ direction 5 — unresolved SOUL.md template fails (exit 1): {problems[0]}")

    # The script must also be invocable end-to-end against the real repo.
    proc = subprocess.run([sys.executable, str(script)], capture_output=True, text=True)
    if proc.returncode != 0:
        failures.append(
            f"DIRECTION 6 (real repo must PASS) exit {proc.returncode}:\n{proc.stdout}{proc.stderr}"
        )
    else:
        print("  ✓ direction 6 — the real repository passes (exit 0)")

    if failures:
        print("\nSELF-TEST FAILED")
        for f in failures:
            print(f"  ✗ {f}")
        return 1
    print("\nSELF-TEST PASSED (6 directions)")
    return 0


def main() -> int:
    if "--self-test" in sys.argv[1:]:
        return self_test()

    code, problems, notes = run_scan(REPO_ROOT)
    print("agent identity guardrail check (T1-09 / A44)")
    for note in notes:
        print(f"  · {note}")
    if code == 0:
        print("✅ every agent identity file and both generator templates carry the")
        print("   style-inspired-only guardrail; none carries a persona-assumption directive")
        return 0
    header = (
        "❌ CHECK COULD NOT RUN — reporting as a failure, never as a pass"
        if code == 2
        else "❌ persona-assumption directive present / guardrail missing"
    )
    print(header)
    for problem in problems:
        print(f"  ✗ {problem}")
    return code


if __name__ == "__main__":
    sys.exit(main())
