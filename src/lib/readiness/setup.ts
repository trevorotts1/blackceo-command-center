/**
 * Setup readiness (T-31).
 *
 * WHY THIS EXISTS. Every other surface in the Command Center answers "is it
 * running". None answered "is it SET UP", and the two are genuinely different:
 * a box can serve traffic, pass every probe, and still have no owner record, no
 * workspace, and an empty agent roster — because no boot step is required to
 * prove any of those exist. The operator then discovers it at the worst moment,
 * usually through a client.
 *
 * THE RULE THIS MODULE OBEYS. No item may report READY on the strength of a
 * configured value. A setting existing is not evidence that the thing it names
 * works. Every READY here is backed by a result the probe actually observed:
 * a row returned, a statement that ran, a socket that connected, a registry
 * lookup that resolved. When a probe cannot decide, the item is UNKNOWN — and
 * UNKNOWN never rolls up to READY.
 *
 * DEPENDENCIES ARE INJECTED. Every probe lives behind `SetupDeps` so a test can
 * drive each state (and each refusal) with no database, no network and no
 * environment. The defaults are the real thing.
 */

import net from 'node:net';
import type Database from 'better-sqlite3';

import { getDb } from '@/lib/db';
import { checkDispatchSchemaHealth, getMigrationStatus, runMigrations } from '@/lib/db/migrations';
import { installedCompanyIdentity } from '@/lib/db/branding-seed';
import { configuredPublicOrigin, tenantRegistration } from '@/lib/auth/tenant-context';
import { registrationAllowsOwnerLogin } from '@/lib/auth/owner-login';

import type {
  ActionResult,
  OwnerAction,
  OwnerActionId,
  ReadinessEvidence,
  ReadinessItem,
  ReadinessItemId,
  ReadinessState,
  SetupReadiness,
} from './types';

/** Bounded gateway reachability probe; never let a dead port hold the route. */
const GATEWAY_PROBE_TIMEOUT_MS = 1500;
const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';

export interface GatewayProbeResult {
  ok: boolean;
  detail: Record<string, unknown>;
}

export interface AgentSyncResult {
  inserted: number;
  updated: number;
  skipped: number;
  message: string;
}

/**
 * Every side effect this module can have, behind one interface.
 *
 * Defaults do the real work; tests replace them. Nothing here reads a config
 * value and calls the result readiness.
 */
export interface SetupDeps {
  openDb(): Database.Database;
  /** Authoritative company identity for this box, or null when unset. */
  companyId(): string | null;
  /** Host whose tenant registry entry is checked for owner login. */
  host(): string;
  probeGateway(): Promise<GatewayProbeResult>;
  applyMigrations(db: Database.Database): void;
  syncAgents(): Promise<AgentSyncResult>;
  /** Owner-login predicate for this host. Injected so a throw can be driven. */
  allowsOwnerLogin(host: string): boolean;
  now(): string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One observation record, always a record.
 *
 * A probe that returned nothing must not render as the literal text
 * "undefined" under a row: an absent observation is recorded as absent.
 */
function evidence(probe: string, observed: Record<string, unknown> | undefined, at: string): ReadinessEvidence {
  return {
    probe,
    observed: observed && typeof observed === 'object' ? observed : { emptyObservation: 'probe returned no observed values' },
    at,
  };
}

/** Bounded TCP connect. Reachability is proven by a completed handshake. */
export function tcpProbe(
  url: string,
  timeoutMs: number = GATEWAY_PROBE_TIMEOUT_MS,
): Promise<GatewayProbeResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve({
      ok: false,
      detail: { probe: 'tcp_connect', error: 'gateway_url_unparseable' },
    });
  }
  const host = target.hostname;
  const port = target.port
    ? Number(target.port)
    : target.protocol === 'wss:' || target.protocol === 'https:'
      ? 443
      : 80;
  const started = Date.now();

  return new Promise<GatewayProbeResult>((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (result: GatewayProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () =>
      finish({
        ok: false,
        detail: {
          probe: 'tcp_connect',
          host,
          port,
          latencyMs: Date.now() - started,
          error: 'timeout',
        },
      }),
    );
    socket.once('connect', () =>
      finish({
        ok: true,
        detail: { probe: 'tcp_connect', host, port, latencyMs: Date.now() - started },
      }),
    );
    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish({
        ok: false,
        detail: {
          probe: 'tcp_connect',
          host,
          port,
          latencyMs: Date.now() - started,
          error: err.code || 'connect_failed',
        },
      }),
    );
  });
}

