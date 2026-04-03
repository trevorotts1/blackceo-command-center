# Mission Control Deployment Playbook

> **WARNING: Never run `pm2 restart` directly. Always use `deploy.sh`.**

---

## Quick Deploy

```bash
~/projects/mission-control/scripts/deploy.sh
```

That's it. The script handles everything: backup, build, restart, health check, and automatic rollback if needed.

---

## The Golden Rules

| Rule | Why It Matters |
|------|----------------|
| **NEVER** run `pm2 restart` directly | Bypasses backups, health checks, and rollback protection |
| **ALWAYS** backup `.next` and database | Enables instant rollback if build fails |
| **ALWAYS** do `rm -rf .next` before building | Prevents cache corruption and stale artifacts |
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
5. **Restarts PM2** — Restarts the `mission-control` process
6. **Health checks** — Verifies the site returns HTTP 200
7. **Auto-rollback** — If health check fails, restores backups and restarts

---

## Rollback Instructions

### If deploy.sh fails and you need manual rollback:

```bash
# 1. Stop the current process
pm2 stop mission-control

# 2. Restore the build backup
cd ~/projects/mission-control
rm -rf .next
cp -r .next-backup .next

# 3. Restore the database backup
cp mission-control.db.backup mission-control.db

# 4. Restart PM2
pm2 restart mission-control

# 5. Verify the site
sleep 5
curl -s -o /dev/null -w "%{http_code}" https://trevor.zerohumanworkforce.com
# Should return: 200
```

### Emergency: Full Reset and Rebuild

If backups are corrupted or missing:

```bash
cd ~/projects/mission-control

# Stop PM2
pm2 stop mission-control

# Clean everything
rm -rf .next
rm -rf node_modules
rm -f package-lock.json

# Fresh install and build
npm install
npm run build

# Restart
pm2 restart mission-control

# Verify
sleep 5
curl -s -o /dev/null -w "%{http_code}" https://trevor.zerohumanworkforce.com
```

---

## Cloudflare Tunnel (Mac Only)

> **If you are on VPS/Hostinger: SKIP this entire section.**
> Your dashboard is already publicly accessible via your VPS IP on port 3000.
> No tunnel needed. Just make sure port 3000 is open in your firewall.

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
- **Manual check:** `pm2 logs mission-control` to see startup errors

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
pm2 start npm --name "mission-control" -- start
```

### Health check returns 000 (no response)
- Check Cloudflare tunnel status (Mac only — VPS users skip this)
- Check PM2 logs: `pm2 logs mission-control`
- Verify DNS resolves: `nslookup trevor.zerohumanworkforce.com`

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
| `pm2 logs mission-control` | View app logs |
| `pm2 logs mission-control --lines 100` | View last 100 lines |
| `pm2 stop mission-control` | Stop the process |
| `pm2 restart mission-control` | Restart (use deploy.sh instead) |
| `pm2 delete mission-control` | Remove from PM2 |

---

## Site Details

| Property | Value |
|----------|-------|
| **App Directory** | `~/projects/mission-control` |
| **PM2 Process Name** | `mission-control` |
| **Production URL** | https://trevor.zerohumanworkforce.com |
| **Database File** | `mission-control.db` |
| **Build Output** | `.next/` |
| **Backup Location** | `.next-backup/` |

---

**Last Updated:** March 21, 2026
