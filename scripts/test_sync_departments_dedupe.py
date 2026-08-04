"""Regression test for sync-departments-from-build-state.py's duplicate-
workspace healing (2026-08-04 "WANTED Woman" incident).

Ground truth on the client's box: 35 real departments, 36 OpenClaw agents
(1 main + 35 department heads) -- correct. But her `workspaces` table held 72
rows for those 35 departments: 36 keyed `dept-<slug>` and 36 keyed bare
`<slug>` -- two naming generations of the same departments. This is exactly
the shape dedupe_canonical_workspaces() (and the reseed_workspaces() call
that wires it in) must heal, without ever touching a different company's
identically-named department.

Runs directly against sqlite3 fixture DBs -- no mission-control.db schema
dependency beyond what reseed_workspaces() itself creates (workspaces,
companies) plus a minimal agents/tasks table the test seeds by hand.
"""
import importlib.util
import os
import sqlite3

import pytest

_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "sync-departments-from-build-state.py"
)
_spec = importlib.util.spec_from_file_location("sync_departments_from_build_state", _SCRIPT)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

dedupe_canonical_workspaces = _mod.dedupe_canonical_workspaces
reseed_workspaces = _mod.reseed_workspaces


def _fresh_db(tmp_path, name="mission-control.db"):
    db_path = str(tmp_path / name)
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute(
        "CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, "
        "slug TEXT UNIQUE NOT NULL, industry TEXT, config TEXT DEFAULT '{}')"
    )
    cur.execute(
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, "
        "slug TEXT UNIQUE NOT NULL, description TEXT, icon TEXT, "
        "company_id TEXT DEFAULT 'default')"
    )
    cur.execute(
        "CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, role TEXT, "
        "workspace_id TEXT)"
    )
    cur.execute(
        "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT "
        "DEFAULT 'backlog', workspace_id TEXT)"
    )
    conn.commit()
    return db_path, conn, cur


# ---------------------------------------------------------------------------
# dedupe_canonical_workspaces() — the primitive
# ---------------------------------------------------------------------------

def test_merges_dept_prefixed_and_bare_pair_for_the_same_company(tmp_path):
    _, conn, cur = _fresh_db(tmp_path)
    cur.execute("INSERT INTO companies (id, name, slug) VALUES ('wanted-woman', 'WANTED Woman', 'wanted-woman')")
    cur.execute(
        "INSERT INTO workspaces (id, name, slug, company_id) VALUES "
        "('dept-marketing', 'Marketing', 'dept-marketing', 'wanted-woman')"
    )
    cur.execute(
        "INSERT INTO workspaces (id, name, slug, company_id) VALUES "
        "('marketing', 'Marketing', 'marketing', 'wanted-woman')"
    )
    cur.execute("INSERT INTO agents (id, name, role, workspace_id) VALUES ('a1', 'Legacy', 'specialist', 'dept-marketing')")
    cur.execute("INSERT INTO agents (id, name, role, workspace_id) VALUES ('a2', 'Current', 'specialist', 'marketing')")
    cur.execute("INSERT INTO tasks (id, title, workspace_id) VALUES ('t1', 'Legacy task', 'dept-marketing')")
    conn.commit()

    groups_merged, rows_deleted = dedupe_canonical_workspaces(cur)
    conn.commit()

    assert groups_merged == 1
    assert rows_deleted == 1

    remaining = [r[0] for r in cur.execute("SELECT id FROM workspaces").fetchall()]
    assert remaining == ["marketing"]  # the canonical-slug row wins as keeper

    # Both agents and the task were re-homed onto the keeper -- not deleted.
    assert cur.execute("SELECT workspace_id FROM agents WHERE id='a1'").fetchone()[0] == "marketing"
    assert cur.execute("SELECT workspace_id FROM agents WHERE id='a2'").fetchone()[0] == "marketing"
    assert cur.execute("SELECT workspace_id FROM tasks WHERE id='t1'").fetchone()[0] == "marketing"

    conn.close()


def test_is_a_true_noop_on_an_already_healed_board(tmp_path):
    _, conn, cur = _fresh_db(tmp_path)
    cur.execute("INSERT INTO companies (id, name, slug) VALUES ('acme', 'Acme', 'acme')")
    cur.execute("INSERT INTO workspaces (id, name, slug, company_id) VALUES ('marketing', 'Marketing', 'marketing', 'acme')")
    conn.commit()

    groups_merged, rows_deleted = dedupe_canonical_workspaces(cur)

    assert groups_merged == 0
    assert rows_deleted == 0
    conn.close()


