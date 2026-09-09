/**
 * Rescue Rangers incident identity (RR-020): server-derived projection keys.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The Command Center's rescue projection rules, stated in one pure module so
 * every CC consumer (dashboard, digest, board projector) resolves incident
 * identity, notification budgets and alias suggestions the SAME way. Pure
 * functions only: no I/O, no credentials, no network. The caller supplies rows
 * it already read through the read-only dashboard handle; this module derives
 * the PROJECTION identity from them.
 *
 * THE RR-020 RULES THIS ENCODES
 * -----------------------------
 * 1. RUNTIME INCIDENT IDs. The incident id for authorization and projection is
 *    the COMPANY ENROLLMENT RUNTIME incident id — the ticket id the enrollment
 *    runtime (RR-04 ledger) minted, carried on the row as `ticket_id` (the
 *    enrollment-bound identity). It is IMMUTABLE once minted: projections
 *    group, dedup and authorize by it, never by a display label.
 * 2. BUDGETS vs DEDUP ARE SEPARATE. Per-PERSON notification budgets key on the
 *    person/identity the enrollment binds (one human, one daily budget, no
 *    matter how many machines). Per-RESOURCE incident dedup keys on the
 *    company enrollment runtime incident id + failure fingerprint. A repeat
 *    incident on the same resource folds into its incident id; the PERSON's
 *    notification budget is a different counter entirely.
 * 3. FINGERPRINT THE ACTUAL FAILED TARGET AND SIGNATURE. The dedup
 *    fingerprint is (canonical box slug + failure signature), where the box
 *    slug comes from the TICKET ROW's enrollment-bound slug — never from a
 *    caller display name. Two DISTINCT boxes of the same client stay two
 *    independently actionable incidents; the same failure signature on the
 *    SAME box folds.
 * 4. ALIASES SUGGEST, NEVER CHOOSE. A standing alias lookup may surface
 *    candidate identities for an ambiguous label. This module returns
 *    candidates ranked; it NEVER selects a foreign delivery target on
 *    ambiguity. When candidates are ambiguous (more than one plausible match),
 *    the delivery target is NOT resolved: the caller must route the request to
 *    operator triage instead.
 * 5. UNKNOWN IDENTITIES GO TO ISOLATED OPERATOR TRIAGE, durably retained.
 *    `routeIdentity()` returns a triage bucket for anything it cannot bind to
 *    exactly one enrollment. Triage items carry durable retention; they are
 *    never silently dropped and never mixed into client projections.
 * 6. NEVER ROUTE BY DISPLAY NAME OR CALLER RETURN ADDRESS. Display names and
 *    caller return addresses are HINTS for resolution, never routing keys.
 *    Routing keys are enrollment-bound identities only.
 *
 * CREDENTIAL POSTURE: no credential values are read, held, or emitted here.
 * Company credentials for CC are derived SERVER-SIDE (operator enrollment
 * records); this module consumes identity strings only.
 */

import type { RescueTicket } from './types';

/** A candidate surfaced by a standing alias lookup. */
export interface AliasCandidate {
  /** Canonical enrollment-bound box slug of the candidate. */
  boxSlug: string;
  /** Enrollment-bound person/client identity key (not a display label). */
  identityKey: string;
  /** Which field matched (box_slug | alias | client_label). */
  matchedOn: 'box_slug' | 'alias' | 'client_label';
}

/** The result of resolving a projection identity. */
export type IdentityRoute =
  | {
      kind: 'exact';
      identityKey: string;
      boxSlug: string;
      incidentId: string;
    }
  | {
      kind: 'ambiguous';
      /** Ranked candidates — suggestions only, never a choice. */
      candidates: AliasCandidate[];
      /** Where an ambiguous identity lands: isolated operator triage. */
      route: 'operator-triage';
    }
  | {
      kind: 'unknown';
      /** Unknown identities are quarantined for operator triage with durable retention. */
      route: 'operator-triage';
      /** Stable quarantine key so the same unknown caller stays one triage thread. */
      triageKey: string;
    };

