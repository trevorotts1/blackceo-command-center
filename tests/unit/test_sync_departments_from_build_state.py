"""
Unit tests for scripts/sync-departments-from-build-state.py (P1-2 fix).

Covers the path-resolution fix that lets the sync script SEE the canonical
Zero-Human-Company root (master-files) instead of no-oping on every
current-generation box:

  - Mac layout   : ~/Downloads/openclaw-master-files/zero-human-company/<slug>/
  - VPS layout   : $MASTER_FILES_DIR/zero-human-company/<slug>/  (the same env
                   override the resolver honors; on a real VPS this default is
                   /data/openclaw-master-files/zero-human-company)
  - Legacy layout: ~/clawd/zero-human-company/<slug>/
  - Slug priority: build-state companySlug beats the most-recent-folder fallback
  - find_db()    : the VPS canonical /data/projects/command-center path resolves

Path resolution is REPLICATED from onboarding/shared-utils/detect_platform.py;
these tests pin that replication so the two trees cannot silently drift.

Hermetic: every test redirects HOME (so Path.home() -> tmp_path) and clears the
build/DB env vars, so nothing on the real box is read or written.
"""
import importlib.util
import json
import os
from pathlib import Path

import pytest

_SCRIPT = (
    Path(__file__).resolve().parent.parent.parent
    / "scripts"
    / "sync-departments-from-build-state.py"
)


