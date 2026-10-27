# T-03 — Reverify current Command Center discovery, lifecycle and Kanban interfaces

**Builder lane:** PBB-1702 (rebuild of the PBB-403 pass) · **Repo:** `trevorotts1/blackceo-command-center` — confirmed by instrument, not by the table: `git cat-file -t 87562056f25dc2b26dfae9d8e82edae26778121c` returns `commit` in that repo and exits 128 (`fatal: git cat-file: could not get object info`) in both `openclaw-onboarding` and `999-setup`, so exactly one repo answered.
**Base of THIS pass (re-read, not assumed):** `3244d5cd77b7149611332918569575768a572c8c` — `git rev-parse origin/main` after `git fetch origin`. The audited PBB-403 pass measured `dfe01f86285d87ba7c9be6312530b97ad02a3255`; this branch re-ran the instruments at both revisions and records the difference in §14.
**Branch:** `pb/PBB-1702/t-03-evidence` (branched from `origin/main` at that SHA; never rebased, never force-pushed)
**Kind:** measurement only. No source file, migration, config or test was modified; `git diff --stat origin/main` on the branch shows only the two evidence files added by this task.

Every claim below says which tree it was derived from. §14 is the re-verification at `3244d5cd` and the list of what the first pass got wrong. No prior inventory was used as a source; the diff against prior documents is at §11.

---

## 1. Instrument proof — how the route list was produced

**Instrument (this pass):** `Purple-Billboard-Client-System-Build/tmp/pbb1702/enumerate_routes.py` — walks `src/app`, matches `route.(ts|tsx|js|jsx|mjs)`, and records every exported HTTP method symbol with its line number: `export [async] function M`, `export const M =`, and every arm of an `export { … }` list (the aliased multi-arm form the audited instrument parsed only in part — see §14). Route path is derived from the filesystem path, with route groups `(x)` and parallel slots `@x` dropped.

**Command:**

```
cd <worktree at origin/main> && python3 -I "$L/enumerate_routes.py" . > routes.tsv 2> routes.stderr.txt

**Positive control — the instrument returns non-empty:**

```
SCANNED=./src/app EXISTS=True FILES=259 METHOD_ROWS=381

259 route files, 381 exported method/route pairs, exit 0. The same instrument on the audited base tree `dfe01f86` returns `FILES=259 METHOD_ROWS=381` — identical, so the route surface did not move between the two revisions.

259 route files, 376 exported method/route pairs, exit 0.

**Negative control — the same instrument, a path that does not exist:**
python3 -I "$L/enumerate_routes.py" . src/app/this-path-does-not-exist-xyz
SCANNED=src/app/this-path-does-not-exist-xyz EXISTS=False FILES=0 METHOD_ROWS=0
stdout bytes: 0     EXIT: 0

So a zero from this instrument is a real zero, not a broken walk. The discriminator is empty-vs-populated stdout, and the `EXISTS=` flag distinguishes "scanned and found none" from "nothing there".

**Completeness cross-check (not a route count, a route-file count):** every `route.ts` under `src/app` exports at least one method —

