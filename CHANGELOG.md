## [v4.15.0] - 2026-06-09 - fix(qc): Gemini model deprecated -> gemini-2.5-flash; log non-OK API errors

Fixes QC auto-scorer always falling through to the heuristic path (scoring <= 8.0, never reaching DONE).

### Root cause
`llmScoreViaGoogle` defaulted to `gemini-2.0-flash`, which Google has retired (returns HTTP 404 NOT_FOUND). The `if (!resp.ok) return null` check silently discarded the error with no log message, causing every Gemini call to return `null` -> heuristic path -> 8.0/10 score -> never >= 8.5 gate -> task never reaches `done`.

### Fixed
- `src/lib/qc-scorer.ts`: default Google model changed from `gemini-2.0-flash` -> `gemini-2.5-flash` (verified working).
- `llmScoreViaGoogle` and `llmScoreViaOpenAI`: non-OK responses now log `console.warn` with status code + error body before returning null.

### Fleet implication
Any CC deployment using Google/Gemini for QC scoring (no OPENAI_API_KEY) was affected. Fix is code-only. Deploy: `git pull && npm ci && npm run build && pm2 restart blackceo-command-center`.

## [v4.14.0] - 2026-06-09 - Auto-dispatch: specialist tasks now invoke OpenClaw automatically after routing

Closes the two-step routing gap: every task auto-routed to a specialist agent now fires the OpenClaw invocation immediately (no manual "Send to Agent" click required).

### Fixed

- **Routed specialist tasks now auto-invoke OpenClaw** (`src/lib/task-dispatcher.ts` + three call-sites): The Command Center has always had two steps — (1) routing assigns `assigned_agent_id`, (2) dispatch connects to OpenClaw and advances the task to `in_progress`. Step 2 only fired on a manual UI click. This meant every auto-routed task (Curtis routing a purple-duck to Graphics Lead; any agent ingest via Telegram/ingest endpoint) stalled in backlog indefinitely — the specialist was never invoked, no deliverable produced, no QC. Proven on Sheila's box.

### Added

- **`src/lib/task-dispatcher.ts`** — new server-only module exporting `autoDispatchTask(taskId, context?)`. Replicates the `POST /api/tasks/[id]/dispatch` Step-2 logic in-process: connects to OpenClaw, creates/reuses a session, builds the full task message (SOP pull, intelligence resolution, persona, output dir, API callbacks), calls `chat.send`, advances task to `in_progress`, sets agent to `working`, writes `task_dispatched` event + `task_activities` row. Fire-and-forget (`void autoDispatchTask(...)`) so routing never fails due to an OpenClaw connectivity issue.

- **Guards inside `autoDispatchTask`** (all verified by tests):
  1. Master/CEO agents (`is_master=1`) → **skip** (routing artifacts; CEO orchestrates, specialists execute).
  2. No `assigned_agent_id` → skip.
  3. Task already `in_progress`/`review`/`done`/`blocked`/`archived` → skip.
  4. `qc_reroute_attempts > QC_MAX_REROUTES` → skip (QC loop cap already blocked the task).
  5. Errors logged, never thrown — routing always completes.

- **`src/lib/tasks.ts`** — `createTaskCore` now calls `void autoDispatchTask(id, 'createTaskCore')` immediately after in-process routing assigns a non-null `resolvedAgentId`. Import added.

- **`src/app/api/webhooks/auto-route/route.ts`** — `POST` handler now calls `void autoDispatchTask(taskId, 'auto-route')` after the routing UPDATE. Import added. (This is the path the QC scorer and CEO delegation sweep hit.)

- **`src/lib/jobs/ceo-delegation-sweep.ts`** — sweep loop now calls `void autoDispatchTask(task.id, 'ceo-delegation-sweep')` after re-homing a task. Import added. Ensures QC-fail re-routed tasks also get invoked.

- **`tests/unit/auto-dispatch-routing.test.ts`** — 9 unit tests: function export, no-agent skip, master/CEO guard, `in_progress` guard, `review`/`done`/`blocked` terminal guards, QC cap guard, non-existent task ID graceful handling, import stability.

### Unchanged / Backward Compatible

- **Manual "Send to Agent" path** (`POST /api/tasks/[id]/dispatch`) continues to work for operator UI use.
- Pre-existing ~24 stale backlog tasks are NOT mass-dispatched — `autoDispatchTask` only fires on the routing/assignment event for newly-routed tasks, and the terminal-status guard prevents re-dispatching tasks already in flight.
- QC re-route loop guard (`qc_reroute_attempts`, `QC_MAX_REROUTES=3`) fully respected.

---

## [v4.13.0] - 2026-06-09 - Company Settings: brand secondary color, auto-derived product name, full CSS-variable theming

Extends the Company Settings page (`/settings/company`) so operators can make the dashboard their own:

### Added

- **Brand secondary color field** (`CompanySettingsForm`, v4.13.0): new color picker + hex input for `brandSecondaryColor`. Accepts hex or color name ("coral", "navy") with the same `resolveBrandColor()` D1 resolution as the primary. Persisted to `company-config.json` (via `/api/company/config`) and to `clients.brand_secondary_color` (via `/api/clients/[id]` PATCH).
- **`clients.brand_secondary_color` column** — Migration 062 adds `TEXT` column to the `clients` table; additive + idempotent, safe against any existing DB.
- **`buildThemeVars(primary, secondary?)` secondary parameter** (`src/lib/branding.ts`): when an explicit secondary is supplied it drives `--bcc-secondary`, `--bcc-secondary-hover`, `--bcc-secondary-light`, and the new `--brand-secondary-50..950` CSS-variable scale. When omitted/null the auto-derived analogous (+30°) shade is used as before.
- **`--brand-secondary-*` CSS-variable scale** (`globals.css`): default 50→950 scale (mirrors BlackCEO green) that `BrandTheme` replaces per client. Also adds `--bcc-secondary-hover` and `--bcc-secondary-light` to `:root`.
- **Secondary utility overrides in `BrandTheme`** (`src/components/BrandTheme.tsx`): emits `bg-brand-secondary-N`, `text-brand-secondary-N`, `border-brand-secondary-N`, gradient classes, and hover variants for all 11 scale steps — same build-safe `<style>` block pattern as the primary overrides.
- **`tests/unit/company-settings-brand.test.ts`** — 8 unit tests: product-name derive, `buildThemeVars` secondary output, null fallback to analogous, migration 062 column, API `allowedStrings` gate, `SELECT_COLS` coverage, `BrandTheme` source check.

### Changed

- **Company name → Product name auto-derive** (`CompanySettingsForm`): typing in the Company Name field now auto-populates Product Name as `"<Company Name> Command Center"` (e.g. "Wake-Up Rise-Up Live-Up Command Center"). Product Name stays fully editable; once the operator manually edits it the auto-populate stops. Hint text updated to document the behaviour.
- **`BrandTheme`** now reads `client.brand_secondary_color` from the selected tenant and passes it as the second argument to `buildThemeVars`, so the secondary scale cascades app-wide from the root `<style>` block — no per-component edits required.
- **`/api/clients/[id]` PATCH** now accepts and validates `brand_secondary_color` (hex or color-name resolution, same as `brand_color`).
- **`/api/company/config` POST** `allowedStrings` extended with `'brandSecondaryColor'`.
- **`src/lib/clients.ts`** — `Client`, `PublicClient`, `ClientRow` interfaces, `SELECT_COLS`, `createClient`, and `updateClient` all updated for `brand_secondary_color`.

---

## [v4.12.0] - 2026-06-09 - QC loop closed: port fix, re-dispatch to in_progress, infinite-loop guard

Two bugs caused QC-failed tasks to strand in backlog and never be redone automatically.

### Fixed

- **`src/lib/qc-scorer.ts` — FAIL-branch base URL (port 3000 → 4000)**: The re-route POST was built as `NEXTAUTH_URL || NEXT_PUBLIC_APP_URL || 'http://localhost:3000'`. The app runs on **port 4000**, so this POST always failed with "fetch failed" when `NEXTAUTH_URL` was unset. Fixed: now uses `getMissionControlUrl()` from `src/lib/config.ts`, which returns `MISSION_CONTROL_URL || 'http://localhost:4000'` (server-side). Import added at top of file.
- **`src/app/api/webhooks/auto-route/route.ts` — status advance**: The POST handler only set `assigned_agent_id` but left `status = 'backlog'`. A task assigned but still in backlog was invisible to the specialist and never appeared in their queue. Fixed: the UPDATE now also sets `status = 'in_progress'` when the current status is `'backlog'` (CASE WHEN guard — tasks already in_progress/review/done are untouched).
- **`src/lib/qc-scorer.ts` — FAIL branch now persists `qc_reroute_attempts`**: The UPDATE that sets `status = 'backlog'` also increments `qc_reroute_attempts` so the loop guard can track repeat failures.

### Added

- **`src/lib/qc-scorer.ts` — Infinite-loop guard (`qc_reroute_attempts` + `QC_MAX_REROUTES`)**: Each QC-fail re-route increments `tasks.qc_reroute_attempts`. When the counter exceeds `QC_MAX_REROUTES` (default **3**, overridable via env), the scorer stops re-dispatching and instead: sets the task to **`blocked`**, appends a `[QC-BLOCKED]` note to description, writes a `task_status_changed` event, and writes a CEO-addressed `qc_review` event with `[QC-BLOCKED]` so the Live Feed surfaces it for human attention. The kickback note now also shows `(attempt N/cap)` for visibility.
- **`src/lib/jobs/ceo-delegation-sweep.ts` — QC-fail backlog sweep**: Extended `runCeoDelegationSweep()` to also sweep backlog tasks with `qc_reroute_attempts > 0` from **any** department (not just CEO-workspace tasks). These tasks know their target department; the sweep re-routes them via `routeTask()` with the department hint and advances status to `in_progress`. This is the reliable safety net for tasks the immediate auto-route POST may have missed (race condition or transient failure).
- **`src/lib/db/migrations.ts` — Migration 061** (`add_tasks_qc_reroute_attempts`): Adds `tasks.qc_reroute_attempts INTEGER DEFAULT 0` column + partial index `WHERE qc_reroute_attempts > 0`. Additive + idempotent.
- **`src/lib/db/schema.ts`** — `qc_reroute_attempts` added to the tasks table definition for fresh installs.
- **`src/lib/types.ts`** — `qc_reroute_attempts?: number | null` added to the `Task` interface.
- **`tests/unit/qc-loop-close.test.ts`** — 8 unit tests: URL returns port 4000; `MISSION_CONTROL_URL` env respected; migration 061 column exists; `qc_reroute_attempts` increments on fail; task blocked after cap; `QC-BLOCKED` event written at cap (no `QC-REROUTE`); sub-cap stays in backlog; ceo-delegation-sweep query includes qc-fail tasks.

### Notes

- `QC_MAX_REROUTES` env (integer, default `3`): set lower (e.g. `1`) in test environments; set higher for complex departments with legitimate multi-round rework.
- The `ceo-delegation-sweep` runs every 5 minutes (unchanged) and now handles both CEO-stranded tasks and QC-fail re-dispatch as a unified safety net.

---

## [v4.11.0] - 2026-06-09 - QC scorer wired to all review-entry paths; FAIL→backlog+CEO-reroute; Live Feed surfaces qc_review

The per-department QC scorer (`runQCOnReview`) was only reachable via the manual PATCH route. Tasks reaching `review` via the agent-completion webhook or execution-watcher reconcile never triggered scoring, so `qc_review` events were never written and items rotted in the Review/QC column.

### Fixed

- **`src/app/api/webhooks/agent-completion/route.ts`** — imported `runQCOnReview`; both the `task_id` path and the `session_id` path now fire `runQCOnReview()` as a fire-and-forget call (inside the transition guard — only when the task actually moves into `review`).
- **`src/lib/jobs/execution-watcher.ts`** — imported `runQCOnReview`; `advanceToReview()` caller now also fires `runQCOnReview()` fire-and-forget after advancing to review.
- **`src/lib/qc-scorer.ts`** — FAIL branch changed: task now moves to **`backlog`** (not `in_progress`) so the ceo-delegation-sweep and auto-route webhook can re-dispatch it to the correct department. A CEO-addressed `qc_review` event with `[QC-REROUTE]` is written and a fire-and-forget POST to `/api/webhooks/auto-route` is triggered.
- **`src/components/LiveFeed.tsx`** — `qc_review` added to the Tasks filter list and `getEventDot()` switch (`bg-purple-500`).

### Added

- **`src/lib/jobs/qc-review-sweep.ts`** — new `runQCReviewSweep()` job: selects `review` tasks with no `qc_review` event in the last 10 minutes and calls `runQCOnReview()` for each. Disable with `DISABLE_QC_REVIEW_SWEEP=1`.
- **`src/lib/jobs/scheduler.ts`** — `qc-review-sweep` registered at `*/2 * * * *` (same frequency as `execution-reconcile`).
- **`tests/unit/qc-review-wiring.test.ts`** — 8 new unit tests covering: QC fires from agent-completion path, sweep scores a stuck review task, FAIL→backlog+CEO reroute event, task_status_changed event mentions Backlog, recent-event guard skips already-scored tasks, DISABLE guard, and qc_review event queryability.

---

## [v4.10.0] - 2026-06-09 - Department sidebar: subtitle shows head agent name instead of repeating dept name

Each department card in the left sidebar was displaying the department name twice — once as the bold title and again as the grey subtitle. The subtitle now shows the name of the department's assigned head agent (resolved from `workspaces.head_agent_id` → `agents.name` via the existing migration 028 JOIN). If no head agent is assigned, the subtitle renders "—" rather than repeating the name.

### Changed

- **`src/components/AgentsSidebar.tsx`** — sidebar department card rendering:
  - `Department.headTitle: string` renamed to `Department.headName: string | null`.
  - Workspace fetch type annotation extended with `head_agent_name?: string | null` (already returned by `/api/workspaces` via LEFT JOIN since migration 028).
  - `headName` populated from `ws.head_agent_name || null` instead of `ws.name`.
  - Subtitle render: `{dept.headName ?? '—'}` — shows the agent name when present, "—" when absent; never falls back to the department name.
  - Focus-mode rail subtitle unchanged ("In focus" string — unrelated to the bug).

### Behaviour notes

- All departments with a head agent set in the DB now show that agent's name as the subtitle.
- CEO / Master Orchestrator and any brand-new dept without an assigned head agent show "—".
- IDLE/ACTIVE badges, hoist order (CEO first, General Tasks last), and minimized emoji-only mode are all unaffected.

---

## [v4.9.0] - 2026-06-09 - Key-save hardening: 507 disk-full, atomic write, Ollama alias, smoke-test, ws-fix

Hardens the Intelligence Settings key-save path against the disk-full failure
mode diagnosed in the field (ENOSPC → opaque 502). Adds UX improvements for
the Ollama Cloud provider and fixes `ws://` scheme errors flooding server logs.

### Fixed

- **B1 — 507 on disk-full**: `POST /api/clients/[id]/keys` now returns HTTP 507
  Insufficient Storage (with an actionable message) when the write hits ENOSPC /
  "no space left on device", instead of an opaque 502. `isDiskFullError()` helper
  exported from `provider-discovery.ts` detects ENOSPC / "no space" / "disk full"
  variants.
- **B2 — atomic write**: `writeClientProviderKey` (self path) now writes to a
  `.bcc-tmp-<pid>` temp file in the same directory, then `fs.renameSync`s over
  the target — never partially overwriting the 57 KB `openclaw.json`. A
  `statfsSync` disk-space preflight (Node ≥ 18.15) refuses the write when free
  space < 2× file size with a clear operator message.
- **C1 — Ollama slug alias**: `extractOpenclawProviderKeys` now maps the OpenClaw
  `ollama` provider slug to BOTH `OLLAMA_API_KEY` (conventional derivation) AND
  `OLLAMA_CLOUD_API_KEY` (canonical name the UI checks), so the provider lights
  up regardless of which env-var name the detection layer queries first.
- **C2 — UI freshness**: `IntelligenceProviderList` now re-fetches
  `/api/models/provider-status` after the client resolves (not only on mount),
  so the detection side-effect that hydrates `process.env` on first read is
  always reflected. When `status.configured` is true the row shows "Configured
  (key: ENVVAR)" and the "Add API key" button is suppressed.
- **D — Smoke-test on save**: `types.ts` adds optional `verifyKey?(apiKey)` to
  `ModelProvider`. Ollama Cloud implements it (GET `/v1/models`, 7 s timeout).
  The key-save route runs it after a successful write and returns
  `smokeTest:{ok,status,message}` in the JSON. The UI surfaces green "Key saved
  and verified" or amber "Key saved but verification failed: <msg>".
