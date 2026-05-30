# Feature 52 — Conversational-AI Live Analytics Dashboard

A NEW card + route in the Command Center, distinct from `/ceo-board` (which is
the CEO Performance Board: tasks / agents / KPIs). F52 is the **conversational-
AI** analytics surface: channel volume, conversations, sentiment, objections,
funnel, and the operational signals the Round-3 OpenClaw skills emit.

It reuses the `/ceo-board` redesign component library (`SectionContainer`) and
the `SystemPulseSection` fetch pattern (use-client, `useEffect`→`fetch`, loading
skeletons, `useMemo`, framer-motion). It does NOT modify or duplicate
`/ceo-board`.

- **Home card:** 7th `EntryCard` in `src/app/page.tsx`
  (fuchsia→pink→rose gradient, `MessagesSquare` icon, route `/conversational-ai`).
- **Route:** `src/app/conversational-ai/page.tsx`
- **APIs:** `src/app/api/conversational-ai/{status,metrics,enriched}/route.ts`
  (all `force-dynamic`)
- **Libs:** `src/lib/conversational-ai/{sources,interview-state,metrics}.ts`
- **Components:** `src/components/conversational-ai/*`

---

## Layer 1 vs Layer 2

| | Layer 1 (universal) | Layer 2 (persona-tuned) |
|---|---|---|
| Works without interview? | Yes — every client | No — unlocks on interview completion |
| Channel volume, timeline, sentiment, escalation, objections, KB hit, discounts, follow-up, bot/spam, quiet-hours, pixel funnel | ✓ | ✓ (re-contextualized) |
| Persona-aligned funnels, business KPIs, journey-template funnels, industry benchmarks, recommended actions | — | ✓ |

### Merge logic

The page polls `GET /api/conversational-ai/status` every 20s. That endpoint
runs the interview-state checkpoint (`src/lib/conversational-ai/interview-state.ts`):

1. `company-config.json` has interview-derived `companyKPIs[]` **and** a specific
   `industry` → complete.
2. `workforce-interview-answers.md` present in the OpenClaw workspace → complete.
3. A `build-progress.json` / `.workforce-build-state.json` reporting a completed
   build → complete (the interview precedes the build).
4. None of the above → **NOT complete** (clean default).

- **Not complete:** render Layer 1 + the `InterviewBanner`
  ("Complete your AI Workforce interview to unlock persona-tuned views").
- **Complete:** render Layer 1 + Layer 2 unified (`Layer2Section`).
- **Completes while open:** the next poll flips `complete:false → true`, the page
  fetches `/enriched` and adds Layer 2 **with no reload**. Historical Layer-1
  data is preserved and re-contextualized, never reset.

---

## Data contract (Round-3 skill output)

Sources are discovered by probing candidate OpenClaw workspace roots (env
`OPENCLAW_COMPANY_ROOT` / `OPENCLAW_WORKSPACE_ROOT` first, then
`/data/.openclaw/workspace`, `~/.openclaw/workspace`, `~/clawd`,
`~/Downloads/openclaw-master-files`) × known subdirs (`.`, `company-discovery`,
`conversational-ai`, `analytics`, `skills/round-3`). Same strategy as
`onboarding/build-status` and `migrations.ts`.

| Source file/dir | Kind | Feeds metric | Reader |
|---|---|---|---|
| `pixel-events/` | dir of `*.jsonl` | pixel funnel | `readJsonlDir` |
| `aggression-detection-log.md` | markdown append-log | bot/spam volume (line count) | `readMarkdownLog` |
| `interrupt-log.jsonl` | jsonl | quiet-hours impact | `readJsonl` |
| `geo-qualification-log.jsonl` | jsonl | geo qualification | `readJsonl` |
| `crm-field-writes-log.jsonl` | jsonl | follow-up performance | `readJsonl` |
| `faq-detour-log.jsonl` | jsonl | KB hit rate | `readJsonl` |
| `real-estate-events.jsonl` | jsonl | industry funnel (Layer 2) | `readJsonl` |
| `public-records-queries.jsonl` | jsonl | public records (Layer 2) | `readJsonl` |
| `conversations-log.jsonl` | jsonl | channel volume, timeline, sentiment, escalation, objections, discounts | `readJsonl` |

