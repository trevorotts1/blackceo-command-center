# Command Center

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
See PRD v2.1 (`onboarding ant farm PRD v2.1.md` in user's local Downloads) for the complete specification. Executes in order: v1.1 (foundation) → v2.0 (intelligence) → v2.1 (zero-human-company spec).
<!-- END v2.1 SECTION -->



AI Agent Management Dashboard - A universal template for any organization.

**Current Version: v8.0.0** — April 13, 2026

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
