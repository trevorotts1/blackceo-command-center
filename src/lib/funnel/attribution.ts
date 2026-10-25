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
 *      A reference must be an IDENTIFIER — letters, digits, space, `.`, `_`,
 *      `-` — never a URL, a path, markup, a JSON blob or a bare number.
 *      Percent escapes, compatibility forms, zero-width characters and
 *      trailing slashes are normalized so one keyword has one spelling. When
 *      the caller supplies an expected `tenant`, a reference that belongs to a
 *      different tenant (or to none) is refused instead of attributed.
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
  | 'ref_not_an_identifier'
  | 'ref_foreign_tenant'
  | 'tenant_not_provenanced'
  | 'observation_not_provenanced'
  | 'outcome_not_evidenced'
  | 'outcome_kind_unrecognized'
  | 'malformed_record';

export const REASON_TEXT: Record<FunnelUnknownReason, string> = {
  source_absent: 'source unavailable — no events were observed',
  no_attribution_data: 'no attribution reference was observed on the event',
  ref_not_an_identifier:
    'a reference was present but is not an identifier (URL, path, markup or malformed text)',
  ref_foreign_tenant: 'the reference belongs to a different tenant than the one being reported',
  tenant_not_provenanced:
    'a tenant scope was requested but the event carried no tenant, so ownership is unproven',
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
  'tenant_id',
] as const;
export type FunnelInputContractField = (typeof FUNNEL_INPUT_CONTRACT_FIELDS)[number];

/** Named limitations carried on every snapshot. Ids are stable, text is prose. */
export const PRODUCER_LIMITATION_IDS = [
  'pixel_events_schema_gap',
  'tenant_scope_unverified',
] as const;
export type ProducerLimitationId = (typeof PRODUCER_LIMITATION_IDS)[number];

export const PRODUCER_LIMITATIONS: Record<ProducerLimitationId, string> = {
  pixel_events_schema_gap:
    'pixel_events_schema_gap: no producer in this repository emits the input contract, so the wired pixel-events/ reader (Skill-38 Pixel-Concierge schema) can only map what the source proves — timestamp -> observed_at, agent_id -> attribution_source. No field of that schema is an attribution reference and none is an outcome kind (event_type is pageview/scroll/click/page_hidden/delete_request; referrer, path, data.href and data.text are page and copy, never attribution — D-05), so pixel events classify unknown and count no outcome until a producer emits the contract. This is a named gap, not a zero.',
  tenant_scope_unverified:
    'tenant_scope_unverified: no expected tenant was supplied to this build, so a reference cannot be checked against a tenant and is attributed to the provenance the record carries. Pass `tenant` (and a `tenant_id` on the record) to refuse a foreign-tenant reference; without it, tenant ownership is unproven, not established.',
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
  /** Tenant/account the reference belongs to. Needed to refuse a foreign ref. */
  tenant_id?: unknown;
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
  // The stored field is canonicalized to one UTC spelling. Keeping the raw
  // text would make three spellings of one instant compare unequal and a
  // sortable string sort in the wrong order; `canonicalInstant` also refuses
  // a stamp that names no real moment.
  const own = canonicalInstant(ev.observed_at);
  if (own !== null) ev.observed_at = own;
  else {
    const ts = canonicalInstant(raw.timestamp);
    if (ts !== null) ev.observed_at = ts;
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
  /**
   * The tenant this report is for. When supplied, a record whose reference
   * belongs to another tenant (or carries no tenant) is NOT attributed.
   */
  tenant?: string | null;
  now?: string;
}

export interface LoadOptions {
  read?: () => FunnelAttributionSource;
  /** See `BuildOptions.tenant`. */
  tenant?: string | null;
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
 * ISO-8601 date-time that denotes a real instant in a NAMED zone.
 *
 * Deliberately NOT bare `Date.parse`: that accepts `"0"`, `"2026"` and
 * `"2026-05-30"`, so a claim could pass the evidence gate without ever naming
 * a moment — and it silently rolls `2026-02-30` forward to March 2, certifying
 * an instant that never existed. Every field below is checked against the real
 * calendar, and the zone is REQUIRED: `2026-10-23T09:15:00` with no offset
 * names a different instant on every host, so it names no instant at all.
 * Seconds and fractions are optional; the zone is not.
 */
const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}:?\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Strict instant parse: epoch milliseconds, or null when no real instant is named. */
function parseInstant(v: unknown): number | null {
  const s = nonEmptyString(v);
  if (!s) return null;
  const m = ISO_DATETIME_RE.exec(s);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const fraction = m[7] ?? '';
  const millis = fraction ? Number((fraction + '000').slice(0, 3)) : 0;

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  const zone = m[8];
  if (zone !== 'Z' && zone !== 'z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const offHour = Number(digits.slice(0, 2));
    const offMinute = Number(digits.slice(2, 4));
    if (offMinute > 59) return null;
    if (offHour > 14 || (offHour === 14 && offMinute !== 0)) return null;
    offsetMinutes = sign * (offHour * 60 + offMinute);
  }

  const dt = new Date(0);
  dt.setUTCFullYear(year, month - 1, day);
  dt.setUTCHours(hour, minute, second, millis);
  // A roll cannot happen for a field validated above, but prove it: this also
  // guards the Date convention that maps years 0-99 to 1900-1999.
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day ||
    dt.getUTCHours() !== hour ||
    dt.getUTCMinutes() !== minute ||
    dt.getUTCSeconds() !== second ||
    dt.getUTCMilliseconds() !== millis
  ) {
    return null;
  }

  const ms = dt.getTime() - offsetMinutes * 60_000;
  // Refuse an instant outside the 4-digit-year form the contract can express,
  // so every stored value sorts against its siblings.
  if (!/^\d{4}-/.test(new Date(ms).toISOString())) return null;
  return ms;
}

