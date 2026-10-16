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
import subprocess
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
# The client's real entries name their own folder; the map key carries a
# "-dept" suffix that is NOT the department's slug.
KEYED_ENVELOPE = {
    "company": "Acme", "total_departments": 2, "total_roles": 18,
    "departments": {
        "account-management-dept": {"name": "Account Management",
                                    "folder": "account-management"},
        "app-development-dept": {"name": "App Development",
                                 "folder": "app-development"},
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


def test_the_entrys_own_folder_beats_a_dept_suffixed_map_key():
    # The client shape that put 34 duplicate workspace rows on a board: the map
    # is keyed "<name>-dept" while the entry names its real folder. The ENTRY wins.
    assert normalize_departments(
        {"account-management-dept": {"name": "Account Management",
                                     "folder": "account-management",
                                     "emoji": "\U0001f91d"}}
    ) == [{"name": "Account Management", "folder": "account-management",
           "emoji": "\U0001f91d", "id": "account-management",
           "slug": "account-management"}]


def test_slug_precedence_is_id_then_slug_then_folder_then_key():
    def one(entry, key="account-management-dept"):
        return normalize_departments({key: entry})[0]

    assert one({"id": "own-id", "slug": "own-slug", "folder": "own-folder"})["slug"] == "own-slug"
    assert one({"id": "own-id", "slug": "own-slug", "folder": "own-folder"})["id"] == "own-id"
    assert one({"slug": "own-slug", "folder": "own-folder"})["id"] == "own-slug"
    assert one({"folder": "own-folder"})["id"] == "own-folder"
    assert one({"folder": "own-folder"})["slug"] == "own-folder"
    # nothing of its own: the key, with its "-dept" suffix stripped
    assert one({"name": "Account Management"})["id"] == "account-management"
    # an empty string is not an identity
    assert one({"id": "", "folder": "own-folder"})["id"] == "own-folder"


def test_a_dept_suffix_is_stripped_only_when_the_slug_came_from_the_key():
    # from the key: stripped
    assert normalize_departments({"billing-dept": {"name": "Billing"}})[0]["slug"] == "billing"
    # the entry's OWN value is never rewritten, suffix and all
    assert normalize_departments(
        {"billing-dept": {"folder": "billing-dept"}})[0]["slug"] == "billing-dept"
    assert normalize_departments(
        {"billing-dept": {"slug": "billing-dept"}})[0]["id"] == "billing-dept"
    # a key that is only the suffix is left alone
    assert normalize_departments({"-dept": {"name": "Odd"}})[0]["id"] == "-dept"


def test_a_key_only_entry_still_keeps_a_plain_key():
    assert normalize_departments({"marketing": {"name": "Marketing"}})[0]["id"] == "marketing"


def test_departments_key_holding_a_dict_of_dicts_is_folded():
    # The shape a real client box ships: the 'departments' KEY holds a MAP of 34
    # objects keyed by department slug, not a list. v7.6.29 refused this with
    # "'departments' key holds dict, expected a list" and failed Phase 6c.
    assert normalize_departments(KEYED_ENVELOPE) == [
        {"name": "Account Management", "folder": "account-management",
         "id": "account-management", "slug": "account-management"},
        {"name": "App Development", "folder": "app-development",
         "id": "app-development", "slug": "app-development"},
    ]


def test_folding_keeps_an_entrys_own_id_and_only_fills_what_is_missing():
    assert normalize_departments(
        {"departments": {"marketing": {"id": "dept-marketing", "name": "Marketing"}}}
    ) == [{"id": "dept-marketing", "name": "Marketing", "slug": "dept-marketing"}]
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
    assert [d["id"] for d in got] == ["account-management", "app-development"]


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


# ── the WRITE paths: what actually lands in config/departments.json ────────
#
# Ground truth from a client box's installer backups: cc-backup-20260921-091809
# held a clean LIST of 34 departments; cc-backup-20260921-093039, taken after a
# v7.6.26 update run, held the raw object shape
# `{company, total_departments: 34, total_roles, departments: {<slug>: {...}}}`.
#
# The writer was NOT the `--merge` path. `merge_config()` forces its accumulator
# to a list (`if not isinstance(existing, list): existing = []`) and dumps only
# that accumulator, at v7.6.26 byte for byte as today, so it cannot emit a
# non-list at any version — pinned below. The writer was the DEFAULT overwrite
# path, `write_config()`, which dumps its argument straight through: install
# PHASE 6c and the updater's Command Center refresh both run the sync with NO
# `--merge` flag, and before v7.6.29 the load boundary handed that argument over
# unnormalized. The normalizer at `_read_json` is what closes it; these pin that
# it stays closed on both paths.

SYNC_SCRIPT = os.path.join(_SCRIPTS, "sync-departments-from-build-state.py")
FIXTURE_SLUG = "zzz-pytest-fixture-co"

# 34 departments keyed by slug under the `departments` key — the client's shape.
# Department 07's folder deliberately does NOT match its key minus "-dept", so
# these cases fail if the fold falls back to the key for an entry that names its
# own folder. Every other entry mirrors the client artifact exactly.
KEYED_34 = {
    f"department-{i:02d}-dept": {
        "name": f"Department {i:02d}",
        "folder": ("department-07-renamed" if i == 7 else f"department-{i:02d}"),
        "emoji": "\U0001f4c1",
    }
    for i in range(1, 35)
}
# The bare slug each entry actually owns — what both readers must agree on.
BARE_34 = [v["folder"] for v in KEYED_34.values()]
CLIENT_ARTIFACT_34 = {
    "company": "Acme", "total_departments": 34, "total_roles": 416,
    "departments": KEYED_34,
}
# The local config as it stood BEFORE the corrupting run: the first 33 of those
# departments as a flat list, plus one department the box owner added by hand.
CUSTOM_ENTRY = {"id": "custom-ops-dept", "name": "Custom Ops", "emoji": "\u2699\ufe0f"}
EXISTING_33_PLUS_CUSTOM = [
    {"id": v["folder"], "name": v["name"], "emoji": v["emoji"]}
    for v in list(KEYED_34.values())[:33]
] + [CUSTOM_ENTRY]


def _run_sync(tmp_path, artifact, *extra_args, existing=EXISTING_33_PLUS_CUSTOM,
              db=None, times=1):
    """Drive the real sync CLI against a hermetic ZHC root. Returns (proc, config_path).

    `MASTER_FILES_DIR` is the same override the resolver honors, and `HOME` and
    the working directory are redirected into the tmp tree, so no root this
    scans and no database candidate can reach a real box's files.
    """
    company = tmp_path / "master-files" / "zero-human-company" / FIXTURE_SLUG
    company.mkdir(parents=True)
    (company / "departments.json").write_text(json.dumps(artifact))

    home = tmp_path / "home"
    home.mkdir()
    config = tmp_path / "cc" / "config" / "departments.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps(existing, indent=2) + "\n")

    env = dict(os.environ)
    env["MASTER_FILES_DIR"] = str(tmp_path / "master-files")
    env["HOME"] = str(home)
    for k in ("DASHBOARD_DB_PATH", "DATABASE_PATH", "COMPANY_SLUG"):
        env.pop(k, None)

    argv = [sys.executable, SYNC_SCRIPT, "--config", str(config),
            "--company-slug", FIXTURE_SLUG, *extra_args]
    if db is not None:
        argv += ["--db", str(db)]
    for _ in range(times):
        proc = subprocess.run(argv, cwd=str(home), env=env,
                              capture_output=True, text=True, timeout=180)
    return proc, config


def test_merge_writes_a_list_from_the_slug_keyed_artifact_and_keeps_custom_entries(tmp_path):
    proc, config = _run_sync(tmp_path, CLIENT_ARTIFACT_34, "--merge")
    assert proc.returncode == 0, proc.stderr

    written = json.loads(config.read_text())
    assert isinstance(written, list), f"config must be a LIST, got {type(written).__name__}"
    # 33 updated in place + the 34th appended + the owner's custom department kept.
    assert len(written) == 35
    ids = [e["id"] for e in written]
    assert set(ids) == set(BARE_34) | {"custom-ops-dept"}
    assert len(ids) == len(set(ids)), "no duplicate ids"
    # every id is the entry's own folder, never the "-dept" map key
    assert not [i for i in ids if i.endswith("-dept") and i != "custom-ops-dept"]
    appended = next(e for e in written if e["id"] == "department-34")
    assert appended["name"] == "Department 34"
    # the custom department the box owner added is untouched
    assert CUSTOM_ENTRY in written
    # and none of the envelope's metadata keys became a department
    assert not {"company", "total_departments", "total_roles", "departments"} & set(ids)


def test_the_default_overwrite_path_also_writes_a_list_from_the_same_artifact(tmp_path):
    # PHASE 6c and the updater's CC refresh run the sync with NO --merge, and this
    # is the path that wrote the object shape on the client box before v7.6.29.
    proc, config = _run_sync(tmp_path, CLIENT_ARTIFACT_34)
    assert proc.returncode == 0, proc.stderr

    written = json.loads(config.read_text())
    assert isinstance(written, list), f"config must be a LIST, got {type(written).__name__}"
    assert [e["id"] for e in written] == BARE_34


@pytest.mark.parametrize("bad", [
    METADATA_ONLY,                            # no departments key at all
    {"departments": {"marketing": "yes"}},    # a value that is not an object
    {"departments": {}},                      # empty is not a department map
])
@pytest.mark.parametrize("flags", [(), ("--merge",)])
def test_a_refused_artifact_leaves_the_config_byte_identical(tmp_path, bad, flags):
    # The control for the two above: a shape the normalizer refuses must abort
    # BEFORE any write, on both paths. A partial write here would be worse than
    # the crash it replaced.
    before = json.dumps(EXISTING_33_PLUS_CUSTOM, indent=2) + "\n"
    proc, config = _run_sync(tmp_path, bad, *flags)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "[sync] FATAL" in proc.stderr
    assert config.read_text() == before, "a refused artifact must not touch the config file"


def test_merge_config_cannot_write_a_non_list_even_handed_the_raw_object(tmp_path):
    # Evidence that the --merge path was never the writer of the corrupted file:
    # handed the RAW unnormalized object, iterating it yields string keys, every
    # one is skipped, and the accumulator it dumps is the local list unchanged.
    config = tmp_path / "config" / "departments.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps(EXISTING_33_PLUS_CUSTOM))
    _sync.merge_config(str(config), CLIENT_ARTIFACT_34)

    written = json.loads(config.read_text())
    assert isinstance(written, list)
    assert written == EXISTING_33_PLUS_CUSTOM


def test_without_the_normalizer_the_object_shape_reaches_the_config_file(tmp_path, monkeypatch):
    # Mutation proof, and the v7.6.26 repro. Flip exactly one thing — the
    # normalizer at the load boundary — and the default write path dumps the raw
    # object into config/departments.json, which is what the installer backups
    # caught. With the real normalizer the same two calls write a list, so the
    # tests above cannot be passing for any other reason.
    monkeypatch.setattr(_sync, "normalize_departments", lambda data, path=None: data)
    unnormalized = _sync._read_json(_write(tmp_path, CLIENT_ARTIFACT_34))
    corrupted = tmp_path / "corrupted" / "departments.json"
    _sync.write_config(str(corrupted), unnormalized)
    assert json.loads(corrupted.read_text()) == CLIENT_ARTIFACT_34

    monkeypatch.undo()
    normalized = _sync._read_json(_write(tmp_path, CLIENT_ARTIFACT_34))
    healthy = tmp_path / "healthy" / "departments.json"
    _sync.write_config(str(healthy), normalized)
    written = json.loads(healthy.read_text())
    assert isinstance(written, list)
    assert [e["id"] for e in written] == BARE_34


def test_the_sync_cli_seeds_bare_slugs_and_is_idempotent_across_two_runs(tmp_path):
    """End to end on a hermetic tree: the workspaces table gets ONE row per
    department, slugged from the entry's own folder, and a second identical run
    adds nothing. Folding on the "-dept" map key put a second row beside every
    existing bare-slug row — 40 board columns became 74 — and `_canonical_dept_slug`
    strips only a `dept-` PREFIX, so nothing collapsed the pair.
    """
    db = tmp_path / "mission-control.db"
    proc, _ = _run_sync(tmp_path, CLIENT_ARTIFACT_34, existing=[], db=db, times=2)
    assert proc.returncode == 0, proc.stdout + proc.stderr

    conn = sqlite3.connect(str(db))
    slugs = [r[0] for r in conn.execute("SELECT id FROM workspaces").fetchall()]
    conn.close()

    assert sorted(slugs) == sorted(BARE_34), f"expected the 34 bare slugs, got {sorted(slugs)}"
    assert len(slugs) == len(set(slugs)), "a second run must not duplicate a workspace row"
    assert not [s for s in slugs if s.endswith("-dept")], (
        "no workspace may be slugged from the '-dept' map key")
