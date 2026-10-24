# T-03 — Command Center capability inventory (reverified)

| | |
|---|---|
| Unit | PBB-064 / ledger task T-03 (repair pass **PBB-085**) |
| Agent | rev-lane-c (build, alias `deepseek-chain`) → repair-lane-z (repair, alias `opus-chain`) |
| Repo | `trevorotts1/blackceo-command-center` |
| Worktree | `/Volumes/mac mini m4/Downloads/git trees and automations/worktrees/pb-skill38-20261024/rev-t03` (build); `/Volumes/mac mini m4/Downloads/git trees and automations/worktrees/pb-skill38-20261024/fix-t03` (repair pass) |
| Branch | `pb/PBB-064/t03-inventory` (build, cut from `origin/main`); `pb/PBB-085/t03-inventory` (repair pass) |
| Baseline commit | `a92d11d940eb082944c30a3433f592aac0ce9842` |
| App version | 7.6.125 (`package.json`) |
| Date | 2026-10-24 |
| Changes | Evidence file only. No product code, no schema, no config, no dependencies. |

## Method

Static read-only reconnaissance of `HEAD` at the baseline commit. Every verdict cites a
`file:line` in this worktree. Nothing was executed: no dev server, no app start, no
database, no test suite, no network call to a client box or external provider.

Verdict scale:

- **PRESENT** — server path and a user-facing surface both exist and the surface reads persisted state.
- **PARTIAL** — real implementation exists but a required half is missing (no UI, no persistence, projection-only, or operator-only where a client needs it).
- **ABSENT** — no implementation found for the capability in this repository.

## Verdict summary

| # | Capability | Verdict | Client-visible status surface? |
|---|---|---|---|
| 1 | Client discovery (tenant registry + selection) | **PARTIAL** | Only the header client switcher; no client registry/lifecycle page |
| 2 | Lifecycle (task state machine, transitions, WIP gates) | **PRESENT** | Yes — board card status, blocked-reason panel |
| 3 | Setup readiness | **PARTIAL** | Partial — health dot + build-progress page; no consolidated client readiness checklist |
| 4 | Campaign / approval / publication | **PRESENT** | Yes — campaign board sync strip, publish summary line |
| 5 | Conversation / fulfillment / follow-up | **PARTIAL** | Yes for conversation metrics, deliverables and publish state; follow-up is aggregate-only |
| 6 | Booking / outcome views | **PARTIAL** | Outcome views yes; **booking ABSENT** |
| 7 | Kanban lifecycle events + stale-state handling | **PRESENT** | Yes — live board, stale/offline banner, escalation notices |

Counts at baseline: 64 page routes, 258 API route handlers, 1,064 `.ts`/`.tsx` files under
`src/` — 286,343 lines combined (215,406 `.ts` + 70,937 `.tsx`) — 35 entries in the cron job table.

---

## 1. Client discovery — PARTIAL

What exists: a typed tenant registry with a cookie-selected active client, a browser-safe
projection that strips secrets, CRUD APIs, and a header switcher.

- Registry type carries secrets and is server-only: `src/lib/clients.ts:26` (`Client`),
  with the security note at `src/lib/clients.ts:15-17`.
- Secret strip for the browser: `src/lib/clients.ts:112` (`toPublicClient`) — gateway/CF-Access
  values become `has_gateway_token` / `has_cf_access` booleans (`:63-65`, `:124-125`).
- Enumeration / read / create: `src/lib/clients.ts:132` (`listClients`), `:140` (`getClient`),
  `:148` (`getSelfClient`), `:205` (`createClient`), `:237` (`updateClient`).
- Selected client, with graceful fallback to the self row: `src/lib/clients.ts:161`
  (`getSelectedClientId`), `:181` (`getClientContext`), `:273` (`setSelectedClient`);
  cookie name at `:23`.
- API: `src/app/api/clients/route.ts:17` (`GET`), `:38` (`POST`);
  `src/app/api/clients/[id]/route.ts:8` (`GET`), `:24` (`PATCH`);
  `src/app/api/clients/select/route.ts:31` (`POST`, sets the cookie).
- Companies (a second, weaker axis): `src/app/api/companies/route.ts:11` (`GET` with
  workspace counts), `:29` (`POST`).
- Tenant identity resolution used by every tenant-scoped route:
  `src/lib/auth/tenant-context.ts:276` (`resolveTenantContext`).
- UI: `src/components/Header.tsx:86` (fetch `/api/clients`), `:139` (POST `/api/clients/select`),
  `:439` (active-row marking). The selected label is echoed on
  `src/app/conversational-ai/page.tsx:65`.

