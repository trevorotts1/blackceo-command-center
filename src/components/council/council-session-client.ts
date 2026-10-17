/**
 * council-session-client.ts (CWE-034, Skill 77 Council of Wise Elders)
 *
 * The browser client for the council screens: typed reads over the
 * CWE-029 safe-read routes and the CWE-030 events surface, and the
 * mutation calls for follow-up, outcomes, and exports whose
 * production services land at CWE-050 (follow-up, outcomes) and
 * CWE-038 (exports).
 *
 * Honesty rules enforced here:
 *   - Every response is read through the Section 17.3 envelope. An
 *     error envelope throws CouncilApiClientError carrying the
 *     server's own code (FEATURE_NOT_READY included), so screens
 *     render the typed state the server actually returned instead of
 *     simulating success.
 *   - Mutations send an Idempotency-Key header, per Section 17.1.
 *     CSRF proof is the host's signed mc_csrf_token cookie, which
 *     same-origin fetch carries automatically (CWE-007).
 *   - The event transport follows the CWE-030 stream contract:
 *     snapshot first, then the ordered stream; SSE frames are the
 *     journal event types plus council.snapshot,
 *     council.session.invalidated, and council.stream_error.
 */

import type {
  CouncilCatchUp,
  CouncilResyncSnapshot,
  CouncilWireEvent,
} from '@/lib/council/events/types';
import { EVENT_TYPES } from '@/lib/council/contracts';
import type {
  CouncilSessionSummaryView,
  CouncilVerdictReadData,
} from './council-session-types';

export class CouncilApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly action: string;

  constructor(code: string, message: string, status: number, action: string) {
    super(message);
    this.name = 'CouncilApiClientError';
    this.code = code;
    this.status = status;
    this.action = action;
  }

  get isFeatureNotReady(): boolean {
    return this.code === 'FEATURE_NOT_READY';
  }
}

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; action: string };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CouncilFollowUpRequest {
  seat_id: string;
  question: string;
}

export interface CouncilOutcomeRequest {
  /** What actually happened, recorded separately from the prediction. */
  observed_outcome: string;
  observed_at: string;
  /** The preserved prediction snapshot this outcome answers. */
  verdict_revision: number;
  verdict_content_sha256: string;
}

export interface CouncilExportRequest {
  session_id: string;
  format: 'markdown' | 'json' | 'pdf';
  /** Exports initiated from a replay carry the replay label (T101). */
  replay: boolean;
}

export class CouncilApiClient {
  private readonly basePath: string;
  private readonly fetchFn: FetchLike;

  constructor(options: { basePath?: string; fetchFn?: FetchLike } = {}) {
    this.basePath = options.basePath ?? '';
    this.fetchFn =
      options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetchFn(`${this.basePath}${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    let envelope: Envelope | null = null;
    try {
      envelope = (await response.json()) as Envelope;
    } catch {
      envelope = null;
    }
    if (!envelope || envelope.ok !== true) {
      const code = envelope?.error?.code ?? 'INTERNAL_ERROR';
      const message =
        envelope?.error?.message ??
        `The council request failed with status ${response.status}.`;
      throw new CouncilApiClientError(
        code,
        message,
        response.status,
        envelope?.error?.action ?? 'contact_support',
      );
    }
    return envelope.data as T;
  }

  listSessions(): Promise<{
    sessions: CouncilSessionSummaryView[];
    count: number;
    total_in_scope: number;
  }> {
    return this.request('/api/council/sessions');
  }

  getSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/council/sessions/${encodeURIComponent(sessionId)}`);
  }

  getVerdict(sessionId: string): Promise<CouncilVerdictReadData> {
    return this.request(
      `/api/council/sessions/${encodeURIComponent(sessionId)}/verdict`,
    );
  }

  getEventsSnapshot(sessionId: string): Promise<CouncilCatchUp> {
    return this.request(
      `/api/council/sessions/${encodeURIComponent(sessionId)}/events?snapshot=1`,
    );
  }

  getEventsPage(sessionId: string, after: number): Promise<CouncilCatchUp> {
    return this.request(
      `/api/council/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`,
    );
  }

