# Environment File Persistence

The BlackCEO Command Center reads its configuration (API keys, gateway URLs, feature toggles) from a `.env` file at boot. Where that file lives differs between the operator's Mac Mini install and the Hostinger VPS Docker install. On Hostinger, there are actually TWO `.env` files in play (one on the host, one in the container) and they serve different purposes. This document explains where each file lives, why, how to safely modify it, and how to avoid the common pitfall of editing the wrong one.

## 1. Mac Mini

On the operator's Mac Mini, the env file lives in the operator's home directory tree, typically:

  - `~/Documents/<client-slug>/.env` for a per-client local install (when the Mac is acting as a deployment target rather than a developer workstation), OR
  - `<repo-root>/.env` for the developer workstation install (the v4 build's working directory)

The exact location is set by `scripts/install/mac-mini-bootstrap.sh` at install time. The bootstrap writes a sentinel file at `~/.openclaw/bootstrap-state.json` recording the chosen env path.

Persistence model: the file lives on the local APFS volume. It persists across reboots and across logins. It is not synced to iCloud Drive by default. The operator's own backup discipline is the only protection against data loss; the operator typically copies the env file to a password manager (1Password) after every meaningful change.

The dashboard reads the env file at boot via Next.js's built-in dotenv loading (which respects `NODE_ENV` and merges `.env`, `.env.local`, `.env.production`). On the Mac the boot path is `pm2 start ecosystem.config.cjs`. PM2 starts Next.js with the resolved env baked into the process.

## 2. VPS Docker (Hostinger)

Two `.env` files exist on a Hostinger VPS Docker deployment. They are NOT redundant. They serve different purposes and the operator must understand both.

### 2a. Container-internal env file (canonical)

  - Path inside the container: `/data/.openclaw/.env`
  - Other documented fallback paths (used by older OpenClaw versions): `/data/.openclaw/workspace/.env`, `/data/openclaw/.env`, `/data/blackceo/.env`

This file is INSIDE the OpenClaw Docker container. Because Hostinger mounts `/data` as a persistent Docker volume, the file survives container recreate. You can `docker compose up -d --force-recreate` and the env file remains intact.

This is the canonical source of truth for the running dashboard. The dashboard process reads from this file at boot.

How to edit:

  ```bash
  docker exec -it <container> bash
  vi /data/.openclaw/.env
  exit
  docker exec <container> pm2 restart blackceo-command-center --update-env
  ```

Why the dashboard reads from here and not from process env: the dashboard intentionally re-reads the env file at boot from disk rather than relying on the env vars baked into the container at start time. This gives the operator the ability to change configuration without recreating the container. PM2's `--update-env` flag picks up changes from the file.

### 2b. Host-level env file (Hostinger Docker Manager UI)

  - Path on the bare VPS host: `/docker/<project>/.env`
  - Managed via Hostinger's Docker Manager UI under the Environment Variables tab for the project.

This file is on the HOST filesystem, not inside the container. When you edit env vars in the Hostinger UI, the UI writes to this file. Then, on the next `docker compose up`, those env vars are injected into the container as process env (via the `env_file:` directive in `docker-compose.yml`).

This file is what the operator sees when they open Hostinger's web dashboard. It is NOT what the running BlackCEO dashboard reads at runtime. It is consumed only at container-start time.

There are two important consequences:

  1. Editing `/docker/<project>/.env` via the Hostinger UI requires a `docker compose up -d --force-recreate` to take effect. `docker compose restart` is NOT enough; restart does not reload env_file changes. See the `docker-compose-restart-vs-up` memory entry for the source incident.
  2. If you also have keys set inside the container at `/data/.openclaw/.env`, those override anything set in the host env file (because the dashboard reads from the in-container file directly). Operators have lost time chasing "I set this in the Hostinger UI but the dashboard doesn't see it" when the issue was an old value in the in-container env file taking precedence.

### Which file to edit when

  - For runtime API key changes that should take effect immediately: edit the in-container file (`/data/.openclaw/.env`). PM2 `--update-env` picks up the change without recreating the container.
  - For env vars that need to be set at container start (rare; mostly things consumed by entrypoint scripts before the dashboard boots): edit the host file via the Hostinger UI and follow up with `docker compose up -d --force-recreate`.
  - For most operator workflows, only the in-container file matters.

### Why both files exist

Hostinger's Docker Manager UI offers env editing as a feature. Operators who do not SSH into the container expect this UI to be the source of truth. But the dashboard needs runtime env reload without container recreate, so it reads its own file inside the persistent volume. The OpenClaw onboarding flow handles this by writing keys to both files at install time, so the initial state is consistent. Drift only happens when an operator edits one file but not the other after install.

Best practice: pick one file as your source of truth (recommended: the in-container file at `/data/.openclaw/.env`) and let the other go stale. Document this choice in your team's internal runbook.

## 3. Persistence across container recreate

This is the failure mode the operator cares about most: "I rebuilt the container and lost my keys."

The in-container file at `/data/.openclaw/.env` lives on the `/data` mount, which is a Hostinger-managed persistent Docker volume. The volume persists across:

  - `docker compose down && docker compose up -d`
  - `docker compose up -d --force-recreate`
  - Image upgrades via `docker compose pull && docker compose up -d --force-recreate`
  - Hostinger VPS restarts

The volume does NOT persist across:

  - Hostinger volume deletion (rare, manual action)
  - Switching to a different Hostinger plan that migrates to a new physical host (Hostinger usually preserves volumes here, but verify in their docs before doing the migration)
  - `docker volume rm <name>` (operator must explicitly do this)

Reference: Hostinger's official guidance on Docker environment variables is at https://www.hostinger.com/tutorials/docker-environment-variables. The OpenClaw documentation on environment configuration is at https://docs.openclaw.ai/configuration/environment.

## 4. Atomic-write pattern

Every code path that writes to the env file MUST use the atomic-write pattern. A partial-write would leave the dashboard unable to boot. The pattern:

  1. Read the existing file into memory.
  2. Compute the new content (existing lines unchanged plus appended new lines; do NOT edit or remove existing lines unless the operator explicitly asked).
  3. Write to a sibling temp file in the SAME directory (so the rename in step 5 is atomic on POSIX): for example `/data/.openclaw/.env.tmp.<pid>`.
  4. `fsync` the temp file. Then open and `fsync` the parent directory so the directory entry hits disk.
  5. `rename(.env.tmp.<pid>, .env)`. On POSIX, this is an atomic replacement. Any reader either sees the old file or the new file, never a half-written file.
  6. If any step fails, delete the temp file and report. The original file is untouched.

Shared helper: `src/lib/env/atomic-write.ts` exports `writeEnvFileAtomic(absolutePath, contents)`. All env-writing code MUST go through this helper.

Pseudocode:

```ts
import { promises as fs } from 'fs';
import path from 'path';

export async function writeEnvFileAtomic(target: string, contents: string): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.env.tmp.${process.pid}.${Date.now()}`);
  await fs.writeFile(tmp, contents, { mode: 0o600 });
  const fh = await fs.open(tmp, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  const dh = await fs.open(dir, 'r');
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
  await fs.rename(tmp, target);
}
```

Notes:

  - Mode 0o600 (operator read/write only) is intentional. The env file contains API keys and must not be world-readable.
  - The temp file name includes pid and timestamp so two concurrent writers do not collide on the same temp name. Concurrency on the same target is otherwise the operator's responsibility; the writer should hold an in-process lock if it expects parallel callers.
  - On some filesystems `fsync` on the directory is a no-op. The code still attempts it for correctness on filesystems where it matters (ext4 with default options, for example).

## 5. Reading and merging existing values

When appending new keys, never overwrite an existing key the client has set. Parse the file as ordered key=value lines (preserving comments and blank lines), then append new lines at the end. If you must replace a value, write a comment line above the new line stating the date and reason for the replacement, and keep the old line commented out. The operator can audit the diff later.

Example after appending three new keys:

```
# Existing keys (unchanged)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OPENCLAW_GATEWAY_URL=http://localhost:8765
OPENCLAW_GATEWAY_TOKEN=...

