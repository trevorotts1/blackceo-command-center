#!/usr/bin/env python3
"""
ingest-sop-library-from-disk.py

Ingests the CLIENT'S REAL on-disk Standard Operating Procedure (SOP) library —
the DMAIC SOP markdown files Skill 23 (AI Workforce Blueprint) builds under
each role workspace — into the Command Center `sops` table, so every client's
dashboard shows THEIR built SOP library instead of the 17 generic starter SOPs.

WHY THIS EXISTS (the gap this closes):
  Through v4.1.9 the only writers of the `sops` table were:
    - scripts/seed-starter-sops.ts  -> 17 hardcoded generic starter SOPs
    - src/lib/sop-learning.ts        -> runtime AI-evolved SOPs
    - POST /api/sops                 -> manual UI creation
  Nothing read the client's real built SOP library off disk. Skill 32 shipped an
  `ingest-sop-library.py` but it requires a `sops.jsonl` that NOTHING in either
  onboarding repo ever produces, and `run-full-install.sh` never calls it. Net:
  a client could build 900-1,100 real DMAIC SOPs and the dashboard still showed
  only the 17 generic starters. This script closes that gap from the Command
  Center side with ZERO dependency on a JSONL export — it reads the real .md
  files directly.

ON-DISK LAYOUT (verified against Skill 23 create_role_workspaces.py):
  <zhc-root>/<company-slug>/departments/<dept>/roles/<role>/
      how-to.md            <- the role's primary procedure (entry point)
      SOP/
        00-INDEX.md        <- table of contents (skipped on ingest)
        NN-<topic>.md      <- individual SOPs, numbered in execution order
  Older / alternate trees also seen: <root>/<slug>/sops/<dept>/<role>/*.md and
  workspace-level departments/*/roles/*/sops/*.md — all are matched.

SOURCE OF TRUTH (priority order, mirrors sync-departments-from-build-state.py):
  1. build-state companySlug -> ~/clawd/zero-human-company/<slug>/
  2. $COMPANY_SLUG env / --company-slug override
  3. Most-recently-modified ~/clawd/zero-human-company/<slug>/ (or ~/clawd/zhc/<slug>/)
  4. The OpenClaw workspace itself (~/.openclaw/workspace or /data/.openclaw/workspace)

USAGE:
  python3 ingest-sop-library-from-disk.py
  python3 ingest-sop-library-from-disk.py --company-slug acme-corp
  python3 ingest-sop-library-from-disk.py --root /path/to/zhc/acme-corp --db /path/to/mission-control.db
  python3 ingest-sop-library-from-disk.py --dry-run

Idempotent: every SOP is keyed by a stable slug derived from its dept + relative
path; re-running UPSERTs (INSERT OR REPLACE on slug). Safe to call from
run-full-install.sh on every install/resume, and from the dashboard's own
db:seed:sops:disk npm script.
"""
import argparse
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

# Canonical 16-dept emoji/name hints (kept aligned with the canonical dept IDs,
# NOT the legacy support/operations/creative/hr/it slugs that caused zero-role
# departments elsewhere). Only used for the `department` slug normalization.
CANONICAL_DEPT_ALIASES = {
    "customer-support": "customer-support", "support": "customer-support",
    "hr-people": "hr-people", "hr": "hr-people", "people": "hr-people",
    "legal-compliance": "legal-compliance", "legal": "legal-compliance",
    "it-tech": "it-tech", "it": "it-tech", "tech": "it-tech",
    "web-development": "web-development", "webdev": "web-development",
    "app-development": "app-development", "appdev": "app-development",
    "master-orchestrator": "master-orchestrator", "ceo": "ceo",
    "paid-advertisement": "paid-advertisement", "paid-ads": "paid-advertisement",
    "social-media": "social-media", "social": "social-media",
    "graphics": "graphics", "video": "video", "audio": "audio",
    "marketing": "marketing", "sales": "sales", "billing": "billing",
    "crm": "crm", "research": "research", "operations": "operations",
    "creative": "creative",
}