Why PARTIAL, not PRESENT:

- There is **no `/clients` page** in the 64-route page inventory — the only consumer of the
  registry is a dropdown in `src/components/Header.tsx`. `src/app/settings/company/page.tsx:49`
  reads `getClientContext()` for the *selected* client only, not a list.
- There is **no lifecycle or health state per client** on any surface. `PublicClient`
  (`src/lib/clients.ts:48-68`) exposes connection fields and `interview_complete`, not
  reachability, last-seen, build stage or readiness.
- Nothing in this repo probes a *remote* client's gateway. `clientToOpenClawTarget`
  (`src/lib/clients.ts:323`) has exactly three consumers: `src/app/api/events/client-feed/route.ts:85`,
  `src/lib/bridge/dispatch.ts:38` (import at `:22`), and `src/lib/operator/goals.ts:302`
  (import at `:24`) — i.e. connection *use*, never discovery or probing. The interview handlers
  (`src/app/api/interview/answer/route.ts:523`, `src/app/api/interview/state/route.ts:74`) call
  `getClientContext()`, not `clientToOpenClawTarget`.
- Fleet-level discovery lives outside this repo (operator tooling), so Command Center cannot
  answer "which clients exist and what state are they in" on its own.

## 2. Lifecycle — PRESENT

- Canonical status set (10 states): `src/lib/types.ts:21`
  (`backlog | inbox | planning | in_progress | assigned | review | testing | blocked | pending_dispatch | done`).
- The single funnel: `src/lib/task-lifecycle.ts` module header states transition() is "the ONE
  path a task's status changes" (`:3-20`). Legal edges: `:146` (`LEGAL_TRANSITIONS`).
  WIP/column caps: `:186` (`WIP_LIMITS`), `:238` (`checkWipLimit`). The gate itself:
  `:1296` (`transition`).
- Atomicity and concurrency: status UPDATE is compare-and-swapped on the observed from-status
  (`src/lib/task-lifecycle.ts:38-44`), audit rows written in the same transaction (`:326-338`),
  `:780` (`recordStatusEvent`), and a regression-guard path for raw writers
  `:1109` (`transitionWithDeclaredException`).
- HTTP path: `src/app/api/tasks/[id]/status/route.ts:302` (`POST`) calling `transition` at
  `:438` with `expectedFrom` at `:431`.
- Board projection (six synthetic columns over ten statuses):
  `src/lib/board-projection.ts:19` (`TODO_BUCKET_STATUSES`), `:25` (`REVIEW_BUCKET_STATUSES`),
  `:43` (`taskToColumnId`), `:58` (`columnIdToStatus`), `:71` (`CREATE_TERMINAL_STATUSES`),
  `:78` (`createSubmitStatus`) — the create form refuses to fabricate `review`/`done`.
- Surfaces: `/tasks/all` (`src/app/tasks/all/page.tsx:33`), `/tasks/by-department`
  (`src/app/tasks/by-department/page.tsx`), and `/kanban` is a permanent redirect to
  `/tasks/all` (`src/app/kanban/page.tsx:12`). Per-card status pill:
  `src/components/kanban/StatusPill.tsx`. Blocked context: `src/components/TaskOverviewPanels.tsx:468`
  (`BlockedReasonPanel`), `:441` (`DispatchHoldPanel`).
- Per-task lifecycle history: `src/app/api/tasks/[id]/activities/route.ts:22` (`GET`).

## 3. Setup readiness — PARTIAL

Server-side readiness is thorough. What a client can actually see is narrow.

- Tiered readiness parser with "an incomplete result can never certify health":
  `src/lib/health-readiness.ts:20` (`parseReadiness`), requiring `database` and
  `openclaw_gateway` probes (`:35`).
- Liveness route: `src/app/api/health/route.ts:232` (`GET`). Tiered status:
  `src/app/api/system/status/route.ts:19` (`GET`).
- Deep, gating checks (`pass` / `indeterminate` / per-check detail):
  `src/app/api/health/deep/route.ts:1-40+`; implementation in
  `src/lib/health/deep-checks.ts` (`asset_manifest` `:122`, `build_content` `:303`,
  `database_path`, `migrations`, `disk_headroom`, `scheduler_liveness` — enumerated at
  `:10-15` of that file and in the route header).
- Probe families registered: `src/lib/probes/db.ts:84`, `agents.ts:38`, `disk.ts:92`,
  `jobs.ts:41`, `memory.ts:32`, `telegram.ts:22`, `cloudflare-tunnel-probe.ts:249`,
  `model-providers.ts:29` (ten provider probes).
