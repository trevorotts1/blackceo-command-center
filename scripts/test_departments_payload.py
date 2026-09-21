"""Regression test for the departments.json ENVELOPE shape (2026-08-07 incident).

Ground truth on the client's box: `departments.json` was written as
`{"company": ..., "total_departments": N, "total_roles": N, "departments": [...]}`.
Both Python readers iterated whatever they parsed, so they walked the dict's
KEYS. seed-workspaces.py inserted four workspaces literally named Company /
Total Departments / Total Roles / Departments, and sync-departments-from-
build-state.py later crashed Phase 6c at `dept.get("id")` with
`AttributeError: 'str' object has no attribute 'get'`.

Covers the three required behaviours for each reader — bare list,
dict-with-departments, dict-without — plus the end-to-end proof that
reseed_workspaces() no longer seeds a metadata key as a workspace.

    python3 -m pytest scripts/test_departments_payload.py
"""
import importlib.util
import json
import os
import sqlite3
import sys

import pytest

_SCRIPTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_SCRIPTS), "shared-utils"))

from departments_payload import (  # noqa: E402
    MalformedDepartmentsError,
    departments_or_empty,
    normalize_departments,
)


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_SCRIPTS, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_sync = _load("sync_departments_from_build_state", "sync-departments-from-build-state.py")
_seed = _load("seed_workspaces", "seed-workspaces.py")

DEPTS = [
    {"id": "dept-marketing", "name": "Marketing", "emoji": "\U0001f4e3"},
    {"id": "dept-sales", "name": "Sales", "emoji": "\U0001f4b0"},
]
ENVELOPE = {"company": "Acme", "total_departments": 2, "total_roles": 18, "departments": DEPTS}
METADATA_ONLY = {"company": "Acme", "total_departments": 34, "total_roles": 416}
# The shape verified on a client box: the 'departments' KEY holds a dict of
# department objects keyed by slug, not a list.
KEYED_ENVELOPE = {
    "company": "Acme", "total_departments": 2, "total_roles": 18,
    "departments": {
        "account-management-dept": {"name": "Account Management"},
        "app-development-dept": {"name": "App Development"},
    },
}


# ── the normalizer itself: the three shapes ────────────────────────────────

def test_bare_list_passes_through():
    assert normalize_departments(DEPTS) is DEPTS


def test_dict_with_departments_is_unwrapped():
    assert normalize_departments(ENVELOPE) == DEPTS
    # the retirement script's audit-trail shape is the same envelope
    assert normalize_departments(
        {"removedWithProvenance": [{"slug": "legal"}], "departments": DEPTS}) == DEPTS


def test_dict_without_departments_is_refused_naming_path_and_type():
    with pytest.raises(MalformedDepartmentsError) as exc:
        normalize_departments(METADATA_ONLY, path="/tmp/departments.json")
    msg = str(exc.value)
    assert "/tmp/departments.json" in msg
    assert "dict" in msg
    # the metadata keys must never surface as departments
    assert "Total Departments" not in msg.title()


def test_dict_of_dicts_keyed_by_slug_is_folded():
    assert normalize_departments({"marketing": {"name": "Marketing"}}) == [
        {"name": "Marketing", "id": "marketing", "slug": "marketing"}
    ]


def test_departments_key_holding_a_dict_of_dicts_is_folded():
    # The shape a real client box ships: the 'departments' KEY holds a MAP of 34
    # objects keyed by department slug, not a list. v7.6.29 refused this with
    # "'departments' key holds dict, expected a list" and failed Phase 6c.
    assert normalize_departments(KEYED_ENVELOPE) == [
        {"name": "Account Management", "id": "account-management-dept",
         "slug": "account-management-dept"},
        {"name": "App Development", "id": "app-development-dept",
         "slug": "app-development-dept"},
    ]


def test_folding_keeps_an_entrys_own_id_and_only_fills_what_is_missing():
    assert normalize_departments(
        {"departments": {"marketing": {"id": "dept-marketing", "name": "Marketing"}}}
    ) == [{"id": "dept-marketing", "name": "Marketing", "slug": "marketing"}]
    assert normalize_departments(
        {"departments": {"marketing": {"id": "dept-marketing", "slug": "mktg"}}}
    ) == [{"id": "dept-marketing", "slug": "mktg"}]


@pytest.mark.parametrize("payload", [
    {"departments": {"marketing": "yes"}},  # a value that is not an object
    {"departments": {"marketing": ["a"]}},  # a list is not a department object
    {"departments": {}},                    # empty is not a department map
    {"departments": 42},
])
def test_departments_key_holding_a_non_map_is_still_refused(payload):
    with pytest.raises(MalformedDepartmentsError) as exc:
        normalize_departments(payload, path="/tmp/departments.json")
    assert "'departments' key holds" in str(exc.value)


