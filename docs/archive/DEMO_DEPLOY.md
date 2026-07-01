# Demo Deployment Guide

Deploy Mission Control as a live, read-only demo at `missioncontrol.example.com`.

## Server: <demo-host> (Proxmox VM)

**SSH:** `ssh <demo-host>` (or `ssh root@<demo-server-ip> -p <ssh-port>`)

---

## Step 1: Install Node.js (if not installed)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version  # Should be v20+
```

## Step 2: Clone the repo

```bash
cd /var/www
git clone https://github.com/crshdn/mission-control.git mission-control-demo
cd mission-control-demo
```

## Step 3: Install dependencies

```bash
npm install
```

## Step 4: Create environment file

```bash
cat > .env.local << 'EOF'
# Demo mode — read-only, no auth needed
DEMO_MODE=true
DATABASE_PATH=./mission-control-demo.db
PORT=4000
EOF
```

## Step 5: Build

```bash
npm run build
```

## Step 6: Initialize and seed the database

```bash
# Start briefly to create schema
PORT=4000 npx next start -p 4000 &
sleep 5
curl -s http://localhost:4000/api/workspaces > /dev/null
kill %1
sleep 2

# Seed demo data
node scripts/demo-seed.js --db ./mission-control-demo.db
```

## Step 7: Install PM2 and start services

```bash
npm install -g pm2

# Start Mission Control
pm2 start "npx next start -p 4000" --name mc-demo --cwd /var/www/mission-control-demo

# Start the simulator (generates live activity every 15 seconds)
pm2 start scripts/demo-simulator.js --name mc-simulator --cwd /var/www/mission-control-demo -- --db ./mission-control-demo.db --interval 15000

# Save for auto-restart
pm2 save
pm2 startup  # Follow the output command
```

## Step 8: Set up Cloudflare tunnel

In the Cloudflare dashboard for `example.com`:

1. Go to **DNS** → Add a CNAME record:
   - **Name:** `missioncontrol`
   - **Target:** (your tunnel hostname)
   - **Proxy:** ON (orange cloud)

2. Or if using `cloudflared`:
```bash
cloudflared tunnel route dns <tunnel-id> missioncontrol.example.com
```

3. Add the tunnel config to route `missioncontrol.example.com` → `http://localhost:4000`

---

## Verify

- Visit `https://missioncontrol.example.com`
- You should see the demo banner at the top
- Tasks should be moving through the kanban board
- Live feed should show agent activity
- Try clicking "+ New Task" — should get a "demo mode" error toast

## Maintenance

```bash
# Check status
pm2 list

# View simulator output
pm2 logs mc-simulator --lines 20

# Reset demo data (re-seed)
pm2 stop mc-simulator mc-demo
rm mission-control-demo.db*
pm2 start mc-demo
sleep 5
curl -s http://localhost:4000/api/workspaces > /dev/null
pm2 stop mc-demo
node scripts/demo-seed.js --db ./mission-control-demo.db
pm2 start mc-demo mc-simulator

# Update code
git pull
npm install
npm run build
pm2 restart all
```
