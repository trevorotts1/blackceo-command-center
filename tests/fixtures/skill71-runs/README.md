# Skill 71 runs: Item 26 acceptance fixtures

Event files in the frozen run-events format (schema v1.0), shaped like
the real transports:

- `client-a/runs.jsonl`, `client-b/runs.jsonl`: a fleet-contabo style
  mount tree (`<mount-root>/<client-slug>/runs.jsonl`). Import with
  `scripts/import-skill71-runs.ts --mount-root <this directory's parent>`.
- `pushed-hostinger.jsonl`: the lines a fleet-hostinger box would POST
  to `/api/skill-runs/ingest` (importable through the file transport for
  the same assertions).

## The five runs

1. **Complete** (client-a, fleet-contabo): all 13 stages closed,
   `report_generated` overall `complete`, review mode `INDEPENDENT`,
   one cost block (kie, 42.0 credits on `image-generation-qc`).
   Expect: panel row shows 13/13, complete, no review flag, cost shown.
2. **Blocked at image-generation-qc** (client-a, fleet-contabo): seven
   stages closed, then a `stage_blocked` with one named failure line.
   Expect: blocked stage named in red; failure line visible in detail.
3. **Self-reviewed test run** (client-a, fleet-contabo): `test_run:
   true`, three stages closed, report overall `test-run`, review mode
   `SELF-REVIEWED`. Expect: TEST RUN chip and the red SELF-REVIEWED
   flag; the panel's self-reviewed banner counts it.
4. **Pushed fleet-hostinger run** (client-c): the `intake` stage_closed
   line appears **twice, byte-identical**. Expect: ingestion inserts it
   once and reports one duplicate; the run shows 2 stages closed.
5. **Client B's run** (client-b, fleet-contabo): exists only in
   client-b's file. Expect: filtering the API/panel by client-a never
   surfaces it; it appears under client-b with review mode `UNKNOWN`
   (amber flag).

Re-importing everything a second time must change nothing: zero new
events inserted, all lines reported as duplicates.
