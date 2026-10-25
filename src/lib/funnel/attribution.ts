/**
 * PBB-127 / T-30 — truthful funnel attribution and outcome evidence.
 *
 * WHAT THIS IS
 * ------------
 * The Command Center already renders a "pixel funnel" (`pixelFunnel()` in
 * `src/lib/conversational-ai/metrics.ts`) that counts stage strings and draws
 * them as sequential bars. That shape asserts two things the source cannot
 * prove: (a) that the events were attributed to the client's own keyword, and
 * (b) that they form one ordered funnel. D-05 is the concrete counter-example:
 * A/B messages arrived at GHL, but neither tested `m.me` reference appeared in
 * the inspected normalized attribution fields — arrival is not attribution.
 *
 * This module separates the two claims instead of blurring them:
 *
 *   1. ATTRIBUTION CLASS is decided per event from EXPLICIT evidence only:
 *        - `observed_keyword` — exactly one distinct touch reference, and the
 *          observation carries a provenance source plus an observed timestamp.
 *        - `multitouch`       — two or more distinct touch references. It is
 *          NEVER collapsed into the single-keyword bucket.
 *        - `unknown`          — everything else, with a named reason. A
 *          message body that merely mentions a keyword is not a reference
 *          (D-05: an absent ref renders UNKNOWN, never success).
 *
 *      The touch references of one event are the UNION of `refs`,
 *      `touch_refs` and `keyword_ref` (deduped case-insensitively): the
 *      adapter observed all of them, so dropping one because another field was
 *      present would under-report a multitouch as a single keyword.
 *
 *   2. OUTCOMES are counted INDEPENDENTLY: gift / contact / booking / sale.
 *      There is no total, no rate, no "sale implies booking" progression, and
 *      no derived stage. A sale increments only the sale bucket. An event
 *      whose kind is outside the adapter vocabulary lands in `unclassified`
 *      with `outcome_kind_unrecognized` — never folded into one of the four.
 *
 * UNKNOWN IS NEVER ZERO. When the source is absent the snapshot status is
 * UNKNOWN, every count is `null` (not 0) and carries `source_absent`. A source
 * that is present but empty is a legitimate observed zero and is reported as
 * OBSERVED 0 — the two states are distinct and tested in both directions.
 *
 * This mirrors the F-40 rule in `src/lib/social/measured-outcomes.ts`
 * ("missing is unknown, never zero"). The sentinel is redeclared locally on
 * purpose: that module imports `@/lib/db`, and this projection must stay
 * database-free so it can be unit-tested without a database.
 *
 * The load function delegates to the accepted Round-3 reader
 * (`readJsonlDir('pixel-events')` from `src/lib/conversational-ai/sources.ts`)
 * and accepts an injected reader so tests never touch a real workspace.
 *
 * Known limitation (named, not hidden): `readJsonlDir` reports an unreadable
 * directory exactly like an empty one (`available: true`, no records). This
 * module therefore cannot distinguish "temporarily unreadable" from "present
 * but empty" through that reader. Fixing it belongs in `sources.ts`, which is
 * outside this unit's ownership.
 *
 * Known limitation (named, not hidden, id `pixel_events_schema_gap`): no
 * producer in this repository emits this module's input contract. The one
 * wired reader is `readJsonlDir('pixel-events')`, whose records are the
 * Skill-38 Pixel-Concierge schema (`timestamp`, `event_type`, `site_id`,
 * `agent_id`, `visitor_id`, `fingerprint`, `path`, `referrer`,
 * `seconds_on_page`, `total_visits`, `first_visit_date`, `data`). `timestamp`
 * and `agent_id` map honestly to `observed_at` and `attribution_source`
 * (`mapPixelEventRecord`), but NO field of that schema is an attribution
 * reference and none is an outcome kind, so pixel events classify
 * `unknown`/`no_attribution_data` and count no outcome — fail-closed and
 * inert, never a fabricated count. The gap is carried on every snapshot as
 * `limitations`, not left implicit.
 */

import { readJsonlDir } from '@/lib/conversational-ai/sources';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/** Mirror of `UNKNOWN` from measured-outcomes; kept local to avoid the DB import. */
export const FUNNEL_UNKNOWN = 'unknown';

export const ATTRIBUTION_CLASSES = ['observed_keyword', 'multitouch', 'unknown'] as const;
export type AttributionClass = (typeof ATTRIBUTION_CLASSES)[number];