```
Set-diff of the audited table against this measurement (keys are route+method): **376 audited rows, 381 measured rows, 0 audited rows absent from the measurement, 5 measured rows absent from the audited table** — `DELETE`, `HEAD`, `PATCH`, `POST`, `PUT` on `/api/tenant-board/[...path]`. After that correction §2 carries every row the instrument finds, and every `route.ts` under `src/app` appears in the file column.

**Routing is filesystem-only:** `next.config.mjs` contains no `rewrites`, no `redirects`, no `basePath`, no `trailingSlash` (only `headers()` at :83). Nothing serves a path that is not a `route.ts` or `page.tsx`. Pages: **68** `page.tsx` files at `3244d5cd` (67 at the audited base; the one addition is `src/app/campaigns/[id]/approval/page.tsx`, listed in §2.2).

**Pages carry one redirect:** `src/app/kanban/page.tsx` is `permanentRedirect('/tasks/all')` (308) — the cross-department Kanban board the product calls "Kanban" is served at `/tasks/all`, not `/kanban`. Cited because R-31 names the Kanban interface.

---

## 2. Route table — every route, method, file:line and gate

381 method/route pairs across 259 route files. Gate vocabulary is defined in §4. The class of each row is the middleware decision for THAT method (so a read and a write on one path are labelled differently); rows inherited from the audited pass are carried with their citations because every file those citations name is provably unchanged at this base (`src/middleware.ts` and `src/lib/bearer-required-routes.ts` are both absent from `git diff --name-status dfe01f86..3244d5cd`), and the five rows this pass added are classified in §14 from the chain itself.

Gate-count summary: READ 174 · SAME_ORIGIN_CSRF 115 · BEARER 60 · MIDDLEWARE_BYPASS 20 · WEBHOOK_HMAC 12 = **381**.

| route | method | file:line | gate |
|---|---|---|---|
| `/api/ad-campaigns` | POST | `src/app/api/ad-campaigns/route.ts:29` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/ad-campaigns` | GET | `src/app/api/ad-campaigns/route.ts:61` | READ (tenant session / same-origin passthrough) |
| `/api/ad-campaigns/[id]` | PATCH | `src/app/api/ad-campaigns/[id]/route.ts:27` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/ad-campaigns/[id]` | GET | `src/app/api/ad-campaigns/[id]/route.ts:76` | READ (tenant session / same-origin passthrough) |
| `/api/agents` | GET | `src/app/api/agents/route.ts:23` | READ (tenant session / same-origin passthrough) |
| `/api/agents` | POST | `src/app/api/agents/route.ts:54` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/agents/[id]` | GET | `src/app/api/agents/[id]/route.ts:17` | READ (tenant session / same-origin passthrough) |
| `/api/agents/[id]` | PATCH | `src/app/api/agents/[id]/route.ts:40` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/agents/[id]` | DELETE | `src/app/api/agents/[id]/route.ts:213` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/agents/[id]/memory-logs` | GET | `src/app/api/agents/[id]/memory-logs/route.ts:11` | READ (tenant session / same-origin passthrough) |
| `/api/agents/[id]/memory-logs` | POST | `src/app/api/agents/[id]/memory-logs/route.ts:32` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/agents/[id]/openclaw` | GET | `src/app/api/agents/[id]/openclaw/route.ts:15` | READ (tenant session / same-origin passthrough) |
| `/api/agents/[id]/openclaw` | POST | `src/app/api/agents/[id]/openclaw/route.ts:44` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/agents/[id]/openclaw` | DELETE | `src/app/api/agents/[id]/openclaw/route.ts:125` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/agents/[id]/performance` | GET | `src/app/api/agents/[id]/performance/route.ts:40` | READ (tenant session / same-origin passthrough) |
| `/api/anthology/gate` | GET | `src/app/api/anthology/gate/route.ts:108` | READ (tenant session / same-origin passthrough) |
| `/api/anthology/gate` | POST | `src/app/api/anthology/gate/route.ts:132` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/archify-runs` | POST | `src/app/api/archify-runs/route.ts:40` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/archify-runs` | GET | `src/app/api/archify-runs/route.ts:77` | READ (tenant session / same-origin passthrough) |
| `/api/archify-runs/[id]` | PATCH | `src/app/api/archify-runs/[id]/route.ts:23` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/archify-runs/[id]` | GET | `src/app/api/archify-runs/[id]/route.ts:73` | READ (tenant session / same-origin passthrough) |
| `/api/artifacts/[taskId]/[file]` | GET | `src/app/api/artifacts/[taskId]/[file]/route.ts:98` | READ (tenant session / same-origin passthrough) |
| `/api/auth/interview-invitation` | POST | `src/app/api/auth/interview-invitation/route.ts:5` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/auth/interview-ready` | GET | `src/app/api/auth/interview-ready/route.ts:18` | READ (tenant session / same-origin passthrough) |
| `/api/auth/interview-session` | GET | `src/app/api/auth/interview-session/route.ts:35` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/auth/interview-session` | POST | `src/app/api/auth/interview-session/route.ts:43` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/auth/owner-session` | POST | `src/app/api/auth/owner-session/route.ts:74` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/auth/owner-session` | GET | `src/app/api/auth/owner-session/route.ts:170` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/auth/owner-session` | PATCH | `src/app/api/auth/owner-session/route.ts:190` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/auth/owner-session` | DELETE | `src/app/api/auth/owner-session/route.ts:250` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/auth/tenant-ready` | GET | `src/app/api/auth/tenant-ready/route.ts:9` | READ (tenant session / same-origin passthrough) |
| `/api/benchmarks` | GET | `src/app/api/benchmarks/route.ts:94` | READ (tenant session / same-origin passthrough) |
| `/api/bugs` | GET | `src/app/api/bugs/route.ts:46` | READ (tenant session / same-origin passthrough) |
| `/api/bugs` | POST | `src/app/api/bugs/route.ts:102` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/bugs/[id]` | PATCH | `src/app/api/bugs/[id]/route.ts:38` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/campaigns` | GET | `src/app/api/campaigns/route.ts:20` | READ (tenant session / same-origin passthrough) |
| `/api/campaigns` | POST | `src/app/api/campaigns/route.ts:44` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/campaigns/[id]` | GET | `src/app/api/campaigns/[id]/route.ts:29` | READ (tenant session / same-origin passthrough) |
| `/api/campaigns/[id]` | PATCH | `src/app/api/campaigns/[id]/route.ts:43` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/campaigns/[id]` | DELETE | `src/app/api/campaigns/[id]/route.ts:80` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/capacity` | GET | `src/app/api/capacity/route.ts:41` | READ (tenant session / same-origin passthrough) |
| `/api/ceo-chat/history` | GET | `src/app/api/ceo-chat/history/route.ts:30` | READ (tenant session / same-origin passthrough) |
| `/api/ceo-chat/message` | POST | `src/app/api/ceo-chat/message/route.ts:76` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/ceo-chat/status` | GET | `src/app/api/ceo-chat/status/route.ts:16` | READ (tenant session / same-origin passthrough) |
| `/api/ceo-chat/task` | POST | `src/app/api/ceo-chat/task/route.ts:95` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/ceo-chat/upload` | POST | `src/app/api/ceo-chat/upload/route.ts:40` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/clients` | GET | `src/app/api/clients/route.ts:13` | READ (tenant session / same-origin passthrough) |
| `/api/clients` | POST | `src/app/api/clients/route.ts:33` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/clients/[id]` | GET | `src/app/api/clients/[id]/route.ts:9` | READ (tenant session / same-origin passthrough) |
| `/api/clients/[id]` | PATCH | `src/app/api/clients/[id]/route.ts:27` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/clients/[id]/keys` | POST | `src/app/api/clients/[id]/keys/route.ts:32` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/clients/select` | GET | `src/app/api/clients/select/route.ts:12` | READ (tenant session / same-origin passthrough) |
| `/api/clients/select` | POST | `src/app/api/clients/select/route.ts:31` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/companies` | GET | `src/app/api/companies/route.ts:9` | READ (tenant session / same-origin passthrough) |
| `/api/companies` | POST | `src/app/api/companies/route.ts:29` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/companies/[slug]` | GET | `src/app/api/companies/[slug]/route.ts:9` | READ (tenant session / same-origin passthrough) |
| `/api/company` | GET | `src/app/api/company/route.ts:63` | READ (tenant session / same-origin passthrough) |
| `/api/company-health` | GET | `src/app/api/company-health/route.ts:24` | READ (tenant session / same-origin passthrough) |
| `/api/company/config` | GET | `src/app/api/company/config/route.ts:15` | READ (tenant session / same-origin passthrough) |
| `/api/company/config` | POST | `src/app/api/company/config/route.ts:39` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/conversational-ai/enriched` | GET | `src/app/api/conversational-ai/enriched/route.ts:22` | READ (tenant session / same-origin passthrough) |
| `/api/conversational-ai/metrics` | GET | `src/app/api/conversational-ai/metrics/route.ts:28` | READ (tenant session / same-origin passthrough) |
| `/api/conversational-ai/status` | GET | `src/app/api/conversational-ai/status/route.ts:18` | READ (tenant session / same-origin passthrough) |
| `/api/council/advisors` | GET | `src/app/api/council/advisors/route.ts:13` | READ (tenant session / same-origin passthrough) |
| `/api/council/capabilities` | GET | `src/app/api/council/capabilities/route.ts:12` | READ (tenant session / same-origin passthrough) |
| `/api/council/exports` | POST | `src/app/api/council/exports/route.ts:35` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/exports/[exportId]` | GET | `src/app/api/council/exports/[exportId]/route.ts:25` | READ (tenant session / same-origin passthrough) |
| `/api/council/models` | GET | `src/app/api/council/models/route.ts:16` | READ (tenant session / same-origin passthrough) |
| `/api/council/models/probe` | POST | `src/app/api/council/models/probe/route.ts:24` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions` | GET | `src/app/api/council/sessions/route.ts:23` | READ (tenant session / same-origin passthrough) |
| `/api/council/sessions` | POST | `src/app/api/council/sessions/route.ts:97` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]` | GET | `src/app/api/council/sessions/[id]/route.ts:28` | READ (tenant session / same-origin passthrough) |
| `/api/council/sessions/[id]` | DELETE | `src/app/api/council/sessions/[id]/route.ts:76` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/action-plan/approve` | POST | `src/app/api/council/sessions/[id]/action-plan/approve/route.ts:31` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/action-plan/create` | POST | `src/app/api/council/sessions/[id]/action-plan/create/route.ts:33` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/action-plan/preview` | POST | `src/app/api/council/sessions/[id]/action-plan/preview/route.ts:30` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/archive` | POST | `src/app/api/council/sessions/[id]/archive/route.ts:25` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/brief` | PATCH | `src/app/api/council/sessions/[id]/brief/route.ts:24` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/cancel` | POST | `src/app/api/council/sessions/[id]/cancel/route.ts:24` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/decision` | POST | `src/app/api/council/sessions/[id]/decision/route.ts:26` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/events` | GET | `src/app/api/council/sessions/[id]/events/route.ts:42` | READ (tenant session / same-origin passthrough) |
| `/api/council/sessions/[id]/evidence/[evidenceId]` | GET | `src/app/api/council/sessions/[id]/evidence/[evidenceId]/route.ts:24` | READ (tenant session / same-origin passthrough) |
| `/api/council/sessions/[id]/follow-up` | POST | `src/app/api/council/sessions/[id]/follow-up/route.ts:27` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/outcomes` | POST | `src/app/api/council/sessions/[id]/outcomes/route.ts:26` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/pause` | POST | `src/app/api/council/sessions/[id]/pause/route.ts:23` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/rerun` | POST | `src/app/api/council/sessions/[id]/rerun/route.ts:26` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/resume` | POST | `src/app/api/council/sessions/[id]/resume/route.ts:23` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/run-authorization` | GET | `src/app/api/council/sessions/[id]/run-authorization/route.ts:26` | READ (tenant session / same-origin passthrough) |
| `/api/council/sessions/[id]/run-authorization/approve` | POST | `src/app/api/council/sessions/[id]/run-authorization/approve/route.ts:27` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/run-authorization/preview` | POST | `src/app/api/council/sessions/[id]/run-authorization/preview/route.ts:29` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/run-authorization/revoke` | POST | `src/app/api/council/sessions/[id]/run-authorization/revoke/route.ts:25` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/start` | POST | `src/app/api/council/sessions/[id]/start/route.ts:30` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/council/sessions/[id]/verdict` | GET | `src/app/api/council/sessions/[id]/verdict/route.ts:18` | READ (tenant session / same-origin passthrough) |
| `/api/council/settings` | GET | `src/app/api/council/settings/route.ts:27` | READ (tenant session / same-origin passthrough) |
| `/api/council/settings` | PATCH | `src/app/api/council/settings/route.ts:39` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/cron/refresh-models` | POST | `src/app/api/cron/refresh-models/route.ts:30` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/cron/refresh-models` | GET | `src/app/api/cron/refresh-models/route.ts:78` | READ (tenant session / same-origin passthrough) |
| `/api/cron/register` | GET | `src/app/api/cron/register/route.ts:14` | READ (tenant session / same-origin passthrough) |
| `/api/cron/sop-learning` | GET | `src/app/api/cron/sop-learning/route.ts:42` | READ (tenant session / same-origin passthrough) |
| `/api/cron/sop-learning` | POST | `src/app/api/cron/sop-learning/route.ts:46` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/da-challenges` | GET | `src/app/api/da-challenges/route.ts:82` | READ (tenant session / same-origin passthrough) |
| `/api/da-challenges` | POST | `src/app/api/da-challenges/route.ts:101` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/da-challenges/[id]` | PATCH | `src/app/api/da-challenges/[id]/route.ts:24` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/demo` | GET | `src/app/api/demo/route.ts:6` | READ (tenant session / same-origin passthrough) |
| `/api/department-config` | GET | `src/app/api/department-config/route.ts:49` | READ (tenant session / same-origin passthrough) |
| `/api/departments` | GET | `src/app/api/departments/route.ts:38` | READ (tenant session / same-origin passthrough) |
| `/api/departments` | POST | `src/app/api/departments/route.ts:300` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/departments/[id]/config` | GET | `src/app/api/departments/[id]/config/route.ts:20` | READ (tenant session / same-origin passthrough) |
| `/api/departments/[id]/config` | PATCH | `src/app/api/departments/[id]/config/route.ts:100` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/departments/[id]/personas` | GET | `src/app/api/departments/[id]/personas/route.ts:26` | READ (tenant session / same-origin passthrough) |
| `/api/departments/[id]/roles` | POST | `src/app/api/departments/[id]/roles/route.ts:66` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/dept-memory` | GET | `src/app/api/dept-memory/route.ts:11` | READ (tenant session / same-origin passthrough) |
| `/api/dept-memory` | POST | `src/app/api/dept-memory/route.ts:42` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/dept-memory/[id]` | DELETE | `src/app/api/dept-memory/[id]/route.ts:10` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/dept-memory/[id]` | PATCH | `src/app/api/dept-memory/[id]/route.ts:35` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/engine-db` | GET | `src/app/api/engine-db/route.ts:26` | READ (tenant session / same-origin passthrough) |
| `/api/events` | GET | `src/app/api/events/route.ts:29` | READ (tenant session / same-origin passthrough) |
| `/api/events` | POST | `src/app/api/events/route.ts:80` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/events/client-feed` | GET | `src/app/api/events/client-feed/route.ts:35` | READ (tenant session / same-origin passthrough) |
| `/api/events/stream` | GET | `src/app/api/events/stream/route.ts:54` | READ (tenant session / same-origin passthrough) |
| `/api/execution-queue` | GET | `src/app/api/execution-queue/route.ts:11` | READ (tenant session / same-origin passthrough) |
| `/api/execution-queue` | POST | `src/app/api/execution-queue/route.ts:56` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/execution-queue/[id]` | PATCH | `src/app/api/execution-queue/[id]/route.ts:10` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/execution-queue/[id]` | DELETE | `src/app/api/execution-queue/[id]/route.ts:97` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/files/download` | GET | `src/app/api/files/download/route.ts:47` | READ (tenant session / same-origin passthrough) |
| `/api/files/preview` | GET | `src/app/api/files/preview/route.ts:44` | READ (tenant session / same-origin passthrough) |
| `/api/files/reveal` | POST | `src/app/api/files/reveal/route.ts:17` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/files/upload` | POST | `src/app/api/files/upload/route.ts:32` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/files/upload` | GET | `src/app/api/files/upload/route.ts:91` | READ (tenant session / same-origin passthrough) |
| `/api/harvest-cards/[id]/approve` | POST | `src/app/api/harvest-cards/[id]/approve/route.ts:30` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/health` | GET | `src/app/api/health/route.ts:232` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/health/deep` | GET | `src/app/api/health/deep/route.ts:155` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/health/service` | GET | `src/app/api/health/service/route.ts:20` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/hq/activity` | POST | `src/app/api/hq/activity/route.ts:186` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/hq/activity` | GET | `src/app/api/hq/activity/route.ts:344` | READ (tenant session / same-origin passthrough) |
| `/api/hq/activity/[id]` | GET | `src/app/api/hq/activity/[id]/route.ts:113` | READ (tenant session / same-origin passthrough) |
| `/api/hq/chat/sessions` | POST | `src/app/api/hq/chat/sessions/route.ts:42` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/hq/chat/sessions/[id]` | GET | `src/app/api/hq/chat/sessions/[id]/route.ts:37` | READ (tenant session / same-origin passthrough) |
| `/api/hq/chat/sessions/[id]/turns` | POST | `src/app/api/hq/chat/sessions/[id]/turns/route.ts:42` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/hq/chat/sessions/[id]/turns/[turnId]` | GET | `src/app/api/hq/chat/sessions/[id]/turns/[turnId]/route.ts:26` | READ (tenant session / same-origin passthrough) |
| `/api/hq/chat/sessions/[id]/turns/[turnId]/retry` | POST | `src/app/api/hq/chat/sessions/[id]/turns/[turnId]/retry/route.ts:31` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/hq/snapshot` | GET | `src/app/api/hq/snapshot/route.ts:16` | READ (tenant session / same-origin passthrough) |
| `/api/internal/auth-rejected` | GET | `src/app/api/internal/auth-rejected/route.ts:82` | READ (tenant session / same-origin passthrough) |
| `/api/internal/auth-rejected` | HEAD | `src/app/api/internal/auth-rejected/route.ts:83` | READ (tenant session / same-origin passthrough) |
| `/api/internal/auth-rejected` | POST | `src/app/api/internal/auth-rejected/route.ts:84` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/internal/auth-rejected` | PUT | `src/app/api/internal/auth-rejected/route.ts:85` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/internal/auth-rejected` | PATCH | `src/app/api/internal/auth-rejected/route.ts:86` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/internal/auth-rejected` | DELETE | `src/app/api/internal/auth-rejected/route.ts:87` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/internal/auth-rejected` | OPTIONS | `src/app/api/internal/auth-rejected/route.ts:88` | READ (tenant session / same-origin passthrough) |
| `/api/interview/answer` | POST | `src/app/api/interview/answer/route.ts:223` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/interview/answers` | GET | `src/app/api/interview/answers/route.ts:171` | READ (tenant session / same-origin passthrough) |
| `/api/interview/answers/export` | GET | `src/app/api/interview/answers/export/route.ts:53` | READ (tenant session / same-origin passthrough) |
| `/api/interview/canonical-departments` | GET | `src/app/api/interview/canonical-departments/route.ts:30` | READ (tenant session / same-origin passthrough) |
| `/api/interview/complete` | POST | `src/app/api/interview/complete/route.ts:200` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/interview/decision` | POST | `src/app/api/interview/decision/route.ts:88` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/interview/gate-status` | GET | `src/app/api/interview/gate-status/route.ts:39` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/interview/prior-completion` | POST | `src/app/api/interview/prior-completion/route.ts:10` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/interview/remote` | POST | `src/app/api/interview/remote/route.ts:9` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/interview/send-link` | POST | `src/app/api/interview/send-link/route.ts:185` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/interview/state` | POST | `src/app/api/interview/state/route.ts:260` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/interview/state` | GET | `src/app/api/interview/state/route.ts:320` | READ (tenant session / same-origin passthrough) |
| `/api/interview/turn` | POST | `src/app/api/interview/turn/route.ts:380` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/interview/turn` | GET | `src/app/api/interview/turn/route.ts:489` | READ (tenant session / same-origin passthrough) |
| `/api/kpi-history` | GET | `src/app/api/kpi-history/route.ts:8` | READ (tenant session / same-origin passthrough) |
| `/api/kpi-snapshots` | GET | `src/app/api/kpi-snapshots/route.ts:9` | READ (tenant session / same-origin passthrough) |
| `/api/kpi-snapshots` | POST | `src/app/api/kpi-snapshots/route.ts:61` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/launch-abilities` | GET | `src/app/api/launch-abilities/route.ts:35` | READ (tenant session / same-origin passthrough) |
| `/api/launch-runs` | GET | `src/app/api/launch-runs/route.ts:24` | READ (tenant session / same-origin passthrough) |
| `/api/launch-runs/ingest` | POST | `src/app/api/launch-runs/ingest/route.ts:35` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/logo` | GET | `src/app/api/logo/route.ts:16` | READ (tenant session / same-origin passthrough) |
| `/api/logo` | POST | `src/app/api/logo/route.ts:45` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/models` | GET | `src/app/api/models/route.ts:76` | READ (tenant session / same-origin passthrough) |
| `/api/models/[id]` | GET | `src/app/api/models/[id]/route.ts:20` | READ (tenant session / same-origin passthrough) |
| `/api/models/env-audit` | GET | `src/app/api/models/env-audit/route.ts:14` | READ (tenant session / same-origin passthrough) |
| `/api/models/env-audit` | POST | `src/app/api/models/env-audit/route.ts:35` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/models/env-audit/confirm` | POST | `src/app/api/models/env-audit/confirm/route.ts:21` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/models/env-audit/dismiss` | POST | `src/app/api/models/env-audit/dismiss/route.ts:14` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/models/provider-status` | GET | `src/app/api/models/provider-status/route.ts:175` | READ (tenant session / same-origin passthrough) |
| `/api/models/provider-status/prove` | POST | `src/app/api/models/provider-status/prove/route.ts:20` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/onboarding/build-status` | GET | `src/app/api/onboarding/build-status/route.ts:15` | READ (tenant session / same-origin passthrough) |
| `/api/openclaw/models` | GET | `src/app/api/openclaw/models/route.ts:82` | READ (tenant session / same-origin passthrough) |
| `/api/openclaw/orchestra` | GET | `src/app/api/openclaw/orchestra/route.ts:25` | READ (tenant session / same-origin passthrough) |
| `/api/openclaw/sessions` | GET | `src/app/api/openclaw/sessions/route.ts:10` | READ (tenant session / same-origin passthrough) |
| `/api/openclaw/sessions` | POST | `src/app/api/openclaw/sessions/route.ts:63` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/openclaw/sessions/[id]` | GET | `src/app/api/openclaw/sessions/[id]/route.ts:14` | READ (tenant session / same-origin passthrough) |
| `/api/openclaw/sessions/[id]` | POST | `src/app/api/openclaw/sessions/[id]/route.ts:52` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/openclaw/sessions/[id]` | PATCH | `src/app/api/openclaw/sessions/[id]/route.ts:93` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/openclaw/sessions/[id]` | DELETE | `src/app/api/openclaw/sessions/[id]/route.ts:164` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/openclaw/sessions/[id]/history` | GET | `src/app/api/openclaw/sessions/[id]/history/route.ts:12` | READ (tenant session / same-origin passthrough) |
| `/api/openclaw/status` | GET | `src/app/api/openclaw/status/route.ts:21` | READ (tenant session / same-origin passthrough) |
| `/api/operator/bridge/send` | POST | `src/app/api/operator/bridge/send/route.ts:521` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/operator/bridge/stream` | GET | `src/app/api/operator/bridge/stream/route.ts:86` | READ (tenant session / same-origin passthrough) |
| `/api/operator/goals` | GET | `src/app/api/operator/goals/route.ts:32` | READ (tenant session / same-origin passthrough) |
| `/api/operator/goals` | POST | `src/app/api/operator/goals/route.ts:53` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/operator/goals/[id]` | GET | `src/app/api/operator/goals/[id]/route.ts:25` | READ (tenant session / same-origin passthrough) |
| `/api/operator/goals/[id]` | PATCH | `src/app/api/operator/goals/[id]/route.ts:33` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/operator/goals/[id]` | DELETE | `src/app/api/operator/goals/[id]/route.ts:59` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/operator/health` | GET | `src/app/api/operator/health/route.ts:46` | READ (tenant session / same-origin passthrough) |
| `/api/operator/health-workforce` | GET | `src/app/api/operator/health-workforce/route.ts:26` | READ (tenant session / same-origin passthrough) |
| `/api/operator/journal` | GET | `src/app/api/operator/journal/route.ts:39` | READ (tenant session / same-origin passthrough) |
| `/api/operator/journal` | POST | `src/app/api/operator/journal/route.ts:63` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/operator/journal/[id]` | GET | `src/app/api/operator/journal/[id]/route.ts:39` | READ (tenant session / same-origin passthrough) |
| `/api/operator/journal/[id]` | PATCH | `src/app/api/operator/journal/[id]/route.ts:47` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/operator/journal/[id]` | DELETE | `src/app/api/operator/journal/[id]/route.ts:74` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/operator/memory/search` | GET | `src/app/api/operator/memory/search/route.ts:55` | READ (tenant session / same-origin passthrough) |
| `/api/operator/memory/search` | POST | `src/app/api/operator/memory/search/route.ts:75` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/operator/notebook` | GET | `src/app/api/operator/notebook/route.ts:23` | READ (tenant session / same-origin passthrough) |
| `/api/operator/notebook` | POST | `src/app/api/operator/notebook/route.ts:41` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/operator/notebook/[id]` | GET | `src/app/api/operator/notebook/[id]/route.ts:23` | READ (tenant session / same-origin passthrough) |
| `/api/operator/notebook/[id]` | PATCH | `src/app/api/operator/notebook/[id]/route.ts:42` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/operator/notebook/[id]` | DELETE | `src/app/api/operator/notebook/[id]/route.ts:94` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/operator/notebook/[id]/sources` | GET | `src/app/api/operator/notebook/[id]/sources/route.ts:27` | READ (tenant session / same-origin passthrough) |
| `/api/operator/notebook/[id]/sources` | POST | `src/app/api/operator/notebook/[id]/sources/route.ts:46` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/operator/notebook/[id]/sources` | DELETE | `src/app/api/operator/notebook/[id]/sources/route.ts:113` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/operator/research/[id]` | GET | `src/app/api/operator/research/[id]/route.ts:15` | READ (tenant session / same-origin passthrough) |
| `/api/operator/research/availability` | GET | `src/app/api/operator/research/availability/route.ts:28` | READ (tenant session / same-origin passthrough) |
| `/api/operator/research/history` | GET | `src/app/api/operator/research/history/route.ts:38` | READ (tenant session / same-origin passthrough) |
| `/api/operator/research/search` | POST | `src/app/api/operator/research/search/route.ts:184` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/operator/studio/generate` | POST | `src/app/api/operator/studio/generate/route.ts:40` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/operator/studio/jobs` | GET | `src/app/api/operator/studio/jobs/route.ts:19` | READ (tenant session / same-origin passthrough) |
| `/api/operator/studio/jobs/[id]` | GET | `src/app/api/operator/studio/jobs/[id]/route.ts:17` | READ (tenant session / same-origin passthrough) |
| `/api/operator/tts` | GET | `src/app/api/operator/tts/route.ts:71` | READ (tenant session / same-origin passthrough) |
| `/api/operator/tts` | POST | `src/app/api/operator/tts/route.ts:85` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/operator/web-agent/run` | POST | `src/app/api/operator/web-agent/run/route.ts:31` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/operator/web-agent/session/[id]/stream` | GET | `src/app/api/operator/web-agent/session/[id]/stream/route.ts:36` | READ (tenant session / same-origin passthrough) |
| `/api/operator/web-agent/sessions` | GET | `src/app/api/operator/web-agent/sessions/route.ts:38` | READ (tenant session / same-origin passthrough) |
| `/api/operator/workspace/buckets` | GET | `src/app/api/operator/workspace/buckets/route.ts:28` | READ (tenant session / same-origin passthrough) |
| `/api/operator/workspace/file` | GET | `src/app/api/operator/workspace/file/route.ts:68` | READ (tenant session / same-origin passthrough) |
| `/api/operator/workspace/list` | GET | `src/app/api/operator/workspace/list/route.ts:34` | READ (tenant session / same-origin passthrough) |
| `/api/org-chart` | GET | `src/app/api/org-chart/route.ts:22` | READ (tenant session / same-origin passthrough) |
| `/api/performance` | GET | `src/app/api/performance/route.ts:38` | READ (tenant session / same-origin passthrough) |
| `/api/persona-assignment` | POST | `src/app/api/persona-assignment/route.ts:22` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/persona-assignment` | GET | `src/app/api/persona-assignment/route.ts:113` | READ (tenant session / same-origin passthrough) |
| `/api/persona-matrix` | GET | `src/app/api/persona-matrix/route.ts:24` | READ (tenant session / same-origin passthrough) |
| `/api/persona-performance` | GET | `src/app/api/persona-performance/route.ts:8` | READ (tenant session / same-origin passthrough) |
| `/api/persona-selection-log` | GET | `src/app/api/persona-selection-log/route.ts:7` | READ (tenant session / same-origin passthrough) |
| `/api/personas` | GET | `src/app/api/personas/route.ts:138` | READ (tenant session / same-origin passthrough) |
| `/api/podcast/jobs` | GET | `src/app/api/podcast/jobs/route.ts:18` | READ (tenant session / same-origin passthrough) |
| `/api/podcast/jobs/[job_id]` | GET | `src/app/api/podcast/jobs/[job_id]/route.ts:22` | READ (tenant session / same-origin passthrough) |
| `/api/podcast/ops/tokens` | GET | `src/app/api/podcast/ops/tokens/route.ts:26` | READ (tenant session / same-origin passthrough) |
| `/api/podcast/ops/tokens` | POST | `src/app/api/podcast/ops/tokens/route.ts:38` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/podcast/ops/tokens/[tokenId]` | DELETE | `src/app/api/podcast/ops/tokens/[tokenId]/route.ts:15` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/podcast/queue` | GET | `src/app/api/podcast/queue/route.ts:18` | READ (tenant session / same-origin passthrough) |
| `/api/podcast/session` | POST | `src/app/api/podcast/session/route.ts:20` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/podcast/session` | DELETE | `src/app/api/podcast/session/route.ts:41` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/podcast/summary` | GET | `src/app/api/podcast/summary/route.ts:17` | READ (tenant session / same-origin passthrough) |
| `/api/presentations/[taskId]/deliverables` | GET | `src/app/api/presentations/[taskId]/deliverables/route.ts:216` | READ (tenant session / same-origin passthrough) |
| `/api/presentations/[taskId]/phases` | GET | `src/app/api/presentations/[taskId]/phases/route.ts:27` | READ (tenant session / same-origin passthrough) |
| `/api/presentations/[taskId]/resume` | POST | `src/app/api/presentations/[taskId]/resume/route.ts:47` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/presentations/[taskId]/stage-timings` | GET | `src/app/api/presentations/[taskId]/stage-timings/route.ts:89` | READ (tenant session / same-origin passthrough) |
| `/api/presentations/children` | GET | `src/app/api/presentations/children/route.ts:29` | READ (tenant session / same-origin passthrough) |
| `/api/presentations/runs` | POST | `src/app/api/presentations/runs/route.ts:76` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/presentations/runs` | GET | `src/app/api/presentations/runs/route.ts:132` | READ (tenant session / same-origin passthrough) |
| `/api/presentations/stage-timings` | POST | `src/app/api/presentations/stage-timings/route.ts:52` | WEBHOOK_HMAC (bearer + HMAC over WEBHOOK_SECRET) |
| `/api/presentations/stage-timings` | GET | `src/app/api/presentations/stage-timings/route.ts:368` | WEBHOOK_HMAC (bearer + HMAC over WEBHOOK_SECRET) |
| `/api/recommendations` | GET | `src/app/api/recommendations/route.ts:23` | READ (tenant session / same-origin passthrough) |
| `/api/recommendations` | POST | `src/app/api/recommendations/route.ts:72` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/recommendations/[id]/approve` | POST | `src/app/api/recommendations/[id]/approve/route.ts:10` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/recommendations/[id]/dismiss` | POST | `src/app/api/recommendations/[id]/dismiss/route.ts:10` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/recommendations/[id]/outcome` | PATCH | `src/app/api/recommendations/[id]/outcome/route.ts:10` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/recommendations/[id]/save` | POST | `src/app/api/recommendations/[id]/save/route.ts:10` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/recommendations/effectiveness` | GET | `src/app/api/recommendations/effectiveness/route.ts:8` | READ (tenant session / same-origin passthrough) |
| `/api/rescue/summary` | GET | `src/app/api/rescue/summary/route.ts:33` | READ (tenant session / same-origin passthrough) |
| `/api/rescue/tickets` | GET | `src/app/api/rescue/tickets/route.ts:31` | READ (tenant session / same-origin passthrough) |
| `/api/rescue/tickets/[ticketId]` | GET | `src/app/api/rescue/tickets/[ticketId]/route.ts:28` | READ (tenant session / same-origin passthrough) |
| `/api/routing-corrections` | GET | `src/app/api/routing-corrections/route.ts:39` | READ (tenant session / same-origin passthrough) |
| `/api/routing-corrections` | POST | `src/app/api/routing-corrections/route.ts:59` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/settings/board-slas` | GET | `src/app/api/settings/board-slas/route.ts:32` | READ (tenant session / same-origin passthrough) |
| `/api/settings/intelligence` | GET | `src/app/api/settings/intelligence/route.ts:310` | READ (tenant session / same-origin passthrough) |
| `/api/settings/intelligence` | PUT | `src/app/api/settings/intelligence/route.ts:556` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/settings/intelligence` | PATCH | `src/app/api/settings/intelligence/route.ts:734` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/setup/readiness` | GET | `src/app/api/setup/readiness/route.ts:58` | READ (tenant session / same-origin passthrough) |
| `/api/setup/readiness` | POST | `src/app/api/setup/readiness/route.ts:75` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/skill-35/publish` | POST | `src/app/api/skill-35/publish/route.ts:89` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/skill-35/publish` | GET | `src/app/api/skill-35/publish/route.ts:228` | READ (tenant session / same-origin passthrough) |
| `/api/skill-runs` | GET | `src/app/api/skill-runs/route.ts:24` | READ (tenant session / same-origin passthrough) |
| `/api/skill-runs/ingest` | POST | `src/app/api/skill-runs/ingest/route.ts:34` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/social-theme/exchange` | POST | `src/app/api/social-theme/exchange/route.ts:45` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/social-theme/invitations` | POST | `src/app/api/social-theme/invitations/route.ts:52` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/social-theme/preferences` | GET | `src/app/api/social-theme/preferences/route.ts:50` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/social-theme/preferences` | PATCH | `src/app/api/social-theme/preferences/route.ts:76` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/social-theme/renew` | POST | `src/app/api/social-theme/renew/route.ts:47` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/social-theme/session` | GET | `src/app/api/social-theme/session/route.ts:52` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/social-theme/session` | PATCH | `src/app/api/social-theme/session/route.ts:94` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/social-theme/skip` | POST | `src/app/api/social-theme/skip/route.ts:22` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/social-theme/submit` | POST | `src/app/api/social-theme/submit/route.ts:28` | MIDDLEWARE_BYPASS (self-authenticating handler) |
| `/api/social/media/[assetId]` | GET | `src/app/api/social/media/[assetId]/route.ts:36` | READ (tenant session / same-origin passthrough) |
| `/api/social/media/[assetId]` | POST | `src/app/api/social/media/[assetId]/route.ts:100` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/social/performance` | GET | `src/app/api/social/performance/route.ts:34` | READ (tenant session / same-origin passthrough) |
| `/api/social/performance` | POST | `src/app/api/social/performance/route.ts:84` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/social/performance` | PATCH | `src/app/api/social/performance/route.ts:142` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/social/performance` | PUT | `src/app/api/social/performance/route.ts:157` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/sops` | GET | `src/app/api/sops/route.ts:27` | READ (tenant session / same-origin passthrough) |
| `/api/sops` | POST | `src/app/api/sops/route.ts:103` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/sops/[id]` | GET | `src/app/api/sops/[id]/route.ts:11` | READ (tenant session / same-origin passthrough) |
| `/api/sops/[id]` | PATCH | `src/app/api/sops/[id]/route.ts:30` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/sops/[id]` | DELETE | `src/app/api/sops/[id]/route.ts:140` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/sops/[id]/performance` | GET | `src/app/api/sops/[id]/performance/route.ts:16` | READ (tenant session / same-origin passthrough) |
| `/api/sops/feedback` | POST | `src/app/api/sops/feedback/route.ts:17` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/sops/feedback` | GET | `src/app/api/sops/feedback/route.ts:59` | READ (tenant session / same-origin passthrough) |
| `/api/sops/import-role-library` | POST | `src/app/api/sops/import-role-library/route.ts:62` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/sops/import-role-library` | GET | `src/app/api/sops/import-role-library/route.ts:75` | READ (tenant session / same-origin passthrough) |
| `/api/sops/proposals` | GET | `src/app/api/sops/proposals/route.ts:15` | READ (tenant session / same-origin passthrough) |
| `/api/sops/proposals` | POST | `src/app/api/sops/proposals/route.ts:44` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/sops/proposals/[id]` | GET | `src/app/api/sops/proposals/[id]/route.ts:12` | READ (tenant session / same-origin passthrough) |
| `/api/sops/proposals/[id]` | PATCH | `src/app/api/sops/proposals/[id]/route.ts:42` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/sops/suggest` | GET | `src/app/api/sops/suggest/route.ts:18` | READ (tenant session / same-origin passthrough) |
| `/api/system/bootstrap` | POST | `src/app/api/system/bootstrap/route.ts:65` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/system/converge` | POST | `src/app/api/system/converge/route.ts:149` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/system/qc-judge-probe` | GET | `src/app/api/system/qc-judge-probe/route.ts:29` | READ (tenant session / same-origin passthrough) |
| `/api/system/status` | GET | `src/app/api/system/status/route.ts:19` | READ (tenant session / same-origin passthrough) |
| `/api/tasks` | GET | `src/app/api/tasks/route.ts:19` | READ (tenant session / same-origin passthrough) |
| `/api/tasks` | POST | `src/app/api/tasks/route.ts:160` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]` | GET | `src/app/api/tasks/[id]/route.ts:36` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]` | PATCH | `src/app/api/tasks/[id]/route.ts:80` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]` | DELETE | `src/app/api/tasks/[id]/route.ts:1046` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/activities` | GET | `src/app/api/tasks/[id]/activities/route.ts:22` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/activities` | POST | `src/app/api/tasks/[id]/activities/route.ts:124` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/tasks/[id]/archive` | POST | `src/app/api/tasks/[id]/archive/route.ts:34` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/archive` | DELETE | `src/app/api/tasks/[id]/archive/route.ts:158` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/audience` | GET | `src/app/api/tasks/[id]/audience/route.ts:58` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/audience` | POST | `src/app/api/tasks/[id]/audience/route.ts:68` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/audit-backfill` | POST | `src/app/api/tasks/[id]/audit-backfill/route.ts:96` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/tasks/[id]/deliverables` | GET | `src/app/api/tasks/[id]/deliverables/route.ts:107` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/deliverables` | POST | `src/app/api/tasks/[id]/deliverables/route.ts:134` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/tasks/[id]/dispatch` | POST | `src/app/api/tasks/[id]/dispatch/route.ts:218` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/messages` | GET | `src/app/api/tasks/[id]/messages/route.ts:176` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/messages` | POST | `src/app/api/tasks/[id]/messages/route.ts:215` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/tasks/[id]/messages/owner-ids` | GET | `src/app/api/tasks/[id]/messages/owner-ids/route.ts:41` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/operator-preengine-recovery` | POST | `src/app/api/tasks/[id]/operator-preengine-recovery/route.ts:24` | WEBHOOK_HMAC (bearer + HMAC over WEBHOOK_SECRET) |
| `/api/tasks/[id]/persona-bundle` | GET | `src/app/api/tasks/[id]/persona-bundle/route.ts:43` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/persona-choice` | POST | `src/app/api/tasks/[id]/persona-choice/route.ts:57` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/phases` | GET | `src/app/api/tasks/[id]/phases/route.ts:23` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/planning` | GET | `src/app/api/tasks/[id]/planning/route.ts:17` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/planning` | POST | `src/app/api/tasks/[id]/planning/route.ts:82` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/planning` | DELETE | `src/app/api/tasks/[id]/planning/route.ts:204` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/planning/answer` | POST | `src/app/api/tasks/[id]/planning/answer/route.ts:10` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/planning/approve` | POST | `src/app/api/tasks/[id]/planning/approve/route.ts:67` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/tasks/[id]/planning/poll` | POST | `src/app/api/tasks/[id]/planning/poll/route.ts:84` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/planning/poll` | GET | `src/app/api/tasks/[id]/planning/poll/route.ts:104` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/planning/retry-dispatch` | POST | `src/app/api/tasks/[id]/planning/retry-dispatch/route.ts:15` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/promote` | POST | `src/app/api/tasks/[id]/promote/route.ts:57` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/promote` | GET | `src/app/api/tasks/[id]/promote/route.ts:194` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/provider-choice` | GET | `src/app/api/tasks/[id]/provider-choice/route.ts:49` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/provider-choice` | POST | `src/app/api/tasks/[id]/provider-choice/route.ts:74` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/tasks/[id]/publish-summary` | GET | `src/app/api/tasks/[id]/publish-summary/route.ts:26` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/rating` | POST | `src/app/api/tasks/[id]/rating/route.ts:7` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/tasks/[id]/resume` | POST | `src/app/api/tasks/[id]/resume/route.ts:32` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/[id]/resume` | GET | `src/app/api/tasks/[id]/resume/route.ts:163` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/return-to-orchestrator` | POST | `src/app/api/tasks/[id]/return-to-orchestrator/route.ts:53` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/tasks/[id]/status` | POST | `src/app/api/tasks/[id]/status/route.ts:302` | WEBHOOK_HMAC (bearer + HMAC over WEBHOOK_SECRET) |
| `/api/tasks/[id]/status` | GET | `src/app/api/tasks/[id]/status/route.ts:546` | WEBHOOK_HMAC (bearer + HMAC over WEBHOOK_SECRET) |
| `/api/tasks/[id]/subagent` | POST | `src/app/api/tasks/[id]/subagent/route.ts:17` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/tasks/[id]/subagent` | GET | `src/app/api/tasks/[id]/subagent/route.ts:105` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/[id]/test` | POST | `src/app/api/tasks/[id]/test/route.ts:78` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/tasks/[id]/test` | GET | `src/app/api/tasks/[id]/test/route.ts:515` | READ (tenant session / same-origin passthrough) |
| `/api/tasks/bulk` | POST | `src/app/api/tasks/bulk/route.ts:84` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tasks/ingest` | POST | `src/app/api/tasks/ingest/route.ts:354` | WEBHOOK_HMAC (bearer + HMAC over WEBHOOK_SECRET) |
| `/api/tasks/ingest` | GET | `src/app/api/tasks/ingest/route.ts:1520` | WEBHOOK_HMAC (bearer + HMAC over WEBHOOK_SECRET) |
| `/api/tenant-board/[...path]` | GET | `src/app/api/tenant-board/[...path]/route.ts:6` | READ (tenant session / same-origin passthrough) |
| `/api/tenant-board/[...path]` | DELETE | `src/app/api/tenant-board/[...path]/route.ts:6` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tenant-board/[...path]` | HEAD | `src/app/api/tenant-board/[...path]/route.ts:6` | READ (tenant session / same-origin passthrough) |
| `/api/tenant-board/[...path]` | PATCH | `src/app/api/tenant-board/[...path]/route.ts:6` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tenant-board/[...path]` | POST | `src/app/api/tenant-board/[...path]/route.ts:6` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/tenant-board/[...path]` | PUT | `src/app/api/tenant-board/[...path]/route.ts:6` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/version` | GET | `src/app/api/version/route.ts:29` | READ (tenant session / same-origin passthrough) |
| `/api/webhooks/agent-completion` | POST | `src/app/api/webhooks/agent-completion/route.ts:124` | WEBHOOK_HMAC (bearer + HMAC over WEBHOOK_SECRET) |
| `/api/webhooks/agent-completion` | GET | `src/app/api/webhooks/agent-completion/route.ts:474` | WEBHOOK_HMAC (bearer + HMAC over WEBHOOK_SECRET) |
| `/api/webhooks/auto-route` | POST | `src/app/api/webhooks/auto-route/route.ts:52` | WEBHOOK_HMAC (bearer + HMAC over WEBHOOK_SECRET) |
| `/api/webhooks/auto-route` | GET | `src/app/api/webhooks/auto-route/route.ts:114` | WEBHOOK_HMAC (bearer + HMAC over WEBHOOK_SECRET) |
| `/api/webhooks/task-created` | POST | `src/app/api/webhooks/task-created/route.ts:39` | WEBHOOK_HMAC (bearer + HMAC over WEBHOOK_SECRET) |
| `/api/weight-profiles` | GET | `src/app/api/weight-profiles/route.ts:22` | READ (tenant session / same-origin passthrough) |
| `/api/weight-profiles` | POST | `src/app/api/weight-profiles/route.ts:35` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/workspaces` | GET | `src/app/api/workspaces/route.ts:57` | READ (tenant session / same-origin passthrough) |
| `/api/workspaces` | PUT | `src/app/api/workspaces/route.ts:161` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/workspaces` | POST | `src/app/api/workspaces/route.ts:191` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/workspaces/[id]` | GET | `src/app/api/workspaces/[id]/route.ts:13` | READ (tenant session / same-origin passthrough) |
| `/api/workspaces/[id]` | PATCH | `src/app/api/workspaces/[id]/route.ts:45` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/workspaces/[id]` | DELETE | `src/app/api/workspaces/[id]/route.ts:104` | BEARER (MC_API_TOKEN, middleware Layer 2) |
| `/api/workspaces/[id]/archive` | POST | `src/app/api/workspaces/[id]/archive/route.ts:28` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |
| `/api/workspaces/[id]/archive` | DELETE | `src/app/api/workspaces/[id]/archive/route.ts:63` | SAME_ORIGIN_CSRF (tenant + signed CSRF; tokenless via forged Origin) |

### 2.2 Pages (68) — filesystem-derived

| route | file |
|---|---|
| `/` | `src/app/page.tsx` |
| `/agents` | `src/app/agents/page.tsx` |
| `/agents/[agentId]` | `src/app/agents/[agentId]/page.tsx` |
| `/campaigns/[id]` | `src/app/campaigns/[id]/page.tsx` |
| `/campaigns/[id]/approval` | `src/app/campaigns/[id]/approval/page.tsx` |
| `/ceo-board` | `src/app/ceo-board/page.tsx` |
| `/ceo-board/[dept]` | `src/app/ceo-board/[dept]/page.tsx` |
| `/ceo-board/[dept]/focus` | `src/app/ceo-board/[dept]/focus/page.tsx` |
| `/ceo-board/departments` | `src/app/ceo-board/departments/page.tsx` |
| `/conversational-ai` | `src/app/conversational-ai/page.tsx` |
| `/conversational-ai/funnel` | `src/app/conversational-ai/funnel/page.tsx` |
| `/council` | `src/app/council/page.tsx` |
| `/council/[sessionId]` | `src/app/council/[sessionId]/page.tsx` |
| `/council/advisors` | `src/app/council/advisors/page.tsx` |
| `/council/history` | `src/app/council/history/page.tsx` |
| `/council/new` | `src/app/council/new/page.tsx` |
| `/council/settings` | `src/app/council/settings/page.tsx` |
| `/hq` | `src/app/hq/page.tsx` |
| `/interview` | `src/app/interview/page.tsx` |
| `/kanban` | `src/app/kanban/page.tsx` |
| `/launch` | `src/app/launch/page.tsx` |
| `/launch/[launchId]` | `src/app/launch/[launchId]/page.tsx` |
| `/my-ai-ceo` | `src/app/my-ai-ceo/page.tsx` |
| `/onboarding/building` | `src/app/onboarding/building/page.tsx` |
| `/onboarding/resume/[slug]` | `src/app/onboarding/resume/[slug]/page.tsx` |
| `/operator` | `src/app/operator/page.tsx` |
| `/operator/archive` | `src/app/operator/archive/page.tsx` |
| `/operator/bridge` | `src/app/operator/bridge/page.tsx` |
| `/operator/call` | `src/app/operator/call/page.tsx` |
| `/operator/goals` | `src/app/operator/goals/page.tsx` |
| `/operator/health` | `src/app/operator/health/page.tsx` |
| `/operator/journal` | `src/app/operator/journal/page.tsx` |
| `/operator/memory` | `src/app/operator/memory/page.tsx` |
| `/operator/notebook` | `src/app/operator/notebook/page.tsx` |
| `/operator/notebook/[id]` | `src/app/operator/notebook/[id]/page.tsx` |
| `/operator/research` | `src/app/operator/research/page.tsx` |
| `/operator/research/[id]` | `src/app/operator/research/[id]/page.tsx` |
| `/operator/studio` | `src/app/operator/studio/page.tsx` |
| `/operator/web-agent` | `src/app/operator/web-agent/page.tsx` |
| `/operator/web-agent/session/[id]` | `src/app/operator/web-agent/session/[id]/page.tsx` |
| `/operator/workspace` | `src/app/operator/workspace/page.tsx` |
| `/overview` | `src/app/overview/page.tsx` |
| `/owner-login` | `src/app/owner-login/page.tsx` |
| `/participant/[[...token]]` | `src/app/participant/[[...token]]/page.tsx` |
| `/personas` | `src/app/personas/page.tsx` |
| `/podcast` | `src/app/podcast/page.tsx` |
| `/podcast/episodes/[job_id]` | `src/app/podcast/episodes/[job_id]/page.tsx` |
| `/podcast/ops` | `src/app/podcast/ops/page.tsx` |
| `/podcast/ops/access` | `src/app/podcast/ops/access/page.tsx` |
| `/podcast/ops/queue` | `src/app/podcast/ops/queue/page.tsx` |
| `/podcast/queue` | `src/app/podcast/queue/page.tsx` |
| `/preview` | `src/app/preview/page.tsx` |
| `/rescue` | `src/app/rescue/page.tsx` |
| `/settings` | `src/app/settings/page.tsx` |
| `/settings/board-slas` | `src/app/settings/board-slas/page.tsx` |
| `/settings/company` | `src/app/settings/company/page.tsx` |
| `/settings/intelligence` | `src/app/settings/intelligence/page.tsx` |
| `/setup` | `src/app/setup/page.tsx` |
| `/social-theme` | `src/app/social-theme/page.tsx` |
| `/social-theme/welcome` | `src/app/social-theme/welcome/page.tsx` |
| `/social/media/[assetId]` | `src/app/social/media/[assetId]/page.tsx` |
| `/sops/[id]` | `src/app/sops/[id]/page.tsx` |
| `/sops/proposals` | `src/app/sops/proposals/page.tsx` |
| `/tasks/all` | `src/app/tasks/all/page.tsx` |
| `/tasks/by-department` | `src/app/tasks/by-department/page.tsx` |
| `/workspace` | `src/app/workspace/page.tsx` |
| `/workspace/[slug]` | `src/app/workspace/[slug]/page.tsx` |
| `/workspace/[slug]/exceptions` | `src/app/workspace/[slug]/exceptions/page.tsx` |

---

---

## 3. Event schemas — the real definitions and their real shapes

### 3.1 SSE application events (`src/lib/types.ts`)

- Event **name** union, 20 arms: `src/lib/types.ts:837-872` (`SSEEventType`), including two template arms `` `publish_queued:${string}` `` (:855) and `` `publish_state:${string}` `` (:860), and the content-free `'hq_changed'` (:872).
- Event **envelope**: `src/lib/types.ts:874-914`. `interface SSEEvent { type: SSEEventType; payload: <union of 11 shapes> }`. Shapes cited in place: task/session (`{taskId, sessionId, agentName?, summary?, deleted?}` :876-882), delete (`{id}` :883), recommendation outcome (`{recommendation_id, outcome}` :885-887), activity (`{task_id, activity}` :888-890), `ceo_chat_task_status` (`{taskId, sessionId, kind: 'trust_ack'|'trust_progress'|'trust_done', message}` :891-896), `publish_state` (`{id, status: 'queued'|'running'|'published'|'failed', task_id?, execution_id?}` :901-906), `hq_changed` (`{companyId, highSeq}` :910-913).
- **No runtime validator.** `SSEEvent` is a TypeScript type only. Instrument: `grep -rln "from 'zod'" src/lib` returns 5 files, and none of them is `events.ts` or `types.ts`; the SSE send path is `broadcast()` (`src/lib/events.ts:474`), which takes a typed object and does not parse it. Declared plainly: the SSE envelope is compile-time-only, so a producer that ships a wrong payload shape is not stopped at the bus. This is a FINDING, not a fix request.
- **Scope** (tenant separation of the bus, which R-31 cares about): `scopeForEvent` `src/lib/events.ts:307`, `connectionMayReceive` :409, `resolveHqChangedScope` :295. `hq_changed` is explicitly excluded from the nullable-scope fan-out (`src/lib/events.ts:315`, :485) — an unprovable company is DROPPED.

### 3.2 Versioned tenant/producer events (HQ, SPEC S7)

- Schema version constant: `HQ_ENVELOPE_SCHEMA_VERSION = 1` — `src/lib/hq/types.ts:180`.
- Closed value sets: `HQ_TOOL_NAMES` :182, `HQ_SOURCE_HOOKS` :185, `HQ_NATIVE_STATUSES` :188, `HQ_TARGET_DISPOSITIONS` :191, `HQ_CORRELATION_STATUSES` :194.
- Per-kind payload validators (zod `strictObject` = unknown keys rejected, null ≠ omission): `hqTaskPayloadSchema` :198, `hqOwnerNotePayloadSchema` :204, `hqDecisionPayloadSchema` :209 (confidence as integer basis points 0..10000), `hqExchangePayloadSchema` :224 (session keys bounded 512 chars).
- Required-key base shared by every kind: `hqProducerEventBase` `src/lib/hq/types.ts:240-253` (`eventId, sourceKey, installationId, companyId, issuedAt, occurredAt, taskId, actorRuntimeId, recipientRuntimeId, fromWorkspaceId, toWorkspaceId, exchangeId`).
- Kind discriminated union starts at `hqTaskEventSchema` :255 with `kind: z.literal('task')`.
- SSE invalidation shape: `HqChangedEvent = { type:'hq_changed'; companyId; highSeq }` — `src/lib/hq/types.ts:170-174`. Public feed row shape: `HqActivityEvent` :152-164.

**Here the validator IS the schema** — `z.strictObject` rejects unknown keys at parse time, unlike §3.1.

### 3.3 Task/activity/deliverable request schemas (`src/lib/validation.ts`, zod)

- `TaskStatus` enum, 10 values, `src/lib/validation.ts:47-58` — `backlog, inbox, planning, in_progress, assigned, review, testing, blocked, pending_dispatch, done`. Comment at :41-46 records that `'delivered'` is deliberately absent and a `status='delivered'` PATCH is a 400.
- `ActivityType` enum, 9 values, :72-84 (widened for engine producers: `comment, progress, phase_started, phase_completed, error`).
- `DeliverableType` enum, 4 values, :90.
- `CreateTaskSchema` :96 · `UpdateTaskSchema` :132 (includes `blocked_reason` enum :146, `blocked_on_human` enum :147) · `CreateActivitySchema` :228 · `CreateDeliverableSchema` :248 · stage-timing discriminated schemas :259 (`event: z.literal('phase_exit')`) and :290 (`event: z.literal('run_summary')`).

### 3.4 Other real validators in the tree

`src/lib/council/contracts/schemas.ts` — `sessionStateSchema` :102 (`z.enum(SESSION_STATES)`), `moneySchema` :88, `scopeFieldsSchema` :110, `hostStampSchema` :122, `decisionOptionSchema` :151, `typedFactSchema` :175, `evidenceManifestEntrySchema` :182. · `src/lib/interview/answer-schema.ts:25` `answerRequestSchema`.

---

## 4. Permissions — the real enforcement points, and the unguarded routes

All enforcement is in one file plus one allow-list: `src/middleware.ts` (matcher `:1153-1157` — everything except `_next/static`, `_next/image`, `favicon.ico`, `public/`) and `src/lib/bearer-required-routes.ts`.

### 4.1 Gate chain in `middleware()`, in execution order

| # | Line | Gate |
|---|---|---|
| 1 | `src/middleware.ts:532` | `/api/health` subtree bypass (CF health + deep probes) |
| 2 | `:542` | `/api/interview/gate-status` bypass (internal fallback) |
| 3 | `:554` | `/api/internal/auth-rejected` → hard 404 (own rewrite sink) |
| 4 | `:564` | `/participant` subtree bypass (self-authenticating token page) |
| 5 | `:576` | launch surface requires a cryptographically resolved tenant; shared host refused |
| 6 | `:597` | DEMO_MODE: every non-GET/HEAD/OPTIONS on `/api/` → 403 |
| 7 | `:614` | `/interview` GET/HEAD → CSRF cookie minted, admitted |
| 8 | `:629` | `/api/auth/interview-session`, `/api/interview/remote` → handler is the only gate |
| 9 | `:647` | `/owner-login` GET/HEAD + `/api/auth/owner-session` POST only; other verbs → 403 `owner_login_method_refused`; host must be kind `self` |
| 10 | `:681` | `/api/social-theme/*` subtree bypass (mini-app holds no tenant session) |
| 11 | `:692` | **Layer 1** — if `REQUIRE_CF_ACCESS=true`, verified tenant or 403 |
| 12 | `:702` | webhook route with no `WEBHOOK_SECRET` → 503 `webhook-secret-unset` |
| 13 | `:728` | `/api/hq/*` + `/api/auth/owner-session` on a client-kind host → 403 `hq_direct_origin_required` |
| 14 | `:738` | client-kind tenant: non-read + no CSRF → 401; else rewrite to `/api/tenant-board/...` |
| 15 | `:746` | `x-expected-installation-id` mismatch → 403 |
| 16 | `:799` | **same-origin passthrough** — non-webhook, non-bearer-listed route: tenant required (:804), mutating requires signed CSRF cookie (:815-821) |
| 17 | `:862` | `/api/launch-runs/ingest` → any `Bearer` handed to handler (per-client token, handler decides) |
| 18 | `:874` | `MC_API_TOKEN` unset → 503 `mc-api-token-unset` unless `ALLOW_INSECURE_OPEN_API` |
| 19 | `:900` | `/api/events/stream` accepts `?token=` (constant-time compare), self-installation only |
| 20 | `:924-929` | `Bearer` missing / wrong → 401 with distinct reject reasons |
| 21 | `:953` | interview shell lock for GET/HEAD page navigations (HMAC cookie + latch + fallbacks) |

### 4.2 Bearer allow-list — measured, not quoted from its own docblock

`src/lib/bearer-required-routes.ts` — `BEARER_REQUIRED_WRITE_ROUTES` declared :67, closed :166. **Actual regex entries: 50** (parsed, comments stripped). The file's own last revision note says "Now 50 patterns" — they agree. Matching function: `requiresBearerForWrite` :170, read-only short-circuit `READ_ONLY_METHODS` :168.

### 4.3 Webhook/HMAC family — 5 static + 2 dynamic

`WEBHOOK_SECRET_ROUTES` `src/middleware.ts:140-155` (`/api/tasks/ingest`, `/api/webhooks/agent-completion`, `/api/webhooks/auto-route`, `/api/webhooks/task-created`, `/api/presentations/stage-timings`); `WEBHOOK_SECRET_DYNAMIC_ROUTES` :167-170 (`/api/tasks/{id}/status`, `/api/tasks/{id}/operator-preengine-recovery`); `isWebhookSecretRoute` :190.

### 4.4 Mutating-route census (164 routes exporting POST/PUT/PATCH/DELETE)

| class | count | meaning |
|---|---|---|
| `BEARER` | 51 | middleware requires `MC_API_TOKEN` |
| `SAME_ORIGIN_CSRF` | 96 | no bearer; reachable tokenless through the same-origin passthrough |
| `WEBHOOK_HMAC` | 7 | bearer + route-level HMAC over `WEBHOOK_SECRET` |
| `MIDDLEWARE_BYPASS` | 10 | middleware early-returns; handler must self-authenticate |
| **total** | **164** | distinct route PATHS with at least one mutating method, counted from §2 |

### 4.5 UNGUARDED / weakly-guarded routes — named

1. **96 mutating routes have no credential gate, only a forgeable same-origin header plus a CSRF cookie minted on unauthenticated page loads.** The code states this itself: `src/middleware.ts:776-794` (`U052: RESIDUAL`) and `:1082-1087` (`the token is minted on UNAUTHENTICATED page loads … the signature does NOT defend against that harvest-and-replay`). `isSameOriginRequest` (:377) trusts client-settable `Origin`/`Referer`. The only closure is `REQUIRE_CF_ACCESS=true` (Layer 1). Full list of the 96 is every `SAME_ORIGIN_CSRF` row in §2; `/api/tenant-board/[...path]` is one of them, and its handler then adds its own tenant-class and installation binding (§14).
2. **Route-level truth for the 51 bearer routes depends on env.** If `MC_API_TOKEN` is unset and `ALLOW_INSECURE_OPEN_API=true` (and `NODE_ENV !== 'production'`, :131), the bearer layer is a passthrough (:874-882). Outside that override the box 503s, so the fail-closed posture holds — but "bearer-gated" is an environment claim, not a structural one.
3. **Two bearer-list patterns are unreachable.** `/api/social-theme/invitations` and `/api/social-theme/renew` are listed at `src/lib/bearer-required-routes.ts:140-141`, but middleware returns at `src/middleware.ts:681` before the Layer-2 bearer check ever runs for `/api/social-theme/*`. The patterns are dead for that path. The routes do self-authenticate — `src/app/api/social-theme/invitations/route.ts:57` and `:159` return 403 `operator_service_required`; `src/app/api/social-theme/renew/route.ts:75` and `:98` return 403 `renewal_auth_required` — so the surface is not open, but the documented mechanism (bearer list) is not the one enforcing it. Code wins; the comment's claim is the discrepancy.
4. **`/api/auth/owner-session` exports POST, PATCH and DELETE;** only POST is exempted (`:653-658`); PATCH/DELETE fall to the `owner_login_method_refused` 403. Fail-closed, named here so the asymmetry is on the record.
5. `/api/events/stream` accepts the **master** `MC_API_TOKEN` in a query string (`:900-911`). The code names this residual at :891-899 (lands in access logs/Referer). Recorded, not fixed.

---

## 5. Dedupe — three real mechanisms, one is application-level only

**A. Task creation — layered, in code, with a stated precedence rule.**
- Layer 1: caller-supplied `idempotency_key` (`src/lib/tasks.ts:2568` field; contract described :21). When a key is supplied, Layer 2 is skipped (`:2724` guard `!input.idempotency_key`) — deliberate, so two distinct contacts with coincident titles are not merged.
- Layer 2: `findDuplicateByTitleWindow(title, workspace_id)` — declared `src/lib/tasks.ts:2455`, called `:2725`, returns the existing row and `{ deduped: true }` at `:2729-2731`. Skipped when `workspace_id` is absent or `'default'`.
- **Real, not a comment**: `createTaskCore` returns the pre-existing task rather than writing a second row.

**B. Execution attempts — DB-enforced uniqueness (the strongest evidence here).** `src/lib/execution-schema.ts`: `idempotency_key TEXT NOT NULL UNIQUE` (:33), `session_key … UNIQUE` and `session_id … UNIQUE` (:37-38), `UNIQUE(task_id, generation)` (:47), plus the partial index `CREATE UNIQUE INDEX task_execution_active_task ON task_executions(task_id) WHERE state IN ('reserved','sending','accepted','running','unknown')` (:48-49). Capacity is COUNTED under `BEGIN IMMEDIATE`, not unique-indexed — documented at :50-53 (`migration 149 drops the old unique index`). The SQLite CHECK constraint on `state` (:27) is also a real enum gate at the DB layer.

**C. Manual dispatch — a time window, application-level, read-then-write.** `checkDuplicateDispatch` `src/lib/dispatch-idempotency.ts:114`, enforced at `src/app/api/tasks/[id]/dispatch/route.ts:330`. Window `DISPATCH_IDEMPOTENCY_WINDOW_SECONDS` default 120s (:49, :62-68; `0` disables). Suppression requires a **same-agent** prior success (:157-158) — reassignment is never suppressed. It is a **window, not a unique constraint**: the check is a `SELECT` (`:132-138`) followed later by the send, so two concurrent POSTs inside the same instant can both read "no prior event" and both send. The docblock (:5-13) documents exactly the live double-send it was built for, and is honest about the gateway-side key only collapsing CONCURRENT sends. Not silent: a suppressed duplicate writes `duplicate_dispatch_suppressed` (:52) plus a task activity.

**D. `company_cycle` — one row per (company, week).** `src/lib/social/cycle-service.ts:13-16`: a second fire for the same week collapses to a no-op; next week's row is independent. This is the dedupe behind the scheduler cycle (see R-06).

Not found / not claimed: there is no dedupe key on the SSE bus itself (a producer that broadcasts twice broadcasts twice).

---

## 6. Existing lifecycle — the real state machine

**States (10):** `LifecycleState` `src/lib/task-lifecycle.ts:115-125` — `backlog, inbox, planning, pending_dispatch, assigned, in_progress, review, testing, done, blocked`. Comment :108-113 records that this is deliberately kept in lockstep with `TaskStatus` (`src/lib/types.ts:21`, `src/lib/validation.ts:47-58`).

**Transition table (enforced):** `LEGAL_TRANSITIONS` `src/lib/task-lifecycle.ts:146-163`, `Record<LifecycleState, Set<LifecycleState>>`:

```
backlog          → inbox, planning, pending_dispatch, assigned, in_progress, blocked, review
inbox            → planning, pending_dispatch, assigned, in_progress, backlog, blocked
planning         → pending_dispatch, assigned, in_progress, backlog, blocked
pending_dispatch → assigned, in_progress, backlog, blocked
assigned         → in_progress, pending_dispatch, backlog, blocked
in_progress      → review, testing, blocked, backlog
review           → done, testing, in_progress, blocked, backlog
testing          → done, review, in_progress, blocked, backlog
done             → backlog                      (terminal; re-open only)
blocked          → backlog, inbox, planning, pending_dispatch, assigned, in_progress
```

**Enforcement points:**
- `transition()` — `src/lib/task-lifecycle.ts:1296` (the funnel every status change is meant to go through).
- `transitionWithDeclaredException()` — :1109, with the closed union of unmodelled edges `ALLOWED_EXCEPTION_EDGES` :1121; an undeclared edge is refused (:1130).
- Illegal transition → `TransitionError` (`ILLEGAL_TRANSITION`, class :285); CAS conflict → `CAS_CONFLICT` (:311).
- Preconditions: `SANDBOX_COMPLETION_PROHIBITED` :592, `PRECONDITION_EVIDENCE` :613 and :629, `PRECONDITION_PROCESS_CERTIFICATE` :657.
- WIP limits, server-side: `WIP_LIMITS` :186 (`in_progress: 5`, `review: 8`), column definitions `WIP_COLUMNS` :202 (review column buckets `review` + `testing`), `checkWipLimit` :238.
- Status events: `recordStatusEvent` :780.

**Kanban path for a status move (end to end, cited):** board component `src/components/MissionQueue.tsx:671-675` sends `PATCH /api/tasks/${task.id}` with `{ status }` → route `src/app/api/tasks/[id]/route.ts:80` → zod `UpdateTaskSchema.safeParse` :103 (`UpdateTaskSchema` = `src/lib/validation.ts:132`) → status routed through `transition()` :686-699. The move menu itself is `src/components/kanban/MoveTaskMenu.tsx:39`, which computes capacity refusal client-side at :33 from the same limits.

**Honest limit:** `src/app/api/tasks/[id]/route.ts:174` states this route does not go through `transition()` for every field; the status path does (:686-699). **Correction to the audited pass:** `tasks.status` DOES carry a DB CHECK — `src/lib/db/schema.ts:115` is `status TEXT DEFAULT 'backlog' CHECK (status IN ('backlog','inbox','planning','pending_dispatch','assigned','in_progress','review','testing','blocked','done'))`, byte-identical at `dfe01f86` and at `3244d5cd` and attributed by `git log -L 115,115:src/lib/db/schema.ts` to v4.63.0. So a writer outside these routes is pinned to the legal state SET at the table, while the legal EDGE (which state may follow which) is enforced only by `LEGAL_TRANSITIONS` in `src/lib/task-lifecycle.ts:146-163`. The audited text said there was no CHECK; that was wrong.

---

## 7. The four requirements, quoted verbatim, and what was measured

Quoted from `live-ledgers/requirements.json` `items[].statement` — exact text, not paraphrase.

### R-06 — "One 35/57 scheduler with distinct placement cycles" — **PARTIAL**

- One scheduler module exists: `src/lib/jobs/scheduler.ts`, `registerCronJobs()` :1168, iterating the `JOBS` array (:426-1116) and calling `cron.schedule(...)` :1180 with `noOverlap: true` (:1179). **Exactly 35 job entries** (parsed from the array): `model-refresh, env-audit, usage-refresh, memory-index, sop-learning, interview-outbox, council-outbox-pump, council-completion-scan, dispatch-intents, execution-reconcile, provider-ledger, social-publish-dispatcher, social-performance-review, qc-review-sweep, ceo-delegation, intake-advance, board-jobs-watchdog, persona-grounding-health, trust-engine, backlog-redispatch, persona-backfill, stale-task-sweep, stuck-in-progress-sweep, interview-nudge, weekly-done-clear, db-retention, lss-control-review, general-task-recurrence, port-integrity, board-hygiene, operator-column-age-digest, social-cycle, social-expiry-recovery, hq-retention, hq-chat-reconcile`.
- Single-owner execution: `runLeasedJob` (`src/lib/jobs/job-lease.ts`, used at `scheduler.ts:185`) over `scheduler_leases` (`src/lib/execution-schema.ts:70`), so two boxes cannot both run a tick.
- Distinct cycles: each job carries its own cron expression; the social family has separate entries — `social-cycle` (`SOCIAL_CYCLE_CRON` default `*/5 * * * *`, `src/lib/jobs/social-cycle.ts:30`), `social-publish-dispatcher`, `social-performance-review`, `social-expiry-recovery`.
- **ABSENT: any "placement cycle" concept.** Instrument: `grep -rn "placement" src/lib/jobs/ | wc -l` → **0**; control on the same instrument/tree for the word `cron` in `scheduler.ts` → **87** hits, so the grep works. "placement" appears elsewhere only as board-card wording (`src/lib/board-projection.ts:48`) and as `replacement` in SOP/persona code — never as a scheduler cycle.
- **ABSENT: a "57".** The only `Skill 57` reference in source is historical prose about an external cron script (`src/lib/social/cycle-service.ts:6`); no code artifact counts 57 of anything. The one exact 35 in the tree is the job count above — reported as an observation, not as proof of the requirement's 35/57 arithmetic (which lives in the spec, not the code).
- Verdict wording: one scheduler, distinct per-job cycles, per-company durable weekly cycle with a UNIQUE (company, week) — real. "Placement cycles" as a named concept and the `35/57` figure — not in the code. Hence PARTIAL, not MEASURED.

### R-20 — "Truthful funnel attribution, outcomes and client workload" — **PARTIAL**

- Attribution module is real and substantial: `src/lib/funnel/attribution.ts` (863 lines). Named vocabulary at exact lines: `FUNNEL_UNKNOWN = 'unknown'` :82, `ATTRIBUTION_CLASSES = ['observed_keyword','multitouch','unknown']` :84, `OUTCOME_KINDS = ['gift','contact','booking','sale']` :87, `FunnelUnknownReason` :90, `REASON_TEXT` :101, `FUNNEL_INPUT_CONTRACT_FIELDS` :131, `PRODUCER_LIMITATIONS` :149, `FunnelAttributionSnapshot` :174, `FunnelAttributionEvent` :206, `mapPixelEventRecord` :251. The design refuses to round an unknown up: a snapshot carries `unknown` plus a reason instead of a guessed class — that is "truthful" in the sense the requirement names.
- Wired, not orphaned: `src/app/conversational-ai/funnel/page.tsx` and `src/components/funnel/FunnelAttributionView.tsx`; the same view is mounted for the workspace surface by `src/app/workspace/[slug]/exceptions/page.tsx` (T-34, landed at base).
- **Outcomes:** present as a closed vocabulary (`OUTCOME_KINDS` :87) and a snapshot bucket (`OutcomeBucket` :161), with the T-34 view itself reporting bookings/outcomes as `null`/UNKNOWN with a reason when no producer exists (CHANGELOG top entry for T-34 repair2). Truthful-by-absence, but the producer is not on main.
- **Client workload:** `src/lib/cc/exceptions-outcomes.ts`, `src/app/api/performance/route.ts`, `src/components/ClientExceptionsOutcomes.tsx` (`grep -rln "workload"` — 3 files). Workload exists as a rendered field; there is no measurement artifact in the tree proving it is computed from real work rather than declared. Recorded as the gap.
- Hence PARTIAL: attribution and the outcome vocabulary are measured in code; workload and live outcome production are not.

### R-28 — "Shared per-surface readiness and invalidation" — **PARTIAL / mostly ABSENT**

- Readiness **exists** as a first-class vocabulary: `src/lib/readiness/types.ts` — `ReadinessState = 'READY'|'BLOCKED'|'UNKNOWN'` :15, `ReadinessGroup = 'data'|'identity'|'runtime'` :17, `ReadinessEvidence {probe, observed, at}` :26, `ReadinessItem` :32, the 8 item ids :43-51 (`database, schema_migrations, dispatch_schema, company_record, company_workspace, owner_registration, agent_roster, openclaw_gateway`), `OwnerAction` :53 with `OwnerActionId` :69, `SetupReadiness` :75 (`overall` = BLOCKED > UNKNOWN > READY, :76), `ActionResult` :83.
- Computed and served: `computeSetupReadiness` `src/lib/readiness/setup.ts:278`, `rollUp` :188, `tcpProbe` :98, owner actions `runSetupAction` :658; route `src/app/api/setup/readiness/route.ts` GET :58 / POST :75.
- **ABSENT — per-surface keying.** The package's own definition (`READINESS.md:4`) is "Readiness key: tenant + surface + account + environment + adapter/config/binding revision + evidence time". The code's key is a flat 8-item list on one surface (setup); there is no tenant, surface, account, revision or evidence-time dimension in `SetupReadiness` (:75-81 carries only `overall`, `items`, `actions`, `computedAt`).
- **ABSENT — general invalidation.** The only invalidation event in the tree is `hq_changed` (`src/lib/types.ts:872`, `src/lib/hq/types.ts:170`, scope logic `src/lib/events.ts:295/315/485`). Instrument: `grep -rn "invalidate\|invalidation" src/lib/board src/lib/readiness src/lib/events.ts` → **4 hits, all in `src/lib/events.ts`, all about `hq_changed`**; zero in `src/lib/readiness/` and zero in `src/lib/board/`. So a readiness change does not invalidate a surface's proof, and no surface advertises a readiness key.
- Hence PARTIAL: shared readiness vocabulary + one computed surface — real. "Per-surface" and "invalidation" as the requirement names them — not in the code.

### R-31 — "Real Command Center views, Kanban actions and versioned tenant events" — **MEASURED**

- **Views:** 31 top-level route segments under `src/app` (`agents, campaigns, ceo-board, conversational-ai, council, hq, interview, kanban, launch, my-ai-ceo, onboarding, operator, overview, owner-login, participant, personas, podcast, preview, rescue, settings, setup, social, social-theme, sops, tasks, workspace` + root), 68 `page.tsx` files (67 at the audited base; `src/app/campaigns/[id]/approval/page.tsx` added). A component with no mounted route was the T-34 defect; that defect's fix is at `src/app/workspace/[slug]/exceptions/page.tsx` and is present at base.
- **Kanban actions:** the board's move is a real HTTP action, not local state — `src/components/MissionQueue.tsx:671-675` → `PATCH /api/tasks/[id]` (`src/app/api/tasks/[id]/route.ts:80`) → zod (:103) → `transition()` (:686-699) → `LEGAL_TRANSITIONS` (`src/lib/task-lifecycle.ts:146`). Capacity refusal is server-side (`checkWipLimit` :238) as well as client-side (`MoveTaskMenu.tsx:33`). The `/kanban` URL is a 308 to `/tasks/all` (`src/app/kanban/page.tsx`).
- **Versioned tenant events:** `HQ_ENVELOPE_SCHEMA_VERSION = 1` (`src/lib/hq/types.ts:180`), zod `strictObject` per kind (:198, :204, :209, :224), required-key base (:240), `HqChangedEvent` (:170). Company scoping is fail-closed on the bus (`src/lib/events.ts:295`, :315, :485).
- Caveat carried into the verdict: the application SSE envelope (§3.1) is compile-time only — "versioned tenant events" is true for the HQ producer family, not for the general bus.

---

## 8. Version — five locations, at the audited base and at current main

Rule is CONSISTENCY, not increment. This branch is an evidence-only commit: no bump invented.

| location | `dfe01f86` (audited base) | `3244d5cd` (this base) |
|---|---|---|
| `version` | `v7.6.125` | `v7.6.126` |
| `package.json` `.version` | `7.6.125` | `7.6.126` |
| `package-lock.json` `.version` (root) | `7.6.125` | `7.6.126` |
| `package-lock.json` `.packages[""].version` | `7.6.125` | `7.6.126` |
| `CHANGELOG.md` top entry | `## [Unreleased] — 2026-10-25 — fix(cc views) … (PBB-327 / T-34 repair2)` | `## [v7.6.126] — 2026-10-26 — release: oct-25 fix batch (l20–l24) stamped …` |

