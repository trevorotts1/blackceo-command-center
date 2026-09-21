#!/usr/bin/env python3
"""
sync-departments-from-build-state.py

Regenerates config/departments.json from the CLIENT'S REAL Zero Human Company
build (ZHC departments.json + .workforce-build-state.json) and re-seeds the
`workspaces` table in mission-control.db so the dashboard always reflects what
the client actually built -- never the stale shipped template.

WHY THIS EXISTS:
  config/departments.json ships EMPTY ([]) on purpose. autoSeedFromDepartmentsJson()
  in migrations.ts returns early on an empty array, so a fresh dashboard seeds
  nothing until this script runs against the client's real build. Through v4.0.2
  the repo shipped a 17-row template that won (because it was non-empty), so every
  client dashboard showed the same 17 departments regardless of their interview.

SOURCE OF TRUTH (priority order):
  Canonical master-files roots (where build-workforce.py actually writes, PRD 1.9
  resolve_company_paths / detect_platform.py get_openclaw_paths()['company_root']):
    - $MASTER_FILES_DIR/zero-human-company/<slug>/departments.json (env override)
    - VPS:  /data/openclaw-master-files/zero-human-company/<slug>/departments.json
    - Mac:  ~/Downloads/openclaw-master-files/zero-human-company/<slug>/departments.json
  Legacy roots (backward-compat READS only, never written):
    - ~/clawd/zero-human-company/<slug>/departments.json
    - ~/clawd/zhc/<slug>/departments.json (short alias)
    - /data/clawd/zero-human-company/<slug>/departments.json (VPS legacy)
  Company selection within the resolved roots:
    1. --company-slug / $COMPANY_SLUG
    2. build-state companySlug (fallback: clientSlug)
    3. Most-recently-modified departments.json (last resort; emits a loud warning)

USAGE:
  python3 sync-departments-from-build-state.py
  python3 sync-departments-from-build-state.py --company-slug acme-corp
  python3 sync-departments-from-build-state.py --db /path/to/mission-control.db \\
      --config /path/to/config/departments.json
  python3 sync-departments-from-build-state.py --merge  (update-flow safe mode)

Idempotent: re-running refreshes config/departments.json and upserts workspaces
(never duplicates). Safe to call from run-full-install.sh on every install/resume.
"""
import argparse
from datetime import datetime, timezone
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

# DATA-08: single shared DB resolver (shared-utils/resolve_db.py) so this script
# and the Command Center app always resolve the SAME mission-control.db.
_SHARED_UTILS = Path(__file__).resolve().parent.parent / "shared-utils"
sys.path.insert(0, str(_SHARED_UTILS))
try:
    from resolve_db import find_dashboard_db as _shared_find_dashboard_db, is_db_found as _shared_is_db_found  # type: ignore
    _HAS_SHARED_RESOLVER = True
except ImportError:
    _HAS_SHARED_RESOLVER = False

# departments.json ships in TWO legitimate top-level shapes: a bare list, and an
# object wrapping that list under a "departments" key (the retire-script's
# {removedWithProvenance, departments} audit trail, and the build's
# {company, total_departments, total_roles, departments} envelope). This script
# iterated whatever it loaded, so an envelope handed `reseed_workspaces()` the
# dict's KEYS -- which seeded four bogus workspaces literally named Company /
# Total Departments / Total Roles / Departments on a client box (2026-08-07) and
# later crashed Phase 6c with `AttributeError: 'str' object has no attribute
# 'get'`. The ONE normalizer decides the shape; a dict's metadata keys are never
# departments.
from departments_payload import (  # type: ignore  # noqa: E402
    MalformedDepartmentsError,
    normalize_departments,
)


def _oc_root():
    if Path("/data/.openclaw").is_dir():
        return Path("/data/.openclaw")
    return Path.home() / ".openclaw"


def _build_state_path():
    p = _oc_root() / "workspace" / ".workforce-build-state.json"
    return p


