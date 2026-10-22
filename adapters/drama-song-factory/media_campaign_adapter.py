"""media_campaign_adapter — drama-song factory media campaign driver, Command Center AD-CAMPAIGNS.

Verified route family (live read 2026-10-06, ~/blackceo-command-center):
  GET  /api/health                          server lifecycle probe (auth-exempt)
  POST /api/ad-campaigns                    create, idempotent on job_id (201 created:true / 200 created:false)
  GET  /api/ad-campaigns/{job_id}           snapshot: campaign row + cards (stage_slug -> status, task id)
  PATCH /api/ad-campaigns/{job_id}          move ONE stage card; ILLEGAL_TRANSITION -> 409; NOT_FOUND -> 404;
                                            evidence invariant failures -> 422 (PRECONDITION_EVIDENCE);
                                            blocked without ask -> 400 (ASK_REQUIRED)
  POST /api/tasks/{task_id}/deliverables    register a real artifact (FIX 27: unreachable path -> 422, no row)

NOT /api/campaigns (generic route, wrong envelope), NOT Skill 47 cc_board.py default URL.

Contract (directive 20.1 / 20.5 + W3-01):
  * connect-or-create carries the 12 canonical creative stages ONLY — no
    caller-supplied stage list exists here. Server DEFAULT_AD_STAGES is the
    7-slot Facebook family; never fall back to it.
  * create -> stage-updates -> deliverable -> complete, in that order: the
    server review/done evidence invariant (task-lifecycle.ts FIX 25 / done
    gate, ABOVE operatorOverride) refuses review/done until >=1 reachable
    deliverable row exists on that card, so deliverables register first.
  * tenant isolation: one Outbox bound to ONE workspace; foreign-workspace
    events raise WrongCompanyError at enqueue, never stored, never sent.
  * human-only blocked: blocked requires blocked_reason + non-empty ask
    (client gate + server superRefine); workers park via ask, not silent.
  * independent completion authority: done requires an independent reviewer
    (reviewer != actor) and completion evidence, enforced at enqueue —
    attempted self-approval stores nothing and hits no wire.
  * durable outbox (create/move/deliverable rows): pending -> sent -> acked,
    rejected terminal, outage stops flush in order. Deliverable registration
    fulfils the SAME acknowledged-outbox contract the stage-move guard reads
    (cc_sync.stage_deliverable_queued): one durable row, acked before any
    dependent stage move is enqueued; a file registered over HTTP without
    that acknowledgement must never strand a legitimate stage.
  * replay-safe stage completion: read the current acknowledged state,
    enqueue only the required forward transitions, return the existing
    receipt for identical valid evidence, and on a changed artifact
    invalidate the appropriate review (done re-opens legally to backlog)
    instead of an illegal done -> in_progress replay.

Import boundary (finding D13): this packaged caller resolves its canonical
shared transport from either supported distribution — the OpenClaw skill
(`75-drama-song-ad-factory/scripts/core`) or the Claude-Nine skill
(`drama-song-ad-factory/scripts/core`), installed under a skill root or
dropped at the documented repo-root `core/` — or from CC_SYNC_CORE. The
documented standalone entrypoint no longer dies on ModuleNotFoundError.

Durable state (finding D13): the outbox defaults to a file bound to the
tenant and run identity (cc_sync.default_outbox_path); `:memory:` is an
explicit test seam only, so acknowledgement state survives process restart.

Stdlib only: json, os, sys, urllib (transport + auth live in core/cc_sync.py).
Auth material comes from env only (MC_API_TOKEN bearer, WEBHOOK_SECRET HMAC
for ad-campaign POST/PATCH) — never read, printed, or logged here.

NO blackceo-command-center REPO CHANGES: this adapter consumes the existing
API only.
"""

import json
import os
import sys

_BUILD_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def _core_dir_candidates():
    """Where the canonical shared core may live, in support order."""
    here = os.path.dirname(os.path.abspath(__file__))
    env = os.environ.get("CC_SYNC_CORE") or os.environ.get("SKILL75_CORE")
    if env:
        yield env
    yield os.path.join(here, "core")
    yield os.path.join(_BUILD_ROOT, "core")  # documented repo-root drop
    home = os.path.expanduser("~")
    for skill_root in (os.path.join(home, ".claude", "skills"),
                       os.path.join(home, ".claude-nine", "skills"),
                       os.path.join(home, ".openclaw", "skills")):
        for dist in ("drama-song-ad-factory", "75-drama-song-ad-factory"):
            yield os.path.join(skill_root, dist, "scripts", "core")


