# Command Center

> **v4.63.0 (2026-07-06)** is a full dashboard UX/design + functionality pass. **Kanban**: drag/move errors now surface in a toast and revert instead of silently snapping back; the **Blocked** column is finally reachable (a modal collects the required reason/audience/ask and persists them); a touch-friendly "Move task" menu makes the board usable on phones/tablets; real-time deletes, per-column create, a board search, empty-column hints, and a 60s stale-board refetch land too. The task **DELETE 500** (blocked by `persona_selection_log`/`persona_performance` FKs) is fixed, and UI-created tasks keep their department. **Settings** stop lying: Intelligence overrides can be cleared ("Reset to inherited"), lock (423) holders are named, provider badges read "Key present" (not "Configured"), the settings hub drops dead localStorage-only fields, and Company Settings reads brand state back + warns visibly when live branding isn't applied. **Models engine**: the Ollama-Cloud cascade actually selects (`tierOf` now recognizes `ollama-cloud/`), operator role/department model overrides now win over the auto-selector, and a hardcoded Anthropic id was removed from the Header (models load dynamically). **Health-rating**: no more fabricated `72`s or hardcoded `B` grades — the pulse strip, `resolve-department`, and CEO dashboard all use the real `grading.ts` engine and show "Insufficient data" honestly. **Responsive**: a real mobile bottom-nav, an app-wide Cmd+K navigate group, a responsive CEO-board header (with the Agents-tab 404 fixed), an AA-compliant muted-text token, and verified no-horizontal-overflow at mobile/tablet/desktop. A fresh-DB seed crash (`SQLITE_CONSTRAINT_FOREIGNKEY`) and an invalid-priority demo seed are also fixed. No new dependencies; no Anthropic ids in client-facing paths. See `CHANGELOG.md` for the full v4.63.0 entry.
>
> **v4.61.0 (2026-07-05)** delivers the matched persona to the doer at dispatch (Persona-Matching-Overhaul foundation, FDN-3/F4.1). Both dispatch paths — the fast-loop auto-dispatch (`src/lib/task-dispatcher.ts`) and the operator-click route (`src/app/api/tasks/[id]/dispatch/route.ts`) — now render a shared `buildPersonaBlock` (`src/lib/persona-dispatch.ts`) that reads `task.persona_id` and emits the resolved persona's Section-4 (A–D) + §7B load contract, instead of telling the doer to "AUTO-SELECT / run the 5-Layer Protocol." `agent_settings.persona` is now an operator lock only; every branch is fail-closed (never naked, never `'auto'`). See `CHANGELOG.md` for the full v4.61.0 entry.
>
> **v4.56.0 (2026-06-29)** adds ingest schema-error self-heal + clear 503 + owner escalation (`notifyOwnerSchemaError`), and a presentations done-gate requiring `process_certificate_sha` (no-skip proof) before any presentations task can be marked done at the board. See `CHANGELOG.md` for the full v4.56.0 entry.
>
> **v4.14.0 (2026-06-09)** closes the two-step routing gap: specialist tasks now **auto-invoke OpenClaw** after routing without any manual "Send to Agent" click. `src/lib/task-dispatcher.ts` (`autoDispatchTask`) is called fire-and-forget from `createTaskCore`, `auto-route`, and `ceo-delegation-sweep`. Guards: master/CEO agents skipped, terminal statuses skipped, QC loop cap respected. See `CHANGELOG.md` for the full v4.14.0 entry.
>
> **v4.13.0 (2026-06-09)** extends Company Settings with a **brand secondary color** field (color picker + hex/name input), **auto-derived Product Name** from the Company Name (`"<Name> Command Center"`), and full CSS-variable theming: primary + secondary colors cascade app-wide via `--brand-secondary-*` CSS variables and `BrandTheme` Tailwind utility overrides. Migration 062 adds `clients.brand_secondary_color`. See `CHANGELOG.md` for the full v4.13.0 entry.
>
> **v4.12.0 (2026-06-09)** closes the QC re-dispatch loop: fixes the "fetch failed" bug (wrong port 3000 → port 4000 via `getMissionControlUrl()`), ensures QC-fail backlog tasks are re-dispatched to the correct department specialist (`in_progress`), and adds an infinite-loop guard (`qc_reroute_attempts` counter, cap via `QC_MAX_REROUTES` env, default 3 — exceeded tasks go `blocked` with a CEO-addressed event). See `CHANGELOG.md` for the full v4.12.0 entry.
>
> **v4.11.0 (2026-06-09)** wires the QC scorer to every path that transitions a task into `review`: agent-completion webhook, execution-watcher reconcile, and a new `qc-review-sweep` cron (every 2 min) that catches tasks already stuck in Review/QC. FAIL branch now moves tasks to **backlog** (not in_progress) and writes a CEO reroute event so the master-orchestrator can re-dispatch. `qc_review` events surface in the Live Feed rail with a purple dot. See `CHANGELOG.md` for the full v4.11.0 entry.
>
> **v4.10.0 (2026-06-09)** fixes the department sidebar: each department's subtitle now shows the **name of the department's head agent** instead of repeating the department name. Resolved from `workspaces.head_agent_id` → `agents.name` (migration 028 JOIN); departments without a head agent show "—". See `CHANGELOG.md` for the full v4.10.0 entry.
>
> **v4.9.0 (2026-06-09)** hardens the Intelligence key-save path: HTTP 507 on disk-full (ENOSPC), atomic write (temp + rename), Ollama Cloud slug alias (maps `ollama` → both OLLAMA_API_KEY + OLLAMA_CLOUD_API_KEY), smoke-test on save (verifyKey), UI freshness re-fetch, and ws:// scheme bug fix in the task webhook. See `CHANGELOG.md` for the full entry.
>
> **v4.8.0 (2026-06-09)** adds an always-visible, draggable horizontal scrollbar and left/right scroll affordances (fade gradients + chevron buttons) to the Kanban Task Board so users immediately see that Review/QC, Blocked, and Done columns exist off-screen to the right. See `CHANGELOG.md` for the full entry.
>
> **v4.7.0 (2026-06-09)** wires per-department QC Specialist agents: migration 060 adds `agents.role_type`, seeds one QC Specialist per workspace, and the QC scorer + review→done gate now resolve the task's own dept QC agent instead of any global master. See `CHANGELOG.md` for the full entry.
>
> **v4.6.0 (2026-06-09)** fixes a fleet-wide board ordering bug: the canonical CEO dept slug `master-orchestrator` now correctly pins to the top of every board, and General Tasks pins to the bottom. See `CHANGELOG.md` for the full entry.
>
> **v4.1.7 (2026-05-30)** adds two universal Operator Console UX features. **(1) An onboarding walkthrough** — a first-run, re-openable overlay that explains each sub-module (Console, Bridge, Workspace, Studio, Notebook, Goals, Journal, Memory, Research, Call Mode, Web Agent) in plain English. It auto-opens once (persists `bcc-operator-onboarding-seen`), re-opens from a sidebar/home "Show walkthrough" control and a per-page "What is this?" button, and the **Memory card explains the vault**: everything you write flows to the vault and is searchable in Memory — on a **Mac Mini** you can also browse it in Obsidian, on a **VPS** there is no Obsidian so the Memory page IS your window into the brain. Fully accessible (focus trap, Esc, arrow-key nav, aria, ≥44px targets, ≥16px text, icon+label). **(2) Per-module vault-write health dots** — a small status dot per persisting module (Goals/Journal/Notebook/Studio/Research): green = last write reached the vault, amber = saved-but-vault-unconfirmed, red = error, grey = unknown (never fabricated green). Backed by a read-only `GET /api/operator/health` that reuses `vaultRoot()` and never throws. See `CHANGELOG.md` for the full v4.1.7 entry.
>
> **v4.1.6 (2026-05-30)** adds a boot-time Studio provider registry seed (`instrumentation.ts`) so the Image/Video/Audio providers populate on first deploy instead of staying empty until the first manual generation. See `CHANGELOG.md` for the full v4.1.6 entry.
>
> **v4.1.5 (2026-05-30)** makes the Operator Console **Research** sub-module provider-agnostic (the mirror of the v4.1.4 Studio fix). Research was hard-wired to xAI Grok via `X_AI_API_KEY` — dead on any box without that key. It now **auto-discovers** the search provider from the environment + OpenClaw secret files and selects one in the order **Perplexity > OpenAI > Ollama (cloud) > xAI**. If a key exists the module is **live** (the `Soon` badge is dropped, a "Live via `<Provider>`" pill shows); if no key exists it shows an **honest empty-state** ("Add a Perplexity/OpenAI/Ollama/xAI key to enable Research") instead of a dead box or a 502. Shallow/Deep preserved. See `## Operator Research — provider auto-discovery (v4.1.5)` below and `CHANGELOG.md`.
>
> **v4.1.3 (2026-05-30)** fixes the Operator Console → Bridge → OpenClaw connect failure on VPS deploys. The Bridge device identity now persists on the `/data` volume (VPS) / `~/.mission-control` (Mac) and is **never silently regenerated**, so it survives `docker compose up -d --force-recreate` and the gateway approval is a one-time step. A boot-time pairing bootstrap registers the device as a pending request on the gateway right after deploy; `GET /api/openclaw/status` reports `connected` / `device_id` / `pairing_pending` plus the exact `openclaw devices approve <requestId>` remediation. The Bridge pill strip is now **platform-aware**: a VPS install shows only the OpenClaw pill (the six Mac-desktop CLIs are hidden), Mac installs are unchanged. See `docs/OPENCLAW_BRIDGE_PAIRING.md` for the per-box deploy + pairing runbook, and `CHANGELOG.md` for the full v4.1.3 entry.
>
> **v4.1.2 (2026-05-30)** is the single-department Focus View fix: `/tasks/all` rail clicks + the `/tasks/by-department` picker now deterministically open `/workspace/[slug]`, which filters by the workspace's `workspace_id` (the enforced FK) so a department always shows exactly its own tasks. See `CHANGELOG.md` for the full v4.1.2 entry.
>
> **v4.0.2 (2026-05-25)** is the v4.0.1 fix pass: 8 bug fixes closing latent issues surfaced during the v4.0.1 fleet rollout. Migration runner now supports per-migration `useOuterTransaction: false` so migration 034 applies cleanly on fresh installs. All runtime-state API routes declare `export const dynamic = 'force-dynamic'` so `/api/health` and similar return fresh timestamps (no more build-time prerender cache). Header.tsx mount-gates the live clock to eliminate React hydration warnings. New `/settings/company` page wraps CompanySettingsForm. ecosystem.config.cjs template hardcodes port to prevent Hostinger PORT env leak. Empty-state copy clarified for Studio, Journal, Memory. `persona_selection_log` refuses sentinel inserts; new migration 045 cleans up existing orphans. See `CHANGELOG.md` for the full v4.0.2 entry. **v4.0.3** ships `config/departments.json` empty + adds `scripts/sync-departments-from-build-state.py` so the dashboard always reflects the client's real build-state instead of a stale 17-row template.
>
> **v4.0.1 (2026-05-25)** is the v4.0 fix pass: Operator Console added to the home screen as the 5th of 6 cards, global Header link, global Cmd+K, real Fish Audio + xAI Grok TTS providers, weekly model-refresh cron (node-cron), 🤖 model pill on task cards, three new provider connectors (ollama-local, xiaomi, fish-audio), Cloudflare Access one-shot setup script, five new docs files, three new system-status probes (CLI / CF Tunnel / CF Access), and a streaming `/api/system/bootstrap` re-run endpoint. xAI label now reads "xAI (Grok)". See `CHANGELOG.md` for the full v4.0.1 entry.
>
> **v4.0.0 (2026-05-25)** shipped the Operator Console (10 sub-modules), a fully dynamic 13-provider model registry, the System Status Panel, Cloudflare Access + `MC_API_TOKEN` middleware, and a Cmd+K palette. Old routes `/kanban` and `/workspace` 308-redirect to `/tasks/all` and `/tasks/by-department`.