const DEFAULT_DEPS: SetupDeps = {
  openDb: () => getDb(),
  companyId: () => installedCompanyIdentity(),
  host: () => configuredPublicOrigin()?.hostname ?? 'localhost',
  probeGateway: () => tcpProbe(process.env.OPENCLAW_GATEWAY_URL || DEFAULT_GATEWAY_URL),
  applyMigrations: (db) => runMigrations(db),
  allowsOwnerLogin: (host) => registrationAllowsOwnerLogin(host),
  syncAgents: async () => {
    // Loaded lazily: the sync pulls the gateway client, which no readiness read
    // should pay for.
    const { syncSpecialistAgentsFromOpenClaw } = await import('@/lib/openclaw/agent-sync');
    return syncSpecialistAgentsFromOpenClaw();
  },
  now: () => new Date().toISOString(),
};

/**
 * Overall roll-up.
 *
 * BLOCKED outranks UNKNOWN because a proven fault is more actionable than an
 * open question, but UNKNOWN outranks READY unconditionally: something
 * undecidable is never a pass.
 *
 * An EMPTY state set is UNKNOWN, never READY. Zero evidence rows is not a
 * clean bill of health — it is a surface that proved nothing, and vacuous
 * truth must never read as a pass.
 */
export function rollUp(states: ReadinessState[]): ReadinessState {
  if (states.length === 0) return 'UNKNOWN';
  if (states.includes('BLOCKED')) return 'BLOCKED';
  if (states.includes('UNKNOWN')) return 'UNKNOWN';
  return 'READY';
}

const DISABLED = {
  databaseUnavailable: 'database_unavailable',
  alreadyReady: 'already_ready',
  companyIdentityUnset: 'company_identity_unset',
  companyRecordNotReady: 'company_record_not_ready',
  gatewayUnreachable: 'gateway_unreachable',
} as const;

function disabledReasonFor(
  id: OwnerActionId,
  stateById: (id: ReadinessItemId) => ReadinessState,
  dbReady: boolean,
  companyId: string | null,
): string | null {
  switch (id) {
    case 'apply_pending_migrations':
      if (!dbReady) return DISABLED.databaseUnavailable;
      if (stateById('schema_migrations') !== 'BLOCKED') return DISABLED.alreadyReady;
      return null;
    case 'create_company_record':
      if (!dbReady) return DISABLED.databaseUnavailable;
      if (companyId === null) return DISABLED.companyIdentityUnset;
      if (stateById('company_record') !== 'BLOCKED') return DISABLED.alreadyReady;
      return null;
    case 'create_default_workspace':
      if (!dbReady) return DISABLED.databaseUnavailable;
      if (companyId === null) return DISABLED.companyIdentityUnset;
      // The workspaces row carries a foreign key to companies. Creating it
      // before the company record exists cannot succeed, so it is not offered.
      if (stateById('company_record') !== 'READY') return DISABLED.companyRecordNotReady;
      if (stateById('company_workspace') !== 'BLOCKED') return DISABLED.alreadyReady;
      return null;
    case 'sync_agent_roster':
      if (stateById('agent_roster') !== 'BLOCKED') return DISABLED.alreadyReady;
      if (stateById('openclaw_gateway') !== 'READY') return DISABLED.gatewayUnreachable;
      return null;
  }
}

const ACTION_SPECS: Array<Omit<OwnerAction, 'enabled' | 'disabledReason'>> = [
  {
    id: 'apply_pending_migrations',
    label: 'Apply pending migrations',
    description: 'Runs the migration runner against this box\'s database.',
    unblocks: ['schema_migrations', 'dispatch_schema'],
  },
  {
    id: 'create_company_record',
    label: 'Create the company record',
    description: 'Inserts the companies row named by this box\'s MC_COMPANY_ID.',
    unblocks: ['company_record'],
  },
  {
    id: 'create_default_workspace',
    label: 'Create the default workspace',
    description: 'Inserts one active workspace for this box\'s company.',
    unblocks: ['company_workspace'],
  },
  {
    id: 'sync_agent_roster',
    label: 'Sync the agent roster',
    description: 'Pulls the OpenClaw gateway agent roster into the agents table.',
    unblocks: ['agent_roster'],
  },
];

