/**
 * Scoped council event delivery (CWE-030, directive Sections 17.2,
 * 18.1-18.3, 28.2; binding B07).
 *
 * This service is the ONLY server path that turns committed council
 * journal rows into client-bound events, and it enforces scope
 * server-side, before any content is shaped:
 *
 *   - Authorization is decided by CWE-007 (the route resolves the
 *     principal and calls assertCouncilSessionRead) and handed to
 *     this service as a completed access decision. This service
 *     never re-derives authority from request input.
 *   - A consumer receives an event only when the event's scope
 *     matches the authorized session scope. Cross-tenant and
 *     cross-company sessions are not found at all (the CWE-006
 *     store scopes every read by tenant and company, and the route's
 *     session load does the same), so a foreign subscriber receives
 *     the typed not-found, never a redacted stream.
 *   - Private sessions: the owner receives full events. Any other
 *     authorized reader (support, via the audited CWE-007 support
 *     path) receives at most the non-sensitive invalidation signal
 *     on this surface, per the unit brief; their content read path
 *     is the session snapshot route, not the event stream. Company
 *     scoping alone never unlocks private event content.
 *   - Events are committed before display: every byte served here
 *     comes from the durable council_events journal. Nothing is
 *     served from an in-memory buffer, and nothing is written to
 *     the host's sse_event_log fan-out table (whose rows are
 *     deleted after five minutes and whose registry has no owner
 *     dimension). Council journal retention follows Section 16:
 *     no code in this layer deletes journal rows, ever.
 *
 * Reconnect semantics (Section 18.3): pages are gapless because the
 * journal is gapless per session. A client whose cursor is inside
 * the journal gets the exact missed page. A client whose cursor is
 * unusable (negative, ahead of the journal, or so far behind that
 * the missed page exceeds the resync cap) gets a snapshot of the
 * folded projection instead: never a silently partial history.
 */

import type { CouncilAccessVia } from '../auth';
import type { CouncilEnvelope, CouncilRepositories } from '../store';
import type { CouncilStore } from '../persistence/council-store';
import {
  projectSession,
  summarizeProjection,
  toWireEvents,
} from './projection';
import type {
  CouncilCatchUp,
  CouncilEventPage,
  CouncilEventPageResult,
  CouncilEventScope,
  CouncilInvalidationSignal,
  CouncilResyncSnapshot,
  CouncilSessionListEntry,
} from './types';

export const EVENT_PAGE_DEFAULT_LIMIT = 200;
export const EVENT_PAGE_MAX_LIMIT = 500;
/** Missed events beyond this count resync by snapshot, not by page. */
export const RESYNC_PAGE_CAP = 500;

/** The route's completed CWE-007 access decision for one session. */
export interface CouncilEventAccess {
  envelope: CouncilEnvelope;
  accessVia: CouncilAccessVia;
  session: {
    id: string;
    tenant_id: string;
    company_id: string;
    installation_id: string;
    owner_subject: string | null;
    visibility: 'private' | 'company';
    state: string;
    state_version: number;
  };
}

export function scopeOfAccess(access: CouncilEventAccess): CouncilEventScope {
  return {
    tenant_id: access.session.tenant_id,
    company_id: access.session.company_id,
    installation_id: access.session.installation_id,
    session_id: access.session.id,
    visibility: access.session.visibility,
    owner_subject: access.session.owner_subject,
  };
}

/**
 * Whether this access carries event CONTENT. Private sessions give
 * content to their owner only; support access on the events surface
 * is signal-only even though CWE-007 grants support an audited read
 * of the session record itself.
 */
export function accessHasContent(access: CouncilEventAccess): boolean {
  if (access.session.visibility === 'company') return true;
  return access.accessVia === 'owner';
}

export class CouncilEventDelivery {
  private readonly repositories: CouncilRepositories;
  private readonly store: CouncilStore;

  constructor(deps: { repositories: CouncilRepositories; store: CouncilStore }) {
    this.repositories = deps.repositories;
    this.store = deps.store;
  }

  /** The session's current committed sequence head and state version. */
  private head(access: CouncilEventAccess): { lastSequence: number; stateVersion: number } {
    const events = this.repositories.listEvents(access.envelope, access.session.id, 0);
    const projection = projectSession(scopeOfAccess(access), events);
    return {
      lastSequence: events.length > 0 ? events[events.length - 1].sequence : 0,
      stateVersion: projection?.state_version ?? access.session.state_version,
    };
  }

  private invalidationSignal(access: CouncilEventAccess): CouncilInvalidationSignal {
    const head = this.head(access);
    return {
      kind: 'council.session.invalidated',
      session_id: access.session.id,
      scope: scopeOfAccess(access),
      state_version: head.stateVersion,
      last_sequence: head.lastSequence,
      occurred_at: new Date().toISOString(),
    };
  }