Both columns are internally consistent (the `v` prefix on the `version` file is the repo's existing convention; the numeric part matches). The audited pass recorded only the left column; current main has moved one release on. After-commit re-check is in §10.

---

## 9. Schema validation of `current-cc-evidence.json`

Validator: `jsonschema` 4.26.0, Draft 2020-12, against `Purple-Billboard-Client-System-Build/schemas/evidence.schema.json` (that schema sets `additionalProperties: false` and requires all 15 properties). Run in a scratch venv on the external disk, `-I` isolated.

```
jsonschema.Draft202012Validator.check_schema(sch)      # schema itself valid
errs = sorted(Draft202012Validator(sch).iter_errors(inst))
RESULT: PASS
top-level properties: 15
required present: True
additional: []
```

**Negative control — the validator rejects a deliberately invalid instance** (same schema, same call, one extra property `invented_endpoint`):

```
NEGATIVE CONTROL errors: 1
 - [] Additional properties are not allowed ('invented_endpoint' was unexpected)
disposition: REJECTED as expected
```

So the PASS is a real pass: the same validator that accepts this file rejects a fabricated endpoint key.

---

## 10. Commit, version re-check, readbacks and the negative control

**Commit contents:** exactly two files added — `evidence/current-cc-evidence.json` and `evidence/T-03-EVIDENCE.md`. No source, schema, migration, config or test file changed; `git status` on the branch after the commit shows a clean tree apart from those two paths.

**Version re-check after the commit — all five still agree, and this branch changed none of them** (it adds two files under `evidence/` and nothing else):

| location | after |
|---|---|
| `version` | `v7.6.126` |
| `package.json` `.version` | `7.6.126` |
| `package-lock.json` `.version` (root) | `7.6.126` |
| `package-lock.json` `.packages[""].version` | `7.6.126` |
| `CHANGELOG.md` top entry | unchanged `## [v7.6.126] — 2026-10-26 …` |

No bump was invented: this is an evidence-only commit and the repo's rule is consistency, not increment.

**Readbacks** — the branch this pass pushes is `pb/PBB-1702/t-03-evidence`; the populated `git ls-remote --heads origin pb/PBB-1702/t-03-evidence` line naming the pushed SHA is recorded in the batch-merge-room request filed for this unit, written after the push (§13), not asserted here.

**Negative control for the readback instrument — run by this pass, not asserted:**

```
git ls-remote --heads origin pb/PBB-1702/this-ref-does-not-exist-xyz
→ (empty stdout)  EXIT 0

gh api repos/trevorotts1/blackceo-command-center/git/ref/heads/pb/PBB-1702/this-ref-does-not-exist-xyz
→ {"message":"Not Found", ... "status":"404"}  gh: Not Found (HTTP 404)
```

So a ref readback is proven by **populated** output naming the same SHA, never by an exit code — `ls-remote` on a nonexistent ref is a silent success.

---

## 11. Diff against prior inventories — and why there is nothing to diff

**Sources checked for a prior Command Center route/event/permission inventory** (each with its own instrument):

| source | result |
|---|---|
| `Purple-Billboard-Client-System-Build/evidence/` | contains exactly one file: `t04-storage-census.md`. No Command Center inventory. |
| whole package tree, `find … -name "current-cc-evidence.json"` | no match (exit 0, empty) |
| package docs `SPEC.md`, `ACCEPTANCE-MATRIX.md`, `DATA-CONTRACTS.md`, `DISCOVERIES.md`, `READINESS.md`, `SCHEDULER-ADAPTER.md` for `/api/...` endpoint claims | **zero** endpoint claims in all six |
| repo `docs/` (48 files) filtered for route/api/endpoint names | zero files |
| scratch lane dirs, `*-evidence.json` / `evidence*.json` | hits exist, all for other repos/tasks (onboarding, presentations, motion) — none for command-center routes |

**Controls (same instrument, known non-empty):**
- `find` control: `find "$B" -name "requirements.json"` → 2 files. So the `current-cc-evidence.json` miss is a real miss, not a broken find.
- regex control: `grep -oE '/api/[A-Za-z0-9/_{}\[\]-]+' src/middleware.ts` → **56 matches** (e.g. `/api/health`, `/api/tasks/ingest`, `/api/webhooks/agent-completion`). So the zero across the six package docs is a real zero of endpoint claims, not a dead regex.

**Consequence:** `current-cc-evidence.json` is this task's OUTPUT artifact, not an input. There is no earlier endpoint list to contradict — and therefore no copied endpoint in §2. The two *document-vs-code* contradictions found are recorded as findings in place: §4.5 item 3 (bearer-list patterns dead behind the social-theme early return) and §7 R-28 (READINESS.md's tenant+surface key vs the flat 8-item code). In both, the code is what is reported.