<!-- BEGIN v2.1 SECTION -->
## v2.1 — Zero-Human Company Spec (PRD v2.1)

> **What this version delivers:** A solo founder can complete the AI Workforce setup in under 45 minutes and end up with the operational machinery of a Fortune 500 company. 16 mandatory departments. 130-200 specialized AI roles. Persona-governed execution.

### The 16 Mandatory Departments
Auto-built for every zero-human company:

1. **Marketing** — Demand generation, brand positioning
2. **Sales** — Outreach, conversion, deals
3. **Billing & Finance** — Invoices, cash flow, forecasting
4. **Customer Support** — Onboarding, retention, service
5. **Web Development** — Website, funnels, SEO, technical SEO
6. **App Development** — Desktop, mobile, PWA
7. **Graphics** — Visual content across all formats
8. **Video** — Production, editing, Video SEO
9. **Audio** — Podcast, AI voice (11 Labs), sound design
10. **Research** — McKinsey-style industry + competitor intel
11. **Communications** — PR, internal/external messaging
12. **CRM** — Platform admin, **Email Deliverability & Optimization (flagship)**
13. **OpenClaw Maintenance** — System health, backups, security
14. **Legal** — Contracts, compliance, IP
15. **Social Media** — Organic posting across 10 platforms (separate from Paid Ads)
16. **Paid Advertisement** — Paid media across 13 ad platforms