- Workforce build readiness: `src/app/api/onboarding/build-status/route.ts:16` (`GET`) —
  explicitly refuses to call a build complete without verification
  (`verifiedBuild && verifiedCommandCenter`, `:32`, statuses `validating` / `complete` / `waiting`).
  Client surface: `src/app/onboarding/building/page.tsx:9` (stage enum), `:22` (stage labels).
- Installation handshake: `src/app/api/auth/tenant-ready/route.ts:13` (`missing[]`) — returns
  `{ready, missing[]}` with a named missing-component list… **but only for the operator**
  (`context.subject !== 'operator:api'` → 403, `:12`). This is exactly the checklist a client
  would need, and it is not available to a client.
- Interview readiness gate: `src/app/api/interview/gate-status/route.ts:39`. Until closeout the
  middleware 302s every non-exempt page to `/interview`
  (`src/middleware.ts:300-312` exemptions, redirect at `:1027`).
- Client-visible readiness surfaces: `src/components/HealthIndicator.tsx:65` with tiers
  healthy/degraded/unavailable/checking (`:42-60`), mounted on the home dashboard
  (`src/app/page.tsx:476`, `:593`) and the department board
  (`src/app/tasks/by-department/page.tsx:326`); the operator variant opens the drawer
  (`src/components/Header.tsx:404`, `src/components/SystemStatusDrawer.tsx`).

Why PARTIAL: a client gets a single coloured dot plus the build-progress page. There is no
client-facing page that lists "what is still missing for my setup" — that list exists only
server-side and is gated to the operator principal.

## 4. Campaign / approval / publication — PRESENT

Campaigns (persisted, company-scoped):

- `src/app/api/campaigns/route.ts:17` (`GET`) / `:42` (`POST`); company scoping enforced per
  row (`:20-31`); detail `src/app/api/campaigns/[id]/route.ts`.
- Auto-attach a campaign to a task: `src/lib/campaigns.ts:130` (`ensureCampaignForTask`),
  deterministic key `:110`.
- Campaign board UI (real board, not a report): `src/app/campaigns/[id]/page.tsx:19-55`
  (types + publish overlay), SSE subscription `:97`, polling fallback `:144`,
  offline/stale derivation `:171`, sync strip `:346`. Reached from the CEO board:
  `src/app/ceo-board/page.tsx:120`.

Ad campaigns (Skill 48 / 75 boards, engine-only):

- Five canonical stages: `src/lib/ad-campaigns.ts:160` (`DEFAULT_AD_STAGES`); card status set
  `:73`; stage move `:689` (`moveAdStage`); create `:551`.
- Approval is **revision- and hash-bound**, not a boolean: `src/lib/ad-campaigns.ts:403`
  (`checkSkill75Completion`), envelope scan `:420-446`, refusal of conflicting sha256 bindings
  `:437-441`, `latest.decision !== 'approved'` gate `:446`, independent-reviewer rule `:453+`.
- API: `src/app/api/ad-campaigns/route.ts`, `src/app/api/ad-campaigns/[id]/route.ts`
  (bearer-required: `src/lib/bearer-required-routes.ts:69`).
- Gap: **no `.tsx` in this repo calls `/api/ad-campaigns`** (grep over `src/**.tsx` → 0 hits).
  The ad-campaign board is driven by external Skill 48/75 producers, and its stage cards land on
  the shared Kanban rather than a dedicated UI.

Publication:

- Queue write with idempotency and company scope: `src/app/api/skill-35/publish/route.ts:180`
  (`INSERT INTO publish_queue`), readback `:189`, broadcast `:208`;
  status-filtered read `:228` (`GET`).
- Ten publication states, including `verification_required` and `overdue`:
  `src/lib/types.ts:904` (`PublishQueueItem`).
- Surfaces: `src/components/MarketingPublishButton.tsx` mounted per card at
  `src/components/MissionQueue.tsx:1979`, with a truthful persisted-state summary area
  (`src/components/MarketingPublishButton.tsx:261`); `src/components/TaskPublishSummaryPanel.tsx`
  mounted in `src/components/TaskModal.tsx:599`, reading
  `src/app/api/tasks/[id]/publish-summary/route.ts:26` which builds the message via
  `src/lib/social/summary.ts:289` (`buildTaskSummary`) / `:165` (`buildPublishMessage`).
