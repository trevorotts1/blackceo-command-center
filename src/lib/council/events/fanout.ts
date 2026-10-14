/**
 * Outbox-driven council event fanout (CWE-030, directive Sections
 * 16.2, 18.2; binding B07).
 *
 * The CWE-006 projection outbox is the committed notification that
 * new journal work exists: every accepted card and validated
 * verdict enqueues an intent in the SAME transaction as its journal
 * event. This module is the fanout consumer of those intents. It
 * claims due intents, resolves each one back to its durable journal
 * event, and publishes the resulting wire event to the subscription
 * registry, which is where scope enforcement for live delivery
 * lives:
 *
 *   - A subscription is created only from a completed CWE-007
 *     authorization (the route or composition root decides who may
 *     subscribe to what). The registry matches on the full scope:
 *     tenant, company, installation, AND session. There is no
 *     broadcast-to-everyone operation in this module, and no
 *     subscription can widen itself after creation.
 *   - Private sessions: content subscriptions exist only for the
 *     owner. A signal-only subscription (for example an audited
 *     support reader) receives the invalidation signal instead of
 *     the event, so private content cannot leak through the live
 *     path even if a signal subscription is misregistered with a
 *     content payload: the registry re-derives what a subscription
 *     may receive from the event's own scope and the subscription's
 *     content flag on every publish.
 *   - Delivery is idempotent at the consumer (Section 18.2): the
 *     registry suppresses exact duplicates per subscription (same
 *     event ID or same sequence), and the client reducer dedups
 *     again. A transport duplicate, a double claim, or a journal
 *     row plus a live push of the same event therefore reaches a
 *     reducer as ONE semantic event (T057).
 *
 * Council events NEVER pass through the host's src/lib/events.ts
 * broadcast(): that registry is keyed by company alone, treats
 * null scope as "deliver to every connection", has no owner
 * dimension, and journals into a table deleted after five minutes.
 * Routing council events there would recreate B07 exactly.
 */

import type { CouncilEnvelope, CouncilRepositories } from '../store';
import type { CouncilStore } from '../persistence/council-store';
import { toWireEvents } from './projection';
import type {
  CouncilEventScope,
  CouncilInvalidationSignal,
  CouncilWireEvent,
} from './types';

export interface CouncilSubscription {
  scope: CouncilEventScope;
  /** True only when CWE-007 granted this subscriber event content. */
  contentAccess: boolean;
  send: (message: CouncilWireEvent | CouncilInvalidationSignal) => void;
}

interface TrackedSubscription {
  subscription: CouncilSubscription;
  deliveredEventIds: Set<string>;
  deliveredSequences: Set<number>;
  lastSignalStateVersion: number;
}

export class CouncilEventSubscriptions {
  private readonly subscriptions = new Set<TrackedSubscription>();

  /** Register a subscription; returns its unsubscribe function. */
  subscribe(subscription: CouncilSubscription): () => void {
    const tracked: TrackedSubscription = {
      subscription,
      deliveredEventIds: new Set(),
      deliveredSequences: new Set(),
      lastSignalStateVersion: -1,
    };
    this.subscriptions.add(tracked);
    return () => {
      this.subscriptions.delete(tracked);
    };
  }

  get size(): number {
    return this.subscriptions.size;
  }

  /**
   * Publish one committed wire event to every subscription whose
   * scope matches exactly. Returns the number of deliveries made
   * (content or signal). Non-matching subscriptions receive
   * nothing at all: not a redacted event, not a signal, nothing.
   */
  publish(event: CouncilWireEvent): number {
    let deliveries = 0;
    for (const tracked of this.subscriptions) {
      const { scope } = tracked.subscription;
      if (
        scope.tenant_id !== event.scope.tenant_id ||
        scope.company_id !== event.scope.company_id ||
        scope.installation_id !== event.scope.installation_id ||
        scope.session_id !== event.scope.session_id
      ) {
        continue;
      }
      const mayHaveContent =
        tracked.subscription.contentAccess &&
        (event.scope.visibility === 'company' ||
          (event.scope.owner_subject !== null &&
            scope.owner_subject === event.scope.owner_subject));
      if (mayHaveContent) {
        if (
          tracked.deliveredEventIds.has(event.event_id) ||
          tracked.deliveredSequences.has(event.sequence)
        ) {
          continue; // transport duplicate: one semantic delivery only
        }
        tracked.deliveredEventIds.add(event.event_id);
        tracked.deliveredSequences.add(event.sequence);
        tracked.subscription.send(event);
        deliveries += 1;
      } else {
        // Signal-only for this subscription: one signal per state
        // version, carrying no event content whatsoever.
        if (tracked.lastSignalStateVersion >= event.state_version) continue;
        tracked.lastSignalStateVersion = event.state_version;
        const signal: CouncilInvalidationSignal = {
          kind: 'council.session.invalidated',
          session_id: event.session_id,
          scope: event.scope,
          state_version: event.state_version,
          last_sequence: event.sequence,
          occurred_at: event.occurred_at,
        };
        tracked.subscription.send(signal);
        deliveries += 1;
      }
    }
    return deliveries;
  }
}

