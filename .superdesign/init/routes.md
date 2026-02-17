# Routes - BlackCEO Command Center

## Framework
Next.js 14 App Router (file-based routing)

## Page Routes

| Path | File | Description |
|------|------|-------------|
| `/` | `src/app/page.tsx` | Workspace selection dashboard |
| `/workspace/[slug]` | `src/app/workspace/[slug]/page.tsx` | Main workspace view with agents, mission queue, and live feed |
| `/settings` | `src/app/settings/page.tsx` | Settings page |

## API Routes

| Path | File | Methods |
|------|------|---------|
| `/api/agents` | `src/app/api/agents/route.ts` | GET, POST |
| `/api/agents/[id]` | `src/app/api/agents/[id]/route.ts` | GET, PATCH, DELETE |
| `/api/agents/[id]/openclaw` | `src/app/api/agents/[id]/openclaw/route.ts` | GET, POST, DELETE |
| `/api/tasks` | `src/app/api/tasks/route.ts` | GET, POST |
| `/api/tasks/[id]` | `src/app/api/tasks/[id]/route.ts` | GET, PATCH, DELETE |
| `/api/workspaces` | `src/app/api/workspaces/route.ts` | GET, POST |
| `/api/workspaces/[id]` | `src/app/api/workspaces/[id]/route.ts` | GET, PATCH, DELETE |
| `/api/events` | `src/app/api/events/route.ts` | GET, POST |
| `/api/openclaw/status` | `src/app/api/openclaw/status/route.ts` | GET |
| `/api/openclaw/sessions` | `src/app/api/openclaw/sessions/route.ts` | GET |

## Key Pages Summary

### Home (/) - Workspace Selection
- Shows all workspaces in a card grid
- Each workspace card shows: icon, name, slug, task count, agent count
- "Add Workspace" button to create new workspaces
- Create Workspace modal with icon selector and name input

### Workspace (/workspace/[slug]) - Main Dashboard
- **Header**: Logo, workspace indicator, stats (agents active, tasks in queue), time, online status, settings button
- **Left Sidebar**: Agents list with filter tabs (all/working/standby), agent cards with avatar, name, role, status, OpenClaw connect button
- **Center**: Mission Queue kanban board with columns (Planning, Inbox, Assigned, In Progress, Testing, Review, Done), draggable task cards
- **Right Sidebar**: Live Feed with event stream, filter tabs (all/tasks/agents)
