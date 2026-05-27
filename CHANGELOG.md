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
- PRD v2.1 saved at user's local Downloads: `onboarding ant farm PRD v2.1.md`
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
