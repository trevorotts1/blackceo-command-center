#!/usr/bin/env python3
"""media_campaign_adapter acceptance suite (W08-U1; findings D13, D32; spec 17.4).

Regression cases preserved from the audit counterexamples:
  * the documented standalone entrypoint against a clean installation must
    import and run (was: ModuleNotFoundError: No module named 'cc_sync');
  * deliverable registration -> review admission must pass REAL shared-outbox
    admission (was: EvidenceError after a successful registration POST);
plus the repair contract: durable outbox bound to tenant/run surviving
process restart, replay-safe completion returning existing receipts,
review invalidation on changed artifacts (never an illegal done ->
in_progress replay), exactly one campaign per tenant/run across retries and
outages, and visible pending-synchronization state.

HTTP is faked at the sender seam only; the adapter and cc_sync under test
are the real files. Zero sockets, zero spend.

Run: python3 test_media_campaign_adapter.py   (pytest-collectable) stdlib only.

The canonical core is resolved from CC_SYNC_CORE (scripts/core of the drama
song factory distribution) or from a supported installed distribution.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADAPTER = HERE / "media_campaign_adapter.py"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


MCA = _load("mca_under_test", ADAPTER)
CS = MCA.cc_sync

CANONICAL_SLUGS = ("research", "creative-strategy", "script-lyrics", "music",
                   "continuity-bible", "storyboard", "image-keyframes",
                   "video-generation", "qc-retakes", "assembly", "final-qc",
                   "delivery")

# src/lib/task-lifecycle.ts LEGAL_TRANSITIONS, ad-status projection only.
# Written out from the server source: the fake must not import the client's
# own mirror and agree with it by construction.
SERVER_LEGAL = {
    "backlog": {"in_progress", "review", "blocked"},
    "in_progress": {"review", "blocked", "backlog"},
    "review": {"done", "in_progress", "blocked", "backlog"},
    "blocked": {"backlog", "in_progress"},
    "done": {"backlog"},
}


class FakeBoard:
    """Command Center contract: idempotent create on job_id, stage transitions
    with 409 ILLEGAL_TRANSITION, 422 PRECONDITION_EVIDENCE when review/done has
    no registered deliverable, same-state idempotent PATCH. `down=True` models
    an outage at the transport seam."""

    def __init__(self):
        self.campaigns = {}      # job -> {slug: {"id", "status"}}
        self.deliverables = {}   # task id -> [row]
        self.calls = []
        self.down = False
        self._n = 0

    def _next_id(self):
        self._n += 1
        return "task-%d" % self._n

    def _card(self, task_id):
        for cards in self.campaigns.values():
            for slug, card in cards.items():
                if card["id"] == task_id:
                    return slug, card
        return None, None

    def sender(self, method, path, payload):
        if self.down:
            raise CS.TransportOutage("board unreachable (dispatched=False)",
                                     dispatched=False)
        self.calls.append({"method": method, "path": path, "payload": payload})
        parts = path.strip("/").split("/")
        if parts[:2] == ["api", "health"]:
            return 200, {"status": "ok"}
        if parts[:2] == ["api", "ad-campaigns"]:
            if method == "POST" and len(parts) == 2:
                return self._create(payload)
            if len(parts) == 3 and method == "PATCH":
                return self._move(parts[2], payload)
            if len(parts) == 3 and method == "GET":
                job = parts[2]
                if job not in self.campaigns:
                    return 404, {"code": "NOT_FOUND"}
                cards = [{"id": c["id"], "stage_slug": slug, "status": c["status"]}
                         for slug, c in self.campaigns[job].items()]
                return 200, {"campaign": {"id": job, "status": "active"}, "cards": cards}
        if parts[:2] == ["api", "tasks"] and len(parts) == 4 and parts[3] == "deliverables":
            task_id = parts[2]
            if self._card(task_id)[1] is None:
                return 404, {"code": "NOT_FOUND"}
            if method == "GET":
                return 200, self.deliverables.get(task_id, [])
            if method == "POST":
                return self._register(task_id, payload)
        return 404, {"code": "NO_ROUTE"}

    def _create(self, payload):
        job = (payload or {}).get("job_id")
        if job in self.campaigns:
            return 200, self._create_result(job, created=False)
        cards = {"epic": {"id": self._next_id(), "status": "backlog"}}
        for s in (payload or {}).get("stages") or []:
            cards[s["slug"]] = {"id": self._next_id(), "status": "backlog"}
        self.campaigns[job] = cards
        return 201, self._create_result(job, created=True)

    def _create_result(self, job, created):
        cards = self.campaigns[job]
        return {"ok": True, "created": created, "campaign_id": job,
                "parent_id": cards["epic"]["id"],
                "stages": [{"slug": slug, "id": c["id"], "status": c["status"]}
                           for slug, c in cards.items() if slug != "epic"]}

    def _register(self, task_id, payload):
        if (payload or {}).get("deliverable_type") == "url":
            p = (payload or {}).get("path") or ""
            if not (p.startswith("http://") or p.startswith("https://")):
                return 422, {"error": "A 'url' deliverable requires a valid http(s) URL in path."}
        row = {"id": "d%d" % (len(self.deliverables.get(task_id, [])) + 1), **(payload or {})}
        self.deliverables.setdefault(task_id, []).append(row)
        return 201, row

    def _move(self, job, body):
        if job not in self.campaigns:
            return 404, {"code": "CARD_NOT_FOUND"}
        slug = (body or {}).get("stage_slug")
        card = self.campaigns[job].get(slug)
        if card is None:
            return 404, {"code": "CARD_NOT_FOUND"}
        status = (body or {}).get("status")
        if status == card["status"]:
            return 200, {"task": {"id": card["id"], "stage_slug": slug, "status": status}}
        if status not in SERVER_LEGAL.get(card["status"], set()):
            return 409, {"code": "ILLEGAL_TRANSITION"}
        if status in ("review", "done") and not self.deliverables.get(card["id"]):
            return 422, {"code": "PRECONDITION_EVIDENCE"}
        card["status"] = status
        return 200, {"task": {"id": card["id"], "stage_slug": slug, "status": status}}

    def patch_statuses(self):
        return [c["payload"].get("status") for c in self.calls
                if c["method"] == "PATCH"]


class TmpDir:
    def __init__(self, case, prefix="s75w08u1-adapter-"):
        self.tmp = tempfile.TemporaryDirectory(prefix=prefix)
        case.addCleanup(self.tmp.cleanup)

    def dir(self):
        return self.tmp.name


def make_adapter(case, board, job="job-demo-1", run_id=None, db_path=None):
    outdir = TmpDir(case)
    os.environ["CC_OUTBOX_DIR"] = outdir.dir()
    case.addCleanup(os.environ.pop, "CC_OUTBOX_DIR", None)
    return MCA.MediaCampaignAdapter("ws-test", base_url="http://fake.invalid",
                                    db_path=db_path, sender=board.sender,
                                    run_id=run_id or job)


class ImportBoundary(unittest.TestCase):
    """The documented standalone entrypoint resolves the canonical shared core
    from EITHER supported distribution (spec 17.4 row 14 counterexample)."""

    def _fixture_core(self, home, rel):
        core = Path(home) / rel / "scripts" / "core"
        core.mkdir(parents=True)
        shutil.copy(Path(CS.__file__), core / "cc_sync.py")
        return core

    def _probe_resolution(self, home, core):
        saved = dict(os.environ)
        saved_modules = {k: sys.modules.pop(k) for k in list(sys.modules)
                         if k == "cc_sync" or k.startswith("cc_sync.")}
        try:
            os.environ.pop("CC_SYNC_CORE", None)
            os.environ.pop("SKILL75_CORE", None)
            os.environ["HOME"] = home
            resolved = MCA._load_cc_sync()
            self.assertEqual(os.path.realpath(resolved.__file__),
                             os.path.realpath(core / "cc_sync.py"))
        finally:
            os.environ.clear()
            os.environ.update(saved)
            sys.modules.update(saved_modules)

    def test_resolves_from_claude_nine_and_openclaw_distributions(self):
        core = Path(CS.__file__).resolve().parent  # the canonical core in use
        nine = TmpDir(self).dir()
        oc = TmpDir(self).dir()
        self._probe_resolution(nine, self._fixture_core(
            nine, os.path.join(".claude", "skills", "drama-song-ad-factory")))
        self._probe_resolution(oc, self._fixture_core(
            oc, os.path.join(".openclaw", "skills", "75-drama-song-ad-factory")))

    def test_missing_core_raises_named_actionable_error(self):
        saved = dict(os.environ)
        saved_modules = {k: sys.modules.pop(k) for k in list(sys.modules)
                         if k == "cc_sync" or k.startswith("cc_sync.")}
        try:
            os.environ.pop("CC_SYNC_CORE", None)
            os.environ.pop("SKILL75_CORE", None)
            os.environ["HOME"] = TmpDir(self).dir()  # clean box: nothing installed
            with self.assertRaises(ModuleNotFoundError) as caught:
                MCA._load_cc_sync()
            self.assertIn("CC_SYNC_CORE", str(caught.exception))
            self.assertIn("scripts/core", str(caught.exception))
        finally:
            os.environ.clear()
            os.environ.update(saved)
            sys.modules.update(saved_modules)

    def test_stale_core_is_skipped_or_named_never_a_deep_type_error(self):
        home = TmpDir(self).dir()
        core = self._fixture_core(home, os.path.join(
            ".claude", "skills", "drama-song-ad-factory"))
        stub = core / "cc_sync.py"
        stub.write_text(
            "class BoardSyncError(Exception): pass\n"
            "class Outbox:\n"
            "    def __init__(self, db_path=':memory:', **kw): pass\n",
            encoding="utf-8")  # predates the durable outbox API
        saved = dict(os.environ)
        saved_modules = {k: sys.modules.pop(k) for k in list(sys.modules)
                         if k == "cc_sync" or k.startswith("cc_sync.")}
        try:
            os.environ.pop("CC_SYNC_CORE", None)
            os.environ.pop("SKILL75_CORE", None)
            os.environ["HOME"] = home
            with self.assertRaises(ModuleNotFoundError) as caught:
                MCA._load_cc_sync()
            self.assertIn("stale", str(caught.exception))
        finally:
            os.environ.clear()
            os.environ.update(saved)
            sys.modules.update(saved_modules)

    def test_documented_standalone_entrypoint_imports_and_runs_clean_install(self):
        """python3 -I media_campaign_adapter.py from a clean installation:
        exit 4 usage envelope (the documented entrypoint RAN), never exit 1
        ModuleNotFoundError -- from either supported distribution."""
        for rel in (os.path.join(".claude", "skills", "drama-song-ad-factory"),
                    os.path.join(".openclaw", "skills", "75-drama-song-ad-factory")):
            home = TmpDir(self).dir()
            self._fixture_core(home, rel)
            env = {k: v for k, v in os.environ.items()
                   if k not in ("CC_SYNC_CORE", "SKILL75_CORE")}
            env["HOME"] = home
            proc = subprocess.run(
                [sys.executable, "-I", str(ADAPTER)],
                capture_output=True, text=True, env=env,
                cwd=TmpDir(self).dir())
            self.assertEqual(proc.returncode, 4, proc.stderr)
            self.assertIn("usage", proc.stdout)
            self.assertNotIn("ModuleNotFoundError", proc.stderr)


class DurableOutbox(unittest.TestCase):
    def test_default_state_is_durable_and_bound_to_tenant_run(self):
        board = FakeBoard()
        ad = make_adapter(self, board, run_id="job-demo-1")
        self.assertNotEqual(ad.outbox.db_path, ":memory:")
        self.assertEqual(os.path.basename(ad.outbox.db_path), "job-demo-1.sqlite3")
        self.assertTrue(ad.outbox.db_path.startswith(os.environ["CC_OUTBOX_DIR"]))
        self.assertIn(os.sep + "ws-test" + os.sep, ad.outbox.db_path)

    def test_memory_is_explicit_test_seam_only(self):
        ad = memory_adapter(self)
        self.assertEqual(ad.outbox.db_path, ":memory:")

    def test_durable_outbox_state_survives_process_restart(self):
        board = FakeBoard()
        ad = make_adapter(self, board)
        res = ad.initialize("job-demo-1", "Demo Show")
        self.assertTrue(res["created"])
        self.assertTrue(res["cards"])
        db_path = ad.outbox.db_path
        ad.outbox.db.close()
        # a fresh process = a fresh connection on the same durable path
        ad2 = MCA.MediaCampaignAdapter("ws-test", base_url="http://fake.invalid",
                                       db_path=db_path, sender=board.sender)
        self.assertEqual(ad2.counts().get("acked"), 1)
        self.assertEqual(ad2.outbox.acknowledged_status("job-demo-1", "script-lyrics"),
                         "backlog")


def memory_adapter(case):
    outdir = TmpDir(case)
    os.environ["CC_OUTBOX_DIR"] = outdir.dir()
    case.addCleanup(os.environ.pop, "CC_OUTBOX_DIR", None)
    return MCA.MediaCampaignAdapter("ws-test", base_url="http://fake.invalid",
                                    db_path=":memory:", sender=FakeBoard().sender)


class Lifecycle(unittest.TestCase):
    def test_initialize_canonical_mapping_and_events(self):
        board = FakeBoard()
        ad = make_adapter(self, board)
        res = ad.initialize("job-demo-1", "Demo Show")
        self.assertTrue(res["created"])
        self.assertEqual(sorted(res["cards"]), sorted(("epic",) + CANONICAL_SLUGS))
        self.assertEqual(res["sync"], [])
        self.assertIn("state", [e["type"] for e in res["events"]])
        create = [c for c in board.calls if c["method"] == "POST"]
        self.assertEqual([s["slug"] for s in create[0]["payload"]["stages"]],
                         list(CANONICAL_SLUGS))
        # reconcile: second initialize is snapshot-only, zero writes
        writes = [c for c in board.calls if c["method"] != "GET"]
        res2 = ad.initialize("job-demo-1", "Demo Show")
        self.assertFalse(res2["created"])
        self.assertEqual([c for c in board.calls if c["method"] != "GET"], writes)

    def test_registration_then_review_admission_uses_real_shared_outbox(self):
        """spec 17.4 row 15: the reproduction that failed at script handoff
        after successful registration now passes real shared-outbox
        admission and persists."""
        board = FakeBoard()
        ad = make_adapter(self, board)
        ad.initialize("job-demo-1", "Demo Show")
        task_id = ad.snapshot("job-demo-1")["task_ids"]["script-lyrics"]
        res = ad.complete_stage("job-demo-1", "script-lyrics", task_id,
                                "media-runner", "qc-lead", "/runs/r1/script.md")
        self.assertEqual(res["flow"], ["in_progress", "review", "done"])
        # the shared-outbox deliverable row the move guard reads is acked
        row = ad.outbox.db.execute(
            "SELECT state FROM outbox WHERE kind='deliverable' AND job_id=? AND stage_slug=?",
            ("job-demo-1", "script-lyrics")).fetchone()
        self.assertEqual(row[0], "acked")
        self.assertEqual(board.campaigns["job-demo-1"]["script-lyrics"]["status"], "done")

    def test_completion_replay_returns_existing_receipt_without_illegal_moves(self):
        board = FakeBoard()
        ad = make_adapter(self, board)
        ad.initialize("job-demo-1", "Demo Show")
        task_id = ad.snapshot("job-demo-1")["task_ids"]["script-lyrics"]
        first = ad.complete_stage("job-demo-1", "script-lyrics", task_id,
                                  "media-runner", "qc-lead", "/runs/r1/script.md")
        rows = ad.counts()
        calls = len(board.calls)
        again = ad.complete_stage("job-demo-1", "script-lyrics", task_id,
                                  "media-runner", "qc-lead", "/runs/r1/script.md")
        self.assertEqual(again, first, "identical valid evidence returns the existing receipt")
        self.assertEqual(again["flow"], ["in_progress", "review", "done"])
        self.assertEqual(ad.counts(), rows, "replay enqueues zero new rows")
        self.assertEqual(len(board.calls), calls, "replay sends zero bytes")
        self.assertNotIn("backlog", board.patch_statuses())

    def test_changed_artifact_invalidates_review_never_illegal_replay(self):
        board = FakeBoard()
        ad = make_adapter(self, board)
        ad.initialize("job-demo-1", "Demo Show")
        task_id = ad.snapshot("job-demo-1")["task_ids"]["script-lyrics"]
        ad.complete_stage("job-demo-1", "script-lyrics", task_id,
                          "media-runner", "qc-lead", "/runs/r1/script.md")
        redone = ad.complete_stage("job-demo-1", "script-lyrics", task_id,
                                   "media-runner", "qc-lead", "/runs/r1/script-v2.md")
        self.assertEqual(redone["flow"], ["in_progress", "review", "done"])
        self.assertEqual(board.campaigns["job-demo-1"]["script-lyrics"]["status"], "done")
        self.assertEqual(ad.counts().get("rejected", 0), 0,
                         "no illegal transition was attempted server-side")
        statuses = board.patch_statuses()
        self.assertIn("backlog", statuses, "done re-opened legally to backlog")
        self.assertEqual(statuses.count("backlog"), 1)
        # the illegal shape (done -> in_progress straight) never appears
        done_at = max(i for i, s in enumerate(statuses) if s == "done")
        reopen_at = statuses.index("backlog")
        self.assertLess(reopen_at, done_at)
        rec = ad.outbox.stage_receipt("job-demo-1", "script-lyrics", "done")
        self.assertEqual(rec["evidence"], "/runs/r1/script-v2.md")

    def test_reopen_cycles_queue_new_intents_never_dedupe_onto_prior_cycle(self):
        """W08-U1 repair: a re-opened cycle must send its OWN hops. The core
        reopen_count matcher is dead (LIKE '%"reason":"reopen:%' vs JSON dumped
        as 'reason': 'value'), so without per-cycle intent identity cycle 3
        collapsed silently: 0 wire moves, done receipt naming the cycle-1
        artifact while the board held the cycle-2 one."""
        board = FakeBoard()
        ad = make_adapter(self, board)
        ad.initialize("job-demo-1", "Demo Show")
        task_id = ad.snapshot("job-demo-1")["task_ids"]["script-lyrics"]
        ev1, ev2 = "/runs/r1/script.md", "/runs/r1/script-v2.md"
        ad.complete_stage("job-demo-1", "script-lyrics", task_id,
                          "media-runner", "qc-lead", ev1)
        n1 = len(board.patch_statuses())
        # cycle 2: changed artifact re-opens and re-sends every hop
        ad.complete_stage("job-demo-1", "script-lyrics", task_id,
                          "media-runner", "qc-lead", ev2)
        n2 = len(board.patch_statuses()) - n1
        self.assertEqual(n2, 4, "re-open + three forward hops sent as new intents")
        # cycle 3: reverting to the earlier artifact is a THIRD completion
        # cycle, not an identical retry — it must re-open and re-send too
        ad.complete_stage("job-demo-1", "script-lyrics", task_id,
                          "media-runner", "qc-lead", ev1)
        n3 = len(board.patch_statuses()) - n1 - n2
        self.assertEqual(n3, 4, "cycle 3 sends its own hops; never a silent no-op")
        statuses = board.patch_statuses()
        self.assertEqual(statuses.count("backlog"), 2, "one legal re-open per changed cycle")
        self.assertEqual(statuses.count("done"), 3, "each cycle reaches done")
        rec = ad.outbox.stage_receipt("job-demo-1", "script-lyrics", "done")
        self.assertEqual(rec["evidence"], ev1, "receipt names the artifact actually landed")
        self.assertEqual(board.campaigns["job-demo-1"]["script-lyrics"]["status"], "done")
        # identical retry inside cycle 3 still dedupes onto its own rows
        rows = ad.counts()
        calls = len(board.calls)
        again = ad.complete_stage("job-demo-1", "script-lyrics", task_id,
                                  "media-runner", "qc-lead", ev1)
        self.assertEqual(again["flow"], ["in_progress", "review", "done"])
        self.assertEqual(ad.counts(), rows, "identical retry enqueues zero new rows")
        self.assertEqual(len(board.calls), calls, "identical retry sends zero bytes")

    def test_one_campaign_per_tenant_run_across_retries_and_outages(self):
        board = FakeBoard()
        ad = make_adapter(self, board)
        board.down = True                       # Command Center is down
        res = ad.initialize("job-demo-1", "Demo Show")
        self.assertIsNone(res["created"])
        self.assertTrue(res["sync"], "pending synchronization state is visible")
        self.assertEqual(res["sync"][0]["state"], "pending")
        board.down = False
        res2 = ad.initialize("job-demo-1", "Demo Show")   # replay, same request
        self.assertTrue(res2["created"])
        self.assertEqual(res2["sync"], [])
        self.assertEqual(len(board.campaigns), 1, "exactly one campaign")
        creates = ad.outbox.db.execute(
            "SELECT COUNT(*) FROM outbox WHERE kind='create'").fetchone()[0]
        self.assertEqual(creates, 1, "the request is never re-ingested as a second create")
        res3 = ad.initialize("job-demo-1", "Demo Show")
        self.assertFalse(res3["created"])
        self.assertEqual(len(board.campaigns), 1)

    def test_unacknowledged_deliverable_aborts_and_never_strands_the_stage(self):
        board = FakeBoard()
        ad = make_adapter(self, board)
        ad.initialize("job-demo-1", "Demo Show")
        task_id = ad.snapshot("job-demo-1")["task_ids"]["script-lyrics"]
        board.down = True
        with self.assertRaises(MCA.BoardSyncError):
            ad.complete_stage("job-demo-1", "script-lyrics", task_id,
                              "media-runner", "qc-lead", "/runs/r1/script.md")
        moves = ad.outbox.db.execute(
            "SELECT COUNT(*) FROM outbox WHERE kind='move'").fetchone()[0]
        self.assertEqual(moves, 0, "no dependent stage move is enqueued")
        board.down = False
        res = ad.complete_stage("job-demo-1", "script-lyrics", task_id,
                                "media-runner", "qc-lead", "/runs/r1/script.md")
        self.assertEqual(res["flow"], ["in_progress", "review", "done"],
                         "the stage is never stranded")


if __name__ == "__main__":
    unittest.main(verbosity=2)
