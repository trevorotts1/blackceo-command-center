# Command Center

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
- **Focus View (`/ceo-board/[dept]/focus`):** Dedicated task focus page per department
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
- **Departments:** Loaded dynamically from database workspaces; configure via `config/departments.json` or Skill 23 seed
- **Port:** `${PORT:-4000}` (env var, defaults to 4000)
- **Logo:** Place at `public/logo.png` or set `NEXT_PUBLIC_LOGO_URL`
- **Brand colors:** Set primary/secondary hex colors on the company record; palette auto-generates
- **Intelligence:** Settings > Intelligence for per-department AI model and persona assignment

See deployment documentation for full setup instructions.