def _load_module():
    """Import the hyphenated script file as a module (name != __main__)."""
    spec = importlib.util.spec_from_file_location("sync_departments_from_build_state", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mod = _load_module()

# A minimal but non-empty departments payload (empty -> _read_json returns None).
_DEPTS = [{"id": "dept-marketing", "name": "Marketing", "emoji": "\U0001f4e2"}]


def _write_company(root: Path, slug: str, depts=None) -> Path:
    """Create <root>/<slug>/departments.json and return its path."""
    company_dir = root / slug
    company_dir.mkdir(parents=True, exist_ok=True)
    dj = company_dir / "departments.json"
    dj.write_text(json.dumps(depts if depts is not None else _DEPTS))
    return dj


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    """Redirect HOME to an isolated dir and clear env that steers resolution."""
    monkeypatch.setenv("HOME", str(tmp_path))
    for var in (
        "MASTER_FILES_DIR",
        "COMPANY_SLUG",
        "COMPANY_NAME",
        "DASHBOARD_DB_PATH",
        "DATABASE_PATH",
        "OPENCLAW_COMPANY_SLUG",
    ):
        monkeypatch.delenv(var, raising=False)
    # Build-state resolves under HOME/.openclaw; pin it so no real /data is touched.
    monkeypatch.setattr(mod, "_oc_root", lambda: tmp_path / ".openclaw")
    return tmp_path


def _write_build_state(home: Path, payload: dict):
    bs = mod._build_state_path()
    bs.parent.mkdir(parents=True, exist_ok=True)
    bs.write_text(json.dumps(payload))
    return bs


# ---------------------------------------------------------------------------
# Layout coverage
# ---------------------------------------------------------------------------

def test_mac_layout_found(_clean_env):
    """Mac canonical: ~/Downloads/openclaw-master-files/zero-human-company/<slug>/."""
    home = _clean_env
    mac_root = home / "Downloads" / "openclaw-master-files" / "zero-human-company"
    dj = _write_company(mac_root, "acme-corp")

    data, source = mod.find_departments()

    assert data == _DEPTS
    assert source == str(dj)
    assert "Downloads/openclaw-master-files/zero-human-company" in source


def test_vps_layout_found_via_master_files_dir(_clean_env, monkeypatch):
    """VPS canonical honored through MASTER_FILES_DIR (resolver's env override).

    On a real VPS this default is /data/openclaw-master-files; that literal is
    unwritable in a test, so we exercise the same override the resolver honors
    and separately assert the /data literal is present (test_zhc_roots_*).
    """
    master = _clean_env / "vps-master"
    monkeypatch.setenv("MASTER_FILES_DIR", str(master))
    dj = _write_company(master / "zero-human-company", "acme-corp")

    data, source = mod.find_departments()

    assert data == _DEPTS
    assert source == str(dj)
    assert source.startswith(str(master))


def test_legacy_layout_found(_clean_env):
    """Legacy backward-compat: ~/clawd/zero-human-company/<slug>/ still readable."""
    home = _clean_env
    legacy_root = home / "clawd" / "zero-human-company"
    dj = _write_company(legacy_root, "acme-corp")
    # No canonical master-files company exists -> legacy must be used.
    assert not (home / "Downloads" / "openclaw-master-files").exists()

    data, source = mod.find_departments()

    assert data == _DEPTS
    assert source == str(dj)
    assert "clawd/zero-human-company" in source


def test_zhc_short_alias_root_found(_clean_env):
    """Legacy short alias ~/clawd/zhc/<slug>/ is still resolved."""
    home = _clean_env
    dj = _write_company(home / "clawd" / "zhc", "acme-corp")

    data, source = mod.find_departments()

    assert data == _DEPTS
    assert source == str(dj)


# ---------------------------------------------------------------------------
# Slug selection
# ---------------------------------------------------------------------------

def test_companyslug_priority_beats_most_recent_folder(_clean_env):
    """build-state companySlug wins even when another folder is more recent."""
    home = _clean_env
    mac_root = home / "Downloads" / "openclaw-master-files" / "zero-human-company"
    target_dj = _write_company(mac_root, "old-co")   # the companySlug target
    newer_dj = _write_company(mac_root, "new-co")     # most-recently-modified

    # Make new-co unambiguously newer than old-co on disk.
    os.utime(target_dj, (1_000_000, 1_000_000))
    os.utime(newer_dj, (2_000_000, 2_000_000))

    _write_build_state(home, {"companySlug": "old-co"})

    data, source = mod.find_departments()

    # Slug match must win over the newer folder.
    assert source == str(target_dj)
    assert "old-co" in source
    assert "new-co" not in source


def test_clientslug_fallback_when_no_companyslug(_clean_env):
    """When companySlug is absent, clientSlug is honored (transition support)."""
    home = _clean_env
    mac_root = home / "Downloads" / "openclaw-master-files" / "zero-human-company"
    target_dj = _write_company(mac_root, "legacy-co")
    newer_dj = _write_company(mac_root, "decoy-co")
    os.utime(target_dj, (1_000_000, 1_000_000))
    os.utime(newer_dj, (2_000_000, 2_000_000))

    _write_build_state(home, {"clientSlug": "legacy-co"})

    data, source = mod.find_departments()

    assert source == str(target_dj)
    assert "legacy-co" in source


def test_most_recent_folder_fallback_when_slug_unresolved(_clean_env, capsys):
    """No slug anywhere -> most-recent folder is used AND a loud warning fires."""
    home = _clean_env
    mac_root = home / "Downloads" / "openclaw-master-files" / "zero-human-company"
    older_dj = _write_company(mac_root, "older-co")
    newer_dj = _write_company(mac_root, "newer-co")
    os.utime(older_dj, (1_000_000, 1_000_000))
    os.utime(newer_dj, (2_000_000, 2_000_000))
    # No build-state file, no env slug.

    data, source = mod.find_departments()

    assert source == str(newer_dj)
    warning = capsys.readouterr().err
    assert "WARNING" in warning


# ---------------------------------------------------------------------------
# Structural pins (replication of detect_platform.py must not drift)
# ---------------------------------------------------------------------------

def test_zhc_roots_canonical_before_legacy(_clean_env):
    """Canonical master-files roots must be listed BEFORE legacy roots."""
    roots = [str(r) for r in mod._zhc_roots()]

    vps_canonical = "/data/openclaw-master-files/zero-human-company"
    mac_canonical = str(
        _clean_env / "Downloads" / "openclaw-master-files" / "zero-human-company"
    )
    legacy = str(_clean_env / "clawd" / "zero-human-company")
    legacy_alias = str(_clean_env / "clawd" / "zhc")
    vps_legacy = "/data/clawd/zero-human-company"

    for expected in (vps_canonical, mac_canonical, legacy, legacy_alias, vps_legacy):
        assert expected in roots, f"missing root: {expected}"

    # Both canonical defaults must precede every legacy root.
    assert roots.index(vps_canonical) < roots.index(legacy)
    assert roots.index(mac_canonical) < roots.index(legacy)
    assert roots.index(mac_canonical) < roots.index(vps_legacy)


def test_zhc_roots_master_files_dir_takes_priority(_clean_env, monkeypatch):
    """$MASTER_FILES_DIR/zero-human-company is scanned first when set."""
    master = _clean_env / "custom-master"
    monkeypatch.setenv("MASTER_FILES_DIR", str(master))
    roots = [str(r) for r in mod._zhc_roots()]
    assert roots[0] == str(master / "zero-human-company")


def test_find_db_resolves_vps_canonical(_clean_env, monkeypatch):
    """find_db() returns /data/projects/command-center/mission-control.db.

    Simulate a box where only the VPS canonical DB exists (real /data is
    unwritable in tests) by making Path.exists() true for that path alone.
    """
    vps_db = "/data/projects/command-center/mission-control.db"
    monkeypatch.setattr(mod.Path, "exists", lambda self: str(self) == vps_db)

    assert mod.find_db() == vps_db


def test_find_db_explicit_and_env_take_priority(_clean_env, monkeypatch, tmp_path):
    """Explicit arg and DATABASE_PATH still win over the candidate scan."""
    assert mod.find_db(explicit="/x/y.db") == "/x/y.db"
    monkeypatch.setenv("DATABASE_PATH", "/env/db.sqlite")
    assert mod.find_db() == "/env/db.sqlite"


# ---------------------------------------------------------------------------
# reseed_workspaces — Issue #13 (slug upsert crash) + Issue #11 (prune/adopt)
# ---------------------------------------------------------------------------
import sqlite3


_COMPANY_INFO = {
    "name": "Acme Corp", "slug": "acme-corp", "industry": "widgets",
    "brand_primary": "#1f2937", "brand_accent": "#3b82f6", "brand_text": "#f8fafc",
}


def _make_db(tmp_path):
    """Create a mission-control.db with the real companies/workspaces/tasks schema."""
    db_path = str(tmp_path / "mission-control.db")
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE companies (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
            industry TEXT, config TEXT DEFAULT '{}'
        );
        CREATE TABLE workspaces (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
            description TEXT, icon TEXT, company_id TEXT DEFAULT 'default'
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_id TEXT
        );
        """
    )
    conn.commit()
    conn.close()
    return db_path


def _workspaces(db_path):
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        "SELECT id, company_id FROM workspaces ORDER BY id").fetchall()
    conn.close()
    return dict(rows)


def _companies(db_path):
    conn = sqlite3.connect(db_path)
    rows = conn.execute("SELECT id, name, slug FROM companies ORDER BY id").fetchall()
    conn.close()
    return rows


def test_company_upsert_no_crash_on_slug_conflict_different_id(_clean_env):
    """Issue #13: an existing companies row with the SAME slug but a DIFFERENT id
    must not crash the sync (UNIQUE(slug) violation); it is updated in place."""
    home = _clean_env
    db_path = _make_db(home)
    # Pre-seed the company under a uuid id (the pre-fix seed path) with our slug.
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO companies (id, name, slug, industry) VALUES (?,?,?,?)",
        ("11111111-uuid", "Stale Name", "acme-corp", "old"))
    conn.commit()
    conn.close()

    # Must NOT raise sqlite3.IntegrityError.
    mod.reseed_workspaces(db_path, list(_DEPTS), dict(_COMPANY_INFO))

    companies = _companies(db_path)
    # Still exactly one company row (updated in place, not duplicated).
    assert len(companies) == 1
    cid, name, cslug = companies[0]
    assert cid == "11111111-uuid"   # kept the existing id
    assert cslug == "acme-corp"
    assert name == "Acme Corp"      # refreshed to the build's name


def test_company_upsert_fresh_insert(_clean_env):
    """No pre-existing company -> a new row is inserted with id == slug."""
    home = _clean_env
    db_path = _make_db(home)
    mod.reseed_workspaces(db_path, list(_DEPTS), dict(_COMPANY_INFO))
    companies = _companies(db_path)
    assert companies == [("acme-corp", "Acme Corp", "acme-corp")]


def test_adopt_workspace_seeded_under_default_company_id(_clean_env):
    """Issue #11: a workspace row seeded under company_id='default' is ADOPTED
    (re-homed to the real slug + refreshed), never duplicated or crashed on the
    PRIMARY KEY(id) INSERT."""
    home = _clean_env
    db_path = _make_db(home)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO workspaces (id, name, slug, description, icon, company_id) "
        "VALUES (?,?,?,?,?,?)",
        ("marketing", "Old Marketing", "marketing", "old", "\U0001f4c1", "default"))
    conn.commit()
    conn.close()

    depts = [{"id": "dept-marketing", "name": "Marketing", "emoji": "\U0001f4e2"}]
    mod.reseed_workspaces(db_path, depts, dict(_COMPANY_INFO))

    ws = _workspaces(db_path)
    # Exactly one 'marketing' row, re-homed to the real slug (no duplicate id).
    assert ws == {"marketing": "acme-corp"}


def test_prune_deletes_stale_empty_workspace(_clean_env):
    """--prune deletes a workspace that is no longer in the build and has no tasks."""
    home = _clean_env
    db_path = _make_db(home)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO workspaces (id, name, slug, description, icon, company_id) "
        "VALUES (?,?,?,?,?,?)",
        ("legacy-dept", "Legacy", "legacy-dept", "", "\U0001f4c1", "acme-corp"))
    conn.commit()
    conn.close()

    depts = [{"id": "dept-marketing", "name": "Marketing", "emoji": "\U0001f4e2"}]
    mod.reseed_workspaces(db_path, depts, dict(_COMPANY_INFO), prune=True)

    ws = _workspaces(db_path)
    assert "legacy-dept" not in ws          # pruned
    assert "marketing" in ws                # current build present


def test_prune_keeps_workspace_with_tasks(_clean_env, capsys):
    """--prune must NEVER delete a stale workspace that still holds tasks;
    it is kept and logged for operator review."""
    home = _clean_env
    db_path = _make_db(home)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO workspaces (id, name, slug, description, icon, company_id) "
        "VALUES (?,?,?,?,?,?)",
        ("legacy-dept", "Legacy", "legacy-dept", "", "\U0001f4c1", "acme-corp"))
    conn.execute("INSERT INTO tasks (id, title, workspace_id) VALUES (?,?,?)",
                 ("t1", "unfinished work", "legacy-dept"))
    conn.commit()
    conn.close()

    depts = [{"id": "dept-marketing", "name": "Marketing", "emoji": "\U0001f4e2"}]
    mod.reseed_workspaces(db_path, depts, dict(_COMPANY_INFO), prune=True)

    ws = _workspaces(db_path)
    assert "legacy-dept" in ws               # KEPT because it has tasks
    assert "KEPT stale workspace" in capsys.readouterr().out


def test_prune_never_deletes_reserved_system_workspaces(_clean_env):
    """--prune must leave reserved infra workspaces (bugs/general-task/default/
    master-orchestrator) alone even though they are absent from departments.json."""
    home = _clean_env
    db_path = _make_db(home)
    conn = sqlite3.connect(db_path)
    for wid in ("bugs", "general-task", "default", "master-orchestrator", "inbox"):
        conn.execute(
            "INSERT INTO workspaces (id, name, slug, description, icon, company_id) "
            "VALUES (?,?,?,?,?,?)",
            (wid, wid.title(), wid, "", "\U0001f4c1", "acme-corp"))
    conn.commit()
    conn.close()

    depts = [{"id": "dept-marketing", "name": "Marketing", "emoji": "\U0001f4e2"}]
    mod.reseed_workspaces(db_path, depts, dict(_COMPANY_INFO), prune=True)

    ws = _workspaces(db_path)
    for wid in ("bugs", "general-task", "default", "master-orchestrator", "inbox"):
        assert wid in ws, f"reserved workspace {wid} was wrongly pruned"


def test_prune_off_by_default_leaves_stale_rows(_clean_env):
    """Without --prune, stale workspaces are left in place (backward-compatible)."""
    home = _clean_env
    db_path = _make_db(home)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO workspaces (id, name, slug, description, icon, company_id) "
        "VALUES (?,?,?,?,?,?)",
        ("legacy-dept", "Legacy", "legacy-dept", "", "\U0001f4c1", "acme-corp"))
    conn.commit()
    conn.close()

    depts = [{"id": "dept-marketing", "name": "Marketing", "emoji": "\U0001f4e2"}]
    mod.reseed_workspaces(db_path, depts, dict(_COMPANY_INFO))  # prune defaults off

    ws = _workspaces(db_path)
    assert "legacy-dept" in ws               # not pruned when --prune absent


def test_reseed_prune_no_tasks_table_does_not_crash(_clean_env):
    """Prune is safe even if the tasks table does not exist yet (fresh DB)."""
    home = _clean_env
    db_path = str(home / "mc.db")
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE companies (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
            industry TEXT, config TEXT DEFAULT '{}'
        );
        CREATE TABLE workspaces (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
            description TEXT, icon TEXT, company_id TEXT DEFAULT 'default'
        );
        """
    )
    conn.execute(
        "INSERT INTO workspaces (id, name, slug, description, icon, company_id) "
        "VALUES (?,?,?,?,?,?)",
        ("legacy-dept", "Legacy", "legacy-dept", "", "\U0001f4c1", "acme-corp"))
    conn.commit()
    conn.close()

    depts = [{"id": "dept-marketing", "name": "Marketing", "emoji": "\U0001f4e2"}]
    # No tasks table -> treated as zero tasks -> stale row pruned, no crash.
    mod.reseed_workspaces(db_path, depts, dict(_COMPANY_INFO), prune=True)
    assert "legacy-dept" not in _workspaces(db_path)