export interface SetupOptions {
  host?: string;
  deps?: Partial<SetupDeps>;
}

interface ProbeRun {
  db: Database.Database | null;
  dbError: string | null;
  dbLatencyMs: number | null;
  companyId: string | null;
  /** Why the identity could not be read at all — distinct from "unset". */
  companyIdError: string | null;
  host: string;
  at: string;
}

/** Build every item. Pure except for the injected probes. */
export async function computeSetupReadiness(options: SetupOptions = {}): Promise<SetupReadiness> {
  const deps: SetupDeps = { ...DEFAULT_DEPS, ...options.deps };
  const host = options.host ?? deps.host();

  // A clock that throws must not take the whole surface down with it — the
  // other seven rows are still worth reading. The failure is recorded and the
  // computation continues; a claim that cannot be timestamped degrades below.
  let at: string;
  let clockError: string | null = null;
  try {
    at = deps.now();
    if (typeof at !== 'string' || at.length === 0) {
      throw new Error('now() returned no timestamp');
    }
  } catch (err) {
    clockError = errorMessage(err);
    at = 'clock_unavailable';
  }

  let db: Database.Database | null = null;
  let dbError: string | null = null;
  const dbStarted = Date.now();
  try {
    db = deps.openDb();
    db.prepare('SELECT 1 AS ok').get();
  } catch (err) {
    db = null;
    dbError = errorMessage(err);
  }
  const dbLatencyMs = db ? Date.now() - dbStarted : null;

  let companyId: string | null = null;
  let companyIdError: string | null = null;
  try {
    companyId = deps.companyId();
  } catch (err) {
    companyId = null;
    companyIdError = errorMessage(err);
  }

  const run: ProbeRun = { db, dbError, dbLatencyMs, companyId, companyIdError, host, at };
  const items: ReadinessItem[] = [];

  // ── data ──────────────────────────────────────────────────────────────────
  items.push({
    id: 'database',
    label: 'Database reachable',
    group: 'data',
    state: db ? 'READY' : 'BLOCKED',
    ...(db ? {} : { reason: dbError ?? 'database_unavailable' }),
    evidence: evidence(
      'SELECT 1 AS ok',
      db
        ? { result: 1, latencyMs: dbLatencyMs }
        : { error: dbError ?? 'database_unavailable' },
      at,
    ),
  });

  items.push(probeMigrations(run));
  items.push(probeDispatchSchema(run));
  items.push(probeCompanyRecord(run));
  items.push(probeCompanyWorkspace(run));
  items.push(probeOwnerRegistration(run, deps));
  items.push(probeAgentRoster(run));
  items.push(await probeGateway(deps, at));

  // Evidence completeness. READY means "a probe observed this", so a READY row
  // whose observation is empty, or whose timestamp could not be taken, is not
  // proven — it degrades to UNKNOWN. A proven fault stays BLOCKED regardless of
  // the clock. Nothing here throws away the surface: one bad clock or one
  // vacuous answer costs that item its claim, never the other rows.
  const proven: ReadinessItem[] = items.map((item) => {
    const observed = item.evidence.observed ?? {};
    const empty = Object.keys(observed).length === 0;
    const downgraded = item.state === 'READY' && (clockError !== null || empty);
    return {
      ...item,
      ...(downgraded ? { state: 'UNKNOWN' as ReadinessState } : {}),
      evidence: {
        ...item.evidence,
        observed: {
          ...observed,
          ...(clockError !== null ? { clockError } : {}),
          ...(empty ? { emptyObservation: 'probe returned no observed values' } : {}),
        },
      },
    };
  });

  const stateById = (id: ReadinessItemId): ReadinessState =>
    proven.find((item) => item.id === id)?.state ?? 'UNKNOWN';

  const actions: OwnerAction[] = ACTION_SPECS.map((spec) => {
    const reason = disabledReasonFor(spec.id, stateById, db !== null, companyId);
    return reason === null
      ? { ...spec, enabled: true }
      : { ...spec, enabled: false, disabledReason: reason };
  });

  return {
    overall: rollUp(proven.map((item) => item.state)),
    items: proven,
    actions,
    computedAt: at,
  };
}

