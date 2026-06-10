# BlackCEO Command Center - Critical Project Reference

**Last Updated:** 2026-02-18 7:10 PM EST
**Purpose:** Permanent reference so any future session can pick this up cold.

---

## What It Is

BlackCEO Command Center is Trevor's AI agent orchestration dashboard. A Next.js web app that manages 23 AI agents running his business operations. White-labeled under the BlackCEO brand.

- **Location:** ~/projects/mission-control
- **Tech:** Next.js 15 + React + TypeScript + Tailwind CSS + SQLite (better-sqlite3) + Zustand
- **Port:** 4000 (Mac: 3000 | VPS: 4000) (PM2 process: "mission-control")
- **DB:** ~/projects/mission-control/mission-control.db (SQLite)

---

## Access URLs

- Local: http://localhost:4000 (Mac: 3000 | VPS: 4000)
- Network: http://YOUR_IP:4000
- Tailscale: http://YOUR_TAILSCALE_IP:4000

---

## Commands

```bash
cd ~/projects/mission-control
npm run dev              # Dev server (port 4000)
npm run build            # Production build
npx pm2 restart mission-control  # Restart prod
npx pm2 logs mission-control     # View logs
npm run db:seed          # Re-seed DB
npm run db:backup        # Backup SQLite
npm run db:reset         # Nuke + re-seed
```

---

## Tech Stack

**Dependencies:** Next.js, React, better-sqlite3, @hello-pangea/dnd (drag-drop Kanban), zustand (state), lucide-react (icons), date-fns, zod, uuid, playwright
**Dev:** TypeScript, Tailwind, PostCSS, ESLint

---

## App Structure

### Pages
- `/` - Main dashboard
- `/workspace/[slug]` - Workspace view
- `/settings` - Settings page

### API Routes (src/app/api/)
- `agents/` - CRUD for agents
- `tasks/` - CRUD for tasks
- `events/` - SSE event stream
- `workspaces/` - Workspace management
- `files/` - File handling
- `openclaw/` - OpenClaw integration
- `webhooks/` - Webhook endpoints
- `demo/` - Demo data

### Components (src/components/)
- **WorkspaceDashboard.tsx** - Main layout
- **Header.tsx** - Top nav with BlackCEO branding
- **AgentsSidebar.tsx** - Left panel listing all agents
- **MissionQueue.tsx** - Kanban board (drag-drop task columns)
- **LiveFeed.tsx** - Real-time event feed (SSE)
- **TaskModal.tsx** - Task detail/edit modal
- **AgentModal.tsx** - Agent detail modal
- **PlanningTab.tsx** - Task planning interface with Q&A
- **ActivityLog.tsx** - Task activity history
- **DeliverablesList.tsx** - Task deliverables
- **SessionsList.tsx** - OpenClaw sessions list
- **SSEDebugPanel.tsx** - Debug panel for SSE events

### Lib (src/lib/)
- **db/** - SQLite schema, migrations, seed data
- **openclaw/** - Client + device identity for OpenClaw integration
- **store.ts** - Zustand global state
- **types.ts** - TypeScript types
- **events.ts** - SSE event system
- **orchestration.ts** - Agent orchestration logic
- **auto-dispatch.ts** - Auto task dispatch
- **planning-utils.ts** - Planning Q&A utilities
- **config.ts** - App config
- **validation.ts** - Zod schemas

---

## Database Schema

**Tables:**
- `workspaces` - Multi-workspace support (default: "BlackCEO Operations")
- `agents` - 23 agents with name, role, status, soul_md, model config
- `tasks` - Kanban tasks with statuses: pending_dispatch, planning, inbox, assigned, in_progress, testing, review, done
- `planning_questions` - Q&A for task planning (multiple choice, text, yes/no)
- `planning_specs` - Locked planning specs per task
- `conversations` - Agent-to-agent and task conversations
- `conversation_participants` - M:M for conversations
- `messages` - Chat messages
- `events` - Activity event log (SSE source)
- `businesses` - Multi-business support
- `openclaw_sessions` - Tracks OpenClaw agent sessions
- `task_activities` - Task activity log
- `task_deliverables` - Files/outputs attached to tasks

---

## 23 Agents

1. **Master Orchestrator** - Plans, delegates, reviews. Quality gate. Never produces deliverables.
2. **Operations Admin** - Airtable, Sheets, calendar, email, SOPs, project tracking
3. **Content Writer** - Blog, email, SMS, newsletters. Creates content (does NOT send)
4. **Communications Agent** - Email/SMS delivery. Takes content from Content Writer and sends it.
5. **Convert and Flow Agent** - GHL backend: CRM, pipelines, automations, contacts, sub-accounts
6. **Website Developer** - Conversion-optimized pages. Sub-agents on Kimi 2.5 write code.
7. **Funnel Builder** - Funnel architecture, conversion strategy, offer sequencing
8. **App Builder** - DB schema, API, components, state. Sub-agents write code.
9. **Graphics Agent** - Image generation (KIE.AI, Nano Banana Pro, OpenAI)
10. **Video Agent** - Video creation (KIE.AI video, FFMPEG, FAL.AI)
11. **Voice AI Agent** - Call scripts, The Code methodology (128 techniques, 12 personas)
12. **Social Media Agent** - All platforms unified. Content calendar.
13. **Research Agent** - Web research, competitor intel, fact-checking
14. **Scraper Agent** - Web scraping, data extraction
15. **N8N Workflow Builder** - N8N workflow JSON. Sub-agents assemble JSON.
16. **Course Agent** - Curriculum for BlackCEO School of AI (entrepreneurs 55+)
17. **Book Writer** - Non-fiction with full narrative arc
18. **Anthology Writer** - 8-stage chapter creation for guided anthology
19. **Support Agent** - Monitors support@blackceo.com and Slack
20. **Billing Agent** - Stripe products, subscriptions, invoicing
21. **QA/Testing Agent** - Test strategies. Sub-agents execute tests.
22. **Zoom Agent** - Download recordings, transcribe, segment, clip, upload
23. **Podcast Agent** - Podcast production, Podbean, episode scheduling

---

## Design System (Light Theme - Implemented)

**Colors:**
- Background: #F8F9FB | Cards: #FFFFFF | Borders: #E5E7EB
- Text: #1A1D26 (primary), #6B7280 (secondary)
- Accent: #4F46E5 (indigo-600) | Success: #10B981

**Font:** Inter
**Buttons:** bg-indigo-600 hover:bg-indigo-700
**Cards:** hover:border-indigo-300 hover:shadow-lg

---

## Logo

- Local: `/public/logo-blackceo.png`
- GHL: `https://storage.googleapis.com/msgsndr/Mct54Bwi1KlNouGXQcDX/media/bbda8c9f-425b-45cd-a081-797689289593.png`

---

## What NOT to Change

- Project folder name (~/projects/mission-control)
- PM2 process name ("mission-control")
- Database file name
- API endpoint paths
- Agent configurations (23 agents in DB)

---

## Known Issues / Next Steps

1. **MissionQueue.tsx** - May still have old mc-* Tailwind classes to verify
2. **Phases 8-17** - Blocked awaiting guidance on `openclaw agent add` command
3. **Tab 24** - Needs a name from Trevor
4. Superdesign was tested but designs looked identical - pivoted to direct implementation

---

## Superdesign (Paused)

Project ID: `159f7357-87e0-4e38-ab37-43b8512b5f8a`
Files in `.superdesign/` folder (reference only, not actively used)