  /**
   * One page of committed events after `afterSequence` (0 = from the
   * beginning). For signal-only access the page is the invalidation
   * signal: no event rows, types, actors, or payloads leave this
   * service for a private session's non-owner.
   */
  page(
    access: CouncilEventAccess,
    afterSequence: number,
    limit: number = EVENT_PAGE_DEFAULT_LIMIT,
  ): CouncilEventPageResult {
    if (!accessHasContent(access)) {
      return { kind: 'invalidation', signal: this.invalidationSignal(access) };
    }
    const capped = Math.max(1, Math.min(limit, EVENT_PAGE_MAX_LIMIT));
    const after = Math.max(0, Math.floor(afterSequence));
    const all = this.repositories.listEvents(access.envelope, access.session.id, 0);
    const wire = toWireEvents(scopeOfAccess(access), all);
    const lastSequence = wire.length > 0 ? wire[wire.length - 1].sequence : 0;
    const missed = wire.filter((event) => event.sequence > after);
    const events = missed.slice(0, capped);
    const page: CouncilEventPage = {
      kind: 'events',
      session_id: access.session.id,
      events,
      last_sequence: lastSequence,
      has_more: missed.length > events.length,
    };
    return page;
  }

  /** The folded projection snapshot for this session, if authorized. */
  snapshot(access: CouncilEventAccess): CouncilResyncSnapshot | CouncilInvalidationSignal {
    if (!accessHasContent(access)) return this.invalidationSignal(access);
    const events = this.repositories.listEvents(access.envelope, access.session.id, 0);
    const projection = projectSession(scopeOfAccess(access), events);
    const lastSequence = events.length > 0 ? events[events.length - 1].sequence : 0;
    if (!projection) {
      // A session row exists (the route loaded it) but its journal
      // has no creation event: that is store inconsistency. Throw so
      // the route answers a typed internal error instead of
      // fabricating a session shell.
      throw new Error(
        `Council session ${access.session.id} has no session_created journal event; refusing to fabricate a projection.`,
      );
    }
    return {
      kind: 'snapshot',
      session_id: access.session.id,
      projection,
      last_sequence: lastSequence,
    };
  }

  /**
   * Reconnect catch-up (Section 18.3): an exact gapless page when
   * the cursor is usable, a snapshot when it is not, and never a
   * silently partial history.
   */
  catchUp(access: CouncilEventAccess, afterSequence: number): CouncilCatchUp {
    if (!accessHasContent(access)) {
      return { kind: 'invalidation', signal: this.invalidationSignal(access) };
    }
    const events = this.repositories.listEvents(access.envelope, access.session.id, 0);
    const lastSequence = events.length > 0 ? events[events.length - 1].sequence : 0;
    const after = Math.floor(afterSequence);
    if (after < 0 || after > lastSequence || lastSequence - after > RESYNC_PAGE_CAP) {
      const snapshot = this.snapshot(access);
      if (snapshot.kind !== 'snapshot') {
        return { kind: 'invalidation', signal: snapshot };
      }
      return { kind: 'snapshot', snapshot };
    }
    const page = this.page(access, after);
    if (page.kind !== 'events') return { kind: 'invalidation', signal: page.signal };
    return { kind: 'page', page };
  }

  /**
   * The session-list projection for the envelope's tenant/company:
   * one folded summary per session the envelope may see (company
   * sessions, plus private sessions owned by the envelope actor).
   * Foreign scopes are excluded by the store query itself.
   */
  listProjection(access: { envelope: CouncilEnvelope }): CouncilSessionListEntry[] {
    const { envelope } = access;
    const rows = this.store
      .handle()
      .prepare(
        `SELECT id, tenant_id, company_id, installation_id, owner_subject, visibility
           FROM council_sessions
          WHERE tenant_id = ? AND company_id = ?
          ORDER BY created_at ASC`,
      )
      .all(envelope.tenant_id, envelope.company_id) as Array<{
      id: string;
      tenant_id: string;
      company_id: string;
      installation_id: string;
      owner_subject: string | null;
      visibility: 'private' | 'company';
    }>;
    const entries: CouncilSessionListEntry[] = [];
    for (const row of rows) {
      if (this.repositories.isDeleted(row.tenant_id, row.id)) continue;
      if (
        row.visibility === 'private' &&
        row.owner_subject !== envelope.actor_subject
      ) {
        continue;
      }
      const scope: CouncilEventScope = {
        tenant_id: row.tenant_id,
        company_id: row.company_id,
        installation_id: row.installation_id,
        session_id: row.id,
        visibility: row.visibility,
        owner_subject: row.owner_subject,
      };
      const events = this.repositories.listEvents(envelope, row.id, 0);
      const projection = projectSession(scope, events);
      if (projection) entries.push(summarizeProjection(projection));
    }
    return entries;
  }
}

/**
 * Scope-qualified cache keys (Section 18, brief item 3). Every key
 * embeds the full scope, so an event can only ever invalidate
 * entries belonging to its own tenant, company, installation, and
 * session. There is deliberately no unscoped council cache key.
 */
export function councilCacheKey(
  scope: CouncilEventScope,
  resource: 'session' | 'room' | 'list',
): string {
  const base =
    `council:v1:t/${scope.tenant_id}/c/${scope.company_id}` +
    `/i/${scope.installation_id}`;
  if (resource === 'list') return `${base}/sessions`;
  return `${base}/s/${scope.session_id}/${resource}`;
}

/** The exact keys one committed event invalidates: its own scope's. */
export function invalidationKeysForEvent(scope: CouncilEventScope): string[] {
  return [
    councilCacheKey(scope, 'session'),
    councilCacheKey(scope, 'room'),
    councilCacheKey(scope, 'list'),
  ];
}
