# OpenClaw Bridge — Pairing & Connect Runbook

How the Command Center's **Operator Console → Bridge → OpenClaw** pill connects
to the OpenClaw gateway, and the exact per-box steps to pair a fresh deploy
without manual device surgery.

Applies to **v4.1.2+**.

---

## How it works (3 moving parts)

1. **Device identity (ed25519 keypair).** On first run the Command Center
   generates a keypair and persists it. The public-key fingerprint is the
   `deviceId` the gateway approves. It is stored at a path that survives a
   container redeploy:
   - **VPS Docker:** `/data/.openclaw/mission-control/identity/device.json`
     (under the Hostinger persistent volume).
   - **Mac Mini:** `~/.mission-control/identity/device.json`.
   - Override with `BCC_DEVICE_IDENTITY_DIR`.

   The identity is **never silently regenerated**. If the file is corrupt the
   app refuses to mint a new keypair (that would orphan an already-approved
   device); fix or delete the file deliberately.

2. **Gateway URL + token.**
   - `OPENCLAW_GATEWAY_URL` defaults to `ws://127.0.0.1:18789` (correct when the
     Command Center runs in the **same** container/host as the gateway — the
     normal install). Only set it when the gateway is on a different host
     (reach it over the Cloudflare Tunnel, e.g. `wss://gateway.example.com`).
   - `OPENCLAW_GATEWAY_TOKEN` — set when the gateway requires a token.
   - These must be set where pm2 actually inherits them: the container/host
     `.env` (`/docker/<project>/.env` on Hostinger) and/or the app-cwd
     `.env.local`. After editing, `pm2 restart mission-control --update-env`
     (plain `restart` does NOT reload env_file changes) or recreate the
     container.

3. **Pairing bootstrap.** On boot the Command Center fires a single,
   non-blocking connect attempt. This makes the gateway record this device as a
   **pending pairing request immediately after deploy** (instead of waiting for
   the first Bridge use). You then approve it once. Opt out with
   `DISABLE_BRIDGE_BOOTSTRAP=1`.

The connection state is surfaced at **`GET /api/openclaw/status`**:
- `connected: true` — paired and live.
- `connected: false, pairing_pending: true` — the device is not approved yet;
  the response includes `device_id` and a `remediation` string with the exact
  commands.
- `connected: false, pairing_pending: false` — the gateway is unreachable
  (check `OPENCLAW_GATEWAY_URL` / that the gateway is up).

---

## (i) Deploy this build — per box

### VPS Docker (Hostinger)

```bash
# On the host, in the project dir that holds docker-compose.yml + .env
cd /docker/<project>

# Pull the new Command Center image / source per your normal deploy, then:
docker compose up -d --force-recreate

# Confirm the app is up and see the device id the gateway must approve:
curl -s http://127.0.0.1:4000/api/openclaw/status | jq
# -> { "connected": false, "pairing_pending": true, "device_id": "<HEX>", ... }
```

If the Command Center runs **inside** the OpenClaw container, leave
`OPENCLAW_GATEWAY_URL` unset (loopback default). If it is a separate container,
set `OPENCLAW_GATEWAY_URL` + `OPENCLAW_GATEWAY_TOKEN` in
`/docker/<project>/.env`, then `docker compose up -d --force-recreate`.

### Mac Mini

```bash
# In the app dir
git pull   # or your deploy step
npm ci
npm run build
pm2 restart mission-control --update-env
curl -s http://127.0.0.1:4000/api/openclaw/status | jq
```

---

## (ii) Pair the device on the client gateway — the commands

Run on the **gateway host** (the box running `openclaw`). The bootstrap above
has already registered the pending request, so:

```bash
# 1. List pending pairing requests + paired devices. Find the requestId whose
#    device id matches the device_id from /api/openclaw/status.
openclaw devices list
# (machine-readable: openclaw devices list --json)

# 2. Approve that specific request. Omitting <requestId> only PREVIEWS the
#    newest pending request — you must pass the id to actually approve.
openclaw devices approve <requestId>
```

For a **remote** gateway, pass the URL + token explicitly (setting `--url`
disables config/env fallback, so `--token` is required):

```bash
openclaw devices list  --url wss://gateway.example.com --token "$OPENCLAW_GATEWAY_TOKEN"
openclaw devices approve <requestId> --url wss://gateway.example.com --token "$OPENCLAW_GATEWAY_TOKEN"
```

### Verify

```bash
curl -s http://127.0.0.1:4000/api/openclaw/status | jq '.connected'
# -> true
```

Then open **Operator Console → Bridge → OpenClaw** and send a message.

Because the identity now lives on the persistent volume, this approval is a
**one-time** step — it survives `docker compose up -d --force-recreate` and
redeploys. You do NOT have to re-approve on every redeploy (the v4.1.1 bug).

---

## VPS CLI pill behavior

On a **VPS install** the Bridge shows only the **OpenClaw** pill. The six
Mac-desktop CLIs (Claude Code, Codex, Antigravity, Hermes, Gemini, Free Claude
Code) are not installed in the container, so they are hidden. On **Mac Mini**
all seven pills show, unchanged.

Detection: `BCC_INSTALL_TYPE` env flag (`vps` | `mac`) wins if set; otherwise
auto-detect via `OPENCLAW_PLATFORM`, then the `/data/.openclaw` VPS marker,
else `mac-mini`.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `pairing_pending: true` after approve | approved a different requestId | re-run `openclaw devices list`, match `device_id` exactly, approve that id |
| `connected: false`, `pairing_pending: false` | gateway unreachable | check the gateway is up; verify `OPENCLAW_GATEWAY_URL`; for remote, confirm the CF Tunnel hostname |
| Re-prompts to pair after every redeploy | identity not on the persistent volume | confirm `device.json` is under `/data/...` (VPS); set `BCC_DEVICE_IDENTITY_DIR` if using a custom mount |
| `Refusing to regenerate` error in logs | `device.json` is corrupt | inspect it; if truly unrecoverable, delete it deliberately and re-pair |
| env vars not taking effect | pm2 didn't reload env | `pm2 restart mission-control --update-env`, or recreate the container |