def test_departments_or_empty_never_raises():
    assert departments_or_empty(METADATA_ONLY, path="/tmp/departments.json") == []
    assert departments_or_empty(ENVELOPE) == DEPTS


# ── sync-departments-from-build-state.py: _read_json is the load boundary ──

def _write(tmp_path, payload):
    p = tmp_path / "departments.json"
    p.write_text(json.dumps(payload))
    return p


@pytest.mark.parametrize("payload", [DEPTS, ENVELOPE])
def test_sync_read_json_returns_the_list_for_both_shapes(tmp_path, payload):
    assert _sync._read_json(_write(tmp_path, payload)) == DEPTS


def test_sync_read_json_reads_the_slug_keyed_envelope(tmp_path):
    # Phase 6c's load boundary. This is the payload that made v7.6.29 print
    # "[sync] FATAL: departments.json: 'departments' key holds dict, expected a list".
    got = _sync._read_json(_write(tmp_path, KEYED_ENVELOPE))
    assert [d["id"] for d in got] == ["account-management-dept", "app-development-dept"]


def test_sync_read_json_refuses_a_metadata_envelope(tmp_path):
    # Skipping would silently fall through to ANOTHER company's departments.json
    # and sync the wrong client's board, so this one must raise.
    with pytest.raises(MalformedDepartmentsError):
        _sync._read_json(_write(tmp_path, METADATA_ONLY))


def test_sync_read_json_still_skips_unparseable_json(tmp_path):
    p = tmp_path / "departments.json"
    p.write_text("{not json")
    assert _sync._read_json(p) is None


# ── the crash itself: reseed_workspaces no longer walks dict keys ──────────

def _company():
    return {"slug": "acme", "name": "Acme", "industry": "Widgets",
            "brand_primary": "#000", "brand_accent": "#111", "brand_text": "#222"}


def test_reseed_workspaces_seeds_real_departments_not_metadata_keys(tmp_path):
    db = str(tmp_path / "mission-control.db")
    departments = _sync._read_json(_write(tmp_path, ENVELOPE))
    _sync.reseed_workspaces(db, departments, _company())

    conn = sqlite3.connect(db)
    names = {row[0] for row in conn.execute("SELECT name FROM workspaces").fetchall()}
    conn.close()
    assert names == {"Marketing", "Sales"}
    # the four bogus workspaces from the live incident
    assert not names & {"Company", "Total Departments", "Total Roles", "Departments"}


def test_reseed_workspaces_crashed_on_the_raw_envelope_before_the_fix(tmp_path):
    # Mutation proof: feeding reseed_workspaces the UNNORMALIZED dict still
    # reproduces the exact live failure, so the test above cannot pass vacuously.
    with pytest.raises(AttributeError, match="'str' object has no attribute 'get'"):
        _sync.reseed_workspaces(str(tmp_path / "raw.db"), ENVELOPE, _company())


# ── seed-workspaces.py: same shapes, lenient contract ─────────────────────

def _seed_config_at(tmp_path, monkeypatch, payload):
    """Plant a departments.json at seed-workspaces.py's first candidate path."""
    cfg = tmp_path / "projects" / "mission-control" / "config" / "departments.json"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(json.dumps(payload))
    monkeypatch.setattr(_seed.Path, "home", staticmethod(lambda: tmp_path))
    return cfg


@pytest.mark.parametrize("payload", [DEPTS, ENVELOPE])
def test_seed_find_departments_config_reads_both_shapes(tmp_path, monkeypatch, payload):
    cfg = _seed_config_at(tmp_path, monkeypatch, payload)
    departments, source = _seed.find_departments_config()
    assert departments == DEPTS
    assert source == str(cfg)


def test_seed_find_departments_config_degrades_to_none_on_a_metadata_envelope(
    tmp_path, monkeypatch, capsys
):
    # Lenient by design: this reader falls back to scanning Skill 23 folders, so
    # "nothing here" sends it down that path instead of seeding four bogus
    # workspaces named after the envelope's metadata keys.
    _seed_config_at(tmp_path, monkeypatch, METADATA_ONLY)
    departments, source = _seed.find_departments_config()
    assert departments is None and source is None
    assert "MALFORMED" in capsys.readouterr().err


def test_seed_seeded_metadata_keys_before_the_fix(tmp_path):
    # Mutation proof for the lenient path: handed the raw envelope, seed() still
    # walks its keys, so the guard above is doing real work.
    with pytest.raises(TypeError, match="string indices must be integers"):
        _seed.seed(str(tmp_path / "raw.db"), METADATA_ONLY, "Acme")
