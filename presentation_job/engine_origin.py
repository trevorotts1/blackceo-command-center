"""presentation_job/engine_origin.py — PRES-039 engine provenance + compatibility preflight.

Single home for three facts every run and diagnostic must agree on:

  1. WHERE this copy came from (distributor, source path, copy role).
  2. WHICH content this copy is (content digest over the package's .py/.json,
     plus the distributor commit when the distributor repo is available).
  3. WHETHER this copy may dispatch (compatibility preflight against the
     CC API contract + stale-duplicate detection on the import path).

Authoritative distributable engine: ONB
  23-ai-workforce-blueprint/templates/role-library/presentations/scripts/presentation_job/
Full cutover owner after extraction acceptance: the PRES package (PRES-049/WF16).
Until that cutover this CC-root copy is a vendored non-authoritative
duplicate: never edit it independently, never delete it until every caller
and installer is migrated and rollback is tested.

Design notes:

* The digest covers file BYTES (sorted names + lengths + sha256), not git
  SHAs: it works identically from a repo root, an installed Mac workspace,
  a Docker workdir, or a bare copy on PYTHONPATH — none of which is
  guaranteed to be a git checkout.
* The preflight FAILS (non-zero, machine-readable reason) on:
    - a stale duplicate shadowing this package earlier on sys.path
      (AF-ENGINE-STALE-DUPLICATE);
    - a schema/contract drift vs the CC API surface this engine must satisfy
      (AF-ENGINE-CONTRACT-DRIFT).
  It never warns-and-continues: silently importing a stale copy is the exact
  failure PRES-039 exists to close.
* Diagnostics (`--diagnose-only`, `diagnose.describe_park`, launcher refusal
  paths) print the recorded origin so a run always states which engine it is.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import (
    ENGINE_COPY_ROLE,
    ENGINE_CUTOVER_OWNER,
    ENGINE_CUTOVER_TASK,
    ENGINE_DEDUP_TASK,
    ENGINE_DISTRIBUTOR,
    ENGINE_SOURCE_PATH,
)

# CC API contract surface this engine must satisfy. Each entry is a
# (module, symbol, expectation) triple checked WITHOUT importing heavy
# modules (AST for .py members, JSON shape for data files):
#   - state.STATE_SCHEMA_VERSION == 1 (state.json readers/writers agree)
#   - phases Engine honors manifest pins (no silent fallback)
#   - launcher dispatch refusal family intact (-4..-7 sentinels)
#   - board posts carry metadata.phase_id (CC phaseIdOf reads ONLY that key)
#   - TS contract key PHASE_ACTIVITY_METADATA_KEY == 'phase_id'
ENGINE_CONTRACT_VERSION = 1
EXPECTED_STATE_SCHEMA_VERSION = 1
EXPECTED_METADATA_KEY = "phase_id"

# Structured-compat floor: the CC copy predates modules the canonical ONB
# engine grew (governor/fanout/lease/env_store/supervisor/autospawn/...
# — 17 files). Dispatch compatibility is judged against the CC API
# contract above, NOT against ONB module-set parity: the missing 17 are a
# recorded capability gap (pending WF16 vendoring), not a dispatch refusal.
# Refusing every run until parity would be its own outage.
KNOWN_MISSING_VS_CANONICAL = [
    "approvals.py",
    "auto_resume.py",
    "autospawn.py",
    "citation_validator.py",
    "defers.py",
    "deliverable_floors.py",
    "deliverable_paths.py",
    "env_store.py",
    "fanout.py",
    "governor.py",
    "launch_plan.py",
    "lease.py",
    "oc_paths.py",
    "scan_roots.py",
    "scanners.py",
    "supervisor.py",
    "wave_contract.py",
]

AF_STALE_DUPLICATE = "AF-ENGINE-STALE-DUPLICATE"
AF_CONTRACT_DRIFT = "AF-ENGINE-CONTRACT-DRIFT"

PACKAGE_DIR = Path(__file__).resolve().parent


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def package_digest(package_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Content digest of the engine package: sorted name/len/sha256 per file.

    Covers *.py + *.json directly inside the package dir (no recursion: the
    package is flat). Deterministic across hosts: same bytes -> same digest.
    """
    root = Path(package_dir) if package_dir else PACKAGE_DIR
    files: List[Dict[str, Any]] = []
    for name in sorted(os.listdir(root)):
        if not (name.endswith(".py") or name.endswith(".json")):
            continue
        p = root / name
        if not p.is_file():
            continue
        files.append({
            "name": name,
            "bytes": p.stat().st_size,
            "sha256": _sha256_file(p),
        })
    canon = json.dumps(files, sort_keys=True, separators=(",", ":"))
    return {
        "files": files,
        "file_count": len(files),
        "digest": hashlib.sha256(canon.encode("utf-8")).hexdigest(),
    }