The canonical contract is also exported as `ROUND3_DATA_CONTRACT` in
`src/lib/conversational-ai/sources.ts` so the `/status` endpoint reports which
sources are present.

### Expected JSONL line shapes (consumed defensively)

`conversations-log.jsonl` (one object per conversation/turn):

```json
{ "channel": "sms", "ts": "2026-05-30T10:00:00Z", "sentiment": 0.8,
  "escalated": false, "objection": "too expensive",
  "offered": true, "redeemed": true }
```

`channel` is normalized (e.g. `instagram`/`ig`→IG DM, `facebook comment`→FB
Comments, `live chat`/`webchat`→Live Chat). `sentiment` accepts `-1..1`,
`0..100`, or `positive`/`neutral`/`negative`.

### Empty-state / safety contract

Every reader is **defensive**: a missing dir, missing file, empty file, or
malformed line yields an empty-but-valid shape with `available: false` (or
skips the bad line) and **never throws**. The UI renders a `role="status"`
empty-state for any unavailable family. **No number is ever fabricated** — empty
means "awaiting data", not zero-as-a-value. SQLite-mirrored metrics (when added)
should prefer the `getDb()` aggregator pattern from `api/performance`.

---

## Accessibility (WCAG 2.1 AA target, AAA where possible)

- Body text ≥ 16px (globals.css enforces a 13px floor only on badges).
- Semantic headings: one `h1`, sections as `h2`, banner as `h3`.
- **Never color-alone** for state: every empty-state and status pairs an icon +
  text label; objection/funnel bars carry `role="img"` + `aria-label`.
- Tap targets ≥ 44px (the interview-CTA button uses `min-h-[44px]`).
- 3 clicks max: Home → Conversational AI card → page (1 click to the dashboard).
- Empty-states use `role="status"` for polite announcement.
- Mobile-friendly: single-column on small screens, 2/3/4-col grids at `lg`.

---

## Per-client deploy (scope-gated)

`scripts/conversational-ai/deploy-dashboard.sh` publishes the Command Center to
`dashboard.<client-domain>` via Cloudflare Pages behind the F49 Access app.

It requires the same Cloudflare token scopes F49 established:
`Pages: Edit` + `Workers Scripts: Edit` + `Workers Routes: Edit`.

```bash
# 1. Verify scopes WITHOUT deploying (gate)
./scripts/conversational-ai/deploy-dashboard.sh --precheck
# 2. Deploy only after the precheck passes
./scripts/conversational-ai/deploy-dashboard.sh <project> dashboard.client.com
# 3. Gate the subdomain
./scripts/cloudflare/setup-access-app.sh dashboard.client.com <operator-email>
```

If scopes are missing the precheck prints exactly which ones and exits non-zero
**without touching Cloudflare**. The F52 card ships inside the Command Center
app regardless — the standalone subdomain is optional and gated.

---

## MVP vs production follow-up

**MVP (this release):** card + route, all 11 Layer-1 metric families with graceful
empty-states, interview-state detection (3 signals), Layer 2 (business KPIs,
journey funnel, industry benchmarks, recommended actions), 20s real-time unlock
poll, scope-gated deploy + precheck, accessibility pass.

**Production follow-up (needs the real Round-3 emitters + scopes):**
- Confirm exact field names once the Round-3 skills finalize their JSONL schema
  (readers are defensive but field names are best-effort today).
- A dedicated `conversations-log.jsonl` emitter (channel volume currently falls
  back to `pixel-events/` if absent).
- SQLite mirroring of high-volume metrics for large clients (the aggregator hook
  is documented; the mirror tables are not yet migrated).
- Live per-client subdomain deploy (gated on the CF token scopes above).
- Industry benchmark bands are conservative reference points; expand the table
  as published industry data is gathered.