- **ws:// scheme bug**: `POST /api/webhooks/task-created` normalises
  `OPENCLAW_GATEWAY_URL` from `ws://` → `http://` / `wss://` → `https://`
  before passing to `fetch()`, eliminating "unknown scheme" log floods.

### New

- `isDiskFullError(msg: string): boolean` in `provider-discovery.ts`
- `SmokeTestResult` interface and `verifyKey?` method in `model-providers/types.ts`
- `verifyKey` implementation in `ollama-cloud.ts`
- `tests/unit/provider-key-hardening.test.ts` — 8 unit tests covering all items above

---

## [v4.8.0] - 2026-06-09 - Kanban board: always-visible scrollbar + scroll affordance

Users could not tell that Review/QC, Blocked, and Done columns existed off-screen to the right. Replaced the invisible auto-hiding browser scrollbar with an always-visible, draggable styled scrollbar and added left/right scroll affordances.

### Changed

- **`src/components/MissionQueue.tsx`** — Kanban columns container refactored:
  - Outer `div` is now `position:relative overflow-hidden`, anchoring overlay affordances.
  - Inner scroll container gains `ref={scrollRef}` + `kanban-scroll` CSS class.
  - `canScrollLeft` / `canScrollRight` state derived from `scrollLeft`, `clientWidth`, `scrollWidth` via a `ResizeObserver` + scroll event listener.
  - Left/right fade gradient overlays (`.kanban-fade-left` / `.kanban-fade-right`) rendered conditionally; `pointer-events:none` so they never block card drag-and-drop.
  - Chevron buttons (`.kanban-scroll-btn`) sit centred within each fade zone, scrolling 320 px (≈ one column width) per click. Hidden on mobile (`.hidden.lg:block`).
  - Region `aria-label` + `tabIndex=0` added for keyboard accessibility.
  - Added `ChevronLeft`, `ChevronRight` from lucide-react; added `useRef`, `useEffect`, `useCallback` imports.

- **`src/app/globals.css`** — new `.kanban-scroll` class:
  - `scrollbar-width: thin` + `scrollbar-color` (Firefox).
  - `::-webkit-scrollbar` height 10 px, themed track (`--brand-50`) + thumb (`--brand-400`) with hover/active states (Chrome/Safari/Edge).
  - `.kanban-fade-left` / `.kanban-fade-right` overlay gradient rules.
  - `.kanban-scroll-btn` button rules (circle, white background, brand border, hover/active tints).

### Behaviour notes

- On macOS the default scrollbar is "overlay" (auto-hides); the new rules force it always visible and themed so users immediately see the board is scrollable.
- Card drag-and-drop (`draggable` / `onDragStart` / `onDrop`) is unaffected — the overlay divs are `pointer-events:none`.
- Keyboard scroll: the scroll region is `tabIndex=0`; arrow keys and Page Left/Right work natively on the focused container.
- Chevrons hide automatically at each edge (no scroll possible in that direction).

## [v4.7.0] - 2026-06-09 - Per-department QC Specialist gates review→done

Each department now has its own dedicated QC Specialist agent (`role_type=qc`). The QC scorer and the review→done gate use the task's own department QC agent for scoring and approval authority, with a global-master fallback for pre-migration installs.

### New

- **`agents.role_type` column** — migration 060 (`add_role_type_and_seed_qc_agents`) adds the column via `ALTER TABLE ADD COLUMN` (idempotent) and seeds one `QC Specialist` agent per existing workspace (`role_type='qc'`, `specialist_type='permanent'`).
- **`resolveQCAgent(task)`** — `src/lib/qc-scorer.ts` resolves the task's department QC agent by `workspace_id` (falling back to `canonicalDeptSlug` lookup); gracefully returns `null` when the column doesn't exist yet (pre-060 installs).
- **Per-dept scorer identity** — `buildQCPrompt` now opens with `"You are <AgentName>, the QC Specialist for the <dept> department."` when a QC agent is resolved; `runQCOnReview` event log carries `[scorer:<name>]` or `[scorer:global-heuristic]`.
- **`review→done` gate** (`src/app/api/tasks/[id]/route.ts`) — approval authority shifts from "any `is_master` agent" to the task's dept QC agent; falls back to global master when no QC agent exists for the workspace (safe on existing installs).
- **Unit tests** — 8 new tests in `tests/unit/per-dept-qc-specialist.test.ts` covering column existence, seeding, resolution, and gate authorization.

### Migration SQL (060)

```sql
ALTER TABLE agents ADD COLUMN role_type TEXT;
INSERT OR IGNORE INTO agents (id, name, role, ..., role_type) VALUES ('qc-agent-<ws_id>', '<ws_name> QC Specialist', 'QC Specialist', ..., 'qc');
```

## [v4.6.0] - 2026-06-09 - Board ordering: CEO pinned first, General Tasks pinned last (fleet-wide fix)

Fixes a fleet-wide bug where the canonical CEO department slug `master-orchestrator` was never hoisted to the top of the board (the old hoist only matched legacy slugs `ceo`/`dept-ceo`). Also pins General Tasks to the bottom. Both guarantees are enforced at two independent layers (DB sort_order + UI).

### Fixes

- **AgentsSidebar.tsx** — `isCeoItem()` now matches slugs `master-orchestrator`, `ceo`, `dept-ceo` and names `ceo`, `master orchestrator`. `isGeneralTaskItem()` pins the catch-all dept to the bottom. Board renders: CEO first … operational depts … General Tasks.
- **tasks/ingest/route.ts** — CEO catch-all query now includes `master-orchestrator` in the slug IN-list and `master orchestrator` in the name IN-list so unrouted tasks land on the CEO workspace on canonical installs.
- **migrations.ts** — Migration 046 re-pin query extended to match `master-orchestrator` slug (was only `ceo` / `dept-ceo`). New idempotent **migration 059** `pin_general_task_department_last` sets `general-task` workspaces to `sort_order = 99999`. `autoSeedFromDepartmentsJson` now seeds CEO at `sort_order = 0` and general-task at `sort_order = 99999`.

## [v4.5.0] - 2026-06-09 - Lean Kanban board confirmation + QC-agent auto-approval

Documents and cements the lean Kanban model; builds the QC-agent auto-scorer that was not previously wired.

### Lean Kanban board (UI/column-mapping change only)

- The board already had the correct lean columns: Backlog → To-Do → In Progress → Review/QC → Blocked → Done.
- `inbox`/`planning`/`assigned`/`pending_dispatch` statuses fold into the To-Do column; `testing` folds into Review/QC. No separate `inbox`, `planning`, `testing`, or `pending_dispatch` board columns — these are internal pipeline states only.
- `Blocked` is a side-state (not a stage in the flow). `TaskStatus` enum keeps all underlying values — this is intentionally a display mapping, not a schema migration.
- Updated COLUMNS comment in `MissionQueue.tsx` to document the lean model, the Triad gate, and the QC-agent auto-scorer gate.
- Added `general-task` to the emoji/name lookup tables in `MissionQueue.tsx`.

### QC-agent auto-approval (NEW — was not previously wired)

- New `src/lib/qc-scorer.ts`: when a task enters `review` status, fires the QC scorer against the assigned SOP's `success_criteria`.
- Scoring path: OPENAI_API_KEY → gpt-4o-mini (configurable via `QC_SCORER_MODEL`), then GOOGLE_API_KEY → Gemini flash, then heuristic fallback (no key required — conservative 6–8 range, never auto-passes).
- Pass (≥8.5): auto-moves task to `done`, writes `task_completed` event.
- Fail (<8.5): returns task to `in_progress`, appends gap notes to description, writes `task_status_changed` event.
- Always writes a `qc_review` event for the audit trail. Disable with `DISABLE_QC_AUTO_SCORER=1`.
- Wired in `src/app/api/tasks/[id]/route.ts` PATCH handler: fires fire-and-forget after response when `status` transitions to `review`.

## [v4.4.0] - 2026-06-09 - General Task routing floor + recurrence detector

Adds the General Task catch-all department and a routing confidence floor to prevent force-fitting tasks into the wrong department.

### General Task department (design section B)

- New mandatory canonical department `general-task` added to `CANONICAL_SLUGS` + `DEFAULT_DEPARTMENTS` (priority 1, empty keywords — never wins on merit).
- Routing aliases: `general`, `misc`, `catch-all`, `catchall`, `unclassified`.
- `DEFAULT_DEPARTMENTS` count is now 25 (was 24). `qc-cc.sh` check 2.5 updated accordingly.

### MIN_ROUTING_CONFIDENCE floor in comDispatch()

- New env-overridable constant `MIN_ROUTING_CONFIDENCE` (default 0.55) in `department-router.ts`.
- When the best semantic similarity is below the floor, routes to General Task (Step 3.5) instead of force-fitting to the wrong department. CEO master fallback is now Step 4 (degenerate only).
- Keyword-only mode: zero keyword hits now routes to General Task instead of CEO master.
- Every General Task fallback logs `sim / floor` values for tuning.

### General Task recurrence detector

- New `src/lib/jobs/general-task-recurrence.ts`: weekly job (Sunday 04:30) that clusters general-task tasks over 30 days. Any cluster ≥4 upserts a `recommendations` row (`category='try'`). Idempotent on SHA-256 cluster hash; suppresses dismissed. Zero new schema (reuses existing `recommendations` table).
- Registered in `scheduler.ts`. Disable with `DISABLE_GENERAL_TASK_RECURRENCE=1`.

### Tests

- 4 new unit tests: general-task config validation, never-wins-keyword, zero-keyword-hit → GT, high-confidence → specific dept.
- `intelligent-routing.test.ts` count assertion updated 24 → 25.
- qc-cc.sh check 2.5 updated 24 → 25. All 27/27 checks green.

## [v4.3.1] - 2026-06-09 - Bulletproof task-ingest deduplication — title+window + idempotency_key

Fixes the "duck-duplication" bug where two identical task requests (same title, same description, short time window) created two separate tasks.

### Changes

- **Layer 1 dedup in `createTaskCore`** (`src/lib/tasks.ts`): before inserting a new task, checks (a) an explicit `idempotency_key` match against existing `task_created` events, and (b) a 5-minute title+description+workspace window dedup. Returns `{ task, deduped: true }` for a match — no new row written.
- **Ingest route** (`src/app/api/tasks/ingest/route.ts`): removed the old Layer-0 dedup query (now redundant) and wires through to `createTaskCore`'s richer result; returns `{ deduped: true, task_id, ... }` on a hit with HTTP 200 (callers can distinguish from the 201 create).
- **UI create route** (`src/app/api/tasks/route.ts`): passes `skipWindowDedup: true` so intentional manual double-creates from the operator board are still honoured; explicit `idempotency_key` is still respected.
- **241 new unit tests** (`tests/unit/task-ingest-dedup.test.ts`) covering idempotency-key match, window dedup, skipWindowDedup bypass, and edge cases.

## [v4.3.0] - 2026-06-02 - SOP wiring: nightly auto-writer, Triad auto-draft, role-library bridge

Wires three previously-disconnected pieces of the Hybrid SOP system so the auto-SOP-writer, the Triad Rule, and the on-disk role library actually feed the Command Center SOP board. All three changes are additive; the SOP/Triad subsystem itself was already merged and enforced on main.

### 1. Auto-SOP-writer now runs nightly (was never scheduled)

