/**
 * Workforce build kick (AI Workforce Interview BU-30, closes WF-021).
 *
 * The one mechanism in either repository that is known to START an agent turn
 * is the OpenClaw gateway client (see src/app/api/interview/turn/route.ts). A
 * shell script cannot. So `start-workforce-build.py` leaves a WANTED file
 * behind, and this module turns that intent into the turn.
 *
 * DOCTRINE (do not violate):
 *   • FILES ARE THE SOURCE OF TRUTH. Eligibility is read from the canonical
 *     build-state through the P0-1 seam readers. This module NEVER writes
 *     build-state, NEVER writes interviewComplete and NEVER records a decision;
 *     its only write is its own kick ledger,
 *     <workspace>/.workforce-build-kick.json.
 *   • SILENT. Exactly ONE message per kick, and never one to the owner — the
 *     message itself says "Do not message the owner".
 *   • BOUNDED. At most one kick per 20 minutes and at most 12 per build, then
 *     `gaveUp: true` and it stops. A gateway that refuses records `lastError`
 *     and is retried on the next run instead of throwing at the scheduler.
 *   • SWITCHED OFF for a client tenant on a shared host: that, and nothing
 *     else, is the one case that returns `skippedReason` (the Command Center
 *     package's unit U-16 / finding CC-058 reserves `skippedReason` for
 *     "switched off"; "nothing to do this run" is `{ kicked: false, reason }`).
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getOpenClawClient, type OpenClawClient } from '@/lib/openclaw/client';
import { tenantRegistryIdentities } from '@/lib/auth/tenant-context';
import { resolveWorkspaceDir } from '@/lib/interview/paths';
import { readBuildState, readInterviewQcStatus } from '@/lib/interview/seam';

/** The one message a kick sends, character for character (BU-30 spec). */
const KICK_MESSAGE =
  '[WORKFORCE-RESUME] The interview is complete and build-eligible. Read ~/.openclaw/skills/23-ai-workforce-blueprint/resume-prompt.txt (or the /data path) and follow it now. Do not message the owner.';

const WANTED_FILE = '.workforce-build-wanted.json';
const KICK_FILE = '.workforce-build-kick.json';
const RECENT_KICK_MS = 20 * 60_000;
const MAX_KICKS = 12;
const LAST_ERROR_MAX = 300;

export interface WorkforceBuildKickResult {
  /** True only when the message actually reached the gateway. */
  kicked: boolean;
  /** Why nothing happened this run (never set for "switched off"). */
  reason?: string;
  /** The gateway session the message was sent to, on a kick. */
  sessionKey?: string;
  /** Set ONLY when the job is switched off for this box (client tenant on a shared host). */
  skippedReason?: string;
  /** The gateway's own refusal, recorded on the kick ledger for the next run. */
  lastError?: string;
}

/** The kick ledger (<workspace>/.workforce-build-kick.json), as §2.1 defines it. */
interface KickRecord {
  kickedAt?: string;
  sessionKey?: string;
  reason?: string;
  kicks?: number;
  lastError?: string;
  gaveUp?: boolean;
}

/** Optional injected dependencies (testing seam). Production uses the defaults. */
export interface WorkforceBuildKickDeps {
  /** The gateway client; defaults to this box's own loopback singleton. */
  client?: Pick<OpenClawClient, 'isConnected' | 'connect' | 'createSession' | 'sendMessage'>;
  /** Current time in ms (defaults to Date.now()) — lets tests drive the 20-minute window. */
  now?: number;
}