- Approval is **not** part of the publish queue — `PublishQueueItem.status` has no
  `awaiting_approval`. Approvals live in three separate places: recommendation approve
  (`src/app/api/recommendations/[id]/approve/route.ts:10`), ad-campaign artifact envelopes
  (`src/lib/ad-campaigns.ts:403`), and council action-plan approval
  (`src/app/api/council/sessions/[id]/action-plan/approve/route.ts:31`).

## 5. Conversation / fulfillment / follow-up — PARTIAL

Conversation:

- Dashboard `/conversational-ai` with three data calls:
  `src/app/conversational-ai/page.tsx:43` (metrics), `:52` (enriched), `:76` (status).
- Status gate reports Round-3 source presence and Layer 1 vs Layer 2:
  `src/app/api/conversational-ai/status/route.ts:22-31`.
- Metric families: `src/lib/conversational-ai/metrics.ts` — channel volume, objection handling,
  `:213` (`kbHitRate`), `:224` (`discountRedemptions`), `:244` (`followUpPerformance`),
  `:259` (`botSpamVolume`), `:267` (`quietHoursImpact`), `:284` (`pixelFunnel`).
- Eight declarative sources with graceful degradation:
  `src/lib/conversational-ai/sources.ts:217` (`ROUND3_DATA_CONTRACT`); discovery roots
  `:44`; absent source ⇒ `available: false`, never a fabricated number (`:1-17` header contract).
- Conversation with the AI executive is a separate surface: `/hq` chat
  (`src/app/hq/page.tsx`, `/api/hq/chat/sessions*`).

Fulfillment:

- Deliverables per task: `src/app/api/tasks/[id]/deliverables/route.ts`.
- Completion gate that refuses a `done` claim without usable evidence:
  `src/lib/completion-evidence.ts:329` (`collectCompletionEvidence`),
  `:375` (`noEvidenceMessage`), usable-evidence definition `:239` (`EVIDENCE_DELIVERABLE_TYPES`),
  `:258` (`isUsableUrl`), `:269` (`isUsableFile`).
- Publication delivery state is the fulfilment signal for marketing work:
  `src/lib/types.ts:904` + summary route above.

Follow-up:

- Only an **aggregate metric** — write count, distinct contacts, coverage ratio
  (`src/lib/conversational-ai/metrics.ts:244`), read from a client-box JSONL log
  (`crm-field-writes-log.jsonl`, `src/lib/conversational-ai/sources.ts:222`).
- There is no follow-up queue, worklist, due-date, owner or per-contact record in this
  repository. No `conversations` table exists in the migration list.

Why PARTIAL: conversation analytics and fulfillment evidence are real and honest (they say
"unavailable" rather than inventing numbers), but they are a **read-only projection over files
that other skills write**. Follow-up has no operational surface at all — only a ratio.

## 6. Booking / outcome views — PARTIAL (outcomes PRESENT, booking ABSENT)

Booking — **ABSENT**:

- No booking/appointment/calendar table. `src/lib/db/migrations.ts` contains 141
  `CREATE TABLE` occurrences (includes comments and idempotent duplicates; not a table count).
  The only name matching `book|appoint|calendar|availab` is substring noise — `notebooks` /
  `notebook_sources` (`:1606`, `:1619`, matched on "book" inside "notebook"). None is a booking,
  appointment, availability or calendar table.
- No booking route. The `/api/*` inventory (258 handlers) contains no `booking`, `appointment`
  or `calendar` path. One route matches `availab` and is **not** booking:
  `src/app/api/operator/research/availability/route.ts` reports Research-module *provider*
  availability (`{available, selected, providers[]}` — Perplexity/OpenAI/Ollama/xAI key
  discovery, header `:1-18`), which has nothing to do with scheduling. The only other path
  matches are the three `notebook` routes again matching on "book" inside "notebook".
- The only hits are *routing vocabulary*, not capability: department profile
  `src/lib/routing/department-profiles.ts:128-131` ("book a flight", "reschedule a meeting"),
  department config `src/lib/routing/departments.config.ts:887,893`, and a role-library folder
  name `src/lib/role-library-import.ts:138` ("03-appointment-setter").
- The `launch` pages mention appointments only through Council/SOP text
  (`src/app/launch/[launchId]/page.tsx`, `src/lib/council/engine.ts`) — no booking object model.

Outcome views — **PRESENT**:

- Recommendation outcome capture with before/after scoring and improvement math:
  `src/app/api/recommendations/[id]/outcome/route.ts:11` (`PATCH`), validation `:24-31`,
  improvement calculation `:49+`. Effectiveness aggregate:
  `src/app/api/recommendations/effectiveness/route.ts:8` (`GET`) over
  `recommendation_outcomes`. UI: `src/components/ceo-board/RecommendationsSection.tsx:35`
  (pending list), `:48` (effectiveness); actions in
  `src/components/ceo-board/RecommendationEngineCard.tsx:72` (approve), `:107` (dismiss),
  `:127` (save).