export const OUTCOME_KINDS = ['gift', 'contact', 'booking', 'sale'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export type FunnelUnknownReason =
  | 'source_absent'
  | 'no_attribution_data'
  | 'observation_not_provenanced'
  | 'outcome_not_evidenced'
  | 'outcome_kind_unrecognized'
  | 'malformed_record';

export const REASON_TEXT: Record<FunnelUnknownReason, string> = {
  source_absent: 'source unavailable — no events were observed',
  no_attribution_data: 'no attribution reference was observed on the event',
  observation_not_provenanced:
    'a reference was present but carried no provenance source or observed timestamp',
  outcome_not_evidenced: 'the outcome carried no provenance source or observed timestamp',
  outcome_kind_unrecognized: 'the outcome kind is outside the supported vocabulary',
  malformed_record: 'the record was not a usable object',
};

/**
 * Adapter vocabulary. Deliberately small: a kind that is not listed here is
 * reported as unclassified rather than guessed into one of the four outcomes.
 */
const OUTCOME_ALIASES: Record<OutcomeKind, readonly string[]> = {
  gift: ['gift', 'gift_claim', 'gift_claimed', 'gift_delivered', 'gift_download'],
  contact: ['contact', 'contact_capture', 'contact_captured', 'contact_created', 'contact_added'],
  booking: ['booking', 'booked', 'booking_created', 'booking_confirmed', 'appointment_booked'],
  sale: ['sale', 'purchase', 'purchased', 'order_paid', 'payment_received'],
};

/**
 * The input contract this adapter needs from a producer. Named here so the
 * gap below is machine-checkable instead of folklore.
 */
export const FUNNEL_INPUT_CONTRACT_FIELDS = [
  'kind',
  'refs',
  'keyword_ref',
  'touch_refs',
  'attribution_source',
  'observed_at',
] as const;
export type FunnelInputContractField = (typeof FUNNEL_INPUT_CONTRACT_FIELDS)[number];

/** Named limitations carried on every snapshot. Ids are stable, text is prose. */
export const PRODUCER_LIMITATION_IDS = ['pixel_events_schema_gap'] as const;
export type ProducerLimitationId = (typeof PRODUCER_LIMITATION_IDS)[number];

export const PRODUCER_LIMITATIONS: Record<ProducerLimitationId, string> = {
  pixel_events_schema_gap:
    'pixel_events_schema_gap: no producer in this repository emits the input contract, so the wired pixel-events/ reader (Skill-38 Pixel-Concierge schema) can only map what the source proves — timestamp -> observed_at, agent_id -> attribution_source. No field of that schema is an attribution reference and none is an outcome kind (event_type is pageview/scroll/click/page_hidden/delete_request; referrer, path, data.href and data.text are page and copy, never attribution — D-05), so pixel events classify unknown and count no outcome until a producer emits the contract. This is a named gap, not a zero.',
};

export interface ReasonCount {
  reason: FunnelUnknownReason;
  count: number;
}

export interface OutcomeBucket {
  kind: OutcomeKind;
  /** OBSERVED when the source exists; UNKNOWN when it does not. */
  status: 'OBSERVED' | 'UNKNOWN';
  /** Observed outcomes of this kind. `null` iff status is UNKNOWN. */
  count: number | null;
  /** Set iff status is UNKNOWN (today: `source_absent`). */
  reason: FunnelUnknownReason | null;
  /** Events of this kind that were refused for missing evidence. */
  unknown: number | null;
  unknownReasons: ReasonCount[];
}

export interface FunnelAttributionSnapshot {
  source: string | null;
  available: boolean;
  status: 'OBSERVED' | 'UNKNOWN';
  reason: FunnelUnknownReason | null;
  attribution: {
    observed_keyword: number | null;
    multitouch: number | null;
    unknown: number | null;
    unknownReasons: ReasonCount[];
  };
  /** Exactly four entries, in OUTCOME_KINDS order. */
  outcomes: OutcomeBucket[];
  /** Events whose kind is present but outside the vocabulary. */
  unclassified: { count: number | null; reasons: ReasonCount[] };
  /** Records that carried no outcome kind at all (page views, etc.). */
  nonOutcome: number | null;
  /** Malformed records plus unparseable source lines. `null` iff source absent. */
  refused: number | null;
  /** Named input-contract gaps (`PRODUCER_LIMITATIONS`) — carried, not hidden. */
  limitations: string[];
  generatedAt: string;
}

// ─── Input ──────────────────────────────────────────────────────────────────

/**
 * The adapter's normalized event shape. `refs` is the canonical field — the
 * distinct touch references the adapter actually OBSERVED in the source
 * payload. `keyword_ref` / `touch_refs` are accepted for older emitters.
 * `message` / `body` / `text` are accepted but NEVER read for attribution.
 */
export interface FunnelAttributionEvent {
  kind?: unknown;
  refs?: unknown;
  keyword_ref?: unknown;
  touch_refs?: unknown;
  attribution_source?: unknown;
  observed_at?: unknown;
  [key: string]: unknown;
}

export interface FunnelAttributionSource {
  available: boolean;
  source: string | null;
  records: unknown[];
  /** Source lines that failed to parse (surfaced as refusals). */
  skipped?: number;
}

/**
 * Map one raw `pixel-events/` record (Skill-38 Pixel-Concierge schema) onto
 * the input contract — mapping ONLY what the source proves:
 *
 *   observed_at        <- timestamp  (ISO-8601, when the event was observed)
 *   attribution_source <- agent_id   (the observing emitter)
 *
 * A contract field already present on the record passes through untouched, so
 * a producer that one day emits the real contract needs no change here — with
 * one exception: when `observed_at` is present but names no real instant
 * (`'yesterday-ish'`, `'2026'`), the proven `timestamp` is not thrown away in
 * its favour. An unusable value cannot be evidence, and the source's own
 * instant is exactly what the field is for; this mirrors the `agent_id` ->
 * `attribution_source` fallback below. A `timestamp` that is itself not a
 * real instant is never promoted.
 * Deliberately NOT mapped: `event_type` (pageview|scroll|click|page_hidden|
 * delete_request) is an event type, not an outcome kind; `referrer`, `path`,
 * `data.href` and `data.text` are page and copy, not attribution references
 * (D-05 — text is never attribution). Mapping either would fabricate a claim
 * the source cannot support, so those records classify `unknown` and count no
 * outcome, and the gap rides along as `pixel_events_schema_gap`.
 *
 * Non-objects pass through untouched and are refused by
 * `buildFunnelAttribution` as `malformed_record`, as before.
 */
export function mapPixelEventRecord(raw: unknown): FunnelAttributionEvent {
  if (!isPlainObject(raw)) return raw as FunnelAttributionEvent;
  const ev: FunnelAttributionEvent = { ...raw };
  if (!isTimestamp(ev.observed_at)) {
    const ts = raw.timestamp;
    if (isTimestamp(ts)) ev.observed_at = ts;
  }
  if (nonEmptyString(ev.attribution_source) === null) {
    const agent = nonEmptyString(raw.agent_id);
    if (agent) ev.attribution_source = agent;
  }
  return ev;
}

export interface BuildOptions {
  available: boolean;
  source?: string | null;
  /** Source lines the reader could not parse; folded into `refused`. */
  sourceSkipped?: number;
  now?: string;
}

export interface LoadOptions {
  read?: () => FunnelAttributionSource;
  now?: string;
}

// ─── Pure classification ────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * ISO-8601 date-time that denotes a real instant.
 *
 * Deliberately NOT bare `Date.parse`: that accepts `"0"`, `"2026"` and
 * `"2026-05-30"`, so a claim could pass the evidence gate without ever naming
 * a moment. A date-time stamp is required — date and time, not a year, a
 * month or a bare calendar day — and it must survive `Date.parse`, so a
 * calendar-impossible stamp (`2026-13-45T99:99:99Z`) is refused too.
 * Seconds and the offset are optional, so a producer emitting local ISO time
 * is not refused for it.
 */
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|z|[+-]\d{2}:?\d{2})?$/;

