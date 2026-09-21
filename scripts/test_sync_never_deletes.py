"""The sync script never hard-deletes a workspace row (2026-09-21 incident).

Ground truth from a client box: during the v7.6.35 roll,
`sync-departments-from-build-state.py` hard-DELETED 22 archived workspace rows —
the `--prune` delete and the dedupe "loser" delete. A workspace row anchors a
department's whole task and agent history, the board's archive view is a display
state rather than a tombstone, and a delete leaves no audit trail an operator can
undo. Both paths now ARCHIVE.

These also pin the archived-aware, name-tolerant matching that keeps a second run
from inserting a duplicate beside a row the board already has.

    python3 -m pytest scripts/test_sync_never_deletes.py
"""
import importlib.util
import os
import sqlite3
import sys

import pytest

_SCRIPTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_SCRIPTS), "shared-utils"))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_SCRIPTS, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_sync = _load("sync_departments_from_build_state", "sync-departments-from-build-state.py")

COMPANY = {"slug": "acme", "name": "Acme", "industry": "Widgets",
           "brand_primary": "#000", "brand_accent": "#111", "brand_text": "#222"}


def _db(tmp_path, workspaces=(), tasks=(), companies=()):
    """A fixture board: the real schema this script writes, plus rows."""
    path = str(tmp_path / "mission-control.db")
    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
        description TEXT, icon TEXT, company_id TEXT DEFAULT 'default',
        archived_at TEXT, archived_reason TEXT)""")
    conn.execute("""CREATE TABLE tasks (
        id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT)""")
    conn.execute("""CREATE TABLE companies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
        industry TEXT, config TEXT DEFAULT '{}')""")
    conn.execute("""CREATE TABLE agents (
        id TEXT PRIMARY KEY, workspace_id TEXT)""")
    for c in companies:
        conn.execute("INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)",
                     (c["id"], c["name"], c.get("slug", c["id"])))
    for w in workspaces:
        conn.execute(
            "INSERT INTO workspaces (id, name, slug, company_id, archived_at, archived_reason) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (w["id"], w.get("name", w["id"].title()), w.get("slug", w["id"]),
             w.get("company_id", "acme"), w.get("archived_at"), w.get("archived_reason")))
    for t in tasks:
        conn.execute("INSERT INTO tasks (id, workspace_id, status) VALUES (?, ?, ?)",
                     (t["id"], t["workspace_id"], t.get("status", "done")))
    conn.commit()
    conn.close()
    return path


def _rows(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    out = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM workspaces")}
    conn.close()
    return out


def _dept(did, name=None):
    return {"id": did, "name": name or did.replace("-", " ").title(), "emoji": "\U0001f4c1"}


# ── rule 1: never delete ───────────────────────────────────────────────────

def test_prune_archives_the_stale_row_instead_of_deleting_it(tmp_path):
    db = _db(tmp_path, workspaces=[{"id": "marketing"}, {"id": "retired-dept-x"}])
    _sync.reseed_workspaces(db, [_dept("marketing")], COMPANY, prune=True)

    rows = _rows(db)
    assert "retired-dept-x" in rows, "the row must still exist — this script never deletes one"
    assert rows["retired-dept-x"]["archived_at"]
    assert rows["retired-dept-x"]["archived_reason"] == "pruned: absent from build-state"
    assert not rows["marketing"]["archived_at"], "a department in the build stays live"


def test_prune_still_keeps_a_stale_workspace_that_holds_tasks(tmp_path):
    db = _db(tmp_path, workspaces=[{"id": "marketing"}, {"id": "busy"}],
             tasks=[{"id": "t1", "workspace_id": "busy"}])
    _sync.reseed_workspaces(db, [_dept("marketing")], COMPANY, prune=True)

    rows = _rows(db)
    assert not rows["busy"]["archived_at"], "a row holding tasks is neither archived nor deleted"


def test_the_dedupe_loser_is_archived_not_deleted_and_its_rows_move_to_the_keeper(tmp_path):
    db = _db(tmp_path,
             workspaces=[{"id": "marketing", "slug": "marketing"},
                         {"id": "dept-marketing", "slug": "dept-marketing"}],
             tasks=[{"id": "t1", "workspace_id": "dept-marketing", "status": "done"}])
    _sync.reseed_workspaces(db, [_dept("marketing")], COMPANY)

    rows = _rows(db)
    assert "dept-marketing" in rows, "the loser row must still exist"
    assert rows["dept-marketing"]["archived_at"]
    assert rows["dept-marketing"]["archived_reason"] == "deduped: loser of marketing"
    assert not rows["marketing"]["archived_at"]

    conn = sqlite3.connect(db)
    assert conn.execute(
        "SELECT workspace_id FROM tasks WHERE id='t1'").fetchone()[0] == "marketing"
    conn.close()


def test_the_script_contains_no_workspace_delete_at_all(tmp_path):
    # The blunt guard: a future edit that reaches for DELETE fails here.
    src = open(os.path.join(_SCRIPTS, "sync-departments-from-build-state.py")).read()
    assert "DELETE FROM workspaces" not in src


# ── rule 3: archived rows are inert ────────────────────────────────────────

def test_an_archived_workspace_is_untouched_by_a_later_run(tmp_path):
    db = _db(tmp_path, workspaces=[
        {"id": "marketing"},
        {"id": "sales", "archived_at": "2026-01-01T00:00:00+00:00",
         "archived_reason": "operator declined"},
    ])
    _sync.reseed_workspaces(db, [_dept("marketing")], COMPANY, prune=True)
    first = _rows(db)["sales"]
    _sync.reseed_workspaces(db, [_dept("marketing")], COMPANY, prune=True)
    second = _rows(db)["sales"]

    assert first == second, "an archived row's audit trail must not be rewritten"
    assert first["archived_reason"] == "operator declined"


def test_prune_does_not_count_or_log_an_already_archived_row(tmp_path, capsys):
    db = _db(tmp_path, workspaces=[
        {"id": "marketing"},
        {"id": "sales", "archived_at": "2026-01-01T00:00:00+00:00",
         "archived_reason": "operator declined"},
    ])
    _sync.reseed_workspaces(db, [_dept("marketing")], COMPANY, prune=True)

    out = capsys.readouterr().out
    assert "pruned stale workspace: sales" not in out
    assert "pruned=0" in out


def test_a_build_entry_for_an_archived_department_never_reactivates_it(tmp_path):
    db = _db(tmp_path, workspaces=[
        {"id": "sales", "archived_at": "2026-01-01T00:00:00+00:00",
         "archived_reason": "operator declined"}])
    _sync.reseed_workspaces(db, [_dept("sales-team", "Sales")], COMPANY)

    rows = _rows(db)
    assert rows["sales"]["archived_at"], "the archived row stays archived"
    assert "sales-team" in rows, "the build entry got its own fresh live row"
    assert not rows["sales-team"]["archived_at"]


def test_the_script_never_writes_to_the_agents_table(tmp_path):
    src = open(os.path.join(_SCRIPTS, "sync-departments-from-build-state.py")).read()
    for verb in ("INSERT INTO agents", "UPDATE agents", "DELETE FROM agents"):
        assert verb not in src, f"this script must not {verb} — no head-agent links from here"


# ── rule 2: match before insert ────────────────────────────────────────────

def test_a_case_insensitive_name_match_updates_instead_of_inserting(tmp_path):
    db = _db(tmp_path, workspaces=[
        {"id": "ws-8f21", "name": "Billing & Finance", "slug": "ws-8f21"}])
    _sync.reseed_workspaces(
        db, [{"id": "billing-finance", "name": "billing & finance", "emoji": "\U0001f4b3"}],
        COMPANY)

    rows = _rows(db)
    assert len(rows) == 1, f"a name match must not insert a second row: {list(rows)}"
    assert rows["ws-8f21"]["name"] == "billing & finance"
    assert rows["ws-8f21"]["slug"] == "ws-8f21", "a name-matched row keeps its own slug"


def test_an_alias_match_updates_instead_of_inserting(tmp_path):
    db = _db(tmp_path, workspaces=[{"id": "billing", "name": "Billing", "slug": "billing"}])
    _sync.reseed_workspaces(db, [_dept("billing-finance", "Billing & Finance")], COMPANY)

    rows = _rows(db)
    assert len(rows) == 1, f"billing <-> billing-finance is an alias hit: {list(rows)}"
    assert rows["billing"]["name"] == "Billing & Finance"


def test_the_canonical_slug_match_beats_a_dept_prefixed_row(tmp_path):
    db = _db(tmp_path, workspaces=[
        {"id": "dept-legal", "name": "Legal", "slug": "dept-legal"}])
    _sync.reseed_workspaces(db, [_dept("legal", "Legal")], COMPANY)
    assert len(_rows(db)) == 1


def test_matching_never_crosses_into_another_companys_workspace(tmp_path):
    db = _db(tmp_path, workspaces=[
        {"id": "ws-other", "name": "Marketing", "slug": "ws-other", "company_id": "other-co"}])
    _sync.reseed_workspaces(db, [_dept("marketing", "Marketing")], COMPANY)

    rows = _rows(db)
    assert "marketing" in rows, "a different company's row is never matched or reused"
    assert rows["ws-other"]["company_id"] == "other-co"


def test_a_second_identical_run_inserts_nothing(tmp_path):
    db = _db(tmp_path)
    depts = [_dept("marketing"), _dept("billing-finance", "Billing & Finance")]
    _sync.reseed_workspaces(db, depts, COMPANY)
    after_first = _rows(db)
    _sync.reseed_workspaces(db, depts, COMPANY)
    assert _rows(db).keys() == after_first.keys()


# ── rule 4: the company-id line ────────────────────────────────────────────

def test_the_company_ids_present_and_the_target_are_printed(tmp_path, capsys):
    db = _db(tmp_path, workspaces=[
        {"id": "a", "company_id": "default"},
        {"id": "b", "company_id": "wakeuphappysis"},
        {"id": "c", "company_id": "wake-up-happy-sis"},
    ])
    _sync.reseed_workspaces(db, [_dept("marketing")], COMPANY)

    line = [l for l in capsys.readouterr().out.splitlines() if "company ids" in l]
    assert len(line) == 1, "exactly one company-scope line"
    for token in ("default", "wakeuphappysis", "wake-up-happy-sis", "acme"):
        assert token in line[0], f"{token} missing from: {line[0]}"


@pytest.mark.parametrize("variant,canonical", [
    ("billing", "billing-finance"),
    ("legal-compliance", "legal"),
    ("compliance", "legal"),
    ("webdev", "web-development"),
    ("ceo", "master-orchestrator"),
])
def test_the_alias_table_mirrors_canonical_slug_ts(variant, canonical):
    assert _sync._aliased_dept_slug(variant) == canonical
    assert _sync._aliased_dept_slug(f"dept-{variant}") == canonical


def test_app_development_is_never_aliased_away_to_engineering():
    # The 2026-07-08 lesson: a client who chose BOTH must keep BOTH lanes.
    assert _sync._aliased_dept_slug("app-development") == "app-development"
    assert _sync._aliased_dept_slug("engineering") == "engineering"


# ── the companies table: never a third row for the same client ─────────────

def _companies(path):
    conn = sqlite3.connect(path)
    out = {r[0]: r[1] for r in conn.execute("SELECT id, name FROM companies")}
    conn.close()
    return out


def test_a_same_name_company_is_reused_not_duplicated(tmp_path):
    # The v7.6.26 roll inserted a THIRD row, 'wake-up-happy-sis', beside these
    # two, all three named the same, and the workspaces then split across ids.
    db = _db(
        tmp_path,
        companies=[{"id": "default", "name": "Wake Up Happy Sis", "slug": "wuhs"},
                   {"id": "wakeuphappysis", "name": "Wake Up Happy Sis"}],
        workspaces=[{"id": "marketing", "company_id": "wakeuphappysis"},
                    {"id": "sales", "company_id": "wakeuphappysis"},
                    {"id": "hr", "company_id": "default"}])
    company = dict(COMPANY, slug="wake-up-happy-sis", name="Wake Up Happy Sis")
    _sync.reseed_workspaces(db, [_dept("marketing")], company)

    assert set(_companies(db)) == {"default", "wakeuphappysis"}, "no third row"
    # The reused row is the one already owning the most workspaces, so the sync
    # lands where the board's departments actually live.
    assert _rows(db)["marketing"]["company_id"] == "wakeuphappysis"


def test_the_name_match_ignores_case_and_punctuation(tmp_path):
    db = _db(tmp_path, companies=[{"id": "acme-co", "name": "  ACME,  Inc. "}])
    _sync.reseed_workspaces(db, [_dept("marketing")],
                            dict(COMPANY, slug="acme-inc", name="acme inc"))
    assert set(_companies(db)) == {"acme-co"}
    assert _rows(db)["marketing"]["company_id"] == "acme-co"


def test_an_exact_slug_match_still_wins_over_a_name_match(tmp_path):
    db = _db(tmp_path, companies=[{"id": "other", "name": "Acme"},
                                  {"id": "acme", "name": "Acme"}])
    _sync.reseed_workspaces(db, [_dept("marketing")], dict(COMPANY, slug="acme", name="Acme"))
    assert _rows(db)["marketing"]["company_id"] == "acme"


def test_a_genuinely_new_company_is_still_inserted(tmp_path):
    db = _db(tmp_path, companies=[{"id": "other-co", "name": "Different Client"}])
    _sync.reseed_workspaces(db, [_dept("marketing")], dict(COMPANY, slug="acme", name="Acme"))
    assert set(_companies(db)) == {"other-co", "acme"}
