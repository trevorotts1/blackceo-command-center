# media-campaign-adapter

Drama-song factory → Command Center **AD-CAMPAIGNS** driver. Stdlib only. Consumes the
existing CC API; **zero changes to `blackceo-command-center`**.

- Route family: `POST/GET /api/ad-campaigns`, `PATCH/GET /api/ad-campaigns/{job_id}`,
  `POST /api/tasks/{id}/deliverables`, `GET /api/health`. Not `/api/campaigns`.
- Transport + auth (Bearer `MC_API_TOKEN`, HMAC `WEBHOOK_SECRET` on ad-campaign
  POST/PATCH) come from `core/cc_sync.py` — env only, never printed.
- `connect_or_create(job_id, show_name)` sends **exactly the 12 canonical stages**
  (directive 20.1). No stage-list argument exists; server `DEFAULT_AD_STAGES`
  (7-slot Facebook family) is never used.
- Order is enforced: deliverable registers first (server review/done evidence
  invariant, `task-lifecycle.ts` FIX 25, above `operatorOverride`), then
  `backlog → in_progress → review → done` per card, then `epic → done` flips
  `campaigns.status = 'complete'`.
- Gates held at enqueue (nothing stored, nothing sent): tenant
  (`WrongCompanyError`), blocked reason+ask (`BlockedGateError` / server 400
  `ASK_REQUIRED`), evidence (`EvidenceError`), independent reviewer
  (`SelfApprovalError`).
- Durable outbox: `pending → sent → acked`, rejected terminal, outage stops the
  flush in order; idempotent replay answers `created:false` with zero duplicates.

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