- Council outcome recording, prediction-snapshot preserving: route
  `src/app/api/council/sessions/[id]/outcomes/route.ts:26` (`POST`, 200/201 at `:39`), service
  `src/lib/council/composed-services.ts:685` (`recordOutcomeRoute`) which requires the exact
  `verdict_revision` + `verdict_content_sha256` (`:698-706`) and refuses a mismatch (`:16-24`
  route header). UI `src/components/council/CouncilOutcomeForm.tsx:33-37` with an explicit
  not-ready state (`:162-167`) — the form's comment at `:13-15` is stale (the service is now
  wired), but the not-ready branch is a correct honest fallback.
- Company/department outcome grades: `src/app/api/company-health/route.ts:10` (`GET`),
  `src/lib/grading.ts:887` (`computeCompanyHealth`), consumed by
  `src/components/ceo-board/health/CompanyHealthSection.tsx:187` and
  `src/components/ceo-board/redesign/DepartmentPulseStrip.tsx:124`.

Why PARTIAL: the outcome half is genuinely implemented end-to-end; the booking half does not
exist. A client cannot book, reschedule or see a booking through Command Center.

## 7. Kanban lifecycle events + stale-state handling — PRESENT

Live event transport:

- SSE endpoint `src/app/api/events/stream/route.ts:54` (231 lines total).
- Company scoping on the wire: `src/lib/events.ts:409` (`connectionMayReceive`) applied at
  `:525`; operator connections see everything, a company connection never sees another
  company's events.
- Payload projection at the choke point so a thin emitter can never delete rendered fields:
  `src/lib/events.ts:442` (`projectTaskEventPayload`), rationale `:419-441`.
- Emitted task families: `task_created` / `task_updated` / `task_deleted` / `task_message` /
  `activity_logged` / `deliverable_added` / `agent_spawned` / `agent_completed`
  (`src/lib/events.ts:354-359` and the scope switch `:355-395`).

Client consumption:

- `src/hooks/useSSE.ts:293` (`task_created`), `:298` (`task_updated`), `:315` (`task_deleted`),
  `:359` (`deliverable_added`); single shared connection with an owned retry timer
  (`:56` delay, `:62-64` reschedule, `:111` `onerror`), and teardown that clears the timer
  (`:166-168`).

Optimistic moves and conflict recovery:

- `src/components/MissionQueue.tsx:629` (`revertOptimisticMove`) — on a failed PATCH it
  **refetches** the task instead of reverting to a captured status ("MR-27", rationale `:604-627`),
  called from the failed-move path `:693` and the blocked-move cancel path `:715`.
- Drop entry point `:749` (`handleDrop`), column render `:1466`.

Stale-state handling (watchdog, not a prettifier):

- Scheduled every 10 minutes: `src/lib/jobs/stale-task-sweep.ts:65` (`STALE_TASK_SWEEP_CRON`),
  registered in the cron table at `src/lib/jobs/scheduler.ts:765` (invoked `:772`).
- Blocked-card lifecycle windows: `:103` (`resolveBlockedWindows`), re-ping threshold
  `:134`/`:335` (`STALE_BLOCKED_REPING_HOURS`, department-overridable), global defaults
  `:150` (`STALE_TASK_SWEEP_GLOBAL_DEFAULTS`).
- Escalation path: `:426` (`returnToOrchestrator`) and the owner re-ping POST to
  `/api/events` with type `stale_blocked_repinged` (`:355-372`), at-most-once dedup key
  (SWEEP-DEDUP, header `:24-35`), and a loud failure path that refuses to swallow a rejected
  re-ping (`:367-377`). Kill switch: `DISABLE_STALE_TASK_SWEEP` (`:33`).
- Entry point `:529` (`runStaleTaskSweep`).
- Independent state-machine idempotency: producer `seq` monotonic (`src/task_state.ts:97`),
  consumer CAS `revision` (`:114`), stale-seq rejection (`:313`), stale-revision conflict
  (`:412`).
- Page-level staleness honesty: board banner `src/app/tasks/all/page.tsx:130`
  ("Displayed data may be stale. Last task refresh: …"); campaign board
  `src/app/campaigns/[id]/page.tsx:171` (`offline = connected === false && age > 2 × poll`).

Operator tuning surface: `src/app/settings/board-slas/page.tsx:12`, thresholds in
`src/lib/board-slas.ts:63` (keys), `:183` (`loadBoardSlaConfig`), `:232` (`resolveSlaThreshold`).

