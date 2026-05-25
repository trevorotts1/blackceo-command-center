# Multi-Client Rollout Playbook

This document is the operator-facing playbook for rolling a new BlackCEO Command Center release out to existing client deployments. It mirrors Section 6 of the v4.0.1 post-build-fixes directive but stays release-version-agnostic, so you can reuse it for v4.0.2, v4.1.0, and beyond.

The core rule: one client at a time, backup before any change, never leave a deployment half-updated.

## 1. Discovery: enumerate every deployment

The operator maintains the canonical client list. Discover targets by any combination of:

  - Reading `~/Documents/clients-registry.json` on the operator's Mac Mini if it exists.
  - Listing all `*.zerohumanworkforce.com` subdomains configured in Cloudflare (account-level DNS query).
  - Querying the operator's GitHub for forked or instantiated client repositories under `trevorotts1/*`.
  - Asking the operator directly via Telegram or in person.

For each client deployment, gather:

  - Subdomain (for example `clientname.zerohumanworkforce.com`)
  - VPS host and SSH or Hostinger credentials path
  - OpenClaw container ID (the Docker container running on Hostinger)
  - Client's Telegram chat_id (for the interactive update flow). See `fleet-chat-id-discovery` memory entry for how to find this if unknown.
  - Currently installed version (read from the deployed `version` file via the dashboard's `/api/health` endpoint or via SSH)

Write the discovered targets to `rollout-targets.json` at the repo root. This file is gitignored; it holds operational data, not source. Format:

```json
{
  "release": "v4.0.1",
  "targets": [
    {
      "slug": "acme",
      "subdomain": "acme.zerohumanworkforce.com",
      "vps_host": "...",
      "openclaw_container": "...",
      "telegram_chat_id": "...",
      "current_version": "v4.0.0"
    }
  ]
}
```

## 2. Pre-flight checks per client

Before touching any deployment, verify:

### OpenClaw compatibility

  - curl `https://docs.openclaw.ai/api/version` (or scrape the docs page if no API) to get the current OpenClaw version range.
  - Read the client's deployed OpenClaw version via the gateway: `docker exec <container> openclaw --version`.
  - If the client's OpenClaw is older than the new release's minimum supported OpenClaw, ABORT for this client and Telegram both the client and the operator. Template: "Your OpenClaw is on version X. Zero Human Company Command Center v[new] requires OpenClaw version Y or higher. Please update OpenClaw first. See https://docs.openclaw.ai/upgrade."

### Disk space

  - At least 500 MB free on the VPS volume (`df -k /data | tail -1`).
  - Below threshold means the rebuild may not complete. Abort and notify.

### Backup capability

  - Confirm write access to the backup directory by creating and deleting a sentinel file. If the write fails, abort and notify.

### Cloudflare Tunnel and Access

  - Curl the subdomain with `-H 'Cf-Access-Client-Id: bypass-check'` to confirm the tunnel is up.
  - Verify the Cloudflare Access app exists for this subdomain (see [`CLOUDFLARE_ACCESS_SETUP.md`](./CLOUDFLARE_ACCESS_SETUP.md)).

If ANY pre-flight check fails, do not start the update for this client.

## 3. Backup procedure

Run all of these inside the OpenClaw container before changing anything.

  1. Tag the current git HEAD: `git tag pre-<new-version>-backup-$(date +%Y%m%d-%H%M%S)`.
  2. Copy the SQLite database: `cp mission-control.db mission-control.db.backup-pre-<new-version>`.
  3. Copy the env file: `cp <env-path> <env-path>.backup-pre-<new-version>`. Env path is determined by Section 4 below.
  4. Snapshot the vault directory: `tar -czf vault-backup-pre-<new-version>.tar.gz workspace/` (or rsync to a sibling directory).
  5. Snapshot the operator scratch root similarly.

If any backup step fails, ABORT the update for this client and Telegram the operator with the failing step and full error output. Never proceed without a complete backup set.

## 4. Env file location probing

The env file lives INSIDE the OpenClaw container on Hostinger, not on the bare VPS host. This is essential for persistence across container restarts because Hostinger mounts the container's `/data` as a persistent volume.

The canonical path depends on the OpenClaw version. Probe these locations in order:

  1. Curl `https://docs.openclaw.ai/manifest/env-paths.json` if OpenClaw publishes a manifest. Use the first listed canonical path.
  2. Otherwise scrape `https://docs.openclaw.ai/configuration/environment` for the documented path.
  3. Otherwise fall back to these known paths in order:
     - `/data/.openclaw/.env` (current canonical)
     - `/data/.openclaw/workspace/.env`
     - `/data/openclaw/.env`
     - `/data/blackceo/.env` (BlackCEO-specific override location)
  4. If none of these exist, the client is on a non-standard setup. Telegram the operator: "Client [name] does not have a Docker-persisted env file in any of the standard locations. They may be running BlackCEO outside the OpenClaw container or on bare metal. Manual review required before update." Abort.

Note: Hostinger's Docker Manager UI ALSO writes a HOST-level `/docker/<project>/.env` file that becomes container env vars at boot. See [`ENV_FILE_PERSISTENCE.md`](./ENV_FILE_PERSISTENCE.md) for the full distinction. Most clients have BOTH files. The in-container env file is the one we modify because changes survive container recreate without dashboard intervention. After modifying it, you usually do NOT need to touch the host-level `.env`.

Once the canonical env file is located, the update process:

  - READS the existing file to preserve all current settings.
  - APPENDS new env vars only. Never overwrites or removes anything the client has set.
  - Writes atomically (see Section 6 below) so a crash mid-update does not corrupt the file.

## 5. The update flow per client

Sequential per client. Do NOT batch parallel updates across clients. One failure should never cascade.

  1. **Notify start.** Telegram the client: "Hi [client name], your Zero Human Company Command Center is about to update from v[old] to v[new]. This will take about 5 to 10 minutes. I'll let you know when it's done."
  2. **Pre-flight checks** (Section 2). On any failure, abort and notify.
  3. **Backups** (Section 3). On any failure, abort and notify.
  4. **Locate env file** (Section 4). On not-found, abort and notify.
  5. **Pull updates:**
     ```bash
     docker exec <container> bash -c 'cd /data/blackceo && git fetch --tags && git checkout v<new>'
     ```
     If git checkout fails because of uncommitted changes on the client's tree, stash them, retry, restore the stash after the migration step. Log the stash hash to the rollout report.
  6. **Install new dependencies:**
     ```bash
     docker exec <container> bash -c 'cd /data/blackceo && npm install'
     ```
  7. **Rebuild native modules:**
     ```bash
     docker exec <container> bash -c 'cd /data/blackceo && npm rebuild better-sqlite3'
     ```
  8. **Apply database migrations.** The migration runner auto-applies missing migrations on next boot. Verify via `GET /api/health` after restart that the expected migration list is applied.
  9. **Detect missing env vars.** Parse the env file. Compare against the env var manifest for the new release (see the new release's `docs/ENV_VARS.md` or `7.4 Required and optional env vars` in the release notes). Identify gaps.
 10. **Telegram interactive key collection** (Section 7). Walk the client through each missing key.
 11. **Append collected keys to env file** using the atomic-write pattern from Section 6 below.
 12. **Build the app:**
     ```bash
     docker exec <container> bash -c 'cd /data/blackceo && npm run build'
     ```
 13. **Restart PM2 services:**
     ```bash
     docker exec <container> bash -c 'pm2 restart blackceo-command-center --update-env && pm2 save'
     ```
 14. **Health check:**
     - `curl https://<subdomain>/api/health` must return 200 with the new version and the expected migration list.
     - `curl https://<subdomain>/api/system/status` should return all components live or with explained degradation.
     - Run `scripts/integration-tests/vps-docker-compat.sh` inside the container.
 15. **Notify completion.** Telegram the client a release-specific message listing new features. For v4.0.1: "Your Zero Human Company Command Center is now on v4.0.1. New features available: Operator Console (chat with Claude Code, Codex, Antigravity, Hermes, Gemini, Free Claude Code; Studio for media; Notebook for research; Goals/Journal/Memory; Research with Grok Live Search; half-duplex Call Mode; Web Agent for browser automation). Log in to your dashboard to explore. Reply with any questions."
 16. **Notify operator.** Telegram or Slack: "Client [name] updated to v[new] successfully. New env vars accepted: [list]. Skipped optional features: [list]."

## 6. Atomic env file write

Never partial-write the env file. A crash mid-write would leave the client unable to boot the dashboard. The pattern:

  1. Read existing `.env` into memory.
  2. Compute the new content (existing lines plus appended keys; never edit or remove existing lines).
  3. Write to a sibling `.env.tmp` in the same directory (same filesystem so rename is atomic).
  4. `fsync` the temp file. Then `fsync` the parent directory.
  5. `rename(.env.tmp, .env)`. POSIX guarantees atomic replacement on the same filesystem.
  6. If any step fails, delete the `.env.tmp` and report. The original `.env` is untouched.

This pattern is documented at [`ENV_FILE_PERSISTENCE.md`](./ENV_FILE_PERSISTENCE.md) Section 4. The shared helper is at `src/lib/env/atomic-write.ts`.

## 7. Telegram interactive key collection

For each missing optional env var, the bot sends an interactive prompt. The bot must be patient and conversational.

Template prompts per feature:

  - **Fish Audio:** "Do you want voice synthesis powered by Fish Audio in Call Mode? Fish Audio has very natural-sounding voices. If yes, paste your Fish Audio API key from https://fish.audio/account. If no, reply 'skip'. You can always add this later in your settings."
  - **xAI (Grok):** "Do you want to enable Grok models (xAI) for chat and research? You'll need an xAI API key from https://x.ai/api. Paste it here, or reply 'skip'."
  - **ElevenLabs:** "Do you want voice synthesis powered by ElevenLabs in Call Mode? If yes, paste your ElevenLabs API key. If no, reply 'skip'."
  - **OpenAI:** "OpenAI is required for Call Mode default voice. Paste your OpenAI API key from https://platform.openai.com/api-keys. If you skip this, Call Mode will fall back to browser-native voice only."
  - **Kie.ai:** "Do you want Kie.ai (Sora video, Veo video) in Studio? Paste your Kie.ai API key, or reply 'skip'."
  - **Fal.ai:** "Do you want Fal.ai (image/video/audio gen) in Studio? Paste your Fal.ai API key, or reply 'skip'."
  - **Ollama Cloud:** "Do you want Ollama Cloud models in your model registry? Paste your Ollama Cloud API key, or reply 'skip'."
  - **OpenRouter:** "Do you want OpenRouter (access to many models with one key) in your model registry? Paste your OpenRouter API key, or reply 'skip'."

Validation rules per response:

  - If the client pastes a value, validate the prefix (`sk-` for OpenAI, `sk-ant-` for Anthropic, etc.). If it does not match, ask once more: "That doesn't look like a valid [provider] key. Please paste the full key including the prefix."
  - If the client replies "skip", record the skip and move on. The feature stays unavailable but the dashboard works.
  - If the client does not respond within 10 minutes, send one gentle nudge. After another 10 minutes with no response, complete the update with all remaining keys as skipped and tell the client they can add keys later via the Settings page.

Implementation: `src/lib/telegram/interactive-onboarding.ts`. State persists in the `onboarding_sessions` table.

## 8. Failure handling and rollback

If ANY step from 5 through 13 fails:

  1. STOP. Do not continue to later steps.
  2. Restore the env file from the backup.
  3. Restore the SQLite database from the backup if migrations were partially applied.
  4. `git checkout` back to the pre-update tag.
  5. `npm install && npm rebuild better-sqlite3 && npm run build` to restore a working state.
  6. `pm2 restart blackceo-command-center --update-env`.
  7. Health-check that the rolled-back state is healthy.
  8. Telegram the client: "Hi [name], the update didn't complete cleanly. I've rolled your system back to v[old]. Your data is safe and your dashboard works exactly as it did before. The operator has been notified and will follow up."
  9. Telegram or Slack the operator with: full error log, client name, the step that failed, the rollback outcome.

NEVER leave a client deployment in a half-updated state. The rollback is the contract.

## 9. One client at a time

  1. Start with the operator's own deployment (Trevor's personal one if it exists) as the canary. Verify everything works end to end before touching any client.
  2. Then update one client. Wait for their Telegram confirmation that the dashboard works for them before proceeding.
  3. Then the next. One at a time.
  4. If any client rejects the update (rolls back, refuses, etc.), PAUSE the entire rollout and notify the operator before proceeding to subsequent clients. The operator decides whether to investigate before resuming.

Why one at a time: a regression that we missed in QC is best caught at one client, not at five. The serialization cost (perhaps an extra hour total for a small fleet) is cheap insurance.

## 10. Post-rollout verification

After all clients are updated:

  - Build a rollout summary report at the repo root: `rollout-report-v<new>.md`.
  - Include per client: name, old version, new version, update timestamp, env vars added, env vars skipped, health check result, total elapsed time, any anomalies.
  - Telegram the operator with the report as a summary.
  - Append the report path to `~/clawd/fleet-heartbeat/change-log.md` (see `fleet-heartbeat` memory entry) so the next heartbeat cycle has the change documented.

## Related references

  - Post-build-fixes Section 6 (the source for this playbook).
  - [`ENV_FILE_PERSISTENCE.md`](./ENV_FILE_PERSISTENCE.md) for env file paths and the atomic write pattern.
  - [`PLATFORM_DETECTION.md`](./PLATFORM_DETECTION.md) for how platform detection routes the bootstrap script.
  - [`CLOUDFLARE_ACCESS_SETUP.md`](./CLOUDFLARE_ACCESS_SETUP.md) for the per-client edge auth setup.
  - Memory entries: `openclaw-vps-docker-persistent-upgrade`, `feedback-test-paste-commands-before-handing-off`, `feedback-github-is-source-of-truth`, `docker-compose-restart-vs-up`.