**Plus: Master Orchestrator (CEO agent)** above all departments. Special persona deferral clause — uses personas as input but mission and owner values override on conflict.

### Industry Vertical Packs (Auto-Added)
- **Personal/Professional Development** (~60% of clients): Presentations, Client Coaches, Course Creator, Podcast, Community Management
- **Real Estate**: Listings, MLS Ops, Lead Gen, Showings, Open House, Closing, Local Market Intelligence
- **Service Industry**: Scheduling/Dispatch, Field Operations, Reviews Management, Recurring Service

### The 30-Question Interview
6 phases, ~35 minutes total. Pre-interview asset drop pre-fills 40%+ of answers. Behavioral interview (5 scenario-based questions) replaces value-based platitudes. Department customization bundled across 13 questions (not 1-per-dept).

### The `/interview` Web Surface (v4.64)
The Command Center ships LOCKED to `/interview` until the AI Workforce interview completes (WG-9 doctrine): consent → structured cards (identity → brand → operations) → conversational depth → department decision board → review → the triple-gated "Build my company" trigger. Continuity is server-derived from the canonical Skill-23 files: a refresh, a new browser, or a hop from Telegram resumes on the EXACT next unanswered question with every prior answer intact, the conversation session survives reloads, and facts already on file are offered as confirm-or-correct (recorded with `confirmed-from-context` provenance). The client↔route request contract is pinned by `tests/unit/interview-answer-contract.test.ts` against the route's own zod schema so the two can never drift.

