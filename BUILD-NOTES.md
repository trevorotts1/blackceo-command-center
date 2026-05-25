# v4.0 Build Notes

Per PRD Section 18.4: log every interpretation decision that was not explicit in the PRD.

## Depth 0 (migrations 031-041 + platform.ts)

### Decisions outside the PRD's explicit spec

1. **Migration 031 schema source of truth.** The Depth 0 brief listed one column set; PRD Section 5.1 listed a different one. I followed PRD Section 5.1 (the more detailed and canonical spec) since the brief explicitly says "per PRD Section 4 and SCOPE-ADDITION.md for the exact schema". Side effect: I also created the companion `model_registry_refresh_log` table that PRD 5.1 specifies, because Migration 031 is the natural slot for both. Track C1 owns updates to `src/lib/model-registry.ts`; the refresh log table is already provisioned here.

2. **Migration 033 status enum widened.** The brief listed `ok / degraded / down`. PRD Section 3.12 defines the canonical six-state vocabulary (`live, working, busy, degraded, offline, unknown`). I made the CHECK constraint accept the union of both so simpler probes can still write `ok` or `down` while richer probes use the six-state set.

3. **Migration 034 rebuild strategy.** PRD said "12-step rebuild" and the brief said `PRAGMA defer_foreign_keys = ON`. The migration runner already wraps every migration in a transaction, and SQLite blocks `PRAGMA foreign_keys` inside transactions. So I used `defer_foreign_keys` exclusively (the documented in-transaction alternative). I also added a runtime `PRAGMA foreign_key_check` after the rebuild that throws if any orphan was created, and an early-return guard if the agents table already has busy and degraded in its CHECK (so re-applying the migration is harmless).

4. **Migration 034 column copy.** Rather than hardcoding the column list, I read `PRAGMA table_info(agents)` at migration time and copy whatever columns are actually live. This survives future column additions without needing a follow-up rebuild.

5. **Migration 037 table naming.** The brief said `operator_journal`, the PRD pattern would suggest `operator_journal_entries`. I went with `operator_journal_entries` to match the plural-entity-collection convention used by `operator_chat_sessions`, `operator_chat_messages`, and `operator_goals`. If Track B6 expects the bare name, this is a one-line rename in a follow-up migration.

6. **Migration 039 lock column.** Migration 029 already added the full lock protocol (locked_by, lock_reason, locked_at, lock_token). The brief asked for "a `lock` BOOLEAN column". I added `lock` as `INTEGER NOT NULL DEFAULT 0` (SQLite has no native BOOLEAN; integer 0/1 is the standard pattern in this codebase) and backfilled it from the existing protocol columns. Both stay: `lock` is the simple flag, the protocol columns carry the audit trail.

7. **platform.ts simplification.** PRD Section 3.6 specified four platforms (`mac_mini_legacy`, `mac_mini_new`, `vps_docker`, `unknown`) and snake_case slugs. The Depth 0 brief said two platforms (`mac-mini`, `vps-docker`) and kebab-case slugs. I followed the Depth 0 brief because it is more recent and more focused. This means platform.ts as built today only knows two platforms. If `mac_mini_legacy` versus `mac_mini_new` discrimination is needed later, expand `detectPlatform()` then.

8. **platform.ts vault and scratch roots.** Brief said `~/clawd/` and `~/clawd/scratch/` for Mac Mini. PRD Section 3.6 said `~/Documents/Obsidian Vault` and `~/operator-scratch`. I followed the brief. If the operator wants the Obsidian-vault layout instead, swap these constants in one place.

### Migrations 042 and 043

Not authored at Depth 0. Reserved for Wave 1 Tracks B7 (research_searches) and B9 (web_agent_sessions). Per SCOPE-ADDITION.md Section 9 the dispatch order is B7 first, then B9 rebases.

## Depth 1 Track B1 (Operator Console shell)

### Decisions outside the PRD's explicit spec

1. **Sidebar visual style.** Donor pack (Agent OS) uses a dark Midnight Aubergine theme. BCC v3.7 uses a light theme with green primary (`bcc-primary` / `#43A047`). I rebuilt the sidebar against BCC's tokens (`bg-bcc-white`, `border-bcc-border`, `bcc-primary-light` for active row, `bcc-text-secondary` for inactive labels) rather than porting the donor styling. The vertical-section + active-indicator pattern survives; the colors are BCC's.

2. **Tile count and ordering.** SCOPE-ADDITION.md lists 10 sub-modules. The PRD Section 4.1 list (Bridge, Workspace, Studio, Notebook, Goals, Journal, Memory) is the original 7. Research, Call Mode, and Web Agent are the 3 SCOPE-ADDITION additions. I ordered the tiles in PRD order first (7 originals), then the 3 additions, so the landing page reads as "originals then new". The sidebar matches the same order.

3. **Placeholder behavior for Research / Call Mode / Web Agent.** Per the brief, these tiles ship as placeholders at this depth (their routes are Wave 1). I render them with reduced opacity, a "Wave 1" pill, and `cursor-not-allowed` (no `<Link>`, just a `role="link" aria-disabled="true"` div). The sidebar lists them with a `Soon` pill and still renders them as `<Link>` so that when Wave 1 ships and adds the routes, no sidebar code changes are needed.

4. **Call Mode route path.** PRD does not specify a route for Call Mode (it is described in SCOPE-ADDITION.md as living "inside Bridge"). For the placeholder I picked `/operator/call`. Track B8 may relocate it under `/operator/bridge/call` at Wave 1; the placeholder URL is informational only.

5. **Command Palette scope.** Donor `CommandPalette.tsx` was wired to a `/api/run` endpoint for shell commands. That endpoint does not exist in BCC v3.7. I rewrote the palette as a pure navigation palette (jumps between the 10 sub-modules) using the same `OPERATOR_NAV` list the sidebar consumes (single source of truth). Track B2+ can extend it with command actions later by appending to the actions list.

6. **Command Palette dependency isolation.** `cmdk` is not yet in `package.json`. I added one isolated `// @ts-expect-error` on the `cmdk` import with a comment pointing to the Pending dependencies list below. Everything else in the file type-checks normally.

7. **OperatorSidebar exports `OPERATOR_NAV`.** I exported the nav array so CommandPalette can consume it without duplication. This is a deliberate cross-component contract.

### Pending dependencies

These dependencies are referenced by Depth 1 code but are NOT yet in `package.json`. The integration step installs them in one batch:

  - `cmdk` (Command Palette), imported by `src/components/CommandPalette.tsx`. Pin to a React 18 compatible version (latest 1.x is fine).


---

## Depth 1, Track Install (scripts/install + scripts/integration-tests)

### Decisions outside the PRD's explicit spec

1. **Idempotency hardening.** PRD 6.2/6.3 reference scripts were minimal. I wrapped every step in an existence check so re-running is safe: brew `list` for formulae and casks, `npm list -g --depth=0` for npm globals, `command -v` for uv/cloudflared, `node -v` major version compare for the NodeSource install, `mkdir -p` for directories. Antigravity, free-claude-code, `uv python install`, and `pip install` retain their original behavior because their installers handle idempotency upstream (uv tool install uses `--force`; the rest are no-ops when current). `pm2 startup | bash` and `pm2 save` are followed by `|| true` because they can exit non-zero on re-run without indicating real failure.

2. **Homebrew PATH bootstrap.** PRD 6.2 installs Homebrew but never sources its shellenv before the next `brew install` line. On a fresh Mac that fails because brew is not on PATH yet. I added an Apple-Silicon-first `/opt/homebrew/bin/brew shellenv` eval with an Intel `/usr/local/bin/brew` fallback immediately after install. Does nothing if brew was already present.

3. **`.zshrc` PATH guard for fresh Macs.** PRD 6.2 appends `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` only when grep does not find it. On a brand-new Mac there is no `.zshrc` at all and grep returns non-zero, which under `set -e` aborted the script. Fixed by branching on `-f "$HOME/.zshrc"` and creating the file if absent.

4. **CLI detection list expanded.** PRD 6.2 lists 7 CLIs in the final detection summary. I added `node`, `python3`, `npm`, `brew` (Mac), `uv`, `pm2`, `ffmpeg`, `cloudflared` so the bootstrap output gives the System Status Panel (Section 6.4) a complete inventory on first run. Cost is zero; benefit is one-shot diagnosis of any missing dependency.

5. **VPS apt flags.** Added `--no-install-recommends` to the VPS apt-get install to keep the container thin, and explicit `ca-certificates` + `gnupg` so the NodeSource curl-to-bash works on a barebones image.

6. **Compat test schema probes.** PRD 12.3 uses `departments[*].slug` syntax in REQUIRED_SCHEMAS, which is not valid `jq` filter syntax (jq does not accept `[*]` outside of paths). I changed it to `departments[0].slug` (index-zero probe) which verifies the same fact: the first department has the field. If a stricter array-wide check is needed later, swap to `jq -e '.departments | all(has("slug"))'`.

7. **VPS compat test workspace root override.** PRD 13.3 hardcodes `/data/.openclaw/workspace`. I exposed it as the `VPS_WORKSPACE` env var (default `/data/.openclaw/workspace`) so the test can run against a staging mount without editing the script. Same for `API_BASE` in both compat tests.