/** Temp file in the same directory, then rename: a reader never sees half a record. */
function writeJsonAtomic(target: string, value: unknown): void {
  const tmp = `${target}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, target);
}

function readJsonObject(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * A box that serves a client tenant is a shared host: starting THIS box's
 * workforce build there would build the wrong tenant. The tenant registry is
 * the only honest signal available to a background job (no request, therefore
 * no host), and a client-kind registration is exactly what makes an
 * installation shared (see launchHostIsShared).
 */
function switchedOffForThisBox(): string | null {
  try {
    if (tenantRegistryIdentities().some((identity) => identity.kind === 'client')) {
      return 'switched off for this box: it serves a client tenant on a shared host';
    }
  } catch {
    // An unreadable registry is this box's own single-tenant installation.
  }
  return null;
}

/**
 * One kick attempt. Reads build-state and the two workspace files, decides
 * whether this run may start the build, and either sends the ONE message or
 * says why not. Never throws.
 *
 * @param reason who asked (the complete route, or the scheduled job) — recorded
 *               on the kick ledger so a later reader can tell the two apart.
 */
export async function kickWorkforceBuild(
  reason: string,
  deps: WorkforceBuildKickDeps = {},
): Promise<WorkforceBuildKickResult> {
  const off = switchedOffForThisBox();
  if (off) return { kicked: false, skippedReason: off };

  const workspace = resolveWorkspaceDir();
  const wantedPath = path.join(workspace, WANTED_FILE);
  const kickPath = path.join(workspace, KICK_FILE);

  if (!fs.existsSync(wantedPath)) return { kicked: false, reason: 'no build is wanted' };

  const state = readBuildState();
  if (state?.interviewComplete !== true) {
    return { kicked: false, reason: 'the interview is not complete' };
  }
  const qcStatus = readInterviewQcStatus(state);
  if (qcStatus !== 'pass' && qcStatus !== 'needs-review') {
    return { kicked: false, reason: `the interview's QC status is ${qcStatus}` };
  }
  if (nonEmptyString(state.buildCompletedAt)) {
    return { kicked: false, reason: 'the build is already complete' };
  }

  // The wanted file is {wantedAt, reason, buildId}; the build id falls back to
  // the interview session id so a wanted file written before ids existed still
  // gets a stable session key.
  const wanted = readJsonObject(wantedPath);
  const buildId =
    nonEmptyString(wanted.buildId) || nonEmptyString(state.interviewSessionId);
  if (!buildId) return { kicked: false, reason: 'no buildId and no interviewSessionId' };

  const now = deps.now ?? Date.now();
  const sessionKey = `agent:main:workforce-build-${buildId}`;
  const prior: KickRecord = readJsonObject(kickPath) as KickRecord;
  // The 12-kick ceiling is PER BUILD: the recorded session key names the build
  // this ledger belongs to, so a new build starts its own count.
  const sameBuild = nonEmptyString(prior.sessionKey) === sessionKey;
  const kicks = sameBuild && typeof prior.kicks === 'number' ? prior.kicks : 0;

  if (sameBuild && prior.gaveUp === true) {
    return { kicked: false, reason: `gave up after ${MAX_KICKS} kicks for this build` };
  }
  if (kicks >= MAX_KICKS) {
    writeJsonAtomic(kickPath, { ...prior, sessionKey, kicks, gaveUp: true });
    return { kicked: false, reason: `gave up after ${MAX_KICKS} kicks for this build` };
  }
  if (nonEmptyString(prior.kickedAt)) {
    const lastKick = Date.parse(prior.kickedAt as string);
    if (Number.isFinite(lastKick) && now - lastKick < RECENT_KICK_MS) {
      return { kicked: false, reason: 'a kick was sent less than 20 minutes ago' };
    }
  }

  const client = deps.client ?? getOpenClawClient();
  try {
    if (!client.isConnected()) await client.connect();
    try {
      // Open the session at the stable key. A key that already exists is the
      // REUSE case — the send below addresses it directly, so a refusal here is
      // not this kick's outcome.
      await client.createSession('mission-control', undefined, { key: sessionKey });
    } catch {
      /* reuse: sendMessage addresses the key itself */
    }
    await client.sendMessage(sessionKey, KICK_MESSAGE);
  } catch (err) {
    // A failed attempt records NO kickedAt and does not advance the count: the
    // next run retries at once instead of the 20-minute window swallowing it. A
    // stale kickedAt from a DIFFERENT build is dropped for the same reason.
    const lastError = (err instanceof Error ? err.message : String(err)).slice(0, LAST_ERROR_MAX);
    const { kickedAt: staleKick, ...rest } = prior;
    writeJsonAtomic(kickPath, {
      ...(sameBuild && staleKick ? { kickedAt: staleKick } : {}),
      ...rest,
      sessionKey,
      kicks,
      lastError,
    });
    return { kicked: false, reason: 'the gateway did not accept the kick', lastError };
  }

  writeJsonAtomic(kickPath, {
    kickedAt: new Date(now).toISOString(),
    sessionKey,
    reason,
    kicks: kicks + 1,
  } satisfies KickRecord);
  return { kicked: true, reason, sessionKey };
}
