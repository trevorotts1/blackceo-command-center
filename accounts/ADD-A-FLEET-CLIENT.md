# ADD A FLEET CLIENT — the one canonical process

**This is the single source of truth for adding a client. It lives next to the roster
(`~/clawd/accounts/accounts.md`), NOT in the heartbeat folder.** The heartbeat only *reads* the roster.
Every file below already exists and is cross-pointed — this doc just puts the steps in one place so a
new client is added the SAME way every time and never half-added again.

---

## The map (where everything lives — verified)

| Thing | Exact location | Holds |
|---|---|---|
| **Roster (source of truth)** | `~/clawd/accounts/accounts.md` | one numbered section + table row per client: machine, owner, access method, tunnel/CF-app ids, **env-var NAMES** for tokens/passwords, SSH alias/key/known_hosts |
| **Heartbeat copy (drives monitoring)** | `~/clawd/fleet-heartbeat/scripts/probe-fleet.sh` → `ROSTER=()` | machine-readable copy of the roster the ONE heartbeat loops over |
| **Canonical machine roster (drives the gate)** | `~/clawd/accounts/fleet-roster.json` | JSON copy of `accounts.md` keyed by box-id (provider/account/kind/registry_id/probe_match). The coverage gate's authority. |
| **CF Access token map (Mac-tunnel only, drives the gate)** | `~/clawd/accounts/cf-token-map.json` | single-source map of tunnel hostname (`probe_match`) → CF Access token NAME suffix (e.g. `EDDIE_OTTS`). `probe-fleet.sh` reads ONLY this file for both the probe and the auto-update step — no more duplicated `case` switch. The gate FAILS (`MISSING_CF_TOKEN_MAPPING`) if a mac-kind roster box has no entry. |
| **Prover/rolls copy** | `~/clawd/fleet-prover/box-registry.json` | box connection registry `prove-floor.py`/`prove-fleet.sh` iterate |
| **🚦 Coverage gate (ENFORCES no-silent-drop)** | `~/clawd/accounts/fleet-coverage-gate.py` | `--reconcile --check-contabo` proves all copies agree; `--touched -` proves an op covered everyone. Exit 1 = STOP. |
| **Access RULES (patterns only)** | `~/clawd/AGENTS.md` | VPS pattern (`ssh root@IP` → `docker exec`; §"Contabo VPS" + §"Other clients, hosts & gotchas"); Mac-tunnel ssh-config pattern + service-token gotchas (§"Rescue Rangers — client onboarding for remote SSH"). **RULES/patterns only — per-client blocks are NOT here anymore (retired).** |
| **Per-client access blocks** | `~/clawd/accounts/accounts.md` | each client's detail section (field table: access method + `zsh -lc` rule, tunnel/CF-app ids, service-token env-var NAMES, SSH user/alias) — this is where per-client access details actually live. |
| **Reference (conventions + creds policy)** | `~/clawd/TOOLS.md` | "creds by env-var name only", roster pointer, per-client access reference sections |
| **Per-client memory + index** | `~/clawd/MEMORY.md` + `.claude/.../memory/<client>.md` | short per-client block + pointers back to accounts.md |
| **SECRETS (the only place values live)** | `~/.openclaw/secrets/.env` (canonical; `~/.openclaw/.env` & `~/clawd/secrets/.env` are symlinks to it) | CF tokens, connector tokens, root passwords — **values**, referenced everywhere else by NAME only |
| **SSH key** | `~/.ssh/id_ed25519` (+ `.pub`) | the credential for ALL boxes; per-client `~/.ssh/known_hosts_<client>` |

**Iron rule (already enforced — keep it):** a secret VALUE never appears in any `.md`. The `.md` files name
the env var (e.g. `CF_ACCESS_KAREN_SVC_CLIENT_SECRET`); the value lives only in `~/.openclaw/secrets/.env`.
`~/clawd/` is git-tracked, so a pasted value = a leak.

---

## Two client types
- **VPS (Hostinger Docker):** `ssh root@<IP>` then `docker exec <container> openclaw …`. Key auth (no password
  for normal ops; root password is emergency-only, stored as `VPS_<CLIENT>_ROOT_PASSWORD`).