/** Canonical UTC spelling of a real instant, or null. */
export function canonicalInstant(v: unknown): string | null {
  const ms = parseInstant(v);
  return ms === null ? null : new Date(ms).toISOString();
}

function isTimestamp(v: unknown): boolean {
  return parseInstant(v) !== null;
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

/** Invisible formatting characters a copy/paste can smuggle into a keyword. */
const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;

/**
 * A touch reference is an IDENTIFIER, not free text: at least one letter, and
 * only letters, digits, space, `.`, `_` and `-`. A URL, a path, a JSON blob, a
 * script tag or a bare number is not a keyword — accepting one would attribute
 * an event to a "reference" no campaign ever emitted.
 */
const REF_IDENTIFIER_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]*$/u;
const REF_HAS_LETTER_RE = /\p{L}/u;

/**
 * Normalize one observed reference to its canonical identifier, or null when
 * it is not an identifier at all.
 *
 * One keyword must have one spelling, or the same touch reads as multitouch
 * and two tenants' identical keywords are indistinguishable: percent escapes
 * are decoded (`%53UMMER` -> `SUMMER`), compatibility forms are folded
 * (NFKC), zero-width characters are removed, runs of whitespace collapse, and
 * trailing slashes are dropped. A broken escape or a shape outside the
 * identifier alphabet is refused rather than guessed (`SUMMER%`, URLs,
 * paths, markup, `{"a":1}`, `42`).
 */
function normalizeRef(raw: string): string | null {
  let t = raw;
  try {
    t = decodeURIComponent(t);
  } catch {
    // A broken escape cannot be decoded; the shape check below refuses it.
  }
  t = t.normalize('NFKC').replace(ZERO_WIDTH_RE, '').trim();
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/[/\\]+$/, '').trim();
  if (!t) return null;
  if (!REF_HAS_LETTER_RE.test(t)) return null;
  if (!REF_IDENTIFIER_RE.test(t)) return null;
  return t;
}

/** Every non-empty string the reference fields carried, before validation. */
function rawObservedRefs(ev: FunnelAttributionEvent): string[] {
  const raw: string[] = [];
  for (const field of ['refs', 'touch_refs', 'keyword_ref'] as const) {
    raw.push(...touchesOf(ev[field]));
  }
  return raw;
}

/**
 * Collect the DISTINCT VALID touch references the adapter observed. The three
 * fields are UNIONED — a reference observed in `touch_refs` is still observed
 * when `refs` is also present (and vice versa) — so a multitouch record can
 * never collapse into the single-keyword bucket. Dedupe is case-insensitive:
 * `['SUMMER','summer']` is ONE touch, not multitouch. Each field is read in
 * whatever shape it was written (a bare string or a list of strings), because
 * dropping the shapes the field was not written in would drop an observed
 * touch and report a multitouch as a single keyword. A value that is not an
 * identifier is not a touch and is never invented.
 */
export function observedRefs(ev: FunnelAttributionEvent): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawObservedRefs(ev)) {
    const r = normalizeRef(raw);
    if (r === null) continue;
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

export interface AttributionOptions {
  /**
   * The tenant this report is for. When supplied, the event must CARRY the
   * same tenant — a reference from another tenant (or one with no tenant at
   * all) is refused rather than attributed to this source.
   */
  tenant?: string | null;
}

/**
 * The tenant leg of the evidence gate. Returns a refusal reason, or null when
 * the event may be attributed. With no expected tenant the leg is unproven —
 * the snapshot carries `tenant_scope_unverified` — but the record is not
 * refused, because no caller asked for a tenant-scoped answer.
 */
function tenantVerdict(
  ev: FunnelAttributionEvent,
  expected: string | null,
): FunnelUnknownReason | null {
  if (expected === null) return null;
  const actual = nonEmptyString(ev.tenant_id);
  if (actual === null) return 'tenant_not_provenanced';
  return actual.toLowerCase() === expected.toLowerCase() ? null : 'ref_foreign_tenant';
}

/**
 * Decide the attribution class from explicit evidence only. A reference that
 * is not an identifier is never a touch; a missing provenance source or
 * timestamp demotes a present reference to UNKNOWN — a claim is not an
 * observation.
 */
export function classifyAttribution(
  ev: FunnelAttributionEvent,
  opts: AttributionOptions = {},
): AttributionVerdict {
  const refs = observedRefs(ev);
  if (refs.length === 0) {
    const reason: FunnelUnknownReason =
      rawObservedRefs(ev).length > 0 ? 'ref_not_an_identifier' : 'no_attribution_data';
    return { class: 'unknown', reason, refs };
  }
  const tenantReason = tenantVerdict(ev, nonEmptyString(opts.tenant));
  if (tenantReason !== null) return { class: 'unknown', reason: tenantReason, refs };
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

/**
 * Fresh copy of the named producer gaps — carried on every snapshot. The
 * tenant gap is only a gap while no expected tenant was supplied; once one is,
 * ownership is actually checked and the note would be false.
 */
function producerLimitations(tenantExpected: boolean): string[] {
  return PRODUCER_LIMITATION_IDS
    .filter((id) => id !== 'tenant_scope_unverified' || !tenantExpected)
    .map((id) => PRODUCER_LIMITATIONS[id]);
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
  const expectedTenant = nonEmptyString(opts.tenant);

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
      limitations: producerLimitations(expectedTenant !== null),
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

    const verdict = classifyAttribution(ev, { tenant: expectedTenant });
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

    const tenantReason = tenantVerdict(ev, expectedTenant);
    if (tenantReason !== null) {
      bump(unknownByKind[kind], tenantReason);
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
    limitations: producerLimitations(expectedTenant !== null),
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
    tenant: opts.tenant,
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
