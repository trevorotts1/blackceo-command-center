/**
 * council-gauntlet-eventui.test.tsx — CWE-044 gauntlet: committed
 * event to visible UI (T154, Section 32.6 budget: p95 <= 1 s over
 * 200 samples).
 *
 * The loop under measurement is the real one: a card is committed
 * through the real repositories into the real journal; the event is
 * read back through the real CouncilEventDelivery; it is pushed
 * into the mounted CouncilLiveSession through its transport seam;
 * the client reducer folds it; the DOM updates. The ONLY replaced
 * hop is HTTP/SSE transport: the in-process transport calls the
 * delivery service directly instead of crossing a socket, which is
 * disclosed here and in the build report. Everything the user sees
 * (reducer, projection, room, activity line) is production code.
 *
 * Per sample: a fresh session is created and mounted; once the room
 * shows "0 of N perspectives committed", the clock starts, the
 * card commits, its wire event is delivered, and the clock stops
 * when the activity line shows "1 of N". 200 samples; p95 asserted
 * against 1,000 ms. Machine-relative (loaded 2-CPU VM, 2026-10-14).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CouncilLiveSession } from '../../src/components/council/CouncilLiveSession';
import type {
  CouncilSessionTransport,
  CouncilStreamHandlers,
} from '../../src/components/council/council-session-client';
import type { CouncilCatchUp } from '../../src/lib/council/events/types';

process.env.DATABASE_PATH = join(
  mkdtempSync(join(tmpdir(), 'cwe044-eventui-')),
  'eventui.db',
);

const SAMPLES = 200;
const BUDGET_MS = 1000;
const now = '2026-10-14T12:00:00.000Z';

type StoreModule = typeof import('../../src/lib/council/store');
type EventsModule = typeof import('../../src/lib/council/events');
type ContractsModule = typeof import('../../src/lib/council/contracts');

let storeModule: StoreModule;
let eventsModule: EventsModule;
let contractsModule: ContractsModule;
let repositories: InstanceType<StoreModule['CouncilRepositories']>;
let delivery: InstanceType<EventsModule['CouncilEventDelivery']>;
let fixtures: typeof import('../../src/lib/council/contracts/fixtures/examples');
let closeDb: () => void;

let idCounter = 0;
const newId = () => `cc044ui-${(idCounter += 1).toString().padStart(4, '0')}`;

const SCOPE = {
  tenant_id: 'tenant-ui',
  company_id: 'company-ui',
  installation_id: 'inst-ui',
  owner_subject: null as string | null,
};

interface SessionRig {
  stored: import('../../src/lib/council/store').CouncilStoredSession;
  access: import('../../src/lib/council/events/delivery').CouncilEventAccess;
  handlers: CouncilStreamHandlers | null;
}

const rigs = new Map<string, SessionRig>();

class DirectTransport implements CouncilSessionTransport {
  async snapshot(sessionId: string): Promise<CouncilCatchUp> {
    const rig = rigs.get(sessionId);
    if (!rig) throw new Error(`no rig for ${sessionId}`);
    return delivery.catchUp(rig.access, 0);
  }
  async page(sessionId: string, after: number): Promise<CouncilCatchUp> {
    const rig = rigs.get(sessionId);
    if (!rig) throw new Error(`no rig for ${sessionId}`);
    return delivery.catchUp(rig.access, after);
  }
  openStream(
    sessionId: string,
    _after: number,
    handlers: CouncilStreamHandlers,
  ): { close: () => void } {
    const rig = rigs.get(sessionId);
    if (rig) rig.handlers = handlers;
    return { close: () => undefined };
  }
}

const transport = new DirectTransport();

function makeStored(sessionId: string) {
  const spec = JSON.parse(JSON.stringify(fixtures.validSessionSpec));
  const brief = JSON.parse(JSON.stringify(fixtures.validBrief));
  spec.session_id = sessionId;
  brief.session_id = sessionId;
  spec.visibility = 'company';
  spec.brief_sha256 = contractsModule.canonicalHash(brief);
  const state = {
    schema_version: 'wise-elders.session-state/v1',
    session_id: sessionId,
    mode: spec.mode,
    state: 'DRAFT',
    state_version: 0,
    brief_revision: brief.revision,
    resume_phase: null,
    cancel_generation: 0,
    revocation_generation: 0,
    attempt: 1,
    lease_epoch: 0,
    archived: false,
    updated_at: spec.created_at,
  };
  return { spec, brief, scope: { ...SCOPE }, state, sample: false } as never;
}

function advisorCard(session: { brief: never; spec: never; scope: never }, operationId: string) {
  const brief = session.brief as {
    revision: number;
    options: Array<{ id: string }>;
  };
  return {
    schema_version: 'wise-elders.card/v1',
    session_id: (session.spec as { session_id: string }).session_id,
    brief_revision: brief.revision,
    seat_id: 'simon-sinek',
    input_manifest_sha256: contractsModule.canonicalHash({ manifest: operationId }),
    pack_version: 'pack-fixture-1.0.0',
    card_kind: 'advisor',
    round: 1,
    stance: 'support',
    preferred_option_id: 'B',
    option_scores: brief.options.map((o) => ({
      option_id: o.id,
      score: o.id === 'B' ? 8 : 5,
      rationale: 'Fixture rationale.',
      evidence_ids: ['ev-1'],
    })),
    framework_applications: [],
    decisive_arguments: ['The pilot is the bounded next step.'],
    strongest_objection: 'Retention is unmeasured.',
    conditions: [],
    critical_unknowns: [],
    change_my_mind: 'Evidence the pilot cannot be staffed.',
    challenges_answered: [],
    quotes: [],
    evidence_strength: 'medium',
    minority_position: null,
    host: {
      scope: { ...(session.scope as object) },
      operation_id: operationId,
      route_id: 'route-fixture-1',
      session_id: (session.spec as { session_id: string }).session_id,
      stamped_at: now,
      source_status: 'unverified',
    },
  } as never;
}

const medallions: Record<string, string> = Object.fromEntries(
  [
    'simon-sinek',
    'td-jakes',
    'oprah-winfrey',
    'tiffany-aliche',
    'russell-brunson',
    'michelle-obama',
    'brene-brown',
    'dennis-kimbro',
    'les-brown',
  ].map((seat) => [seat, '']),
);

beforeAll(async () => {
  storeModule = await import('../../src/lib/council/store');
  eventsModule = await import('../../src/lib/council/events');
  contractsModule = await import('../../src/lib/council/contracts');
  const adapterModule = await import('../../src/lib/council/persistence/council-store');
  const dbModule = await import('../../src/lib/db');
  fixtures = await import('../../src/lib/council/contracts/fixtures/examples');
  closeDb = dbModule.closeDb;
  const adapter = adapterModule.openCouncilStore();
  repositories = new storeModule.CouncilRepositories({
    adapter,
    diagnosticsDir: mkdtempSync(join(tmpdir(), 'cwe044-ui-diag-')),
    now: () => now,
    newId,
  });
  delivery = new eventsModule.CouncilEventDelivery({ repositories, store: adapter });
});

afterAll(() => {
  closeDb();
});

describe('committed event to visible UI (T154)', () => {
  it(`p95 <= ${BUDGET_MS}ms over ${SAMPLES} commit-to-DOM samples`, async () => {
    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const sessionId = `sess-ui-${String(i).padStart(3, '0')}`;
      const stored = makeStored(sessionId);
      const write = storeModule.envelopeFromScope(SCOPE, 'owner-1', 'owner', 'write');
      repositories.createSession(write, stored as never);
      const access = {
        envelope: storeModule.envelopeFromScope(SCOPE, 'owner-1', 'owner', 'read'),
        accessVia: 'owner',
        session: {
          id: sessionId,
          tenant_id: SCOPE.tenant_id,
          company_id: SCOPE.company_id,
          installation_id: SCOPE.installation_id,
          owner_subject: null,
          visibility: 'company',
          state: 'DRAFT',
          state_version: 0,
        },
      } as never;
      rigs.set(sessionId, { stored: stored as never, access, handlers: null });

      const view = render(
        <CouncilLiveSession
          sessionId={sessionId}
          transport={transport}
          decisionTitle="Should we pilot the revised offer before a broad launch?"
          medallionSrcBySeat={medallions}
        />,
      );
      const activity = await screen.findByTestId('council-live-activity');
      await waitFor(() => {
        expect(activity.textContent ?? '').toMatch(/^0 of \d+ perspectives committed/);
      });
      const totalSeats = Number(
        /of (\d+) perspectives/.exec(activity.textContent ?? '')?.[1] ?? '9',
      );
      const rig = rigs.get(sessionId);
      if (!rig?.handlers) throw new Error('stream handlers never registered');

      const started = performance.now();
      const outcome = repositories.acceptCard(
        write,
        advisorCard(stored as never, `op-${sessionId}`),
        { expected_state_version: 0, cancel_generation: 0, lease_epoch: 0 },
      );
      expect(outcome.outcome).toBe('committed');
      const page = delivery.page(access, 1);
      if (page.kind !== 'events') throw new Error('expected an events page');
      const wire = page.events[page.events.length - 1];
      rig.handlers.onEvent(wire);
      await waitFor(() => {
        expect(activity.textContent ?? '').toContain(
          `1 of ${totalSeats} perspectives committed`,
        );
      });
      samples.push(performance.now() - started);
      view.unmount();
      rigs.delete(sessionId);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
    const p50 = sorted[Math.floor(sorted.length / 2)];
    // Evidence line for the build report (also asserted below).
    console.log(
      `event-to-UI: n=${samples.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${sorted[sorted.length - 1].toFixed(1)}ms budget=${BUDGET_MS}ms`,
    );
    expect(p95).toBeLessThanOrEqual(BUDGET_MS);
  });
});
