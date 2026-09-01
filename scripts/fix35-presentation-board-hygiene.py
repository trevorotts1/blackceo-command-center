#!/usr/bin/env python3
"""fix35-presentation-board-hygiene.py — FIX 35 (spec REV 3, Phase D data lane).

Purges synthetic "done" rows from the LIVE board and backfills missing
`to-done` audit events — DESTRUCTIVE, own Trevor GO, executed ONLY after a
FIX 34-verified live-DB backup exists.

BROKEN (spec FIX 35):
  * 5 `ZZZ-SYNTHETIC-TEST` rows sit as done on the live board;
  * 11 of 23 done rows have no `to-done` audit event.

WHAT THIS TOOL DOES:
  PHASE A  BACKUP      — SQLite online `.backup` of the LIVEDB (WAL-aware, the
                         rollback-doctrine mechanism) to a timestamped file
                         under ~/presentation-fix-tests/backups/db/. Verifies
                         non-zero size + integrity_check + SHA-256. --apply
                         refuses to run unless a verified backup exists (this
                         one, or one passed with --backup <path>). Restore =
                         the FIX 34 procedure (operator-run).
  PHASE B  PURGE       — archive the synthetic rows (soft archive: stamp
                         archived_at; NEVER a DELETE), scoped to rows whose
                         title carries the exact synthetic markers.
  PHASE C  AUDIT       — for each `done` task with NO to-done audit event,
                         classify provenance: a row that traces to a real
                         completed run (has completion evidence in
                         task_events) gets its to-done event backfilled VIA
                         THE GATED CC API (POST /api/tasks/<id>/audit-backfill
                         with Bearer + x-webhook-signature + the literal
                         destructive confirmation in the body) — never a raw
                         sqlite write. Rows tracing to synthetic or aborted
                         runs are archived with the synthetic set.
                         Owner: CC hygiene job (this script), run by the
                         operator with an explicit GO.

DESTRUCTIVE-CONFIRMATION GATE (spec HARD RULE): any phase that writes to the
live DB refuses to start unless the environment carries

    PRESENTATION_CONFIRM_DESTRUCTIVE=I-UNDERSTAND-THIS-PURGES-LIVE-BOARD-ROWS

(the literal confirmation string). The gate is checked BEFORE any connection
is opened for writing; without the exact string --apply exits non-zero and
touches nothing. A bare --apply flag is NOT sufficient — that is the disease
this gate exists to stop. Dry-run never writes and needs no confirmation.

Usage:
  python3 fix35-presentation-board-hygiene.py --db <LIVEDB>            # dry-run (default)
  python3 fix35-presentation-board-hygiene.py --db <LIVEDB> --apply \
      --api-base https://... --api-token ... --webhook-secret ...
  python3 fix35-presentation-board-hygiene.py --db <LIVEDB> --apply --backup <path>

stdlib only.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# The literal confirmation string. The gate refuses to run without it.
CONFIRM_ENV = "PRESENTATION_CONFIRM_DESTRUCTIVE"
CONFIRM_VALUE = "I-UNDERSTAND-THIS-PURGES-LIVE-BOARD-ROWS"

# Exact synthetic markers (spec: `ZZZ-SYNTHETIC-TEST` rows). Restricted so a
# real client card can never match.
SYNTHETIC_TITLE_MARKS = ("%ZZZ-SYNTHETIC%", "%SYNTHETIC-TEST%", "%W5-drill%")

DEFAULT_BACKUP_DIR = Path.home() / "presentation-fix-tests" / "backups" / "db"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _connect(path: str) -> sqlite3.Connection:
    con = sqlite3.connect(path, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=15000")
    return con


# ---------------------------------------------------------------------------
# PHASE A — backup
# ---------------------------------------------------------------------------
def phase_a_backup(db_path: str, backup_dir: Path, explicit: str | None) -> Path:
    """SQLite online .backup of LIVEDB (WAL-aware). Returns the backup path."""
    if explicit:
        bak = Path(explicit).expanduser().resolve()
        if not bak.is_file() or bak.stat().st_size == 0:
            raise SystemExit(f"[fix35] FATAL: --backup {bak} missing or 0 bytes — refusing.")
        return bak
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    bak = backup_dir / f"mission-control.db.fix35-backup.{stamp}"
    src = sqlite3.connect(db_path, timeout=15)
    try:
        src.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        dst = sqlite3.connect(str(bak))
        try:
            with dst:
                src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    size = bak.stat().st_size
    if size == 0:
        raise SystemExit(f"[fix35] FATAL: backup {bak} is 0 bytes — refusing (decoy).")
    chk = sqlite3.connect(str(bak))
    try:
        integ = chk.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        chk.close()
    if str(integ).lower() != "ok":
        raise SystemExit(f"[fix35] FATAL: backup integrity_check={integ!r} — refusing.")
    print(f"[fix35] backup OK: {bak} ({size} bytes) sha256={_sha256(bak)} integrity=ok")
    return bak


# ---------------------------------------------------------------------------
# Provenance: does a done row trace to a real completed run?
# ---------------------------------------------------------------------------
def _provenance(con: sqlite3.Connection, task_id: str, has_events_col: bool) -> dict:
    """Classify a done-without-to-done-event row: real | synthetic | unknown."""
    row = con.execute(
        "SELECT title, description FROM tasks WHERE id=?", (task_id,)
    ).fetchone()
    title = (row["title"] or "") if row else ""
    desc = (row["description"] or "") if row else ""
    blob = f"{task_id} {title} {desc}".upper()
    if "ZZZ-SYNTHETIC" in blob or "SYNTHETIC" in blob or "W5-DRILL" in blob:
        return {"verdict": "synthetic", "title": title}
    # A real completed run leaves SOME trace in THIS task's task_events (any
    # status hop); a done row with zero events of its own has unknown
    # provenance and is NOT backfilled (fail closed) — it is archived with
    # the synthetic set.
    if has_events_col:
        n = con.execute(
            "SELECT COUNT(*) AS n FROM task_events WHERE task_id=?", (task_id,)
        ).fetchone()["n"]
        if n > 0:
            return {"verdict": "real", "title": title}
    return {"verdict": "unknown", "title": title}


# ---------------------------------------------------------------------------
# PHASE C — backfill to-done audit event via the GATED CC API (never sqlite)
# ---------------------------------------------------------------------------
def _api_cfg(args) -> dict | None:
    base = (args.api_base or os.environ.get("COMMAND_CENTER_URL") or "").rstrip("/")
    if not base:
        return None
    return {
        "base": base,
        "token": args.api_token or os.environ.get("CC_API_TOKEN")
        or os.environ.get("MC_API_TOKEN") or "",
        "secret": args.webhook_secret or os.environ.get("WEBHOOK_SECRET")
        or os.environ.get("CC_WEBHOOK_SECRET") or "",
        "timeout": float(os.environ.get("CC_BOARD_TIMEOUT", "15")),
    }


def _sign(secret: str, raw: bytes) -> str | None:
    if not secret:
        return None
    return hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()


def _backfill_via_api(task_id: str, cfg: dict) -> tuple[int, str]:
    """Record the to-done event THROUGH THE GATED API. FIX 35 rule: the audit
    backfill rides the dedicated bearer+HMAC-gated POST /api/tasks/<id>/
    audit-backfill route, which appends the sanctioned task_events row via
    recordStatusEvent — this tool NEVER writes task_events directly. The body
    carries the same literal destructive confirmation the PRESENTATION_CONFIRM_
    DESTRUCTIVE env gate enforces on this side."""
    url = f"{cfg['base']}/api/tasks/{urllib.parse.quote(task_id, safe='')}/audit-backfill"
    payload = {
        "confirmation": CONFIRM_VALUE,
        "provenance": "done row missing to-done audit event; provenance traced "
                      "to a real completed run by the FIX 35 hygiene script",
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if cfg["token"]:
        headers["Authorization"] = f"Bearer {cfg['token']}"
    sig = _sign(cfg["secret"], raw)
    if sig is not None:
        headers["x-webhook-signature"] = sig
    req = urllib.request.Request(url, data=raw, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=cfg["timeout"]) as resp:
            return resp.getcode(), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:  # unreachable = fail closed, never sqlite fallback
        return 0, f"{type(exc).__name__}: {exc}"


# ---------------------------------------------------------------------------
# Plan inputs
# ---------------------------------------------------------------------------
def _any_live_synthetic(con: sqlite3.Connection) -> list:
    return con.execute(
        "SELECT id, title, status FROM tasks WHERE "
        "(title LIKE ? OR title LIKE ? OR title LIKE ?)",
        SYNTHETIC_TITLE_MARKS,
    ).fetchall()


def _done_missing_to_done(con: sqlite3.Connection, has_events_col: bool) -> list:
    """done rows with NO to-done audit event (task_events or task_status_audit)."""
    rows = con.execute(
        "SELECT id, title FROM tasks WHERE status IN ('done','complete')"
    ).fetchall()
    out = []
    for r in rows:
        hit = False
        if has_events_col:
            n = con.execute(
                "SELECT COUNT(*) AS n FROM task_events WHERE task_id=? AND to_status='done'",
                (r["id"],),
            ).fetchone()["n"]
            hit = hit or n > 0
        try:
            n2 = con.execute(
                "SELECT COUNT(*) AS n FROM task_status_audit WHERE task_id=? AND to_status='done'",
                (r["id"],),
            ).fetchone()
            hit = hit or n2["n"] > 0
        except sqlite3.OperationalError:
            pass  # task_status_audit absent on this box — task_events is the record
        if not hit:
            out.append(r)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="FIX 35 synthetic-row purge + audit backfill (DESTRUCTIVE, gated)."
    )
    ap.add_argument("--db", required=True, help="path to the LIVE mission-control.db")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, write nothing")
    ap.add_argument("--apply", action="store_true",
                    help="execute (STILL requires PRESENTATION_CONFIRM_DESTRUCTIVE)")
    ap.add_argument("--backup", default=None, help="path to an already-verified backup (skips Phase A)")
    ap.add_argument("--backup-dir", default=str(DEFAULT_BACKUP_DIR), help="backup output dir")
    ap.add_argument("--api-base", default=None, help="Command Center base URL (enables Phase C backfill)")
    ap.add_argument("--api-token", default=None)
    ap.add_argument("--webhook-secret", default=None)
    args = ap.parse_args(argv)

    if args.apply and args.dry_run:
        ap.error("--apply and --dry-run are mutually exclusive")
    dry_run = not args.apply  # default is dry-run

    db_path = str(Path(args.db).expanduser().resolve())
    if not Path(db_path).is_file():
        raise SystemExit(f"[fix35] FATAL: db not found: {db_path}")

    print(f"[fix35] mode: {'APPLY (gated)' if args.apply else 'DRY-RUN'}")
    supplied = os.environ.get(CONFIRM_ENV, "")
    if supplied == CONFIRM_VALUE:
        print("[fix35] destructive-confirmation gate: SATISFIED")
    else:
        print(f"[fix35] destructive-confirmation gate: NOT SATISFIED "
              f"({CONFIRM_ENV} must equal the literal confirmation string)")
        if args.apply:
            print(f"[fix35] FATAL: --apply refused. Set {CONFIRM_ENV}={CONFIRM_VALUE}")
            return 3
        print("[fix35] (dry-run continues — read-only, no gate needed)")

    # PHASE A: backup (required for --apply; also run for dry-run visibility
    # when --backup is given, so the operator sees the same verification).
    if args.apply or args.backup:
        phase_a_backup(db_path, Path(args.backup_dir).expanduser(), args.backup)
    else:
        print("[fix35] (dry-run) Phase A backup would run against LIVEDB before any write.")

    con = _connect(db_path)
    try:
        has_events_col = "task_events" in {
            t[0] for t in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        synth = _any_live_synthetic(con)
        done_missing = _done_missing_to_done(con, has_events_col)

        print("\n=== PLAN ===")
        print(f"synthetic rows on board (archive): {len(synth)}")
        for r in synth:
            print(f"  - {r['id']}  status={r['status']!r:12}  {r['title'][:60]}")
        print(f"done rows missing to-done audit event: {len(done_missing)}")
        verdicts = {}
        if has_events_col:
            for r in done_missing:
                v = _provenance(con, r["id"], has_events_col)
                verdicts[r["id"]] = v
                print(f"  - {r['id']}  provenance={v['verdict']:9}  {r['title'][:60]}")
        else:
            print("  (task_events table absent — Phase C would fail closed)")

        if dry_run:
            print("\n[dry-run] no writes performed.")
            return 0

        # ---- APPLY (only reachable with the confirmation env satisfied) ----
        real_backfill, synthetic_extra = [], []
        for r in done_missing:
            v = verdicts.get(r["id"], {"verdict": "unknown"})
            if v["verdict"] == "real":
                real_backfill.append(r["id"])
            else:
                synthetic_extra.append(r["id"])

        # Fail closed BEFORE any write if the backfill cannot proceed.
        if real_backfill and not _api_cfg(args):
            print("[fix35] FATAL: to-done backfill needs the gated CC API "
                  "(--api-base/--api-token/--webhook-secret or COMMAND_CENTER_URL env). "
                  "Failing closed — this tool never writes audit events via raw sqlite.")
            return 4

        archived = [r["id"] for r in synth] + synthetic_extra
        print("\n=== APPLY ===")
        print(f"archiving (soft) {len(archived)} rows: {archived}")
        ts = _now()
        if archived:
            con.execute("BEGIN IMMEDIATE")
            try:
                for tid in archived:
                    con.execute(
                        "UPDATE tasks SET archived_at=?, updated_at=? "
                        "WHERE id=? AND archived_at IS NULL",
                        (ts, ts, tid),
                    )
                con.execute("COMMIT")
            except Exception:
                con.execute("ROLLBACK")
                raise
            print("[fix35] synthetic rows archived (soft, reversible).")

        for tid in real_backfill:
            code, body = _backfill_via_api(tid, _api_cfg(args))
            ok = 200 <= code < 300
            print(f"[fix35] backfill {tid}: HTTP {code} {'OK' if ok else 'REFUSED — fail closed'}")
            if not ok:
                print(f"  body: {body[:400]}")
                return 5

        print("\n=== VERIFY ===")
        live_left = con.execute(
            "SELECT COUNT(*) AS n FROM tasks WHERE archived_at IS NULL "
            "AND (title LIKE ? OR title LIKE ? OR title LIKE ?)",
            SYNTHETIC_TITLE_MARKS,
        ).fetchone()
        print(f"ZZZ-SYNTHETIC rows still live on board: {live_left['n']} (expect 0)")
        return 0 if live_left["n"] == 0 else 6
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())