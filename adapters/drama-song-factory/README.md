# media-campaign-adapter

Drama-song factory → Command Center **AD-CAMPAIGNS** driver. Stdlib only. Consumes the
existing CC API; **zero changes to `blackceo-command-center`**.

- Route family: `POST/GET /api/ad-campaigns`, `PATCH/GET /api/ad-campaigns/{job_id}`,
  `POST /api/tasks/{id}/deliverables`, `GET /api/health`. Not `/api/campaigns`.
- Transport + auth (Bearer `MC_API_TOKEN`, HMAC `WEBHOOK_SECRET` on ad-campaign
  POST/PATCH) come from the canonical shared `cc_sync.py` — env only, never
  printed. The adapter resolves that core from either supported distribution
  (`drama-song-ad-factory` / `75-drama-song-ad-factory` skill roots), from the
  repo-root `core/` drop, or from `CC_SYNC_CORE`; a stale core is named, never
  imported.
- `initialize(job_id, show_name)` creates OR reconciles exactly one campaign
  with **exactly the 12 canonical stages** (directive 20.1). No stage-list
  argument exists; server `DEFAULT_AD_STAGES` (7-slot Facebook family) is
  never used. Tenant + run identity is the idempotency scope: one campaign
  per tenant/run across retries and outages.
- Order is enforced: deliverable registers first through the acknowledged
  outbox (server review/done evidence invariant, `task-lifecycle.ts` FIX 25,
  above `operatorOverride`), then `backlog → in_progress → review → done` per
  card, then `epic → done` flips `campaigns.status = 'complete'`.
- Replay safe: `complete_stage` reads the acknowledged state, enqueues only
  the required forward transitions, returns the existing receipt for
  identical valid evidence, and invalidates the appropriate review on a
  changed artifact (never `done → in_progress`).
- Gates held at enqueue (nothing stored, nothing sent): tenant
  (`WrongCompanyError`), blocked reason+ask (`BlockedGateError` / server 400
  `ASK_REQUIRED`), evidence (`EvidenceError`), independent reviewer
  (`SelfApprovalError`).
- Durable outbox: a file bound to tenant/run (`CC_OUTBOX_DIR` overrides the
  root; `:memory:` is a test seam only) — `pending → sent → acked`, rejected
  terminal, outage keeps a visible pending-sync state and the flush replays
  idempotently. `created:false` with zero duplicates on replay.

Usage (env: `MC_API_TOKEN`, `WEBHOOK_SECRET`, optional `CC_BASE_URL`,
`CC_WORKSPACE`, `CC_ACTOR`, `CC_REVIEWER`):

```bash
python3 media_campaign_adapter.py create job-demo-1 "Demo Show"
python3 media_campaign_adapter.py stage job-demo-1 research <task_id> /abs/evidence.md
python3 media_campaign_adapter.py complete job-demo-1 /abs/evidence.md
```

Envelope: `{"schema": "drama-song/media-campaign-adapter/1", "command", "outcome", ...}`;
exit 0 ok, 3 rejected, 4 error. Contract fixtures: `core/board_contract_fixtures/` (12).
Evidence: `lanes/DTS-401-lane/`.