  postFollowUp(
    sessionId: string,
    body: CouncilFollowUpRequest,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/council/sessions/${encodeURIComponent(sessionId)}/follow-up`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    );
  }

  postOutcome(
    sessionId: string,
    body: CouncilOutcomeRequest,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/council/sessions/${encodeURIComponent(sessionId)}/outcomes`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    );
  }

  createExport(body: CouncilExportRequest, idempotencyKey: string): Promise<Record<string, unknown>> {
    return this.request('/api/council/exports', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  }

  getCapabilities(): Promise<{
    principal?: {
      subject?: string;
      tenant_id?: string;
      company_id?: string;
    };
    [key: string]: unknown;
  }> {
    return this.request('/api/council/capabilities');
  }

  getAdvisors(): Promise<{
    seats: Array<{
      seat_id: string;
      display_name: string;
      lenses: string[];
      profile_label: string;
      provenance: string;
    }>;
  }> {
    return this.request('/api/council/advisors');
  }

  getSettings(): Promise<Record<string, unknown>> {
    return this.request('/api/council/settings');
  }
}

/* ── Event transport (snapshot, ordered pages, live stream) ─────────── */

export interface CouncilStreamHandlers {
  onEvent: (event: CouncilWireEvent) => void;
  onSnapshot: (snapshot: CouncilResyncSnapshot) => void;
  onInvalidation: () => void;
  onStreamError: (message: string) => void;
  onDisconnect: () => void;
}

export interface CouncilSessionTransport {
  snapshot(sessionId: string): Promise<CouncilCatchUp>;
  page(sessionId: string, after: number): Promise<CouncilCatchUp>;
  openStream(
    sessionId: string,
    after: number,
    handlers: CouncilStreamHandlers,
  ): { close: () => void };
}

const STREAM_EVENT_NAMES: readonly string[] = [
  ...EVENT_TYPES,
  'council.snapshot',
  'council.session.invalidated',
  'council.stream_error',
];

/**
 * The production transport over the real events contract. Tests
 * inject a fake transport with the same interface; this class is the
 * only place EventSource is touched.
 */
export class FetchCouncilSessionTransport implements CouncilSessionTransport {
  private readonly client: CouncilApiClient;
  private readonly basePath: string;

  constructor(client: CouncilApiClient, basePath = '') {
    this.client = client;
    this.basePath = basePath;
  }

  snapshot(sessionId: string): Promise<CouncilCatchUp> {
    return this.client.getEventsSnapshot(sessionId);
  }

  page(sessionId: string, after: number): Promise<CouncilCatchUp> {
    return this.client.getEventsPage(sessionId, after);
  }

  openStream(
    sessionId: string,
    after: number,
    handlers: CouncilStreamHandlers,
  ): { close: () => void } {
    if (typeof EventSource === 'undefined') {
      handlers.onStreamError(
        'This browser cannot open the live event stream. Reconnect to catch up from the committed record.',
      );
      return { close: () => undefined };
    }
    const url = `${this.basePath}/api/council/sessions/${encodeURIComponent(sessionId)}/events?stream=1&after=${after}`;
    const source = new EventSource(url, { withCredentials: true });
    const onFrame = (name: string) => (message: MessageEvent) => {
      try {
        const parsed: unknown = JSON.parse(message.data as string);
        if (name === 'council.snapshot') {
          handlers.onSnapshot(parsed as CouncilResyncSnapshot);
        } else if (name === 'council.session.invalidated') {
          handlers.onInvalidation();
        } else if (name === 'council.stream_error') {
          const text =
            (parsed as { message?: string }).message ??
            'The event stream reported an error.';
          handlers.onStreamError(text);
        } else {
          handlers.onEvent(parsed as CouncilWireEvent);
        }
      } catch {
        handlers.onStreamError('A malformed event frame was received and ignored.');
      }
    };
    const listeners = STREAM_EVENT_NAMES.map((name) => {
      const listener = onFrame(name);
      source.addEventListener(name, listener as EventListener);
      return { name, listener };
    });
    source.onerror = () => {
      handlers.onDisconnect();
    };
    return {
      close: () => {
        for (const { name, listener } of listeners) {
          source.removeEventListener(name, listener as EventListener);
        }
        source.close();
      },
    };
  }
}