def test_never_merges_two_different_companies_identically_named_department(tmp_path):
    # workspaces.slug is globally UNIQUE (both in this script's minimal
    # CREATE TABLE and the real TS schema), so two rows can never share the
    # LITERAL slug string "marketing" -- the realistic cross-company hazard
    # is a pre-MR-21 LEGACY row (id/slug still "dept-marketing", never
    # migrated) on one company coexisting with a canonical "marketing" row on
    # a DIFFERENT company sharing the same box. Different literal slugs
    # (schema-valid), same CANONICAL slug once dept- is stripped -- exactly
    # what dedupe_canonical_workspaces groups on.
    _, conn, cur = _fresh_db(tmp_path)
    cur.execute("INSERT INTO companies (id, name, slug) VALUES ('wanted-woman', 'WANTED Woman', 'wanted-woman')")
    cur.execute("INSERT INTO companies (id, name, slug) VALUES ('other-co', 'Other Co', 'other-co')")
    cur.execute("INSERT INTO workspaces (id, name, slug, company_id) VALUES ('marketing', 'Marketing', 'marketing', 'wanted-woman')")
    cur.execute("INSERT INTO workspaces (id, name, slug, company_id) VALUES ('dept-marketing', 'Marketing', 'dept-marketing', 'other-co')")
    cur.execute("INSERT INTO agents (id, name, role, workspace_id) VALUES ('a1', 'WW Marketer', 'specialist', 'marketing')")
    cur.execute("INSERT INTO agents (id, name, role, workspace_id) VALUES ('a2', 'Other Co Marketer', 'specialist', 'dept-marketing')")
    conn.commit()

    groups_merged, rows_deleted = dedupe_canonical_workspaces(cur)
    conn.commit()

    # Same CANONICAL slug ("marketing") on two DIFFERENT real companies must
    # NOT collapse into one row, even though the raw slugs differ.
    assert groups_merged == 0
    assert rows_deleted == 0
    remaining = sorted(r[0] for r in cur.execute("SELECT id FROM workspaces").fetchall())
    assert remaining == ["dept-marketing", "marketing"]
    assert cur.execute("SELECT workspace_id FROM agents WHERE id='a2'").fetchone()[0] == "dept-marketing"
    # And the other company's row's company_id must be untouched.
    assert cur.execute("SELECT company_id FROM workspaces WHERE id='dept-marketing'").fetchone()[0] == "other-co"

    conn.close()


def test_never_merges_a_workspace_with_live_dispatched_work(tmp_path):
    _, conn, cur = _fresh_db(tmp_path)
    cur.execute("INSERT INTO companies (id, name, slug) VALUES ('acme', 'Acme', 'acme')")
    cur.execute("INSERT INTO workspaces (id, name, slug, company_id) VALUES ('dept-sales', 'Sales', 'dept-sales', 'acme')")
    cur.execute("INSERT INTO workspaces (id, name, slug, company_id) VALUES ('sales', 'Sales', 'sales', 'acme')")
    cur.execute("INSERT INTO tasks (id, title, status, workspace_id) VALUES ('t1', 'Live task', 'in_progress', 'dept-sales')")
    conn.commit()

    groups_merged, rows_deleted = dedupe_canonical_workspaces(cur)

    assert groups_merged == 0
    assert rows_deleted == 0
    remaining = sorted(r[0] for r in cur.execute("SELECT id FROM workspaces").fetchall())
    assert remaining == ["dept-sales", "sales"]

    conn.close()


# ---------------------------------------------------------------------------
# reseed_workspaces() — the wired-in, end-to-end idempotency proof
# ---------------------------------------------------------------------------

def test_reseed_workspaces_heals_pre_existing_duplicate_and_stays_idempotent(tmp_path):
    db_path, conn, cur = _fresh_db(tmp_path)
    # Simulate the corrupted pre-existing state: a department present under
    # BOTH dept-marketing and marketing for the same company.
    cur.execute("INSERT INTO companies (id, name, slug) VALUES ('wanted-woman', 'WANTED Woman', 'wanted-woman')")
    cur.execute("INSERT INTO workspaces (id, name, slug, company_id) VALUES ('dept-marketing', 'Marketing', 'dept-marketing', 'wanted-woman')")
    cur.execute("INSERT INTO workspaces (id, name, slug, company_id) VALUES ('marketing', 'Marketing', 'marketing', 'wanted-woman')")
    conn.commit()
    conn.close()

    company_info = {
        "name": "WANTED Woman", "slug": "wanted-woman", "industry": "Retail",
        "brand_primary": "#1f2937", "brand_accent": "#3b82f6", "brand_text": "#f8fafc",
    }
    departments = [{"id": "marketing", "name": "Marketing", "emoji": "📣"}]

    # Run 1: heals the pre-existing duplicate.
    reseed_workspaces(db_path, departments, company_info, prune=False)

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    workspace_count_after_1 = cur.execute("SELECT COUNT(*) FROM workspaces").fetchone()[0]
    remaining = [r[0] for r in cur.execute("SELECT id FROM workspaces").fetchall()]
    assert remaining == ["marketing"]
    conn.close()

    # Run 2: idempotent -- no growth.
    reseed_workspaces(db_path, departments, company_info, prune=False)
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    workspace_count_after_2 = cur.execute("SELECT COUNT(*) FROM workspaces").fetchone()[0]
    conn.close()

    assert workspace_count_after_2 == workspace_count_after_1