def _load_cc_sync():
    """Resolve and import cc_sync from either supported distribution.

    A core that predates the durable-outbox contract (missing
    default_outbox_path/pending_sync) is skipped in favour of a current one,
    and named loudly when only stale copies exist — never a deep TypeError
    from a version-skewed installation."""
    tried, stale = [], []
    for cand in _core_dir_candidates():
        core = os.path.dirname(cand) if os.path.basename(cand) == "cc_sync.py" else cand
        tried.append(core)
        if not os.path.isfile(os.path.join(core, "cc_sync.py")):
            continue
        if core not in sys.path:
            sys.path.insert(0, core)
        import cc_sync
        if not (hasattr(cc_sync, "default_outbox_path")
                and hasattr(getattr(cc_sync, "Outbox", None), "pending_sync")):
            stale.append(getattr(cc_sync, "__file__", core))
            sys.modules.pop("cc_sync", None)  # a stale copy must not win
            sys.path.remove(core)
            continue
        return cc_sync
    if stale:
        raise ModuleNotFoundError(
            "cc_sync found but stale (predates the durable outbox API): %s — "
            "update the installed drama-song factory distribution" % ", ".join(stale))
    raise ModuleNotFoundError(
        "cc_sync not found in any supported distribution (tried: %s); "
        "install the drama-song factory core or set CC_SYNC_CORE to its "
        "scripts/core directory" % ", ".join(tried))


cc_sync = _load_cc_sync()
from cc_sync import (  # noqa: E402  (core resolution above)
    AuthError,
    BoardSyncError,
    BlockedGateError,
    EvidenceError,
    SelfApprovalError,
    TransportOutage,
    WrongCompanyError,
)

# Directive 20.1 — the twelve creative stages, stable slugs, in board order.
# connect-or-create sends exactly these; the server adds the 'epic' parent.
CANONICAL_STAGES = (
    ("research", "Research"),
    ("creative-strategy", "Creative Strategy"),
    ("script-lyrics", "Script / Lyrics"),
    ("music", "Music"),
    ("continuity-bible", "Continuity Bible"),
    ("storyboard", "Storyboard"),
    ("image-keyframes", "Image / Keyframes"),
    ("video-generation", "Video Generation"),
    ("qc-retakes", "QC / Retakes"),
    ("assembly", "Assembly"),
    ("final-qc", "Final QC"),
    ("delivery", "Delivery"),
)
EPIC_SLUG = "epic"
SCHEMA = "drama-song/media-campaign-adapter/1"

assert len(CANONICAL_STAGES) == 12, "canonical board is twelve stages only"


