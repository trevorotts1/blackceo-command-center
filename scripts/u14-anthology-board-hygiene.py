#!/usr/bin/env python3
"""U14 - B13 Anthology board hygiene (Command Center repo; OPERATOR box only).

Reversible, soft-archive-ONLY cleanup of the Anthology department board on the
operator's OWN Command Center. It NEVER deletes a task row.

WHAT A READ OF THE LIVE DB SHOWS (verified before writing anything):
  * The Anthology board (workspace_id='anthology') carries 6 cards total:
      - 1 stale auto-seeded starter card  "Welcome to Anthology"
        (id f102165bb3e86b57, status=blocked, archived_at=NULL -> STILL ON BOARD)
        Its body is the generic department placeholder ("... Your AI workforce
        will populate real tasks ...") -- wrong voice for a producer board.
      - 5 synthetic ZZZ-SYNTHETIC-TEST / W5-drill cards. EVERY one of them
        ALREADY carries archived_at (batch-archived 2026-07-08T22:22:56Z), so
        they are ALREADY off the open board (the tasks API filters
        `AND t.archived_at IS NULL`, see src/app/api/tasks/route.ts).
    (The upstream recon said "6 synthetic"; the live DB has 5. Reported, not guessed.)

WHAT THIS SCRIPT DOES:
  1. SOFT-ARCHIVE any still-live synthetic drill card on the anthology board
     (title contains 'ZZZ' or 'SYNTHETIC' -- markers that can only be drill data,
     never a real co-author). With the DB in its current state this matches 0 rows
     (all already archived); the step is here so the cleanup is complete + idempotent.
  2. SOFT-ARCHIVE the stale auto-seeded "Welcome to Anthology" placeholder by
     stamping tasks.archived_at (the canonical "off the board" marker). Reversible.
  3. SEED exactly ONE real Welcome card in PRODUCER voice ("editors", never "AI").

SAFETY:
  * Archive == stamp archived_at (soft). NEVER a DELETE. Fully reversible
    (`--rollback` sets archived_at back to NULL and removes the one seeded card).
  * The synthetic match is restricted to 'ZZZ'/'SYNTHETIC' titles so a real
    participant card ("Anthology chapter - <name>") can NEVER be caught.
  * The stale-welcome match is pinned to the exact auto-seed body signature so a
    real Welcome card is never archived.
  * All writes run in ONE transaction with a busy_timeout, so a concurrent gateway
    read/write never corrupts and the change is atomic.

Usage:
  python3 u14-anthology-board-hygiene.py --db <path> --dry-run      # show plan, no write
  python3 u14-anthology-board-hygiene.py --db <path> --apply        # do it
  python3 u14-anthology-board-hygiene.py --db <path> --rollback     # undo (reversible)

stdlib only.
"""
import argparse
import sqlite3
import sys
from datetime import datetime, timezone

WORKSPACE = "anthology"
DEPARTMENT = "anthology"
HEAD_AGENT_ID = "caa5c28b88e5d724"          # "Anthology Producer" (Anthology Dept Head)
STALE_WELCOME_ID = "f102165bb3e86b57"       # the auto-seeded placeholder starter card
STALE_BODY_MARK = "%AI workforce will populate real tasks%"   # exact auto-seed signature
SEED_CARD_ID = "ebb86d7e6d5c616f"           # the ONE new producer-voice Welcome card

