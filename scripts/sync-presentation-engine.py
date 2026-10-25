#!/usr/bin/env python3
"""sync-presentation-engine.py -- generate and verify the vendored
presentation_job engine copy in this repo.

WHY THIS EXISTS (Item 7, B7 two-copies design, decision (b))
------------------------------------------------------------
This repo used to carry a hand-maintained copy of the presentation engine
(presentation_job/) that diverged from the canonical package in
trevorotts1/openclaw-onboarding: 34 of 41 shared files differed and 159 of
canonical's 200 files were missing entirely, while fixes kept landing
canonically. The copy is now GENERATED OUTPUT, never hand-edited:

  sync    Replace presentation_job/ wholesale with the canonical package
          tree at a PINNED onboarding commit, and write
          presentation_job/PARITY-MANIFEST.json recording, per file, the
          git blob SHA + sha256 + byte count, the pinned commit, and the
          package content digest.
  verify  Check the worktree against PARITY-MANIFEST.json: every listed
          file present with matching blob SHA and sha256, no unlisted
          files, the recorded digest recomputes, and the engine contract
          invariants hold. This is the CI parity gate (warn-first; see
          .github/workflows/presentation-engine-parity.yml).
  drift   Compare the pinned commit against a source checkout's current
          package tree and report the delta. Used by the weekly drift
          workflow (.github/workflows/presentation-engine-drift.yml).

THE DIGEST, AND THE ONE FILE IT EXCLUDES
----------------------------------------
PARITY-MANIFEST.json's package_digest is computed with EXACTLY the
algorithm engine_origin.package_digest() uses (sorted top-level *.py +
*.json, {name, bytes, sha256} records, canonical JSON, sha256 of it), so
the CI gate and the runtime preflight agree on the digest definition.
The census is taken over the SYNCED FILES, excluding PARITY-MANIFEST.json
itself: a manifest cannot coherently record a digest that covers the
manifest (the value would have to be a fixed point of its own content).
Consequence, recorded not hidden: engine_origin's runtime census on this
copy counts PARITY-MANIFEST.json as one extra top-level .json, so a
runtime-reported digest here differs from canonical's by exactly that
file until a canonical-side follow-up teaches package_digest the same
exclusion (the natural home is the design's Step 6 parity assertion). The
parity gate's own digest check uses the manifest-excluded census, which
is the value the manifest records, and pres039 cross-checks the module's
census against it whenever engine_origin.py is in the pinned tree.

REFUSALS (fail-closed, exit 2)
------------------------------
  sync refuses: a missing or unresolvable --commit (an unpinned source is
  not a source); a source that is not a git checkout; a source with no
  remote whose normalized URL is trevorotts1/openclaw-onboarding, or whose
  --commit is not reachable from that remote's mainline (a checkout that
  merely carries the package tree is not canonical and must never be
  stamped as such); a target whose
  presentation_job/ carries uncommitted changes (the sync replaces that
  directory wholesale and must never silently destroy uncommitted work).
  verify refuses (exit 2 even in --warn mode): a missing or unparseable
  PARITY-MANIFEST.json. A gate that cannot read its own manifest has not
  "warned"; it has not run.

EXIT CODES: 0 ok / 1 verification failed / 2 usage or refusal / 3 drift
found (drift mode only).

Interpreter residue: __pycache__ directories and *.pyc files under
presentation_job/ are ignored by verify's unlisted-file check. They are
bytecode caches a local import leaves behind, never source; a fresh CI
checkout has none.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

CANONICAL_REPO = "trevorotts1/openclaw-onboarding"
CANONICAL_PACKAGE_PATH = (
    "23-ai-workforce-blueprint/templates/role-library/presentations/"
    "scripts/presentation_job"
)
TARGET_PACKAGE = "presentation_job"
MANIFEST_NAME = "PARITY-MANIFEST.json"
GENERATOR_VERSION = 1

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_REFUSED = 2
EXIT_DRIFT = 3


def die(msg: str) -> "SystemExit":
    print(f"sync-presentation-engine: REFUSED: {msg}", file=sys.stderr)
    raise SystemExit(EXIT_REFUSED)


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run(["git", "-C", str(repo), *args],
                       capture_output=True, text=True)
    if check and r.returncode != 0:
        die(f"git -C {repo} {' '.join(args)} failed: {r.stderr.strip()}")
    return r


def resolve_commit(source: Path, ref: str) -> str:
    if not (source / ".git").exists():
        die(f"source {source} is not a git checkout (no .git)")
    r = git(source, "rev-parse", "--verify", f"{ref}^{{commit}}", check=False)
    sha = r.stdout.strip()
    if r.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}", sha):
        die(f"commit {ref!r} does not resolve in source {source} "
            f"(an unpinned source is not a source; pass a full commit SHA)")
    return sha


_REMOTE_URL = re.compile(
    r"^(?:(?P<scheme>[A-Za-z][A-Za-z0-9+.-]*)://)?"
    r"(?:(?P<user>[^/@]+)@)?"
    r"(?P<host>[^/:]+)"
    r"(?::(?P<port>\d+))?"
    r"[:/]"
    r"(?P<path>.+)$")

# Transports that actually fetch from the host they name. Anything else
# (ext::, file://, ...) resolves through a helper of its own and proves
# nothing about origin, so it never counts as canonical.
_REMOTE_SCHEMES = frozenset({"ssh", "git", "http", "https"})


def normalize_remote_url(url: str) -> str:
    """`host/owner/repo` from any git remote URL form (scp, ssh, https).

    Credentials, port and transport are dropped: provenance compares on
    repository identity, not on how a checkout was fetched. Only git's own
    transports count, though -- a URL carrying any other scheme
    (ext::, file://, javascript:, ...) is not a fetch of the canonical
    repo no matter what its host and path say, so it is returned as-is.
    A local path or any form that does not parse is likewise returned
    as-is, so both can only ever fail the canonical comparison.
    """
    m = _REMOTE_URL.match(url.strip())
    if not m:
        return url.strip()
    scheme = m.group("scheme")
    if scheme is not None and scheme.lower() not in _REMOTE_SCHEMES:
        return url.strip()
    path = m.group("path").split("?")[0].split("#")[0].strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    if not path:
        return m.group("host").lower()
    host = m.group("host").lower()
    if host == "www.github.com":
        host = "github.com"
    return f"{host}/{path}"


# Remote-tracking mainline refs searched, in order, for the remote that
# matches CANONICAL_REPO. Only refs fetched FROM that remote count: a local
# refs/heads/main is the checkout's own state and can be ahead of canonical.
_MAINLINE_REFS = ("refs/remotes/{remote}/main", "refs/remotes/{remote}/HEAD")


def verified_source(source: Path, commit: str) -> Dict[str, str]:
    """Prove `source` is the canonical repo and `commit` is on its mainline.

    A checkout that merely CONTAINS the package tree is not canonical: the
    manifest's provenance fields are a claim about where the bytes came
    from, so the remote identity and the commit's mainline reachability are
    both checked before anything is copied. The mainline TIP is not
    recorded -- it moves, and a moving value would break sync idempotence;
    the proof is this acceptance/refusal at copy time.
    """
    listing = git(source, "remote", "-v", check=False)
    remotes: Dict[str, str] = {}
    for line in listing.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            remotes.setdefault(parts[0], parts[1])
    matching = sorted(name for name, url in remotes.items()
                      if normalize_remote_url(url).lower()
                      == f"github.com/{CANONICAL_REPO}".lower())
    if not matching:
        seen = ", ".join(f"{n} ({u})"
                         for n, u in sorted(remotes.items())) or "none"
        die(f"source {source} has no remote pointing at {CANONICAL_REPO} "
            f"(remotes: {seen}); a checkout that carries the package tree "
            f"is not the canonical repository")
    for remote in matching:
        for ref in (r.format(remote=remote) for r in _MAINLINE_REFS):
            head = git(source, "rev-parse", "--verify", "--quiet", ref,
                       check=False)
            tip = head.stdout.strip()
            if head.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}", tip):
                continue
            if git(source, "merge-base", "--is-ancestor", commit, tip,
                   check=False).returncode == 0:
                return {"repo": CANONICAL_REPO, "remote": remote,
                        "url": f"https://github.com/{CANONICAL_REPO}",
                        "mainline_ref": ref}
    die(f"commit {commit} is not on {CANONICAL_REPO}'s mainline in {source} "
        f"(remotes {', '.join(matching)}); refusing to stamp it canonical")


def enumerate_tree(source: Path, commit: str) -> List[Dict[str, Any]]:
    """Tracked files of the canonical package at `commit`, via ls-tree."""
    r = git(source, "ls-tree", "-r", "-z", commit, "--", CANONICAL_PACKAGE_PATH)
    entries: List[Dict[str, Any]] = []
    prefix = CANONICAL_PACKAGE_PATH + "/"
    for record in r.stdout.split("\0"):
        if not record:
            continue
        meta, path = record.split("\t", 1)
        mode, _typ, blob_sha = meta.split(" ")
        if not path.startswith(prefix):
            die(f"unexpected ls-tree path {path!r} outside {CANONICAL_PACKAGE_PATH}")
        entries.append({
            "path": path[len(prefix):],
            "mode": mode,
            "git_blob_sha": blob_sha,
        })
    if not entries:
        die(f"no files under {CANONICAL_PACKAGE_PATH} at {commit} "
            f"(wrong source repo or wrong commit)")
    entries.sort(key=lambda e: e["path"])
    return entries


def blob_bytes(source: Path, blob_sha: str) -> bytes:
    r = subprocess.run(["git", "-C", str(source), "cat-file", "blob", blob_sha],
                       capture_output=True)
    if r.returncode != 0:
        die(f"git cat-file blob {blob_sha} failed in {source}")
    return r.stdout


def git_blob_sha(content: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(content) + content).hexdigest()


def sha256_hex(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def package_digest(records: List[Dict[str, Any]]) -> Tuple[str, int]:
    """engine_origin.package_digest()'s algorithm over the synced records.

    Top-level *.py + *.json only (no recursion), PARITY-MANIFEST.json
    excluded (see module docstring). Returns (digest, census_file_count).
    """
    files: List[Dict[str, Any]] = []
    for rec in records:
        name = rec["path"]
        if "/" in name or name == MANIFEST_NAME:
            continue
        if not (name.endswith(".py") or name.endswith(".json")):
            continue
        files.append({"name": name, "bytes": rec["bytes"],
                      "sha256": rec["sha256"]})
    files.sort(key=lambda f: f["name"])
    canon = json.dumps(files, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest(), len(files)


_ORIGIN_CONSTANTS = (
    "ENGINE_DISTRIBUTOR", "ENGINE_SOURCE_PATH", "ENGINE_COPY_ROLE",
    "ENGINE_CUTOVER_OWNER", "ENGINE_CUTOVER_TASK", "ENGINE_DEDUP_TASK",
)


def harvest_origin(records_content: Dict[str, bytes]) -> Optional[Dict[str, Any]]:
    """The PRES-039 origin constants of the pinned tree, or None.

    Read from the pinned package __init__.py (import-free data) plus
    ENGINE_CONTRACT_VERSION from engine_origin.py when the pinned tree
    carries it. A pin whose __init__ declares no constants (canonical
    before the PRES-039 upstream) yields None, which the manifest records
    honestly as origin: null.
    """
    init_src = records_content.get("__init__.py")
    if init_src is None:
        return None
    found: Dict[str, Any] = {}
    try:
        tree = ast.parse(init_src.decode("utf-8", errors="replace"))
    except SyntaxError:
        return None
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        for t in node.targets:
            if isinstance(t, ast.Name) and t.id in _ORIGIN_CONSTANTS:
                try:
                    found[t.id.lower().removeprefix("engine_")] = \
                        ast.literal_eval(node.value)
                except (ValueError, SyntaxError):
                    pass
    if "distributor" not in found:
        return None
    eo_src = records_content.get("engine_origin.py")
    if eo_src is not None:
        m = re.search(r"^ENGINE_CONTRACT_VERSION\s*=\s*(\d+)\s*$",
                      eo_src.decode("utf-8", errors="replace"), re.MULTILINE)
        if m:
            found["contract_version"] = int(m.group(1))
    return found


def load_manifest(target: Path) -> Dict[str, Any]:
    path = target / TARGET_PACKAGE / MANIFEST_NAME
    if not path.is_file():
        die(f"{path} does not exist (run sync first, or the gate has no "
            f"manifest to check against)")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:  # JSONDecodeError, UnicodeDecodeError
        die(f"{path} is unreadable: {exc}")
    if not isinstance(manifest, dict):
        die(f"{path} is not a manifest (top-level "
            f"{type(manifest).__name__}, want object)")
    return manifest


# --------------------------------------------------------------- sync

def cmd_sync(args: argparse.Namespace) -> int:
    source = Path(args.source).resolve()
    target = Path(args.target).resolve()
    commit = resolve_commit(source, args.commit)
    verified = verified_source(source, commit)

    if not (target / ".git").exists():
        die(f"target {target} is not a git checkout (no .git)")
    dirty = git(target, "status", "--porcelain", "--", TARGET_PACKAGE).stdout
    if dirty.strip():
        die(f"target {TARGET_PACKAGE}/ has uncommitted changes; the sync "
            f"replaces that directory wholesale and will not destroy them. "
            f"Commit or stash them first:\n{dirty}")

    entries = enumerate_tree(source, commit)
    pkg_dir = target / TARGET_PACKAGE
    old_manifest: Optional[Dict[str, Any]] = None
    if (pkg_dir / MANIFEST_NAME).is_file():
        old_manifest = load_manifest(target)

    # Read every blob once; assert the content hashes to the pinned blob.
    content: Dict[str, bytes] = {}
    records: List[Dict[str, Any]] = []
    for e in entries:
        data = blob_bytes(source, e["git_blob_sha"])
        if git_blob_sha(data) != e["git_blob_sha"]:
            die(f"blob {e['git_blob_sha']} for {e['path']} does not hash "
                f"back to itself (source repo object store inconsistent)")
        content[e["path"]] = data
        records.append({
            "path": e["path"],
            "git_blob_sha": e["git_blob_sha"],
            "sha256": sha256_hex(data),
            "bytes": len(data),
        })
    digest, census_count = package_digest(records)
    origin = harvest_origin(content)

    new_manifest: Dict[str, Any] = {
        "canonical_repo": verified["repo"],
        "canonical_commit": commit,
        "canonical_package_path": CANONICAL_PACKAGE_PATH,
        "source": verified,
        "generator_version": GENERATOR_VERSION,
        "package_digest": digest,
        "package_files": census_count,
        "file_count": len(records),
        "origin": origin,
        "files": records,
    }

    # Idempotence: if the pinned content and the recorded manifest (sans
    # generated_at) already agree, write nothing at all.
    if old_manifest is not None:
        comparable_old = {k: v for k, v in old_manifest.items()
                           if k != "generated_at"}
        if comparable_old == new_manifest and all(
                (pkg_dir / rec["path"]).is_file()
                and sha256_hex((pkg_dir / rec["path"]).read_bytes()) == rec["sha256"]
                for rec in records):
            print(f"sync: already at canonical {commit} "
                  f"(digest {digest[:12]}, {len(records)} files) -- no changes")
            return EXIT_OK

    # Wholesale replace: delete files the new tree does not carry, then
    # write the new tree. PARITY-MANIFEST.json is written last.
    wanted = {e["path"] for e in entries}
    removed: List[str] = []
    if pkg_dir.is_dir():
        for p in sorted(pkg_dir.rglob("*")):
            if p.is_file():
                rel = p.relative_to(pkg_dir).as_posix()
                if rel != MANIFEST_NAME and rel not in wanted:
                    p.unlink()
                    removed.append(rel)
        for p in sorted((d for d in pkg_dir.rglob("*") if d.is_dir()),
                        reverse=True):
            try:
                p.rmdir()
            except OSError:
                pass
    changed = added = 0
    for e in entries:
        dest = pkg_dir / e["path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        data = content[e["path"]]
        if dest.is_file() and dest.read_bytes() == data:
            continue
        if dest.is_file():
            changed += 1
        else:
            added += 1
        dest.write_bytes(data)
        os.chmod(dest, 0o755 if e["mode"] == "100755" else 0o644)

    from datetime import datetime, timezone
    new_manifest["generated_at"] = datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    ordered = {k: new_manifest[k] for k in (
        "canonical_repo", "canonical_commit", "canonical_package_path",
        "source", "generated_at", "generator_version", "package_digest",
        "package_files", "file_count", "origin", "files")}
    (pkg_dir / MANIFEST_NAME).write_text(
        json.dumps(ordered, indent=2) + "\n", encoding="utf-8")

    old_files = {f["path"]: f for f in (old_manifest or {}).get("files", [])}
    delta_changed = sum(
        1 for rec in records
        if rec["path"] in old_files
        and old_files[rec["path"]]["git_blob_sha"] != rec["git_blob_sha"])
    print(f"sync: pinned {CANONICAL_REPO}@{commit}")
    print(f"sync: {len(records)} files ({added} added, {changed} rewritten, "
          f"{len(removed)} removed vs worktree; {delta_changed} changed vs "
          f"previous pin)")
    print(f"sync: package_digest {digest} ({census_count} census files)")
    print(f"sync: wrote {TARGET_PACKAGE}/{MANIFEST_NAME}")
    return EXIT_OK


# --------------------------------------------------------------- verify

def _contract_problems_fallback(target: Path,
                                  records: List[Dict[str, Any]]) -> List[str]:
    """Contract checks used only when the pinned tree has no
    engine_origin.py to reuse (a pin predating the PRES-039 upstream).

    Mirrors engine_origin._check_contract's assertions AST/text-wise,
    minus the DISPATCH_ENGINE_REFUSED sentinel, which does not exist
    before the upstream (its canonical value is asserted by the module's
    own _check_contract once the pin carries it).
    """
    pkg = target / TARGET_PACKAGE
    problems: List[str] = []
    try:
        tree = ast.parse((pkg / "state.py").read_text(encoding="utf-8"))
        vals = [n.value for n in ast.walk(tree)
                if isinstance(n, ast.Assign)
                and any(getattr(t, "id", "") == "STATE_SCHEMA_VERSION"
                        for t in n.targets if isinstance(t, ast.Name))
                and isinstance(n.value, ast.Constant)]
        if not vals or vals[0].value != 1:
            problems.append("state.STATE_SCHEMA_VERSION != 1")
    except Exception as exc:  # noqa: BLE001
        problems.append(f"state.py unreadable: {exc.__class__.__name__}: {exc}")
    try:
        board_src = (pkg / "board.py").read_text(encoding="utf-8")
        if "phase_id" not in board_src:
            problems.append("board.py never references phase_id")
    except Exception as exc:  # noqa: BLE001
        problems.append(f"board.py unreadable: {exc.__class__.__name__}: {exc}")
    try:
        launcher_src = (pkg / "launcher.py").read_text(encoding="utf-8")
        for token in (r"^DISPATCH_CAPACITY_REFUSED = -4\s*$",
                      r"^DISPATCH_UNKNOWN_DECK_TYPE = -5\s*$",
                      r"^DISPATCH_CREDIT_REFUSED = -6\s*$",
                      r"^DISPATCH_NOTIFY_REFUSED = -7\s*$",
                      r"^CAPACITY_STATUS_UNDETERMINED"):
            if not re.search(token, launcher_src, re.MULTILINE):
                problems.append(f"launcher.py missing {token}")
    except Exception as exc:  # noqa: BLE001
        problems.append(f"launcher.py unreadable: {exc.__class__.__name__}: {exc}")
    ts = target / "src" / "lib" / "presentation-phases.ts"
    if ts.is_file():
        try:
            if "PHASE_ACTIVITY_METADATA_KEY = 'phase_id'" not in \
                    ts.read_text(encoding="utf-8"):
                problems.append("src/lib/presentation-phases.ts "
                                "PHASE_ACTIVITY_METADATA_KEY != 'phase_id'")
        except Exception as exc:  # noqa: BLE001
            problems.append(f"presentation-phases.ts unreadable: {exc}")
    return problems


def _contract_problems(target: Path,
                       records: List[Dict[str, Any]]) -> Tuple[List[str], str]:
    """(problems, mode). Reuses engine_origin._check_contract from the
    pinned tree when the tree carries the module (the design's rule: one
    implementation, not two); the built-in fallback otherwise."""
    names = {r["path"] for r in records}
    if "engine_origin.py" in names:
        sys.path.insert(0, str(target))
        try:
            from presentation_job import engine_origin as eo
            ok, problems = eo._check_contract(target / TARGET_PACKAGE)
            return ([] if ok else list(problems)), "engine_origin._check_contract"
        except Exception as exc:  # noqa: BLE001
            return ([f"engine_origin._check_contract could not run: "
                     f"{exc.__class__.__name__}: {exc}"], "engine_origin")
        finally:
            sys.path.pop(0)
    return (_contract_problems_fallback(target, records),
            "built-in fallback (pin predates engine_origin upstream)")


def _engine_digest_crosscheck(target: Path,
                              records: List[Dict[str, Any]],
                              manifest: Dict[str, Any]) -> Optional[str]:
    """When the pinned tree carries engine_origin, prove the module's own
    census (over the package minus PARITY-MANIFEST.json, via a symlink
    census dir) equals the digest the manifest records. Returns a problem
    string, or None when it agrees or the module is absent."""
    names = {r["path"] for r in records}
    if "engine_origin.py" not in names:
        return None
    import tempfile
    pkg = target / TARGET_PACKAGE
    sys.path.insert(0, str(target))
    try:
        from presentation_job import engine_origin as eo
        with tempfile.TemporaryDirectory() as td:
            census = Path(td) / "census"
            census.mkdir()
            for name in os.listdir(pkg):
                if name == MANIFEST_NAME:
                    continue
                src = pkg / name
                if src.is_file() and (name.endswith(".py")
                                     or name.endswith(".json")):
                    (census / name).symlink_to(src)
            got = eo.package_digest(census)["digest"]
    except Exception as exc:  # noqa: BLE001
        return f"engine_origin census cross-check could not run: {exc}"
    finally:
        sys.path.pop(0)
    if got != manifest.get("package_digest"):
        return (f"engine_origin census digest {got[:12]} != manifest "
                f"package_digest {str(manifest.get('package_digest'))[:12]}")
    return None


def cmd_verify(args: argparse.Namespace) -> int:
    target = Path(args.target).resolve()
    manifest = load_manifest(target)
    records: List[Dict[str, Any]] = manifest.get("files", [])
    pkg = target / TARGET_PACKAGE
    problems: List[str] = []

    listed = set()
    for rec in records:
        rel = rec["path"]
        listed.add(rel)
        p = pkg / rel
        if not p.is_file():
            problems.append(f"MISSING {rel} (listed in PARITY-MANIFEST)")
            continue
        data = p.read_bytes()
        if len(data) != rec["bytes"]:
            problems.append(f"SIZE {rel}: {len(data)} != {rec['bytes']}")
        if sha256_hex(data) != rec["sha256"]:
            problems.append(f"SHA256 {rel}: content differs from PARITY-MANIFEST")
        if git_blob_sha(data) != rec["git_blob_sha"]:
            problems.append(f"BLOB {rel}: git blob SHA differs from the "
                            f"pinned canonical file")

    if pkg.is_dir():
        for p in sorted(pkg.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(pkg).as_posix()
            if rel == MANIFEST_NAME or rel in listed:
                continue
            if "__pycache__" in Path(rel).parts or rel.endswith(".pyc"):
                continue
            problems.append(f"UNLISTED {rel}: present in {TARGET_PACKAGE}/ "
                            f"but not in PARITY-MANIFEST (hand-added file?)")

    digest, census_count = package_digest(records)
    if digest != manifest.get("package_digest"):
        problems.append(f"DIGEST: recomputed {digest[:12]} != recorded "
                        f"{str(manifest.get('package_digest'))[:12]}")
    if census_count != manifest.get("package_files"):
        problems.append(f"CENSUS: recomputed {census_count} files != "
                        f"recorded {manifest.get('package_files')}")

    contract_problems, mode = _contract_problems(target, records)
    for cp in contract_problems:
        problems.append(f"CONTRACT: {cp}")
    cross = _engine_digest_crosscheck(target, records, manifest)
    if cross:
        problems.append(f"CONTRACT: {cross}")

    pin = manifest.get("canonical_commit", "?")
    if problems:
        for prob in problems:
            if args.warn:
                print(f"::warning::presentation-engine parity: {prob}")
            print(f"PARITY FAIL: {prob}")
        print(f"parity: {len(problems)} problem(s) against pin {pin} "
              f"(contract checks via {mode})")
        return EXIT_OK if args.warn else EXIT_FAILED
    print(f"parity: OK -- {len(records)} files match PARITY-MANIFEST "
          f"(pin {pin}, digest {digest[:12]}, contract via {mode})")
    return EXIT_OK


# --------------------------------------------------------------- drift

def cmd_drift(args: argparse.Namespace) -> int:
    source = Path(args.source).resolve()
    target = Path(args.target).resolve()
    manifest = load_manifest(target)
    head = resolve_commit(source, args.source_ref)
    entries = enumerate_tree(source, head)
    current = {e["path"]: e["git_blob_sha"] for e in entries}
    pinned = {f["path"]: f["git_blob_sha"] for f in manifest.get("files", [])}
    added = sorted(set(current) - set(pinned))
    removed = sorted(set(pinned) - set(current))
    changed = sorted(p for p in set(current) & set(pinned)
                     if current[p] != pinned[p])
    pin = manifest.get("canonical_commit")
    if head == pin and not (added or removed or changed):
        print(f"drift: up to date -- pin {pin} == source {head}")
        return EXIT_OK
    print(f"drift: PINNED {pin}")
    print(f"drift: SOURCE {head}")
    print(f"drift: {len(added)} added, {len(removed)} removed, "
          f"{len(changed)} changed in the canonical package")
    for label, names in (("added", added), ("removed", removed),
                         ("changed", changed)):
        for name in names[:50]:
            print(f"drift: {label}: {name}")
        if len(names) > 50:
            print(f"drift: {label}: ... and {len(names) - 50} more")
    return EXIT_DRIFT


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="sync-presentation-engine.py",
        description="Generate / verify / drift-check the vendored "
                    "presentation_job copy against its canonical pin.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("sync", help="replace presentation_job/ from a "
                                     "pinned canonical commit")
    sp.add_argument("--source", required=True,
                    help="path to an openclaw-onboarding checkout")
    sp.add_argument("--commit", required=True,
                    help="canonical commit SHA to pin (required: an "
                         "unpinned source is refused)")
    sp.add_argument("--target", default=str(Path(__file__).resolve().parent.parent),
                    help="CC repo root (default: this script's repo)")
    sp.set_defaults(fn=cmd_sync)

    vp = sub.add_parser("verify", help="check the worktree against "
                                       "PARITY-MANIFEST.json")
    vp.add_argument("--target", default=str(Path(__file__).resolve().parent.parent))
    vp.add_argument("--warn", action="store_true",
                    help="warn-first staging: report problems as "
                         "::warning:: annotations and exit 0 (a missing "
                         "or unparseable manifest still exits 2)")
    vp.set_defaults(fn=cmd_verify)

    dp = sub.add_parser("drift", help="compare the pin against a source "
                                      "checkout's current package tree")
    dp.add_argument("--source", required=True,
                    help="path to an openclaw-onboarding checkout")
    dp.add_argument("--source-ref", default="HEAD",
                    help="ref in the source to compare (default HEAD)")
    dp.add_argument("--target", default=str(Path(__file__).resolve().parent.parent))
    dp.set_defaults(fn=cmd_drift)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