---

## 12. Internal-disk discipline

Every clone, script, output and intermediate for this pass lives under `/Volumes/mac mini m4/Downloads/git trees and automations/…`: the worktree at `Purple-Billboard-Client-System-Build/worktrees/PBB-1702-t03-evidence` (guard-registered, `--lock --reason "portable drive"`), the instruments and TSV outputs at `Purple-Billboard-Client-System-Build/tmp/pbb1702/` (`enumerate_routes.py`, `routes.tsv`, `routes.stderr.txt`, `base_routes.tsv`, `changed.txt`), and the lane folder at `Purple-Billboard-Client-System-Build/lanes/PBB-1702-lane/`. No `/tmp` and no internal-disk path was written by this lane. The two committed files are the only files this task adds to the repo.

---

## 13. Readback record

**Artifact commit — the commit that adds both evidence files:**

```
git rev-parse HEAD                                    → c9d29acc389efc10bb6f12a445e4b34837ba03ed
```

The readback rule this pass follows: a ref readback is proven by **populated** output naming the same SHA, never by an exit code — `git ls-remote` on a nonexistent ref is a silent success with empty stdout. The audited pass ran that negative control and it is recorded in §10 above; it still holds because the instrument is the same `git ls-remote`.

**Head at hand-off.** This section is itself committed after the artifact commit, so the branch head at hand-off is one commit past the SHA above. The authoritative readback for that head — the populated `git ls-remote --heads origin pb/PBB-1702/t-03-evidence` line naming the same SHA — is carried in the batch-merge-room request filed for this unit, and that request is written only after the push and names the pushed tip. Nothing here claims the branch head equals the artifact commit above.