class MediaCampaignAdapter:
    """Drive one media campaign through create -> stages -> deliverable -> complete.

    sender= is a test seam (same (status, body) contract as cc_sync transport).
    db_path=None binds a durable outbox file to (workspace, run_id); pass
    db_path=":memory:" only from explicit tests.
    """

    def __init__(self, workspace, base_url=None, db_path=None, sender=None, run_id=None):
        self.workspace = workspace
        self.outbox = cc_sync.Outbox(db_path=db_path, base_url=base_url,
                                     workspace=workspace, sender=sender, run_id=run_id)
        # Reuse the outbox's verified stdlib transport (bearer + HMAC) for the
        # non-outbox calls (health/snapshot/deliverable) — one transport, no
        # second header implementation to drift. self.outbox.sender honours the
        # sender= test seam.
        self.http = self.outbox.sender

    # -- lifecycle -------------------------------------------------------
    def connect(self):
        """Server lifecycle probe. Raises TransportOutage/AuthError on failure."""
        status, body = self.http("GET", "/api/health", None)
        if status != 200:
            raise BoardSyncError("health check refused http=%s" % status)
        return {"ok": True, "status": body.get("status"), "timestamp": body.get("timestamp")}

    def snapshot(self, job_id):
        """GET the campaign; None when the server proves it does not exist."""
        status, body = self.http("GET", "/api/ad-campaigns/" + job_id, None)
        if status == 404:
            return None
        if status != 200:
            raise BoardSyncError("snapshot failed http=%s" % status)
        cards = (body or {}).get("cards") or []
        return {
            "campaign": (body or {}).get("campaign"),
            "cards": {c.get("stage_slug"): c.get("status") for c in cards if isinstance(c, dict)},
            "task_ids": {c.get("stage_slug"): c.get("id") for c in cards if isinstance(c, dict)},
        }

    # -- create / connect-or-create (12 canonical stages only) -----------
    def connect_or_create(self, job_id, show_name, owner=None, department="music", agent_id=None):
        """Connect to an existing run, else create it with the 12 stages.

        No `stages` argument exists: the adapter can only ever send
        CANONICAL_STAGES (12). Second call against a live run performs zero
        writes (snapshot only); idempotent replay protection lives server-side
        AND in the outbox key (same request, same row).
        """
        try:
            existing = self.snapshot(job_id)
        except TransportOutage:
            # Board unreachable: fall through to the durable outbox. The
            # idempotency key means a replay cannot enqueue a second create,
            # and the server's job_id idempotency cannot mint a second campaign.
            existing = None
        if existing is not None:
            return {
                "created": False,
                "campaign_id": job_id,
                "card_count": len(existing["cards"]),
                "cards": existing["cards"],
            }
        rid = self.outbox.enqueue_create(
            job_id,
            show_name,
            [{"slug": s, "title": t} for s, t in CANONICAL_STAGES],
            workspace=self.workspace,
            owner=owner,
            department=department,
            agent_id=agent_id,
        )
        report = self.outbox.flush()
        state, result = self.outbox.db.execute("SELECT state, result FROM outbox WHERE id=?", (rid,)).fetchone()
        if state == "rejected":
            raise BoardSyncError("create rejected result=%s report=%s" % (result, report))
        if state != "acked":
            # Outage: keep the visible pending-synchronization state. The next
            # call replays the SAME durable row — one campaign per tenant/run
            # across retries and outages, no manual database edits.
            return {
                "created": None,
                "campaign_id": job_id,
                "card_count": 0,
                "cards": {},
                "report": report,
            }
        snap = self.snapshot(job_id)
        if snap is None:
            raise BoardSyncError("create acked but server snapshot proves missing")
        return {
            "created": True,
            "campaign_id": job_id,
            "card_count": len(snap["cards"]),
            "cards": snap["cards"],
            "ack": json.loads(result) if result else None,
        }

    def initialize(self, job_id, show_name, owner=None, department="music", agent_id=None):
        """Production initialization (D32): create OR reconcile exactly one
        campaign and its canonical stage mapping through the durable outbox,
        with tenant + stable run identity as the idempotency scope. Reports the
        visible pending-synchronization state and the run's event stream."""
        res = self.connect_or_create(job_id, show_name, owner=owner,
                                     department=department, agent_id=agent_id)
        if res.get("created") is not None:
            missing = [s for s, _ in CANONICAL_STAGES if s not in (res.get("cards") or {})]
            if missing:
                raise BoardSyncError(
                    "canonical stage mapping incomplete for %s: missing %s" % (job_id, missing))
        res["sync"] = self.outbox.pending_sync(job_id=job_id)
        res["events"] = self.outbox.events(job_id=job_id)
        return res

    # -- deliverable (acknowledged outbox prerequisite; see module docstring)
    def register_deliverable(self, job_id, stage_slug, task_id, title, path,
                             deliverable_type="file", description=None):
        """Register a real artifact through the SAME acknowledged-outbox
        contract the stage-move guard uses (cc_sync.stage_deliverable_queued).
        If the registration cannot be acknowledged the caller aborts and no
        dependent stage move is enqueued — order is the contract."""
        rid = self.outbox.enqueue_stage_deliverable(
            job_id, stage_slug, path, title, self.workspace,
            description=description, deliverable_type=deliverable_type, task_id=task_id)
        report = self.outbox.flush()
        state, result = self.outbox.db.execute(
            "SELECT state, result FROM outbox WHERE id=?", (rid,)).fetchone()
        if state != "acked":
            raise BoardSyncError(
                "deliverable registration not acknowledged state=%s result=%s report=%s"
                % (state, result, report))
        res = json.loads(result) if result else {}
        return {"http": res.get("http"), "id": res.get("id") or task_id}

    # -- stage moves (durable outbox) ------------------------------------
    def move(self, job_id, stage_slug, status, actor, reason=None, evidence=None, reviewer=None,
             blocked_reason=None, blocked_on_human=None, ask=None):
        """One stage move through the outbox. Client gates raise before any row
        is stored (blocked/evidence/self-approval/tenant). Returns the row state."""
        rid = self.outbox.enqueue_move(
            job_id, stage_slug, status, actor, workspace=self.workspace,
            reason=reason, evidence=evidence, reviewer=reviewer,
            blocked_reason=blocked_reason, blocked_on_human=blocked_on_human, ask=ask,
        )
        report = self.outbox.flush()
        state, result = self.outbox.db.execute("SELECT state, result FROM outbox WHERE id=?", (rid,)).fetchone()
        return {"state": state, "result": json.loads(result) if result else None, "report": report}

    def _move_acked(self, job_id, stage_slug, status, actor, **kw):
        res = self.move(job_id, stage_slug, status, actor, **kw)
        if res["state"] != "acked":
            raise BoardSyncError("stage %s -> %s not acknowledged: %s" % (stage_slug, status, res))
        return res

    def block(self, job_id, stage_slug, actor, ask, blocked_reason="approval", blocked_on_human="owner", reason=None):
        """Human-only blocked: reason + a real ask are mandatory (client gate;
        server superRefine answers 400 ASK_REQUIRED without them)."""
        return self.move(job_id, stage_slug, "blocked", actor, reason=reason,
                         blocked_reason=blocked_reason, blocked_on_human=blocked_on_human, ask=ask)

    def complete_stage(self, job_id, stage_slug, task_id, actor, reviewer, evidence_path,
                       show_name=None):
        """deliverable -> backlog/in_progress/review/done, independent reviewer.

        Replay safe: reads the current acknowledged state and enqueues only
        the required forward transitions. A completed stage with identical
        valid evidence returns its existing receipt with zero new rows; a
        changed artifact invalidates the appropriate review (done re-opens
        legally to backlog, a review under a changed artifact falls back to
        in_progress) instead of an illegal done -> in_progress replay.

        Aborts (raises) before any stage move if the deliverable is not
        acknowledged or a move is rejected/deferred — order is the contract.
        """
        cur = self.outbox.acknowledged_status(job_id, stage_slug)
        if cur == "done":
            rec = self.outbox.stage_receipt(job_id, stage_slug, "done")
            if rec and rec["evidence"] == evidence_path and rec["reviewer"] == reviewer:
                return rec["receipt"]
            self._move_acked(job_id, stage_slug, "backlog", actor,
                             reason="reopen: evidence changed" if rec
                             else "reopen: evidence unverified")
            cur = "backlog"
        elif cur == "review":
            rec = self.outbox.stage_receipt(job_id, stage_slug, "review")
            if not (rec and rec["evidence"] == evidence_path):
                self._move_acked(job_id, stage_slug, "in_progress", actor,
                                 reason="reopen: review invalidated (evidence changed)")
                cur = "in_progress"
        self.register_deliverable(
            job_id,
            stage_slug,
            task_id,
            "DTS-401 probe deliverable — %s" % stage_slug,
            evidence_path,
            description="registered before review/done: server evidence invariant",
        )
        # A re-opened cycle re-sends its forward transitions as NEW intents
        # (the reopen count is durable and monotonic per card), while identical
        # retries within one cycle dedupe onto the same outbox rows.
        reason = "stage lifecycle: %s" % stage_slug
        reopened = self.outbox.reopen_count(job_id, stage_slug)
        if reopened:
            reason += " (reopen %d)" % reopened
        forward = {
            "backlog": ("in_progress", "review", "done"),
            "blocked": ("in_progress", "review", "done"),
            "in_progress": ("review", "done"),
            "review": ("done",),
            None: ("in_progress", "review", "done"),
        }[cur]
        flow = []
        for status in forward:
            self._move_acked(job_id, stage_slug, status, actor,
                             reason=reason,
                             evidence=evidence_path if status in ("review", "done") else None,
                             reviewer=reviewer if status == "done" else None)
            flow.append(status)
            if status in ("review", "done"):
                self.outbox.record_stage_receipt(
                    job_id, stage_slug, status, evidence_path,
                    reviewer if status == "done" else "", actor,
                    {"stage_slug": stage_slug, "flow": list(flow)})
        return {"stage_slug": stage_slug, "flow": flow}

    def complete(self, job_id, actor, reviewer, evidence_path):
        """Epic done -> server flips campaigns.status to 'complete' (ad-campaigns.ts L364)."""
        snap = self.snapshot(job_id)
        if snap is None:
            raise BoardSyncError("campaign missing; nothing to complete")
        epic_task = snap["task_ids"].get(EPIC_SLUG)
        if not epic_task:
            raise BoardSyncError("epic card missing from snapshot")
        self.complete_stage(job_id, EPIC_SLUG, epic_task, actor, reviewer, evidence_path)
        final = self.snapshot(job_id)
        status = ((final or {}).get("campaign") or {}).get("status")
        if status != "complete":
            raise BoardSyncError("epic done but campaign status=%r" % status)
        return {"campaign_id": job_id, "status": status, "cards": final["cards"]}

    # -- convenience -----------------------------------------------------
    def counts(self):
        return dict(self.outbox.db.execute("SELECT state, COUNT(*) FROM outbox GROUP BY state").fetchall())


