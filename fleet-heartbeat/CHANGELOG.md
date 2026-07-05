# fleet-heartbeat CHANGELOG

Operator-box Rescue Rangers subsystem (heartbeat + remediate + real-time receiver
+ n8n ticketing). Not an onboarding skill — there is no `skill-version.txt` /
`SKILL.md` here, so changes are tracked by dated entry.

## 2026-07-05 — Wave-0 merge-train T-rescue-rangers

Rescue Rangers hardening (planned fixes; the expedited P1s RESCUE-01/03/04 are
handled out-of-band and are not in this train).

- **FIX-RESCUE-02** — `rescue-receiver-watchdog.sh`: the receiver-down alarm is
  restored (BOT_TOKEN from `RESCUE_RANGERS_BOT_TOKEN`, never hardcoded/printed;
  flag-file dedup) and a real crash-loop detector is added: once the bounded
  kickstart budget is spent while the receiver is still down, a **distinct**
  escalation pages the operator ("kickstart will NOT help — check run.sh/.env",
  with the launchd last exit code), separate from the normal auto-restart page.
  Fixed a BSD/macOS `sed` portability bug (`\|` alternation → `sed -E`) that would
  otherwise have shipped the exit-code read broken on the operator Mac.
- **FIX-RESCUE-05** — `rescue-receiver.mjs`: added a real **medium** tier so the
  most common ticket class (coach-client-agent / how-to) routes to
  `ollama/deepseek-v4-flash:cloud` @ low instead of falling through to the
  expensive `kimi-k2.6:cloud` @ high default. Per-tier timeout ladder
  (light 120s / structured 180s / medium 240s / hard 540s) with the serial-queue
  cap set to `timeoutSecs+60` per job, so the agent's own `--timeout` always fires
  before the queue backstop (kills the 602s-abandonment regression).
- **FIX-RESCUE-07** — `rescue-ticketing/`: durable ticket-store redesign
  (`schema.sql` for Postgres/Supabase + `ticket_store.mjs` storage-agnostic core):
  RR-000123 numbers, the fail-closed state machine + `ticket_events` audit trail,
  severity→SLA computation, ownership flips, semantic dedup keys, and the
  reporting views (open-by-severity, MTTR, repeat offenders, cap usage, SLA
  breaches). Replaces the volatile n8n workflow-static-data store. Design in
  `rescue-ticketing/README.md`.
- **FIX-RESCUE-09** — `rescue-receiver.mjs`: gated the direct SSH/docker-exec
  return leg behind per-box verification. Every `type:"vps"` allowlist entry now
  defaults `verified:false` and stays SSH-blocked (falls back to the Telegram-group
  post) until a per-box loopback smoke test passes. Added the smoke test as a
  `--smoke-test <box>` CLI that records the result in a durable sidecar store.
- **FIX-RESCUE-10** — `remediate.sh`: `pattern_flag` now reads a compact
  append-only `incidents.tsv` index (single windowed `awk` pass) instead of
  perl-scanning the multi-MB prose change-log twice per fix; `change-log.md` is
  rotated monthly (`change-log-YYYY-MM.md`). One-time backfill preserves pattern
  detection continuity on first run.
- **FIX-RESCUE-12** — hygiene: `.gitignore` keeps the secret-laden n8n relay
  exports, `.bak`/`.orig`/`.rej` backups, the legacy bridge, and runtime state out
  of git; `scripts/archive-bak-files.sh` (dry-run default) moves backups to
  `scripts/_archive/` and retires the superseded `rescue-rangers-bridge.py` /
  `remote-rescue/`; `scripts/install-heartbeat-direct-cron.sh` +
  `launchd/ai.openclaw.fleet-heartbeat.plist.template` convert the hourly
  heartbeat from an LLM agent cron (Ollama-Cloud furnace) to a direct launchd
  command cron, matching the poller/watchdog.

Tests: `scripts/tests/` (receiver tier ladder + return-leg gate + watchdog
crash-loop + pattern_flag/rotation) and `rescue-ticketing/tests/` all pass
offline (no network, no SSH, no secrets).