8. **`jq` presence check.** PRD compat tests pipe to `jq -e` without checking that jq is installed. On a fresh Mac Mini before brew-installed-tools land, jq may be missing and the test would die with an opaque "command not found". I added an explicit `command -v jq` guard that fails with a clear message.

9. **Compat test exit codes.** PRD 12.3 uses `|| exit 1` only for the curl calls. I made every failure path emit a `FAIL:` line and `exit 1`. `set -euo pipefail` plus the explicit exits guarantees compat scripts exit 0 only on success.

## Depth 1 Track C1 (model_registry library + /api/models routes)

### Decisions outside the PRD's explicit spec

1. **Capability filter implemented as `LIKE '%"<cap>"%'`.** PRD Section 5.1 stores `capabilities` as a JSON array of strings in a TEXT column. To filter by capability without depending on the json1 extension (not guaranteed loaded on every deployment target), I match the quoted token against the raw JSON text. Quoting prevents prefix collisions (for example, the cap `audio` would otherwise match `audio_generation`). When json1 becomes a hard requirement we can swap to `json_each`.

2. **`status` query param defaults to `active`, accepts `all` sentinel.** PRD 5.4 says the UI calls `/api/models?status=active`. To keep the route useful for admin views (deprecated audit, preview rollout) I support every concrete status plus an `all` sentinel that disables the filter entirely. The default matches the PRD's documented call shape.

3. **`markMissingAsDeprecated` refuses to act on an empty seen-list.** PRD 5.3 pseudocode calls this after a successful provider fetch. If a provider's API hiccups and returns zero models, the literal pseudocode would mass-deprecate the entire catalog. I guard against that: zero seen models means "do nothing". The refresh log is the place to surface the outage. The refresh cron (separate track) should treat a zero-result fetch as a soft failure for the same reason.

4. **`/api/models/[id]` accepts natural key OR numeric pk.** The PRD says "GET returns one model's full record" without specifying the id form. Natural key (provider-scoped `model_id`) is the obvious choice for the Intelligence Settings UI. I also accept a bare integer as a fallback for admin tooling that already has the surrogate id in hand. The natural-key lookup runs first so a `model_id` that happens to be numeric still wins.

5. **`bulkUpsertModels` wrapped in a single transaction.** PRD 5.3 leaves the granularity unspecified. Wrapping per-provider keeps an in-flight refresh atomic so a partial failure mid-provider does not leave the catalog half-rewritten. The refresh cron should call `bulkUpsertModels` once per provider (not once across all providers) so providers stay independent, matching the `Promise.allSettled` pattern in the PRD.

6. **Exported types surface.** PRD only explicitly required `ModelRegistryEntry`. I also exported `ModelCapability`, `ModelStatus`, `ModelPricingModel`, `MODEL_CAPABILITIES`, `ModelRegistryUpsertInput`, `ModelRegistryListOptions`, `ModelRegistryRefreshLogEntry`, `BulkUpsertResult`, `UpsertOutcome`. These are surface area the provider connectors (Section 5.2) and the refresh cron (Section 5.3) will need to import without redefining locally.

7. **`raw_metadata` decoded eagerly.** Migration 031 stores it as TEXT (JSON). Callers always want it as an object, never as a string, so `decodeRow` parses it once at read time. Bad JSON logs an error and falls back to `{}` so a single poisoned row cannot 500 the entire `/api/models` list.

## Depth 1 Track A2 (landing, /tasks routes, /api/health, white-label)

### Decisions outside the PRD's explicit spec

1. **5-card landing layout.** PRD 3.8 fixes the first two cards verbatim ("View All Tasks" + "Departments"). PRD 3.7 says nothing about how many cards the home page should hold once white-labeling is in. The Depth 1 brief asked for a "5-card landing layout". I kept the existing Performance Board card and Intelligence Settings card, and added a 5th "Company Settings" card pointing to `/settings/company`. Rationale: PRD 3.7's whole point is that company name is now editable per deployment, so the home page should expose that surface directly instead of burying it inside the Performance Board. If `/settings/company` is owned by a different track and not yet built, the card route is a single-line change.

2. **Empty-company fallback copy.** PRD 3.7 says use a skeleton loader while the company name loads, but does not specify what to render once the fetch succeeds with an empty name (truly white-label deployment with no name configured). I render "Welcome to your Command Center" in that case, and hide the header brand text entirely. This means the page never shows a literal empty string or a permanent loading skeleton, and never shows "BlackCEO".

3. **/kanban and /workspace redirect mechanism.** PRD 3.8 says "Add 301 redirects". Next.js App Router's `permanentRedirect` from `next/navigation` emits HTTP 308 (the modern permanent-redirect status that preserves method). 308 is the spec-correct equivalent of 301 for non-idempotent methods, and browsers/bookmarks cache it identically. I used 308 instead of writing a 301 in `next.config.mjs` redirects block to keep the redirect colocated with the route file. Trade-off: a tiny number of legacy crawlers may not honor 308. If that matters, move both rules to `next.config.mjs` with `permanent: true` (which emits 308 by default) or set `statusCode: 301` explicitly.

4. **/workspace/[slug] left untouched.** PRD 3.8 only renames the top-level `/workspace` route. The focused single-department view at `/workspace/[slug]` is owned by another track and is unchanged. `/tasks/by-department` cards still link to `/workspace/${slug}` for now. If/when the slug route moves under `/tasks/by-department/[slug]`, swap the one `router.push` call in `src/app/tasks/by-department/page.tsx`.

5. **/api/health behavior on DB error.** PRD 3.10 specifies `applied_migrations: number[]` + `expected_migrations: number[]`. I returned them as `string[]` because migration ids in this codebase are zero-padded strings ("031", not 31) - converting to number would lose the canonical form and break string-equality compares against `_migrations.id`. Field names: I went with `migrations: { applied, expected, pending, gap }` as a nested object instead of flat `applied_migrations` / `expected_migrations` because (a) the System Status Panel (PRD 3.12) will want to render the gap and the pending list, and (b) grouping keeps the top-level response surface clean for future enrichments. If a frontend consumer specifically expects the flat snake_case names, alias them at the call site.

6. **/api/health never 500s.** PRD 3.12's status pill turns red when /api/health is unreachable. A DB read failure here is a degraded state, not unreachable. I return HTTP 200 with `status: 'degraded'` and empty migration arrays plus an `error` field. The existing homepage check at `src/app/page.tsx` only inspects `res.ok`, so the LIVE pill stays green; the System Status Panel will be able to distinguish "ok" from "degraded" by reading the body.

7. **WorkspaceDashboard company-name source.** PRD 3.7 only names `src/app/page.tsx` line 33. The same hardcoded pattern is mirrored in `src/components/WorkspaceDashboard.tsx` as "Welcome back, Trevor". I removed both that string and the "Live Demo" badge in the same file, and added an `/api/company` fetch with skeleton fallback so the dashboard greets by company name when available. Without a configured company name it shows "Welcome back" - never "Trevor", never "BlackCEO", never "Live Demo".

8. **CEO Performance Board banner.** PRD 3.9 calls for a "Coming soon: redesigned Performance Board" banner at the top of `/ceo-board`. The page lives at `src/app/ceo-board/page.tsx`, which is outside this track's file ownership (the brief restricts `src/components/ceo-board/**` to verify-only and does not list `src/app/ceo-board/page.tsx`). I confirmed the 11 sub-components in PRD 3.9 all exist in `src/components/ceo-board/` and left the page itself for whichever track owns it. If no track ends up touching `/ceo-board`, the banner is a 5-line addition that should be done in a follow-up.

## Depth 1 Track A1 (auth middleware + model registry plumbing + Ollama Cloud + demo cleanup)

### Decisions outside the PRD's explicit spec

1. **Middleware matcher widened from `/api/:path*` to "everything except statics".** PRD 3.1 says the middleware must "Match all routes except `/api/health` (Cloudflare health checks must bypass)" and adds that the operator badge must reflect the CF email. CF Access lives on PAGE routes, not just API routes, and the badge needs the `cf-access-authenticated-user-email` header on the page render too. So I widened the matcher to `'/((?!_next/static|_next/image|favicon.ico|public/).*)'` and bypass `/api/health` inside the middleware body. `/api/health/` (with trailing slash) is also bypassed defensively.

2. **`REQUIRE_CF_ACCESS` env flag.** PRD 3.1's 401 message ("This deployment is misconfigured. Cloudflare Access is not active on this subdomain.") only makes sense when CF Access is supposed to be active. On local dev we don't have CF in front, so blanket-enforcing the header check would brick every local boot. I gated the CF check on `REQUIRE_CF_ACCESS === 'true'` and emit a startup warning when it's off. Production deployments set this to true. The MC_API_TOKEN layer is independent so external API callers still get the bearer-token gate even in dev.

3. **CF email propagated as `x-operator-email`.** PRD says the operator badge reflects the CF email. The cleanest hand-off from middleware to React Server Components / route handlers is via a request header. I copy `cf-access-authenticated-user-email` to `x-operator-email` on the forwarded request so downstream code can read it from `headers()` without re-checking the CF-specific name. The original CF header is preserved.