def _load_build_state():
    p = _build_state_path()
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _zhc_roots():
    """Zero-Human-Company roots to scan for <slug>/departments.json, priority order.

    SOURCE OF TRUTH: onboarding/shared-utils/detect_platform.py
      get_openclaw_paths()['company_root'] (canonical) + get_legacy_company_roots()
      (backward-compat). This CC-repo script CANNOT import that module at runtime
      (different install trees), so the resolution is REPLICATED inline here.
      KEEP IN SYNC with detect_platform.py.

    Canonical master-files roots FIRST -- this is where build-workforce.py
    (PRD 1.9 resolve_company_paths) actually writes the client's real build:
      1. $MASTER_FILES_DIR/zero-human-company  (same override the resolver honors)
      2. VPS:  /data/openclaw-master-files/zero-human-company
      3. Mac:  ~/Downloads/openclaw-master-files/zero-human-company
    Both platform defaults are always listed; only the root that exists on this
    box is scanned, so a single list works on Mac and VPS alike.

    THEN legacy roots (READ-ONLY backward-compat; never written by new builds):
      4. ~/clawd/zero-human-company        (v9.6.0+ canonical, legacy)
      5. ~/clawd/zhc                       (short alias, legacy)
      6. /data/clawd/zero-human-company    (VPS pre-master-files workforces)
    """
    roots = []
    # 1. Canonical: honor MASTER_FILES_DIR before any default (matches resolver).
    env_master = os.environ.get("MASTER_FILES_DIR", "").strip()
    if env_master:
        roots.append(Path(env_master) / "zero-human-company")
    # 2-3. Canonical platform defaults (VPS + Mac).
    roots.append(Path("/data/openclaw-master-files") / "zero-human-company")
    roots.append(Path.home() / "Downloads" / "openclaw-master-files" / "zero-human-company")
    # 4-6. Legacy read-only roots (backward-compat).
    roots.append(Path.home() / "clawd" / "zero-human-company")
    roots.append(Path.home() / "clawd" / "zhc")
    roots.append(Path("/data/clawd") / "zero-human-company")

    # De-dup while preserving priority order (MASTER_FILES_DIR may equal a default).
    seen = set()
    deduped = []
    for r in roots:
        if r not in seen:
            seen.add(r)
            deduped.append(r)
    return deduped


def _scan_zhc_companies():
    """Return (slug, departments.json path) tuples for every ZHC company found."""
    results = []
    for root in _zhc_roots():
        if not root.is_dir():
            continue
        try:
            entries = sorted(root.iterdir())
        except (OSError, PermissionError) as e:
            print(f"  [sync] skipping unscannable root {root}: {e}", file=sys.stderr)
            continue
        for entry in entries:
            if entry.is_dir() and not entry.name.startswith("."):
                dj = entry / "departments.json"
                if dj.exists():
                    results.append((entry.name, dj))
    return results


def find_departments(company_slug=None):
    """Locate the client's real ZHC departments.json. Returns (data, path) or (None, None)."""
    target = company_slug or os.environ.get("COMPANY_SLUG", "").strip()
    if not target:
        # Honor build-state companySlug; fall back to clientSlug. Onboarding is
        # standardizing on companySlug, but older build-states only wrote
        # clientSlug -- support both during the transition.
        state = _load_build_state()
        target = (state.get("companySlug") or state.get("clientSlug") or "").strip()

    companies = _scan_zhc_companies()

    # 1. Exact slug match (deterministic, preferred).
    if target:
        for slug, dj in companies:
            if slug == target:
                data = _read_json(dj)
                if data:
                    return data, str(dj)
        print(f"  [sync] WARNING: build-state slug '{target}' not found under any ZHC "
              f"root; falling back to the most-recently-modified departments.json.",
              file=sys.stderr)

    # 2. Most-recently-modified ZHC departments.json (last-resort fallback).
    with_mtime = sorted(
        ((dj.stat().st_mtime, dj) for _, dj in companies),
        reverse=True,
    )
    for _, dj in with_mtime:
        data = _read_json(dj)
        if data:
            if not target:
                print("  [sync] WARNING: no companySlug/clientSlug in build-state and no "
                      "--company-slug/$COMPANY_SLUG override; using most-recently-modified "
                      f"departments.json ({dj}). Set companySlug for deterministic sync.",
                      file=sys.stderr)
            return data, str(dj)

    return None, None


def _read_json(path):
    """Load a departments.json and return its department LIST, or None.

    The single load boundary for this script, so the shape is decided exactly
    once. A read/parse failure is skippable (the scan moves to the next
    candidate file). A MALFORMED payload is NOT: skipping it would silently
    fall through to a different company's departments.json and sync the wrong
    client's board. So it propagates, naming the path and the top-level type.
    (MalformedDepartmentsError subclasses ValueError, but json.JSONDecodeError
    is a distinct subclass, so the except below does not swallow it.)
    """
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"  [sync] skipping {path}: {e}", file=sys.stderr)
        return None
    departments = normalize_departments(data, path=str(path))
    return departments if departments else None


