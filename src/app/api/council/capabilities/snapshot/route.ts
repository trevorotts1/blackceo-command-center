import type { NextRequest } from 'next/server';
import {
  checkBodyScope,
  handleCouncil,
  parseJsonBody,
  requireIdempotencyKey,
  requireMutationProofFor,
  respondOk,
} from '@/lib/council/api/foundation';
import { CouncilApiError } from '@/lib/council/api/errors';
import {
  assertSnapshotInstallation,
  CAPABILITY_SNAPSHOT_LIMITS,
  CAPABILITY_SNAPSHOT_SCHEMA,
  CapabilitySnapshotError,
  validateCapabilitySnapshot,
  type InstallationCapabilitySnapshot,
} from '@/lib/council/capability-snapshot';
import { scopeForPrincipal } from '@/lib/council/capability-snapshot-service';
import {
  loadCapabilitySnapshot,
  saveCapabilitySnapshot,
} from '@/lib/council/persistence/capability-snapshot-store';
import { canonicalHash } from '@/lib/council/contracts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const AVAILABILITY_NOTE =
  'Available means installed on this installation. It is not an operational claim: a matching skill or department is optional assistance, never a promise that it can execute a plan step.';
const OPERATIONAL_NOTE =
  'Operational state is separate from availability. This route records installation facts only; it does not probe, start, or execute a skill or department.';

function snapshotError(error: unknown): never {
  if (error instanceof CapabilitySnapshotError) {
    if (error.code === 'CAPABILITY_SNAPSHOT_MISMATCH') {
      throw new CouncilApiError('CAPABILITY_SNAPSHOT_MISMATCH', error.message, {
        status: 403,
        action: 'check_installation',
      });
    }
    throw new CouncilApiError('CAPABILITY_SNAPSHOT_INVALID', error.message, {
      status: error.code === 'CAPABILITY_SNAPSHOT_TOO_LARGE' ? 413 : 400,
      action: 'fix_request',
    });
  }
  throw error;
}

/**
 * GET /api/council/capabilities/snapshot
 *
 * The scope-bound installation capability snapshot. Metadata only: no
 * tenant-private data, no filesystem read on this route, no model call.
 * When no snapshot has been recorded the response says so explicitly
 * instead of returning an empty inventory that reads like "nothing is
 * installed".
 */
export async function GET(request: NextRequest) {
  return handleCouncil(request, async (ctx) => {
    const stored = loadCapabilitySnapshot(
      ctx.store.handle(),
      scopeForPrincipal(ctx.principal),
    );
    return respondOk(ctx, {
      schema_version: CAPABILITY_SNAPSHOT_SCHEMA,
      integration: 'integrated' as const,
      ingest_route: '/api/council/capabilities/snapshot',
      read_route: '/api/council/capabilities/snapshot',
      binding: {
        tenant_id: ctx.principal.scope.tenant_id,
        company_id: ctx.principal.scope.company_id,
        installation_id: ctx.principal.scope.installation_id,
      },
      snapshot: stored?.snapshot ?? null,
      source: stored?.source ?? null,
      updated_at: stored?.updated_at ?? null,
      item_count: stored?.snapshot.items.length ?? 0,
      availability_note: AVAILABILITY_NOTE,
      operational_note: OPERATIONAL_NOTE,
      limits: CAPABILITY_SNAPSHOT_LIMITS,
      matching: 'recorded_reference_or_exact_whole_phrase_only',
    });
  });
}

/**
 * POST /api/council/capabilities/snapshot
 *
 * Ingest one strict, scope-bound installation capability snapshot. The
 * caller's authenticated installation is authoritative; a snapshot naming
 * another installation is refused. The mutation requires the channel's
 * proof (CSRF cookie for a browser, the approved bearer for a machine
 * principal), an idempotency key, and the foundation JSON body limit.
 *
 * The body is the snapshot contract itself. Only a bounded id, kind, name,
 * short description, availability, source, and recorded plan references
 * are accepted; there is no path, URL, prompt, memory, credential, or
 * configuration field in the contract, and unknown fields are refused.
 */
export async function POST(request: NextRequest) {
  return handleCouncil(request, async (ctx) => {
    await requireMutationProofFor(request, ctx.principal);
    const body = await parseJsonBody(request);
    const idempotencyKey = requireIdempotencyKey(
      request,
      body,
      'capability snapshot ingest',
    );
    // The idempotency key is transport proof, not snapshot content. Remove
    // it before the strict snapshot validation, or the strict schema would
    // refuse the request as an unknown field.
    delete body.idempotency_key;
    checkBodyScope(ctx.principal, body);

    let snapshot: InstallationCapabilitySnapshot;
    try {
      snapshot = validateCapabilitySnapshot(body);
      assertSnapshotInstallation(
        snapshot,
        ctx.principal.scope.installation_id,
      );
    } catch (error) {
      throw snapshotError(error);
    }

    const scope = scopeForPrincipal(ctx.principal);
    const claim = ctx.repositories.claimRequestKey({
      tenantId: scope.tenant_id,
      source: 'council-api',
      operation: 'council.capabilities.snapshot',
      requestKey: idempotencyKey,
      payloadFingerprint: canonicalHash(snapshot),
      sessionId: null,
    });
    if (claim.outcome === 'conflict') {
      throw new CouncilApiError(
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key was already used for a different capability snapshot. The repeated request was refused; no state changed.',
        { status: 409, action: 'use_a_new_idempotency_key' },
      );
    }
    // Upsert on replay too: a claim without a saved row (for example a
    // process stop between the two writes) must never read back as stored.
    saveCapabilitySnapshot(ctx.store.handle(), scope, {
      snapshot,
      source: 'client_push',
      owner_subject: ctx.principal.subject,
      now: new Date().toISOString(),
    });
    return respondOk(
      ctx,
      {
        schema_version: CAPABILITY_SNAPSHOT_SCHEMA,
        integration: 'integrated' as const,
        stored: true,
        replayed: claim.outcome === 'replay',
        binding: scope,
        item_count: snapshot.items.length,
        captured_at: snapshot.captured_at,
        basis: snapshot.basis,
        availability_note: AVAILABILITY_NOTE,
        operational_note: OPERATIONAL_NOTE,
        limits: CAPABILITY_SNAPSHOT_LIMITS,
      },
      { status: claim.outcome === 'replay' ? 200 : 201 },
    );
  });
}