- **Mac-tunnel:** `ssh <user>@<tunnelhost>` over a Cloudflare tunnel + CF Access service token (no `root@IP`;
  Mac is behind NAT). Remote commands MUST be wrapped in `zsh -lc "…"` (else node/openclaw aren't on PATH).

---

## THE STEPS (run A→F, in order)

### A. (Mac-tunnel only) Stand up the tunnel on Cloudflare
- A1. Create tunnel `rescue-<client>`; `GET …/cfd_tunnel/{id}/token` for the connector token.
- A2. DNS CNAME `rescue-<client>.<zone>` → `<tunnel-id>.cfargotunnel.com` (proxied).
- A3. CF Access **self_hosted** app on that hostname (Google SSO + allowed emails) **+ service token** (non-identity policy).

### B. (Mac-tunnel only) Make the connector PERMANENT — ON THE CLIENT'S MAC (can't be done remotely)
The tunnel survives **reboot + crash + idle** only if you do BOTH B1 and B2. This is the exact setup proven on Cassandra's box (up for days). Copy it.

**B1 — connector as a permanent launchd LaunchDaemon.**
- *Simple (no other cloudflared on the box):* `sudo cloudflared service install <CONNECTOR-TOKEN>` → creates `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` with `RunAtLoad`. Then verify `KeepAlive` is set (B1b).
- *Bulletproof (client ALREADY runs cloudflared for their own OpenClaw — do NOT reuse `com.cloudflare.cloudflared`):* create a separate `/Library/LaunchDaemons/com.blackceo.rescue-<client>.plist` (Intel → `/usr/local/bin/cloudflared`; Apple Silicon → `/opt/homebrew/bin/cloudflared`):
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
    <key>Label</key><string>com.blackceo.rescue-<client></string>
    <key>ProgramArguments</key><array>
      <string>/opt/homebrew/bin/cloudflared</string>
      <string>tunnel</string><string>--no-autoupdate</string><string>run</string>
      <string>--token</string><string><CONNECTOR-TOKEN></string>
    </array>
    <key>RunAtLoad</key><true/>   <!-- comes back after REBOOT -->
    <key>KeepAlive</key><true/>   <!-- comes back after CRASH/disconnect -->
    <key>StandardOutPath</key><string>/Library/Logs/com.blackceo.rescue-<client>.out.log</string>
    <key>StandardErrorPath</key><string>/Library/Logs/com.blackceo.rescue-<client>.err.log</string>
  </dict></plist>
  ```
  ```bash
  sudo chown root:wheel /Library/LaunchDaemons/com.blackceo.rescue-<client>.plist
  sudo chmod 644        /Library/LaunchDaemons/com.blackceo.rescue-<client>.plist
  sudo launchctl bootout  system /Library/LaunchDaemons/com.blackceo.rescue-<client>.plist 2>/dev/null
  sudo launchctl bootstrap system /Library/LaunchDaemons/com.blackceo.rescue-<client>.plist
  ```
- **B1b — both `RunAtLoad=true` AND `KeepAlive=true` must be set** in whichever plist you used. Missing either = the connector dies and never returns (this is what dropped Kofi/Karen). Use `--no-autoupdate`.

**B2 — never sleep:** `sudo pmset -a sleep 0 displaysleep 0` → confirm `pmset -g | grep ' sleep'` shows `0 (sleep prevented by powerd)`.

**B3 — Remote Login ON** (System Settings → General → Sharing) + `id_ed25519.pub` in the client user's `authorized_keys`.

**B4 — PROVE permanence (RATIFIED kickstart standard — NEVER `sudo reboot` a client's Mac).** All three are REQUIRED:
- **plist audit:** both `RunAtLoad=true` AND `KeepAlive=true` set in the connector plist (B1b) **and** `pmset -g | grep ' sleep'` shows `sleep 0` (B2).
- **kickstart test:** `sudo launchctl kickstart -k system/<label>` then from the master `cloudflared tunnel info <id>` (query by UUID, never by name) shows active connectors — with nobody touching the Mac. This is the permanence TEST, not the edit-apply mechanism (plist edits apply only via bootout→bootstrap).
- If any of these fails, fix RunAtLoad/KeepAlive/pmset and re-test before declaring the client added.

A **client-attended reboot is the OPTIONAL gold test only** — run it solely when the client is on the call and FileVault status is known (FileVault ON halts at pre-boot with nothing running until physically unlocked). Full procedure: the Rescue Rangers Field Install Guide (permanence / F-section) in the `trevorotts1/rescue-rangers` repo.

(Hostinger VPS: run the connector under PM2 + `pm2 save` + `pm2 startup`; no sleep concern.)

### C. Store credentials — ONLY in `~/.openclaw/secrets/.env`
- Mac-tunnel: `CF_ACCESS_<NAME>_SVC_CLIENT_ID`, `_CLIENT_SECRET`, `_TOKEN_ID`, `<NAME>_TUNNEL_CONNECTOR_TOKEN` (+id/name/zone/hostname).
- VPS: the IP, and `VPS_<CLIENT>_ROOT_PASSWORD` (emergency only). Mirror into `openclaw.json` → `env.vars` if the runtime needs it.
- Then `~/.ssh/config`: `Host rescue-<client>` — use the EXACT working pattern below. The ProxyCommand MUST carry the **TWO SEPARATE** `--service-token-id` / `--service-token-secret` flags (the combined `--service-token id:secret` flag does NOT exist; omitting them makes the connection time out). This is the canonical pattern maintained in `~/clawd/AGENTS.md` → §"Rescue Rangers — client onboarding for remote SSH" — keep the two in sync:
  ```
  Host rescue-<slug>
      HostName rescue-<slug>.zerohumanworkforce.com
      User <ssh-username>
      ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h --service-token-id ${CF_ACCESS_<CLIENT>_SVC_CLIENT_ID} --service-token-secret ${CF_ACCESS_<CLIENT>_SVC_CLIENT_SECRET}
      IdentityFile ~/.ssh/id_ed25519
      UserKnownHostsFile ~/.ssh/known_hosts_<slug>
  ```
  Env vars must match the `CF_ACCESS_<CLIENT>_SVC_*` NAMES in `~/.openclaw/secrets/.env`. VPS needs no alias (root@IP).

### D. Register in the ROSTER (this is what makes OpenClaw SEE + MONITOR the client)
- D1. `~/clawd/accounts/accounts.md` — add a numbered detail section + a row in the roster table + the quick-ref table, with the brand-vs-rescue designation. **Only env-var NAMES, never values.**
- D2. `~/clawd/fleet-heartbeat/scripts/probe-fleet.sh` `ROSTER=()`:
  - VPS: `"Client|Persona|IP|container"`
  - Contabo: `"Client|Persona|oc-<slug>|oc-<slug>|contabo"` (probed via `ssh contabo-host` + `docker exec -u node`; auto-update is skipped for pinned-image, client-funded boxes)
  - Mac-tunnel: `"Client|Persona|<ssh-user>|<tunnelhost>|mac-tunnel"` (or `mac-tunnel-rescue`) — **quote any pattern containing a space or `(`** (an unquoted space/paren is a `bash` parse error that makes the WHOLE script emit nothing → the heartbeat silently covers NOBODY; this happened Jun 18–29).
- D2b. `~/clawd/accounts/fleet-roster.json` — add the box under `boxes` with `client/provider/account/kind/registry_id/probe_match` (env-var NAMES only). This is the gate's authority.
- D2c. `~/clawd/fleet-prover/box-registry.json` — add the box so `prove-floor`/rolls reach it.
- D2d. **(Mac-tunnel ONLY)** `~/clawd/accounts/cf-token-map.json` — add one entry under `"tokens"`: `"<tunnelhost>": "<NAME>"`, keyed by the EXACT `probe_match` value you just used in D2b (not the client's display name — those two are allowed to differ, e.g. Aurelia's mac-mini box). This is the SINGLE source `probe-fleet.sh` reads for CF Access token names — it replaced a hand-maintained `case` statement that was duplicated in two places in that file and let a client (Eddie Otts, missing from both; E.R. Spaulding, missing from one) silently inherit a DIFFERENT client's Cloudflare credential and get reported DOWN while healthy. **You cannot forget this step and ship anyway: `fleet-coverage-gate.py --reconcile` (step below) FAILS with `MISSING_CF_TOKEN_MAPPING` if a mac-kind roster box has no entry here — the gate is the enforcement, this bullet is just the how-to.**
- D3. **Active rollout/wave roster (if one exists):** `~/clawd/accounts/accounts.md` is the SINGLE SOURCE OF TRUTH for the fleet. Any wave/execution roster (e.g. `~/clawd/WAVE5-ROSTER.md`) is a DERIVED view — if such a file currently exists, add the new client's row there too (same columns: #, Client, Agent, Box Type, Tunnel/Host + tunnel id, SSH User, CF token env-var NAMES, SSH command pattern, Special Cases) and bump its box count, OR regenerate it from accounts.md. Don't let it drift from accounts.md. (A new fleet member was missed here once because they were added to accounts.md but not the active wave roster.)
- ✅ After D, the ONE `fleet-heartbeat` cron checks this client every hour. No per-client heartbeat ever.

### E. Teach the agents how to GET IN and MAKE CHANGES
- E1. `~/clawd/AGENTS.md` — **generic access RULES only.** The per-client-block-in-AGENTS.md practice is **RETIRED**: per-client host/user/token-var/tunnel-id now live in the accounts.md detail section (step D1), and the `zsh -lc "…"` rule is already a standing RULE in AGENTS.md. So NO per-client edit is needed here unless the client introduces a genuinely NEW access *pattern*. Just confirm the client fits an existing rule — the Mac-tunnel ssh-config pattern + `zsh -lc "…"` rule (§"Rescue Rangers — client onboarding for remote SSH") or the VPS pattern (§"Contabo VPS" / §"Other clients, hosts & gotchas"). Only if a new pattern is required, add the RULE (not a per-client block) there.
- E2. `~/clawd/TOOLS.md` — add the per-client reference section (alias, tunnel id, user, token-var NAMES) that points back to accounts.md + AGENTS.md.
- E3. `~/clawd/MEMORY.md` — short per-client block pointing to accounts.md.

### F. Reference memory (so cross-references resolve)
- F1. `.claude/.../memory/<client>.md` — per-client memory file.
- F2. Add to `fleet-client-chat-ids.md` + `openclaw-fleet-agent-roster.md`. `client-command-center-links.md` ONLY if brand-managed.

### G. (Command-Center / brand-managed clients) Command Center WEB-login access — add the CLIENT'S OWN email
The client opens their dashboard at `<client>.zerohumanworkforce.com`, gated by its OWN Cloudflare Access app
`<client>-command-center` (a SEPARATE app from the A3 SSH app). Its `allow` policy MUST include the **client's
own Google login email**, not just the operator emails — otherwise the client hits **"That account does not have
access"** the first time they log in, even though the dashboard is healthy locally. (Real incident: Monique
Tucker lockout 2026-06-21; an audit then found 4 more clients — Corey, Sonatta, Aurelia, Karen — with the
identical gap. See changelog 2026-06-21.)
- G1. Find the app + its allow policy (token `CLOUDFLARE_ZHW_APPS_API_TOKEN`; account = ZHC `$CLOUDFLARE_ACCOUNT_ID` = `13f808b7…`; Access login domain `sweet-wave-ca28.cloudflareaccess.com`):
  `GET /accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps` → find `<client>-command-center` → `GET …/access/apps/{app}/policies` → the `decision:allow` ("Operator access") policy.
- G2. ADD the client's login email to that policy's `include` (PRESERVE every operator email already there; only ADD): `GET …/policies/{id}` → append `{ "email": { "email": "<client-login-email>" } }` to `include` → `PUT …/policies/{id}` with the full body (strip read-only `id`/`created_at`/`updated_at`/`uid`). Re-GET to confirm the email is now in `include`.
- G3. If the client signs in with a DIFFERENT Google account than their canonical email, add THAT exact address (ASK the client; never guess). They must sign in with an email that is on the list.

---

## The ONE heartbeat (no per-client heartbeats)
- One cron: `fleet-heartbeat` (id `3f0f33c9-41d9-4244-a02f-3a94819eaa8e`), `0 6-21 * * *` ET, on the master.
- It runs `probe-fleet.sh`, loops the WHOLE `ROSTER=()` in parallel, sends ONE Telegram status to `5252140759`.
- Add a client to the ROSTER (step D) → it's in the one heartbeat. Never create a second heartbeat.

## VERIFY before calling it done (don't trust the add — prove it)
- **🚦 RUN THE GATE — this is the binding check:** `python3 ~/clawd/accounts/fleet-coverage-gate.py --reconcile --check-contabo` MUST exit 0 (proves `fleet-roster.json` ⇄ `probe-fleet.sh` ROSTER ⇄ `box-registry.json` ⇄ live Contabo ⇄ `cf-token-map.json` all agree, and `probe-fleet.sh` still parses). A non-zero exit names exactly what's missing — fix it, don't ship. **`MISSING_CF_TOKEN_MAPPING` means you skipped D2d** — the client will probe as DOWN with `cf_token_unmapped` instead of connecting, never a false PASS.
- `accounts.md` client count == `probe-fleet.sh` `ROSTER=()` row count.
- Run `probe-fleet.sh` → new client shows `ssh=OK gw=OK`.
- `grep -L '<client>'` across accounts.md, AGENTS.md, TOOLS.md, MEMORY.md, probe-fleet.sh → must be present in ALL.
- (Mac-tunnel) `cloudflared tunnel info <id>` shows active connectors (proves B took).
- (Command-Center clients) The client's OWN login email is on their `<client>-command-center` Access **allow** policy (step G), not just operator emails: `GET …/access/apps/{app}/policies` and confirm the client email is in `include`. Skipping this = guaranteed "That account does not have access" on the client's first login.
- Confirm NO secret value landed in any `.md`: `grep -niE 'secret|password' *.md` shows only env-var NAMES.

## Cross-pointers that make this discoverable (so nobody depends on memory)
- `accounts.md`, `AGENTS.md`, `TOOLS.md`, `MEMORY.md` each link to THIS doc at the top of their fleet section.