function isTimestamp(v: unknown): boolean {
  const s = nonEmptyString(v);
  if (!s) return false;
  if (!ISO_DATETIME_RE.test(s)) return false;
  return !Number.isNaN(Date.parse(s));
}

/**
 * The usable text one reference field carries, as a list of touches.
 *
 * Both shapes are accepted everywhere — a field may name its touch as a bare
 * string or as a list of strings — because the fields are UNIONED and the
 * adapter observed whatever shape the emitter wrote. Restricting `refs` to
 * arrays (and `keyword_ref` to a scalar) silently discarded the touches in
 * the other shape: `refs: 'SUMMER'` reported no touch at all.
 *
 * A field that carries no readable text contributes nothing: this reports
 * what was OBSERVED, never a touch the adapter could not read.
 */
function touchesOf(v: unknown): string[] {
  const one = (x: unknown): string | null => (typeof x === 'string' ? nonEmptyString(x) : null);
  const scalar = one(v);
  if (scalar) return [scalar];
  if (Array.isArray(v)) return v.map(one).filter((s): s is string => s !== null);
  return [];
}

/**
 * Collect the DISTINCT touch references the adapter observed. The three
 * fields are UNIONED — a reference observed in `touch_refs` is still observed
 * when `refs` is also present (and vice versa) — so a multitouch record can
 * never collapse into the single-keyword bucket. Dedupe is case-insensitive:
 * `['SUMMER','summer']` is ONE touch, not multitouch. Each field is read in
 * whatever shape it was written (a bare string or a list of strings), because
 * dropping the shapes the field was not written in would drop an observed
 * touch and report a multitouch as a single keyword. A value that carries no
 * readable text is not a touch and is never invented.
 */