# Producer-voice Welcome copy. Speaks to the producer; the automated workforce is
# referred to as "editors"; the word "AI" never appears. This IS the HOW-TO-USE
# content, phrased for the board.
WELCOME_TITLE = "Welcome to Anthology"
WELCOME_BODY = (
    "Welcome to your Anthology board. You are the producer of this anthology, and "
    "this is where you run it.\n\n"
    "Every co-author you invite becomes one card here. As their chapter is drafted, "
    "their card moves across the board on its own; when a chapter, title, or outline "
    "is ready for your call, the card lands in the Review column - that is your "
    "approval queue.\n\n"
    "Open a card to APPROVE a deliverable and release it to your co-author, or choose "
    "Request rewrite and add your notes to send it back for another pass (up to two "
    "rewrites per chapter). Nothing reaches a co-author until you approve it, and a "
    "card only reaches Done after the independent quality check clears it - you are "
    "never asked to sign off on something the quality gate already passed.\n\n"
    "Your co-authors never log in. When it is their turn, your editors send them a "
    "short, friendly email with one private link to do a single thing - pick a title, "
    "approve an outline, or approve a chapter. Their progress is always saved, so "
    "anyone can step away for weeks and pick up exactly where they left off.\n\n"
    "When every co-author is approved or excluded, an Assembly card appears with a "
    "readiness report. Assembling is your decision: you fire the ready-to-assemble "
    "trigger, confirm the finished set, adjust the chapter order, and give the final "
    "sign-off. Your editors then compile the full manuscript - front matter, an "
    "editor's introduction in your voice, contributor bios, and back matter - and "
    "deliver it as both a Google Doc and a designed PDF.\n\n"
    "Every form, link, and field lives in Convert and Flow, and your documents live "
    "in your shared Google Drive, organized by anthology and co-author. There are no "
    "deadlines, and nothing is ever sent to a co-author except the short nudges above. "
    "Click into any card to begin."
)


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _connect(db_path):
    con = sqlite3.connect(db_path, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=15000")
    con.execute("PRAGMA foreign_keys=ON")
    return con


def _board_snapshot(con, include_archived=True):
    q = ("SELECT id, substr(title,1,52) AS title, status, "
         "CASE WHEN archived_at IS NULL THEN 'LIVE' ELSE 'archived' END AS board "
         "FROM tasks WHERE workspace_id=? ORDER BY created_at")
    rows = con.execute(q, (WORKSPACE,)).fetchall()
    if not include_archived:
        rows = [r for r in rows if r["board"] == "LIVE"]
    return rows


def _print_rows(label, rows):
    print("\n%s (%d):" % (label, len(rows)))
    for r in rows:
        print("  %-38s %-9s %-8s  %s" % (r["id"], r["status"], r["board"], r["title"]))


def _live_synthetic(con):
    return con.execute(
        "SELECT id, title FROM tasks WHERE workspace_id=? AND archived_at IS NULL "
        "AND (title LIKE '%ZZZ%' OR title LIKE '%SYNTHETIC%')", (WORKSPACE,)).fetchall()


def _stale_welcome(con):
    return con.execute(
        "SELECT id, title FROM tasks WHERE workspace_id=? AND title=? "
        "AND description LIKE ? AND archived_at IS NULL",
        (WORKSPACE, WELCOME_TITLE, STALE_BODY_MARK)).fetchall()


def apply(con, dry_run):
    ts = _now()
    print("=== BEFORE ===")
    _print_rows("anthology board (all)", _board_snapshot(con))
    _print_rows("anthology board LIVE-only (what a producer sees)",
                _board_snapshot(con, include_archived=False))

    synth = _live_synthetic(con)
    stale = _stale_welcome(con)
    already_seeded = con.execute("SELECT id FROM tasks WHERE id=?", (SEED_CARD_ID,)).fetchone()

    print("\n=== PLAN ===")
    print("archive live synthetic drill cards : %d %s"
          % (len(synth), [r["id"] for r in synth]))
    print("archive stale auto-seed Welcome    : %d %s"
          % (len(stale), [r["id"] for r in stale]))
    print("seed producer Welcome card         : %s (id %s)"
          % ("SKIP - already present" if already_seeded else "YES", SEED_CARD_ID))

    if dry_run:
        print("\n[dry-run] no writes performed.")
        return 0

    con.execute("BEGIN IMMEDIATE")
    try:
        archived_ids = []
        for r in synth:
            con.execute("UPDATE tasks SET archived_at=?, updated_at=? WHERE id=? "
                        "AND archived_at IS NULL", (ts, ts, r["id"]))
            archived_ids.append(r["id"])
        for r in stale:
            con.execute("UPDATE tasks SET archived_at=?, updated_at=? WHERE id=? "
                        "AND archived_at IS NULL", (ts, ts, r["id"]))
            archived_ids.append(r["id"])
        if not already_seeded:
            con.execute(
                "INSERT INTO tasks (id, workspace_id, department, title, description, "
                "status, priority, assigned_agent_id, created_by_agent_id, business_id, "
                "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (SEED_CARD_ID, WORKSPACE, DEPARTMENT, WELCOME_TITLE, WELCOME_BODY,
                 "backlog", "medium", HEAD_AGENT_ID, HEAD_AGENT_ID, "default", ts, ts))
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise

    print("\n=== APPLIED ===")
    print("archived (soft, reversible): %s" % archived_ids)
    print("seeded Welcome card id: %s" % (SEED_CARD_ID if not already_seeded else "(pre-existing)"))
    print("\n=== AFTER ===")
    _print_rows("anthology board (all)", _board_snapshot(con))
    _print_rows("anthology board LIVE-only (what a producer sees)",
                _board_snapshot(con, include_archived=False))
    return 0


def rollback(con):
    """Reverse this migration ONLY: un-archive the stale Welcome placeholder and
    remove the one seeded card. Does NOT touch the synthetic cards (archived before
    this migration ran) and NEVER deletes anything else."""
    ts = _now()
    con.execute("BEGIN IMMEDIATE")
    try:
        con.execute("UPDATE tasks SET archived_at=NULL, updated_at=? WHERE id=?",
                    (ts, STALE_WELCOME_ID))
        con.execute("DELETE FROM tasks WHERE id=?", (SEED_CARD_ID,))
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    print("rollback done: stale Welcome %s un-archived; seeded card %s removed."
          % (STALE_WELCOME_ID, SEED_CARD_ID))
    _print_rows("anthology board (all)", _board_snapshot(con))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="U14 anthology board hygiene (reversible).")
    ap.add_argument("--db", required=True, help="path to the live mission-control.db")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true", help="show the plan, write nothing")
    g.add_argument("--apply", action="store_true", help="archive debris + seed Welcome")
    g.add_argument("--rollback", action="store_true", help="undo this migration")
    args = ap.parse_args(argv)
    con = _connect(args.db)
    try:
        if args.rollback:
            return rollback(con)
        return apply(con, dry_run=args.dry_run)
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