---

## Client-visible operational status surfaces (what a client can actually see)

| Surface | Where | What it honestly shows |
|---|---|---|
| Health dot | `src/app/page.tsx:476`, `:593`; `src/app/tasks/by-department/page.tsx:326`; tiers `src/components/HealthIndicator.tsx:65` | healthy / degraded / unavailable / checking, from tiered probes that require DB + gateway |
| Build progress | `/onboarding/building` — `src/app/onboarding/building/page.tsx:9-22` | real stage, documents complete/total, ETA, and "needs attention" on failure; a build is never called complete without verification |
| Board card state | `/tasks/all` — `src/components/kanban/StatusPill.tsx`, `src/components/TaskOverviewPanels.tsx:468` | current lifecycle status and the blocked reason/ask |
| Publish state | `src/components/TaskModal.tsx:599` → `src/components/TaskPublishSummaryPanel.tsx`; `src/components/MarketingPublishButton.tsx:261` | persisted stage, next action and owner; ten queue states incl. `verification_required` / `overdue` |
| Campaign sync strip | `src/app/campaigns/[id]/page.tsx:346`, staleness `:171` | live vs polling, last sync, stale/offline warning |
| Conversation metrics | `/conversational-ai` — `src/app/conversational-ai/page.tsx:43-76` | per-family metrics with `available: false` empty states instead of fabricated numbers |
| Recommendations & outcomes | CEO board — `src/components/ceo-board/RecommendationsSection.tsx:35,48` | pending recommendations, approve/dismiss/save, effectiveness aggregate |
| Council verdict & outcome | `/council/[sessionId]` — `src/components/council/CouncilOutcomeForm.tsx` | committed verdict snapshot (read-only) plus outcome entry, with an explicit not-ready state when unwired |

Operator-only equivalents (not client surfaces): `/operator/*`, `/settings/board-slas`,
`/api/health/deep`, `/api/system/status` drawer, `/api/auth/tenant-ready`.

Surfaces that do **not** exist for a client: a client/tenant registry page, per-client
readiness, and any booking view.

## What I did NOT check

1. **No runtime verification.** No app start, no dev server, no database, no test suite, no
   browser. Every claim is static reading of `a92d11d9`. I did not confirm any route returns
   200, any page renders, or any job actually ticks on a running box.
2. **No live database.** Table facts come from `src/lib/db/migrations.ts` source, not from a
   shipped `mission-control.db`. Migration application order on any box was not verified.
3. **No fleet inspection.** No SSH, no PM2, no cron registration on a host, no
   `openclaw.json`, no client box. Whether the stale sweep is enabled in production
   environment variables is unknown.
4. **No external systems.** GHL, OpenClaw gateway, Telegram, KIE, publishing receivers and
   Council model providers were not contacted. The publication and conversation paths are
   verified only as code.
5. **Producers not reviewed.** Skill 35 / 48 / 75 / 57 scripts that write the Round-3 JSONL
   logs and call `/api/ad-campaigns` live outside this repository. I verified the receivers,
   not the emitters — so "does anything actually write these logs" is undetermined.
6. **Coverage of 258 API handlers is sampled, not exhaustive.** I read the handlers named in
   each section plus auth/tenant plumbing. I did not audit every route's authorization,
   every raw status writer, or every `broadcast()` call site.
7. **Not run:** `scripts/ci/fast_guards.py` (prohibited by the task), lint, typecheck,
   `npm test`, Playwright suites. Test presence is not test passing.
8. **Not assessed:** accessibility, responsive behaviour, visual layout, i18n, performance,
   and upgrade/migration safety.

## Counts

- Page routes: **64** `page.tsx` files under `src/app`.
- API route handlers: **258** `route.ts` files under `src/app/api`.
- Scheduled jobs: **35** entries in the `src/lib/jobs/scheduler.ts` `JOBS` cron table (starts
  at `:426`; 36 `expr:` occurrences minus the type declaration line at `:426`).
- Source scale: **1,064** `.ts`/`.tsx` files, **286,343** lines under `src/` combined
  (**215,406** `.ts` + **70,937** `.tsx`).
- Capabilities inventoried: **7** — **3 PRESENT** (lifecycle, campaign/approval/publication,
  Kanban events + stale handling), **4 PARTIAL** (client discovery, setup readiness,
  conversation/fulfillment/follow-up, booking/outcome). Booking itself is **ABSENT**;
  outcome views are PRESENT.