export function observedRefs(ev: FunnelAttributionEvent): string[] {
  const raw: string[] = [];
  for (const field of ['refs', 'touch_refs', 'keyword_ref'] as const) {
    raw.push(...touchesOf(ev[field]));
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const key = r.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export interface AttributionVerdict {
  class: AttributionClass;
  reason: FunnelUnknownReason | null;
  refs: string[];
}

/**
 * Decide the attribution class from explicit evidence only. A missing
 * provenance source or timestamp demotes a present reference to UNKNOWN — a
 * claim is not an observation.
 */
export function classifyAttribution(ev: FunnelAttributionEvent): AttributionVerdict {
  const refs = observedRefs(ev);
  if (refs.length === 0) {
    return { class: 'unknown', reason: 'no_attribution_data', refs };
  }
  const provenanced =
    nonEmptyString(ev.attribution_source) !== null && isTimestamp(ev.observed_at);
  if (!provenanced) {
    return { class: 'unknown', reason: 'observation_not_provenanced', refs };
  }
  if (refs.length === 1) return { class: 'observed_keyword', reason: null, refs };
  return { class: 'multitouch', reason: null, refs };
}

/** Normalize a raw kind into the adapter vocabulary, or null when unmapped. */
export function normalizeOutcomeKind(raw: unknown): OutcomeKind | null {
  const s = nonEmptyString(raw);
  if (!s) return null;
  const key = s.toLowerCase().replace(/[\s-]+/g, '_');
  for (const kind of OUTCOME_KINDS) {
    if (OUTCOME_ALIASES[kind].includes(key)) return kind;
  }
  return null;
}

// ─── Aggregation ────────────────────────────────────────────────────────────

function bump(map: Map<FunnelUnknownReason, number>, reason: FunnelUnknownReason, by = 1): void {
  map.set(reason, (map.get(reason) ?? 0) + by);
}

function reasonList(map: Map<FunnelUnknownReason, number>): ReasonCount[] {
  return Array.from(map.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
}

/** Fresh copy of the named producer gaps — carried on every snapshot. */
function producerLimitations(): string[] {
  return PRODUCER_LIMITATION_IDS.map((id) => PRODUCER_LIMITATIONS[id]);
}

/**
 * Build the snapshot. Pure: no filesystem, no clock beyond `opts.now`.
 * `available: false` makes EVERY count `null` with `source_absent`.
 */
export function buildFunnelAttribution(
  records: readonly unknown[],
  opts: BuildOptions,
): FunnelAttributionSnapshot {
  const now = opts.now ?? new Date().toISOString();
  const source = opts.source ?? null;

  if (!opts.available) {
    return {
      source,
      available: false,
      status: 'UNKNOWN',
      reason: 'source_absent',
      attribution: {
        observed_keyword: null,
        multitouch: null,
        unknown: null,
        unknownReasons: [],
      },
      outcomes: OUTCOME_KINDS.map((kind) => ({
        kind,
        status: 'UNKNOWN' as const,
        count: null,
        reason: 'source_absent' as const,
        unknown: null,
        unknownReasons: [],
      })),
      unclassified: { count: null, reasons: [] },
      nonOutcome: null,
      refused: null,
      limitations: producerLimitations(),
      generatedAt: now,
    };
  }

  let observedKeyword = 0;
  let multitouch = 0;
  let unknownAttribution = 0;
  const attributionReasons = new Map<FunnelUnknownReason, number>();

  const counts: Record<OutcomeKind, number> = { gift: 0, contact: 0, booking: 0, sale: 0 };
  const unknownByKind: Record<OutcomeKind, Map<FunnelUnknownReason, number>> = {
    gift: new Map(),
    contact: new Map(),
    booking: new Map(),
    sale: new Map(),
  };

  let unclassified = 0;
  const unclassifiedReasons = new Map<FunnelUnknownReason, number>();
  let nonOutcome = 0;
  let refused = opts.sourceSkipped ?? 0;

  for (const raw of records) {
    if (!isPlainObject(raw)) {
      refused += 1;
      continue;
    }
    const ev = raw as FunnelAttributionEvent;

    const verdict = classifyAttribution(ev);
    if (verdict.class === 'observed_keyword') observedKeyword += 1;
    else if (verdict.class === 'multitouch') multitouch += 1;
    else {
      unknownAttribution += 1;
      bump(attributionReasons, verdict.reason ?? 'no_attribution_data');
    }

    const kind = normalizeOutcomeKind(ev.kind);
    if (kind === null) {
      // `unclassified` is "kind PRESENT but outside the vocabulary" and
      // `nonOutcome` is "no outcome kind at all" — a blank or unreadable kind
      // is still a kind the event carried, so it is unclassified. Only an
      // absent kind (`undefined` / `null` / missing) is a non-outcome.
      if (ev.kind === undefined || ev.kind === null) nonOutcome += 1;
      else {
        unclassified += 1;
        bump(unclassifiedReasons, 'outcome_kind_unrecognized');
      }
      continue;
    }

    const evidenced =
      nonEmptyString(ev.attribution_source) !== null && isTimestamp(ev.observed_at);
    if (!evidenced) {
      bump(unknownByKind[kind], 'outcome_not_evidenced');
      continue;
    }
    counts[kind] += 1;
  }

  return {
    source,
    available: true,
    status: 'OBSERVED',
    reason: null,
    attribution: {
      observed_keyword: observedKeyword,
      multitouch,
      unknown: unknownAttribution,
      unknownReasons: reasonList(attributionReasons),
    },
    outcomes: OUTCOME_KINDS.map((kind) => {
      const unknownMap = unknownByKind[kind];
      const unknown = Array.from(unknownMap.values()).reduce((a, b) => a + b, 0);
      return {
        kind,
        status: 'OBSERVED' as const,
        count: counts[kind],
        reason: null,
        unknown,
        unknownReasons: reasonList(unknownMap),
      };
    }),
    unclassified: { count: unclassified, reasons: reasonList(unclassifiedReasons) },
    nonOutcome,
    refused,
    limitations: producerLimitations(),
    generatedAt: now,
  };
}

/**
 * Load from the accepted Round-3 reader (`pixel-events/`). Every record is
 * first mapped through `mapPixelEventRecord`, so the source's own schema is
 * read honestly instead of being guessed into the contract. The reader is
 * injectable so unit tests never read a real client workspace.
 */
export function loadFunnelAttribution(opts: LoadOptions = {}): FunnelAttributionSnapshot {
  const read =
    opts.read ??
    ((): FunnelAttributionSource => readJsonlDir<unknown>('pixel-events'));
  const res = read();
  return buildFunnelAttribution(res.records.map(mapPixelEventRecord), {
    available: res.available,
    source: res.source,
    sourceSkipped: res.skipped ?? 0,
    now: opts.now,
  });
}

// ─── View model ─────────────────────────────────────────────────────────────

export const ATTRIBUTION_LABELS: Record<AttributionClass, string> = {
  observed_keyword: 'Observed keyword',
  multitouch: 'Multitouch',
  unknown: 'Unknown attribution',
};

export const OUTCOME_LABELS: Record<OutcomeKind, string> = {
  gift: 'Gifts',
  contact: 'Contacts',
  booking: 'Bookings',
  sale: 'Sales',
};

/** Label for the row that carries records with no outcome kind at all. */
export const NON_OUTCOME_LABEL = 'Records with no outcome kind (not an outcome event)';

export interface FunnelRow {
  id: string;
  label: string;
  status: 'OBSERVED' | 'UNKNOWN';
  /** `null` iff status is UNKNOWN — a null count can never render as 0. */
  count: number | null;
  /** Human reason when status is UNKNOWN or when the row has refusals. */
  detail: string | null;
}

export interface FunnelViewRows {
  banner: string | null;
  attribution: FunnelRow[];
  outcomes: FunnelRow[];
  /**
   * Records that carried no outcome kind at all. Kept as its own row so a
   * computed counter is never left invisible: the outcomes rows are exactly
   * the four kinds, so a non-outcome cannot ride along in one of them.
   */
  nonOutcome: FunnelRow;
  footnote: string | null;
  /** Named input-contract gaps, rendered so a limitation is never invisible. */
  limitations: string[];
}

/**
 * Turn a snapshot into render rows. UNKNOWN rows carry `count: null` plus the
 * reason text, so a consumer cannot accidentally print a zero or a green check
 * for data that was never observed.
 */
export function buildFunnelAttributionRows(snapshot: FunnelAttributionSnapshot): FunnelViewRows {
  const banner =
    snapshot.status === 'UNKNOWN'
      ? `Funnel attribution UNKNOWN — ${REASON_TEXT[snapshot.reason ?? 'source_absent']}. No counts are shown.`
      : null;

  const attribution: FunnelRow[] = ATTRIBUTION_CLASSES.map((cls) => {
    if (snapshot.status === 'UNKNOWN') {
      return {
        id: cls,
        label: ATTRIBUTION_LABELS[cls],
        status: 'UNKNOWN',
        count: null,
        detail: REASON_TEXT[snapshot.reason ?? 'source_absent'],
      };
    }
    const count = snapshot.attribution[cls];
    const reasons = snapshot.attribution.unknownReasons;
    const detail =
      cls === 'unknown' && reasons.length
        ? reasons.map((r) => `${REASON_TEXT[r.reason]} (${r.count})`).join('; ')
        : null;
    return { id: cls, label: ATTRIBUTION_LABELS[cls], status: 'OBSERVED', count, detail };
  });

  const outcomes: FunnelRow[] = snapshot.outcomes.map((bucket) => {
    if (bucket.status === 'UNKNOWN') {
      return {
        id: bucket.kind,
        label: OUTCOME_LABELS[bucket.kind],
        status: 'UNKNOWN',
        count: null,
        detail: REASON_TEXT[bucket.reason ?? 'source_absent'],
      };
    }
    const detail =
      bucket.unknown && bucket.unknown > 0
        ? bucket.unknownReasons
            .map((r) => `${REASON_TEXT[r.reason]} (${r.count})`)
            .join('; ')
        : null;
    return {
      id: bucket.kind,
      label: OUTCOME_LABELS[bucket.kind],
      status: 'OBSERVED',
      count: bucket.count,
      detail,
    };
  });

  const nonOutcome: FunnelRow =
    snapshot.status === 'UNKNOWN'
      ? {
          id: 'non_outcome',
          label: NON_OUTCOME_LABEL,
          status: 'UNKNOWN',
          count: null,
          detail: REASON_TEXT[snapshot.reason ?? 'source_absent'],
        }
      : {
          id: 'non_outcome',
          label: NON_OUTCOME_LABEL,
          status: 'OBSERVED',
          count: snapshot.nonOutcome,
          detail: null,
        };

  const notes: string[] = [];
  if (snapshot.status === 'OBSERVED' && snapshot.unclassified.count) {
    notes.push(`${snapshot.unclassified.count} event(s) not counted in gift/contact/booking/sale: ${REASON_TEXT.outcome_kind_unrecognized}.`);
  }
  if (snapshot.status === 'OBSERVED' && snapshot.nonOutcome) {
    notes.push(`${snapshot.nonOutcome} record(s) carried no outcome kind: not an outcome event.`);
  }
  if (snapshot.status === 'OBSERVED' && snapshot.refused) {
    notes.push(`${snapshot.refused} record(s) refused as malformed.`);
  }

  return {
    banner,
    attribution,
    outcomes,
    nonOutcome,
    footnote: notes.length ? notes.join(' ') : null,
    limitations: [...snapshot.limitations],
  };
}
