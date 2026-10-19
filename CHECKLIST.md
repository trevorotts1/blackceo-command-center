# BlackCEO Command Center - Implementation Checklist
## Version 1.0.0
## April 12, 2026

---

## Component Verification Status

Legend: ✅ runtime-verified in a browser · 🟨 implemented, checked by reading the code only (not yet verified in a running app) · ⚠️ Partial or open: at least one checklist item is missing at the train head, and the row names the open pull request or says none exists · ⬜ not started.
Each row below was checked on 2026-10-19 against the head of merge train 2 (`main` at `2be019fd`, which already carries gaps D #570, E #571 and F #572 from train #574, plus gap B #569 and this table #573); the two Kanban rows were re-checked on `main` at `438b50ea` for gap A. The per-section "Verification Status" lines further down stay "Not Verified" until someone ticks the boxes in a running app.

| Component | Status | Verified By | Notes |
|-----------|--------|-------------|-------|
| CEO Board | 🟨 Code-checked | Code inspection, 2026-10-19, main 2be019fd + #569, #573 | `src/app/ceo-board/page.tsx` (hero card, KPI cards, department grade cards). Grade weights: decided 2026-10-19, the spec follows the code (25% throughput, 30% QC pass rate, 20% SOP coverage, 25% KPI in `src/lib/grading.ts`); the 40/30/15/15 table in `src/lib/grade-calculator.ts` is `@deprecated`. The checklist item above is reworded to match; it is still unticked until someone checks it in a running app. |
| Department Boards | ⚠️ Partial | Code inspection, 2026-10-19, main 2be019fd + #569, #573 | `src/app/ceo-board/[dept]/page.tsx`. Open at the train head: "Reads department-config.json" is not met; no code under `src` reads that file (the only mention is a comment in `src/lib/routing/department-router.ts`). No fix in flight: it is not yet decided where per-department settings live. |
| Kanban - Department Board View | 🟨 Code-checked | Code inspection, 2026-10-19, main eafc0bdf + the department task count badge PR | Decided 2026-10-19 (gap A, option 1): the department board is the live master board `src/app/tasks/all/page.tsx` (cross-department Kanban, departments rail on the left, six columns, PRD 3.8). The unmounted five-column `DepartmentBrowser` component was deleted and its five-column checklist item is closed as superseded. Each department in the rail (`src/components/AgentsSidebar.tsx`) now shows emoji, name, head agent, status and an open-task count badge: the rail reads `/api/workspaces?stats=true` and shows `taskCounts.total` minus `taskCounts.done`, so every status except `done` counts as open (component test `tests/unit/cc-dept-task-count-badge.test.tsx`). Every item in this section is met by the code; the boxes stay unticked until someone checks them in a running app. |
| Kanban - Focused Single-Department View | 🟨 Code-checked | Code inspection, 2026-10-19, main 438b50ea | `src/app/ceo-board/[dept]/focus/page.tsx` is read-only, as this checklist's View B asks. Blocked cards carry a visible "Blocked" badge (PR #569, gap B). The large "Back" button now goes to the department board `/tasks/all` (gap A; component test `tests/unit/cc-gap-a-focus-back-button.test.tsx`). Every item in this section is met by the code; the boxes stay unticked until someone checks them in a running app. |
| Performance Board | 🟨 Code-checked | Code inspection, 2026-10-19, main 2be019fd + #569, #573 | The three lenses are sections of the CEO Board page `src/app/ceo-board/page.tsx` (home card "Performance Board" routes there from `src/app/page.tsx`). Decided 2026-10-19: industry benchmarks stay on the department pages and the Performance Board shows no company-level benchmark (Question C option 1); the grade formula follows `src/lib/grading.ts` (grade-weights decision). Both checklist items are reworded to match and stay unticked until checked in a running app. |
| Devil's Advocate | ⚠️ Partial | Code inspection, 2026-10-19, main 2be019fd + #569, #573 | `src/components/ceo-board/DevilsAdvocateFeed.tsx`, `src/app/api/da-challenges/route.ts`. "Challenge detail view accessible" is now met: PR #570 (gap D, merged in train #574) added the detail view. Open at the train head: "Respects department-config.json DA settings" is DROPPED by owner decision 2026-10-19 (Devil's Advocate applies to all departments; no per-department setting is built or planned until a client asks). No fix in flight. |
| Intelligence Settings | ⚠️ Partial | Code inspection and component test, 2026-10-19, main eafc0bdf + this PR | `src/app/settings/intelligence/page.tsx`, `src/app/personas/page.tsx`, `src/app/api/personas/route.ts`, `src/components/settings/PersonaSelectionLog.tsx`, `tests/unit/cc-persona-categories-link.test.tsx`. The Persona Selection Log subsection (history, per-layer reasoning, filters) is fixed by PR #571 (gap E, merged in train #574). The three Persona Categories items (list from persona-categories.json, category filter, persona details) are met through the linked `/personas` screen: this screen has a "Persona categories" section whose link opens `/personas`, which loads `/api/personas` (persona-categories.json), filters by category (derived from each persona's domain tags) and shows name, description, domain and perspective tags, and use cases (the persona's custom tags, labelled "Use cases"). They are not embedded on this screen. Partial because the 5-Layer Alignment Display, runtime-loading and File Paths items were not re-checked here. |