def distributor_commit(package_dir: Optional[Path] = None) -> Optional[Dict[str, str]]:
    """Best-effort distributor commit identity (None when unavailable).

    Never fatal: installed workspaces / Docker workdirs / bare copies are
    not git checkouts. Returns {repo, commit} only on a clean `git` answer.
    """
    root = Path(package_dir) if package_dir else PACKAGE_DIR
    try:
        r = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=10,
        )
        commit = r.stdout.strip()
        if r.returncode != 0 or not commit:
            return None
        top = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=10,
        )
        return {"repo": top.stdout.strip() or str(root), "commit": commit}
    except Exception:
        return None


def engine_origin(package_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Full origin record: authority declaration + content digest + commit."""
    root = Path(package_dir) if package_dir else PACKAGE_DIR
    digest = package_digest(root)
    return {
        "distributor": ENGINE_DISTRIBUTOR,
        "source_path": ENGINE_SOURCE_PATH,
        "copy_role": ENGINE_COPY_ROLE,
        "cutover_owner": ENGINE_CUTOVER_OWNER,
        "cutover_task": ENGINE_CUTOVER_TASK,
        "dedup_task": ENGINE_DEDUP_TASK,
        "contract_version": ENGINE_CONTRACT_VERSION,
        "package_dir": str(root),
        "package_digest": digest["digest"],
        "package_files": digest["file_count"],
        "distributor_commit": distributor_commit(root),
    }


def format_origin_line(origin: Dict[str, Any]) -> str:
    commit = (origin.get("distributor_commit") or {}).get("commit", "unknown-commit")
    return (
        f"engine origin: distributor={origin.get('distributor')} "
        f"role={origin.get('copy_role')} "
        f"digest={str(origin.get('package_digest'))[:12]} "
        f"({origin.get('package_files')} files, contract v{origin.get('contract_version')}) "
        f"commit={str(commit)[:12]} "
        f"cutover-owner={origin.get('cutover_owner')}/{origin.get('cutover_task')}"
    )


def find_shadow_copies() -> List[Dict[str, str]]:
    """Every `presentation_job` import origin visible on sys.path.

    Returns [{path, origin}] with the FIRST entry being the one `import
    presentation_job` would actually bind (sys.path order). A stale copy
    earlier on sys.path than THIS file's package is a shadowing duplicate.
    """
    seen: List[Dict[str, str]] = []
    for entry in sys.path:
        if not entry:
            continue
        cand = Path(entry) / "presentation_job" / "__init__.py"
        try:
            if cand.is_file():
                spec = importlib.util.spec_from_file_location(
                    "presentation_job_shadow_probe", str(cand))
                seen.append({
                    "path": str(cand.parent),
                    "loader": getattr(spec.loader, "__class__", type("x")).__name__
                    if spec else "unknown",
                })
        except Exception:
            continue
    # Dedupe preserving order.
    out, known = [], set()
    for s in seen:
        if s["path"] not in known:
            known.add(s["path"])
            out.append(s)
    return out


def _check_contract(package_dir: Optional[Path] = None) -> Tuple[bool, List[str]]:
    """Verify this copy satisfies the CC API contract. No heavy imports."""
    import ast

    root = Path(package_dir) if package_dir else PACKAGE_DIR
    problems: List[str] = []

    # 1. state.STATE_SCHEMA_VERSION == 1 (read by AST: importing state has
    #    side-effect-free module level code, but AST keeps this check
    #    honest even if the module later grows import-time behavior).
    try:
        tree = ast.parse((root / "state.py").read_text(encoding="utf-8"))
        vals = [n.value for n in ast.walk(tree)
                if isinstance(n, ast.Assign)
                and any(getattr(t, "id", "") == "STATE_SCHEMA_VERSION"
                        for t in n.targets if isinstance(t, ast.Name))
                and isinstance(n.value, ast.Constant)]
        if not vals or vals[0].value != EXPECTED_STATE_SCHEMA_VERSION:
            problems.append(
                f"state.STATE_SCHEMA_VERSION != {EXPECTED_STATE_SCHEMA_VERSION}")
    except Exception as exc:
        problems.append(f"state.py unreadable: {exc.__class__.__name__}: {exc}")

    # 2. board posts carry metadata.phase_id: board.py must reference the
    #    phase_id key when posting/patching (CC phaseIdOf reads ONLY it).
    try:
        board_src = (root / "board.py").read_text(encoding="utf-8")
        if "phase_id" not in board_src:
            problems.append("board.py never references phase_id "
                            "(CC phaseIdOf would lose every phase signal)")
    except Exception as exc:
        problems.append(f"board.py unreadable: {exc.__class__.__name__}: {exc}")

    # 3. Launcher refusal family intact: -4..-8 sentinels + UNDETERMINED gate.
    # Regex with line anchors: a bare substring test would accept -70 for -7.
    import re as _re
    try:
        launcher_src = (root / "launcher.py").read_text(encoding="utf-8")
        for token in (r"^DISPATCH_CAPACITY_REFUSED = -4\s*$",
                      r"^DISPATCH_UNKNOWN_DECK_TYPE = -5\s*$",
                      r"^DISPATCH_CREDIT_REFUSED = -6\s*$",
                      r"^DISPATCH_NOTIFY_REFUSED = -7\s*$",
                      r"^DISPATCH_ENGINE_REFUSED = -8\s*$",
                      r"^CAPACITY_STATUS_UNDETERMINED"):
            if not _re.search(token, launcher_src, _re.MULTILINE):
                problems.append(f"launcher.py missing {token}")
    except Exception as exc:
        problems.append(f"launcher.py unreadable: {exc.__class__.__name__}: {exc}")

    # 4. TS contract key agreement: PHASE_ACTIVITY_METADATA_KEY == 'phase_id'.
    #    The .ts lives OUTSIDE this package (src/lib/); search upward from
    #    the repo root (package parent). Missing file = UNDETERMINED here,
    #    not drift: installed workspaces may ship the engine standalone.
    ts = root.parent / "src" / "lib" / "presentation-phases.ts"
    if ts.is_file():
        try:
            src = ts.read_text(encoding="utf-8")
            if "PHASE_ACTIVITY_METADATA_KEY = 'phase_id'" not in src:
                problems.append(
                    "src/lib/presentation-phases.ts PHASE_ACTIVITY_METADATA_KEY "
                    "!= 'phase_id' (engine/consumer metadata key drift)")
        except Exception as exc:
            problems.append(f"presentation-phases.ts unreadable: {exc}")
    return (len(problems) == 0, problems)


def preflight(package_dir: Optional[Path] = None) -> Tuple[int, Dict[str, Any]]:
    """Fail-closed compatibility preflight. Returns (exit_code, report).

    exit 0: origin recorded, no shadow, contract holds.
    exit 3 (EXIT_GATE_BLOCKED family): stale shadow duplicate on sys.path.
    exit 7 (EXIT_MANIFEST_MISMATCH family): contract drift vs CC API surface.
    """
    root = Path(package_dir) if package_dir else PACKAGE_DIR
    origin = engine_origin(root)
    report: Dict[str, Any] = {"origin": origin, "ok": True,
                              "shadows": [], "contract_problems": []}

    shadows = find_shadow_copies()
    report["shadows"] = shadows
    # Resolve symlinks/relative spellings: sys.path entries and PACKAGE_DIR
    # may name the same directory differently (/tmp vs /private/tmp, '.' vs
    # absolute). Without resolving, the live copy is misread as "another"
    # directory and a stale duplicate is missed (or a self-match refused).
    def _real(p: str) -> str:
        try:
            return str(Path(p).resolve())
        except Exception:
            return p
    me = str(root)
    me_real = _real(me)
    order = [_real(x["path"]) for x in shadows]
    for s in shadows:
        if _real(s["path"]) == me_real:
            continue
        # Any OTHER presentation_job dir on sys.path: compare digests.
        # Different bytes ANYWHERE on the import path = stale duplicate:
        # `import presentation_job.x` resolves per-module against sys.path
        # order, so a stale copy later on sys.path can still shadow
        # individual submodules of this package (dispatcher, state, ...).
        # Identical bytes = harmless mirror, recorded not fatal.
        try:
            other = package_digest(Path(s["path"]))
        except Exception:
            other = {"digest": "unreadable", "file_count": -1}
        if other.get("digest") != origin["package_digest"]:
            report["ok"] = False
            report["autofail"] = AF_STALE_DUPLICATE
            report["detail"] = (
                f"stale engine duplicate on import path: {s['path']} "
                f"(digest {str(other.get('digest'))[:12]}) differs from "
                f"this copy {me} "
                f"(digest {str(origin['package_digest'])[:12]}). "
                f"Remove it from PYTHONPATH or pin the distributable "
                f"engine ({origin['distributor']}/{origin['source_path']}); "
                f"refusing dispatch rather than silently importing it.")
            return 3, report
        # Identical bytes later on sys.path: recorded, not fatal.
        report.setdefault("notes", []).append(
            f"identical-byte mirror recorded (not fatal): "
            f"{s['path']} digest={str(other.get('digest'))[:12]}")

    ok, problems = _check_contract(root)
    report["contract_problems"] = problems
    if not ok:
        report["ok"] = False
        report["autofail"] = AF_CONTRACT_DRIFT
        report["detail"] = ("engine copy fails CC API contract: "
                            + "; ".join(problems))
        return 7, report
    return 0, report
