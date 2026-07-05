# FIX-RESCUE-12 — deploy-path cleanup + heartbeat cron de-furnacing

**Priority:** P3 · **Wave:** 0 · **Scope:** operator box `fleet-heartbeat/` only.

Two independent problems, two independent fixes. Everything here is idempotent
and reversible; nothing is hard-deleted and no secret is ever printed.

---

## (i) Deploy-path clutter obscures the live path & amplifies the secret leak

**Problem.** ~60 `*.bak*` copies, the legacy `rescue-rangers-bridge.py`, and a
vestigial `remote-rescue/` sit in the live deploy path. They bury the real
rescue code path and multiply the number of on-disk copies of anything
secret-bearing.

**Fix.** `rescue-12-cleanup.sh` relocates them (never deletes):

- **`.bak*` backups →** `scripts/_archive/` (git-ignored, preserves relative
  layout, writes a timestamped `MANIFEST-*.txt`).
- **`rescue-rangers-bridge.py` →** `scripts/_archive/`. Retired only after two
  guards pass: (1) `heartbeat.sh` documents the dispatch path as superseded and
  (2) no live script actually *invokes* the bridge.
  - Evidence: `heartbeat.sh:510-528` — Rescue Rangers delivery is now handled
    natively by the OpenClaw gateway's multi-account Telegram polling
    (`channels.telegram.accounts.rescue-rangers` → rescue-rangers agent); the
    old raw-curl dispatch was removed 2026-06-22. The only remaining reference
    to the bridge is a **defensive** `launchctl` check in `session-health.sh`
    (it warns if a rogue bridge *daemon* is running) — that check does not run
    or need the `.py`, so archiving the file does not affect it.
- **`remote-rescue/`** — a separate git repo with **no commits, no remote**, and
  no reference from any live script / crontab / launchd. Reported by default;
  archived to `_archive/remote-rescue/` only with `--remove-remote-rescue`.

**Run:**
```bash
cd "$HOME"/clawd/fleet-heartbeat/scripts   # or wherever your fleet-heartbeat checkout lives
./rescue-12-cleanup.sh                              # dry-run, shows every move
./rescue-12-cleanup.sh --apply                      # archive .bak + retire bridge
./rescue-12-cleanup.sh --apply --remove-remote-rescue   # also archive remote-rescue/
```
**Rollback:** consult the manifest in `scripts/_archive/MANIFEST-*.txt` and
`mv` any entry back to its original relative path.

`.gitignore` was hardened (`*.bak-*`, `scripts/_archive/`,
`rescue-rangers-bridge.py*`) so none of this can ever be committed.

---

## (ii) Hourly LLM agent turn just to shell a deterministic script (furnace)

**Problem.** The `fleet-heartbeat` OpenClaw cron
(`id 3f0f33c9-41d9-4244-a02f-3a94819eaa8e`, schedule `0 6-21/3 * * *`
America/New_York) fires a full **agent turn** — `sessionTarget: isolated`,
`model: ollama/llama3.2:latest`, `toolsAllow: [exec]` — every fire, purely to
run `heartbeat.sh` and, on a non-zero exit, forward the rc + log tail to the
Rescue Rangers room. That is an Ollama-Cloud furnace: an LLM turn for work that
needs no model. (It has additionally been failing closed — 8 consecutive
`skipped` fires — because its `announce → last` delivery has no route.)

**Fix.** Run it as a **direct command**, exactly like the poller and the
receiver watchdog already do in the system crontab:

- `fleet-heartbeat-cron.sh` — deterministic wrapper reproducing the agent
  turn's behaviour with plain shell: run `heartbeat.sh`; on non-zero exit send
  `fleet-heartbeat rc=<rc>` + last 20 log lines to the Rescue Rangers room
  **through the gateway** (`openclaw message send`, never a raw curl). The chat
  id comes from `RESCUE_RANGERS_CHAT_ID` / `RESCUE_RANGERS_HELP_CHAT_ID` in the
  `.env` — never hard-coded (fleet-wide repo).
- Choose **one** scheduler:
  - **launchd** — `ai.openclaw.fleet-heartbeat.plist` (modelled on
    `ai.openclaw.rescue-receiver.plist`), or
  - **crontab** — the single line in `fleet-heartbeat.crontab`, sitting beside
    the existing `rescue-rangers-poller.sh` / `rescue-receiver-watchdog.sh`
    lines. This matches "how the poller and watchdog already run" most exactly.

Both preserve the original `0 6-21/3` schedule (minute 0 of hours
6, 9, 12, 15, 18, 21, local tz = America/New_York).

**Deploy (operator, deliberate — this is a live scheduler change):**
```bash
# 1. install the direct-command scheduler (pick ONE):
#    -- launchd -- (the plist ships with __HOME__/__CLAWD_HOME__ placeholder
#       tokens so no operator path is ever committed; expand them at install)
sed -e "s#__HOME__#${HOME}#g" \
    -e "s#__CLAWD_HOME__#${CLAWD_HOME:-${HOME}/clawd}#g" \
    ai.openclaw.fleet-heartbeat.plist > ~/Library/LaunchAgents/ai.openclaw.fleet-heartbeat.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.fleet-heartbeat.plist
#    -- OR crontab -- add the line from fleet-heartbeat.crontab via `crontab -e`

# 2. verify one manual fire works end-to-end:
HEARTBEAT_MODE=smoke-test /opt/homebrew/bin/bash \
  "$HOME"/clawd/fleet-heartbeat/scripts/fleet-heartbeat-cron.sh
tail -n 20 "$HOME"/clawd/fleet-heartbeat/logs/heartbeat.log

# 3. ONLY after the direct fire is confirmed, retire the LLM-turn cron:
openclaw cron delete 3f0f33c9-41d9-4244-a02f-3a94819eaa8e
```

> Sequencing matters: install + verify the replacement **before** removing the
> OpenClaw cron so the heartbeat is never left unscheduled. Removing the
> OpenClaw cron is the operator's deliberate step — this fix ships the
> mechanism; it does not tear down the live cron on its own.

**Rollback:** `launchctl bootout gui/$(id -u)/ai.openclaw.fleet-heartbeat`
(or remove the crontab line) and re-create the OpenClaw cron from the payload
recorded above.
