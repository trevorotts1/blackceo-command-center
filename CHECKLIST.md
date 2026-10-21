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
| Department Boards | 🟨 Code-checked | Code inspection + new wiring, 2026-10-21, main 426024cd + branch recovery/cc-feature-wiring-20261021 | `src/app/ceo-board/[dept]/page.tsx`. The 2026-10-19 open item "Reads department-config.json" is closed by this branch (commit 04ae4bf3): the decision is that per-department settings live at the Skill 23 convention location `$WORKSPACE_BASE_PATH/workspace/departments/<slug>/department-config.json` (23-ai-workforce-blueprint SKILL.md §515). `src/lib/department-config.ts` resolves the candidate paths (WORKSPACE_BASE_PATH with ~ expansion, then ~/.openclaw, then ~/clawd; deduped) and coerces the JSON tolerantly; `GET /api/department-config?department=<slug-or-id>` (src/app/api/department-config/route.ts) returns found:false + expectedPath when the file is absent (the NORMAL state — 0 of 74 department folders ship one) and found:true + parseError when it is malformed, never a 500 and never fabricated KPIs/assignments; the department board page fetches it and renders a universal "Department Config" section (KPI targets + specialist assignments, honest empty state naming the expected path). Unit tests: tests/unit/cc-department-config.test.ts (8 tests, wired into vitest.config.ts). Boxes stay unticked until checked in a running app. |
| Kanban - Department Board View | 🟨 Code-checked | Code inspection, 2026-10-19, main eafc0bdf + the department task count badge PR | Decided 2026-10-19 (gap A, option 1): the department board is the live master board `src/app/tasks/all/page.tsx` (cross-department Kanban, departments rail on the left, six columns, PRD 3.8). The unmounted five-column `DepartmentBrowser` component was deleted and its five-column checklist item is closed as superseded. Each department in the rail (`src/components/AgentsSidebar.tsx`) now shows emoji, name, head agent, status and an open-task count badge: the rail reads `/api/workspaces?stats=true` and shows `taskCounts.total` minus `taskCounts.done`, so every status except `done` counts as open (component test `tests/unit/cc-dept-task-count-badge.test.tsx`). Every item in this section is met by the code; the boxes stay unticked until someone checks them in a running app. |
| Kanban - Focused Single-Department View | 🟨 Code-checked | Code inspection, 2026-10-19, main 438b50ea | `src/app/ceo-board/[dept]/focus/page.tsx` is read-only, as this checklist's View B asks. Blocked cards carry a visible "Blocked" badge (PR #569, gap B). The large "Back" button now goes to the department board `/tasks/all` (gap A; component test `tests/unit/cc-gap-a-focus-back-button.test.tsx`). Every item in this section is met by the code; the boxes stay unticked until someone checks them in a running app. |
| Performance Board | 🟨 Code-checked | Code inspection, 2026-10-19, main 2be019fd + #569, #573 | The three lenses are sections of the CEO Board page `src/app/ceo-board/page.tsx` (home card "Performance Board" routes there from `src/app/page.tsx`). Decided 2026-10-19: industry benchmarks stay on the department pages and the Performance Board shows no company-level benchmark (Question C option 1); the grade formula follows `src/lib/grading.ts` (grade-weights decision). Both checklist items are reworded to match and stay unticked until checked in a running app. |
| Devil's Advocate | 🟨 Code-checked | Code inspection and component and route tests, 2026-10-19, main ed76c520 + this PR; 2026-10-21 branch recovery/cc-feature-wiring-20261021 | `src/components/ceo-board/DevilsAdvocateFeed.tsx`, `src/app/api/da-challenges/route.ts`, `src/app/api/da-challenges/[id]/route.ts`. Met in code: the feed lists challenges newest first (route.ts line 78), the four status badges show (feed line 118), the detail view opens (feed line 453, PR #570 gap D), and the data comes from the da_challenges table (route.ts line 78). Met in code by this PR: "Original proposal visible" (the detail view shows the challenged task's title as a link built from task_id, feed line 172-196 and 457-459; it opens that task on the board through the new `?task=` deep link in MissionQueue.tsx line 244-253; a missing or deleted task shows a plain note, never an error) and "Escalation tracking works" (PATCH /api/da-challenges/{id}, `src/app/api/da-challenges/[id]/route.ts` line 24-52, moves a challenge between pending, approved, rejected and escalated, and the detail view's Escalate, Mark approved and Mark rejected buttons call it, feed line 213 and 487-517; the badge follows the stored status). "Respects department-config.json DA settings" is DROPPED by owner decision 2026-10-19 (#5, PR #577): the Devil's Advocate applies to all departments, so it is not an open requirement and is not counted here. Open at the train head, each checked in code: "Risks and alternatives listed" and "Recommended modifications shown" (the table has no field for either, route.ts line 31-48, and the producer does not make them: openclaw-onboarding shared-utils/devils-advocate.py line 42 tells the model "Do NOT propose solutions" and its output template, line 51-63, has only Challenge, Specific Concern, What Would Have to Be True, Severity and Confidence; the feed already shows the assumptions and the full response, feed line 467-474, so there is nothing more to render without a producer change); the four Review Types items (this repo stores a free-text trigger_type, route.ts line 57 and 119; the producer has five event triggers, devils-advocate.py line 8-13 and devils-advocate-bridge.py line 108-114, no required, optional, standing or deep-dive review type, and no automatic trigger firing, devils-advocate-bridge.py line 10-12). The producer would need: a review_type field (required, optional, standing, deep dive) in the wire payload (devils-advocate-bridge.py build_payload, line 204-221) with the trigger-firing hooks and standing-review configuration behind it; and, for risks, alternatives and modifications, those sections in DA_PROMPT (line 51-63) with rule 4 relaxed, parsed in generate_challenge and sent in the payload. Each needs a paired change here (columns, POST schema, render). Closed in code by branch recovery/cc-feature-wiring-20261021 (commit 2b8e8c0a + paired openclaw-onboarding commit 3cfcb4848 on branch recovery/cc-da-review-fields-20261021): migration 173 (`da_challenge_review_fields`) adds `risks_alternatives`, `recommended_modifications` and `review_type` (default 'required') to da_challenges additively and idempotently (test tests/unit/migration-173-da-review-fields.test.ts, 4 tests); POST /api/da-challenges accepts the three fields as optional (older producers keep posting cleanly; pre-173 rows keep NULL/'required'); the feed's detail view renders "Risks & alternatives" and "Recommended modifications" with an honest "Not provided by the generator" empty state and a review-type badge (deep-dive prettified, unknown values render raw — component test tests/unit/cc-da-review-fields.test.tsx, 3 tests); the producer's DA_PROMPT gained the two sections with rule 4 relaxed ("may list, never execute"), generate_challenge parses them and carries review_type (--review-type flag, context review_type honored), and build_payload emits all three on the wire (selftest green). Still open, deliberately not built: the producer-side automatic trigger firing for standing/deep-dive review types (a scheduler + standing-review configuration behind devils-advocate-bridge.py) — the CC stores, badges and renders review_type for any value a producer sends; firing the trigger itself is a producer-side feature with a named open gap, not a CC integration. Boxes stay unticked until checked in a running app. |
| Intelligence Settings | 🟨 Code-checked | Code inspection and component test, 2026-10-19, main 5845eb7b + this PR | `src/app/settings/intelligence/page.tsx`, `src/app/personas/page.tsx`, `src/app/api/personas/route.ts`, `src/app/api/settings/intelligence/route.ts`, `src/components/settings/PersonaSelectionLog.tsx`, `tests/unit/cc-persona-categories-link.test.tsx`, `tests/unit/cc-gap-e-persona-selection-log.test.tsx`. Every unticked item in the section now carries a "met in code" file and line. The Persona Selection Log subsection (history, per-layer reasoning, filters) is fixed by PR #571 (gap E, merged in train #574). The three Persona Categories items (list from persona-categories.json, category filter, persona details) are met through the linked `/personas` screen: this screen has a "Persona categories" section whose link opens `/personas`, which loads `/api/personas` (persona-categories.json), filters by category (derived from each persona's domain tags) and shows name, description, domain and perspective tags, and use cases (the persona's custom tags, labelled "Use cases"). They are not embedded on this screen. The 5-Layer Alignment Display was not met on real data: the selector stores its five scores nested under `layers`, and the log rendered that object as "[object Object]". The log now shows the five layers by name with their score (this PR, test in `tests/unit/cc-gap-e-persona-selection-log.test.tsx`). Runtime loading, the missing PERSONA_DETAILS map and the File Paths fallback chain (WORKSPACE_BASE_PATH, then ~/clawd/, then ~/Downloads/openclaw-master-files/) are met in both persona routes. No owner decision is open. The boxes stay unticked until someone checks them in a running app. |

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
- [ ] Reads department-config.json (met in code via src/lib/department-config.ts + GET /api/department-config, wired into the department board page's data load — see the Department Boards row above; the file is optional and its absence renders an honest empty state. Unticked until checked in a running app)
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
- [ ] Required reviews trigger correctly (met in code: `review_type` is stored on every challenge (migration 173, default 'required') and the producer now carries it on the wire (--review-type flag; build_payload review_type field, openclaw-onboarding 3cfcb4848); the triggering of required reviews is the existing five event triggers in devils-advocate-bridge.py line 108-114. Unticked until checked in a running app)
- [ ] Optional reviews available on request (met in code: `review_type: 'optional'` is accepted by POST /api/da-challenges and stored/rendered as a badge; a manual `--review-type optional` run is the on-request path. Unticked until checked in a running app)
- [ ] Standing reviews auto-trigger for configured types (OPEN — producer-side: the auto-firing scheduler + standing-review configuration behind devils-advocate-bridge.py was deliberately not built; the CC stores/badges 'standing' when a producer sends it. Named open gap, see the Devil's Advocate row above)
- [ ] Deep dive option available (met in code: `review_type: 'deep-dive'` accepted, stored, and prettified as a "deep dive" badge in the feed detail view (tests/unit/cc-da-review-fields.test.tsx); the prompt's two new sections are emitted on every run and enriched by a deep-dive context. Unticked until checked in a running app)

### Content
- [ ] Original proposal visible (met in code via the detail view's challenged-task link; unticked until checked in a running app)
- [ ] DA feedback displayed
- [ ] Risks and alternatives listed (met in code via migration 173's `risks_alternatives` column + the feed detail view's "Risks & alternatives" section with an honest "Not provided by the generator" empty state; the producer emits the section since openclaw-onboarding 3cfcb4848. Unticked until checked in a running app)
- [ ] Recommended modifications shown (met in code via migration 173's `recommended_modifications` column + the feed detail view's "Recommended modifications" section; same producer pairing. Unticked until checked in a running app)
- [ ] Escalation tracking works (met in code via PATCH /api/da-challenges/{id} and the detail view's status buttons; unticked until checked in a running app)

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
- [ ] Runtime loading from disk (not hardcoded) - met in code: src/app/api/personas/route.ts:80 and src/app/api/settings/intelligence/route.ts:146 read persona-categories.json per request through `safeReadFileUtf8`; the only hardcoded persona ids are the id-only `AVAILABLE_PERSONAS` list, used solely when that file is missing (src/app/api/settings/intelligence/route.ts:217, :474) (unticked until checked in a running app)
- [ ] No PERSONA_DETAILS hardcoded map in TypeScript - met in code: no `PERSONA_DETAILS` exists anywhere in the repo; persona details come from the loaded file (src/app/api/personas/route.ts:145, src/app/api/settings/intelligence/route.ts:200) (unticked until checked in a running app)

### 5-Layer Alignment Display
- [ ] Layer 1: Company Mission match score - met in code: src/components/settings/PersonaSelectionLog.tsx:41 and :53 show "Layer 1: Company Mission match" with its score for every logged selection, from the `layers` the selector stores (presentation_job/persona_service/resources/scripts/persona-selector-v2.py:1449); component test tests/unit/cc-gap-e-persona-selection-log.test.tsx (unticked until checked in a running app)
- [ ] Layer 2: Owner Values alignment - met in code: src/components/settings/PersonaSelectionLog.tsx:41 and :53 show "Layer 2: Owner Values alignment" with its score for every logged selection, from the `layers` the selector stores (presentation_job/persona_service/resources/scripts/persona-selector-v2.py:1449); component test tests/unit/cc-gap-e-persona-selection-log.test.tsx (unticked until checked in a running app)
- [ ] Layer 3: Company Goals relevance - met in code: src/components/settings/PersonaSelectionLog.tsx:41 and :53 show "Layer 3: Company Goals relevance" with its score for every logged selection, from the `layers` the selector stores (presentation_job/persona_service/resources/scripts/persona-selector-v2.py:1449); component test tests/unit/cc-gap-e-persona-selection-log.test.tsx (unticked until checked in a running app)
- [ ] Layer 4: Department Goals fit - met in code: src/components/settings/PersonaSelectionLog.tsx:41 and :53 show "Layer 4: Department Goals fit" with its score for every logged selection, from the `layers` the selector stores (presentation_job/persona_service/resources/scripts/persona-selector-v2.py:1449); component test tests/unit/cc-gap-e-persona-selection-log.test.tsx (unticked until checked in a running app)
- [ ] Layer 5: Task-specific suitability - met in code: src/components/settings/PersonaSelectionLog.tsx:41 and :53 show "Layer 5: Task-specific suitability" with its score for every logged selection, from the `layers` the selector stores (presentation_job/persona_service/resources/scripts/persona-selector-v2.py:1449); component test tests/unit/cc-gap-e-persona-selection-log.test.tsx (unticked until checked in a running app)

### Persona Selection Log
- [ ] History of assignments visible - met in code: src/components/settings/PersonaSelectionLog.tsx:80, :227 (PR #571) (unticked until checked in a running app)
- [ ] Selection reasoning shown per layer - met in code: src/components/settings/PersonaSelectionLog.tsx:53, :243 (unticked until checked in a running app)
- [ ] Filter by department, date, task type works - met in code: src/components/settings/PersonaSelectionLog.tsx:112-118 (PR #571) (unticked until checked in a running app)

### File Paths
- [ ] Reads persona-categories.json from correct workspace path - met in code: `<workspace>/coaching-personas/persona-categories.json` at src/app/api/personas/route.ts:87 and src/app/api/settings/intelligence/route.ts:153 (unticked until checked in a running app)
- [ ] Fallback chain: WORKSPACE_BASE_PATH > ~/clawd/ > ~/Downloads/openclaw-master-files/ - met in code: src/app/api/personas/route.ts:82-88 and src/app/api/settings/intelligence/route.ts:148-154 (unticked until checked in a running app)

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