def find_db(explicit=None):
    if explicit:
        return explicit
    for _ev in ("DASHBOARD_DB_PATH", "DATABASE_PATH"):
        _v = os.environ.get(_ev)
        if _v:
            return _v
    if _HAS_SHARED_RESOLVER:
        p = _shared_find_dashboard_db()
        if _shared_is_db_found(p):
            return str(p)
    candidates = [
        Path.cwd() / "mission-control.db",
        Path.home() / "projects" / "command-center" / "mission-control.db",
        Path("/data/projects/command-center") / "mission-control.db",
        Path.home() / "projects" / "mission-control" / "mission-control.db",
        Path("/opt/mission-control/mission-control.db"),
        Path("/app/mission-control.db"),
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return None


def find_company_info(departments_path):
    """Read company name/slug/industry from the ZHC company-config.json next to departments.json."""
    info = {"name": "", "slug": "", "industry": "",
            "brand_primary": "#1f2937", "brand_accent": "#3b82f6", "brand_text": "#f8fafc"}

    env_name = os.environ.get("COMPANY_NAME", "").strip()
    if env_name:
        info["name"] = env_name

    state = _load_build_state()
    if not info["name"]:
        info["name"] = (state.get("companyName") or "").strip()
    info["industry"] = (state.get("industry") or "").strip()

    cfg = Path(departments_path).parent / "company-config.json"
    if cfg.exists():
        try:
            with open(cfg) as f:
                c = json.load(f)
            info["name"] = c.get("name", "") or info["name"]
            info["slug"] = c.get("slug", "") or info["slug"]
            info["industry"] = c.get("industry", "") or info["industry"]
            brand = c.get("brand", {})
            info["brand_primary"] = brand.get("primary", info["brand_primary"])
            info["brand_accent"] = brand.get("accent", info["brand_accent"])
            info["brand_text"] = brand.get("text", info["brand_text"])
        except (OSError, json.JSONDecodeError):
            pass

    if not info["slug"]:
        info["slug"] = Path(departments_path).parent.name

    if not info["name"]:
        info["name"] = info["slug"].replace("-", " ").title() or "My Company"

    if not info["slug"]:
        info["slug"] = re.sub(r"[^a-z0-9]+", "-", info["name"].lower()).strip("-") or "my-company"

    return info


def write_config(config_path, departments):
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    with open(config_path, "w") as f:
        json.dump(departments, f, indent=2)
        f.write("\n")
    print(f"  [sync] wrote {len(departments)} departments to {config_path}")


def merge_config(config_path, departments):
    """
    Merge-additive write to config/departments.json (U133).

    For each department in ``departments`` (the source-of-truth build):
      - If the ``id`` already exists in the LOCAL file, update its fields in place
        (name, emoji, headTitle).
      - If the ``id`` is new, APPEND it.
    Departments that exist ONLY in the local file (custom departments the box
    owner added manually or through the dashboard) are PRESERVED -- never deleted.

    This is the safe update-flow path invoked from update.sh. It is deliberately
    additive; removal of an upstream-deprecated department is a manual operator
    action, never a surprise side-effect of an automated update.
    """
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    existing = []
    if os.path.exists(config_path):
        try:
            with open(config_path) as f:
                existing = json.load(f)
        except (OSError, json.JSONDecodeError):
            existing = []
    if not isinstance(existing, list):
        existing = []

    # Index existing departments by id for O(1) lookup.
    existing_by_id = {}
    for entry in existing:
        if isinstance(entry, dict) and "id" in entry:
            existing_by_id[entry["id"]] = entry

    added, updated = 0, 0
    for dept in departments:
        if not isinstance(dept, dict):
            continue
        dept_id = dept.get("id", "")
        if not dept_id:
            continue
        if dept_id in existing_by_id:
            target = existing_by_id[dept_id]
            target["name"] = dept.get("name", target.get("name", ""))
            target["emoji"] = dept.get("emoji", target.get("emoji", ""))
            if "headTitle" in dept:
                target["headTitle"] = dept["headTitle"]
            updated += 1
        else:
            entry = {
                "id": dept_id,
                "name": dept.get("name", ""),
                "emoji": dept.get("emoji", ""),
            }
            if "headTitle" in dept:
                entry["headTitle"] = dept["headTitle"]
            existing.append(entry)
            existing_by_id[dept_id] = entry
            added += 1

    with open(config_path, "w") as f:
        json.dump(existing, f, indent=2)
        f.write("\n")
    kept = len(existing) - added
    print(f"  [sync-merge] departments.json: added={added} updated={updated} "
          f"kept={kept} total={len(existing)} -> {config_path}")


# Reserved system/infrastructure workspaces
# podcast + anthology: seeded by migration-113-podcast-anthology-seed;
# must never be deleted by --prune even though they are absent from
# the Zero Human Company departments.json build snapshot.
RESERVED_WORKSPACE_IDS = frozenset({
    "default", "general-task", "bugs", "inbox",
    "master-orchestrator", "ceo", "dept-ceo", "ceo-com",
    "podcast", "anthology",
})

# R-39: fleet-shared producer-engine workspace ids. These are NOT per-client
# departments -- they are shared engines (podcast + anthology producers) that
# every client on a multi-client box sees. They must ALWAYS carry
# company_id='default' so a converge with an active company set never
# re-attributes them to one client (which would hide them from every OTHER
# client on the same box). The sync-depts script must NOT re-home their
# company_id to the client slug. Must stay in sync with
# src/lib/db/migrations.ts ENGINE_WORKSPACE_SLUGS.
ENGINE_WORKSPACE_IDS = frozenset({
    "podcast",
    "anthology",
})


def _table_exists(cur, name):
    row = cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


# Mirrored from src/lib/routing/canonical-slug.ts's ALIAS_MAP. Used ONLY to
# MATCH an existing workspace row before inserting a new one -- never by
# _canonical_dept_slug() below, whose dedupe grouping must stay prefix-only (an
# alias-level merge there would collapse two departments a client deliberately
# chose, which is why 'app-development' is absent from this table as a KEY).
_DEPT_ALIASES = {
    "ceo": "master-orchestrator",
    "ceo-com": "master-orchestrator",
    "com": "master-orchestrator",
    "central-operations": "master-orchestrator",
    "billing": "billing-finance",
    "webdev": "web-development",
    "web-dev": "web-development",
    "web": "web-development",
    "appdev": "app-development",
    "app-dev": "app-development",
    "mobile": "app-development",
    "software-development": "engineering",
    "software-dev": "engineering",
    "apps": "engineering",
    "video-production": "video",
    "audio-production": "audio",
    "legal-compliance": "legal",
    "compliance": "legal",
    "support": "customer-support",
    "customer-service": "customer-support",
    "comms": "communications",
    "communication": "communications",
    "social": "social-media",
    "paid-ads": "paid-advertisement",
    "paid-advertising": "paid-advertisement",
    "openclaw": "openclaw-maintenance",
    "general": "general-task",
    "misc": "general-task",
    "catch-all": "general-task",
    "catchall": "general-task",
    "unclassified": "general-task",
}


def _aliased_dept_slug(slug):
    """`_canonical_dept_slug` plus the alias remap. MATCHING ONLY."""
    s = _canonical_dept_slug(slug)
    return _DEPT_ALIASES.get(s, s)


def _ensure_archive_columns(cur):
    """Make sure workspaces carries archived_at / archived_reason.

    Migration 095 adds them on a box the CC app has booted; this script also
    runs BEFORE that (bootstrap installs create the table here), and it must
    never fall back to deleting because a column is missing.
    """
    cols = [r[1] for r in cur.execute("PRAGMA table_info(workspaces)").fetchall()]
    if "archived_at" not in cols:
        cur.execute("ALTER TABLE workspaces ADD COLUMN archived_at TEXT")
    if "archived_reason" not in cols:
        cur.execute("ALTER TABLE workspaces ADD COLUMN archived_reason TEXT")


def _archive_workspace(cur, wid, reason):
    """Soft-archive one workspace row. THIS SCRIPT NEVER DELETES ONE.

    A hard DELETE here removed 22 archived rows from a client board during the
    v7.6.35 roll. A workspace row is the anchor for a department's whole task and
    agent history; losing it loses that history with no audit trail, and the
    board's own archive view is a display state, not a tombstone. Archiving is
    reversible by an operator, a delete is not.

    Already-archived rows are left exactly as they are -- the original
    archived_at / archived_reason is the audit trail.
    """
    cur.execute(
        "UPDATE workspaces SET archived_at=?, archived_reason=? "
        "WHERE id=? AND (archived_at IS NULL OR archived_at='')",
        (datetime.now(timezone.utc).isoformat(), reason, wid))
    return cur.rowcount > 0


def _print_company_scope(cur, target_slug):
    """One line naming every company id in the DB and the one this run targets.

    A client box carried three ('default' plus two spellings of the same client)
    and the mismatch is what makes phase 6b refuse; the operator could not see it
    without opening the database by hand.
    """
    companies = [r[0] for r in cur.execute("SELECT id FROM companies ORDER BY id")]
    in_use = [(r[0] or "") for r in cur.execute(
        "SELECT DISTINCT company_id FROM workspaces ORDER BY 1")]
    print(f"  [sync] company ids -- companies table: {companies or ['(none)']}; "
          f"on workspaces: {in_use or ['(none)']}; this run targets: {target_slug!r}")


def _canonical_dept_slug(slug):
    """Minimal, prefix-only canonicalization mirroring this script's own
    dept-id normalization two lines above (dept_id = raw_id[5:] if it starts
    with 'dept-').

    Deliberately narrower than the TS canonicalDeptSlug() in
    src/lib/routing/canonical-slug.ts (no alias-map remapping, e.g.
    "billing" -> "billing-finance") -- that full alias table is the CC app's
    single source of truth and this script must never fork a second, drifting
    copy of it. The dept- prefix collision is exactly the literal shape of
    the 2026-08-04 "WANTED Woman" incident (36 `dept-<slug>` rows + 36
    `<slug>` rows for the same 36 departments); any alias-level duplicate
    this simpler pass misses is still healed by the TS-side
    dedupeCanonicalWorkspaces(), which runs on every subsequent boot and
    converge (reseedWorkspacesFromConfig, src/lib/db/migrations.ts).
    """
    s = (slug or "").strip().lower()
    if s.startswith("dept-"):
        s = s[5:]
    return s


def _tables_with_workspace_id(cur):
    tables = []
    for (name,) in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall():
        if name == "workspaces":
            continue
        try:
            cols = [r[1] for r in cur.execute(f"PRAGMA table_info({name})").fetchall()]
        except sqlite3.OperationalError:
            continue
        if "workspace_id" in cols:
            tables.append(name)
    return tables


def dedupe_canonical_workspaces(cur):
    """
    Collapse duplicate workspace rows that canonicalize (dept- prefix only --
    see _canonical_dept_slug) to the SAME department, WITHIN the same company.

    Mirrors src/lib/db/task-dedup.ts's dedupeCanonicalWorkspaces() one-for-one
    (same keeper preference: canonical-slug row first, then most agents+tasks,
    then oldest rowid; same "never touch a workspace with live
    in_progress/assigned work" safety), so a box whose ONLY sync path is this
    Python script (e.g. very early in provisioning, before the CC app's own
    TS reseed has ever run) still self-heals instead of accumulating a
    `dept-<slug>` / `<slug>` pair forever.

    Company-scope guard (2026-08-04 "WANTED Woman" incident): grouping by
    canonical slug ALONE, with no company boundary, would merge TWO DIFFERENT
    companies' "marketing" workspace on a shared multi-client box into one
    row -- splicing one client's task/agent history onto another client's
    department. company_id NULL / '' / 'default' is the box's own
    unattributed data and may merge into any ONE real company's keeper for
    the same department; two rows that each carry a DIFFERENT real
    (non-default) company_id must never merge into each other.

    A loser row is a true duplicate SHELL by the time it is retired -- every
    workspace_id-bearing row that pointed at it was just reassigned to the
    keeper above. It is ARCHIVED, never deleted: task-dedup.ts routes its own
    hard delete through assertArchivedBeforeHardDelete, and this script has no
    equivalent audit-trail helper, so it stops at the archive.

    Returns (groups_merged, rows_archived). Never raises on a row-level
    problem for one canonical group -- logs and continues with the rest.
    """
    # Already-archived rows are invisible to the dedupe: they are a tombstone,
    # not a duplicate to collapse, and re-touching one would rewrite its audit
    # trail. They are also never chosen as a keeper.
    rows = cur.execute(
        "SELECT rowid, id, slug, company_id FROM workspaces "
        "WHERE archived_at IS NULL OR archived_at=''").fetchall()
    by_canon = {}
    for rowid, wid, slug, company_id in rows:
        canon = _canonical_dept_slug(slug) or (slug or "").lower()
        by_canon.setdefault(canon, []).append(
            {"rowid": rowid, "id": wid, "slug": slug or "", "company_id": company_id}
        )

    def is_real_company(cid):
        return bool(cid) and cid != "default"

    merge_groups = []
    for canon, members in by_canon.items():
        real_companies = sorted({m["company_id"] for m in members if is_real_company(m["company_id"])})
        if len(real_companies) <= 1:
            merge_groups.append((canon, members))
            continue
        # 2+ real companies collide on the same canonical slug -- dedup EACH
        # company's own rows independently; unattributed rows are excluded
        # from every sub-group (ambiguous which company they belong to).
        default_rows = [m for m in members if not is_real_company(m["company_id"])]
        for company_id in real_companies:
            merge_groups.append((canon, [m for m in members if m["company_id"] == company_id]))
        if len(default_rows) > 1:
            merge_groups.append((canon, default_rows))
        elif len(default_rows) == 1:
            print(
                f"  [sync] canonical '{canon}' spans {len(real_companies)} companies "
                f"({', '.join(real_companies)}) -- leaving unattributed workspace "
                f"'{default_rows[0]['id']}' un-merged pending manual review",
                file=sys.stderr,
            )

    has_agents = _table_exists(cur, "agents")
    has_tasks = _table_exists(cur, "tasks")
    ws_tables = _tables_with_workspace_id(cur)
    groups_merged = 0
    rows_archived = 0

    for canon, members in merge_groups:
        if len(members) < 2:
            continue

        scored = []
        for m in members:
            a = cur.execute("SELECT COUNT(*) FROM agents WHERE workspace_id=?", (m["id"],)).fetchone()[0] if has_agents else 0
            t = cur.execute("SELECT COUNT(*) FROM tasks WHERE workspace_id=?", (m["id"],)).fetchone()[0] if has_tasks else 0
            scored.append({**m, "weight": a + t, "is_canonical": m["slug"].lower() == canon})

        # Keeper preference: canonical slug first, then most attached rows,
        # then oldest rowid -- identical order to task-dedup.ts.
        scored.sort(key=lambda x: (not x["is_canonical"], -x["weight"], x["rowid"]))
        keeper, losers = scored[0], scored[1:]

        live_loser = None
        if has_tasks:
            for loser in losers:
                n = cur.execute(
                    "SELECT COUNT(*) FROM tasks WHERE workspace_id=? AND status IN ('in_progress','assigned')",
                    (loser["id"],),
                ).fetchone()[0]
                if n > 0:
                    live_loser = loser
                    break
        if live_loser:
            print(
                f"  [sync] SKIP merge for canonical '{canon}': loser workspace "
                f"'{live_loser['id']}' has live in_progress/assigned task(s) -- "
                "deferring to a quiet re-run",
                file=sys.stderr,
            )
            continue

        for loser in losers:
            for table in ws_tables:
                cur.execute(f"UPDATE {table} SET workspace_id=? WHERE workspace_id=?", (keeper["id"], loser["id"]))
            _archive_workspace(cur, loser["id"], f"deduped: loser of {keeper['id']}")
            rows_archived += 1
            print(f"  [sync] merged duplicate workspace '{loser['id']}' into "
                  f"'{keeper['id']}' (canonical '{canon}') -- loser ARCHIVED, not deleted")

        if keeper["slug"].lower() != canon:
            cur.execute("UPDATE workspaces SET slug=? WHERE id=?", (canon, keeper["id"]))

        groups_merged += 1

    return groups_merged, rows_archived


def reseed_workspaces(db_path, departments, company_info, prune=False):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS companies (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
            industry TEXT, config TEXT DEFAULT '{}'
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
            description TEXT, icon TEXT, company_id TEXT DEFAULT 'default'
        )
    """)

    _ensure_archive_columns(cur)

    slug = company_info["slug"]
    company_config = json.dumps({"brand": {
        "primary": company_info["brand_primary"],
        "accent": company_info["brand_accent"],
        "text": company_info["brand_text"],
    }})
    existing_company = cur.execute(
        "SELECT id FROM companies WHERE slug=?", (slug,)).fetchone()
    if existing_company:
        cur.execute(
            "UPDATE companies SET name=?, industry=?, config=? WHERE slug=?",
            (company_info["name"], company_info["industry"], company_config, slug))
    else:
        cur.execute(
            "INSERT INTO companies (id, name, slug, industry, config) "
            "VALUES (?, ?, ?, ?, ?)",
            (slug, company_info["name"], slug, company_info["industry"], company_config))

    _print_company_scope(cur, slug)

    live_rows = cur.execute(
        "SELECT id, company_id, slug, name FROM workspaces "
        "WHERE archived_at IS NULL OR archived_at=''").fetchall()
    existing = {row[0]: row[1] for row in cur.execute(
        "SELECT id, company_id FROM workspaces").fetchall()}

    live_by_id = {r[0]: r for r in live_rows}
    live_rows_scoped = [
        {"id": r[0], "company_id": r[1], "slug": r[2] or "", "name": r[3] or ""}
        for r in live_rows if not r[1] or r[1] in ("default", slug)
    ]

    def _match_existing(dept_id, name):
        """The row this department already IS, or None to insert a new one.

        Order: exact id, then canonicalized slug, then case-insensitive NAME,
        then the alias table. Anything but an exact id match is confined to this
        company's own rows plus unattributed ones, so a shared box never splices
        one client's department onto another's (the 2026-08-04 incident).

        ARCHIVED rows are not candidates. An archived workspace is an operator's
        decision; a later sync must not silently bring it back to life, so a
        build entry for an archived department inserts a fresh row instead.
        """
        if dept_id in live_by_id:
            return dept_id
        want_canon = _canonical_dept_slug(dept_id)
        want_alias = _aliased_dept_slug(dept_id)
        want_name = (name or "").strip().lower()
        for by in (
            lambda r: _canonical_dept_slug(r["slug"]) == want_canon,
            lambda r: (r["name"] or "").strip().lower() == want_name and want_name,
            lambda r: _aliased_dept_slug(r["slug"]) == want_alias,
        ):
            for row in live_rows_scoped:
                if by(row):
                    return row["id"]
        return None

    build_ids = set()
    inserted = updated = 0
    for dept in departments:
        raw_id = dept.get("id", "")
        dept_id = raw_id[5:] if raw_id.startswith("dept-") else raw_id
        if not dept_id:
            continue
        name = dept["name"]
        description = f"{name} department workspace"
        icon = dept.get("emoji", "\U0001f4c1")
        matched = _match_existing(dept_id, name)
        # An exact-id match may have its slug normalized to the id; a row matched
        # by NAME or ALIAS keeps its own slug -- rewriting it to the build's id is
        # what would create the duplicate this match exists to avoid, and it can
        # collide with the UNIQUE(slug) index besides.
        normalize_slug = matched == dept_id
        if matched and matched != dept_id:
            print(f"  [sync] matched build department {dept_id!r} to existing "
                  f"workspace {matched!r} -- updating it instead of inserting a duplicate")
            dept_id = matched
        build_ids.add(dept_id)
        if matched:
            # R-39: fleet-shared engine workspaces (podcast/anthology)
            # must ALWAYS stay company_id='default' -- never re-home
            # them to the client slug. The TS reseedWorkspacesFromConfig
            # enforces the same guard (ENGINE_WORKSPACE_SLUGS). Update
            # display fields (name/slug/description/icon) but keep the
            # existing company_id for engine-owned workspaces.
            if dept_id.lower() in ENGINE_WORKSPACE_IDS:
                cur.execute("""
                    UPDATE workspaces
                    SET name=?, description=?, icon=?
                    WHERE id=?
                """, (name, description, icon, dept_id))
                if normalize_slug:
                    cur.execute("UPDATE workspaces SET slug=? WHERE id=?", (dept_id, dept_id))
                updated += 1
            else:
                cur.execute("""
                    UPDATE workspaces
                    SET name=?, description=?, icon=?, company_id=?
                    WHERE id=?
                """, (name, description, icon, slug, dept_id))
                if normalize_slug:
                    cur.execute("UPDATE workspaces SET slug=? WHERE id=?", (dept_id, dept_id))
                updated += 1
                if existing[dept_id] != slug:
                    print(f"  [sync] re-homed workspace {dept_id}: company_id "
                          f"{existing[dept_id]!r} -> {slug!r}")
        else:
            cur.execute("""
                INSERT INTO workspaces (id, name, slug, description, icon, company_id)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (dept_id, name, dept_id, description, icon, slug))
            inserted += 1
            print(f"  [sync] inserted workspace: {dept_id} ({name})")

    # DEFECT 2 fix (2026-08-04, "WANTED Woman" incident). Heal any PRE-EXISTING
    # `dept-<slug>` / `<slug>` duplicate pair for this box's own company(ies)
    # before pruning -- so the stale-department check below operates on the
    # already-deduped set. Runs on every call (not opt-in): a true no-op on a
    # board with no duplicates.
    dedupe_groups, dedupe_archived = dedupe_canonical_workspaces(cur)
    if dedupe_groups:
        print(f"  [sync] healed {dedupe_groups} duplicate workspace group(s) "
              f"({dedupe_archived} row(s) archived)")

    pruned = kept_nonempty = 0
    if prune:
        has_tasks = _table_exists(cur, "tasks")
        already_archived = {r[0] for r in cur.execute(
            "SELECT id FROM workspaces WHERE archived_at IS NOT NULL AND archived_at<>''")}
        for wid, _cid in list(existing.items()):
            if wid in build_ids:
                continue
            if wid.lower() in RESERVED_WORKSPACE_IDS:
                continue
            if wid in already_archived:
                # Already retired. Its archived_at/archived_reason is the audit
                # trail of WHY, and re-stamping it would erase that.
                continue
            task_count = 0
            if has_tasks:
                task_count = cur.execute(
                    "SELECT COUNT(*) FROM tasks WHERE workspace_id=?", (wid,)
                ).fetchone()[0]
            if task_count > 0:
                kept_nonempty += 1
                print(f"  [sync] KEPT stale workspace {wid!r} (not in build) -- "
                      f"has {task_count} task(s); operator review needed")
                continue
            _archive_workspace(cur, wid, "pruned: absent from build-state")
            pruned += 1
            print(f"  [sync] pruned stale workspace: {wid} (ARCHIVED, not deleted)")

    conn.commit()
    conn.close()
    print(f"  [sync] workspaces re-seeded. inserted={inserted} updated={updated} "
          f"pruned={pruned} kept_nonempty={kept_nonempty} "
          f"total_in_build={len(build_ids)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--company-slug", default=None,
                    help="ZHC company slug to sync (default: build-state companySlug or most recent)")
    ap.add_argument("--db", default=None, help="Path to mission-control.db")
    ap.add_argument("--config", default=None,
                    help="Path to config/departments.json to regenerate")
    ap.add_argument("--prune", action="store_true", default=False,
                    help="ARCHIVE stale workspaces no longer in the build "
                         "(skips reserved system workspaces and any workspace "
                         "that still holds tasks). Default OFF; enable from "
                         "run-full-install Phase 6c.")
    ap.add_argument("--merge", action="store_true", default=False,
                    help="Merge-additive departments.json write: add new, update "
                         "existing, never delete custom departments. Safe for "
                         "update-flow use (unlike the default overwrite).")
    args = ap.parse_args()

    # A malformed payload must stop the sync with a readable line, not a
    # traceback and not a silent fallback to another company's file.
    try:
        departments, source = find_departments(args.company_slug)
    except MalformedDepartmentsError as e:
        print(f"[sync] FATAL: {e}", file=sys.stderr)
        print("[sync] Refusing to sync: a departments.json whose shape cannot be read "
              "would seed bogus workspaces onto this board. Fix the artifact and re-run.",
              file=sys.stderr)
        sys.exit(1)
    if not departments:
        print("[sync] No ZHC departments.json found. "
              "Run Skill 23 (AI Workforce Blueprint) first. Nothing to sync.",
              file=sys.stderr)
        sys.exit(0)
    print(f"[sync] Source of truth: {source} ({len(departments)} departments)")

    config_path = args.config or str(Path(__file__).resolve().parent.parent / "config" / "departments.json")
    if args.merge:
        merge_config(config_path, departments)
    else:
        write_config(config_path, departments)

    db_path = find_db(args.db)
    if not db_path:
        print("[sync] mission-control.db not found -- config written but DB not re-seeded. "
              "The dashboard will auto-seed from config/departments.json on next boot.",
              file=sys.stderr)
        sys.exit(0)

    company_info = find_company_info(source)
    print(f"[sync] DB: {db_path}")
    print(f"[sync] Company: {company_info['name']} (slug={company_info['slug']}, "
          f"industry={company_info['industry'] or 'n/a'})")
    reseed_workspaces(db_path, departments, company_info, prune=args.prune)
    print("[sync] Done. Dashboard now reflects the client's real build-state.")


if __name__ == "__main__":
    main()