SKIP_FILENAMES = {"00-index.md", "index.md", "readme.md", "00-start-here.md"}


def oc_root():
    if Path("/data/.openclaw").is_dir():
        return Path("/data/.openclaw")
    return Path.home() / ".openclaw"


def load_build_state():
    p = oc_root() / "workspace" / ".workforce-build-state.json"
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def zhc_roots():
    return [
        Path.home() / "clawd" / "zero-human-company",
        Path.home() / "clawd" / "zhc",
    ]


def find_company_root(company_slug=None, explicit_root=None):
    """Locate the client's real ZHC company root that holds departments/."""
    if explicit_root:
        return Path(explicit_root)

    target = (company_slug or os.environ.get("COMPANY_SLUG", "")).strip()
    if not target:
        target = (load_build_state().get("companySlug") or "").strip()

    candidates = []
    for root in zhc_roots():
        if root.is_dir():
            for entry in sorted(root.iterdir()):
                if entry.is_dir() and not entry.name.startswith("."):
                    candidates.append(entry)

    # 1. Exact slug match
    if target:
        for c in candidates:
            if c.name == target:
                return c

    # 2. Most-recently-modified company dir that actually has SOP-bearing files
    scored = []
    for c in candidates:
        if _has_sops(c):
            scored.append((c.stat().st_mtime, c))
    if scored:
        scored.sort(reverse=True)
        return scored[0][1]

    # 3. Fall back to the OpenClaw workspace itself
    ws = oc_root() / "workspace"
    if _has_sops(ws):
        return ws

    return None


def _has_sops(root: Path) -> bool:
    if not root.is_dir():
        return False
    # Any role-level how-to.md, any SOP/ folder, or any */roles/*/sops/*.md
    for pat in ("departments/*/roles/*/how-to.md",
                "departments/*/roles/*/SOP/*.md",
                "departments/*/roles/*/sops/*.md",
                "sops/*/*/*.md"):
        for _ in root.glob(pat):
            return True
    return False


def normalize_dept(raw: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")
    return CANONICAL_DEPT_ALIASES.get(s, s)


def slugify(*parts) -> str:
    joined = "-".join(p for p in parts if p)
    s = re.sub(r"[^a-z0-9]+", "-", joined.lower()).strip("-")
    return s[:120] or "sop"


def discover_sop_files(company_root: Path):
    """Return [(dept_slug, role_slug, file_path, is_primary)] for every SOP doc."""
    seen = set()
    out = []

    def emit(dept, role, fp, primary):
        rp = fp.resolve()
        if rp in seen:
            return
        if fp.name.lower() in SKIP_FILENAMES:
            return
        seen.add(rp)
        out.append((dept, role, fp, primary))

    # Layout A: departments/<dept>/roles/<role>/how-to.md + SOP|sops/*.md
    for role_dir in company_root.glob("departments/*/roles/*"):
        if not role_dir.is_dir():
            continue
        dept = role_dir.parent.parent.name
        role = role_dir.name
        howto = role_dir / "how-to.md"
        if howto.exists():
            emit(dept, role, howto, True)
        for sop_sub in ("SOP", "sops"):
            sub = role_dir / sop_sub
            if sub.is_dir():
                for fp in sorted(sub.glob("*.md")):
                    emit(dept, role, fp, False)

    # Layout B: sops/<dept>/<role>/*.md (alternate tree seen on some clients)
    for fp in sorted(company_root.glob("sops/*/*/*.md")):
        dept = fp.parent.parent.name
        role = fp.parent.name
        emit(dept, role, fp, False)

    return out


# DMAIC + common section headers we treat as step boundaries.
STEP_HEADER_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.*\S)\s*$")
NUM_STEP_RE = re.compile(r"^\s{0,3}(?:\d+[.)]|[-*])\s+(.*\S)\s*$")