export interface CouncilOutboxDrainResult {
  claimed: number;
  published: number;
  deliveries: number;
  marked_delivered: number;
  marked_failed: number;
  skipped_unlinked: number;
  skipped_gone: number;
}

interface SessionFactsRow {
  id: string;
  tenant_id: string;
  company_id: string;
  installation_id: string;
  owner_subject: string | null;
  visibility: 'private' | 'company';
}

/**
 * Drain due projection-outbox intents into the subscription
 * registry. Each claimed intent is resolved to its journal event
 * (the durable record; the intent is only the notification) and
 * published; the intent is then marked delivered. An intent whose
 * session was deleted, or whose journal event cannot be resolved,
 * never fans anything out. Resolution failure marks the intent
 * failed under the store's bounded retry policy rather than
 * dropping it silently.
 *
 * The pump is safe to run from more than one caller: claims are
 * reads until marked, a double publish is suppressed per
 * subscription, and consumers dedup again in the reducer.
 */
export function drainCouncilEventOutbox(
  deps: {
    repositories: CouncilRepositories;
    store: CouncilStore;
    subscriptions: CouncilEventSubscriptions;
  },
  envelope: CouncilEnvelope,
  limit = 50,
): CouncilOutboxDrainResult {
  const result: CouncilOutboxDrainResult = {
    claimed: 0,
    published: 0,
    deliveries: 0,
    marked_delivered: 0,
    marked_failed: 0,
    skipped_unlinked: 0,
    skipped_gone: 0,
  };
  const intents = deps.repositories.claimDueOutbox(envelope, limit);
  result.claimed = intents.length;
  for (const intent of intents) {
    try {
      if (intent.session_id === null || intent.event_sequence === null) {
        result.skipped_unlinked += 1;
        deps.repositories.markOutboxDelivered(envelope, intent.id);
        result.marked_delivered += 1;
        continue;
      }
      const facts = deps.store
        .handle()
        .prepare(
          `SELECT id, tenant_id, company_id, installation_id, owner_subject, visibility
             FROM council_sessions
            WHERE tenant_id = ? AND company_id = ? AND id = ?`,
        )
        .get(envelope.tenant_id, envelope.company_id, intent.session_id) as
        | SessionFactsRow
        | undefined;
      if (!facts || deps.repositories.isDeleted(facts.tenant_id, facts.id)) {
        // A deleted session fans nothing out, ever (Section 16.5):
        // a delayed intent must not reconstitute it.
        result.skipped_gone += 1;
        deps.repositories.markOutboxDelivered(envelope, intent.id);
        result.marked_delivered += 1;
        continue;
      }
      const scope: CouncilEventScope = {
        tenant_id: facts.tenant_id,
        company_id: facts.company_id,
        installation_id: facts.installation_id,
        session_id: facts.id,
        visibility: facts.visibility,
        owner_subject: facts.owner_subject,
      };
      const journal = deps.repositories.listEvents(envelope, facts.id, 0);
      const wire = toWireEvents(scope, journal).find(
        (event) => event.sequence === intent.event_sequence,
      );
      if (!wire) {
        deps.repositories.markOutboxFailed(envelope, intent.id, 'EVENT_RESOLUTION_FAILED');
        result.marked_failed += 1;
        continue;
      }
      result.deliveries += deps.subscriptions.publish(wire);
      result.published += 1;
      deps.repositories.markOutboxDelivered(envelope, intent.id);
      result.marked_delivered += 1;
    } catch {
      deps.repositories.markOutboxFailed(envelope, intent.id, 'EVENT_DRAIN_FAILED');
      result.marked_failed += 1;
    }
  }
  return result;
}
