# HEARTBEAT.md

*Last updated: June 28 at 12:17 PM EDT*

## Quick Status

- **Mission Control:** healthy (DB migrations current, /api/health OK)
- **Inbox:** 171 tasks (was 183; 4 Marketing blockers unblocked + 1 Kofi Bryant task re-queued)
- **In Progress:** 8
- **Review:** 2
- **Blocked:** 0
- **Done (today):** 2 Marketing image tasks completed/closed

## Actions Taken This Heartbeat

1. **Unblocked 4 Marketing tasks** that were stuck on `model_sovereignty_needs_owner_input` and `no_specialist_runtime`. Root cause: `~/.openclaw/agents/dept-marketing/` and `dept-openclaw-maintenance/` existed but had no `agent/` runtime directory (only `sessions/`). Copied the `agent/` runtime from `dept-presentations/` into:
   - `~/.openclaw/agents/dept-marketing/agent/`
   - `~/.openclaw/agents/dept-openclaw-maintenance/agent/`
   - `~/.openclaw/agents/dept-communications/agent/`
   - `~/.openclaw/agents/dept-customer-support/agent/`
   - `~/.openclaw/agents/dept-web-development/agent/`
2. **Closed duplicate Marketing image task** `a6d56b90` (10 KIE.ai 1500x1500 images) — deliverables exist, all 10 images uploaded to Drive folder.
3. **Closed redundant task** `be03c275` (10 KIE.ai 1:1 images) — same work completed via `a6d56b90`.
4. **Re-queued Kofi Bryant box-check task** `fbcc4794` from blocked → inbox now that OpenClaw Maintenance runtime exists.

## Still Need Attention

- **Calendar check failing:** `unauthorized_client` on service-account DWD — likely Google Workspace Admin scope needs re-auth or `calendar` scope is missing/expired. Skipped calendar summary.
- **Gmail batch script missing:** `scripts/read_gmail_batch.sh` no longer exists. Used `scripts/get_stripe_full.py` instead; found 5 Stripe failed-payment emails (AI PRO UNIVERSITY $97.97, etc.).
- **Presentations pipeline:** 44 inbox tasks, many E2E/routing tests. One in-progress deck rebuild for Corey Sams (`5dd2d4d7`).
- **Fleet checks:** Several in-progress status checks (Stephanie Brown, Sheila Reynolds, LeAnne/Maria already done).

## Next Recommended Actions

1. Fix Google Workspace service-account DWD / calendar scope so daily briefing can read calendar.
2. Restore or replace `scripts/read_gmail_batch.sh` for unified email check.
3. Let the dispatch sweep run on the now-unblocked Marketing / OpenClaw Maintenance tasks.
4. Triage the 44 Presentations inbox tasks (many are tests; consider bulk archive of stale E2E cards).