- Distinct repository files cited: **89** (**85** at build time; the repair pass added
  `src/app/api/operator/research/availability/route.ts`, `src/lib/bridge/dispatch.ts`,
  `src/lib/operator/goals.ts` and `src/lib/social/cycle-service.ts`; none removed). All 89
  paths resolve to a file on disk at this commit.
- Product code changes: **0**. Files added: **1** (this file).

---

## ABSENT-claim re-derivation (repair pass PBB-085)

Instrument rule: on this machine `\b` is **non-functional** in `git grep` extended regex — it
returns exit 1 regardless of repository content and manufactures false ABSENT claims. No
word-boundary assertion is used in any check below; patterns are plain fixed strings or
explicit character classes. Every zero-match claim carries a **control** — the same command
shape against a pattern proven to exist in the same corpus. Had a control returned empty the
check would be broken, not the repository. Control output is quoted verbatim.

| # | ABSENT claim | Instrument (run at this worktree's HEAD) | Target result | Control, same shape / proven pattern | Verdict |
|---|---|---|---|---|---|
| A1 | No `/clients` page | `find src/app -name 'page.tsx' \| grep -i 'client'` | rc=1, 0 paths (64 pages total) | `… \| grep -i 'campaigns'` → `src/app/campaigns/[id]/page.tsx`, rc=0 | **holds** |
| A2 | No per-client lifecycle / health / reachability state | `grep -rniE 'last_seen\|reachab\|client_health\|probeclient' src/` | 30 hits in 17 files, all prose about deliverables/routes being "unreachable"; no state field | `grep -rniE 'interview_complete' src/` → 6 matches in 4 files, rc=0 | **holds** — `PublicClient` (`src/lib/clients.ts:48-66`) exposes only connection fields, `interview_complete`, brand/logo, `is_self`, `has_gateway_token`, `has_cf_access`, timestamps |
| A3 | No remote-box probing (`clientToOpenClawTarget` is connection use only) | `grep -rn 'clientToOpenClawTarget' src/` | 17 matches in 8 files: definition `src/lib/clients.ts:323`, comments `:311` / `src/lib/operator/goals.ts:272`, and exactly 3 call sites — `src/app/api/events/client-feed/route.ts:85`, `src/lib/bridge/dispatch.ts:38`, `src/lib/operator/goals.ts:302` | `grep -rn 'getClientContext' src/` → 17 matches in 8 files, rc=0 (incl. `src/app/api/interview/answer/route.ts:523`, `src/app/api/interview/state/route.ts:74`) | **holds** — consumer enumeration corrected (defect D2) |
| A4 | No `.tsx` consumer of `/api/ad-campaigns` | `grep -rln 'ad-campaign' --include='*.tsx' src/` | rc=1, 0 files | `… --include='*.tsx' 'publish-summary'` → `src/components/TaskPublishSummaryPanel.tsx`, `src/components/MarketingPublishButton.tsx`, rc=0; `… --include='*.ts' 'ad-campaign'` → `src/lib/ad-campaigns.ts` + 9 more, rc=0 | **holds** |
| A5 | No follow-up queue/worklist/owner/contact record; no `conversations` table | `grep -in 'CREATE TABLE' src/lib/db/migrations.ts \| grep -iE 'follow\|conversation\|contact'` → rc=1, 0 lines; `grep -rniE 'follow.?up (queue\|worklist)\|follow_?up_queue\|follow_?up_worklist' src/` → rc=1, 0 lines | both empty | same two-stage shape `… \| grep -iE 'publish_queue'` → 3 lines (`:794`, `:6357`, `:6412`), rc=0; `grep -rniE 'followUpPerformance' src/` → 6 lines, rc=0 | **holds** |
| A6 | No booking table; no booking route | `find src/app/api -name 'route.ts' \| grep -iE 'book\|appoint\|calendar\|availab'` → 4 paths, none booking: 3 `notebook` routes (matched "book" inside "notebook") + `src/app/api/operator/research/availability/route.ts`; `grep -in 'CREATE TABLE' src/lib/db/migrations.ts \| grep -iE 'book\|appoint\|calendar\|availab'` → 2 lines, `notebooks` `:1606`, `notebook_sources` `:1619` | 4 + 2 path/table hits, all substring noise or a non-booking route | `… \| grep -iE 'health'` → 6 route paths, rc=0; `… \| grep -iE 'publish_queue'` → 3 lines, rc=0 | **holds at capability level** — the earlier literal sentence "no route … has a … availability path" was FALSE and is corrected (defect D3) |
| A7 | `publish_queue` has no `awaiting_approval` state | `sed -n '898,912p' src/lib/types.ts` + `grep -rn 'awaiting_approval' src/` | status union is exactly 10 values, none an approval state; the single `awaiting_approval` hit is `draft_awaiting_approval` at `src/lib/social/cycle-service.ts:389`, a social-cycle disposition | `grep -rn 'verification_required' src/` → 10 lines, rc=0 | **holds** |