---

## CEO Board Checklist

### Display
- [ ] Company health letter grade displays (A-F)
- [ ] Grade calculation uses correct weights: 25% throughput, 30% QC pass rate, 20% SOP coverage, 25% KPI (`DEFAULT_INPUT_WEIGHTS` in `src/lib/grading.ts`)
- [ ] Real-time agent counter shows live count
- [ ] Department cards show emoji, name, headcount, active tasks
- [ ] Department health indicators render correctly

### Data
- [ ] Reads departments.json from config/
- [ ] Reads company-config.json for KPI targets
- [ ] Queries database for live metrics
- [ ] No hardcoded department list

### Interactions
- [ ] Clicking department card navigates to department board
- [ ] Quick-action buttons functional
- [ ] Refresh updates data without full reload

**Verification Status:** ⬜ Not Verified

---

## Department Boards Checklist

### Display
- [ ] Department name and emoji shown
- [ ] KPI tracking section visible
- [ ] Specialist roster displays all agents
- [ ] Agent cards show persona, status, metrics

### Data
- [ ] Reads department-config.json
- [ ] Queries department-specific tasks
- [ ] Links to SOPs accessible

### Interactions
- [ ] Clicking agent shows agent detail
- [ ] DA challenges section visible
- [ ] Navigation to Kanban works

**Verification Status:** ⬜ Not Verified

---

## Kanban Board Checklist

### Department Board View (View A, live at `/tasks/all`)
- [ ] Left sidebar shows all departments
- [ ] Departments display emoji + name + task count badge
- [ ] Clicking a department opens that department's Focus View (`/workspace/[slug]`)
- [ ] Main panel shows the cross-department Kanban
- [x] ~~Kanban columns: New, Queued, In Progress, Review, Done (five-column browser)~~ Closed as superseded 2026-10-19 (gap A): the department board `/tasks/all` uses the six-column PRD 3.8 set; the five columns stay on the Focused view
- [ ] Task cards show: title, assigned agent, persona pill, priority badge

### Focused Single-Department View (View B)
- [ ] Full-screen Kanban displays
- [ ] No sidebar visible
- [ ] Large "Back" button returns to the department board (`/tasks/all`)
- [ ] Accessible via /ceo-board/[dept]/focus route

### Task Filtering
- [ ] department_id query parameter works in API
- [ ] SQL WHERE clause filters correctly
- [ ] Only tasks for selected department shown

### Real-time Updates
- [ ] SSE connection established
- [ ] Task moves reflect in real-time
- [ ] Multi-client sync works

**Verification Status:** ⬜ Not Verified

---

## Performance Board Checklist

### Data Quality
- [ ] No synthetic/fake data (no Math.random, demo arrays)
- [ ] Real API calls fetch live data
- [ ] "No data yet" message when appropriate

### Lens 1: Business Operations KPIs
- [ ] Company-level KPIs display
- [ ] Department-level KPIs display
- [ ] Target vs actual progress bars
- [ ] Industry benchmark comparisons are on the department pages (the Performance Board shows no company-level benchmark)
- [ ] Historical trend charts

### Lens 2: Agent Performance
- [ ] Task completion rates by agent
- [ ] Average task duration metrics
- [ ] Quality scores from reviews
- [ ] Agent utilization visualization

### Lens 3: Proactive Intelligence
- [ ] Recommendations generated count
- [ ] Follow-through rate displayed
- [ ] Proactive task completion rate
- [ ] Insight-to-action conversion

### Grade Calculation
- [ ] Formula matches PRD: `DEFAULT_INPUT_WEIGHTS` in `src/lib/grading.ts` (throughput 0.25, QC pass rate 0.30, SOP coverage 0.20, KPI 0.25)
- [ ] Calculation in utility function (`src/lib/grading.ts`; `grade-calculator.ts` is deprecated)
- [ ] Grades update when data changes

**Verification Status:** ⬜ Not Verified

---

## Devil's Advocate Checklist

### Display
- [ ] Challenge feed shows recent reviews
- [ ] Status indicators: pending, approved, rejected, escalated
- [ ] Challenge detail view accessible

### Review Types
- [ ] Required reviews trigger correctly
- [ ] Optional reviews available on request
- [ ] Standing reviews auto-trigger for configured types
- [ ] Deep dive option available

### Content
- [ ] Original proposal visible
- [ ] DA feedback displayed
- [ ] Risks and alternatives listed
- [ ] Recommended modifications shown
- [ ] Escalation tracking works

