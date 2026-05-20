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