# Appended 2026-05-26 during v4.0.1 update
FISH_AUDIO_API_KEY=...
FISH_AUDIO_VOICE_ID=...
X_AI_API_KEY=xai-...
```

## 6. Common pitfalls

  - **Editing `/docker/<project>/.env` and expecting changes to take effect.** Requires `docker compose up -d --force-recreate`. `restart` is not enough.
  - **Editing inside the container without `--update-env`.** PM2 will continue to use the previous env unless you pass `--update-env` to the restart command.
  - **Mode 0644 on the env file.** Other processes on the host can read it. Always 0600. The atomic-write helper enforces this.
  - **Writing the temp file in a different directory than the target.** `rename` across filesystems is not atomic. Always write the temp in the same directory.
  - **Forgetting the host-level file exists.** If the operator set a key via Hostinger's UI and the dashboard does not see it, check whether the in-container file is also setting the same key with an old value.

## 7. Related references

  - Hostinger tutorial: https://www.hostinger.com/tutorials/docker-environment-variables
  - OpenClaw docs: https://docs.openclaw.ai/configuration/environment
  - Memory entries: `openclaw-hostinger-env-file-location`, `docker-compose-restart-vs-up`, `hostinger-whatsapp-env-trigger`, `openclaw-vps-docker-persistent-upgrade`.
  - Related docs: [`PLATFORM_DETECTION.md`](./PLATFORM_DETECTION.md), [`MULTI_CLIENT_ROLLOUT.md`](./MULTI_CLIENT_ROLLOUT.md).