/** A per-resource incident dedup fingerprint. */
export interface IncidentFingerprint {
  /** Company enrollment runtime incident id (immutable ticket id). */
  incidentId: string;
  /** Canonical box slug from the ticket row (enrollment-bound), never a display name. */
  boxSlug: string;
  /** Failure signature (normalized problem text digest). */
  signature: string;
  /** person-bound notification budget key (independent of the fingerprint). */
  personBudgetKey: string;
}

/** Fold a display string for comparison. Never a routing key by itself. */
export function foldIdentity(value: string | null | undefined): string {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The company enrollment runtime incident id. IMMUTABLE for the life of the
 * incident: the ledger minted it, the row carries it, projections key on it.
 */
export function incidentIdOf(ticket: Pick<RescueTicket, 'ticketId'>): string {
  return String(ticket.ticketId || '').trim();
}

/**
 * Per-person notification budget key. One human = one daily notification
 * budget across every box they own. Keyed on the enrollment person binding
 * (person when present, else the identity key) — NEVER on a display label and
 * NEVER on the incident id. This budget counts NOTIFICATIONS; it has nothing
 * to do with incident dedup.
 */
export function personBudgetKeyOf(ticket: Pick<RescueTicket, 'person' | 'client' | 'box'>): string {
  const person = foldIdentity(ticket.person);
  if (person) return 'person:' + person;
  // Fall back to the client binding (still an enrollment record, not a raw label).
  const client = foldIdentity(ticket.client);
  if (client) return 'person:' + client;
  // No enrollment person binding: degrade DISTINCT (never merge strangers).
  const box = foldIdentity(ticket.box);
  return 'person-unbound:' + (box || 'unknown');
}

/**
 * Per-resource incident fingerprint. Two DISTINCT boxes of one client yield
 * two DISTINCT fingerprints (each independently actionable); the same
 * signature on the SAME box yields the SAME fingerprint (folds).
 */
export function incidentFingerprintOf(
  ticket: Pick<RescueTicket, 'ticketId' | 'person' | 'client' | 'box' | 'problem' | 'failureClass'>,
): IncidentFingerprint {
  const boxSlug = foldIdentity(ticket.box);
  const signature = failureSignatureOf(ticket);
  return {
    incidentId: incidentIdOf(ticket),
    boxSlug,
    signature,
    personBudgetKey: personBudgetKeyOf(ticket),
  };
}

/**
 * Normalize a problem text into a comparable signature: strip timestamps,
 * long hex ids and bare numbers, keep wording. Mirrors the server-side
 * problemSignature normalization so a fold decided server-side stays a fold
 * in projection (compare like with like).
 */
export function failureSignatureOf(
  ticket: Pick<RescueTicket, 'problem' | 'failureClass'>,
): string {
  let t = String(ticket.problem == null ? '' : ticket.problem).toLowerCase();
  t = t.replace(/\d{4}-\d{2}-\d{2}[t ][0-9:.]+z?/g, ' ');
  t = t.replace(/\b[0-9a-f]{8,}\b/g, ' ');
  t = t.replace(/\b\d+(\.\d+)?\b/g, ' ');
  t = t.replace(/[^a-z]+/g, ' ');
  const words = t.split(' ').filter((w) => w.length > 2).slice(0, 24).join(' ');
  const cls = foldIdentity(ticket.failureClass);
  return cls + (cls && words ? '::' : '') + words;
}

/**
 * Resolve an identity claim through a standing alias lookup.
 *
 * ALIAS SUGGESTION RULE: candidates are returned RANKED as suggestions. A
 * single exact box_slug match resolves EXACTLY. Anything else — zero matches
 * (unknown) or more than one plausible match (ambiguous) — NEVER resolves to a
 * delivery target: it routes to isolated operator triage. A foreign target is
 * never chosen on ambiguity, and a display name or caller return address is
 * never a routing key.
 */
export function routeIdentity(
  claim: { boxSlug?: string | null; clientLabel?: string | null; returnTo?: string | null },
  aliasRows: Array<{ box_slug: string; client_label?: string | null; aliases?: string | null }>,
): IdentityRoute {
  const claimedBox = foldIdentity(claim.boxSlug);
  const claimedLabel = foldIdentity(claim.clientLabel);

  if (!claimedBox && !claimedLabel) {
    return {
      kind: 'unknown',
      route: 'operator-triage',
      triageKey: 'unknown:' + foldIdentity(claim.returnTo || 'no-claim'),
    };
  }

  const candidates: AliasCandidate[] = [];
  for (const row of aliasRows) {
    const slug = foldIdentity(row.box_slug);
    if (!slug) continue;
    if (claimedBox && slug === claimedBox) {
      candidates.push({ boxSlug: slug, identityKey: slug, matchedOn: 'box_slug' });
      continue;
    }
    const label = foldIdentity(row.client_label);
    if (claimedLabel && label === claimedLabel) {
      candidates.push({ boxSlug: slug, identityKey: slug, matchedOn: 'client_label' });
      continue;
    }
    if (claimedBox && String(row.aliases || '')
      .split('|')
      .map((a) => foldIdentity(a))
      .includes(claimedBox)) {
      candidates.push({ boxSlug: slug, identityKey: slug, matchedOn: 'alias' });
    }
  }

  // Exact enrollment-bound slug match wins ONLY when it is unambiguous.
  const exact = candidates.filter((c) => c.matchedOn === 'box_slug');
  if (exact.length === 1) {
    return { kind: 'exact', identityKey: exact[0].identityKey, boxSlug: exact[0].boxSlug, incidentId: exact[0].boxSlug };
  }

  // Client-label matches are SUGGESTIONS: they never choose a target on their
  // own, because a label can name several boxes. Ambiguity routes to triage.
  if (candidates.length === 1 && candidates[0].matchedOn === 'client_label') {
    return {
      kind: 'ambiguous',
      candidates,
      route: 'operator-triage',
    };
  }
  if (candidates.length > 1) {
    // Rank: box_slug > alias > client_label, stable within class.
    const rank = { box_slug: 0, alias: 1, client_label: 2 } as const;
    candidates.sort((a, b) => rank[a.matchedOn] - rank[b.matchedOn] || a.boxSlug.localeCompare(b.boxSlug));
    return { kind: 'ambiguous', candidates, route: 'operator-triage' };
  }

  return {
    kind: 'unknown',
    route: 'operator-triage',
    triageKey: 'unknown:' + (claimedBox || claimedLabel),
  };
}

/**
 * The operator board versus client projection policy, as one pure predicate so
 * the dashboard and any future projector cannot drift apart:
 *   - the OPERATOR BOARD sees everything it has rows for (including triage
 *     quarantines, which live in their own panel);
 *   - the CLIENT PROJECTION shows a client only rows whose enrollment-bound
 *     identity matches that client, and never shows another client's row,
 *     never shows triage content, and never carries credential material.
 */
export function projectionPolicy(): {
  boardSeesTriage: boolean;
  clientProjectionKeysOn: 'enrollment-bound identity';
  clientSeesForeignRows: false;
  clientSeesTriage: false;
  routingKeysAllowed: Array<'enrollment-bound identity' | 'company enrollment runtime incident id'>;
  routingKeysForbidden: Array<'display name' | 'caller return address'>;
} {
  return {
    boardSeesTriage: true,
    clientProjectionKeysOn: 'enrollment-bound identity',
    clientSeesForeignRows: false,
    clientSeesTriage: false,
    routingKeysAllowed: ['enrollment-bound identity', 'company enrollment runtime incident id'],
    routingKeysForbidden: ['display name', 'caller return address'],
  };
}
