/**
 * F23 discriminating probes — one per spec item.
 *
 * Run on the PARENT commit and on the F23 head, paste both:
 *
 *   CC_PYTHON= npx tsx tests/probes/f23-probes.ts
 *
 * Each probe prints exactly one line: `F23.NN PASS|FAIL <detail>`. A probe that
 * cannot import a module that only exists on the F23 head is a FAIL by design:
 * the behaviour it measures does not exist on the parent.
 *
 * Uses its own throwaway SQLite database; never touches mission-control.db.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

const dbPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bld006-f23-probe-')),
  'probe.db',
);
process.env.DATABASE_PATH = dbPath;
process.env.DISABLE_QC_AUTO_SCORER = '1';

type Probe = { id: string; run: () => Promise<string> };
const results: Array<{ id: string; ok: boolean; detail: string }> = [];

const HASH_A = createHash('sha256').update('probe-a').digest('hex');
const HASH_B = createHash('sha256').update('probe-b').digest('hex');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function domain(): Promise<any> {
  return import('../../src/lib/launch-domain');
}

const probes: Probe[] = [
  {
    id: 'F23.01',
    run: async () => {
      const d = await domain();
      const governed = d.isGovernedLaunchCard({ id: 't', source: 'signature-funnel', department: 'launch' });
      const plain = d.isGovernedLaunchCard({ id: 'u', source: 'funnel', department: 'marketing' });
      if (!governed || plain) throw new Error(`governed=${governed} plain=${plain}`);
      return 'governed launch cards are registered; unrelated cards are not';
    },
  },
  {
    id: 'F23.02',
    run: async () => {
      const d = await domain();
      const identity = {
        runId: 'run-identity-probe',
        tenantId: 'tenant-a',
        workspaceId: 'launch',
        installationId: 'install-a',
        skill: 49,
        launchId: 'probe-launch-2026-11',
        planRevision: 1,
        planHash: `sha256:${'a'.repeat(64)}`,
      };
      if (d.bindLaunchRunIdentity(identity).status !== 'bound') throw new Error('first bind failed');
      const mismatch = d.bindLaunchRunIdentity({ ...identity, tenantId: 'tenant-b' });
      if (mismatch.status !== 'rejected') throw new Error(`mismatch status ${mismatch.status}`);
      if (d.bindLaunchRunIdentity(identity).status !== 'unchanged') throw new Error('stored identity was overwritten');
      return 'mismatch rejected; stored identity unchanged';
    },
  },
  {
    id: 'F23.03',
    run: async () => {
      const d = await domain();
      const overall = d.projectReportOverall({
        units: [
          { id: 'page', kind: 'page', required: true, state: 'complete' },
          { id: 'email', kind: 'email', required: true, state: 'pending' },
        ],
        reportedOverall: 'complete',
      });
      const close = d.verifyStageClose({
        receiptStatus: 'pass',
        artifactHashes: { page: HASH_B },
        verifiedArtifactHashes: [HASH_A],
        closedAt: '2026-11-01T00:00:00.000Z',
      });
      if (overall !== 'incomplete') throw new Error(`overall=${overall}`);
      if (close.ok) throw new Error('unverified artifact accepted');
      return 'producer overall superseded; unverified artifact refused';
    },
  },
  {
    id: 'F23.04',
    run: async () => {
      const d = await domain();
      const projection = d.projectCanonicalProgress([
        { id: 'a', kind: 'page', required: true, state: 'complete' },
        { id: 'b', kind: 'page', required: true, state: 'dropped' },
      ], 10);
      if (projection.complete) throw new Error('dropped counted as delivered');
      if (projection.percentage !== 50) throw new Error(`percentage=${projection.percentage}`);
      if (projection.stagePercentageLabel !== 'stage progress (stages, not units)') {
        throw new Error(`stage label=${projection.stagePercentageLabel}`);
      }
      return 'dropped not delivered; stage percentage labelled separately';
    },
  },
  {
    id: 'F23.05',
    run: async () => {
      const d = await domain();
      const events = d.deriveInvalidationEvents({
        launchId: 'probe-launch-2026-11',
        previousUnits: [{ id: 'p', kind: 'page', required: true, state: 'complete', artifactHash: HASH_A }],
        currentUnits: [{ id: 'p', kind: 'page', required: true, state: 'complete', artifactHash: HASH_B }],
        approvalsBefore: [{ approvalId: 'ap', revoked: false }],
        approvalsAfter: [{ approvalId: 'ap', revoked: true }],
        artifactsBefore: [HASH_A, HASH_B],
        artifactsAfter: [HASH_B],
      });
      if (events.length !== 3) throw new Error(`events=${events.length}`);
      return 'evidence changed + approval revoked + artifact superseded all minted';
    },
  },
  {
    id: 'F23.06',
    run: async () => {
      const d = await domain();
      const verdict = d.launchAdmissionForTransition(
        { id: 'probe-unbound-card', source: 'signature-funnel', department: 'launch', status: 'in_progress' },
        'review',
      );
      if (verdict.allow || verdict.code !== 'LAUNCH_BINDING_MISSING') {
        throw new Error(`allow=${verdict.allow} code=${verdict.code}`);
      }
      return 'governed card without launch evidence refused';
    },
  },
  {
    id: 'F23.07',
    run: async () => {
      const d = await domain();
      const wireframe = d.evaluateCardCompletion({
        level: 'wireframe',
        presentEvidence: ['wireframe'],
        approvedScope: false,
        canonicalInventoryComplete: false,
      });
      const page = d.evaluateCardCompletion({
        level: 'page',
        presentEvidence: ['wireframe'],
        approvedScope: false,
        canonicalInventoryComplete: false,
      });
      if (!wireframe.ok || page.ok) throw new Error(`wireframe=${wireframe.ok} page=${page.ok}`);
      if (d.subtaskCompletionClosesParent().closes) throw new Error('subtask closes parent');
      return 'wireframe completes at its level; page and parent do not';
    },
  },
  {
    id: 'F23.08',
    run: async () => {
      const d = await domain();
      const state = d.practicalLaunchState({ openGates: ['brand'] }).state;
      if (state !== 'awaiting_brand') throw new Error(`state=${state}`);
      return 'practical states map through the board workflow';
    },
  },
  {
    id: 'F23.09',
    run: async () => {
      const d = await domain();
      const local = d.classifyEvidenceLink({ href: '/tmp/deck.pdf' }).kind;
      const preview = d.classifyEvidenceLink({ href: 'https://example.com/p' }).kind;
      const live = d.classifyEvidenceLink({ href: 'https://example.com/l', verifiedLive: true }).kind;
      const refused = d.classifyEvidenceLink({
        href: 'https://example.com/l',
        verifiedLive: true,
        viewerTenantId: 'b',
        ownerTenantId: 'a',
      }).kind;
      if (local !== 'local' || preview !== 'preview' || live !== 'live' || refused !== 'refused') {
        throw new Error(`${local}/${preview}/${live}/${refused}`);
      }
      return 'local, preview, live and cross-tenant refusal are distinct';
    },
  },
  {
    id: 'F23.10',
    run: async () => {
      const outbox = await import('../../src/lib/launch-outbox');
      outbox.enqueueLaunchEvent({
        eventId: 'probe-event-1',
        runId: 'probe-run',
        skill: 83,
        launchId: 'probe-launch-2026-11',
        planVersion: 1,
        payload: { n: 1 },
      });
      const state = outbox.outboxSyncState();
      if (!state.available || state.sent !== 0 || state.queued !== 1) {
        throw new Error(`available=${state.available} sent=${state.sent} queued=${state.queued}`);
      }
      if (state.remote_acceptance_claimed !== false) throw new Error('claimed remote acceptance');
      return 'queued work is not sent and no remote acceptance is claimed';
    },
  },
  {
    id: 'F23.11',
    run: async () => {
      const d = await domain();
      const ambiguous = d.reconcileLegacyRun({ runId: 'legacy-probe', launchId: null, planHash: null });
      if (ambiguous.status !== 'unverified') throw new Error(`status=${ambiguous.status}`);
      if (ambiguous.fabricatedReceipt !== false) throw new Error('fabricated receipt');
      return 'ambiguous legacy run stays unverified; no receipt fabricated';
    },
  },
  {
    id: 'F23.12',
    run: async () => {
      // These two modules exist on the PARENT too — this probe is a pure
      // behavioural discriminator for the check/checks defect.
      const abilities = await import('../../src/lib/launch-abilities');
      const events = await import('../../src/lib/launch-run-events');
      const ability83 = abilities.getLaunchAbility(83)!;
      const both = abilities.isLaunchStage(ability83, 'check') && abilities.isLaunchStage(ability83, 'checks');
      const result = events.validateLaunchRunEvent({
        skill: 83,
        launch_id: 'probe-launch-2026-11',
        event_id: '11111111-1111-4111-8111-111111111111',
        run_id: '22222222-2222-4222-8222-222222222222',
        event_type: 'stage_closed',
        schema_version: '1.0',
        emitted_at: '2026-11-01T00:00:00.000Z',
        stage: 'check',
        receipt_status: 'pass',
        closed_at: '2026-11-01T00:00:00.000Z',
      });
      if (!both) throw new Error('check/checks do not both resolve');
      if (!result.ok || result.event.stage !== 'checks') {
        throw new Error(`validator ok=${result.ok}`);
      }
      return '`check` and `checks` both resolve; producer alias canonicalised';
    },
  },
  {
    id: 'F23.13',
    run: async () => {
      // No F23 module import: this probe measures transition() itself, so the
      // SAME code runs on parent and head. Parent allows review without launch
      // evidence (the defect); head refuses it.
      const { getDb } = await import('../../src/lib/db');
      const { transition } = await import('../../src/lib/task-lifecycle');
      const db = getDb();
      if (!db.prepare('SELECT id FROM companies WHERE id = ?').get('default')) {
        db.prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)').run('default', 'Default', 'default');
      }
      if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get('launch')) {
        db.prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?,?,?,?,?)')
          .run('launch', 'Launch', 'launch', 'Rocket', 20);
      }
      const agentId = '00000000-0000-4000-8000-0000000f2313';
      db.prepare('INSERT OR IGNORE INTO agents (id, name, role, status, workspace_id) VALUES (?,?,?,?,?)')
        .run(agentId, 'F23 Probe', 'builder', 'working', 'launch');
      const taskId = `f23-probe-order-${Date.now()}`;
      db.prepare(
        `INSERT INTO tasks (id, title, status, priority, assigned_agent_id, workspace_id, department, source)
         VALUES (?, ?, 'in_progress', 'high', ?, 'launch', 'launch', 'signature-funnel')`,
      ).run(taskId, 'F23 ordering probe', agentId);
      db.prepare(
        `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path)
         VALUES (?, ?, 'url', 'Decision link', 'https://example.com/f23-probe')`,
      ).run(`f23-probe-deliv-${Date.now()}`, taskId);
      let refusalCode = '';
      try {
        await transition(taskId, 'review', { actor: agentId, operatorOverride: true });
      } catch (error) {
        refusalCode = (error as { code?: string }).code ?? 'unknown';
      }
      if (refusalCode !== 'PRECONDITION_LAUNCH_EVIDENCE') {
        throw new Error(
          refusalCode
            ? `wrong refusal ${refusalCode}`
            : 'REVIEW ALLOWED with operatorOverride and no launch evidence',
        );
      }
      return 'operatorOverride cannot waive launch admission (review refused before the bail-out)';
    },
  },
  {
    id: 'F23.14',
    run: async () => {
      const outbox = await import('../../src/lib/launch-outbox');
      outbox.enqueueLaunchEvent({
        eventId: 'probe-event-2',
        runId: 'probe-run',
        skill: 83,
        launchId: 'probe-launch-2026-11',
        planVersion: 2,
        payload: { n: 2 },
      });
      const first = outbox.claimDueEvents({ now: Date.now() });
      const second = outbox.claimDueEvents({ now: Date.now() });
      const claimedProbe = first.filter((row: { event_id: string }) => row.event_id === 'probe-event-2');
      if (claimedProbe.length !== 1 || second.length !== 0) {
        throw new Error(`claimed=${claimedProbe.length} second=${second.length}`);
      }
      outbox.retryEvent(claimedProbe[0].event_id, claimedProbe[0].claim_token!, 'unreachable', {
        now: Date.now(),
        maxAttempts: 1,
      });
      const state = outbox.outboxSyncState();
      if (state.dead_lettered !== 1 || state.sent !== 0) {
        throw new Error(`dead=${state.dead_lettered} sent=${state.sent}`);
      }
      return 'atomic claim; exhausted event is dead-lettered, never sent';
    },
  },
];

async function main(): Promise<void> {
  for (const probe of probes) {
    try {
      const detail = await probe.run();
      results.push({ id: probe.id, ok: true, detail });
      console.log(`${probe.id} PASS ${detail}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ id: probe.id, ok: false, detail });
      console.log(`${probe.id} FAIL ${detail}`);
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nF23 probes: ${results.length - failed}/${results.length} PASS`);
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

void main();