### Data
- [ ] Reads from da_challenges table
- [ ] Respects department-config.json DA settings - DROPPED by owner decision 2026-10-19 (Trevor, #5): the Devil's Advocate feed stays ON for every department; this per-department setting is not built and is not an open requirement until a client asks for it

**Verification Status:** ⬜ Not Verified

---

## Intelligence Settings Checklist

### Persona Categories
- [ ] Displays all personas from persona-categories.json (met in code via the linked `/personas` screen; unticked until checked in a running app)
- [ ] Category filters by domain work (met in code via the linked `/personas` screen; unticked until checked in a running app)
- [ ] Persona details: name, description, tags, use cases (met in code via the linked `/personas` screen; unticked until checked in a running app)
- [ ] Runtime loading from disk (not hardcoded)
- [ ] No PERSONA_DETAILS hardcoded map in TypeScript

### 5-Layer Alignment Display
- [ ] Layer 1: Company Mission match score
- [ ] Layer 2: Owner Values alignment
- [ ] Layer 3: Company Goals relevance
- [ ] Layer 4: Department Goals fit
- [ ] Layer 5: Task-specific suitability

### Persona Selection Log
- [ ] History of assignments visible
- [ ] Selection reasoning shown per layer
- [ ] Filter by department, date, task type works

### File Paths
- [ ] Reads persona-categories.json from correct workspace path
- [ ] Fallback chain: WORKSPACE_BASE_PATH > ~/clawd/ > ~/Downloads/openclaw-master-files/

**Verification Status:** ⬜ Not Verified

---

## Technical Infrastructure Checklist

### Database Schema
- [ ] tasks table exists with department_id
- [ ] task_activities table exists
- [ ] task_deliverables table exists
- [ ] kpi_snapshots table exists
- [ ] agent_activity table exists
- [ ] recommendations table exists
- [ ] da_challenges table exists
- [ ] sub_agent_sessions table exists
- [ ] persona_selection_log table exists (new)

### API Endpoints
- [ ] GET /api/departments returns dynamic list
- [ ] GET /api/tasks filters by department_id
- [ ] GET /api/kpi-history returns real data
- [ ] GET /api/agents returns agent activity
- [ ] GET /api/recommendations returns recommendations
- [ ] GET /api/settings/intelligence loads personas from file
- [ ] POST /api/tasks/[id]/dispatch includes 5-layer instructions

### Frontend Components
- [ ] Breadcrumb component on all pages
- [x] ~~DepartmentBrowser component exists~~ Closed as superseded 2026-10-19 (gap A): component deleted, the department board is `/tasks/all`
- [ ] FocusedKanban component exists
- [ ] ActivityLog component renders
- [ ] DeliverablesList component renders
- [ ] SessionsList component renders
- [ ] TaskModal with tabs functional
- [ ] SSE hook (useSSE) implemented

### Real-time
- [ ] SSE endpoint /api/events/stream working
- [ ] Keep-alive pings functional
- [ ] Auto-reconnect on disconnect
- [ ] Multi-client sync tested

### Port Configuration
- [ ] All docs reference port 4000
- [ ] No references to 3007 or 3010
- [ ] ecosystem.config.cjs defaults to 4000
- [ ] PORT env var override works

**Verification Status:** ⬜ Not Verified

---

## Integration Checklist

### Skill 22 (Book-to-Persona)
- [ ] Creates persona blueprints correctly
- [ ] Generates persona-categories.json
- [ ] Updates pre-qualified pools
- [ ] Auto-reindexes after new persona creation

### Skill 23 (AI Workforce Blueprint)
- [ ] Creates departments.json in correct location
- [ ] Creates company-config.json
- [ ] Creates per-department config files
- [ ] Writes SOPs for each role
- [ ] 5-layer alignment documented
- [ ] Persona selection logging included

### Skill 32 (Command Center Setup)
- [ ] Installs on port 4000
- [ ] PM2 configuration correct
- [ ] n8n webhook returns tunnel token
- [ ] Cloudflare tunnel established
- [ ] Subdomain accessible

**Verification Status:** ⬜ Not Verified

---

## Repository Hygiene Checklist

### Documentation
- [ ] PRD.md exists (this document)
- [ ] CHECKLIST.md exists (this document)
- [ ] CHANGELOG.md up to date
- [ ] README.md reflects current features
- [ ] API documentation complete

### Code Quality
- [ ] TypeScript compiles without errors
- [ ] npm run build passes
- [ ] No console.log in production paths
- [ ] Error handling implemented
- [ ] Type safety maintained

### Git
- [ ] All changes committed
- [ ] Commit messages clear and descriptive
- [ ] No uncommitted changes
- [ ] Version bumped

**Verification Status:** ⬜ Not Verified

---

## Final Verification

| Item | Status | Date | Notes |
|------|--------|------|-------|
| All components implemented | ⬜ | - | - |
| All data sources connected | ⬜ | - | - |
| Real-time updates working | ⬜ | - | - |
| No synthetic data remaining | ⬜ | - | - |
| Port 4000 everywhere | ⬜ | - | - |
| Personas loaded from file | ⬜ | - | - |
| Grade calculation correct | ⬜ | - | - |
| Documentation complete | ⬜ | - | - |
| Build passes | ⬜ | - | - |
| Ready for deployment | ⬜ | - | - |

---

*Document created based on BlackCEO System Overhaul Playbook v3.3*
*Last updated: April 12, 2026*
