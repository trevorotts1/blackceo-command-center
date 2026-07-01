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
  python3 sync-departments-from-build-state.py --db /path/to/mission-control.db \
      --config /path/to/config/departments.json

Idempotent: re-running refreshes config/departments.json and upserts workspaces
(never duplicates). Safe to call from run-full-install.sh on every install/resume.
"""
import argparse
import json
import os
import re
import sqlite3
import sys
from pathlib import Path


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
        if root.is_dir():
            for entry in sorted(root.iterdir()):
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
    try:
        with open(path) as f:
            data = json.load(f)
        return data if data else None
    except (OSError, json.JSONDecodeError) as e:
        print(f"  [sync] skipping {path}: {e}", file=sys.stderr)
        return None


def find_db(explicit=None):
    if explicit:
        return explicit
    if os.environ.get("DATABASE_PATH"):
        return os.environ["DATABASE_PATH"]
    candidates = [
        Path.cwd() / "mission-control.db",
        Path.home() / "projects" / "command-center" / "mission-control.db",
        # VPS canonical: vps-docker-bootstrap.sh pins DATABASE_PATH here and
        # watchdog-cc.sh / atomic-deploy.sh resolve the /data install dir. Placed
        # right after the Mac ~/projects/command-center path (mirrors watchdog-cc.sh
        # which checks $HOME/projects/command-center then /data/projects/command-center).
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
        # Derive from the ZHC folder name (== company slug)
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


def reseed_workspaces(db_path, departments, company_info):
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

    slug = company_info["slug"]
    company_config = json.dumps({"brand": {
        "primary": company_info["brand_primary"],
        "accent": company_info["brand_accent"],
        "text": company_info["brand_text"],
    }})
    cur.execute("""
        INSERT INTO companies (id, name, slug, industry, config)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, industry=excluded.industry, config=excluded.config
    """, (slug, company_info["name"], slug, company_info["industry"], company_config))

    existing = {row[0] for row in cur.execute(
        "SELECT id FROM workspaces WHERE company_id=?", (slug,)).fetchall()}
    inserted = skipped = 0
    for dept in departments:
        raw_id = dept.get("id", "")
        dept_id = raw_id[5:] if raw_id.startswith("dept-") else raw_id
        if not dept_id:
            continue
        if dept_id in existing:
            skipped += 1
            continue
        cur.execute("""
            INSERT INTO workspaces (id, name, slug, description, icon, company_id)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (dept_id, dept["name"], dept_id,
              f"{dept['name']} department workspace",
              dept.get("emoji", "\U0001f4c1"), slug))
        inserted += 1
        print(f"  [sync] inserted workspace: {dept_id} ({dept['name']})")

    conn.commit()
    conn.close()
    print(f"  [sync] workspaces re-seeded. inserted={inserted} skipped={skipped} "
          f"total_in_build={len(departments)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--company-slug", default=None,
                    help="ZHC company slug to sync (default: build-state companySlug or most recent)")
    ap.add_argument("--db", default=None, help="Path to mission-control.db")
    ap.add_argument("--config", default=None,
                    help="Path to config/departments.json to regenerate")
    args = ap.parse_args()

    departments, source = find_departments(args.company_slug)
    if not departments:
        print("[sync] No ZHC departments.json found. "
              "Run Skill 23 (AI Workforce Blueprint) first. Nothing to sync.",
              file=sys.stderr)
        sys.exit(0)
    print(f"[sync] Source of truth: {source} ({len(departments)} departments)")

    config_path = args.config or str(Path(__file__).resolve().parent.parent / "config" / "departments.json")
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
    reseed_workspaces(db_path, departments, company_info)
    print("[sync] Done. Dashboard now reflects the client's real build-state.")


if __name__ == "__main__":
    main()