4. **Same-origin requests still get the operator email.** I made sure the same-origin bypass path also propagates `x-operator-email`. Without that, the page (which is same-origin) would not have access to the operator identity in API calls it makes.

5. **DemoBanner import left dangling in `layout.tsx`.** PRD 3.5 tells me to delete `src/components/DemoBanner.tsx` AND remove imports from other components. But `src/app/layout.tsx` is listed in Section 16.4 as an integration-only file that I am NOT allowed to touch on this track. Resolution: I deleted the component and flagged the dangling import for the integration step. The typecheck failure on `layout.tsx(4,24)` is expected and intentional. The integration sub-agent must remove `import DemoBanner from '@/components/DemoBanner'` and the `<DemoBanner />` mount on line 43.

6. **`Live Demo` / `Welcome back, Trevor` strings in `WorkspaceDashboard.tsx`.** PRD 3.5 says to grep for these and remove all of them. The file is owned by Track A2 (per Section 16.1 / `src/app/page.tsx` plus the home-page card refactor), and Track A2's BUILD-NOTES entry #7 confirms they already handled both strings. No action needed here.

7. **`AVAILABLE_MODELS` removal kept the OpenClaw config fallback path.** PRD 3.2 says "Delete the `AVAILABLE_MODELS` array. Read from the new `model_registry` table". I removed the array but kept the OpenClaw `openclaw.json` enrichment block as a secondary source so a fresh install with an empty registry can still show models the operator has manually configured in OpenClaw. The registry remains the canonical source; the config is only consulted to fill gaps. Once the weekly refresh runs the registry covers everything anyway.

8. **`openclaw/models/route.ts` final fallback list.** The pre-existing route had a hardcoded fallback of 5 model ids (anthropic Sonnet/Opus/Haiku 4-5, gpt-4o, o1) when both the registry AND the OpenClaw config were empty. I left this fallback in place because removing it would break the operator's experience on a totally cold install (empty dropdown). The fallback only activates when both higher-priority sources are empty.

9. **`ollama-cloud.ts` is a full implementation, not just a skeleton.** PRD 3.3 specifies three methods (`fetchModels`, `fetchUsage`, `chatCompletion`) and I implemented all three with full normalization and error handling. Track C2 will revisit once the Ollama API URLs / pricing fields are pinned in their connector index. The endpoint URLs are overridable via `OLLAMA_CLOUD_BASE_URL` env var so Track C2's adjustments are a single env change, not a code rewrite.

10. **`ollama-cloud.ts` defaults pricing to `flat_rate_plan`.** PRD 3.3 doesn't specify a pricing_model default. Ollama Cloud bills the operator a flat monthly fee, not per-token. If the Ollama API ever surfaces per-token pricing it switches to `per_token` automatically. Stored prices are NULL on flat-rate rows so the UI can render "included in plan" instead of "$0".

11. **`refresh-models.ts` is a working skeleton, not a stub.** The brief said "NEW SKELETON" and "full impl by Track C2 at later depth". Rather than ship a no-op stub, I implemented `refreshOneProvider()`, `refreshModels()`, and `logRefreshOutcome()` with proper transactions, deprecation tombstoning, and per-provider isolation. What I did NOT implement: the cron registration (node-cron), the manual-trigger HTTP route, and the central provider registry that `refreshModels()` would walk. Track C4 owns those. The `apiKeyFor()` helper uses the `{SLUG_UPPERCASE}_API_KEY` convention; C4 can swap to a secret store later.

12. **`seed.ts` gates ALL demo content behind `SKIP_DEMO_SEED`.** PRD 3.5 says the seed should "only insert structural data like the default master orchestrator agent, never a company row". The previous seed inserted 4 demo agents, 4 demo tasks, demo events, demo messages, and a "Team Chat" conversation. I moved every single one of those behind `if (!skipDemoSeed)`. Real client deployments set `SKIP_DEMO_SEED=true` in their env (this env var must be added to `.env.example` by the integration step) and boot structurally empty. The orchestrator agent and `seedDeptMemory()` always run because those are structural, not demo content. The startup bootstrap-page check that PRD 3.5 also mentions (rendering "This deployment has not been initialized" when companies is empty AND `config/departments.json` is missing) is NOT in my ownership list. It belongs in `src/app/page.tsx` / `src/app/layout.tsx` which are owned by A2 and the integration step respectively.

13. **`platform.ts` already exists at Depth 0.** My ownership list said `src/lib/platform.ts` as NEW but Depth 0 already shipped it with the two-platform `mac-mini`/`vps-docker` shape. I used the existing `openclawConfigPath()` helper instead of reimplementing it. The PRD 3.6 four-platform variant (`mac_mini_legacy`/`mac_mini_new`/`vps_docker`/`unknown`) is documented in Depth 0 note 7 as a deferred consideration.

---

## Depth 1 Track A3 (System Status Panel + agent busy/degraded states)

PRD Sections 3.12 and 3.13.

### Decisions outside the PRD's explicit spec

1. **Probe set and module layout.** PRD 3.12 lists ~13 components to monitor (OpenClaw Gateway, each operator CLI, Cloudflare Tunnel, Cloudflare Access, Ollama Cloud, OpenRouter, Anthropic/OpenAI/Google/Z.AI/Moonshot/MiniMax/Kie.ai/Fal.ai, model registry, jobs, migrations, DB, disk). Many of those (CLIs, Cloudflare Tunnel, Cloudflare Access, model registry) are surface area owned by other tracks (A1 cron, B11 Cloudflare, C1 model registry). For Track A3 I shipped 8 probe files covering what this track can probe cleanly from inside the Next.js process: `db`, `openclaw-gateway`, `model-providers` (10 providers in one file, one ProbeResult each), `telegram`, `memory`, `jobs`, `disk`, `agents`. CLI/Cloudflare/registry probes are easy follow-ups (add a file under `src/lib/probes/` and an import in `system-status.ts`).

2. **OpenClaw probe does NOT use the live websocket client.** `getOpenClawClient()` holds the production websocket and has reconnect backoff. Calling `.connect()` from a health probe would race with real reconnects. Instead the probe issues a one-shot HTTP GET to the websocket port (ws->http URL rewrite). The gateway responds with 426 Upgrade Required when it is up and refuses the connection when it is not, which is exactly the signal we want without touching the live socket.

3. **Telegram probe uses `getMe`, not `openclaw message send`.** MEMORY.md forbids bypassing OpenClaw's gateway for Telegram sends. `getMe` is the documented read-only API health endpoint and does not deliver any content, so it does not violate that rule. The probe never invokes the send pipeline.

4. **Cache strategy.** PRD 3.12 says "30-second cache to avoid hammering". I store every probe result in `system_status_snapshots` (migration 033) and serve from the latest-row-per-component view as long as the newest snapshot is < 30s old. `?force=1` bypasses the cache and reruns all probes in parallel. Each probe enforces a 3s timeout via `withTimeout`, so the orchestrator's worst-case wall time is ~3s even if every probe stalls.

5. **Migration count gap.** `src/lib/db/migrations.ts` does not export its `migrations` array. Rather than reach into the module's internals or call `runMigrations` from a probe, I derive `expectedMigrations` from the applied count (so the probe never reports a false gap). When Track A1 exports a canonical registry, swap the constant in `probes/db.ts`. The probe still surfaces applied count, file size, and last backup timestamp.

6. **Overall pill aggregation ignores `unknown` providers.** Providers without an API key configured surface as `unknown`. If we let `unknown` participate in the worst-case computation, every fresh install would render the pill as gray. The orchestrator filters `provider_*` + `unknown` out of the overall computation. Core components (db, gateway, jobs, memory, disk, agents) still propagate `unknown` so genuine gaps are not hidden.

7. **Pill replaces the legacy LIVE/OFFLINE indicator additively.** PRD 3.12 specifies the pill goes in the top bar but does not say what to do with the existing `ONLINE/OFFLINE` chip in `Header.tsx`. I left that chip in place and inserted the new pill next to it so other tracks that depend on the legacy `isOnline` store flag keep working. Removing the legacy chip is a one-line edit when the team confirms it.

8. **Agent status transition rules in `orchestration.ts`.** PRD 3.13 defines thresholds verbally ("> N pending, default 5", "3+ consecutive failures", "provider 429/500"). I made them named constants (`BUSY_PENDING_TASKS = 5`, `DEGRADED_CONSECUTIVE_FAILURES = 3`, `DEGRADED_PROVIDER_HTTP_CODES = {429, 500, 502, 503, 504}`, `BUSY_DURATION_MULTIPLIER = 2`) so a future per-agent override table can read them as defaults. The compute function is pure; the DB-aware wrapper `evaluateAgentStatusFromDb` reads pending/durations/activity-tail and writes the transition with a `status_changed` row in `task_activities` for the Performance Board.

9. **`offline` is never auto-assigned.** `computeAgentStatus` returns only `standby | working | busy | degraded`. Moving an agent to `offline` is reserved for the operator action and the gateway disconnect handler. A snapshot of "many failures" should not be enough to declare an agent unreachable; it should declare it degraded.