### Universal How-To Template
Every role's `how-to.md` follows the same 18-section structure: identity, persona governance, daily/weekly/monthly/quarterly ops, KPIs tied to revenue cascade, tools, SOPs, quality gates, handoffs, escalation paths, good/bad examples, common mistakes, research sources, edge cases, update triggers.

QC sub-agent verifies every generated document against a 9-item quality checklist. 2 revision cycles max before flagging for owner review.

### Generation Orchestration
After the interview completes, the AI spawns sub-agents:
- 1 industry research sub-agent (McKinsey + Perplexity + competitor intel)
- Up to 10 department sub-agents in parallel
- Up to 50 role sub-agents in parallel (each generating one how-to.md)
- 1 QC sub-agent

**Full build: 25-45 minutes for 130-200 role documents.**

### Platform Abstraction
`shared-utils/detect_platform.py` resolves paths automatically:
- Mac legacy: `~/clawd/`
- Mac new install: `~/.openclaw/workspace/`
- VPS (Hostinger Docker): `/data/.openclaw/workspace/`

No hardcoded paths. Same code runs on every platform.

### Persona Governance Override
Persona is the strongest control over agent behavior. Every generated SOUL.md and IDENTITY.md contains a deferral clause:

> *When a persona is assigned, that persona governs HOW you perform the work. Your beliefs, voice, decision logic come from the persona — not from this file.*

Master Orchestrator (CEO) gets the special variant: persona is INPUT, but company mission and owner values WIN on conflict.