def parse_markdown_to_sop(text: str, fallback_name: str):
    """Parse a DMAIC SOP markdown doc into (name, description, steps[], success_criteria, keywords)."""
    lines = text.splitlines()
    name = fallback_name
    # First H1 becomes the name; strip a trailing "(stub)" marker.
    for ln in lines:
        m = re.match(r"^\s*#\s+(.+?)\s*$", ln)
        if m:
            name = re.sub(r"\s*\(stub\)\s*$", "", m.group(1)).strip()
            break

    # First non-empty, non-heading, non-bullet paragraph -> description.
    description = ""
    for ln in lines:
        s = ln.strip()
        if not s or s.startswith("#") or s.startswith(">") or s.startswith("-") or s.startswith("*"):
            continue
        description = s[:500]
        break

    # Steps: prefer H2/H3 sections; collect their bullet children as checklist.
    steps = []
    current = None
    success_criteria = ""
    for ln in lines:
        hm = re.match(r"^\s{0,3}(#{2,4})\s+(.*\S)\s*$", ln)
        if hm:
            title = hm.group(2).strip()
            low = title.lower()
            if "success" in low or "acceptance" in low or "definition of done" in low:
                # capture as success criteria target; following lines append
                current = {"_collect_success": True, "name": title, "checklist": []}
                steps.append(current) if False else None
                current = {"name": title, "checklist": [], "_success": True}
                continue
            current = {"name": title, "checklist": []}
            steps.append(current)
            continue
        bm = NUM_STEP_RE.match(ln)
        if bm and current is not None:
            item = bm.group(1).strip()
            if current.get("_success"):
                success_criteria += (("; " if success_criteria else "") + item)
            else:
                current["checklist"].append(item[:300])

    # Strip helper flags and empty checklists.
    cleaned = []
    for st in steps:
        if st.get("_success"):
            continue
        out = {"name": st["name"][:200]}
        if st["checklist"]:
            out["checklist"] = st["checklist"][:25]
        cleaned.append(out)

    # Fallback: no headings parsed -> use numbered list, else the whole doc.
    if not cleaned:
        bullets = [NUM_STEP_RE.match(ln).group(1).strip()
                   for ln in lines if NUM_STEP_RE.match(ln)]
        if bullets:
            cleaned = [{"name": "Procedure", "checklist": bullets[:25]}]
        else:
            body = "\n".join(ln for ln in lines if ln.strip())[:1500]
            cleaned = [{"name": "Procedure",
                        "checklist": [body] if body else ["See source document."]}]

    # Keywords: name words + first H2 titles, deduped.
    kw = set()
    for w in re.findall(r"[a-z]{4,}", name.lower()):
        kw.add(w)
    for st in cleaned[:6]:
        for w in re.findall(r"[a-z]{4,}", st["name"].lower()):
            kw.add(w)
    keywords = ",".join(sorted(kw)[:12])

    return name, description, cleaned, success_criteria, keywords