---

## 14. Re-verification at `3244d5cd` — what moved, and the two corrections to the audited pass

**Why this pass exists.** The audited branch `pb/PBB-403/t-03-reverify` was classified REBUILD because its two evidence files are not on `main` (`git cat-file -e origin/main:evidence/T-03-EVIDENCE.md` → rc 128, same for the JSON; `origin/main` has no `evidence/` directory at all). This branch rebuilt them from the tree instead of copying them: every count was re-measured, and audited text was kept only where the re-measurement agreed.

**Instrument equivalence, proved by running both trees with the same script:**

```
tree dfe01f86 (audited base)   SCANNED=./src/app EXISTS=True FILES=259 METHOD_ROWS=381
tree 3244d5cd (current main)   SCANNED=./src/app EXISTS=True FILES=259 METHOD_ROWS=381
```

Identical. The route surface did not move across the 53 commits between the audited base and current main: set-diff of the two TSVs is 0 rows removed and 0 rows added.

**The 5-row omission.** Audited table 376 rows, measurement 381 rows, 0 audited rows absent, 5 measured rows absent: `DELETE`, `HEAD`, `PATCH`, `POST`, `PUT` on `/api/tenant-board/[...path]`. Cause, measured: that file exports all six arms on one line — `export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };` (`src/app/api/tenant-board/[...path]/route.ts:6`) — and the audited enumerator recorded only the first arm, which is why the route appeared to be a GET-only read. §2 carries all six.

