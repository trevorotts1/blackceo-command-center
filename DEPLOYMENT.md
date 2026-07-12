# Command Center Deployment Playbook

> **WARNING: Never run `pm2 restart` directly. Always use `update.sh` (which routes through `scripts/atomic-deploy.sh`).**
>
> **`scripts/deploy.sh` is DEPRECATED.** It does a non-atomic `rm -rf .next` before
> building, which opens a window where the server has no build to serve if the
> build fails mid-way. `update.sh` / `scripts/atomic-deploy.sh` build into a temp
> directory and atomically swap `.next` in with a single `mv` — there is never a
> missing-build window, and a failed health check triggers a verified auto-rollback.
> Prefer `update.sh` for every manual and automated deploy.

---

## Quick Deploy

```bash
~/projects/command-center/update.sh
```

That's it. The script handles everything: backup, git pull, `npm ci`, build (atomic,
temp-dir + swap), pm2 restart, health check, and automatic rollback if needed —
via `scripts/atomic-deploy.sh`.

For a build+restart ONLY (no git pull — e.g. after hand-editing source on the
box), call `scripts/atomic-deploy.sh` directly:
```bash
bash ~/projects/command-center/scripts/atomic-deploy.sh \
  --app-dir ~/projects/command-center --pm2-app blackceo-command-center --port 4000
```

---

## The Golden Rules

| Rule | Why It Matters |
|------|----------------|
| **NEVER** run `pm2 restart` directly | Bypasses backups, health checks, and rollback protection |
| **NEVER** use `scripts/deploy.sh` | Deprecated — non-atomic `rm -rf .next` window; use `update.sh` / `atomic-deploy.sh` |
| **ALWAYS** let `atomic-deploy.sh` snapshot `.next` before building | Enables instant, verified rollback if the build or health check fails |
| **NEVER** hand-delete `.next` before a build | `atomic-deploy.sh` builds into a temp dir and atomically `mv`s it in — there is no window where `.next` is missing; a manual `rm -rf .next` recreates exactly the failure mode this script exists to close |
| **ALWAYS** health check after restart | Confirms the site is actually serving 200 OK |
| **ROLLBACK** automatically if health check fails | Prevents extended downtime |

---

## Deployment Playbook

### Standard Deploy

1. **Navigate to the project:**
   ```bash
   cd ~/projects/mission-control
   ```

2. **Run the deploy script:**
   ```bash
   ./scripts/deploy.sh
   ```

3. **Watch the output.** The script will show:
   - Build backup status
   - Database backup status
   - Build progress (last 5 lines)
   - PM2 restart confirmation
   - Health check result (HTTP 200 = success)

4. **Done.** If you see `=== Deploy Complete ===`, the deployment succeeded.

### What the Script Does

1. **Backs up current build** — Copies `.next/` to `.next-backup/`
2. **Backs up database** — Copies `mission-control.db` to `mission-control.db.backup`
3. **Cleans old build** — Removes `.next/` to prevent cache corruption
4. **Builds the app** — Runs `npm run build`
5. **Restarts PM2** — Restarts the `blackceo-command-center` process
6. **Health checks** — Verifies the site returns HTTP 200
7. **Auto-rollback** — If health check fails, restores backups and restarts

---

## Rollback Instructions

### If deploy.sh fails and you need manual rollback:

```bash
# 1. Stop the current process
pm2 stop blackceo-command-center

# 2. Restore the build backup
cd ~/projects/mission-control
rm -rf .next
cp -r .next-backup .next

# 3. Restore the database backup
cp mission-control.db.backup mission-control.db

# 4. Restart PM2
pm2 restart blackceo-command-center

# 5. Verify the site
sleep 5
curl -s -o /dev/null -w "%{http_code}" https://<your-subdomain>.zerohumanworkforce.com
# Should return: 200
```

### Emergency: Full Reset and Rebuild

If backups are corrupted or missing:

```bash
cd ~/projects/mission-control

# Stop PM2
pm2 stop blackceo-command-center

# Clean everything
rm -rf .next
rm -rf node_modules
rm -f package-lock.json

# Fresh install and build
npm install
npm run build

# Restart
pm2 restart blackceo-command-center

# Verify
sleep 5
curl -s -o /dev/null -w "%{http_code}" https://<your-subdomain>.zerohumanworkforce.com
```

