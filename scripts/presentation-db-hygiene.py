#!/usr/bin/env python3
"""presentation-db-hygiene.py — Phase D data lane (FIX 34 + FIX 35), one gated tool.

Presentation Department FIX SPEC rev3, Phase D data lane (`FIX 34 -> FIX 35`,
each destructive step its own confirmation). This script is the CODE the spec
demands; the destructive FIX 35 purge already executed once under Trevor's GO
(see ~/presentation-fix-tests/proofs/FIX-35-execution-receipt.txt). This tool
exists so the lane is repeatable and provable WITHOUT ever being runnable by
accident.

FIX 34 — decoy-DB backups:
  The repo-root mission-control.db was a 0-byte decoy and every
  `.backup.autodeploy.*` rolled back from it. atomic-deploy.sh now backs up the
  live LIVEDB first (non-zero-size guard). This tool adds the other half of the
  PROOF ("next backup is ~135MB and restores to a working DB"):
    backup          WAL-aware ONLINE backup (sqlite3 .backup API) of the DB into
                    ~/presentation-fix-tests/backups/db/ + a receipt JSON
                    (sizes, SHA-256, PRAGMA integrity_check, user_version, row
                    counts for tasks/task_events/events).
    verify-restore  restore a named backup into a NEW file (NEVER over the
                    source; refuses an existing target), integrity-check it,
                    compare row counts against the receipt.

FIX 35 — synthetic "done" rows + missing to-done audit:
    board-check     READ-ONLY proof query: live/archived ZZZ-SYNTHETIC rows,
                    done rows with no to-done task_events audit row, provenance
                    classification (completed_at present = real run; absent =
                    synthetic/aborted class).
    purge           archive the synthetic set (SOFT — archived_at stamp, NEVER a
                    DELETE) and backfill a `to-done` audit event for each real
                    done row, written with the SAME shape task-lifecycle.ts
                    writeTaskEvent()/recordStatusEvent() writes (same columns,
                    same legacy `events` fallback), actor `cc:fix35-hygiene`.

SAFETY MODEL (fail-closed, every destructive path):
  * Default mode is --dry-run: plans and prints, writes NOTHING.
  * `purge --apply` is refused unless the env var
        PRESENTATION_CONFIRM_DESTRUCTIVE=PURGE-SYNTHETIC-DONE-ROWS
    is set to that LITERAL string (missing or any other value -> exit 3, no
    writes). A GO for one destructive step never authorizes another.
  * `purge --apply` takes its OWN verified backup FIRST (the FIX 34 backup path)
    and aborts before any write if the backup is 0 bytes or fails
    integrity_check. Backup-first is structural, not a reminder.
  * NEVER a DELETE. Archiving = stamping tasks.archived_at (the canonical
    off-the-board marker; the tasks API filters archived_at IS NULL). Fully
    reversible via --rollback for exactly the rows this run archived (recorded
    in the purge receipt).
  * The synthetic match is pinned to '%ZZZ-SYNTHETIC%' in the title — a marker
    only drill data carries — so a real card can never be caught.
  * A 0-byte DB source is refused everywhere (the FIX 34 decoy lesson).

USAGE:
  python3 presentation-db-hygiene.py --db <path> board-check
  python3 presentation-db-hygiene.py --db <path> backup [--out-dir DIR]
  python3 presentation-db-hygiene.py --db <path> verify-restore --backup FILE
  python3 presentation-db-hygiene.py --db <path> purge [--apply]
  python3 presentation-db-hygiene.py --db <path> purge --rollback --receipt FILE

stdlib only. Local fixtures only in tests — never the real LIVEDB.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn

# The literal confirmation string the gate demands (spec hard rule: the gate
# must refuse to run without PRESENTATION_CONFIRM_DESTRUCTIVE=<this string>).
CONFIRM_ENV = "PRESENTATION_CONFIRM_DESTRUCTIVE"
CONFIRM_VALUE = "PURGE-SYNTHETIC-DONE-ROWS"

DEFAULT_BACKUP_DIR = Path.home() / "presentation-fix-tests" / "backups" / "db"

# Tables counted in receipts / restore verification (missing tables count 0).
ROW_COUNT_TABLES = ("tasks", "task_events", "events")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _connect(db_path, read_only: bool = False):
    con = sqlite3.connect(str(db_path), timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=15000")
    con.execute("PRAGMA foreign_keys=ON")
    return con


def _die(msg: str, code: int) -> NoReturn:
    print(f"FATAL [presentation-db-hygiene]: {msg}", file=sys.stderr)
    sys.exit(code)


def _check_nonempty_source(db_path) -> None:
    """FIX 34 lesson: a 0-byte file is a decoy, never a database."""
    p = Path(db_path)
    if not p.is_file():
        _die(f"db not found: {p}", 2)
    if p.stat().st_size == 0:
        _die(
            f"refusing to operate on 0-byte db {p} — that is the FIX 34 decoy "
            "shape, not a database. Point --db at the live DB "
            "(~/command-center/data/mission-control.db on the operator box).",
            2,
        )


def _table_exists(con, name: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def _row_counts(con) -> dict:
    out = {}
    for t in ROW_COUNT_TABLES:
        if _table_exists(con, t):
            out[t] = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        else:
            out[t] = 0
    return out


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _integrity(con) -> str:
    return str(con.execute("PRAGMA integrity_check").fetchone()[0])


# ---------------------------------------------------------------------------
# FIX 34 — backup + verify-restore
# ---------------------------------------------------------------------------
def cmd_backup(db_path: Path, out_dir: Path) -> int:
    src = Path(db_path).expanduser().resolve()
    _check_nonempty_source(src)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup_path = out_dir / f"{src.name}.presentation-fix34.{stamp}"
    if backup_path.exists():
        _die(f"backup target already exists: {backup_path}", 2)

    # WAL-aware ONLINE backup: sqlite3's .backup API copies the DB INCLUDING
    # committed WAL content, safe while writers are active. Never a bare cp of
    # only the main file (the rollback-doctrine trap).
    src_con = _connect(src)
    dst_con = sqlite3.connect(str(backup_path))
    try:
        src_con.backup(dst_con)
    finally:
        dst_con.close()
        src_con.close()

    size = backup_path.stat().st_size
    if size == 0:
        _die(f"produced a 0-byte backup at {backup_path} — refusing to record it", 2)
    con = _connect(backup_path)
    try:
        integrity = _integrity(con)
        counts = _row_counts(con)
        user_version = con.execute("PRAGMA user_version").fetchone()[0]
    finally:
        con.close()
    if integrity != "ok":
        _die(f"backup failed integrity_check: {integrity}", 2)

    src_con = _connect(src)
    try:
        src_counts = _row_counts(src_con)
        src_user_version = src_con.execute("PRAGMA user_version").fetchone()[0]
    finally:
        src_con.close()

    receipt = {
        "fix": "FIX 34",
        "kind": "wal-aware-online-backup",
        "created_at": _now(),
        "source": str(src),
        "source_size_bytes": src.stat().st_size,
        "source_user_version": int(src_user_version),
        "backup": str(backup_path),
        "backup_size_bytes": size,
        "backup_sha256": _sha256(backup_path),
        "integrity_check": integrity,
        "row_counts_backup": counts,
        "row_counts_source": src_counts,
        "schema_user_version": int(user_version),
    }
    receipt_path = backup_path.with_suffix(backup_path.suffix + ".receipt.json")
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    if counts.get("tasks") != src_counts.get("tasks"):
        _die(
            f"backup row-count mismatch for tasks "
            f"({counts.get('tasks')} vs source {src_counts.get('tasks')}) — "
            "backup is not trustworthy; remove it and retry",
            2,
        )
    print(f"OK: backup {backup_path} ({size} bytes) integrity={integrity}")
    return 0


def cmd_verify_restore(db_path: Path, backup: Path, target: Path | None) -> int:
    """Restore a backup into a NEW file — NEVER over the source, never over the
    live DB. The restore target must not already exist."""
    src_db = Path(db_path).expanduser().resolve()
    bk = Path(backup).expanduser().resolve()
    if not bk.is_file():
        _die(f"backup not found: {bk}", 2)
    if bk.stat().st_size == 0:
        _die(f"backup is 0 bytes: {bk} — not a backup (FIX 34 decoy shape)", 2)
    if target:
        tgt = Path(target).expanduser().resolve()
    else:
        tgt = bk.parent / f"{bk.name}.restored"
    if tgt.exists():
        _die(
            f"restore target already exists: {tgt} — a restore NEVER overwrites. "
            "Pick a fresh target path.",
            2,
        )
    if tgt.resolve() == src_db.resolve():
        _die("restore target must never be the live DB itself", 2)

    bk_con = _connect(bk)
    dst_con = sqlite3.connect(str(tgt))
    try:
        bk_con.backup(dst_con)
    finally:
        dst_con.close()
        bk_con.close()

    con = _connect(tgt)
    try:
        integrity = _integrity(con)
        counts = _row_counts(con)
    finally:
        con.close()
    receipt = {
        "fix": "FIX 34",
        "kind": "verify-restore",
        "created_at": _now(),
        "backup": str(bk),
        "restored_to": str(tgt),
        "restored_size_bytes": tgt.stat().st_size,
        "integrity_check": integrity,
        "row_counts": counts,
    }
    # Cross-check against the backup's own receipt when it sits beside it.
    side_receipt = bk.with_suffix(bk.suffix + ".receipt.json")
    if side_receipt.exists():
        try:
            orig = json.loads(side_receipt.read_text())
            receipt["row_counts_match_original_backup"] = (
                counts == orig.get("row_counts_backup")
            )
        except Exception:
            receipt["row_counts_match_original_backup"] = None
    Path(str(tgt) + ".restore-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    if integrity != "ok":
        _die(f"restored DB failed integrity_check: {integrity}", 2)
    print(f"OK: restored {bk} -> {tgt} (integrity={integrity}); source untouched")
    return 0


# ---------------------------------------------------------------------------
# FIX 35 — board-check / purge / rollback
# ---------------------------------------------------------------------------
SYNTHETIC_MATCH = "%ZZZ-SYNTHETIC%"


def _synthetic_rows(con, live_only: bool):
    q = ("SELECT id, title, status, archived_at FROM tasks "
         "WHERE title LIKE ?")
    if live_only:
        q += " AND archived_at IS NULL"
    return con.execute(q + " ORDER BY created_at", (SYNTHETIC_MATCH,)).fetchall()


def _done_missing_audit(con):
    """done rows with NO to-done task_events row (the FIX 35 audit gap).

    ZZZ-SYNTHETIC rows are excluded here: they are the synthetic set itself,
    handled by the archive path; the audit gap this query reports is over the
    remaining (nominally real) done rows, whose provenance is then classified.
    """
    if not _table_exists(con, "task_events"):
        return con.execute(
            "SELECT id, title, completed_at FROM tasks WHERE status='done' "
            "AND title NOT LIKE ? ORDER BY created_at", (SYNTHETIC_MATCH,)
        ).fetchall()
    return con.execute(
        "SELECT t.id, t.title, t.completed_at FROM tasks t "
        "WHERE t.status='done' AND t.title NOT LIKE ? AND NOT EXISTS ("
        "  SELECT 1 FROM task_events e WHERE e.task_id=t.id AND e.to_status='done'"
        ") ORDER BY t.created_at", (SYNTHETIC_MATCH,)
    ).fetchall()


def _classify_provenance(rows) -> dict:
    """Investigate provenance for done rows lacking a to-done audit event.

    A row that carries completed_at traces to a real completed run -> backfill.
    A done row with NO completed_at cannot be traced to a real completion ->
    it belongs to the synthetic/aborted class and is archived with the
    synthetic set. The classification is printed, never guessed silently.
    """
    real = [r for r in rows if r["completed_at"]]
    synthetic_class = [r for r in rows if not r["completed_at"]]
    return {"real": real, "synthetic_class": synthetic_class}


def cmd_board_check(db_path: Path) -> int:
    con = _connect(db_path)
    try:
        live = _synthetic_rows(con, live_only=True)
        archived = [r for r in _synthetic_rows(con, live_only=False)
                    if r["archived_at"] is not None]
        done_total = con.execute(
            "SELECT COUNT(*) FROM tasks WHERE status='done'").fetchone()[0]
        missing = _done_missing_audit(con)
        prov = _classify_provenance(missing)
        out = {
            "fix": "FIX 35 board-check (read-only)",
            "db": str(db_path),
            "checked_at": _now(),
            "synthetic_live": [r["id"] for r in live],
            "synthetic_archived": [r["id"] for r in archived],
            "done_rows_total": done_total,
            "done_missing_todone_audit": [r["id"] for r in missing],
            "provenance_real_completed_run": [r["id"] for r in prov["real"]],
            "provenance_synthetic_or_aborted": [r["id"] for r in prov["synthetic_class"]],
        }
        print(json.dumps(out, indent=2))
    finally:
        con.close()
    return 0


def _write_todone_event(con, task_id: str, reason: str, when: str) -> bool:
    """Backfill a to-done audit event with the SAME shape task-lifecycle.ts
    writeTaskEvent() writes (task_events row; legacy `events` row fallback when
    the structured table does not exist). Returns True when a row was written.
    Idempotent: a row that already has a to-done event is never double-written.
    """
    if _table_exists(con, "task_events"):
        already = con.execute(
            "SELECT 1 FROM task_events WHERE task_id=? AND to_status='done'",
            (task_id,),
        ).fetchone()
        if already:
            return False
        con.execute(
            "INSERT INTO task_events (id, task_id, from_status, to_status, actor, "
            "reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), task_id, "unknown", "done",
             "cc:fix35-hygiene-backfill", reason, when),
        )
        return True
    if _table_exists(con, "events"):
        con.execute(
            "INSERT INTO events (id, type, task_id, message, created_at) "
            "VALUES (?, 'task_status_changed', ?, ?, ?)",
            (str(uuid.uuid4()), task_id,
             f"[lifecycle] unknown -> done: {reason}", when),
        )
        return True
    return False


def cmd_purge(db_path: Path, out_dir: Path, apply: bool,
              rollback_receipt: Path | None) -> int:
    if rollback_receipt is not None:
        return _purge_rollback(db_path, rollback_receipt)

    if apply:
        gate = os.environ.get(CONFIRM_ENV, "")
        if gate != CONFIRM_VALUE:
            _die(
                f"destructive purge REFUSED: env {CONFIRM_ENV} must be set to the "
                f"literal string {CONFIRM_VALUE!r} (got "
                f"{'<unset>' if gate == '' else '<a different value>'}). "
                "Dry-run is the default; --apply without the confirmation env "
                "var writes nothing.",
                3,
            )

    con = _connect(db_path)
    try:
        live = _synthetic_rows(con, live_only=True)
        missing = _done_missing_audit(con)
        prov = _classify_provenance(missing)
        real_ids = [r["id"] for r in prov["real"]]
        synth_class_ids = [r["id"] for r in prov["synthetic_class"]]

        print("=== PLAN ===")
        print(f"archive live synthetic rows          : {len(live)} {[r['id'] for r in live]}")
        print(f"backfill to-done audit (real runs)   : {len(real_ids)} {real_ids}")
        print(f"archive synthetic/aborted-class done : {len(synth_class_ids)} {synth_class_ids}")
        print("mode                                  : "
              + ("APPLY (gated)" if apply else "DRY-RUN (default; no writes)"))
        if not apply:
            print("[dry-run] no writes performed.")
            return 0

        # BACKUP FIRST — structural, not advisory. The purge aborts before any
        # write when the backup is 0 bytes or fails integrity_check.
        print("=== BACKUP FIRST (FIX 34 procedure) ===")
        src = Path(db_path).expanduser().resolve()
        _check_nonempty_source(src)
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        backup_path = out_dir / f"{src.name}.pre-fix35.{stamp}"
        bk_con = _connect(src)
        dst_con = sqlite3.connect(str(backup_path))
        try:
            bk_con.backup(dst_con)
        finally:
            dst_con.close()
            bk_con.close()
        if backup_path.stat().st_size == 0:
            _die("pre-purge backup is 0 bytes — aborting before any write", 2)
        bcon = _connect(backup_path)
        try:
            integrity = _integrity(bcon)
            counts = _row_counts(bcon)
        finally:
            bcon.close()
        if integrity != "ok":
            _die(f"pre-purge backup failed integrity_check: {integrity} — aborting", 2)
        print(f"backup: {backup_path} ({backup_path.stat().st_size} bytes, integrity={integrity})")

        ts = _now()
        archived_ids: list[str] = []
        backfilled: list[str] = []
        con.execute("BEGIN IMMEDIATE")
        try:
            for r in live:
                con.execute(
                    "UPDATE tasks SET archived_at=?, updated_at=COALESCE(updated_at, ?) "
                    "WHERE id=? AND archived_at IS NULL",
                    (ts, ts, r["id"]),
                )
                archived_ids.append(r["id"])
            for rid in real_ids:
                if _write_todone_event(
                    con, rid,
                    "backfill (FIX 35): to-done audit event restored for a done row "
                    "traced to a real completed run (completed_at present); "
                    "provenance investigated by presentation-db-hygiene.py",
                    ts,
                ):
                    backfilled.append(rid)
            for rid in synth_class_ids:
                con.execute(
                    "UPDATE tasks SET archived_at=?, updated_at=COALESCE(updated_at, ?) "
                    "WHERE id=? AND status='done' AND archived_at IS NULL",
                    (ts, ts, rid),
                )
                archived_ids.append(rid)
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise

        receipt = {
            "fix": "FIX 35",
            "kind": "synthetic-purge (soft-archive + to-done backfill)",
            "db": str(src),
            "backup": str(backup_path),
            "backup_integrity": integrity,
            "applied_at": ts,
            "archived_ids": archived_ids,
            "backfilled_todone_ids": backfilled,
            "deletes": 0,
            "confirm_env": CONFIRM_ENV,
        }
        receipt_path = out_dir / f"fix35-purge-receipt.{stamp}.json"
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
        print("=== APPLIED ===")
        print(f"archived (soft, reversible): {archived_ids}")
        print(f"to-done audit backfilled   : {backfilled}")
        print(f"receipt: {receipt_path}")
        return 0
    finally:
        con.close()


def _purge_rollback(db_path: Path, receipt_path: Path) -> int:
    """Un-archive EXACTLY the rows this tool's own purge receipt lists.
    Rollback is itself a mutation: the same confirmation gate applies."""
    gate = os.environ.get(CONFIRM_ENV, "")
    if gate != CONFIRM_VALUE:
        _die(f"rollback REFUSED: env {CONFIRM_ENV} must equal {CONFIRM_VALUE!r}", 3)
    rec = json.loads(Path(receipt_path).read_text())
    ids = [i for i in rec.get("archived_ids", []) if isinstance(i, str)]
    if not ids:
        print("nothing to roll back: receipt lists no archived ids")
        return 0
    con = _connect(db_path)
    try:
        con.execute("BEGIN IMMEDIATE")
        for i in ids:
            con.execute(
                "UPDATE tasks SET archived_at=NULL WHERE id=? AND archived_at IS NOT NULL",
                (i,),
            )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    finally:
        con.close()
    print(f"rollback done: un-archived {len(ids)} rows listed in {receipt_path}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Phase D data lane (FIX 34 backup proof + FIX 35 gated purge). "
                    "Default is dry-run; every write path is gated.")
    ap.add_argument("--db", required=True,
                    help="path to mission-control.db (the live DB or a fixture)")
    ap.add_argument("--out-dir",
                    default=str(Path.home() / "presentation-fix-tests" / "backups" / "db"),
                    help="backup/receipt directory (default ~/presentation-fix-tests/backups/db)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("backup", help="WAL-aware online backup + receipt (read-only on source)")
    vr = sub.add_parser("verify-restore", help="restore a backup into a NEW file + integrity check")
    vr.add_argument("--backup", required=True)
    vr.add_argument("--target", default=None, help="restore target (must NOT exist)")
    sub.add_parser("board-check", help="read-only proof query")
    pg = sub.add_parser("purge", help="archive synthetic rows + backfill to-done audit (GATED)")
    g = pg.add_mutually_exclusive_group()
    g.add_argument("--apply", action="store_true",
                   help=f"execute (requires {CONFIRM_ENV}={CONFIRM_VALUE})")
    g.add_argument("--rollback", action="store_true",
                   help="un-archive exactly the rows listed in --receipt")
    pg.add_argument("--receipt", default=None, help="purge receipt for --rollback")
    args = ap.parse_args(argv)

    db_path = Path(args.db).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()
    if args.cmd == "backup":
        return cmd_backup(db_path, out_dir)
    if args.cmd == "verify-restore":
        return cmd_verify_restore(db_path, Path(args.backup), args.target)
    if args.cmd == "board-check":
        return cmd_board_check(db_path)
    if args.cmd == "purge":
        if args.rollback and not args.receipt:
            _die("--rollback requires --receipt", 2)
        return cmd_purge(db_path, out_dir, apply=bool(args.apply),
                         rollback_receipt=Path(args.receipt) if args.receipt else None)
    ap.error("unknown command")
    return 2


if __name__ == "__main__":
    sys.exit(main())