**Gate classification of the five added rows**, read off the chain rather than inherited:
- `GET`, `HEAD` → `READ`. `HEAD` is read-only by definition: `src/lib/csrf-protection.ts:72` `READ_ONLY_METHODS = new Set(['GET','HEAD','OPTIONS'])`, consumed by `isReadOnlyMethod` (:276), so `HEAD` takes the same passthrough as `GET`.
- `POST`, `PUT`, `PATCH`, `DELETE` → `SAME_ORIGIN_CSRF`. `/api/tenant-board/*` is in neither `WEBHOOK_SECRET_ROUTES` / `WEBHOOK_SECRET_DYNAMIC_ROUTES` (`src/middleware.ts:140-170`) nor `BEARER_REQUIRED_WRITE_ROUTES` (`src/lib/bearer-required-routes.ts` — no `tenant-board` entry), so all four reach the same-origin passthrough at `src/middleware.ts:799-835`, which requires the signed CSRF cookie for non-read methods at `:815-821`.
- The handler adds its own gates: `proxyTenantBoard` refuses an empty remainder and `hq`/`auth`/`ownerSession` before any identity work (403 `client_board_path_refused`), requires `kind === 'client'` (403 `client_target_required`), refuses a self/cross origin target and any redirect (502), binds the returned `x-installation-id` (502 `client_installation_identity_mismatch`), and forwards the remote board's per-tenant bearer — never `MC_API_TOKEN` (`src/lib/tenant-board-proxy.ts`). The class column records the MIDDLEWARE gate, as it does for every other row.