### Rows changed in this repair pass

| Row | Was | Now | Why |
|---|---|---|---|
| Counts, header summary (line ~39) | "`1,064` `.ts`/`.tsx` files under `src/` (70,937 lines)" | 286,343 lines combined (215,406 `.ts` + 70,937 `.tsx`) | D1 — 70,937 is the `.tsx`-only subtotal |
| Counts, source-scale bullet | "**1,064** `.ts`/`.tsx` files, **70,937** lines under `src/`" | same split, 286,343 combined | D1, second occurrence |
| Client discovery, remote-probe bullet | `clientToOpenClawTarget` "consumed only by … client-feed … and interview handlers (`answer/route.ts:523`, `state/route.ts:74`)" | exactly 3 consumers: `events/client-feed/route.ts:85`, `lib/bridge/dispatch.ts:38`, `lib/operator/goals.ts:302`; interview handlers call `getClientContext()` | D2 — named non-consumers, omitted two real ones |
| Booking, table bullet | "none of the enumerated names is a booking… table" | names the substring noise (`notebooks` `:1606`, `notebook_sources`:1619`) | accuracy; keeps the grep reproducible |
| Booking, route bullet | "`/api/*` inventory … has no `booking`, `appointment`, `calendar` or `availability` path" | no `booking`/`appointment`/`calendar` path; `src/app/api/operator/research/availability/route.ts` exists and reports Research-module *provider* availability, not scheduling | D3 — literally false sentence |
| Setup readiness, build-progress citation | `building/page.tsx:20` (stage labels) | `:22` | citation drift (verified: `const STAGE_LABELS` at `:22`) |
| Setup readiness, tenant-ready citation | route `:9`, 403 at `:11` | `missing[]` at `:13`, 403 at `:12` | citation drift (verified) |
| Surfaces table, build-progress row | `building/page.tsx:9-21` | `:9-22` | citation drift |
| Counts, scheduled-jobs bullet | "cron table (`:426+`)" | `JOBS` table starts at `:426`; 36 `expr:` occurrences minus the type declaration line | makes the 35 reproducible |
| Header provenance rows | PBB-064 / rev-lane-c only | adds the PBB-085 repair pass worktree and branch | accuracy |
| Word count in the build receipt | 2,670 | 2,680 (reported by the builder's own receipt outside this file) | citation drift; `wc -w` = 2680 |

No claim was removed. No ABSENT claim was downgraded: all seven still hold at capability level
after re-derivation with a valid instrument and a control per row.

### Operational surfaces — render-component check (repair pass)

Every row of "Client-visible operational status surfaces" was re-checked to name the component
that renders it, at the cited line: `HealthIndicator` export at `src/components/HealthIndicator.tsx:65`,
mounted `<HealthIndicator viewerRole="client" />` at `src/app/page.tsx:476`, `:593` and
`src/app/tasks/by-department/page.tsx:326`; `export function StatusPill` at
`src/components/kanban/StatusPill.tsx:46`; `export function BlockedReasonPanel` at
`src/components/TaskOverviewPanels.tsx:468`; `<TaskPublishSummaryPanel taskId={task.id} />` at
`src/components/TaskModal.tsx:599`; `data-testid="publish-summary-area"` at
`src/components/MarketingPublishButton.tsx:261`; the F36 sync strip comment at
`src/app/campaigns/[id]/page.tsx:346` with the offline derivation at `:171`; the three
`fetch('/api/conversational-ai/…')` calls at `src/app/conversational-ai/page.tsx:43`, `:52`, `:76`;
the two recommendation fetches at `src/components/ceo-board/RecommendationsSection.tsx:35`, `:48`;
and the `state.kind === 'not_ready'` branch at `src/components/council/CouncilOutcomeForm.tsx:162-167`.
All eight rows are accurate; none changed.

### Method note for this pass

Static read-only re-derivation in the `fix-t03` worktree at the repair branch head, which is the
build commit `8b5667eacd6174321d04b157e10a92963ffcdf56`. No app start, no dev server, no
database, no test suite, no network call — so no real database was ever touched.
`scripts/ci/fast_guards.sh` / `fast_guards.py` were not run (prohibited). Nothing was pushed;
no pull request; no merge.
