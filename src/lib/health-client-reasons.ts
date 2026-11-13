/**
 * Client-facing health wording (U-06 / CC-004, CC-020, CC-022, CC-032, CC-036).
 *
 * The single source of the plain-English copy a client sees on the health
 * badge and in its panel. Nothing here may carry a probe id, component name,
 * file path, address or raw error string: the badge is the one health
 * surface a client gets, and "openclaw_gateway: unauthorized_401" is not an
 * answer to "is my Command Center working for me?".
 */
import { countsTowardOverall } from './probes/types';
import type { HealthTier, StatusPayload } from './health-readiness';

export interface ClientReason {
  title: string;
  body: string;
}

const CLIENT_LABEL: Record<HealthTier, string> = {
  healthy: 'All systems working',
  degraded: 'Needs attention',
  unavailable: 'Offline',
  checking: 'Checking…',
  unknown: 'Status not available',
};

/** Badge text for a client. The operator variant keeps the internal wording. */
export function clientLabel(tier: HealthTier): string {
  return CLIENT_LABEL[tier];
}

/** The rows a client can be told about, in the order they are shown. */
const ROW_COPY: Record<string, ClientReason> = {
  database: {
    title: "Your Command Center's records are not responding",
    body: 'Nothing has been lost. Try again in a few minutes.',
  },
  openclaw_gateway: {
    title: "Your AI team can't be reached right now",
    body: 'New tasks will wait safely and start on their own once the connection is back.',
  },
  jobs: {
    title: 'Some tasks have not moved for a while',
    body: 'Open the board and look at the "In Progress" column. A task may be waiting on an answer from you.',
  },
  agents: {
    title: 'One of your AI team members reported a problem',
    body: 'Tasks for that team member may be slower than usual.',
  },
  disk: {
    title: 'This computer is almost out of storage',
    body: 'Work may pause until space is freed.',
  },
};

const ROW_ORDER = ['database', 'openclaw_gateway', 'jobs', 'agents', 'disk'];

/** A row that is live/working/busy is running; anything else is worth a line. */
const RUNNING: ReadonlySet<string> = new Set(['live', 'working', 'busy']);

const UPDATE_FINISHING: ClientReason = {
  title: 'An update is finishing',
  body: 'This usually clears within a few minutes.',
};

const DEGRADED_NO_DETAIL: ClientReason = {
  title: "We're double-checking a few things",
  body: 'Everything you need is working. If this is still showing in an hour, let your support contact know.',
};

/**
 * Plain-English reasons for a non-healthy badge, from counted probe rows plus
 * the `/api/health` status string. Advisory rows (`countsTowardOverall`
 * false) never produce a reason — they do not move the badge either.
 */
export function clientReasons(
  payload: StatusPayload | null,
  healthStatus: string | null
): ClientReason[] {
  const reasons: ClientReason[] = [];
  const components = payload?.components ?? [];

  for (const id of ROW_ORDER) {
    const row = components.find((c) => c.component === id);
    if (!row || !countsTowardOverall(row) || RUNNING.has(row.status)) continue;
    reasons.push(ROW_COPY[id]);
  }

  if (healthStatus === 'degraded') reasons.push(UPDATE_FINISHING);
  if (reasons.length === 0 && payload?.overall === 'degraded') return [DEGRADED_NO_DETAIL];

  return reasons;
}