def find_db(explicit=None):
    if explicit:
        return explicit
    if os.environ.get("DATABASE_PATH"):
        return os.environ["DATABASE_PATH"]
    candidates = [
        Path.cwd() / "mission-control.db",
        Path.home() / "projects" / "command-center" / "mission-control.db",
        Path.home() / "projects" / "mission-control" / "mission-control.db",
        Path("/data/projects/command-center/mission-control.db"),
        Path("/opt/mission-control/mission-control.db"),
        Path("/app/mission-control.db"),
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return None


def ensure_sops_table(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sops (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          department TEXT,
          task_keywords TEXT,
          steps TEXT NOT NULL,
          success_criteria TEXT,
          persona_hints TEXT,
          deleted_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_sops_department ON sops(department)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_sops_slug ON sops(slug)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_sops_deleted ON sops(deleted_at)")
    # Optional V2 columns the dashboard's own ingester may add; populate if present.
    existing = {c[1] for c in cur.execute("PRAGMA table_info(sops)")}
    return existing


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--company-slug", default=None)
    ap.add_argument("--root", default=None,
                    help="Explicit ZHC company root containing departments/")
    ap.add_argument("--db", default=None, help="Path to mission-control.db")
    ap.add_argument("--dry-run", action="store_true",
                    help="Parse + report counts without writing to the DB")
    args = ap.parse_args()

    company_root = find_company_root(args.company_slug, args.root)
    if not company_root:
        print("[ingest-sop-disk] No ZHC SOP library found on disk. "
              "Run Skill 23 (AI Workforce Blueprint) first. Nothing to ingest.",
              file=sys.stderr)
        sys.exit(0)
    print(f"[ingest-sop-disk] Source: {company_root}")

    sop_files = discover_sop_files(company_root)
    if not sop_files:
        print(f"[ingest-sop-disk] No SOP .md files under {company_root}. Nothing to ingest.",
              file=sys.stderr)
        sys.exit(0)
    print(f"[ingest-sop-disk] Discovered {len(sop_files)} SOP documents on disk.")

    rows = []
    for dept_raw, role_raw, fp, primary in sop_files:
        try:
            text = fp.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            print(f"  [skip] {fp}: {e}", file=sys.stderr)
            continue
        dept = normalize_dept(dept_raw)
        fallback = fp.stem.replace("-", " ").replace("_", " ").title()
        name, desc, steps, success, keywords = parse_markdown_to_sop(text, fallback)
        # Stable slug: dept + role + filename stem (primary how-to gets -overview).
        stem = "overview" if primary else fp.stem
        slug = slugify(dept, role_raw, stem)
        rows.append({
            "slug": slug,
            "name": name,
            "description": desc,
            "department": dept,
            "task_keywords": keywords,
            "steps": json.dumps(steps, default=str),
            "success_criteria": success,
            "persona_hints": json.dumps([]),
            "source_role": role_raw,
            "source_file_url": str(fp),
        })

    by_dept = {}
    for r in rows:
        by_dept[r["department"]] = by_dept.get(r["department"], 0) + 1
    print(f"[ingest-sop-disk] Parsed {len(rows)} SOPs across {len(by_dept)} departments:")
    for d in sorted(by_dept):
        print(f"    {d}: {by_dept[d]}")

    if args.dry_run:
        print("[ingest-sop-disk] DRY RUN — no DB writes.")
        sys.exit(0)

    db_path = find_db(args.db)
    if not db_path:
        print("[ingest-sop-disk] mission-control.db not found — parsed but not ingested.",
              file=sys.stderr)
        sys.exit(0)

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    existing_cols = ensure_sops_table(cur)
    has_source_role = "source_role" in existing_cols
    has_source_url = "source_file_url" in existing_cols
    has_layer = "layer_version" in existing_cols

    inserted = 0
    for r in rows:
        # created_at/updated_at are left to the column DEFAULT (datetime('now')).
        cols = ["id", "name", "slug", "description", "version", "department",
                "task_keywords", "steps", "success_criteria", "persona_hints"]
        vals = ["sop_" + r["slug"].replace("-", "_")[:100], r["name"], r["slug"],
                r["description"], 1, r["department"], r["task_keywords"],
                r["steps"], r["success_criteria"], r["persona_hints"]]
        if has_source_role:
            cols.append("source_role"); vals.append(r["source_role"])
        if has_source_url:
            cols.append("source_file_url"); vals.append(r["source_file_url"])
        if has_layer:
            cols.append("layer_version"); vals.append("disk")
        placeholders = ",".join("?" * len(cols))
        try:
            cur.execute(
                f"INSERT OR REPLACE INTO sops ({','.join(cols)}) VALUES ({placeholders})",
                vals)
            inserted += 1
        except Exception as e:
            print(f"  [upsert fail] {r['slug']}: {e}", file=sys.stderr)

    conn.commit()
    total = cur.execute("SELECT COUNT(*) FROM sops WHERE deleted_at IS NULL").fetchone()[0]
    conn.close()
    print(f"[ingest-sop-disk] Upserted {inserted} SOPs from disk. "
          f"Total live SOPs in dashboard: {total}")
    print("[ingest-sop-disk] Done. Dashboard now reflects the client's real SOP library.")


if __name__ == "__main__":
    main()