**Correction 1 — the DB does constrain `tasks.status`.** The audited §6 said "`tasks.status` has no CHECK in `src/lib/db/schema.ts`". False at both revisions: `src/lib/db/schema.ts:115` carries `CHECK (status IN ('backlog','inbox','planning','pending_dispatch','assigned','in_progress','review','testing','blocked','done'))`, identical bytes at `dfe01f86` and `3244d5cd`, attributed by `git log -L 115,115:src/lib/db/schema.ts` to v4.63.0. What is not DB-enforced is the transition EDGE — `LEGAL_TRANSITIONS` lives only in `src/lib/task-lifecycle.ts:146-163`. §6 now says exactly that.

**Correction 2 — the version moved.** The audited §8/§10 recorded 7.6.125 with `[Unreleased]` on top of the CHANGELOG. At `3244d5cd` the five locations read `v7.6.126` / `7.6.126` ×3 / `## [v7.6.126] — 2026-10-26`. Consistency still holds; the number is not the audited one. §8/§10 now carry both columns.

**Claims inherited and not re-derived by hand here — and why that is safe.** Each is anchored to a file that `git diff --name-status dfe01f86..3244d5cd` proves did NOT change (58 paths changed in total, none of these among them), so the audited line numbers still address the same bytes: `src/middleware.ts`, `src/lib/bearer-required-routes.ts`, `src/lib/hq/types.ts`, `src/lib/execution-schema.ts`, `src/lib/tasks.ts`, `src/lib/dispatch-idempotency.ts`, `src/app/api/tasks/[id]/dispatch/route.ts`, `src/lib/task-lifecycle.ts`, `src/lib/jobs/scheduler.ts`, `src/lib/funnel/attribution.ts`, `src/lib/readiness/types.ts`, `src/lib/readiness/setup.ts`, `src/app/api/setup/readiness/route.ts`, `src/lib/events.ts`, `src/components/MissionQueue.tsx`, `src/app/api/tasks/[id]/route.ts`, `src/app/kanban/page.tsx`, `next.config.mjs`. `src/lib/types.ts` DID change, so its anchors were re-read at main and are unchanged: `:837` `export type SSEEventType =`, `:872` `| 'hq_changed';`, `:874` `export interface SSEEvent {`, `:914` `}`.

**What this pass did NOT do.** No source, migration, config, test, CI workflow, CHANGELOG or skill-version file was touched — `git diff --name-status origin/main` lists exactly `A evidence/T-03-EVIDENCE.md` and `A evidence/current-cc-evidence.json`. The measurement limits stated in `current-cc-evidence.json` (no prior inventory exists to diff against; environment-dependent gates; the U052 residual) carry over unchanged.