function unknownDb(run: ProbeRun, probe: string): ReadinessItem['evidence'] {
  return evidence(probe, { skipped: 'database_unavailable', error: run.dbError }, run.at);
}

function probeMigrations(run: ProbeRun): ReadinessItem {
  const base = { id: 'schema_migrations' as const, label: 'Schema at head', group: 'data' as const };
  if (!run.db) {
    return { ...base, state: 'UNKNOWN', evidence: unknownDb(run, 'getMigrationStatus') };
  }
  try {
    const status = getMigrationStatus(run.db);
    const pending = status.pending;
    return {
      ...base,
      state: pending.length === 0 ? 'READY' : 'BLOCKED',
      ...(pending.length === 0 ? {} : { reason: `${pending.length} pending migration(s)` }),
      evidence: evidence('getMigrationStatus', {
        applied: status.applied.length,
        pending,
        head: status.applied[status.applied.length - 1] ?? null,
      }, run.at),
    };
  } catch (err) {
    return {
      ...base,
      state: 'UNKNOWN',
      evidence: evidence('getMigrationStatus', { error: errorMessage(err) }, run.at),
    };
  }
}

function probeDispatchSchema(run: ProbeRun): ReadinessItem {
  const base = { id: 'dispatch_schema' as const, label: 'Dispatch schema sound', group: 'data' as const };
  if (!run.db) {
    return { ...base, state: 'UNKNOWN', evidence: unknownDb(run, 'checkDispatchSchemaHealth') };
  }
  try {
    const health = checkDispatchSchemaHealth(run.db);
    return {
      ...base,
      state: health.ok ? 'READY' : 'BLOCKED',
      ...(health.ok ? {} : { reason: 'dispatch schema does not match the migration ledger' }),
      evidence: evidence('checkDispatchSchemaHealth', { ...health }, run.at),
    };
  } catch (err) {
    return {
      ...base,
      state: 'UNKNOWN',
      evidence: evidence('checkDispatchSchemaHealth', { error: errorMessage(err) }, run.at),
    };
  }
}

function probeCompanyRecord(run: ProbeRun): ReadinessItem {
  const base = { id: 'company_record' as const, label: 'Company record exists', group: 'identity' as const };
  if (!run.db) {
    return { ...base, state: 'UNKNOWN', evidence: unknownDb(run, 'SELECT companies') };
  }
  if (run.companyId === null) {
    // No identity on this box: there is no row we could even look for. That is
    // undecidable, not broken — and certainly not ready. When the identity
    // lookup itself THREW, say that: an error is not an absent variable.
    return {
      ...base,
      state: 'UNKNOWN',
      evidence: evidence('SELECT companies WHERE id = ?', run.companyIdError !== null
        ? {
            companyId: null,
            detail: 'the company identity lookup threw, so no company row can be checked',
            error: run.companyIdError,
          }
        : {
            detail: 'MC_COMPANY_ID is unset, so no company row can be checked',
            companyId: null,
          }, run.at),
    };
  }
  try {
    const row = run.db
      .prepare('SELECT id, name, slug FROM companies WHERE id = ?')
      .get(run.companyId) as { id: string; name: string; slug: string } | undefined;
    return {
      ...base,
      state: row ? 'READY' : 'BLOCKED',
      ...(row ? {} : { reason: 'no companies row for this box\'s MC_COMPANY_ID' }),
      evidence: evidence('SELECT id, name, slug FROM companies WHERE id = ?', {
        companyId: run.companyId,
        row: row ?? null,
      }, run.at),
    };
  } catch (err) {
    return {
      ...base,
      state: 'UNKNOWN',
      evidence: evidence('SELECT companies', { error: errorMessage(err) }, run.at),
    };
  }
}

