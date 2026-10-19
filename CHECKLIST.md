# BlackCEO Command Center - Implementation Checklist
## Version 1.0.0
## April 12, 2026

---

## Component Verification Status

Legend: ✅ runtime-verified in a browser · 🟨 implemented, checked by reading the code only (not yet verified in a running app) · ⚠️ Partial or open: at least one checklist item is missing at `main`, and the row names the open pull request or says none exists · ⬜ not started.
Each row below was checked against `main` at `08fe862d` on 2026-10-19. The per-section "Verification Status" lines further down stay "Not Verified" until someone ticks the boxes in a running app.

| Component | Status | Verified By | Notes |
|-----------|--------|-------------|-------|
| CEO Board | ⚠️ Partial | Code inspection, 2026-10-19, main 08fe862d | `src/app/ceo-board/page.tsx` (hero card, KPI cards, department grade cards). Open at main: "Grade calculation uses correct weights: 40% KPI, 30% Agent, 15% DA, 15% Recommendations" is not met. The live weights are 25% throughput, 30% QC pass rate, 20% SOP coverage, 25% KPI (`src/lib/grading.ts`); the 40/30/15/15 table in `src/lib/grade-calculator.ts` is marked `@deprecated`. No fix in flight: it is the decision packet's "Grade weights" item (change the spec or the code). |
| Department Boards | ⚠️ Partial | Code inspection, 2026-10-19, main 08fe862d | `src/app/ceo-board/[dept]/page.tsx`. Open at main: "Reads department-config.json" is not met; no code under `src` reads that file (the only mention is a comment in `src/lib/routing/department-router.ts`). No fix in flight: it is not yet decided where per-department settings live. |
| Kanban - Department Browser View | ⚠️ Open | Code inspection, 2026-10-19, main 08fe862d | Sidebar + Kanban is live as the master board `src/app/tasks/all/page.tsx` (six columns, PRD 3.8). The five-column version this checklist describes, `src/components/ceo-board/DepartmentBrowser.tsx`, is not mounted on any route. Needs a product decision: keep the six-column board as the browser, or mount the five-column one. |
| Kanban - Focused Single-Department View | ⚠️ Partial | Code inspection, 2026-10-19, main 08fe862d | `src/app/ceo-board/[dept]/focus/page.tsx` is read-only, as this checklist's View B asks. Open defect at main: blocked tasks are folded into the Review column with no marker. Fix waiting in PR #569. The interactive per-department board is `src/app/tasks/by-department/page.tsx`. |
| Performance Board | ⚠️ Partial | Code inspection, 2026-10-19, main 08fe862d | The three lenses are sections of the CEO Board page `src/app/ceo-board/page.tsx` (home card "Performance Board" routes there from `src/app/page.tsx`). Open at main: "Industry benchmark comparisons" are not shown at company level (decision packet Question C), and "Formula matches PRD: `(kpi * 0.4) + ...`" is not met because the live grade weights differ (decision packet "Grade weights" item). No fix in flight for either. |
| Devil's Advocate | ⚠️ Partial | Code inspection, 2026-10-19, main 08fe862d | `src/components/ceo-board/DevilsAdvocateFeed.tsx`, `src/app/api/da-challenges/route.ts`. Open at main: "Challenge detail view accessible" is missing (fix waiting in PR #570). "Respects department-config.json DA settings" is not defined anywhere in this repo, so it is open with no fix in flight. |
| Intelligence Settings | ⚠️ Partial | Code inspection, 2026-10-19, main 08fe862d | `src/app/settings/intelligence/page.tsx`, `src/app/api/persona-selection-log/route.ts`. Open at main: the Persona Selection Log subsection (history, per-layer reasoning, filters) has no UI. Fix waiting in PR #571. |

---

## CEO Board Checklist

### Display
- [ ] Company health letter grade displays (A-F)
- [ ] Grade calculation uses correct weights: 40% KPI, 30% Agent, 15% DA, 15% Recommendations
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

### Department Browser View (View A)
- [ ] Left sidebar shows all departments
- [ ] Departments display emoji + name + task count badge
- [ ] Clicking department sets it as active
- [ ] Right panel shows Kanban for active department
- [ ] Kanban columns: New, Queued, In Progress, Review, Done
- [ ] Task cards show: title, assigned agent, persona pill, priority badge

### Focused Single-Department View (View B)
- [ ] Full-screen Kanban displays
- [ ] No sidebar visible
- [ ] Large "Back" button returns to Browser view
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
- [ ] Industry benchmark comparisons
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
- [ ] Formula matches PRD: `(kpi * 0.4) + (agent * 0.3) + (da * 0.15) + (rec * 0.15)`
- [ ] Calculation in utility function (grade-calculator.ts)
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
- [ ] Respects department-config.json DA settings

**Verification Status:** ⬜ Not Verified

---

## Intelligence Settings Checklist

### Persona Categories
- [ ] Displays all personas from persona-categories.json
- [ ] Category filters by domain work
- [ ] Persona details: name, description, tags, use cases
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
- [ ] DepartmentBrowser component exists
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