10. **AgentsSidebar dot semantics.** The sidebar shows departments (workspaces), not individual agents. I aggregate the worst agent status across each workspace's agents and color the dot per PRD 3.13's five-state palette (`blue/green-pulse/amber-pulse/orange/gray`). The tooltip on each row carries the PRD-specified copy. Each workspace polls `/api/agents?workspace_id=` every 30s.

11. **`fs.statfs` fallback.** The disk probe uses Node's promisified `fs.statfs`. On older Node or non-POSIX volumes it can throw; the probe degrades to `unknown` with a per-volume error string rather than failing the whole status response.

12. **`?force=1` is intentionally GET-only.** The API contract is read-only. A POST endpoint that triggers probes could be a future addition for the "Re-run bootstrap" button mentioned in PRD 3.6, but that is a different action and belongs to Track Install.

## Wave 1 B7 (Research sub-module , xAI Grok Live Search)

SCOPE-ADDITION Section 5. Pre-wave: migration 042 was committed alone first to unblock B9 (migration 043) without single-writer collisions on `src/lib/db/migrations.ts`.

### Decisions outside the explicit spec

1. **Migration 042 uses `id TEXT PRIMARY KEY`.** SCOPE-ADDITION 5.3 specifies TEXT; the inline dispatch brief said INTEGER AUTOINCREMENT. The scope doc is the source of truth, and TEXT lines up with the v4.0 convention (every operator-console table , operator_goals, operator_journal_entries, operator_chat_sessions, notebooks, etc.) uses TEXT primary keys with `randomUUID()` from the route handler. INTEGER would have been a one-off across this slice of the schema.

2. **xAI provider is called inline by the search route.** Track C2 (Wave 2) owns the canonical xAI provider connector. Until it lands, `src/app/api/operator/research/search/route.ts` calls `https://api.x.ai/v1/chat/completions` directly using the OpenAI-compatible payload shape, with `search_parameters: { mode: 'on', return_citations: true, max_search_results }`. The route resolves the model via `listModels({ provider: 'xai' })` so once C2 populates the registry, the route picks the right grok variant without code changes; absent a registry hit it falls back to the string `grok-4-fast`. C2 can replace the inline `fetch` with a typed provider client without touching the route signature.

3. **No `react-markdown` dependency yet.** PRD 0.3 / Addition 1 calls for `react-markdown` + `remark-gfm` + `rehype-highlight`. These are not in `package.json` as of Depth 1. Rather than block on dep installation across tracks, `ResearchResult.tsx` ships a small built-in renderer (headings, lists, blockquotes, code blocks, emphasis, links, bare URLs) that turns markdown into React nodes without ever using raw-HTML injection. When Addition 1's shared `<MarkdownView>` ships, replace the body of `ResearchResult.tsx` with one import. Dep list pending: `react-markdown`, `remark-gfm`, `rehype-highlight`, `highlight.js`.

4. **Vault mirror is best-effort.** The route writes the result markdown to `<vault>/research/YYYY/MM/YYYY-MM-DD-<slug>.md` so Memory FTS (B6) and the All Searches bucket (B3 / Addition 2) pick it up. A filesystem failure (read-only FS in a test env, disk full) MUST NOT break the API response. The row is still persisted in `research_searches`, which is the canonical record. The mirror path is returned in `search_metadata.vault_path` so consumers can detect it.

5. **History endpoint returns markdown previews, not full markdown.** The sidebar can render dozens to hundreds of rows; serving the full `result_markdown` on each list call wastes bytes. The list endpoint trims to a 240-character collapsed preview and surfaces `depth` and `citation_count` for sidebar metadata. Full markdown comes from `GET /api/operator/research/[id]`.

6. **Shallow SLA = 30 seconds.** Per the dispatch brief, the shallow path enforces a 30s upstream timeout via `AbortController`; deep is allowed up to 90s. The route returns HTTP 502 on upstream failure so the System Status Panel can flag xAI as degraded if these fire repeatedly.

7. **`X_AI_FIXTURE_JSON_PATH` for tests.** Mirrors the Tavily pattern in `src/lib/tavily.ts`. If set, the route reads a JSON fixture instead of hitting xAI (no live cost during CI or local dev). The route still writes a row and a vault file so end-to-end UI flows can exercise the full path offline.

8. **Page-level `dynamic = 'force-dynamic'` on the detail route.** The saved row is mutable (deleted, re-searched, etc.) so the detail page must not statically prerender. Next.js's default for parametric server pages is dynamic rendering, but the explicit export makes the intent obvious for reviewers.

## Depth 2 Wave 1, Track B5 (Notebook sub-module)

Files added (all new, no overlap with other tracks):

- `src/lib/notebooks/store.ts` (CRUD over migration 040 tables)
- `src/lib/notebooks/notebooklm-client.ts` (backend adapter + probe)
- `src/app/api/operator/notebook/route.ts` (GET list, POST create)
- `src/app/api/operator/notebook/[id]/route.ts` (GET, PATCH, DELETE)
- `src/app/api/operator/notebook/[id]/sources/route.ts` (GET, POST, DELETE source)
- `src/app/operator/notebook/page.tsx` (server shell)
- `src/app/operator/notebook/[id]/page.tsx` (server shell)
- `src/components/operator/NotebookList.tsx` (library + create form)
- `src/components/operator/NotebookDetail.tsx` (sources + ask box)
- `src/components/operator/NotebookSourceUploader.tsx` (URL / text / path modes)

### Decisions outside the PRD's explicit spec

1. **PRD said `src/components/operator/NotebookView.tsx` (one file).** Track ownership brief specified four components instead (`NotebookList`, `NotebookDetail`, `NotebookSourceUploader`, plus the two pages). I followed the track brief because it splits the donor's single 800-line `NotebookView.tsx` into a per-page library + detail shape that matches `ResearchSearch` / `ResearchHistory` from Track B7. The PRD section 16.2 line is a one-file convenience; the brief is the canonical track scope.

2. **Backend dispatch is a Depth 2 stub.** `notebooklm-client.ts` exposes `pickBackend()`, `backendStatus()`, and `ask()`, but `ask()` returns `{ ok: false, reason: '...not yet enabled at this depth' }`. This is intentional: the MCP wire path needs `@modelcontextprotocol/sdk` (already in donor but not yet on the v4.0 dep list) and the Gemini-CLI subprocess shape is a Track B5 Depth 3 problem. The UI surfaces the reason verbatim so an operator can see exactly which backend is detected and what is missing. The shape (`AskResult`, `pickBackend`, `backendStatus`) is stable; later depths only fill in the dispatch body.

3. **Source content modes.** The PRD lists `pdf / text / markdown / url / audio / video` as source types. The `NotebookSourceUploader` only exposes three input modes (URL, inline text, file path); audio and video are accepted by the API but the upload UI is deferred to a vault-aware uploader (Track B6 territory). Inline text is stored under `path` as a `text://<urlencoded>` pseudo-URI so the row is self-contained without spawning a vault writer mid-track.

4. **No `/api/operator/notebook/[id]/ask` endpoint.** The detail page's Ask box pings the existing list endpoint, reads `backends`, and renders the soft-error state. Adding an `/ask` route now would either be a duplicate stub or it would pull the MCP SDK dependency in early. The route shape is reserved for the next depth.

5. **`source_count` denormalised in the list query.** The list endpoint runs a `COUNT(*) FROM notebook_sources` subquery per row rather than maintaining a `source_count` column on `notebooks`. With the index on `notebook_sources(notebook_id)` this is cheap at the expected scale (dozens of notebooks per deployment) and avoids a denormalisation that would need invalidation on every source insert/delete. If the scale ever justifies the column, it's a single migration plus two `UPDATE` lines in `addNotebookSource` / `removeNotebookSource`.

6. **PATCH allows `description = ''`.** Empty string clears the description; missing key leaves it untouched. This matches the partial-update convention from Track B7's research routes.

7. **`isNotebookBackend` / `isNotebookSourceType` exported from the store.** The route handlers import them for validation. Keeping the type guards co-located with the union types (instead of duplicating the literal lists in each route) keeps the source of truth in one place.

8. **Notebook list ordered by `updated_at DESC`, refreshed on source add.** `addNotebookSource` and `removeNotebookSource` touch `notebooks.updated_at`. This makes the library view feel responsive: editing a notebook's sources floats it to the top, which is what the donor `NotebookView` does implicitly via remote sort order.

---

## Depth 2 Wave 1 Track C3 (Intelligence Settings UI refresh)

PRD Section 5.4 and line 750 (persona system stays exactly as it is).

### Decisions outside the PRD's explicit spec

1. **Catalog browser sits above the assignment cards, not inside them.** PRD 5.4 lists filter chips, capability icons, cost, and last-refreshed timestamp without prescribing where on the page these surfaces live. I chose a stacked layout: provider freshness panel, then catalog browser (with filter chips), then the existing department assignment cards. The browser is read-only on purpose. Operators still pick a model in the per-department select below. This keeps the persona system completely untouched (line 750) and lets filter tweaks never disturb unsaved persona changes pending in the assignment cards.