function probeCompanyWorkspace(run: ProbeRun): ReadinessItem {
  const base = { id: 'company_workspace' as const, label: 'Active workspace exists', group: 'identity' as const };
  if (!run.db) {
    return { ...base, state: 'UNKNOWN', evidence: unknownDb(run, 'SELECT workspaces') };
  }
  if (run.companyId === null) {
    return {
      ...base,
      state: 'UNKNOWN',
      evidence: evidence('SELECT workspaces WHERE company_id = ?', run.companyIdError !== null
        ? {
            companyId: null,
            detail: 'the company identity lookup threw, so workspaces cannot be scoped',
            error: run.companyIdError,
          }
        : {
            detail: 'MC_COMPANY_ID is unset, so workspaces cannot be scoped',
            companyId: null,
          }, run.at),
    };
  }
  try {
    const rows = run.db
      .prepare('SELECT id FROM workspaces WHERE company_id = ? AND archived_at IS NULL ORDER BY id')
      .all(run.companyId) as Array<{ id: string }>;
    return {
      ...base,
      state: rows.length > 0 ? 'READY' : 'BLOCKED',
      ...(rows.length > 0 ? {} : { reason: 'no active workspace for this company' }),
      evidence: evidence('SELECT workspaces WHERE company_id = ? AND archived_at IS NULL', {
        companyId: run.companyId,
        activeWorkspaces: rows.map((row) => row.id),
      }, run.at),
    };
  } catch (err) {
    return {
      ...base,
      state: 'UNKNOWN',
      evidence: evidence('SELECT workspaces', { error: errorMessage(err) }, run.at),
    };
  }
}

function probeOwnerRegistration(run: ProbeRun, deps: SetupDeps): ReadinessItem {
  const base = { id: 'owner_registration' as const, label: 'Owner login usable', group: 'identity' as const };
  let registration;
  try {
    registration = tenantRegistration(run.host);
  } catch (err) {
    return {
      ...base,
      state: 'BLOCKED',
      reason: 'no tenant registration for this host',
      evidence: evidence('tenantRegistration(host)', {
        host: run.host,
        error: errorMessage(err),
      }, run.at),
    };
  }
  // Registration alone is a registry record, not proof the redemption path has
  // anywhere to write. The nonce table is that proof.
  if (!run.db) {
    return {
      ...base,
      state: 'UNKNOWN',
      evidence: evidence('PRAGMA table_info(hq_owner_login_uses)', {
        host: run.host,
        registration,
        skipped: 'database_unavailable',
        error: run.dbError,
      }, run.at),
    };
  }
  let tablePresent = false;
  try {
    tablePresent = !!run.db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='hq_owner_login_uses'")
      .get();
  } catch (err) {
    return {
      ...base,
      state: 'UNKNOWN',
      evidence: evidence('PRAGMA table_info(hq_owner_login_uses)', {
        host: run.host,
        registration,
        error: errorMessage(err),
      }, run.at),
    };
  }
  // The predicate is the last thing that can decide this item, and a predicate
  // that throws decides nothing: UNKNOWN with the error recorded, never a
  // rejected surface and never a guessed verdict.
  let allowed: boolean;
  try {
    allowed = deps.allowsOwnerLogin(run.host);
  } catch (err) {
    return {
      ...base,
      state: 'UNKNOWN',
      evidence: evidence('tenantRegistration(host) + hq_owner_login_uses lookup', {
        host: run.host,
        registration,
        ownerLoginNonceTable: tablePresent,
        error: errorMessage(err),
      }, run.at),
    };
  }
  const state: ReadinessState = allowed && tablePresent ? 'READY' : 'BLOCKED';
  const reason = !allowed
    ? 'tenant registration does not permit owner login'
    : 'owner login nonce table missing';
  return {
    ...base,
    state,
    ...(state === 'READY' ? {} : { reason }),
    evidence: evidence('tenantRegistration(host) + hq_owner_login_uses lookup', {
      host: run.host,
      registration,
      allowsOwnerLogin: allowed,
      ownerLoginNonceTable: tablePresent,
    }, run.at),
  };
}