`detectPatternsAndPropose()` (the learning-loop pattern detector that drafts candidate SOPs from recurring un-SOP'd tasks) was only reachable by an external cron pinging `/api/cron/sop-learning` — so on any box without external cron set up, the proposals queue never populated on its own.

- New in-process `sop-learning` job in `src/lib/jobs/scheduler.ts`, registered alongside the existing weekly `model-refresh` job via the same node-cron mechanism + `instrumentation.ts` boot hook. Runs nightly at **02:00** server local time.
- Idempotent on two levels: the process-wide `__BC_CRON_REGISTERED__` guard prevents double-scheduling, and `detectPatternsAndPropose()` already dedupes against existing pending proposals so re-runs never create duplicates.
- Logged per run (`[cron] sop-learning: scanned N … M new proposal(s)`). Opt out per box with `DISABLE_SOP_LEARNING_CRON=1`.

### 2. Triad block now auto-drafts the missing SOP

When the Triad Rule blocked a task from leaving backlog for having no SOP, the API returned a bare HTTP 400 with nothing for the dept head to act on.

- New `proposeDraftFromTask()` in `src/lib/sop-learning.ts` creates a **DRAFT SOP proposal** (the same `sop_proposals` model the learning loop and auto-research use) pre-filled from the task title/description + department + intended persona, marked `[TRIAD-BLOCK DRAFT — needs-review]`. Reuses the existing `draftStepsFromTask` heuristic.
- `PATCH /api/tasks/[id]` fires it (best-effort, never throws into the request) when `sop_id` is the missing piece, and returns the new `sop_draft_proposal_id` in the 400 body so the operator can jump straight to `/sops/proposals`.
- Idempotent: one pending Triad-block draft per task — a repeatedly-blocked task does not spawn a pile of drafts. Surfaces in the existing `/sops/proposals` "pending" review queue; approving it authors a real SOP via the existing `approveProposal` path.

### 3. Role-library bridge — on-disk how-to.md → CC SOP board

The 23 department-level starter SOPs (`sops-seed.ts`, DB) and the per-role on-disk `how-to.md` files (Skill-23 `departments/<dept>/<NN-role>/how-to.md`) shared no key, so the agents' real operating procedures never appeared on the CC SOP board.

- New `src/lib/role-library-import.ts` walks a departments tree, parses each role's `how-to.md` (title, Section-9 SOP headings → steps, keywords), and **upserts** into `sops` tagged `department` + `role` + `source='role-library'`.
- New `POST /api/sops/import-role-library` route + `npm run db:import:role-library` script (`scripts/import-role-library.ts`). Path is configurable (body `departments_path`, `ROLE_LIBRARY_PATH` env, or `<workspace>/departments`). `GET` reports the resolved path without writing.
- Stable key `role-library:<dept>/<role>` → idempotent, **never duplicates**. Only ever writes/replaces rows where `source='role-library'`; **never touches user-authored / starter / learning-loop SOPs** (those have `source IS NULL`). Optional `prune_missing` soft-deletes only role-library rows gone from disk.
- Migration **050** adds nullable `role` + `source` columns (+ indexes) to `sops`; `schema.ts` carries them for fresh installs. Additive — NULL defaults preserve existing department matching.
- Two-layer model + the sync documented in `docs/SOP-LAYERS.md`.

## [v4.2.2] - 2026-06-02 - OpenClaw Bridge: fix CLI spawn bugs + Enter-to-send + attachments + auto-pair

Bridge was broken across every CLI at the repo level (hit every client):

- **Claude Code**: add `--verbose` (required alongside `--print --output-format stream-json`).
- **Gemini**: `--json` → `--output-format json`, and parse the single JSON object's `.response`.
- **Codex**: an `ENOENT` (not installed) no longer crashes — returns a clean "not installed" message with an install hint.
- **OpenClaw**: protocol range `3` → `[3, 4]` (the gateway is v4); auto-approve a pairing-pending device via the gateway token, then retry the connect.
- **UX**: Enter sends (Shift+Enter inserts a newline); paperclip attachment upload writes to a scratch dir and is referenced in the dispatch.

Touches `src/lib/openclaw/client.ts`, `src/app/api/operator/bridge/send/route.ts`, `src/lib/bridge/agents.ts`, `src/components/operator/{BridgeChat,MessageInput}.tsx`, `src/app/api/openclaw/status/route.ts`. Merged via PR #34.

## [v4.2.1] - 2026-06-01 - White-label branding (D1-D3) + flagged operator fixes

- **Branding (migration 049)**: per-client `brand_color` / `logo_url`; the interview now asks for brand colors (hex or color-name → hex); the Command Center is themed from the client's primary + complementary palette; the client logo is uploaded to their own GHL media library and swapped in for the BlackCEO logo.
- **Flagged fixes**: bridge/send dispatches to the *selected* client's gateway and injects goals (E21/E12); client-FS base64 framing (marker-collision fix); a PDF is no longer read as utf8.

New `src/lib/branding.ts`, `src/lib/colors.ts`, `src/components/BrandTheme.tsx`; updates to `Header.tsx`, `useCompanyBrand.ts`, `CompanySettingsForm.tsx`, `client-fs.ts`. Merged via PR #33.

## [v4.2.0] - 2026-06-01 - Per-client tenant foundation + E1-E27 walkthrough fixes

Foundation (root-cause fix): a `clients` tenant table (migration 048), a per-target OpenClaw WS client with CF-Access headers, `resolveClientPath()` for per-client workspace reads, a client-picker, a single status pill (E24), and a per-client interview flag (E3).

Feature clusters (all QC ≥ 8.5):

- **intelligence** (E4-E9, E14): real refresh, add-key-to-env, model-card purpose, apply-to-all-depts, PersonaMatch placeholder, per-client provider keys over the tunnel.
- **operator** (E11, E12, E13, E16, E18, E20, E21, E22): journal / goals / memory / bridge / workspace / notebooks / call-mode / web-agent all re-pointed at the selected client over the CF tunnel.
- **kanban** (E23, E25, E26): real per-client live feed; settings-gear → intelligence; honest performance-board data source.
- **convai** (E1, E2, E3): connection-state indicator, plain-English persona copy, interview banner respects the per-client flag.
- **walkthrough** (E10, B3): element-anchored coach-marks app-wide.
- **security** (E27): Security Team department + roles wired into the dept registry.

New routes under `src/app/api/clients/*`, new `src/lib/clients.ts`, `src/lib/bridge/{cli-manager,dispatch}.ts`, `src/app/api/events/client-feed/route.ts`. Migration 048. Merged via PR #32.

## [v4.1.13] - 2026-06-01 - Expand starter SOP library 17 → 23

Adds the Security Team SOP (`security-incident-response`) per requirement, plus 5 high-value ZHC departments that previously had no starter SOP: **hr-people**, **finance-accounting**, **operations**, **data-analytics**, **executive-assistant**. Each matches the `SeedSOP` schema and auto-seeds idempotently on first boot via the same path as the existing 17 (`src/lib/sops-seed.ts`). Merged via PR #31.

## v4.1.12 - 2026-06-01 - Speech-to-text on Kanban new-task input

- MicDictateButton (browser Web Speech API) wired into TaskModal title + description fields; graceful degradation on unsupported browsers; no new deps. Build green.

## v4.1.11 - 2026-06-01 - Command Center audit fixes (B1-B8) + edge-build

- B6 SOP/role-library auto-seed on boot (instrumentation hook); B7 campaign board filter; B2 instant card auto-move via SSE + optional backstop; B4/B8 in-process routing + CEO delegation; B3 app-wide interactive walkthrough; B1 model-pill honesty (gateway rejects per-msg model override). Edge-runtime stubs for node-only instrumentation deps. Build green.

## [v4.1.10] - 2026-05-31 - Fix ZHC role/SOP library ingestion path mismatch (org-chart, persona-matrix, governing-personas)

Patch release. Fixes a fleet-wide latent bug that hid a fully built AI workforce: three dashboard read routes probed the **pre-v9.6.0 flat layout** for the client's Zero-Human-Company library, but Skill 23 (`build-workforce.py`) has written the **v9.6.0+ per-company layout** for many releases. So a client whose role/SOP/persona library was fully built still saw "It will be generated after running Skill 23 (AI Workforce Blueprint)" — the library never showed up correctly.

### The bug (verified against Skill 23 source on `trevorotts1/openclaw-onboarding`)

Skill 23 writes the library to the per-company root:
- `ORG-CHART.md`            → `<root>/zero-human-company/<slug>/ORG-CHART.md`
- `persona-matrix.md`       → `<root>/zero-human-company/<slug>/departments/persona-matrix.md`
- `governing-personas.md`   → `<root>/zero-human-company/<slug>/departments/<dept-id>/governing-personas.md` (bare canonical dept id, e.g. `customer-support` — **no** `-dept` suffix)

The three CC routes instead hardcoded the legacy flat paths:
- `GET /api/org-chart`                     → only `<root>/ORG-CHART.md`
- `GET /api/persona-matrix`                → only `<root>/persona-matrix.md`
- `GET /api/departments/[id]/personas`     → only `<root>/departments/<id>-dept/governing-personas.md`

Three independent mismatches: (1) the per-company `zero-human-company/<slug>/` folder was never searched; (2) `persona-matrix.md` actually lives in the per-company `departments/` subfolder; (3) the department folder uses the bare canonical id, not the legacy `<id>-dept` suffix. None of the routes were platform-aware either, so on a VPS box they ignored `/data/.openclaw/workspace`.

### The fix (additive, non-destructive)

- New `zhcLibraryBaseDirs()` helper in `src/lib/platform.ts` — the single source of truth for where the ZHC library lives. Returns ordered candidate base dirs: `OPENCLAW_COMPANY_ROOT` override → every `<root>/zero-human-company/<slug>/` (most-recently-modified first, matching `sync-departments-from-build-state.py`) → legacy flat `<root>/`. Platform-aware (Mac `~/clawd` vs VPS `/data/.openclaw/workspace`), honors `WORKSPACE_BASE_PATH`.
- The three routes now resolve files against `zhcLibraryBaseDirs()`, probing canonical-first with the legacy paths retained as fallbacks — so a v9.6.0+ build resolves correctly while pre-v9.6.0 installs are never regressed. The governing-personas route normalizes the incoming dept id to all of `<bare>`, `dept-<bare>`, `<bare>-dept`.
- 3 new unit tests (`tests/unit/zhc-library-paths.test.ts`): canonical resolution + precedence over the flat root, `OPENCLAW_COMPANY_ROOT` override, and legacy-flat fallback.

No schema change, no client data touched, universal across the fleet. A client whose dashboard already redeployed will need to redeploy again to pick this up (per the per-box deploy model).

## [v4.1.9] - 2026-05-30 - Fix fleet-wide missing kpi_snapshots table (migration 047)

Patch release. Fixes a fleet-wide latent bug: the `kpi_snapshots` table was consumed by three code paths but created by no migration, so every Command Center deployment threw `no such table: kpi_snapshots` the moment a KPI page was touched. One additive, idempotent DB migration; zero personal/client data — universal across the fleet.

### The bug

`kpi_snapshots` is read/written by `GET`+`POST /api/kpi-snapshots`, `GET /api/kpi-history`, and seeded by `src/lib/db/seed-kpi-history.ts` — but no migration ever created it and `schema.ts` never defined it. The KPI pages therefore failed with a SQL error on every box.

### The fix — new idempotent migration `047` `add_kpi_snapshots`

- **`CREATE TABLE IF NOT EXISTS kpi_snapshots`** + the two indexes (`idx_kpi_snapshots_dept_date` on `(department_id, snapshot_date)`, `idx_kpi_snapshots_kpi` on `(kpi_id)`). The columns are derived directly from the consumer routes (the source of truth), not invented: `id TEXT PRIMARY KEY, department_id TEXT NOT NULL DEFAULT 'company', kpi_id TEXT NOT NULL, kpi_name TEXT NOT NULL, value REAL NOT NULL, target REAL, unit TEXT NOT NULL DEFAULT 'count', snapshot_date TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))`. The POST defaults (`unit='count'`, `department_id='company'`) and nullable `target` mirror `kpi-snapshots/route.ts`.
- **`IF NOT EXISTS` everywhere** — boxes whose live DB already has the table (e.g. a hand-repaired install) are untouched; only the boxes missing it self-heal. Runs on every boot via the existing migration chain, so every dashboard self-creates the table on next deploy.
- **047 is the next free slot** — 046 is `pin_ceo_department_first` (v4.1.8); no collision. The migration runner orders by numeric id, so 047 runs after 046.

### Tests

- New `tests/unit/kpi-snapshots-migration.test.ts` (3 cases) drives a real temp SQLite DB through the full migration chain (incl. 047) and asserts: the table + both indexes exist with the exact consumer column set; the `GET /api/kpi-snapshots` query path (the snapshots + latest queries) returns `{ snapshots: [], latest: [] }` with no SQL error; and the `POST`/seed INSERT column lists round-trip with the POST defaults applied and a nullable `target`.

### QC baseline

QC gate (`scripts/qc-cc.sh`) remains at its documented universal-repo baseline (6 pre-existing failures: 2.1–2.5 `config/departments.json` is the empty per-client template shipped in v4.0.3, and 5.1 a pre-existing `claude-` string in `web-agent/runner.ts`). This change introduces **zero new QC failures**.

## [v4.1.8] - 2026-05-30 - CEO department pinned #1 + universal task-ingest API

Minor release. The Command Center half of the CEO-department + universal task-capture feature. One additive DB migration, one new API route, zero personal/client data — universal across the fleet. Focus View, Live Feed, and the existing task-creation path are unchanged.

### Feature 1 — CEO department pinned to the top of the rail / Kanban

Two independent guarantees keep the CEO department at position #1 of the department list and the cross-department board, labeled by the client's main-agent persona (config-driven, with a safe default):

- **DB guarantee — new idempotent migration `046` `pin_ceo_department_first`.** Re-pins the CEO workspace to `sort_order = 0` (below migration 014's CEO=1) on every boot, keyed on the stable `slug = 'ceo'` (or a case-insensitive `name = 'ceo'` fallback). Safe to re-run; non-fatal on a universal-template install that has no CEO row yet. The `GET /api/workspaces` ordering (`ORDER BY sort_order ASC, name ASC`) — consumed by both the sidebar and the by-department board — therefore surfaces CEO first.
- **Auto-seed fix.** `autoSeedFromDepartmentsJson` now seeds a CEO department at `sort_order = 0` (instead of inheriting the schema default of 1000 and landing last) and honors a department's `slug` field, so `{ id: "dept-ceo", slug: "ceo", name: "<persona>" }` seeds with the stable `ceo` slug.
- **UI guarantee — hoist.** `AgentsSidebar.tsx` and `tasks/by-department/page.tsx` splice any `ceo`/`dept-ceo` (case-insensitive name fallback) department to index 0 on every load, so a drag-reorder that demotes it is cosmetic only — the DB re-pin + UI hoist keep it #1 on the next load.
- **Display decoupled from key.** All ordering/migration/hoist logic keys on the stable slug `ceo`; the `name` is free display text — the client's main-agent persona (e.g. "Candace", "Sir Jordan", "Temperance"). Per-client personalization needs zero code change; only the seed value differs. Safe default: when no CEO row exists, ordering is simply unaffected.

### Feature 2 — Universal task-ingest endpoint `POST /api/tasks/ingest`

The front door for "anywhere the agent is told to do something, it lands on the Kanban":

- **Auth-guarded** — `x-webhook-signature` HMAC-SHA256 over the raw body using `WEBHOOK_SECRET`, the exact scheme `/api/webhooks/agent-completion` already uses (dev-mode skip when the secret is unset).
- **Friendly external shape** — `{ title, description?, priority?, source?, source_ref?, department_slug?, persona?, external_session_id?, idempotency_key? }`.
- **Workspace resolver, never trusts external agent ids** — resolves `workspace_id` from `department_slug`, then `persona`/name, then falls back to the CEO workspace (the CEO agent runs all other departments, so it is the correct catch-all owner). `assigned_agent_id` / `created_by_agent_id` are left **NULL** because they are `.uuid()` + FK columns into `agents` that an external OpenClaw payload cannot satisfy; provenance (source/persona/session/ref) is recorded in the description and the `task_created` event instead.
- **Idempotent on a source id** — a deterministic `[ingest:<idempotency_key|source_ref>]` marker is embedded in the `task_created` event message and deduped before insert, so a Telegram retry or a backfill re-run returns the existing task (200, `deduped: true`) instead of creating a duplicate. No schema column required.
- **Reuses the canonical write path** — both `POST /api/tasks` (UI) and `POST /api/tasks/ingest` now delegate to a shared `createTaskCore()` in `src/lib/tasks.ts` (INSERT + `task_created` event + SOP auto-suggest + persona selection + SSE `task_created` broadcast + outbound `/api/webhooks/task-created` gateway notify), so the two front doors can never drift. Ingested tasks live-update `/tasks/all` over SSE and announce themselves to the OpenClaw COM/CEO agent exactly like UI-created ones.

### Tests

- New `tests/unit/ceo-ordering-ingest.test.ts` (5 cases) drives a real temp SQLite DB through the full migration chain (incl. 046) and asserts: CEO pins to `sort_order = 0` and sorts first despite a persona display name that sorts last; the ingest resolver's department_slug / persona / CEO-fallback query paths; and the idempotency dedupe marker match/miss.

### QC baseline

QC gate (`scripts/qc-cc.sh`) remains at its documented universal-repo baseline (6 pre-existing failures: 2.1–2.5 `config/departments.json` is the empty per-client template shipped in v4.0.3, and 5.1 a pre-existing `claude-` string in `web-agent/runner.ts`). This change introduces **zero new QC failures** — `config/departments.json` is intentionally left empty (populated per-client at build time; never client data in the universal repo).

## [v4.1.7] - 2026-05-30 - Operator Console onboarding walkthrough + per-module vault-write health dots

Patch release. Two universal Operator Console UX features, zero schema changes, zero personal/client data.

### Feature 1 — Onboarding / walkthrough cards

A first-run, re-openable walkthrough overlay that explains every Operator Console sub-module in plain English, one card each (Console, Bridge, Workspace, Studio, Notebook, Goals, Journal, Memory, Research, Call Mode, Web Agent). Written for a non-technical, 60-year-old-friendly reader.

- **First run** auto-opens once; dismissing it persists `bcc-operator-onboarding-seen` in localStorage so it never auto-opens again. (localStorage convention mirrors `bcc-sidebar-collapsed` in `AppShell.tsx`.)
- **Re-open anytime** via a "Show walkthrough" control in the sidebar footer and on the Console home header, plus a "What is this?" help button in every sub-module page header that jumps straight to that module's card.
- **Memory card carries the Mac-vs-VPS note** (resolved server-side from `detectPlatform()`): everything you write flows to the vault and is searchable in Memory; on a **Mac Mini** you can ALSO browse the vault in Obsidian; on a **VPS** there is no Obsidian (not cloud-based) so the Memory page IS your window into the brain.
- **Accessibility:** `role="dialog"` / `aria-modal`, focus moved into the dialog on open, focus trap on Tab/Shift+Tab, focus restored on close, Esc closes, Left/Right arrows move between cards, ≥44px tap targets, ≥16px text, visible focus rings, status conveyed by icon + text (never color alone). Overlay pattern mirrors `CommandPalette.tsx`.

### Feature 2 — Per-module vault-write health indicator

A small status dot + accessible label per persisting module (Goals, Journal, Notebook, Studio, Research) showing whether the module is actually persisting AND whether its **last write reached the operator vault**:

- **green (`live`)** = a vault write is confirmed; **amber (`busy`)** = saved to the DB but the vault mirror is unconfirmed; **red (`offline`)** = DB error or the last vault write failed; **grey (`unknown`)** = nothing determinable yet. Unknown is **never** shown as green — honest by contract.
- New read-only `GET /api/operator/health` (and `?module=<id>`) returns each module's DB + vault evidence. It never throws and never fabricates a green. Data source: `src/lib/operator/module-health.ts` reuses `vaultRoot()` from `src/lib/platform.ts` (so it is correct on both Mac and VPS), reads a `<vault>/<module>/.health.json` sidecar for Goals/Journal, discovers the newest file on disk for Studio (`studio/.jobs/*.json`) and Research (`research/**/*.md`), and reports Notebook's vault dimension as not-applicable (DB-only by design). Behind the same Cloudflare Access + `MC_API_TOKEN` middleware as every other `/api/*` route.
- **Closes a real gap:** the Goals/Journal route handlers previously called `void writeVaultMirror()` / `void writeJournalMirror()` and **discarded** the returned path — the only success signal. They now record the mirror outcome via `trackVaultMirror()` so the dot reflects reality.
- Dots render on the Console home tiles and each sub-module page header. Dot vocabulary matches `SystemStatusPill.tsx`'s `STATUS_STYLES`.

### Changed files

- New: `src/lib/operator/module-health.ts`, `src/app/api/operator/health/route.ts`, `src/components/operator/OperatorOnboarding.tsx`, `src/components/operator/OperatorHelpButton.tsx`, `src/components/operator/onboarding-content.ts`, `src/components/operator/ModuleHealthDot.tsx`, `tests/unit/module-health.test.ts`.
- Changed: `src/app/operator/layout.tsx` (mount overlay + pass platform), `src/components/OperatorSidebar.tsx` (re-open control), `src/app/operator/page.tsx` (per-tile help + health dots), `src/app/operator/{goals,journal,memory,studio,research,bridge,web-agent}/page.tsx` (page-header help + dots), `src/components/operator/{NotebookList,WorkspaceView}.tsx` (header help + dot), `src/app/api/operator/goals/route.ts`, `src/app/api/operator/goals/[id]/route.ts`, `src/app/api/operator/journal/route.ts`, `src/app/api/operator/journal/[id]/route.ts` (record mirror outcome).

### Risk: low

- No DB schema change, no migration, no provider calls. The health route is read-only and degrades to `unknown` rather than throwing. The mirror-result recording preserves the existing fire-and-forget, non-blocking behavior of the Goals/Journal POST/PATCH handlers. UI additions are additive.

## [v4.1.6] - 2026-05-30 - Studio providers: boot-time registry seed (no more week-long "No providers configured")

Patch release. Completes the v4.1.4 Studio provider-discovery fix. Even after v4.1.4 wired env-based auto-discovery, the `model_registry` table that the Studio tabs read was still only written by the **weekly** Sunday-03:00 refresh cron, never on boot. On a fresh deploy (verified live on Evelyn: `model_registry` = 0 rows) every Studio tab showed **"No providers configured"** for up to a week — even with KIE / OpenAI / Fish / Gemini keys present — until that cron ticked or someone manually hit `POST /api/cron/refresh-models`.

### Boot + lazy seed (offline, idempotent, single-flight)

- **Boot seed.** `instrumentation.register()` now fires a non-blocking, never-throw seed **after** env hydration, **only if** the registry is empty (`seedRegistryIfEmpty()` in `src/lib/studio/generators.ts`). It uses the **OFFLINE** provider catalogs in `PROVIDER_DISCOVERY` (fal / replicate / kie / fish-audio / openai / google / …), so it needs **no network** — the registry populates the moment the worker boots. Opt out with `DISABLE_REGISTRY_BOOT_SEED=1`.
- **Lazy seed (unchanged path, now shares the guard).** `availableModels()` still seeds on the first Studio read when a capability returns 0 rows.
- **Single-flight.** Both paths funnel through the exported `ensureRegistrySeeded()`, guarded by a process-wide `globalThis` boolean so the seed runs at most once per worker no matter how many reads (or the boot hook) race it. The seed body is fully synchronous (sync hydrate → sync discover → sync `bulkUpsertModels`), so there is no awaited boundary inside the critical section. Idempotent: discovered rows upsert by `model_id`, so the later weekly refresh updates them in place.

### KIE fixes (carried + regression-locked)

- **Env name.** `hasApiKey()` and the `callKie()` generator accept `KIE_API_KEY` (the name the connector + real env use), keeping `KIEAI_API_KEY` / `KIE_AI_API_KEY` as aliases.
- **Capability tags.** `src/lib/model-providers/kie.ts` tags Veo / Runway / Kling as `video_generation` and Suno as `audio_generation` (never the old `streaming` / `audio_input`), so they match the Studio `CAPABILITY_FOR_KIND` map and appear under the Video / Audio tabs. At least one provider always emits `video_generation`.

### Tests

- New `tests/unit/studio-registry-seed.test.ts` drives the seed end-to-end against a throwaway temp-file SQLite DB: `discoverRegistryRows() → bulkUpsertModels() → listModels({capability})`. Asserts an offline seed with `KIE_API_KEY` + `OPENAI_API_KEY` + `FISH_AUDIO_API_KEY` leaves ≥1 active **image**, **video**, and **audio** row, and that re-seeding is idempotent (no duplicate `model_ids`).
- New `tests/unit/kie-capabilities.test.ts` locks the KIE capability tags via the connector's offline curated fallback (no `streaming` / `audio_input`).

Universal — no client-specific data. After deploy a box with media keys lights up all three Studio tabs immediately instead of waiting for the weekly cron.

## [v4.1.5] - 2026-05-30 - Operator Console Research: provider-agnostic (Perplexity / OpenAI / Ollama / xAI)

Patch release. The Operator Console **Research** sub-module (`/operator/research`) was hard-wired to a single provider — xAI Grok Live Search via `X_AI_API_KEY`. On any client box without an xAI key it was effectively dead: the nav tile said "Soon", the page promised "xAI Grok", and a query 502'd with "X_AI_API_KEY is not set" — even when the box had a perfectly good search key (OpenAI / Ollama Cloud / Perplexity) sitting in its environment. Research is now **provider-agnostic and auto-discovered**, the mirror of the v4.1.4 Studio fix.

### Provider auto-discovery + preference order

Research auto-discovers which search provider the box has a key for and selects **one**, in a fixed preference order:

> **PERPLEXITY > OPENAI > OLLAMA (cloud) > XAI**

Discovery reads `process.env` (authoritative; on a VPS already loaded from the host `/docker/<proj>/.env`) and, for any key absent there, probes the OpenClaw secret files (host `/docker/<proj>/.env` via `OPENCLAW_PROJECT_DIR`, `~/.openclaw/.env`, `~/.openclaw/secrets/.env`, `openclaw.json` `env`/`env.vars`) — reusing the v4.1.4 Studio hydrator's `parseDotEnv` / `extractOpenclawEnv` primitives so there is exactly one OpenClaw secret-reader contract. A provider is "available" ONLY when one of its candidate env vars is actually present — **keys are never fabricated**.

| Provider (first present wins) | Env var (+ alias) | Default model | How it's called |
|---|---|---|---|
| Perplexity | `PERPLEXITY_API_KEY` (`PPLX_API_KEY`) | `sonar-pro` | `POST api.perplexity.ai/chat/completions` (OpenAI-compatible); online "sonar" models search the live web; sources in `citations[]`. |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-search-preview` | `POST api.openai.com/v1/chat/completions` with a web-search model; sources in `message.annotations[].url_citation`. |
| Ollama Cloud | `OLLAMA_CLOUD_API_KEY` (`OLLAMA_API_KEY`) | `gpt-oss:120b` | `POST ollama.com/api/v1/chat/completions` with the hosted `web_search` tool; tool results carry source URLs. |
| xAI Grok | `X_AI_API_KEY` (`XAI_API_KEY`) | `grok-4-fast` | `POST api.x.ai/v1/chat/completions` with `search_parameters.mode=on` (Live Search over X + web); sources in `citations[]`. |

### SOON → live + honest empty-state

- **If a search key exists, the module is LIVE for that client** — the `Soon` placeholder badge is dropped from the Research nav item, the page shows a "Live via `<Provider>`" pill, and Shallow/Deep both work.
- **If NO search key exists, the module shows an honest empty-state** — "Add a Perplexity, OpenAI, Ollama, or xAI key to enable Research" with the exact env vars listed — never a dead search box and never a 502. The `POST /search` endpoint returns `{ empty_state: true }` (HTTP 200) in this case.

### Added

- **`src/lib/research/provider-discovery.ts`** — `RESEARCH_PROVIDERS` (the single preference-ordered provider list), `selectResearchProvider()` (picks the highest-preference provider whose key is present, else `null`), `researchAvailability()` (per-provider presence report backing the UI), and `hydrateResearchEnv()` (delegates the OpenClaw secret-file read to the Studio hydrator primitives).
- **`src/lib/research/providers.ts`** — one normalizing `runResearch(slug, …)` adapter per provider. Each documents its request shape + scope, honors a per-provider fixture env var for offline CI (`PERPLEXITY_FIXTURE_JSON_PATH`, `OPENAI_FIXTURE_JSON_PATH`, `OLLAMA_FIXTURE_JSON_PATH`, `XAI_FIXTURE_JSON_PATH` / legacy `X_AI_FIXTURE_JSON_PATH`), applies the shared shallow/deep breadth+timeout mapping, and never fabricates results.
- **`GET /api/operator/research/availability`** — reports `available` + the selected provider + the per-provider presence map + the `enable_env_vars` hint.
- **`tests/unit/research-provider-discovery.test.ts`** — unit test for provider selection given a fake env: preference order (Perplexity > OpenAI > Ollama > xAI), alternate spellings, empty-env honest empty-state, and the availability report.

### Changed

- **`src/app/api/operator/research/search/route.ts`** — now selects the provider via discovery and routes through the adapters; the model is resolved from `model_registry` for the selected provider when present, else the provider's documented default. Returns the honest empty-state when no key exists. Vault mirror + `research_searches` save are unchanged (still feed Memory + the All Searches bucket).
- **`src/app/operator/research/page.tsx`** — provider-neutral copy, probes availability on mount, renders the "Live via `<Provider>`" pill or the honest empty-state.
- **`src/components/operator/ResearchSearch.tsx`** — provider-neutral placeholder; surfaces the empty-state message instead of routing to an empty result.
- **`src/components/OperatorSidebar.tsx`** — dropped `placeholder: true` from the Research nav item (no more `Soon` badge).
- **`.env.example`** — documented `PERPLEXITY_API_KEY` and the provider preference order for Research.

### Per-box deploy

- **VPS (Hostinger Docker):** add the chosen key to host `/docker/<proj>/.env` (e.g. `PERPLEXITY_API_KEY=...`), then `docker compose up -d --force-recreate` (a plain `restart` does NOT reload `env_file`).
- **Mac:** add the key to `~/.openclaw/.env` (or `~/.openclaw/secrets/.env`), then restart the dashboard process. No DB migration; no registry seed required — the provider's default model keeps it live on a fresh box.

## [v4.1.4] - 2026-05-30 - Operator Console Studio: env-based provider auto-discovery (Image / Video / Audio)

Patch release. The Operator Console **Studio** showed "No providers configured" on every tab even on boxes with valid media keys (KIE / OpenAI / Fal / Gemini / Fish), for two compounding reasons now both fixed:

1. **(Primary) The `model_registry` table was empty on fresh deploys.** It is only ever written by the weekly Sunday-03:00 refresh cron, so a freshly deployed/restarted container had zero rows — and Studio reads the registry by capability tag — until the next Sunday tick (or a manual `POST /api/cron/refresh-models`). Studio now **lazily seeds the registry from env auto-discovery on first read** (`availableModels()`), so it lights up the moment the keys exist. Idempotent: discovered rows upsert by `model_id`, so the later weekly refresh just updates them.
2. **(Latent) KIE env-var mismatch + wrong capability tags.** Studio's key gate hard-coded `KIE_AI_API_KEY` while the connector + every box use `KIE_API_KEY`; and the Kie connector tagged Veo/Runway `streaming` and Suno `audio_input`, so the Video/Audio tabs stayed empty for Kie regardless of keys. Both fixed (Veo/Runway → `video_generation`, Suno → `audio_generation`; gate accepts `KIE_API_KEY` + legacy spellings).

### Added

- **`src/lib/studio/provider-discovery.ts`** — the new, data-driven discovery surface:
  - **`PROVIDER_DISCOVERY`** — the single PROVIDER → CAPABILITY map (one place to add a provider). Each entry maps candidate env-var names → a provider slug → its image/video/audio rows (each with a default model + the resolved `api_key_env` + a `generates` flag). A provider contributes rows ONLY when one of its keys is actually present — never fabricates a key.
  - **`hydrateProviderEnvFromOpenClaw()`** — best-effort, never-throws env hydration. `process.env` (container/host env, loaded from host `/docker/<proj>/.env` on the VPS) is authoritative and never overwritten; for keys absent from `process.env` it additionally probes, first-hit-wins, the OpenClaw secret files: host `/docker/<proj>/.env` (via `OPENCLAW_PROJECT_DIR`), `~/.openclaw/.env`, `~/.openclaw/secrets/.env`, and `openclaw.json` `env` / `env.vars` (path via `platform.ts`). Reuses the F52 defensive multi-root reader idiom.
  - **`discoverRegistryRows()` / `discoveryReport()` / `parseDotEnv()` / `extractOpenclawEnv()`** helpers.
- **`tests/unit/provider-discovery.test.ts`** + **`npm run test:unit`** — a `tsx`-runnable, no-network/no-DB unit test for the env→provider map. Core assertion: a fake env with `KIE_API_KEY` + `OPENAI_API_KEY` yields image + video + audio rows.

### Changed

- **`src/lib/studio/generators.ts`** — `availableModels()` lazily seeds the registry from discovery when a capability has zero rows; `hasApiKey()` env map aligned to the connector contract (KIE/Fal accept both spellings; Luma/Stability/Runway added); `callKie()` reads `KIE_API_KEY`; unwired-provider error is now an honest "registry-only (coming soon)" message instead of a silent break.
- **`src/lib/model-providers/kie.ts`** — Veo/Runway → `video_generation`, Suno → `audio_generation` (curated list + `inferCapabilities`).
- **`instrumentation.ts`** — hydrates provider env from the OpenClaw files on boot (before the cron + before any read), so both the Studio gate and the weekly refresh see file-sourced keys.
- **`src/components/operator/StudioToolbar.tsx` / `StudioCanvas.tsx`** — empty states now give a precise per-capability "add one of: `<KEYS>`" hint and document the discovery sources, instead of a blank "No providers configured".

### Provider → capability map shipped

| Key (first present wins) | Provider | image | video | audio |
|---|---|---|---|---|
| `KIE_API_KEY` (+ `KIEAI_API_KEY`/`KIE_AI_API_KEY`) | Kie.ai | ✅ generates | ✅ generates | — |
| `OPENAI_API_KEY` | OpenAI | ✅ generates | — | ⚠ registry-only |
| `FAL_KEY` (+ `FAL_API_KEY`) | Fal.ai | ✅ generates | ✅ generates | ✅ generates |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Google | ⚠ registry-only | ⚠ registry-only | — |
| `FISH_AUDIO_API_KEY` | Fish Audio | — | — | ⚠ registry-only |
| `ELEVENLABS_API_KEY` | ElevenLabs | — | — | ✅ generates |
| `REPLICATE_API_TOKEN` (+ `REPLICATE_API_KEY`) | Replicate | ✅ generates | — | — |
| `LUMA_API_KEY` | Luma | — | ⚠ registry-only | — |
| `STABILITY_API_KEY` | Stability AI | ⚠ registry-only | — | — |
| `RUNWAY_API_KEY` | Runway | — | ⚠ registry-only | — |

"generates" = a real `call*` path is wired in `generators.ts` today; "registry-only" = selectable but the generate path is "coming soon" (honest error on submit, never a silent break).

### Risk: low

- Additive: one new lib module + one unit test; surgical edits to Studio gate/seed, the Kie capability tags, instrumentation, and two Studio components' empty-state copy. **No DB schema change, no migration** (uses the existing `model_registry` table + `bulkUpsertModels`). Discovery is best-effort and never throws; an absent key/source emits nothing. No real keys or client data in code.

## [v4.1.3] - 2026-05-30 - OpenClaw Bridge connect-failure fix: stable device identity, pairing bootstrap, VPS-aware CLI pills

Patch release. Fixes the Operator Console → Bridge → OpenClaw pill failing to connect on VPS Docker deploys (it showed "OpenClaw Gateway unavailable" / "Not connected to OpenClaw Gateway"). Root cause was two compounding bugs plus a UI defect; all three are fixed and the connect path now reaches an `operator.admin` gateway session without manual device surgery on every redeploy.

### Root cause

1. **Device-identity drift (VPS-specific).** The ed25519 device identity was stored at `~/.mission-control/identity/device.json` via `os.homedir()`, which on the Hostinger VPS Docker container is NOT under the `/data` persistent volume. Every `docker compose up -d --force-recreate` wiped it, `loadOrCreateDeviceIdentity` silently minted a NEW keypair → new `deviceId` → the gateway saw an unapproved device → the `connect` handshake was rejected → `connected/authenticated` never flipped true.
2. **Missing pairing bootstrap.** Nothing in the app ever registered or surfaced the device for approval; an operator had to manually `openclaw devices approve` on the gateway, and bug #1 destroyed that approval on the next redeploy.
3. **Bridge pill strip not platform-aware (UI defect).** All seven pills (six Mac-desktop CLIs + OpenClaw) rendered unconditionally even on a VPS where the Mac CLIs are not installed.

### Fixed

- **(A) Stable device identity** — `src/lib/platform.ts` adds `deviceIdentityDir()` / `legacyDeviceIdentityDir()`; the identity now persists at `/data/.openclaw/mission-control/identity/device.json` on VPS (survives force-recreate) and `~/.mission-control/identity/device.json` on Mac, overridable via `BCC_DEVICE_IDENTITY_DIR`. `src/lib/openclaw/device-identity.ts` resolves the path at call time, performs a one-time **forward migration** of a pre-existing legacy identity so an already-paired box keeps its `deviceId`, and **throws instead of silently regenerating** when an existing file is corrupt (never orphans an approved device).
- **(B) Reliable pairing + connect** — `instrumentation.ts` fires a non-blocking connect on boot so the gateway records this device as a **pending pairing request immediately after deploy** (opt out with `DISABLE_BRIDGE_BOOTSTRAP=1`). `OPENCLAW_GATEWAY_URL` keeps the `ws://127.0.0.1:18789` default when unset and reads the env var when set. `GET /api/openclaw/status` now returns `connected`, `device_id`, `pairing_pending`, and a `remediation` string with the exact `openclaw devices list` / `openclaw devices approve <requestId>` commands. The Bridge send route surfaces the same actionable message instead of a raw error. New runbook `docs/OPENCLAW_BRIDGE_PAIRING.md` documents the per-box deploy + pairing procedure.
- **(C) VPS-aware CLI pills** — `BridgeAgent` gains an optional `platforms` tag; the six Mac-desktop CLIs are `['mac-mini']`-only, OpenClaw is unrestricted. `visibleBridgeAgents(platform)` + `resolveInstallPlatform()` (honoring a new `BCC_INSTALL_TYPE=vps|mac` flag, default auto-detect) compute the visible set **server-side** in `src/app/operator/bridge/page.tsx` and pass it through `BridgeChat` → `AgentSelector`. On a VPS the strip shows only OpenClaw; Mac installs are unchanged (all seven).

### Changed files

- `src/lib/platform.ts`, `src/lib/openclaw/device-identity.ts`, `src/lib/openclaw/client.ts`, `src/app/api/openclaw/status/route.ts`, `src/app/api/operator/bridge/send/route.ts`, `instrumentation.ts`, `src/lib/bridge/agents.ts`, `src/components/operator/AgentSelector.tsx`, `src/components/operator/BridgeChat.tsx`, `src/app/operator/bridge/page.tsx`, `ecosystem.config.cjs`, `.env.example`.
- New: `docs/OPENCLAW_BRIDGE_PAIRING.md`, `tests/unit/bridge-platform.test.ts`, `tests/unit/device-identity.test.ts`, `npm run test:unit` script.

### Risk: low

- No DB schema change, no migration, no change to departments / personas / any other route. The only UI behavior change is the VPS pill filter (Mac is byte-for-byte unchanged). The device-identity path change is additive with a forward migration, so a box already paired on the legacy path keeps working.

## [v4.1.2] - 2026-05-30 - Single-department Focus View: filter by workspace_id + scoped focus rail

Patch release. The single-department Focus View (`/workspace/[slug]`) could open empty for a department that actually had tasks, and clicking a department in the `/tasks/all` left rail did nothing. Both are fixed, and the Focus View left rail is scoped down to a clean focused context.

### Root cause

The Focus View fetched + filtered tasks by the **free-text `tasks.department` slug** (`/api/tasks?department=<slug>` plus a client-side `task.department === slug` re-filter). That column is unreliable: the task-create flow (`TaskModal`) only ever writes `workspace_id` and leaves `department` NULL; the department router stamps the display **name** (e.g. `"Audio Production"`) rather than the slug; and older seed scripts used short slugs (`audio`, `appdev`). The only relationship the schema enforces is `tasks.workspace_id REFERENCES workspaces(id)`. So a department whose tasks carried a NULL / name / short-slug value silently matched zero rows — an empty board for a department that had work.

### Changed

- **`src/app/workspace/[slug]/page.tsx`** — Focus View now fetches tasks by `?workspace_id=<workspace.id>` (the enforced FK) instead of `?department=<slug>`, on both the initial load and the 60s fallback poll. The CEO / default workspace still fetches all tasks. The left rail now renders in focus mode (`focusSlug`).
- **`src/components/MissionQueue.tsx`** — when a `workspaceId` is provided (Focus View), the board filters by `task.workspace_id === workspaceId` for both the column contents and the "By Total Tasks" count. The cross-department `/tasks/all` board (no `workspaceId`) keeps the legacy department-slug selection so the sidebar pill still works there.
- **`src/components/AgentsSidebar.tsx`** — added `navigateOnSelect` (used by `/tasks/all`: a department click now navigates to `/workspace/<slug>` deterministically instead of mutating an in-place filter the board ignored) and `focusSlug` (renders a minimal focused rail — a "Back to All Departments" link + the single department in focus — instead of the full all-departments list).
- **`src/app/tasks/all/page.tsx`** — passes `navigateOnSelect` to the rail.
- **`README.md`** — documents `/tasks/all`, `/tasks/by-department`, and the `/workspace/[slug]` Focus View (workspace_id scoping + collapsed focus rail).

### Reconciled entry points

All three ways into a single department now land on the same correct, filtered Focus View (`/workspace/<slug>`): the `/tasks/all` left-rail click, the `/tasks/by-department` "Open Department" card, and a direct `/workspace/<slug>` URL. `/tasks/all` (full board) and the picker are unchanged otherwise.

### Risk: low

- No DB schema change, no migration, no API change (the `?workspace_id=` filter already existed in `/api/tasks`). Three component/page edits + README. The v4.1.1 Live Feed collapsible rail is preserved and untouched.

## [v4.1.1] - 2026-05-30 - Tasks board Live Feed rail: collapsible + resizable (stop crowding the Kanban)

Patch release. The `/tasks/all` Live Feed right rail previously rendered always-expanded at a fixed `w-80` (its in-memory collapse reset on every reload), permanently stealing width from the Kanban so task cards/changelogs were hard to see. The rail is now hidden by default with a floating show-pill, user-resizable when open, and persists its state — giving the board full width unless the user explicitly opens the feed.

### Changed

- **`src/components/LiveFeed.tsx`** — rewrote the rail's container/visibility/sizing layer (the ALL/TASKS/AGENTS tabs, event filtering, and `EventItem` rendering are unchanged):
  - **Hidden by default** so the board uses the FULL width. Open/closed state persists to `localStorage` key `cc.livefeed.open` (mirrors the existing `AppShell` `bcc-`-style mount-effect read / handler-write pattern), so the user's choice sticks across reloads and navigation.
  - **Floating show-pill** when collapsed: a top-right `MessagesSquare` + animated live-dot + visible "Live Feed" label button (`aria-label="Show Live Feed"`, `aria-expanded={false}`, ≥44px tap target, `focus-visible` ring). Clicking/Enter/Space opens the rail. When open, the existing `>` chevron (and an `X` on mobile) collapses it again.
  - **Draggable resize** (desktop/`lg`+): a `role="separator"` splitter on the rail's left edge, `cursor-col-resize`, Pointer Events (mouse + touch), arrow-key resize for a11y. Width clamps to min 300px / max 40% of the viewport so the board can never be crushed, and persists to `localStorage` key `cc.livefeed.width`.
  - **Responsive**: below `lg` (1024px) the open rail renders as a framer-motion **overlay drawer** (88vw, `max-w-sm`) with a tap-to-close scrim instead of a push-panel, so it never squeezes the board on mobile. On `lg`+ it is a push-panel that resizes the board.
  - **Accessibility**: `role="complementary"` + `aria-label` on the rail, `aria-expanded` on the open/close controls, `aria-valuenow/aria-valuemin` on the resize separator, icon+label (never color-alone), `focus-visible` rings, native `<button>` keyboard activation. Body font unchanged.

### Risk: low

- Single-file change to one component's container/visibility/sizing. No DB schema change, no migration, no API change, no change to the Kanban board, departments, or any other route. The `/tasks/all` page composition is untouched — the collapsed pill is `position: fixed` (out of flow) so the board reclaims full width with no page edit.

## [v4.1.0] - 2026-05-30 - Feature 52: Conversational-AI Live Analytics Dashboard

Minor release adding a NEW card + route for conversational-AI analytics, distinct from the existing `/ceo-board` (tasks/agents/KPIs). Reuses the `/ceo-board` redesign component library + the `SystemPulseSection` fetch pattern. No schema changes; no modification to `/ceo-board`.

### Added

- **Home card (7th `EntryCard`)** in `src/app/page.tsx` — fuchsia→pink→rose, `MessagesSquare` icon, routes to `/conversational-ai`.
- **Route** `src/app/conversational-ai/page.tsx` — Layer-1/Layer-2 unified dashboard with a 20s real-time interview-completion poll.
- **API routes** (`force-dynamic`): `src/app/api/conversational-ai/{status,metrics,enriched}/route.ts`. All return graceful 200s; never crash, never fabricate numbers.
- **Libraries**: `src/lib/conversational-ai/sources.ts` (defensive Round-3 JSONL/dir/markdown readers + candidate-root discovery + `ROUND3_DATA_CONTRACT`), `interview-state.ts` (3-signal Layer-2 gate, defaults NOT complete), `metrics.ts` (11 Layer-1 metric aggregators).
- **Components** under `src/components/conversational-ai/`: ChannelVolumeChart, ConversationsTimeline, ConvAiKpiStrip, SentimentTrend, TopObjections, PixelFunnel, InterviewBanner, Layer2Section, EmptyState.
- **Layer 1 (universal, no interview):** channel volume (SMS/Email/FB DM/FB Comments/IG DM/LinkedIn/Live Chat/All-in-One), conversations per day, sentiment trend, escalation rate, top objections, KB hit rate, discount redemptions, follow-up performance, bot/spam volume, quiet-hours impact, pixel funnel.
- **Layer 2 (unlocks on interview completion):** business-specific KPIs, journey-template funnel (re-contextualized pixel funnel), industry benchmarks, recommended-actions panel derived from Layer-1 signals. History preserved, never reset.
- **Scope-gated deploy** `scripts/conversational-ai/deploy-dashboard.sh` (`--precheck` verifies the F49 CF scopes — Pages:Edit + Workers Scripts:Edit + Workers Routes:Edit — and refuses to deploy if missing, without touching Cloudflare).
- **Card README** `src/app/conversational-ai/README.md` documenting the data contract, merge logic, accessibility, deploy gating, and MVP-vs-follow-up.

### Accessibility

- WCAG 2.1 AA target: ≥16px body, semantic h1/h2/h3, never color-alone (icon+label on every state), ≥44px tap targets, `role="status"` empty-states, 3-clicks-max, mobile single-column.

### Risk: low

- Purely additive: new card, route, APIs, libs, components, script. No DB schema change, no migration, no change to `/ceo-board` or any existing route/API.

## [v4.0.3] - 2026-05-27 - Empty department template + build-state sync script

Patch release: stop shipping a stale 17-row department template; sync the dashboard from the client's real Zero Human Company build-state.

### Fixed / Added
- config/departments.json now ships EMPTY ([]). autoSeedFromDepartmentsJson() in migrations.ts already returns early on an empty array, so a fresh dashboard seeds nothing until the client's real build is synced. The previous non-empty 17-row template always won, so every client dashboard showed the same 17 departments regardless of their interview.
- New scripts/sync-departments-from-build-state.py: regenerates config/departments.json from the client's real ZHC departments.json + .workforce-build-state.json and re-seeds the workspaces table. Invoked by Skill 32's run-full-install.sh PHASE 6c (onboarding repos v10.14.11 / v10.15.11) on every install and resume. Idempotent.

## [v4.0.2] - 2026-05-25 - 8-bug patch (hydration race, frozen timestamps, missing route, port leak, empty states, migration runner, persona log validation)

Patch release closing 8 latent bugs surfaced during v4.0.1 fleet rollout.

### Fixed
- Bug 1: Migration 034 runs outside wrapper transaction (new useOuterTransaction flag)
- Bug 2: Closed by Bug 8 (force-dynamic on runtime routes prevents build-time prerender cache)
- Bug 3: persona_selection_log refuses inserts when task_id is null/empty/sentinel + migration 045 cleanup
- Bug 4: Header.tsx mount-gates live clock to prevent React hydration mismatch
- Bug 5: /settings/company route implemented (wraps CompanySettingsForm)
- Bug 6: Verbose empty-state copy for Studio, Journal, Memory
- Bug 7: ecosystem.config.cjs template hardcodes port to prevent Hostinger PORT env leak
- Bug 8: All runtime-state API routes now declare `export const dynamic = 'force-dynamic'`

### Added
- Migration 045 cleanup_persona_log_orphans (additive, no schema change)
- Regression test for migration 034 (tests/integration/migration-034.spec.ts)

### Risk: low
- All fixes are additive or scoped to the v4.0.1-introduced surface
- Migration 045 is a one-time cleanup of orphan rows
- No breaking changes to API contracts or DB schema beyond the additive cleanup

## [v4.0.1] - 2026-05-25 - Post-v4.0 fix pass (17 fixes, multi-client rollout-ready)

Closes the v4.0.1 fix pass per BLACKCEO-V4-POST-BUILD-FIXES.md. 17 fixes across UI, TTS providers, cron, model registry, infrastructure, and docs. No breaking schema changes (migration 044 is additive). Ready for multi-client rollout to existing v4.0 deployments.

### Added

- **Operator Console card on the home screen** (5th of 6 cards). Terminal icon, cyan-sky-blue gradient, routes to `/operator`.
- **Global Operator Console nav link in the Header** so the console is reachable from every non-home page.
- **Global Cmd+K Command Palette** mounted at the root layout. Works on every page now, not just `/operator`.
- **Fish Audio TTS provider** (`fish_audio`) wired into `/api/operator/tts`. Streams MP3 via `https://api.fish.audio/v1/tts` with bearer auth. Falls through on 401/403/429/5xx.
- **xAI / Grok TTS provider** (`xai`) wired into `/api/operator/tts`. POST `https://api.x.ai/v1/audio/speech` (OpenAI-compatible). Marks the provider session-disabled on 403/404 (plan does not include voice).
- **node-cron weekly model refresh scheduler.** `instrumentation.ts` calls `registerCronJobs()` on app boot. Jobs: model refresh Sunday 03:00, usage refresh every 6h, memory index rebuild hourly.
- **`/api/cron/register` (GET)** lists every registered cron job with next-run timestamps.
- **`/api/cron/refresh-models` (POST + GET)** manually triggers a registry refresh. Optional `CRON_SECRET` bearer auth.
- **🤖 Model pill on task cards** (`MissionQueue.tsx`) alongside the existing 🧠 persona pill. Tooltip shows full name + provider + cost-per-million. Click navigates to `/settings/intelligence?focus={model_id}`.
- **Migration 044 `add_task_model_id`** adds nullable `tasks.model_id TEXT` column + index. FK enforced at the app layer (SQLite limitation on `ALTER TABLE`).
- **Three new provider connectors**: `ollama-local` (localhost:11434, free pricing), `xiaomi` (MiMo V2 Pro, manual catalog), `fish-audio` (registry side, audio_generation capability).
- **xAI provider label renamed to "xAI (Grok)"** in filter chips + model cards. Internal slug stays `xai`.
- **Cloudflare Access setup script** at `scripts/cloudflare/setup-access-app.sh` (251 lines, idempotent). Creates One-Time PIN IdP, Access App for a subdomain, email allow policy, 336h session.
- **5 new docs files** (832 lines total): `docs/CLOUDFLARE_ACCESS_SETUP.md`, `docs/OPERATOR_CONSOLE_GUIDE.md`, `docs/PLATFORM_DETECTION.md`, `docs/MULTI_CLIENT_ROLLOUT.md`, `docs/ENV_FILE_PERSISTENCE.md`, `docs/MODEL_CAPABILITIES.md`.
- **Three new system-status probes**: CLI install registry, Cloudflare Tunnel (pm2 jlist on Mac, systemctl on VPS Docker), Cloudflare Access (30s sliding-window header observation). All wired into `/api/system/status`.
- **`/api/system/bootstrap` SSE endpoint** + "Re-run bootstrap" button in `SystemStatusDrawer.tsx`. Streams stdout/stderr live, requires MC_API_TOKEN bearer.

### Fixed

- **P0-1**: Operator Console missing from home screen. Now the 5th card.
- **P0-2**: No global nav to Operator Console. Header link added.
- **P0-3**: Cmd+K only mounted inside `/operator`. Now global at root layout.
- **P0-4**: Fish Audio TTS skeleton. Real implementation shipped.
- **P0-5**: xAI / Grok TTS skeleton. Real implementation shipped.
- **P0-6**: node-cron not installed. Installed + scheduler + 3 jobs registered at boot.
- **P0-7**: Model pill missing from task cards. Added with tooltip + deep-link.
- **P0-8**: Missing connectors (ollama-local, xiaomi, fish-audio). Shipped.
- **P0-9**: xAI label readability. Now "xAI (Grok)".
- **P1-10**: Cloudflare Access setup script missing. Idempotent script + README.
- **P1-11**: Five docs files missing. All written (832 lines).
- **P1-12**: CLI + CF Tunnel + CF Access probes missing. Shipped + wired into `/api/system/status`.
- **P1-13**: `/api/system/bootstrap` endpoint missing. SSE endpoint + drawer button.
- **P1-14**: Replicate provider keep/remove. Decision: KEEP. Documented in BUILD-NOTES.md.
- **P2-15**: Capability vocab grouped into 4 chip categories (Input modalities / Output modalities / Capabilities / Other).
- **P2-16**: `@ts-expect-error` count target 75% reduction. Final count: 0 (Depth 3 Track A had already removed all 4 baseline guards).
- **P2-17**: BUILD-NOTES.md consolidation. "Outstanding work" section at top, 0 items pending.

### Migrations

- **044** `add_task_model_id` — adds nullable `tasks.model_id TEXT` + `idx_tasks_model_id`. FK enforced at app layer.

### Dependencies added

- `node-cron@^4.2.1` + `@types/node-cron@^3.0.11`

### Decisions

- **6 home screen cards** (was 5). Operator Console is the 5th. Company Settings is the 6th.
- **Replicate provider stays.** Long-tail OSS models not on Fal/KIE, near-zero maintenance cost, useful provider-failover headroom.
- **xAI label reads "xAI (Grok)"** for client recognition. Slug remains `xai`.
- **Multi-bot Telegram via `channels.telegram.accounts`** (per OpenClaw docs). Replaced the Python bridge daemon workaround. Slash commands (/models, /memory, /tasks) work natively now.

### Risk: low

- Additive migration (044). No table renames, no destructive changes.
- All new providers/probes/endpoints are opt-in via env vars.
- Existing `/api/settings/intelligence` shape preserved.
- The home-screen layout went from 5 to 6 cards, which is a visible change.

### Deploy checklist

1. `git pull && npm install && npm rebuild better-sqlite3`
2. Migration 044 auto-applies on next boot.
3. Verify `/api/health` shows migration 044 applied.
4. Verify `/api/system/status` includes new `cli`, `cloudflare_tunnel`, `cloudflare_access` keys.
5. Verify `/operator` is reachable from the Operator Console card AND the Header link.
6. (Optional) Run `scripts/cloudflare/setup-access-app.sh <subdomain> <operator-email>` to wire CF Access for a fresh deployment.
7. (Optional) Set new env vars: `FISH_AUDIO_API_KEY`, `FISH_AUDIO_VOICE_ID`, `X_AI_VOICE_MODEL`, `X_AI_VOICE`, `OLLAMA_LOCAL_HOST`, `XIAOMI_API_KEY`, `CRON_SECRET`.

---

## [v4.0.0] - 2026-05-25 - Operator Console, dynamic model registry, white-label release

Closes the v4.0 build: a from-scratch Operator Console with 10 sub-modules, a fully dynamic provider/model registry replacing the hardcoded AVAILABLE_MODELS array, a System Status Panel, platform abstraction, Cloudflare Access + MC_API_TOKEN middleware, a Cmd+K palette, and a white-label cleanup pass. The dashboard now ships with first-class Research (xAI/Grok Live Search), half-duplex Call Mode, and a Web Agent powered by Anthropic Computer Use.

### Added

- **Operator Console (10 sub-modules)** at `src/app/operator/` - Bridge, Workspace, Studio, Notebook, Goals, Journal, Memory, Research, Call, Web Agent, plus the operator landing tile board.
- **Dynamic model registry** at `src/lib/model-registry.ts` + `src/lib/model-providers/` covering 13 providers (Anthropic, OpenAI, Google, xAI, Replicate, Fal, KIE, ElevenLabs, Ollama Cloud, OpenRouter, Z.AI, MiniMax, Moonshot) with normalized `ProviderModel` shape, weekly refresh job, and `/api/models` routes.
- **System Status Panel** - `src/components/SystemStatusPill.tsx`, `src/components/SystemStatusDrawer.tsx`, and `/api/system/status` returning the six-state agent vocabulary (idle / busy / degraded / offline / starting / error).
- **Platform abstraction** at `src/lib/platform.ts` - clean Mac vs VPS-Docker code paths for workspace base, persona file lookup, and disk probes.
- **CF Access + MC_API_TOKEN middleware** at `src/middleware.ts` - dual auth: external API bearer token via `MC_API_TOKEN`, browser path gated by `cf-access-jwt-assertion` when `REQUIRE_CF_ACCESS=true`. Local dev stays open with explicit warnings.
- **Cmd+K command palette** at `src/components/CommandPalette.tsx` (cmdk-powered) - global navigation, search, and quick actions from any route.
- **xAI / Grok Live Search Research sub-module** - `src/app/operator/research/` + `src/lib/providers/xai` wired to Grok Live Search with persisted history.
- **Half-duplex Call Mode** - `src/components/operator/CallMode.tsx` plus voice button on the Bridge composer; push-to-talk turn-taking, no full-duplex audio yet.
- **Web Agent (Anthropic Computer Use)** - `src/app/operator/web-agent/` + runner; uses the `computer_use` capability tag on supported Claude models.
- **18 Playwright smoke tests** at `tests/integration/v4-smoke.spec.ts` covering 13 page routes + 5 API contracts (health / system status / models / research history / workspace list).
- **Install bootstrap and integration compat scripts** under `scripts/install/` and `scripts/integration-tests/` for mac-mini and vps-docker.

### Changed

- **White-label cleanup** - removed every "BlackCEO", "Welcome back, Trevor", and "Live Demo" string from runtime UI; remaining references are explanatory comments only. Landing initial state is empty so white-label deploys never flash the old brand.
- **Route consolidation with 308 redirects** - `/kanban` -> `/tasks/all` (cross-department board) and `/workspace` -> `/tasks/by-department`. Implemented via App Router `permanentRedirect()` so external links keep working.
- **`/api/health` migrations report** - now returns the full migration manifest (id, name, applied_at) so operators can verify the schema state from the outside.
- **Capability vocabulary unified to the 16-tag canonical** - `text, vision, audio_input, streaming, reasoning, tool_use, structured_output, long_context, code_execution, embeddings, image_generation, video_generation, audio_generation, audio_transcription, web_search, computer_use`. Legacy aliases (`chat`, `completion`, `embedding`, `image_input`, `json_mode`, `code`) dropped across all 13 provider connectors and the UI.

### Migrations

- **031** - `model_registry` (replaces hardcoded AVAILABLE_MODELS) + `pricing_model`, `status` CHECK constraints.
- **032** - `provider_credentials` and refresh metadata.
- **033** - `system_status_history` for the six-state vocabulary.
- **034** - `agent_capabilities` join table.
- **035** - `operator_sessions` (Bridge SSE state).
- **036** - `operator_buckets` (Workspace 7-bucket output store).
- **037** - `studio_jobs` (image/video/audio generation queue).
- **038** - `notebook_documents` (NotebookLM-compatible store).
- **039** - `operator_goals` + `operator_journal`.
- **040** - `operator_memory` (long-term recall index).
- **041** - `call_sessions` (half-duplex Call Mode transcripts).
- **042** - `research_searches` (Grok Live Search history).
- **043** - `web_agent_sessions` (Computer Use runs + screenshots).

### Dependencies added

- `cmdk` (Cmd+K palette)
- `react-markdown` + `remark-gfm` + `rehype-highlight` + `highlight.js` (Workspace markdown preview, Notebook viewer)
- `@anthropic-ai/sdk` (Web Agent / Computer Use)
- `playwright` (dev) for the integration smoke suite

### Infrastructure

- `scripts/install/mac-mini-bootstrap.sh` and `scripts/install/vps-docker-bootstrap.sh` - cold-start helpers that install Node deps, rebuild `better-sqlite3`, run migrations, and verify the env matrix.
- `scripts/integration-tests/` - shell harness that walks Wave 1 routes with `jq` selectors.
- `playwright.config.ts` at repo root + 18 specs under `tests/integration/`.

### Removed

- `src/components/DemoBanner.tsx` - deleted along with its `src/app/layout.tsx` import.
- The hardcoded `AVAILABLE_MODELS` array in `src/app/api/settings/intelligence/route.ts`. The registry now hydrates the same shape at request time from the `model_registry` table.

### Risk: high

26 commits on `v4.0-integration` since `main`, 13 new migrations, 13 new provider connectors, a new auth middleware, and a top-level route reshape. The 308 redirects preserve old URLs and the registry hydrate path keeps `/api/settings/intelligence` backwards-shape-compatible, but operators should run `/api/health` immediately after deploy to confirm 043 applied and `/api/system/status` to confirm the six-state vocabulary returns.

### Deploy checklist

1. `git pull origin main` (after Trevor approves the merge from `v4.0-integration`).
2. `npm install` (picks up cmdk, react-markdown chain, @anthropic-ai/sdk).
3. `npm rebuild better-sqlite3` (VPS containers especially).
4. `npm run build`.
5. Set `MC_API_TOKEN` and `REQUIRE_CF_ACCESS=true` in production env.
6. `unset PORT && PORT=4000 pm2 start --update-env ecosystem.config.cjs`.
7. Verify: `/api/health` shows migrations through 043, `/api/system/status` returns six-state, `/api/models` lists the 13 providers, `/operator` loads, `/kanban` 308s to `/tasks/all`, `/workspace` 308s to `/tasks/by-department`.

---

## [v3.7.0] — 2026-05-24 — Clear v2.0 eval backlog (Tier 1+2+3+4 + Triad UI)

Closes the entire v2.0 evaluation backlog in one sweep. Performance Review went from 3/10 to first-class, Model Lock Protocol shipped, Kanban grew its 6th column, the Persona library got a viewer page, and the TaskModal now resolves Triad-Rule violations inline.

### Added

- **`/api/performance`** (NEW) — full executive aggregator returning task counts, avg completion time, agent utilization, department workload distribution, 7/30/90-day trend buckets, top-3 bottleneck clusters, and persona coverage %. Backs the new CEODashboard trend chart + bottleneck + persona-coverage cards.
- **`/api/personas`** (NEW) — exposes the full persona catalog from `persona-categories.json` (Skill 22). Powers the new `/personas` viewer route — searchable, category-grouped library of all coaching personas with domain/perspective tags + blueprint preview.
- **`POST /api/persona-assignment`** (NEW handler on existing route) — auto-suggest + attach a persona to a single task using persona-selector-v2. Backs the TaskModal's "Auto-suggest persona" CTA.
- **`PATCH /api/settings/intelligence`** (NEW handler) — Model Lock Protocol. Lock/unlock a per-department or per-role model/persona setting; returns a `lock_token` the caller must echo via `X-Lock-Token` on subsequent PUTs (423 Locked otherwise).
- **`completed_at` column + `task_history` table + auto-trigger** — `tasks.completed_at` is now set automatically when a row transitions to `done`. Every status change appends a row to `task_history` via the PATCH handler so /api/performance can compute durations and agent attribution.
- **`workspaces.head_agent_id` column + UI** — each workspace now designates a department head. Rendered as a banner on the workspace page and as a card-top pill on the workspace grid. Backfill assigns the first agent created for each workspace.
- **6th Kanban column (`Backlog` separated from `To-Do`)** — Backlog = raw inbox, To-Do = groomed/prioritized, In Progress / Review / Blocked / Done unchanged. Decorative filter chips (`By Status`, `Tasks Due`, `By Agent`, `Completed`) now actually filter the board.
- **TaskModal Triad-Rule banner** — when a backlog → start PATCH returns `{ error: "Triad incomplete", missing: [...] }`, the modal renders a clear banner with "Add an SOP", "Auto-suggest persona", and "Add description" CTAs that each resolve their missing piece inline. Dragging a Triad-incomplete card on the Kanban also re-opens the modal with the same banner.
- **Model cost columns** — `AVAILABLE_MODELS` now carries `cost_per_million_input` / `cost_per_million_output` for every entry. The Intelligence Settings UI will display these next to each model.
- **`/personas` page** — searchable persona library viewer at `src/app/personas/page.tsx`.

### Fixed

- **`/api/company` returns the wrong row** — endpoint used `ORDER BY rowid LIMIT 1`, which surfaced the bootstrap "Command Center" placeholder forever on installs that pre-existed Skill 23. Now prefers `$COMPANY_SLUG` / `$COMPANY_NAME` matches, then any non-placeholder row, and migration 030 deletes the placeholder once a real client row exists.
- **Migration runner ran in file declaration order, not numeric id order** — fixed by sorting `migrations` numerically before iterating. Today's deploy disaster (later migration firing before an earlier one because of a renumbered slot) cannot recur.

### Migrations

- **027** — `add_task_completed_at_and_history` — adds `tasks.completed_at`, `task_history` table, and the `trg_tasks_completed_at` trigger.
- **028** — `add_workspace_head_agent` — adds `workspaces.head_agent_id` + backfills.
- **029** — `add_agent_settings_lock_protocol` — adds `locked_by` / `lock_reason` / `locked_at` / `lock_token` to `agent_settings`.
- **030** — `cleanup_demo_company_row` — deletes the "Command Center" placeholder when a real client row is present.

### Risk: medium

New tables + triggers + four new migrations. The trigger is `CREATE TRIGGER IF NOT EXISTS` — safe to re-apply. The migration runner change is the highest-leverage fix: file order is no longer load-bearing.

### Deploy checklist

1. `git pull origin main`
2. `npm install`
3. `npm rebuild better-sqlite3` (Angeleen VPS especially)
4. `npm run build`
5. `unset PORT && PORT=4000 pm2 start --update-env ecosystem.config.cjs`
6. Verify: `/api/performance`, `/personas`, `/api/sops`, and `/` all return 200.

---

## [v3.6.0] — 2026-05-24 — Skill 35 Marketing "Publish" button + /api/skill-35/publish (Track M, companion to onboarding v10.14.33)

Closes the third trigger path that `35-social-media-planner/INSTRUCTIONS.md` has documented since v10.12.0 but never existed in code:

> *"From the dashboard: The Marketing department in the dashboard has a 'Publish' button on each campaign. Clicking it queues a cycle for this skill."*

### Added

- **`src/components/MarketingPublishButton.tsx`** (NEW) — pink Publish pill rendered on Marketing-department task cards. Hidden (returns null) for non-Marketing tasks, so it can safely live on every TaskCard. States: idle → queuing → queued (or error → retry).
- **`src/app/api/skill-35/publish/route.ts`** (NEW) — `POST` queues a `{ task_id, topic, platforms[], schedule?, requested_by? }` intent, validates+normalizes platforms (twitter → x, dedupe, supported-list check), records it in the new `publish_queue` table, and emits a `publish_queued` SSE event. `GET` lists with `task_id`/`status`/`limit` filters.
- **`src/lib/db/migrations.ts`** — migration `022 add_skill_35_publish_queue` creates the `publish_queue` table (+ 3 indexes on status/task/created_at).
- **`src/lib/types.ts`** — new `PublishQueueItem` interface; `SSEEventType` extended with `'publish_queued'`; `SSEEvent.payload` union accepts `PublishQueueItem`.
- **`src/components/MissionQueue.tsx`** — TaskCard renders `<MarketingPublishButton task={task} />` inside the pill row (no-op for non-marketing departments).

### Companion onboarding PR

This release pairs with **`openclaw-onboarding-vps` v10.14.33** (and Mac `openclaw-onboarding` v10.13.25), which ship the two server-side scripts (`run-publishing-cycle.sh`, `weekly-batch.sh`) referenced by the same `INSTRUCTIONS.md`. The Publish button queues an intent; a downstream worker / the OpenClaw master orchestrator picks up `status='queued'` rows and invokes the cycle script.

### Risk: low

- New API route; no existing route touched.
- New migration is additive (CREATE TABLE IF NOT EXISTS + indexes); cannot collide with existing data.
- Button is gated on `task.department ∈ {marketing, marketing-dept, social-media, social}`; renders nothing otherwise.

---

## [v3.5.0] — 2026-05-20 — Companion bump for onboarding v10.13.0

No dashboard-side fixes needed in the v10.12.0 audit (Phase 19 = 8.80, PASS — only minor changes already covered by the v3.4.1 P1-003/P1-004 typed-persona cleanup). Bumping to v3.5.0 to align with the onboarding v10.13.0 release that closed 5 new P0 blockers and every below-threshold phase across the audit framework.

### Risk: none
Version bump only — no code changes. The dashboard's persona governance (Phase 16 = 9.28, Phase 17 = 9.08) continues to clear the raised 9.0 threshold for the bread-and-butter pillars.

---

## [v3.4.1] — 2026-05-20 — P1-003 + P1-004 dashboard cleanup

Closes the two deferred P1 tickets from the v10.11.0 audit (Phase 19).

- **P1-003** — `Task` interface in `src/lib/types.ts` gained typed persona fields: `persona_id`, `persona_name`, `persona_mode`, `persona_score`, `persona_selected_at`, `persona_version`. Backed by migration 016 on the `tasks` table.
- **P1-004** — `MissionQueue.tsx` dropped `(task as any).persona` cast; now uses `task.persona_name` with `persona_mode` surfaced in the title tooltip + suffix.

---

## [v3.4.0] — 2026-05-20 — Dashboard-side closeout for v2.0 audit

Companion release to onboarding-repo v10.12.0. The v10.11.0 audit found two dashboard-side gaps:

1. **CEO_DEFERRAL heading drift** — `agents/master-orchestrator/IDENTITY.md` used the heading "Persona Governance — CEO Mode" while the onboarding `AGENTS.md` files used "CEO_DEFERRAL — Persona Governance Override (Master Orchestrator Mode)". The onboarding docs claimed the three sources were "kept in sync." They were on substance, not on heading. Now they are on both.

2. **Missing `check-wave-concurrency.sh`** — `AGENTS.md` (across all repos) references this script as a universal concurrency-gate enforcement mechanism, but the dashboard repo didn't have it. Copied byte-identical from the onboarding repos to `scripts/check-wave-concurrency.sh`.

### Files touched

- `agents/master-orchestrator/IDENTITY.md` — heading renamed.
- `scripts/check-wave-concurrency.sh` — NEW (Mac=10 / VPS=5 cap, standing-observer exclusion, JSON output + exit codes).
- `version`, `package.json` — bumped to 3.4.0.

### Risk: low
Heading-only change in IDENTITY.md (no semantic shift). New script is opt-in (must be called explicitly).

---

## [v3.3.0] — 2026-05-20 — Hop 10 Wire-Up: intelligence-resolver consumes persona_assignment

Companion release to onboarding-repo v10.11.0. Closes the last P0 from the v2.0 re-audit: the dashboard ignored what `persona-selector-v2.py` writes to the database, so persona governance stopped at the selector and never made it to dispatch.

### Risk: low
Backward-compatible. New `taskId` parameter on `resolveSettings()` is optional (existing callers without it get the old cascade). The new persona sources (`task_pinned`, `sticky_assignment`) only fire when the relevant tables have data — older DBs without migration 016/019 fall through to `agent_settings` exactly as before.

### Fix — `intelligence-resolver.ts` reads `tasks` + `persona_assignment` at dispatch time

**Before:** `resolveSettings(agentId, departmentId)` queried only `agent_settings`. Persona resolved to `'auto'` for every dispatch unless an admin had hand-set a dept-level default in `agent_settings`. The 5-layer scoring matrix in `persona-selector-v2.py` ran on every dispatch and wrote results to `tasks.persona_id` / `tasks.persona_name` / `tasks.persona_mode` AND upserted into `persona_assignment` — but the dispatch path **never read either**. Hop 10 ("dashboard consumes what the selector wrote") was the last unwired hop.

**Now:** `resolveSettings(agentId, departmentId, taskId?)` cascade is:

1. **`task_pinned`** — if `taskId` is provided and `tasks.persona_id` is set, use `tasks.persona_name` directly. This is the highest-priority source: it's the live output of the 5-layer matrix for THIS task.
2. **`sticky_assignment`** — query `persona_assignment` for the most-recently-assigned row for this `department_id` (`ORDER BY last_assigned_at DESC LIMIT 1`). This is the "what did we pick last time for this department" memory the selector maintains via `ON CONFLICT (department_id, task_category) DO UPDATE`.
3. **`role_override`** — `agent_settings` row with matching `role_id`.
4. **`department_default`** — `agent_settings` row with `role_id IS NULL`.
5. **`hardcoded_default`** — `DEFAULT_PERSONA = 'auto'`.

`PersonaSource` type extended to include `'task_pinned' | 'sticky_assignment'`. `ResolvedSettings` gained optional `personaMode` and `taskCategory` fields. `resolveAndLog` automatically threads `taskId` through; existing dispatch caller (`src/app/api/tasks/[id]/dispatch/route.ts`) already passes `task.id` as first argument so it picks up Hop 10 with no caller-side change.

The dispatch resolution log line now records `personaMode` and `taskCategory` in metadata for the Activity tab.

### Files touched

- `src/lib/intelligence-resolver.ts` — Hop 10 wire-up.

### Verification

- TS type-check on `src/lib/intelligence-resolver.ts` against project `tsconfig.json`: 0 errors.
- Queries tolerant of older DBs missing `tasks.persona_id` columns or the `persona_assignment` table (both wrapped in `try { … } catch { … }`).
- Existing call in `dispatch/route.ts` (`resolveAndLog(task.id, agent.id, task.workspace_id)`) unchanged — Hop 10 fires automatically because `task.id` is the first arg and `resolveAndLog` now threads it into `resolveSettings`.

---

## [v3.2.0] — 2026-05-20 — Post-Analysis Remediation: Departments, ZHC Layout, Persona UI, QC

Companion release to onboarding-repo v10.7.0. Fixes the four dashboard-side findings from the 2026-05-19 15-phase analysis: N17 department mismatch (Phase 7 IW4 = 3.0/10), N19 agents/ ZHC layout (Phase 10 = 1.5/10), no persona-display UI (Phase 11 CC4 = 5.0/10), and zero QC coverage (Phase 13 QC5 = 5.0/10).

### Wave 1.2 — Department canonical set (N17)
Dashboard `DEFAULT_DEPARTMENTS` and `config/departments.json` had four departments the AI Workforce Interview never produces, while missing four it does. Direct N17 binary-gate violation.

- `src/lib/routing/departments.config.ts`: dropped Operations / Creative / HR-People / IT-Tech. Added CRM (priority 8 — GHL focus), OpenClaw Maintenance (priority 9 — Sunday update / skill bumps / QC), Social Media (priority 7 — organic channels), Paid Advertisement (priority 7 — Meta/Google/YouTube/TikTok with ROAS/CPA keywords).
- `config/departments.json`: full rewrite to the 17 canonical departments matching `INSTRUCTIONS.md` mandatory list.
- `src/components/MissionQueue.tsx`: emoji + name maps updated to match new dept set.

### Wave 2 — N19 ZHC layout for `agents/`
Dashboard's `agents/` directory was a pre-v9.6.0 artifact: 23 agents × 4 real files, missing IDENTITY/HEARTBEAT/USER, zero symlinks where the spec required 69. Scored 1.5/10 against an 8.5 threshold.

- `agents/_shared/AGENTS.md` (NEW): canonical company-wide agent behavior rules.
- `agents/_shared/TOOLS.md` (NEW): canonical tool registry. LLM infrastructure (DeepSeek V4 Pro Ollama Cloud → Gemini 3.1 Flash Lite OpenRouter, Anthropic reserved for Master Orchestrator), GHL/n8n/Vercel/Hostinger integrations.
- `agents/_shared/USER.md` (NEW): owner profile (Trevor Otts / BlackCEO) with Behavioral Identity Profile section that persona-selector Layer 2 reads.
- 23 agents × IDENTITY.md (NEW): each with the Persona Governance Override clause. Master Orchestrator gets CEO_DEFERRAL (mission/owner override persona on conflict). Other 22 agents get STANDARD_DEFERRAL.
- 23 agents × HEARTBEAT.md (NEW): default 30-minute cadence + startup checklist.
- 23 agents × {AGENTS,TOOLS,USER}.md: converted from real files to relative symlinks pointing to `agents/_shared/`. **69 symlinks total** — matches the spec exactly.
- `scripts/migrate-agents-to-zhc.py` (NEW, executable): the one-shot migration that built this. Idempotent — safe to re-run.

### Wave 4.3 — Persona governance UI + API
The dashboard had persona infrastructure (DB tables + `/api/persona-matrix` route) but the UI never surfaced any of it. After the onboarding repo's Wave 4.1+4.2 writers populate the data, this commit makes it visible.

- `src/app/api/persona-assignment/route.ts` (NEW): `GET /api/persona-assignment` returns the live `persona_assignment` table sorted by `last_assigned_at DESC`. Query params: `?department=<id>` filter, `?limit=<n>` (default 200), `?include_verification=true` joins in the verification fields. Tolerant of older DBs missing the table or verification columns — returns hint instead of 500.
- `src/components/ceo-board/PersonaGovernanceBoard.tsx` (NEW): CEO-board section showing every active persona assignment grouped by department. Per row: persona name, mode (leadership/coaching/hybrid), task category, time since last assignment, last_score (color-coded), adherence % when verified, "high churn" warning when `switch_count >= 5`. Auto-refresh every 30 seconds.
- `src/app/ceo-board/page.tsx`: mounts the new section as 7b, between the Bento Grid and the Recommendations row.

### Wave 5.3 — Dashboard QC framework + CI gate
Dashboard had zero QC coverage. Phase 13 QC5 = 5.0/10.

- `QC.md` (NEW): 10-point rubric adapted from v9.3.0 standard for a deployed Next.js dashboard. Gate at 8.5 to ship.
- `scripts/qc-cc.sh` (NEW, executable): 27 mechanical checks across 6 sections (version, departments, agents ZHC, migrations, no-Anthropic, persona infra). On current state: **27/27 green, 0 warnings**.
- `.github/workflows/qc-cc.yml` (NEW): runs `qc-cc.sh` on every push to main + every PR. Non-blocking build smoke test as secondary job.

### Wave 6 — Housekeeping
- `src/lib/db/migrations.ts`: added a no-op placeholder for migration `008` so the sequence is no longer 007 → 010 / 009. Clears the QC rubric warning.
- Removed dead `.superdesign/` directory (design-system.md, init folder, 3 reference PNGs, replica HTML templates) — Phase 11 CC1 bloat flag.
- Removed `mission-control.png` (191KB legacy binary at repo root) — same flag.

### Bump path
- `v3.1.0` → `v3.2.0` — minor bump for additive features (4 departments swapped, 23 agents migrated, 1 new API route, 1 new CEO-board section, 1 new QC framework, 1 new CI workflow). No breaking changes to existing routes / DB schema.

### Compatible with
- onboarding-repo v10.7.0 (companion release — persona-selector-v2.py writes the data this dashboard now reads).

---

## [v3.1.0] — 2026-05-19 — Version Alignment + Drift Prevention Infrastructure

Aligns all 5 BlackCEO Command Center version locations after 6+ months of accumulated drift, AND ports the v10.6.2 drift-prevention infrastructure from the onboarding repos to this dashboard so it can't drift silently again.

### The drift that just got fixed

| Location | Before this release | After this release |
|---|---|---|
| `/version` | `v3.0.1` | **`v3.1.0`** |
| `package.json` `"version"` | **`2.9.4`** (stale ~6 months) | **`3.1.0`** |
| `package-lock.json` root `"version"` | **`2.9.4`** (stale ~6 months) | **`3.1.0`** |
| `package-lock.json` `packages[""].version` | **`2.9.4`** (stale ~6 months) | **`3.1.0`** |
| `CHANGELOG.md` top entry | `## [v3.0.1]` (2026-05-17) | **`## [v3.1.0]`** (this entry) |

### Why this happened
Earlier sessions in 2026-Q1/Q2 prepended CHANGELOG entries (v3.0.0, v3.0.1, and a bunch of v10.4.x / v10.5.x entries mixed in to track onboarding-repo waves) but **never actually bumped `package.json` or `package-lock.json`**. The result: every `npm install` and every CI artifact for the past 6 months has shipped under "v2.9.4" while documentation claimed newer versions. Same drift problem the onboarding repos had pre-v10.6.2 — caught here by the Phase 1 audit of the Onboarding Repos Analysis & Hardening PRD.

### Added — `scripts/bump-version.sh`
Atomic 5-location version bumper. CC-specific (the onboarding version targets different files). Usage:
```bash
./scripts/bump-version.sh v3.1.1
./scripts/bump-version.sh --check
```

### Added — `.github/workflows/version-consistency.yml`
GitHub Actions check. Runs on every push to main and every PR. Fails the build if any of the 5 CC version locations disagree, with explicit remediation guidance. Status check name: `Version consistency`. Verified passing on this merge.

### Note on historical CHANGELOG entries
Pre-v3.1.0 entries claiming v10.4.0, v10.4.1, v10.5.0, etc. were the CC's documentation OF the onboarding-repo waves (the CC repo participated in the v2.1 multi-wave releases by adding migrations + pages + APIs to support them). Those entries are NOT claims that the CC itself was at v10.x.x — they're records of CC-side changes shipped alongside onboarding-repo waves of the same name. The CC's own version track is and has always been `2.x.x` / `3.x.x`. Confusing in retrospect; this entry is the last time the CC will share heading-numbers with an onboarding wave.

### Files in this commit
- `package.json` → `"version": "3.1.0"`
- `package-lock.json` → root `"version"` + `packages[""].version` both `"3.1.0"`
- `version` → `v3.1.0`
- `scripts/bump-version.sh` (new, executable)
- `.github/workflows/version-consistency.yml` (new)
- `CHANGELOG.md` — this entry

---

## [v3.0.1] — 2026-05-17 — Wave 4: Hand-Touch Integration

### Added — `src/lib/persona-selector.ts`

The server-side persona selector module that the task dispatch API uses. Spawns `persona-selector-v2.py` from the installed OpenClaw skill folder (resolves path via `OPENCLAW_ROOT` env var with Mac/VPS defaults). Returns a typed `PersonaSelectionResult` that's a superset of the v1 selector: same `persona_id`, `score`, `interaction_mode`, plus new fields `task_category`, `secondary_persona_id` / `secondary_persona_name` / `secondary_persona_score` (hybrid mode), `weights_used`, `layers`, `breakdown`.

Existing callers continue to work — new fields are optional. The v2 selector handles stickiness, adaptive weights, behavioral profile reading, hybrid mode, and weight overrides via the `persona_assignment`, `persona_weight_overrides`, and `persona_performance` tables shipped in Wave 2 migrations 016-021.

### Version

Root `version` file bumped to **v3.0.1**.

---

## [v10.5.0] — 2026-05-17 — Wave 3: v2.1 Integration Layer

This Command Center release aligns the dashboard with the onboarding repos' v10.5.0 integration layer. No new dashboard features in this wave — all migrations and pages shipped in Wave 2 (v10.4.1).

The onboarding repos now ship:
- `persona-selector-v2.py` — the v2.1-aware persona selector with stickiness + adaptive weights
- `post-build-role-workspaces.py` — creates role-level workspaces post-build
- `gemini-section-indexer.py` — section-level Gemini indexing
- `run-v2.1-migrations.sh` — one-command migration runner
- `verify-v2.1-installation.sh` — smoke-test all 36 checks
- `RUNBOOK-v2.1.md` — operator runbook

### Optional hand-touch (RUNBOOK Section 5B)

To wire persona-selector-v2 into the Command Center, edit `src/lib/persona-selector.ts`:

```typescript
// Change:
scriptPath = path.join(openclaw_root, "skills", "23-ai-workforce-blueprint", "scripts", "select-persona-for-task.py");
// To:
scriptPath = path.join(openclaw_root, "skills", "23-ai-workforce-blueprint", "scripts", "persona-selector-v2.py");
```

The v2 selector emits compatible JSON plus extra fields (`task_category`, `secondary_persona_id`, `secondary_persona_name`, `secondary_persona_score`, `weights_used`, `layers`). Existing callers continue to work — new fields are ignored by old consumers.

### Version

Root `version` file bumped to `v3.0.0` (major bump aligns with onboarding v10.5.0 integration milestone).

---

## [v10.4.1] — 2026-05-17 — Wave 2 Execution

### Added — Database Migrations

Six new migrations (016 → 021) applied automatically on next server startup:

- **016 `add_task_persona_fields`** — Adds `persona_id`, `persona_name`, `persona_mode`, `persona_score`, `persona_selected_at` columns to `tasks` table. Creates `persona_selection_log` table with indexes on task_id, department_id, persona_id.
- **017 `add_campaigns_and_campaign_id`** — Creates `campaigns` table (planning/active/review/complete/archived states). Adds `tasks.campaign_id` foreign key. Adds indexes for tasks-by-campaign and campaigns-by-workspace.
- **018 `add_persona_performance`** — Creates `persona_performance` table for outcome tracking (owner_rating -1/0/+1, revision_count, time_to_complete_seconds, kpi_attribution). Creates `persona_weight_overrides` table for auto-rebalancing (-15% weight when persona gets 3+ negative ratings in 7 days).
- **019 `add_persona_assignment_and_version`** — Creates `persona_assignment` table for sticky (department, task_category) → persona mapping. Adds `tasks.persona_version` column for version-pinning at dispatch time.
- **020 `add_da_challenges`** — Creates `da_challenges` table for Devil's Advocate workflow (open/accepted/dismissed/overridden states, severity, confidence, dismissal_reason).
- **021 `add_hybrid_task_secondary_persona`** — Adds `secondary_persona_id`, `secondary_persona_name`, `secondary_persona_score` columns to `tasks` for hybrid-mode tasks (one persona executes work, the other engages the owner).

All migrations are idempotent (re-runnable safely) — they check for existing columns/tables before adding.

### Added — Pages

- `/campaigns/[id]/page.tsx` — Cross-department Kanban view for a single campaign. Shows all 5 columns (New, Queued, In Progress, Review, Done), live persona pills (blue=leadership, purple=coaching), secondary persona pill for hybrid tasks, department badges, dept-filter chips, and a campaign progress bar.
- `/onboarding/building/page.tsx` — Real-time progress page for the full AI workforce build. Polls `/api/onboarding/build-status` every 4 seconds. Shows overall doc count progress + per-department progress bars + ETA. Telegram notification recommended when complete.

### Added — API Routes

- `GET/POST /api/campaigns` — list and create campaigns
- `GET/PATCH/DELETE /api/campaigns/[id]` — read, update, delete a single campaign
- `GET /api/persona-performance` — performance rollup by persona for `?period=7d|30d|90d|all`, filterable by `?department=`
- `GET /api/persona-selection-log` — recent persona selections (default 20), filterable by `?department=`
- `POST /api/tasks/[id]/rating` — submit owner rating (-1, 0, +1) for a completed task. Triggers auto-rebalance check (3+ negatives in 7d → -15% weight override for 30 days).
- `GET/POST /api/weight-profiles` — read/write the company's adaptive weight profiles. Persists to `[OPENCLAW_ROOT]/workspace/weight-profiles.json` on whichever platform is detected.
- `GET /api/onboarding/build-status` — current build progress (idle/manifest/research/departments/roles/qc/assembly/complete) read from `[ZHC]/[active-company]/build-progress.json`.

### Notes

- Existing intelligence settings page (`/settings/intelligence/page.tsx`) and existing DA challenges API + persona matrix API were left intact — they were already implemented in an earlier wave.
- `crypto.randomUUID()` used in API routes — requires Node 18+ (already standard in Next.js 14 deployments).

---

## [v10.4.0] — 2026-05-17 — Zero-Human Company Spec (PRD v2.1)

### Added
- **Shared platform abstraction**: `shared-utils/detect-platform.sh` and `shared-utils/detect_platform.py` resolve paths automatically across Mac (clawd-legacy or .openclaw-new) and VPS (`/data/.openclaw`)
- **30-question interview structure** replacing v9.6 dense flow. Target: owner completion in under 45 minutes. 6 phases — asset drop, behavioral identity (5Q), vision/goals (4Q), customer context (5Q), department customization (13 bundled Q), final review
- **16 mandatory departments** auto-built for every zero-human company: Marketing, Sales, Billing & Finance, Customer Support, Web Development, App Development, Graphics, Video, Audio, Research, Communications, CRM, OpenClaw Maintenance, Legal, Social Media, Paid Advertisement
- **3 industry vertical packs** auto-added by Phase 0 detection: Personal/Professional Development (~60% of clients), Real Estate, Service Industry
- **Universal 18-section how-to.md template** at `23-ai-workforce-blueprint/templates/universal-how-to-template.md`. Every role document follows the same strict structure: identity, persona governance override, daily/weekly/monthly/quarterly ops, KPIs tied to revenue cascade, tools, SOPs, quality gates, handoffs, escalation paths, good/bad examples, common mistakes, research sources, edge cases, update triggers
- **Role documentation generation prompt** at `23-ai-workforce-blueprint/prompts/role-doc-generation-prompt.md`. Enforces consistent sub-agent output: required Perplexity research calls, mandatory section coverage, 2500-5500 word target, anti-hallucination checks
- **4 new suggested-roles department files**: `crm-suggested-roles.md` (with Email Deliverability & Optimization Specialist as flagship role), `openclaw-maintenance-suggested-roles.md`, `social-media-suggested-roles.md`, `paid-advertisement-suggested-roles.md`
- **Persona Governance Override clause** baked into every generated SOUL.md, IDENTITY.md, and how-to.md Section 2. When a persona is assigned, it overrides the identity file. When no persona is assigned, identity file governs as fallback. The owner's company mission and personal values are honored in both modes
- **CEO Persona Deferral Clause** (special variant) applied only to the Master Orchestrator. CEO does NOT fully defer — persona is INPUT but mission and owner values win on conflict
- **Role-level workspace architecture**. Each role inside each department now has its own folder with unique IDENTITY.md / SOUL.md / MEMORY.md / HEARTBEAT.md / how-to.md plus symlinks to company-root AGENTS.md / TOOLS.md / USER.md
- **Revenue cascade** (yearly → quarterly → monthly → weekly → daily) baked into every role's KPI section. Single owner input drives KPI targets across all 130-200 roles
- New mandatory roles in existing departments: **SEO Specialist** + **Technical SEO Specialist** in Web Development; **Video SEO Specialist** in Video; **Email Deliverability & Optimization Specialist** in CRM (flagship — most consequential role in the system)

### Changed
- Interview density: ~50-65 questions in v9.6 → ~28-30 questions in v2.1
- Department naming map (`department-naming-map.json`) reorganized into `mandatory` / `vertical_packs` / `deprecated` tiers
- Sub-agent generation orchestration: 1 manifest → up to 10 department sub-agents → up to 50 role sub-agents in parallel → 25-45 minute full build of 130-200 role documents
- Industry vertical detection runs in Phase 0 (asset drop) and auto-applies vertical pack with one confirmation question

### Deprecated (moved to `suggested-roles/_deprecated/` in a follow-up commit)
- `creative-suggested-roles.md` — responsibilities folded into Graphics + Video + Audio departments
- `hr-people-suggested-roles.md` — zero-human company has no human team to manage
- `it-tech-suggested-roles.md` — replaced by OpenClaw Maintenance department
- `operations-suggested-roles.md` — operations distributed into each department

### Migration Notes for Existing Workspaces
- Run `shared-utils/migrate-deferral-clauses.py` to add Persona Governance Override clause to every existing SOUL.md and IDENTITY.md (idempotent, safe to re-run)
- Existing department-level workspaces built with v9.x format remain functional. v2.1 role-level extensions apply to new builds and audited (Option C) refreshes
- Existing `gemini-index.sqlite` should be re-indexed at section level when v2.0 Chapter 13 ships (separate work item)

### Documentation
- PRD v2.1 saved at user's local Downloads: `onboarding PRD v2.1.md`
- Supersedes PRD v1.1 (foundation) and v2.0 (intelligence layer)
- Execution order remains: v1.1 → v2.0 → v2.1

---

# Changelog

## v2.9.5 - May 13, 2026 - Update Check + Updater Scripts

### Added
- **`check-updates.sh` at repo root** — READ-ONLY script that compares the locally-installed Command Center version against the GitHub `version` file + extracts the latest CHANGELOG entry. Emits structured JSON. Never modifies anything. Designed to be called by the Sunday weekly update cron (lives in the openclaw-onboarding repos).
- **`update.sh` at repo root** — Destructive update script: backs up critical files to `~/Downloads/blackceo-cc-backups/` (Mac) or `~/blackceo-cc-backups/` (VPS), runs `git fetch + reset --hard origin/main`, reinstalls npm dependencies, attempts PM2 reload, writes a `COMMAND CENTER UPDATE PENDING` flag to the workspace AGENTS.md so the agent knows to verify the post-update state. Does NOT auto-apply database migrations — surfaces them as warnings for manual review.

### Changed
- **version file** bumped to v2.9.5.

### Risk: low
Adds tooling, does not change app code or schema. The update.sh script is destructive when invoked but only by explicit user action (or by the Sunday cron after the client explicitly confirms). No effect on running Command Center installs until someone runs update.sh.

### Notes
- These scripts pair with the v9.2.0 weekly-onboarding-update cron in the openclaw-onboarding / openclaw-onboarding-vps repos. The cron calls check-updates.sh from BOTH the onboarding repo AND this repo, composes a single Telegram summary, asks the client which (if any) to update, then calls update.sh here if Command Center was selected.

---

## v2.9.4 - April 3, 2026

### Fixed — Kanban Race Condition
- **src/app/workspace/[slug]/page.tsx:** Removed duplicate Breadcrumb components
- **src/components/MissionQueue.tsx:** Added setTasks([]) on navigation to prevent Zustand store flash
- **src/components/MissionQueue.tsx:** Added departmentFilter prop to override Zustand store
- Version bumped from 2.9.3 to 2.9.4

## v2.9.3 - April 1, 2026

### Upgraded — n8n TOOLS.md to 10/10
- **agents/n8n-workflow-builder/TOOLS.md:** Complete rewrite with full API documentation
- Added authentication example with curl and header format
- Added 7 real API call examples: list, get, create, activate, deactivate, webhook execute, delete
- Added working Webhook-to-Telegram workflow JSON template with deploy command
- Added environment variables table (N8N_API_KEY, N8N_BASE_URL)
- Added 6 common BlackCEO automation use cases
- Added troubleshooting section covering 6 common errors and fixes

## v2.9.2 — April 1, 2026
- Fix HANDOFF.md port header to show Mac: 3000 | VPS: 4000 (QC fix)


## v2.9.1 - April 1, 2026

### Fixed — VPS Deployment Readiness
- **ecosystem.config.cjs:** Changed `/opt/homebrew/bin/npx` to `npx` (Mac-only path broke VPS/Docker)
- **HANDOFF.md:** Updated port 3000 references to 4000, removed hardcoded Mac IPs
- **UI_CHANGES_SUMMARY.md:** Fixed localhost:3000 to localhost:4000
- **config.ts:** Fixed `/Users/user` fallback path to `/root` for Linux/VPS compatibility

### Added — VPS Deployment Docs
- **DEPLOYMENT.md:** Added "Cloudflare Tunnel (Mac Only)" section with VPS skip instructions
- **DEPLOYMENT.md:** Added VPS-specific PM2 install instructions (`--prefix /data/.npm-global`)
- **PRODUCTION_SETUP.md:** Added VPS PM2 install section with persistent /data/ paths
- **PRODUCTION_SETUP.md:** Added VPS note about replacing workspace paths with /data/ equivalents
- **n8n-workflow-builder/TOOLS.md:** Populated with n8n API connection details and env var requirements

### n8n Integration Status
- n8n-workflow-builder agent exists but was a blank template (TOOLS.md had no config)
- Updated TOOLS.md with n8n URL (main.blackceoautomations.com), API key env var name, and auth header format
- Agent still needs: actual workflow templates, webhook URL configuration, and API integration testing
- n8n is NOT integrated with Command Center's task system — it's a standalone agent for building n8n workflows manually

## v2.9.0 - April 1, 2026

### Fixed
- config/departments.json: populated with 17 real departments (was empty [])
- Department IDs now use dept-[slug] format matching openclaw.json agent IDs
- Department schema corrected: id, emoji, name, headTitle, workspacePath fields
- Persona route path resolution fixed: strips dep- prefix for correct file lookup

### Added
- New department section components: CampaignSpotlightCard, ComplianceContextCard, DepartmentMemoryPreviewCard
- DeploymentHealthChart, EnvironmentStatusSection, GoalsConstraintsSection
- HRCultureSpotlight, HRTalentPipeline, HRVoiceCommand
- KPIStatCardsRow, LiveLogsSection, MarketingMemoryDefaults
- RepositoryStatusCard, ResearchInsightsSection, SupportDashboardExtras
- Creative and Operations sub-sections

## v2.4.0 - March 27, 2026

### Added - Intelligence Settings
- New Settings > Intelligence page (`/settings/intelligence`) for per-department model and persona configuration
- AI Settings quick panel in Header for fast model/persona switching per workspace
- `agent_settings` database table with migration 013 (department + role + setting_type + value)
- `/api/settings/intelligence` API endpoint for reading and writing agent settings
- Model options: Free Models Router, Kimi K2.5, MiMo V2 Pro, Claude Sonnet, GPT 5.4, Gemini 3 Flash
- Persona options: Auto-assign, James Clear, Seth Godin, Alex Hormozi, Donald Miller, Chris Voss

### Added - Complementary Brand Palette
- `src/lib/colors.ts`: HSL color utility library (hexToHsl, hslToHex, generatePalette)
- Generates light/dark/accent variants from company primary and secondary colors
- `useCompanyBrand` hook fetches company record and builds full brand palette dynamically
- All palette fields null-safe when brand colors are not yet configured

### Fixed - Dynamic Department Resolution
- `departments.config.ts` now filters departments against workspaces in the database instead of always returning all 17 defaults
- AgentsSidebar loads departments from `/api/workspaces` instead of hardcoded array
- Removed 18-entry hardcoded DEPARTMENTS constant from AgentsSidebar
- Resolution order: env var config > database workspaces > built-in fallback

### Fixed - Donut Chart Restore
- Rebuilt UtilizationPieChart as pure inline SVG (removed recharts dependency for this component)
- Animated donut with gradient stroke, center label, and legend row per department
- Responsive sizing with configurable width/height props

### Fixed - Scrollbar and Layout
- Header CSS updated with wider scrollbar styling and arrow indicators
- Custom scrollbar track/thumb/thumb-hover for AI settings panel overflow

### Fixed - Avatar and Agent Logic
- AgentsSidebar deduplicates agent entries and filters out system/default agents
- CEO role deduplication in agent roster display
- Agent description and department navigation links added

### Changed - CEO Board Layout
- Agent Performance section moved below the two-column department/analytics grid
- "View Department Performance" navigation card added with arrow CTA
- Removed standalone AgentPerformanceSection from CEO board main view

### Changed - Port Configuration
- dev and start scripts use `${PORT:-4000}` env var instead of hardcoded 4000
- Allows client machines to run on port 4000 while Trevor's machine uses 3000

### Infrastructure
- `agent_settings` table with unique constraint on (department_id, role_id, setting_type)
- Migration 013 adds indexes on department_id and role_id columns

## v2.3.0 - March 23, 2026

### Fixed - Dynamic Department Seeding
- Removed ALL hardcoded seed data (Acme Dental, Zero Human Workforce Demo)
- migrations.ts no longer inserts any companies or workspaces
- departments.json ships empty - Skill 23 generates it from client's interview answers
- seed-workspaces.py now reads dynamically from:
  1. config/departments.json (generated by Skill 23)
  2. Falls back to scanning Skill 23 workspace folders
  3. Reads company name from workforce-interview-answers.md
- No personal data, avatars, or branding in the template repo
- config/README.md added explaining the dynamic flow

### Fixed - Cloudflare Tunnel Setup
- Phase 6b uses Cloudflare REST API, not cloudflared CLI (cert.pem not needed)
- create-tunnel.sh script added for automated tunnel creation
- Webhook URL for DNS registration: https://main.blackceoautomations.com/webhook/command-center-register-v3
- Mandatory gate checks at every phase to prevent skipping

## v2.2.0 - March 22, 2026

### Added - Persona UI Integration
- DepartmentCard: activePersona field with violet persona indicator pill
- AgentPerformanceSection: persona pill on agent cards showing active persona per task
- AgentPerformanceSection: specialist type label (Full-time / On-call) per agent
- DevilsAdvocateFeed: persona field on challenges with "Acting as [persona]" display
- Agent type interface: persona and specialist_type fields added

### Added - API Endpoints
- GET /api/departments/[id]/personas: reads governing-personas.md from department workspace
- GET /api/org-chart: reads ORG-CHART.md from CEO workspace
- GET /api/persona-matrix: reads persona-matrix.md from CEO workspace
- Department sub-board fetches live personas before falling back to demo data

### Changed - Dynamic Departments
- Removed ALL hardcoded "17 departments" references from codebase
- CEODashboard: TOTAL_DEPARTMENTS_TARGET replaced with departments.length
- DepartmentPerformanceSection: "all 17 departments" changed to "all departments"
- departments.config.ts and seed-dept-memory.ts comments updated
- Demo persona list expanded to 10 accurate book author names

### Infrastructure
- Added version file (v2.2.0)

## v2.1.0 - March 22, 2026

### Added
- Version file added to repository

## v1.4.0 - March 21, 2026

### Added
- Multi-company schema support
- Per-department memory architecture
- KPI entry form
- Recommendation effectiveness tracking (90-day score)
- Execution queue (5pm-9am out-of-hours processing)
- Historical benchmarks with inline SVG sparklines (30-day trends)
- Model pills on agent cards

## v1.3.0 - March 21, 2026

### Added
- CompanyHealthHeader (letter grade + plain English explanation + dept badges)
- DepartmentCard (stat row, progress bar, status dot)
- DepartmentSubBoard page (/ceo-board/[dept])
- Navigation (back buttons, clickable dept cards)
- RecommendationEngineCard (Approve/Dismiss/Save for Later/Why buttons)
- RecommendationsSection (API, effectiveness stats, empty state)
- Approve-to-backlog Kanban integration
- Recommendations API (GET, POST approve/dismiss/save, SQLite seeding)
- AgentPerformanceSection (192 lines)
- DevilsAdvocateFeed (248 lines)
- DepartmentPerformanceSection (291 lines)
- ExecutionQueueSection
- BenchmarkingSection
- KPIEntryPanel
- ManualKPISection
- Sparkline component
- grading.ts utility

## v1.2.0 - March 21, 2026

### Fixed
- All Departments view shows all tasks instead of empty Kanban
- Routing: clicking All Departments no longer shows CEO Dashboard
- CEO Performance Board shows real metrics instead of zeros

### Added
- Task pills: Status, Priority, Department, Agent, Persona
- Persona values populated for all 111 tasks across departments
- Back to Dashboard button on Performance Board
- All Companies button on dashboard header

## v1.1.0 - March 20, 2026
- Department-based sidebar filtering
- CEO Performance Board with analytics
- Live activity feed
- Mobile responsive fixes