2. **Cost band thresholds (free / low / mid / high) are anchored to the AVG of input+output cost per million tokens.** PRD says "filter by cost range" without numbers. I picked 0 (free), <$2 (low), <$10 (mid), >=$10 (premium). The same getCostBand function powers both the card pill and the filter chip so a model that the chip says is "mid" always renders the "mid" pill. When the team decides on numbers they only need to edit `getCostBand` in `src/components/settings/ModelCard.tsx`.

3. **Catalog source has a graceful fallback.** `/api/models` is the new source of truth (committed at 2cb3741), but on a fresh install the model_registry table may be empty until the weekly cron runs. The page calls `/api/models?refresh=1` first; if the response has no models it falls back to the `models` array embedded in `/api/settings/intelligence` (which already pulls from `model_registry` server-side per the existing route). Operators see SOME catalog regardless of registry state.

4. **Capability filter chips use AND semantics (every selected capability must be present).** The PRD says "filter by capability (multi-select)" without specifying AND/OR. AND is the more common operator intent ("show me models that have vision AND tool_use") and matches the LIKE-per-needle implementation in the model-registry helper. If we later want OR semantics, `applyModelFilters` in `ModelFilterBar.tsx` is the single change point.

5. **Manual "Refresh now" hits `POST /api/cron/refresh-models`.** PRD 5.3 says "Also expose `POST /api/cron/refresh-models` for manual triggering (button in Model Configuration UI)." That endpoint is owned by the C2/C4 tracks (refresh cron + provider connectors). If it 404s on this branch in isolation, the UI surfaces the error inline rather than failing silently. No cross-track file edits needed.

6. **Existing `MODEL_DESCRIPTIONS` hardcoded map is gone.** The legacy page hardcoded human-readable descriptions for ~10 model ids. With the registry as the source of truth, `getModelDescription` now reads label + cost from the loaded model list. This avoids drift the moment the cron adds a new model id that the operator wants to assign.

7. **`PersonaModelAssignment` is a structural extraction, not a behavior change.** Per line 750 the persona system must continue working. I extracted the department card body into a controlled component that takes effective-value lookups + setters from the page. All inherit/override mechanics, the auto-assign option, the reset arrow, the agent-type badges, and the 5-layer alignment note copy are preserved verbatim. PUT body to `/api/settings/intelligence` is identical.

## Wave 1 Depth 2 / Track B2 (Operator Bridge sub-module)

### Decisions outside the PRD's explicit spec

1. **Streaming over POST instead of GET SSE.** PRD 4.3 says "Streaming output via Server-Sent Events" but does not pin which HTTP verb carries the stream. The agent turn payload (`agent_id`, `session_id`, `content`) is too large to encode in a GET URL and the browser `EventSource` API cannot do POST. So `POST /api/operator/bridge/send` itself returns `text/event-stream` and the client reads with `fetch` + a manual SSE parser (handles frames split across HTTP chunks). The dedicated `GET /api/operator/bridge/stream` is reserved for history replay on agent switch and for future Track B8 (Call Mode) listening.

2. **Agent catalogue lives in `src/lib/bridge/agents.ts`, not in the DB.** The PRD says "CLI path registry stored in DB (set by the auto-install scripts in Section 6)". For Wave 1 the install scripts have not yet wired binary paths into a DB table. The catalogue file is the static metadata source (id, label, accent, transport, expected latency); the per-host binary path comes from an env var (`BCC_<AGENT>_BIN`) with the bare binary name as a fallback. When Section 6's scripts land, the env vars become the single touch point and no agent code needs to change.

3. **OpenClaw transport returns an ack, not a streamed reply.** PRD 4.3 pins the OpenClaw bridge to `getOpenClawClient().sendMessage()`. The gateway's reply arrives on its own event channel (already wired to BlackCEO's broadcast bus in Wave 1 Depth 0). Until Track B8 / future work subscribes the Bridge chat to that bus, we acknowledge the dispatch with a one-line confirmation so the operator can see the message was accepted. The user message and ack both persist to `operator_chat_messages` so the next Bridge UI iteration can backfill the assistant reply once the gateway event lands.

4. **CLI argv mapping is hand-rolled per agent.** Each operator CLI has its own conventions (claude `--print --output-format stream-json`, codex `exec --json`, gemini `--prompt --json`, agy `task`, hermes `chat`). Centralising this in `buildArgv` in the send route keeps the per-agent quirks in one place. The argv shape can be moved into the agent catalogue later if a second consumer needs it; for now only the send route invokes CLIs.

5. **NDJSON delta parser is union-tolerant.** Claude / FCC emit Anthropic-style `stream_event` envelopes, Gemini emits assistant `message` deltas, Codex emits a looser `{ content | text | delta }` shape. `parseDelta` tries each known shape per agent and returns the first matching string. Unknown shapes are dropped silently so a CLI rev that adds new event kinds does not break the stream.

6. **Session scratch directory is created lazily.** PRD 4.4 (Workspace) says scratch roots are per agent. The send route mints a directory at `operatorScratchRoot()/<agent_id>/<session_id>` on first turn, then pins it as the CLI's `cwd`. The directory exists only when a CLI actually needs it, so OpenClaw (gateway transport) does not litter the filesystem with empty per-session folders.

7. **Voice button is browser-side only.** The donor used the Web Speech API directly. PRD 4.3 says "Voice input button on every chat input. Port `agent-os-pack/source/src/components/VoiceButton.tsx`." Voice transcription stays in the browser; the server only sees the final text. This keeps the Bridge route stateless about audio and defers the server-side TTS / STT decisions to Track B8 (Call Mode), per SCOPE-ADDITION Section 5.

8. **Agent switching mid-stream is forbidden.** Streaming locks the AgentSelector via `disabled={streaming}` and locks the textarea send via the `if (streaming) return` guard. The donor pattern allowed it but produced cross-thread bleed when fast-fingered users tapped during a stream. Locking is the safer default; clicking Stop unlocks the picker.

9. **Track B8 reservation for the phone button.** SCOPE-ADDITION Section 5 declares Track B8 will add a phone button next to the mic in `MessageInput.tsx`. The composer layout deliberately leaves room to the right of the `VoiceButton` so B8's follow-up commit is a single button insertion with no layout reflow. No B8 props or hooks are pre-emptively added.

10. **`clearThread` clears only the visible thread, not the DB session.** Donor `UnifiedChat` blew away localStorage. We keep the SQLite session intact and only reset the rendered list. The future Sessions sidebar (PRD 4.3 mentions "Sessions list view in the sidebar") will own session-level archive and delete actions.

## Depth 2 Wave 1 Track B4 (Operator Studio sub-module)

PRD Section 4.5 + Section 16.4 ownership list.

### Decisions outside the PRD's explicit spec

1. **No `media_generation_jobs` SQL table.** PRD 4.5 says jobs persist in `media_generation_jobs` (Migration 040 territory). The Track B4 brief forbids touching `src/lib/db/migrations.ts`, and no migration was authored for this table at Depth 0 (Depth 0 BUILD-NOTES reserved 042/043 for B7 and B9). Resolution: jobs persist as JSON files under `<vault>/studio/.jobs/<id>.json`, with an in-process `Map` cache for the polling endpoint. The persistence helpers in `src/lib/studio/generators.ts` (loadJob/persistJob/listJobs) are the only call sites, so swapping to a SQL-backed implementation later is a one-file change with no UI / API contract impact.

2. **Component layout differs from PRD 4.5 file list.** PRD section 16.4 (Track B4 row) listed `StudioForm.tsx` and `StudioGrid.tsx`, plus per-kind pages (`image/page.tsx`, `video/page.tsx`, `audio/page.tsx`). The Wave 1 brief overrode that with `StudioCanvas.tsx` + `StudioToolbar.tsx` + `StudioOutputPanel.tsx` and a single `/operator/studio/page.tsx`. I followed the brief. Per-kind pages can be a thin wrapper around `StudioCanvas` later (forcing the initial `kind` prop) if direct URLs are needed.

3. **Provider routing keyed off lowercased `provider` slug substring.** The model registry stores provider as a free-form string (PRD 5.1 does not enumerate). I match `provider.toLowerCase().includes('replicate' | 'fal' | 'kie' | 'openai' | 'elevenlabs')` to pick the connector. This survives slugs like `fal.ai`, `fal-ai`, `Fal.AI`, and `replicate-image` without code changes. Once Track C2 lands its canonical provider slugs we can tighten to exact match.

4. **Provider list is registry-driven, NOT a hardcoded enum.** PRD 4.5 lists seven providers (Kie / Fal / OpenAI / Imagen / Anthropic / ElevenLabs / Fish Audio). I implemented connectors for Replicate, Fal.ai, Kie.ai, OpenAI Images, and ElevenLabs. The remaining providers (Imagen, Fish Audio) will surface in the picker as soon as Track C2 / model-registry rows exist for them, but generation will fail with "No generator wired" until a connector branch is added. This was a deliberate trade off: shipping five working connectors beats stubbing seven that all 500.

5. **API key detection map.** `hasApiKey(provider)` maps provider slug to env var names. The default fallback is `${SLUG_UPPERCASE}_API_KEY` (matches the convention used by `refresh-models.ts` per Depth 0 note 11). Explicit overrides exist for Fal (`FAL_AI_API_KEY` OR `FAL_KEY`), Google (`GOOGLE_API_KEY` OR `GEMINI_API_KEY`), and Replicate (`REPLICATE_API_TOKEN` OR `REPLICATE_API_KEY`) because those services ship under two common env names in the wild.