function probeAgentRoster(run: ProbeRun): ReadinessItem {
  const base = { id: 'agent_roster' as const, label: 'Agent roster populated', group: 'runtime' as const };
  if (!run.db) {
    return { ...base, state: 'UNKNOWN', evidence: unknownDb(run, 'SELECT COUNT(*) FROM agents') };
  }
  try {
    const row = run.db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number } | undefined;
    const count = row?.n ?? 0;
    return {
      ...base,
      state: count > 0 ? 'READY' : 'BLOCKED',
      ...(count > 0 ? {} : { reason: 'the agents table has no rows' }),
      evidence: evidence('SELECT COUNT(*) FROM agents', { agents: count }, run.at),
    };
  } catch (err) {
    return {
      ...base,
      state: 'UNKNOWN',
      evidence: evidence('SELECT COUNT(*) FROM agents', { error: errorMessage(err) }, run.at),
    };
  }
}

async function probeGateway(deps: SetupDeps, at: string): Promise<ReadinessItem> {
  const base = { id: 'openclaw_gateway' as const, label: 'OpenClaw gateway reachable', group: 'runtime' as const };
  try {
    const result = await deps.probeGateway();
    return {
      ...base,
      state: result.ok ? 'READY' : 'BLOCKED',
      ...(result.ok ? {} : { reason: 'gateway did not accept a connection' }),
      evidence: evidence('tcp_connect(OPENCLAW_GATEWAY_URL)', result.detail, at),
    };
  } catch (err) {
    return {
      ...base,
      state: 'UNKNOWN',
      evidence: evidence('tcp_connect(OPENCLAW_GATEWAY_URL)', { error: errorMessage(err) }, at),
    };
  }
}

/**
 * Run one owner action.
 *
 * REFUSES rather than half-doing: an action that is disabled for any reason —
 * including a reason discovered a moment ago — returns `applied: false` with
 * that reason. Nothing is attempted and nothing fails silently.
 */
export async function runSetupAction(
  actionId: OwnerActionId,
  options: SetupOptions = {},
): Promise<ActionResult> {
  const deps: SetupDeps = { ...DEFAULT_DEPS, ...options.deps };
  const readiness = await computeSetupReadiness(options);
  const action = readiness.actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    return { action: actionId, applied: false, detail: 'unknown action' };
  }
  if (!action.enabled) {
    return { action: actionId, applied: false, detail: action.disabledReason ?? 'disabled' };
  }

  const itemState = (id: ReadinessItemId) =>
    readiness.items.find((item) => item.id === id)?.state ?? 'UNKNOWN';

  try {
    switch (actionId) {
      case 'apply_pending_migrations': {
        const db = deps.openDb();
        deps.applyMigrations(db);
        const status = getMigrationStatus(db);
        return {
          action: actionId,
          applied: status.pending.length === 0,
          detail:
            status.pending.length === 0
              ? 'all migrations applied'
              : `${status.pending.length} migration(s) still pending: ${status.pending.join(', ')}`,
        };
      }
      case 'create_company_record': {
        const companyId = deps.companyId();
        if (!companyId) {
          return { action: actionId, applied: false, detail: DISABLED.companyIdentityUnset };
        }
        const db = deps.openDb();
        db.prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)')
          .run(companyId, companyId, companyId);
        return { action: actionId, applied: true, detail: `created companies row ${companyId}` };
      }
      case 'create_default_workspace': {
        const companyId = deps.companyId();
        if (!companyId) {
          return { action: actionId, applied: false, detail: DISABLED.companyIdentityUnset };
        }
        if (itemState('company_record') !== 'READY') {
          return { action: actionId, applied: false, detail: 'company_record_not_ready' };
        }
        const db = deps.openDb();
        db.prepare(
          'INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          `${companyId}-general`,
          'General',
          `${companyId}-general`,
          'Default workspace created by setup readiness',
          '📁',
          companyId,
          1000,
        );
        return { action: actionId, applied: true, detail: `created workspace ${companyId}-general` };
      }
      case 'sync_agent_roster': {
        const result = await deps.syncAgents();
        return {
          action: actionId,
          applied: result.inserted + result.updated > 0,
          detail: `inserted ${result.inserted}, updated ${result.updated}, skipped ${result.skipped}`,
        };
      }
    }
  } catch (err) {
    // A handler that throws is a refusal with a reason, never a silent no-op.
    return { action: actionId, applied: false, detail: errorMessage(err) };
  }
}
