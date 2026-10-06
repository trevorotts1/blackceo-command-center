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
  * durable outbox (create/move rows): pending -> sent -> acked, rejected
    terminal, outage stops flush in order. Deliverable registration is a
    synchronous prerequisite call (different route family); if it cannot be
    acknowledged the caller aborts and no dependent stage move is enqueued.

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
sys.path.insert(0, os.path.join(_BUILD_ROOT, "core"))

from cc_sync import (  # noqa: E402  (path bootstrap above)
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
    """

    def __init__(self, workspace, base_url=None, db_path=":memory:", sender=None):
        from cc_sync import Outbox  # deferred: keeps import surface honest

        self.workspace = workspace
        self.outbox = Outbox(db_path=db_path, base_url=base_url, workspace=workspace, sender=sender)
        # Reuse the outbox's verified stdlib transport (bearer + HMAC) for the
        # non-outbox calls (health/snapshot/deliverable) — one transport, no
        # second header implementation to drift.
        self.http = self.outbox._http_sender

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
        writes (snapshot only); idempotent replay protection lives server-side.
        """
        existing = self.snapshot(job_id)
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
        if state != "acked":
            raise BoardSyncError("create not acknowledged state=%s result=%s report=%s" % (state, result, report))
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

    # -- deliverable (synchronous prerequisite; see module docstring) -----
    def register_deliverable(self, task_id, title, path, deliverable_type="file", description=None):
        body = {"deliverable_type": deliverable_type, "title": title, "path": path}
        if description:
            body["description"] = description
        status, resp = self.http("POST", "/api/tasks/%s/deliverables" % task_id, body)
        if status != 201:
            raise BoardSyncError(
                "deliverable registration refused http=%s code=%s"
                % (status, (resp or {}).get("code") or (resp or {}).get("error"))
            )
        return {"http": status, "id": (resp or {}).get("id")}

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

    def block(self, job_id, stage_slug, actor, ask, blocked_reason="approval", blocked_on_human="owner", reason=None):
        """Human-only blocked: reason + a real ask are mandatory (client gate;
        server superRefine answers 400 ASK_REQUIRED without them)."""
        return self.move(job_id, stage_slug, "blocked", actor, reason=reason,
                         blocked_reason=blocked_reason, blocked_on_human=blocked_on_human, ask=ask)

    def complete_stage(self, job_id, stage_slug, task_id, actor, reviewer, evidence_path,
                       show_name=None):
        """deliverable -> backlog/in_progress/review/done, independent reviewer.

        Aborts (raises) before any stage move if the deliverable is not
        acknowledged or a move is rejected/deferred — order is the contract.
        """
        self.register_deliverable(
            task_id,
            "DTS-401 probe deliverable — %s" % stage_slug,
            evidence_path,
            description="registered before review/done: server evidence invariant",
        )
        flow = []
        for status in ("in_progress", "review", "done"):
            res = self.move(
                job_id, stage_slug, status, actor,
                reason="stage lifecycle: %s" % stage_slug,
                evidence=evidence_path if status in ("review", "done") else None,
                reviewer=reviewer if status == "done" else None,
            )
            if res["state"] != "acked":
                raise BoardSyncError("stage %s -> %s not acknowledged: %s" % (stage_slug, status, res))
            flow.append(status)
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
            ad = MediaCampaignAdapter(ws, base_url=base_url)
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
            ad = MediaCampaignAdapter(ws, base_url=base_url)
            ad.connect()
            _emit(cmd, "ok", ad.connect_or_create(job_id, show_name))
            return 0
        if cmd in ("stage", "block", "complete"):
            # stage: job_id stage_slug task_id evidence_path [actor] [reviewer]
            # block: job_id stage_slug ask [reason]
            # complete: job_id evidence_path [actor] [reviewer]
            ws = workspace
            ad = MediaCampaignAdapter(ws, base_url=base_url)
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