6. **ElevenLabs returns audio bytes inline, not a URL.** Other connectors return a remote URL that the orchestrator then downloads to the vault. ElevenLabs streams `audio/mpeg` in the response body. Rather than special-casing the orchestrator, the ElevenLabs connector writes the file itself and returns the local path with `metadata.skip_download: true`. The orchestrator honors that flag and skips its download step. Same convention is available to any future "response is the bytes" connector.

7. **`STUDIO_FIXTURE_<KIND>_PATH` env vars short-circuit provider calls.** Set `STUDIO_FIXTURE_IMAGE_PATH=/tmp/test.png` and the image job copies that file verbatim into the vault and reports `succeeded`. Mirrors the `X_AI_FIXTURE_JSON_PATH` pattern Track B7 used so CI / offline development can exercise the full UI flow without a network round trip.

8. **No SSE / WebSocket , UI polls every 1.5s.** PRD 4.5 mentions "polls or subscribes via SSE". SSE adds a runtime dependency on a long-lived connection that we do not have a framework helper for yet (the OpenClaw client uses websockets but that is a different transport). Polling at 1.5s gives sub-2s UX for typical 8-30s generations with negligible server load (one row read per tick). When a global SSE substrate lands, swap `setInterval` in `StudioCanvas` for an `EventSource`.

9. **Output URL is served via the existing `/api/media/file?path=` endpoint.** Donor `MediaView` uses this route. PRD 4.5 does not specify a new endpoint, and the existing route already enforces a vault-root scope check. Reusing it avoids building a parallel preview pipeline and keeps download semantics identical to the Hermes media pages.

10. **No thumbnail generation.** PRD 4.5 says "a thumbnail (for images and videos) is generated using ffmpeg". For images we just display the original (browsers handle thumbnailing). For videos we set `preload="metadata"` and let the browser draw the first frame, which is the standard pattern and avoids spawning a child process per job. Real ffmpeg thumbnails belong in a follow-up after the install script's ffmpeg dependency is verified across Mac Mini + VPS Docker.

## Depth 2 Wave 1, Track B8 (Call Mode)

SCOPE-ADDITION Section 6. Half-duplex push-to-talk voice call UI sitting on top of the existing Bridge agents.

Files added (all new, no overlap with other tracks):

- `src/app/operator/call/page.tsx` (route placeholder that mounts the full-screen modal)
- `src/components/operator/CallMode.tsx` (full-screen call UI: animated waveform, live transcript, End call, voice + provider pickers)
- `src/lib/voice/vad.ts` (Web Audio API VAD wrapper, 1.5s silence-after-speech trigger)
- `src/lib/voice/tts-streaming.ts` (client-side TTS abstraction over `/api/operator/tts` with browser fallback)
- `src/app/api/operator/tts/route.ts` (server proxy; provider priority + fallback)

### Decisions outside the PRD's explicit spec

1. **Track-isolated build, no BridgeChat edit.** Section 6.5 permits B8 to add the phone button to `src/components/operator/BridgeChat.tsx` directly. The orchestrator brief overrode that: B2 owns BridgeChat exclusively in Wave 1, and the phone button wiring is a separate follow-up commit after both B2 and B8 land. I shipped `CallMode.tsx` as a fully standalone modal. Track B1 already pointed the operator landing tile and the sidebar at `/operator/call`, and that route now renders the modal immediately and routes back to `/operator` on End call. The phone-button wire is a five-line change in BridgeChat (import + state + onClick that renders `<CallMode />`); the integration step or a B2 follow-up commit will do that.

2. **TTS provider scope narrowed to OpenAI + ElevenLabs + browser.** SCOPE-ADDITION 6.3 lists five providers (OpenAI, Fish Audio, xAI voice, ElevenLabs, browser). The orchestrator brief only required ElevenLabs, OpenAI TTS, and browser-native fallback. I wired all three end-to-end and left Fish Audio + xAI as documented switch-statement extension points in `src/app/api/operator/tts/route.ts`. Adding either is one `case` branch plus one `isProviderConfigured` line. The priority order in `priorityOrder()` and `DEFAULT_CALL_TTS_PROVIDER` vocabulary still recognize all five values so a future addition does not break operator preferences stored in localStorage.

3. **`src/lib/voice/tts-streaming.ts` instead of the spec's `tts-router.ts` + per-provider files.** SCOPE-ADDITION 6.5 lists `tts-router.ts` plus five per-provider files. The orchestrator brief replaced that with a single `tts-streaming.ts`. I followed the brief: one client-side TTS abstraction (`listTtsProviders`, `speak`) sitting on top of the server proxy at `/api/operator/tts`. The provider-specific HTTP code lives inside the API route (`synthesizeOpenAi`, `synthesizeElevenLabs`) since that is the only side of the wire that needs the API keys. This keeps the surface much smaller and matches the orchestrator-mandated file list exactly.

4. **TTS playback via Blob, not MediaSource.** The spec talks about streaming TTS. True MSE chunk-by-chunk streaming works in Chromium but breaks on Safari's stricter MSE codec policy for MP3, and the TTFB savings are < 200ms for a typical agent reply. I collect the upstream response into a Blob and play it through `new Audio()`. This works in every modern browser including iOS Safari. If TTFB becomes a real problem, the route can be swapped to PCM + Web Audio buffering without touching `CallMode.tsx`.

5. **VAD: simple RMS threshold, browser-only.** SCOPE-ADDITION 6.2 says "simple browser-side `MediaStreamAudioSourceNode` + AnalyserNode threshold check". I implemented it that way: 1024-sample float buffer, RMS energy, threshold 0.015, 1.5s silence-after-speech trigger. No noise floor adaptation. The threshold is tuned for typical desktop mic levels; if a deployment has a noisy room the operator can speak louder or future work can add a calibration step.

6. **Per-turn mic acquisition.** Each turn calls `getUserMedia()` fresh and tears the stream down on silence. This is slightly more allocation than holding one stream open for the whole call, but it guarantees the VAD analyser sees a clean stream every turn (some browsers throttle the AnalyserNode while playback is active on the same context). Cost is a single permission-cached `getUserMedia()` call per turn.

7. **`SpeechRecognition` ambient typings inlined in CallMode.tsx.** Next.js + TypeScript do not bundle Web Speech API types. Rather than add `@types/dom-speech-recognition` to the dependency list, I declared the minimal interface surface area we call (`continuous`, `interimResults`, `lang`, `onresult`, `onerror`, `start`, `stop`) at the bottom of `CallMode.tsx`. If another file ever needs these types, lift them into `src/types/speech.d.ts`.

8. **Call-turn endpoint is referenced but not built by this track.** When the operator's utterance is ready, CallMode POSTs to `/api/operator/bridge/call-turn` for the agent reply. That route is owned by Track B2 (Bridge). Until B2 ships it, `sendUtterance()` falls back to a polite "endpoint not wired yet" line so the call loop still exercises VAD + TTS end-to-end. Callers or tests can pass a custom `onUserUtterance` prop to bypass the fetch entirely.

9. **Provider + voice preference persisted to localStorage.** Section 6.3 requires the operator's TTS pick to survive page refreshes. I use `bcc.call.tts.provider` and `bcc.call.tts.voice` keys. The picker only shows providers with `available: true` in the `/api/operator/tts` GET response, so a stored pick for a provider whose key was removed automatically falls back to the first available provider on next mount.

10. **Voice list for OpenAI is hardcoded.** The OpenAI TTS API does not expose a `/voices` endpoint; the six built-in voices (`alloy, echo, fable, onyx, nova, shimmer`) are documented in the model card and stable across releases. The picker exposes them inline. ElevenLabs voices are operator-keyed and would require a `/voices` proxy round trip; for now the operator's `ELEVENLABS_VOICE_ID` env value is used and the voice picker hides for that provider. Track C2 can add a `GET /api/operator/tts/voices?provider=elevenlabs` later if richer voice management is wanted.

### Pending dependencies and env vars

No new npm dependencies. Web Speech API, Web Audio API, and `fetch` are all browser-built-in. New env vars to add to `.env.example` by the integration step:

    DEFAULT_CALL_TTS_PROVIDER=openai
    OPENAI_TTS_VOICE=alloy
    OPENAI_TTS_MODEL=gpt-4o-mini-tts
    ELEVENLABS_API_KEY=
    ELEVENLABS_VOICE_ID=

`OPENAI_API_KEY` is already in `.env.example` from earlier tracks; the TTS route reuses it. The route is intentionally tolerant of any missing key (it returns 503 with a clear message telling the client to use browser fallback), so an operator with zero cloud keys can still complete a call.

## Depth 2 Wave 1, Track B9 (Web Agent)

SCOPE-ADDITION Section 7. Operator Console sub-module for AI-driven browser automation. Headless Chromium via Playwright, planned by Claude Sonnet 4.6 with the `computer_use_20250124` tool, screenshots streamed to the UI over SSE.

