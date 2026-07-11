# Command Center Demo Pack

A repeatable, **zero-cost, zero-side-effect** demo of the AI Workforce **/interview**
onboarding surface and the **Command Center dashboard**, runnable over and over for
prospects without touching the real account, real client data, or real agents.

It is **purely additive** — everything lives under `scripts/demo/` and the demo runs
from its **own repo copy, own SQLite DB, own workspace, own port, and an env with no
provider keys and a dead gateway**. Nothing here changes application source. The demo
company is entirely fictional: **"Harbor & Oak Candle Co."**

See `projects/Command-Center-Demo/DEMO-STRATEGY.md` for the full design rationale.

---

## What you get

| Profile | Instance | Port | What it shows |
|---|---|---|---|
| `interview` | `blackceo-cc-demo-interview` | 4600 | The journey: WelcomeBack resume → never-re-ask prefill → **live brand-color re-theme** → department board → press **Complete** → the shell-lock releases into a fully seeded Command Center. |
| `dashboard` | `blackceo-cc-demo-dashboard` | 4601 | The destination: a read-only public dashboard (repo's `DEMO_MODE=true`) — kanban, **honest health grades**, KPI trends, worst-trending diagnostics, SOP library, org chart. |

Health grades are **honest**: the seeder writes the four grading INPUTS (throughput,
QC pass-rate, SOP coverage, KPI attainment) and the real `computeCompanyHealth` engine
computes the letters. Seeded spread: **Marketing A**, six departments **B**, and
**Logistics & Fulfillment C** and *trending down* (it populates the worst-trending card).

---

## One-time setup (operator box)

```bash
# 1. Pinned-release copy of the repo (NOT the live checkout).
git clone --depth 1 https://github.com/trevorotts1/blackceo-command-center.git ~/demo/command-center-demo
cd ~/demo/command-center-demo
npm ci
npm run build

# 2. Seed + start both instances, verify pristine + healthy.
bash scripts/demo/reset-demo.sh --profile all

# 3. Prove it is safe (no keys / dead gateway / no client names / not the real CC).
bash scripts/demo/qc-demo.sh
```

`DEMO_DATA_ROOT` (default `~/.command-center-demo`) holds all demo runtime data — the
DBs, workspaces, company-roots, the isolated demo `HOME`, and the rotated cookie
secrets. Nothing demo-related is written inside the repo except `config/*.json`, which
the CC reads from its own working directory at runtime (the committed repo copy stays
template).

---

## Everyday commands

```bash
# START the demo (idempotent): seed → run → health-verify PASS/FAIL.
bash scripts/demo/reset-demo.sh                     # both profiles
bash scripts/demo/reset-demo.sh --profile interview # just the journey instance

# RESET between prospects (~15-20s): wipe → reseed → ROTATE cookie secret → restart.
bash scripts/demo/reset-demo.sh --profile all

# QC gate (run after a reset): proves the demo is key-free + isolated.
bash scripts/demo/qc-demo.sh

# Optional live motion for the dashboard act (tasks visibly move, agents change status):
pm2 start scripts/demo/demo.ecosystem.config.cjs --only blackceo-cc-demo-simulator
# ...always stopped again by the next reset.
```

Demo URLs (local): `http://127.0.0.1:4600/interview` and `http://127.0.0.1:4601/`.

---

## Run of show (operator-driven, ~10 min)

1. Open **`interview-demo.<zone>`** → shell-lock lands on `/interview`, **WelcomeBack**
   ("it remembered where the owner left off; nothing is ever asked twice").
2. Resume → the **brand-color card** (fresh). Enter `#1F6F54` (or "forest green") →
   the color is applied; the seeded Command Center reveals in that color at closeout.
3. The **operations card** (home-base name) is pre-filled from known context —
   confirm-or-correct.
4. Conversational step degrades gracefully (dead gateway) → **Continue to your
   departments**.
5. **Department board**: 26 of 28 departments already decided with provenance; decide
   the last 2 (App Development, Podcast) live — yes / no / later.
6. Press **Complete** → QC passes, the shell-lock releases, the building screen shows
   "ready" → **Open Command Center**: kanban, per-department grades, KPI trends,
   worst-trending diagnostics, live feed.
7. (Optional) start the simulator so the board visibly moves.
8. `bash scripts/demo/reset-demo.sh` off-screen after the call.

The seed leaves EXACTLY those cards/decisions unanswered, so the story is scripted by
the data — the operator types only a color and a couple of clicks.

---

## Why it is safe (by construction)

- **Own DB** (`DATABASE_PATH`), **own workspace** (`OPENCLAW_WORKSPACE_ROOT`), **own
  company root** (`OPENCLAW_COMPANY_ROOT`) — different absolute paths from production.
- **Stubbed Skill-23 scripts** (`OPENCLAW_SKILL23_SCRIPTS` → `scripts/demo/skill23-stubs`).
  This closes the confirmed hazard: the real `update-interview-state.sh` ignores
  `OPENCLAW_WORKSPACE_ROOT` and would write into the LIVE workspace. The stubs honor
  the demo workspace, refuse to run against anything without a `.demo-workspace`
  marker, and contain **no build-kick** — the `[WORKFORCE-RESUME]` multi-agent build
  is structurally impossible to fire.
- **Isolated `HOME`** → `getDb()`'s first-boot auto-seed can never reach the operator's
  real ZHC build; the demo DB holds only fictional Harbor & Oak content.
- **Dead gateway** (`ws://127.0.0.1:1`, never the real `:18789`) → no LLM, no tokens,
  no real agent, no outbound messages.
- **No provider keys** — the env files are authored from scratch; `qc-demo.sh` fails
  the pack if any key name is set (in files OR the live pm2 env).
- **External + costly + irreversible calls are sandboxed**: GHL writes, Fish Audio,
  Podbean, outbound webhooks, and email/SMS all require keys/gateway that do not exist
  here. The dashboard instance additionally runs `DEMO_MODE=true` (read-only; every
  non-GET API returns 403).
- **Name-allowlisted control**: `reset-demo.sh` only ever stops/starts the three
  `blackceo-cc-demo-*` app names. The real Command Center (a different pm2 app on its
  own port) is never touched.
- **Reset rotates `MC_INTERVIEW_COOKIE_SECRET`**, so any prospect browser holding a
  completed-interview cookie fails **closed** to a pristine `/interview`.

---

## Cloudflare Tunnel (Cloudflare Tunnel ONLY — per doctrine)

Publish through the **existing** BlackCEO tunnel by adding two ingress hostnames.
Edit the tunnel's `config.yml` (typically `~/.cloudflared/config.yml`) and add, ABOVE
the catch-all `- service: http_status:404` rule:

```yaml
ingress:
  # … existing rules …
  - hostname: demo.zerohumanworkforce.com            # read-only dashboard (Profile 2)
    service: http://127.0.0.1:4601
  - hostname: interview-demo.zerohumanworkforce.com  # journey demo (Profile 1)
    service: http://127.0.0.1:4600
  - service: http_status:404                          # keep this LAST
```

Then add the two DNS routes and reload the tunnel:

```bash
cloudflared tunnel route dns <TUNNEL_NAME> demo.zerohumanworkforce.com
cloudflared tunnel route dns <TUNNEL_NAME> interview-demo.zerohumanworkforce.com
# reload however this box runs cloudflared (e.g. restart the launchd/service unit).
```

Access policy (operator's call):
- **`demo.`** (read-only): public, or behind Cloudflare Access — safe either way.
- **`interview-demo.`** (accepts writes into the sandbox): put it **behind Cloudflare
  Access**. Operator email always allowed; add a prospect's email with an expiring
  rule for the session, remove it after. Reset after each prospect.

No secrets, tokens, or client identifiers ever live in the demo directory or in this
doc. Separate hostnames also keep the two instances' cookies from colliding.

---

## Teardown

```bash
pm2 delete blackceo-cc-demo-interview blackceo-cc-demo-dashboard blackceo-cc-demo-simulator
rm -rf ~/.command-center-demo ~/demo/command-center-demo
# remove the two Cloudflare ingress entries + DNS routes.
```

Nothing else in the fleet references the demo.
