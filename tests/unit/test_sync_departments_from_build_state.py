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