# --------------------------------------------------------------------------
# CLI — thin envelope over the library (exit 0 ok, 3 rejected, 4 error)
# --------------------------------------------------------------------------
def _emit(command, outcome, payload):
    print(json.dumps({"schema": SCHEMA, "command": command, "outcome": outcome, **payload}, sort_keys=True))


def main(argv):
    if len(argv) < 2:
        _emit("help", "error", {"reason": "usage: probe|create|stage|block|complete ..."})
        return 4
    cmd, args = argv[1], argv[2:]
    base_url = os.environ.get("CC_BASE_URL")
    workspace = os.environ.get("CC_WORKSPACE")
    try:
        if cmd == "probe":
            ws = workspace or (args[1] if len(args) > 1 else None)
            ad = MediaCampaignAdapter(ws, base_url=base_url,
                                      run_id=args[0] if args else None)
            health = ad.connect()
            out = {"health": health}
            if args:
                snap = ad.snapshot(args[0])
                out["snapshot"] = snap
            _emit(cmd, "ok", out)
            return 0
        if cmd == "create":
            job_id, show_name = args[0], args[1]
            ws = workspace or (args[2] if len(args) > 2 else None)
            ad = MediaCampaignAdapter(ws, base_url=base_url, run_id=job_id)
            _emit(cmd, "ok", ad.initialize(job_id, show_name))
            return 0
        if cmd in ("stage", "block", "complete"):
            # stage: job_id stage_slug task_id evidence_path [actor] [reviewer]
            # block: job_id stage_slug ask [reason]
            # complete: job_id evidence_path [actor] [reviewer]
            ws = workspace
            run = args[0] if args else None
            ad = MediaCampaignAdapter(ws, base_url=base_url, run_id=run)
            actor, reviewer = os.environ.get("CC_ACTOR", "media-runner"), os.environ.get("CC_REVIEWER", "qc-lead")
            if cmd == "stage":
                res = ad.complete_stage(args[0], args[1], args[2], actor, reviewer, args[3])
            elif cmd == "block":
                res = ad.block(args[0], args[1], actor, ask=args[2], reason=args[3] if len(args) > 3 else None)
            else:
                res = ad.complete(args[0], actor, reviewer, args[1])
            _emit(cmd, "ok", res)
            return 0
        _emit(cmd, "error", {"reason": "unknown command"})
        return 4
    except (WrongCompanyError, BlockedGateError, EvidenceError, SelfApprovalError, BoardSyncError) as e:
        _emit(cmd, "rejected", {"reason": type(e).__name__})
        return 3
    except (TransportOutage, AuthError) as e:
        _emit(cmd, "error", {"reason": type(e).__name__})
        return 4


if __name__ == "__main__":
    sys.exit(main(sys.argv))