### Documentation
See PRD v2.1 (`onboarding PRD v2.1.md` in user's local Downloads) for the complete specification. Executes in order: v1.1 (foundation) → v2.0 (intelligence) → v2.1 (zero-human-company spec).
<!-- END v2.1 SECTION -->



AI Agent Management Dashboard - A universal template for any organization.

**Current Version: v6.0.25** — 2026-07-15

## Overview

Command Center is a sophisticated web application for managing and orchestrating AI agents. It provides a visual dashboard for task management, agent coordination, and real-time monitoring of agent activities.

## Tech Stack

- **Frontend:** Next.js 15, React 19, TypeScript
- **Styling:** Tailwind CSS with custom design system
- **Database:** SQLite (better-sqlite3)
- **Real-time:** Server-Sent Events (SSE)
- **State:** Zustand

## Features

- **Agent Management:** Multi-agent coordination across departments
- **Task Board:** Kanban-style task management with drag-and-drop
- **Live Feed:** Real-time activity monitoring
- **Planning Phase:** Collaborative task specification with AI agents
- **Workspace Support:** Multi-workspace organization by department
- **Multi-Company:** Support for multiple companies/organizations
- **Intelligence Settings:** Per-department model and persona configuration with quick-access header panel
- **Dynamic Departments:** Departments loaded from database workspaces, not hardcoded lists
- **Brand Palette:** Automatic complementary color generation from company primary/secondary colors
- **CEO Performance Board:** Company health grading, department analytics, recommendations, benchmarks
- **Department Browser (`DepartmentBrowser.tsx`):** Visual Kanban browser for all departments
- **All Tasks (`/tasks/all`):** Cross-department Kanban with the departments rail on the left; clicking a department opens its Focus View.
- **Department Picker (`/tasks/by-department`):** Grid of department cards; "Open Department" opens that department's Focus View.
- **Focus View (`/workspace/[slug]`):** Single-department Kanban scoped to that department's tasks. Both the All-Tasks rail and the picker land here, and the board filters by the workspace's `workspace_id` (the enforced FK), so a department always shows exactly its own tasks. The left rail collapses to a minimal focused context with a "Back to All Departments" link.
- **Grade Calculator:** 40/30/15/15 formula (Revenue/Mission/Efficiency/Team)
- **company-config.json Runtime Loader:** Dynamic persona and config loading
- **Three-Lens Performance Board:** Revenue, Mission, and Operational Excellence views
- **Breadcrumb Navigation:** Consistent breadcrumbs on all pages

## Setup

```bash
# Set your company name
export COMPANY_NAME="Your Company Name"

# Install dependencies
npm install

# Build and start
npm run build
pm2 start ecosystem.config.cjs
```

## Configuration

- **Company name:** Set via `COMPANY_NAME` env var or populated from database
- **Departments:** Loaded dynamically from database workspaces. `config/departments.json` ships EMPTY ([]) on purpose; the dashboard is populated from the client's real Zero Human Company build via `scripts/sync-departments-from-build-state.py` (run by Skill 32 PHASE 6c). Never ships a hardcoded department template.
- **Port:** `${PORT:-4000}` (env var, defaults to 4000)
- **Logo:** Place at `public/logo.png` or set `NEXT_PUBLIC_LOGO_URL`
- **Brand colors:** Set primary/secondary hex colors on the company record; palette auto-generates
- **Intelligence:** Settings > Intelligence for per-department AI model and persona assignment

See deployment documentation for full setup instructions.

## Operator Studio — provider auto-discovery (v4.1.2)

The Operator Console **Studio** (`/operator/studio`) generates Image, Video, and Audio. The provider set is **not hardcoded** — it is discovered at runtime from your environment and the OpenClaw secret files, so a box "just works" the moment a media key exists.

### How a provider appears in Studio

1. **Env discovery.** On boot (`instrumentation.register()`) and lazily on first Studio read (`availableModels()`), the app scans for known media-provider API keys. `process.env` is authoritative and is never overwritten; on a VPS this already contains the keys loaded from the host `/docker/<proj>/.env`. For any key **absent** from `process.env`, it additionally probes — first hit wins — these OpenClaw secret files (and skips any that don't exist, never crashing):
   - host `/docker/<proj>/.env` (set `OPENCLAW_PROJECT_DIR` to the project dir)
   - `~/.openclaw/.env`
   - `~/.openclaw/secrets/.env`
   - `openclaw.json` `env` / `env.vars` (Mac `~/.openclaw/openclaw.json`, VPS `/data/.openclaw/openclaw.json`)
2. **Registry seed.** For every provider whose key is present, discovery emits rows into the existing `model_registry` table (idempotent upsert by `model_id`; the weekly Sunday-03:00 refresh cron then keeps them current). No migration; an absent key emits nothing — keys are never fabricated.
3. **Studio reads the registry** by capability tag (`image_generation` / `video_generation` / `audio_generation`) and shows only providers whose key is present. If a capability has no key, the tab shows a precise "add one of: `<KEYS>`" hint instead of a blank "No providers configured".

### Provider → capability map

| Env key (first present wins) | Provider | Image | Video | Audio |
|---|---|:---:|:---:|:---:|
| `KIE_API_KEY` (`KIEAI_API_KEY`, `KIE_AI_API_KEY`) | Kie.ai | generates | generates | — |
| `OPENAI_API_KEY` | OpenAI | generates | — | registry-only |
| `FAL_KEY` (`FAL_API_KEY`) | Fal.ai | generates | generates | generates |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Google | registry-only | registry-only | — |
| `FISH_AUDIO_API_KEY` | Fish Audio | — | — | registry-only |
| `ELEVENLABS_API_KEY` | ElevenLabs | — | — | generates |
| `REPLICATE_API_TOKEN` (`REPLICATE_API_KEY`) | Replicate | generates | — | — |
| `LUMA_API_KEY` | Luma | — | registry-only | — |
| `STABILITY_API_KEY` | Stability AI | registry-only | — | — |
| `RUNWAY_API_KEY` | Runway | — | registry-only | — |

- **generates** — a real generation path is wired in `src/lib/studio/generators.ts` today.
- **registry-only** — selectable in the dropdown but the generate path is "coming soon"; submitting returns an honest error rather than failing silently.

> NOTE: only the OpenAI **API key** is an image/audio provider. A Codex / ChatGPT OAuth login is **not** an image key.

### Adding a provider

Append one entry to `PROVIDER_DISCOVERY` in **`src/lib/studio/provider-discovery.ts`** — its `envCandidates` (in priority order), `slug`, `displayName`, and the `models` it contributes (each with a `capability` + `generates` flag). That is the single source of truth; nothing else needs to change for the provider to appear in the Studio dropdown and tabs. To make it actually generate (not registry-only), also wire a `call<Provider>()` branch in `runJob()` in `generators.ts`.

Run the discovery unit test with `npm run test:unit`.

## Operator Research — provider auto-discovery (v4.1.5)

The Operator Console **Research** sub-module (`/operator/research`) runs live, grounded web search. The provider is **not hardcoded** — it is discovered at runtime from your environment and the OpenClaw secret files (same hydration contract as Studio), so a box "just works" the moment a search key exists. Results are saved to the operator vault so they show up in **Memory** and the **All Searches** bucket.

### Provider preference order

Research selects **one** provider — the highest-preference one whose key is present:

> **Perplexity > OpenAI > Ollama (cloud) > xAI**

| Env var (first present wins) | Provider | Default model | Request shape + scope |
|---|---|---|---|
| `PERPLEXITY_API_KEY` (`PPLX_API_KEY`) | Perplexity | `sonar-pro` | `POST api.perplexity.ai/chat/completions` (OpenAI-compatible). Online "sonar" models search the live web every call; sources in `citations[]`. Scope: whole public web, real-time. |
| `OPENAI_API_KEY` | OpenAI | `gpt-4o-search-preview` | `POST api.openai.com/v1/chat/completions` with a web-search model + `web_search_options`. Source URLs in `message.annotations[].url_citation`. Scope: web. |
| `OLLAMA_CLOUD_API_KEY` (`OLLAMA_API_KEY`) | Ollama Cloud | `gpt-oss:120b` | `POST ollama.com/api/v1/chat/completions` (OpenAI-compatible) with the hosted `web_search` tool (`tool_choice:"auto"`). Tool results carry source URLs. Scope: web. |
| `X_AI_API_KEY` (`XAI_API_KEY`) | xAI Grok | `grok-4-fast` | `POST api.x.ai/v1/chat/completions` with `search_parameters.mode="on"` (Live Search). Sources in `citations[]`. Scope: X (Twitter) + the live web. |

The model is resolved from `model_registry` for the selected provider when it has an active row; otherwise the provider's default (above) keeps the module live on a fresh box (no registry seed required). **Shallow** targets a 30s SLA / fewer sources; **Deep** broadens the search and may run longer.

### SOON → live, or an honest empty-state

- **A search key is present →** Research is **live**: the `Soon` nav badge is gone, the page shows a "Live via `<Provider>`" pill, and queries run.
- **No search key →** the page shows an **honest empty-state** ("Add a Perplexity, OpenAI, Ollama, or xAI key to enable Research", with the exact env vars). The `POST /search` endpoint returns `{ empty_state: true }` (HTTP 200) — never a dead box, never a 502. Keys are never fabricated.

### Per-box deploy

- **VPS (Hostinger Docker):** add the chosen key to host `/docker/<proj>/.env`, then `docker compose up -d --force-recreate` (a plain `restart` does NOT reload `env_file`).
- **Mac:** add the key to `~/.openclaw/.env` (or `~/.openclaw/secrets/.env`), then restart the dashboard process.

### Adding a provider

Insert one entry into `RESEARCH_PROVIDERS` in **`src/lib/research/provider-discovery.ts`** at the right precedence (`envCandidates` in priority order, `slug`, `displayName`, `defaultModel`, `callSummary`), then add a normalizing adapter in **`src/lib/research/providers.ts`**. `GET /api/operator/research/availability` and the page pick it up automatically. Run the selection unit test with `npm run test:unit`.