---

## Automated Sunday Update Path (P1-07)

Every client box self-updates automatically every Sunday ~3:00 AM. This section
is the one-page answer to "what runs, which file, what proves success, how to
roll back" for that automated path — see also the onboarding repo's
`UPDATE-PLAYBOOK.md` ("Automated Command Center Update — Sunday 3AM (P1-07)"
section) for the ONBOARDING-side half of this same chain.

### What runs, in order

1. **Cron** (installed by the onboarding repo's `scripts/setup-weekly-update.sh`):
   `0 3 * * 0` → `~/.openclaw/skills/.update-restart-if-needed`, which downloads
   and runs the LATEST `update-skills.sh` from `openclaw-onboarding` (never a
   stale local copy).
2. **`update-skills.sh` D5 block** runs the on-box Skill 32 installer:
   `32-command-center-setup/scripts/run-full-install.sh --update-only`.
3. **`run-full-install.sh` Phase 6 (update-only)** does the ONBOARDING-owned
   half: `git pull --ff-only` in the CC checkout, `npm install`, writes
   `.env.local` (gateway token / sovereign model / API-auth posture), runs
   `npm run db:push`, verifies the DATA-08 decoy-DB parity guard, reconciles
   any duplicate pm2 aliases down to one canonical process — then calls
   `cc_route_update_through_canonical_path()`, which is where control passes
   to THIS repo.
4. **THIS repo's `update.sh`** (owns the CC-side half): backs up critical
   files, pulls/verifies the checkout, `npm ci`, then **Step 5: Build +
   restart (atomic deploy)** — routes through `scripts/atomic-deploy.sh`.
5. **`scripts/atomic-deploy.sh`**: builds into a temp dir, gates on a FRESH
   `.next/BUILD_ID` (mtime newer than build start — never accepts a stale
   artefact), atomically swaps `.next` in with one `mv` (no missing-build
   window), restarts pm2, health-checks via `scripts/cc-health-check.sh`, and
   **auto-rolls back to the prior build if the health check is not green**
   (never on exit-3 UNKNOWN — that pauses/retries instead, per the B.2 spec).

### What proves success

- `atomic-deploy.sh` exit 0 ("green") — a fresh `.next/BUILD_ID` (mtime after
  build start) is live AND `cc-health-check.sh` returned green.
- The onboarding-side `cc_route_update_through_canonical_path()` re-checks
  this INDEPENDENTLY (belt-and-suspenders, doesn't just trust the exit code):
  `.next/BUILD_ID` mtime newer than the pull timestamp AND
  `curl -fsS localhost:4000/api/health` returns `200`. It stamps
  `commandCenterLastUpdateVerified` (true/false) in the box's build-state
  file either way — this is the single source of truth for "did Sunday's CC
  update actually take effect," not a log line or an exit code.

### How to roll back

- **Automatic (the normal case):** `atomic-deploy.sh` already rolled back and
  health-verified the prior build BEFORE the script even returns — no action
  needed. Check `pm2 logs blackceo-command-center` and the receipt in the
  update log for why the new build failed health.
- **Manual, same box:** `bash ~/projects/command-center/scripts/atomic-deploy.sh`
  re-run resnapshots and retries. To restore the LAST rollback artifact by
  hand: `rm -rf ~/projects/command-center/.next && cp -r ~/projects/command-center/.next.rollback ~/projects/command-center/.next && pm2 restart blackceo-command-center`.
- **Repo-level (a bad merge, not a bad box):** `git revert` the offending
  commit on `main` and let the next Sunday run (or a manual `update.sh`
  re-run) pull the reverted code — same atomic/health/rollback contract
  applies to a revert exactly as it does to a forward fix.

### Docker VPS boxes

CC runs as a pm2 process INSIDE the same OpenClaw container as the gateway
(`scripts/install/vps-docker-bootstrap.sh`) — there is no separate
docker-compose-managed "CC container" to recreate for a code-only update; the
in-container git-pull + build + pm2-restart chain above is identical to Mac.
The checkout lives under `/data/projects/command-center` specifically because
`/data` is the persistent bind-mounted volume, so the CC checkout + database
survive a `docker compose up -d --force-recreate` of the OUTER container (a
DIFFERENT, less-frequent maintenance action — e.g. an image/dependency bump —
from the Sunday CC code update). **Never** use bare `docker compose restart`
for that outer-container action; it skips `env_file` re-read.

---

## Cloudflare Tunnel (Mac Only)

> **If you are on VPS/Hostinger: SKIP this entire section.**
> Your dashboard is already publicly accessible via your VPS IP on port 4000.
> No tunnel needed. Just make sure port 4000 is open in your firewall.

For Mac Mini deployments, use `scripts/setup-tunnel-daemon.sh` to set up a Cloudflare tunnel.
This creates a macOS LaunchAgent that auto-restarts the tunnel if it dies.

---

## Known Issues

### Cloudflare Caching
- **Symptom:** Changes not visible after deploy
- **Fix:** Hard refresh browser with `Command+Shift+R` (Mac) or `Ctrl+Shift+R` (Windows)
- **Note:** This is client-side caching, not a deployment issue

### .next Directory Corruption
- **Symptom:** PM2 serves stale/corrupt content even with correct source code
- **Cause:** Next.js build cache becomes inconsistent
- **Fix:** The deploy script always runs `rm -rf .next` before building
- **Lesson learned:** Never skip the clean step

### 502 Errors on PM2 Restart
- **Symptom:** Site returns 502 Bad Gateway immediately after restart
- **Cause:** PM2 crashes or Next.js app fails to start
- **Fix:** The deploy script health-checks and auto-rolls back if this happens
- **Manual check:** `pm2 logs blackceo-command-center` to see startup errors

### Database Locked During Backup
- **Symptom:** Backup step hangs or fails
- **Cause:** Active database writes preventing copy
- **Fix:** The script uses simple `cp` which works even with locked SQLite databases
- **Note:** If issues persist, check `lsof mission-control.db` for open handles

---

## Pre-Deploy Checklist

Before every deployment, confirm:

- [ ] **Database is backed up** — `mission-control.db.backup` exists and is recent
- [ ] **Build is backed up** — `.next-backup/` exists and is recent
- [ ] **Clean build planned** — `rm -rf .next` will run before build
- [ ] **Health check enabled** — Script will verify HTTP 200 after restart
- [ ] **Rollback ready** — Previous backups are valid if rollback needed

---

## Troubleshooting

### Build fails with "out of memory"
```bash
# Increase Node memory limit
export NODE_OPTIONS="--max-old-space-size=4096"
./scripts/deploy.sh
```

### PM2 process not found
```bash
# Check if process exists
pm2 list

# If missing, recreate:
pm2 start npm --name "blackceo-command-center" -- start
```

### Health check returns 000 (no response)
- Check Cloudflare tunnel status (Mac only — VPS users skip this)
- Check PM2 logs: `pm2 logs blackceo-command-center`
- Verify DNS resolves: `nslookup <your-subdomain>.zerohumanworkforce.com`

### Rollback loop (keeps rolling back)
1. Check if issue is with new code (build succeeds but app crashes)
2. Review `pm2 logs` for runtime errors
3. Fix the underlying issue in source code
4. Deploy again

---

## PM2 Quick Reference

| Command | Purpose |
|---------|---------|
| `pm2 list` | Show all processes |
| `pm2 logs blackceo-command-center` | View app logs |
| `pm2 logs blackceo-command-center --lines 100` | View last 100 lines |
| `pm2 stop blackceo-command-center` | Stop the process |
| `pm2 restart blackceo-command-center` | Restart (use deploy.sh instead) |
| `pm2 delete blackceo-command-center` | Remove from PM2 |

---

## Site Details

| Property | Value |
|----------|-------|
| **App Directory** | `~/projects/mission-control` |
| **PM2 Process Name** | `blackceo-command-center` |
| **Production URL** | https://<your-subdomain>.zerohumanworkforce.com |
| **Database File** | `mission-control.db` |
| **Build Output** | `.next/` |
| **Backup Location** | `.next-backup/` |

---

**Last Updated:** March 21, 2026
