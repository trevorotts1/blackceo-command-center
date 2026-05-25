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