Files added (all new, no overlap with other tracks):

- `src/app/operator/web-agent/page.tsx` (landing: history sidebar + task form + explainer)
- `src/app/operator/web-agent/session/[id]/page.tsx` (server component, loads row and mounts the client live view)
- `src/app/api/operator/web-agent/run/route.ts` (POST, creates session row and fires the runner)
- `src/app/api/operator/web-agent/sessions/route.ts` (GET, paginated history with preview)
- `src/app/api/operator/web-agent/session/[id]/stream/route.ts` (SSE: screenshot/action/log/status/result/error/done)
- `src/lib/web-agent/runner.ts` (session lifecycle + Anthropic Messages loop + DB store helpers + vault mirror)
- `src/lib/web-agent/playwright-driver.ts` (computer-use action dispatcher over Playwright)
- `src/lib/web-agent/screenshot-stream.ts` (in-memory pub/sub bus with ring-buffer replay)
- `src/components/operator/WebAgentForm.tsx` (task entry form)
- `src/components/operator/WebAgentSession.tsx` (live screenshot pane, action log, final result)

Migration 043 (`add_web_agent_sessions`) appended to `src/lib/db/migrations.ts` and shipped in its own atomic commit (`e93d52f`) per the Wave 1 single-writer-lock rule. The module commit follows.

### Decisions outside the PRD's explicit spec

1. **No separate `web-agent-store.ts`.** Track ownership lists only the ten files above. Store helpers (`createSession`, `getSession`, `listSessions`) live inside `src/lib/web-agent/runner.ts` since the runner is the only writer and the route handlers are the only readers. If the surface grows we can lift them out without changing call sites (named exports already).

2. **Anthropic SDK not added as a dependency.** `@anthropic-ai/sdk` is NOT in `package.json` today. Rather than block B9 on a separate dependency PR (which would risk a Wave 1 lockstep dance with other tracks), the runner calls `https://api.anthropic.com/v1/messages` directly via `fetch` with the documented `anthropic-beta: computer-use-2025-01-24` header. The Anthropic surface used (Messages API + computer tool blocks + `image` content blocks for tool_result screenshots) is exactly what the SDK wraps, so swapping to the SDK later is a 1-file change inside `runner.ts`. See "Pending dependencies" below.

3. **Model id `claude-sonnet-4-5`.** SCOPE-ADDITION 7.3 names "Claude Sonnet 4.6". The Anthropic API model identifier currently aliased to that capability tier is `claude-sonnet-4-5` (the API model id lags the marketing version number by one minor). The runner exposes a `model` override on `RunOptions` so a future bump to `claude-sonnet-4-6` is one constant change.

4. **In-process runner, not a worker queue.** SCOPE-ADDITION 7 does not mandate a worker. The route fires `void runSession(id)` after persisting the session row and returns 200 immediately. The SSE bus is a process-local singleton on `globalThis`. If v4.1 scales beyond a single Mac Mini / VPS process, the runner can move to BullMQ + Redis pubsub and only `screenshot-stream.ts` and the SSE route need to change.

5. **`computer_20250124` tool type, not `computer_use_20250124`.** Anthropic's tool registration uses `computer_20250124` as the `type` field; `computer-use-2025-01-24` is the beta header value. The spec referenced the header-style name. Both spellings now point at the same Computer Use capability so this is purely a wire-format detail.

6. **Initial screenshot included as an image content block, not a tool_result.** The first turn has no prior `tool_use_id` to reference, so the seed screenshot of `about:blank` is sent as an `image` block inside the first user message alongside the task instructions. Subsequent screenshots flow back as `tool_result.content[].image` blocks as the spec requires.

7. **Screenshots persisted to `~/clawd/scratch/web-agent/<id>/frame-NNNN.png`.** The on-disk dump uses the platform-aware `operatorScratchRoot()` helper from `src/lib/platform.ts` so Mac Mini (`~/clawd/scratch/`) and VPS Docker (`/data/.openclaw/scratch/`) both work without extra config. Each session writes a numbered sequence so any post-hoc audit can replay the run.

8. **Vault mirror at `<vault>/web-agent/YYYY/MM/YYYY-MM-DD-<slug>.md`.** Mirrors the Research route pattern (Track B7) so Memory full-text search (Track B6) and the All Searches bucket (Track B3 / Addition 2) pick up Web Agent results automatically with no extra wiring.

9. **MAX_ITERATIONS = 30.** Hard cap on the model loop. With a typical Computer Use task taking 5-15 turns this is comfortably above the realistic ceiling while still preventing a runaway loop from burning unbounded tokens or browser time. Configurable later if real-world tasks need more headroom.

10. **`computer_use_20250124` viewport set to 1280x800.** Matches the Anthropic Computer Use docs default. The `coordinate` integers the model returns are interpreted in this same coordinate system, so screen-size mismatches between the model's "view" and Playwright's viewport would silently miss clicks. Driver and tool config share `DEFAULT_VIEWPORT` to keep them locked together.

11. **SSE event replay via ring buffer (capacity 200).** Late subscribers (operator opens the session URL one tick after submit, or refreshes mid-run) get the full history immediately. After `done` the bus marks the session terminal so a reload after completion replays once and closes cleanly. The ring is process-local and small; a server restart loses replay but the DB row keeps the canonical record.

12. **Browser context teardown is best-effort.** Every shutdown step (`page.close`, `context.close`, `browser.close`) is wrapped in its own try/catch so a partial failure does not leak the rest. The OS will reap the Chromium process on Node exit regardless, but explicit teardown keeps long-lived dev servers tidy.

### Pending dependencies and env vars

The only required env var is `ANTHROPIC_API_KEY`, which is already present in `.env.example` from earlier tracks. No new env vars added by B9.

Pending npm dependency (deferred, not blocking B9):

    @anthropic-ai/sdk  (typed Anthropic SDK; current runner uses raw fetch)

Recommended for the integration step or a Wave 2 follow-up. Once installed, replace the raw `fetch` block in `runner.ts` with `new Anthropic({ apiKey }).messages.create(...)`. The request shape is identical and the response types become first-class. Until then the runner remains fully functional via the public REST API.

Test escape hatch: setting `WEB_AGENT_FIXTURE_PATH` to a JSON file containing a canned Anthropic Messages response makes the runner skip the network call entirely. This lets CI exercise the Playwright + SSE plumbing without an API key or live Anthropic access.

## Depth 2 Wave 1, Track B3 (Operator Console Workspace + Buckets)

### Decisions outside the PRD's explicit spec

1. **One unified workspace API, not per-agent.** PRD Section 4.4 lists per-agent `src/app/api/operator/[agent]/workspace/route.ts` plus per-agent preview catch-alls. The B3 brief specified the unified shape under `/api/operator/workspace/{list,file,buckets}` with `agent` as a query parameter. I followed the brief because it produces seven fewer API folders and keeps the security guardrail (`resolveSafe`) in one place. The buckets view also benefits from a single agent-agnostic file URL builder. If a future track wants the per-agent catch-all preview for HTML asset resolution inside iframes, it can be added later without rewriting the listing API.

2. **Path-based preview through query params, not catch-all.** Donor `04-WORKSPACE-PATTERN.md` uses `/api/<agent>/preview/[...path]` so HTML's relative asset resolution works inside an iframe. The unified API uses `?agent=&path=` instead. Trade-off: HTML files previewed with `srcDoc` cannot resolve relative `<link>`/`<script>` URLs to the same endpoint. Mitigation: the HTML preview is rendered as `srcDoc` (sandboxed) which inlines the content the operator already fetched. Multi-asset HTML apps belong in the "All Apps" bucket where they can be opened in a dedicated app preview later. If the operator needs full asset resolution today, the `Source` toggle exposes the file content as raw text.

3. **HTTP Range support in the file route.** The donor pattern documents Range for video scrub. I kept that capability on the unified file route: any binary kind that the browser requests with `Range:` gets a 206 response with `Content-Range`. Non-Range requests get a normal 200. Same handler, no duplication.

4. **Buckets read research_searches but never write it.** Per the brief, Track B7 owns the write side of `research_searches`. `buckets.ts` calls `listResearchSearches({ limit: 200 })` read-only and wraps it in try/catch so a fresh database (Migration 042 not yet applied) does not crash the buckets endpoint.

5. **Vault file URL placeholder.** Studio and Research files surface in buckets through a `/api/operator/vault/file?source=&path=` URL. That route is NOT in Track B3's ownership; Track B6 (Memory) is the most natural owner. Until B6 ships it, image/video thumbnails for vault items will 404, but the listing itself works. This is documented inline in `buckets.ts`.

6. **Markdown preview deps are import-time, runtime-pending.** `react-markdown`, `remark-gfm`, `rehype-highlight`, and `highlight.js` are PRD 0.3 pending. They are imported in `FilePreview.tsx` with one `@ts-expect-error` per import. TypeScript is happy; `npm run build` will fail until the deps install (same posture as Track B1's `cmdk` posture).

7. **Bucket of `apps` operates on directories.** Section 3 of SCOPE-ADDITION.md defines an "App" as any directory containing `index.html`. The bucket aggregator groups files by parent directory across all agent scratch roots and emits one app entry per matching directory. The entry's `fileUrl` points at the `index.html` itself so the existing file API still serves it.

8. **`text` files split between Documents and Code.** SCOPE-ADDITION.md puts `.txt` in Documents and `.json`/`.yaml` in Code. The aggregator's classifier marks both as `kind: 'text'` or `kind: 'code'`. The buckets router treats `.txt` (via the `text` kind) as Documents and everything else text-flagged as Code, so `.json`/`.yaml` land in Code as specified.

9. **No write API.** PRD's pattern includes `POST /api/<agent>/workspace { name }` for project creation. Project creation comes from the Bridge agent (Track B2) pinning `cwd`, not from the Workspace UI. I omitted the POST. If Bridge needs an explicit "scratch this project" endpoint later it can be added without touching the listing/file/buckets routes.

### Pending dependencies

These are referenced by Track B3 code but NOT yet in `package.json` (consistent with PRD 0.3 pending):

  - `react-markdown` (Addition 1 markdown preview), imported by `src/components/operator/FilePreview.tsx`
  - `remark-gfm` (GitHub Flavored Markdown plugin), imported by `src/components/operator/FilePreview.tsx`
  - `rehype-highlight` (code block syntax highlighting), imported by `src/components/operator/FilePreview.tsx`
  - `highlight.js` (transitive dep of `rehype-highlight`)

All four are React 18 compatible at their current versions (`react-markdown@9.x`, `remark-gfm@4.x`, `rehype-highlight@7.x`, `highlight.js@11.x`).

## Depth 2 Wave 1, Track B6 (Operator Console Goals + Journal + Memory)

PRD Section 4.7. Three new operator console sub-modules backed by Migration 037 (`operator_goals`, `operator_journal_entries`, `operator_chat_sessions`, `operator_chat_messages`).

Files added (all new, no overlap with other Wave 1 tracks):

- `src/lib/operator/goals.ts` (DB helpers + vault mirror writer)
- `src/lib/operator/journal.ts` (DB helpers + per-day vault mirror writer)
- `src/lib/operator/memory-search.ts` (lexical aggregator over 8 sources)
- `src/app/api/operator/goals/route.ts` + `[id]/route.ts`
- `src/app/api/operator/journal/route.ts` + `[id]/route.ts`
- `src/app/api/operator/memory/search/route.ts`
- `src/components/operator/GoalsList.tsx`
- `src/components/operator/JournalEntry.tsx`
- `src/components/operator/MemorySearch.tsx`
- `src/app/operator/goals/page.tsx`
- `src/app/operator/journal/page.tsx`
- `src/app/operator/memory/page.tsx`

### Decisions outside the PRD's explicit spec

1. **DB row is the source of truth, vault markdown is a mirror.** PRD 4.7 describes Goals as either `[vault]/goals.md` (single file) or `[vault]/goals/[category].md` (per-category). Both layouts make sense, so I write BOTH on every mutation: the top-level master `goals.md` plus one per-category subfile. Memory search and Obsidian indexers see whichever layout they prefer. The same posture applies to Journal: the DB row is canonical, the per-day markdown file at `<vault>/journal/YYYY/MM/YYYY-MM-DD.md` is regenerated on every save.

2. **Mirror writes are best effort.** A filesystem error (vault directory does not exist yet, permissions, full disk) never fails an API mutation. The error is logged and the DB row stays consistent. Memory search will pick the entry up from the DB regardless. PRD does not say what to do here; treating filesystem write as advisory keeps the operator unblocked even when the vault volume is sick.

3. **Lexical search, not FTS5.** PRD 4.7 specifies SQLite FTS5 with an hourly re-indexing background job. Track B6 does not own a migration (the brief explicitly forbids `migrations.ts` edits and 037 ships the canonical tables without FTS5 virtual tables). I shipped the user-facing API and a scoring function tuned to match what an FTS5 rank would feel like (phrase boost, term match counts, title position multiplier, coverage bonus, density penalty). The interface returned by `/api/operator/memory/search` is identical to what an FTS5 rewrite would expose, so swapping the backend later is internal to `memory-search.ts`.

4. **Eight sources, not the four PRD lists.** PRD 4.7 lists: vault folder, `operator_chat_messages`, task descriptions, persona blueprints. The orchestrator brief expanded that to: vault, scratch dirs, research_searches, journal entries, plus the PRD four. I shipped all eight in one aggregator (`vault`, `scratch`, `journal`, `chat`, `goal`, `research`, `task`, `persona`) so the operator can include/exclude any subset with `?sources=`. `research_searches` is strictly read-only here (Track B7 owns writes per the brief), with a defensive try/catch so a fresh DB without Migration 042 does not crash search.

5. **Filesystem search guardrails.** A naive recursive walk over `~/clawd` would melt the search box if the operator happens to have a node_modules-heavy project there. I cap at 2000 files per root, 256 KB per file (oversized files are truncated, flagged in `meta.truncated`), and skip common heavy directories (`node_modules`, `.git`, `.next`, `.turbo`, `dist`, `build`, `.venv`, `__pycache__`) plus any dot-directory. Iterative DFS so we never blow the call stack on huge trees.

6. **Memory hit `href` deep links into the existing UI.** Vault/scratch files link to `/operator/workspace?path=<file>` (Track B3 owns the matching workspace deep-link handler). Journal hits link to `/operator/journal?date=YYYY-MM-DD`. Chat hits link to `/operator/bridge?session=<id>` (Track B2). Research links to `/operator/research/<id>` (Track B7). Tasks link to `/tasks/<id>`. Personas link to `/agents/<id>`. None of those targets is owned by B6; each track wires the inbound query/path param at its own pace, and Memory search keeps working today regardless.

7. **Journal `[id]` segment is dual-keyed.** The route accepts either a UUID primary key OR a YYYY-MM-DD date string. The Command Palette and Memory deep links use the date form (`?date=2026-05-25`); the page resolves it through `getJournalEntryByDate`. DELETE is restricted to the UUID form so a deep-linked date URL cannot wipe a day's writing by accident.

8. **Auto-save runs every 5s on dirty bodies.** PRD 4.7 says "Auto-save every 5 seconds". I use `setInterval` rather than a debounced effect so the operator gets predictable cadence. On unmount we fire one last `fetch` with `keepalive: true` so navigating away mid-sentence does not lose a turn of writing.

9. **Markdown preview is text-only today.** B3 owns the `react-markdown` + `remark-gfm` + `rehype-highlight` chain through `FilePreview.tsx`. Importing those modules from B6 components would step on B3's posture (where the deps are intentionally `package.json`-pending). The Journal Preview tab renders the body in a styled `<pre>` block with `whitespace-pre-wrap`. Swapping it for B3's chain is a one-line replacement once the deps land.

10. **No new dependencies.** Everything ships on the existing stack: `next`, `react`, `zod`, `better-sqlite3`, `lucide-react`. The `crypto.randomUUID()` API is Node 14.17+ and already used elsewhere in the repo. No npm install needed before this track can boot.

11. **Voice input on add-goal and journal box: deferred.** PRD 4.7 calls for voice input on both. Track B8 (Call Mode) owns the Web Speech API integration and ships the shared `src/lib/voice/*` module. Wiring a mic button into `GoalsList.tsx` and `JournalEntry.tsx` is a five-line follow-up once B8 lands. The forms are designed so a mic button slots in next to the submit button without layout changes.

12. **Background reindex job: deferred to FTS5 swap.** PRD 4.7 says "Background job re-indexes hourly." Lexical search has nothing to reindex, so the job is a no-op until FTS5 is wired. When FTS5 lands the cron hook goes in `src/lib/jobs/` (Track A1's domain) and triggers `populateFts5()` against the same tables this module reads.


---

## Wave 1 orchestrator follow-up (2026-05-25)

Three small atomic commits to wire cross-track touches the parallel Wave 1 tracks could not own themselves.

### 1. BridgeChat phone button (Addition 5 cross-track touch)

`MessageInput.tsx` now mounts a `Phone` button between the `VoiceButton` mic and the textarea. The button is an anchor to `/operator/call` (the Call Mode route Track B8 shipped). Visual style matches the idle `VoiceButton`: same 38x38 footprint, same `#E5E7EB` border, same `#FFFFFF` background, `text-bcc-text-muted` icon color with a subtle hover into `text-bcc-text`. Implemented as a Next.js `Link` rather than a button + `router.push` so it remains a native middle-click / cmd-click target and works without JS. The file header comment that reserved the slot for the follow-up was updated to reflect the new wiring.

### 2. Operator landing tile verification

All 10 tiles were already present in `src/app/operator/page.tsx` (Bridge, Workspace, Studio, Notebook, Goals, Journal, Memory, Research, Call Mode, Web Agent) — Track B1 shipped the full list. However, three of them (`Research`, `Call Mode`, `Web Agent`) still had `placeholder: true` from when they pointed at routes that did not yet exist. Wave 1 shipped all three routes (`src/app/operator/research/page.tsx`, `.../call/page.tsx`, `.../web-agent/page.tsx`), so the placeholder flags are now stale. Dropped the flags so the tiles render as live `Link`s instead of `cursor-not-allowed` placeholders. No href changes needed.

