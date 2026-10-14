/**
 * Council endpoint contract registry (CWE-029, directive Sections
 * 11.6, 17.2, 17.5, 17.6).
 *
 * This registry is DATA, not commentary: every endpoint on the Section
 * 17 surface is registered with a canonical CWE-003 EndpointContract
 * (method, path, request/response schema names, authorization purpose,
 * idempotency rule, version rule, service owner, contract-test gate,
 * live-integration gate) plus the foundation readiness state and the
 * unit that owns the endpoint's production service.
 *
 * Acceptance scope for CWE-029 is
 * foundation_contracts_and_real_safe_reads_only: safe reads and brief
 * draft persistence are `ready` and wired to real services (CWE-006
 * store, CWE-007 authorization, CWE-008 route catalog). Every other
 * endpoint is `not_ready`: its route exists and answers with the typed
 * FEATURE_NOT_READY error naming the owning unit (Section 17.6). No
 * entry in this registry claims a live integration that has not run.
 *
 * Route-file ownership of every endpoint transfers to CWE-050 after
 * this unit's foundation acceptance.
 */

import {
  SCHEMA_VERSIONS,
  validateEndpointContract,
  type AuthorizationKind,
  type EndpointContract,
} from '../contracts';

export type EndpointReadiness = 'ready' | 'not_ready';

export interface CouncilEndpointEntry {
  contract: EndpointContract;
  readiness: EndpointReadiness;
  /** The unit that owns the endpoint's production service (Section 17.5). */
  owning_unit: string;
  /** Human-readable surface name used in FEATURE_NOT_READY messages. */
  surface: string;
}

type IdempotencyRule = EndpointContract['idempotency'];

interface EntrySpec {
  contract_id: string;
  method: EndpointContract['method'];
  path: string;
  request_schema: string | null;
  response_schema: string;
  authorization_purpose: AuthorizationKind;
  idempotency: IdempotencyRule;
  version_rule: string;
  service_owner: string;
  readiness: EndpointReadiness;
  owning_unit: string;
  surface: string;
}

const FOUNDATION_GATE =
  'CWE-029 council route tests (contract_tested, synthetic identity fixtures)';
const NOT_READY_GATE =
  'CWE-029 FEATURE_NOT_READY shape test (contract_tested); live gate opens at the owning unit acceptance and CWE-050 integration';

function entry(spec: EntrySpec): CouncilEndpointEntry {
  const contract: EndpointContract = {
    schema_version: SCHEMA_VERSIONS.endpoint,
    contract_id: spec.contract_id,
    method: spec.method,
    path: spec.path,
    request_schema: spec.request_schema,
    response_schema: spec.response_schema,
    authorization_purpose: spec.authorization_purpose,
    idempotency: spec.idempotency,
    version_rule: spec.version_rule,
    service_owner: spec.service_owner,
    contract_test_gate:
      spec.readiness === 'ready' ? FOUNDATION_GATE : NOT_READY_GATE,
    live_integration_gate:
      spec.readiness === 'ready'
        ? 'CWE-050 integration (route ownership transfer)'
        : `${spec.owning_unit} acceptance, then CWE-050 integration`,
  };
  const check = validateEndpointContract(contract);
  if (!check.ok) {
    throw new Error(
      `Endpoint registry entry ${spec.contract_id} failed canonical EndpointContract validation: ${JSON.stringify(check.issues)}`,
    );
  }
  return {
    contract,
    readiness: spec.readiness,
    owning_unit: spec.owning_unit,
    surface: spec.surface,
  };
}

const SAFE_READ_VERSION = 'Safe read of committed state only; no version precondition.';
const SESSION_VERSION =
  'Session state_version compare-and-swap; stale writers receive PERSISTENCE_STATE_CONFLICT.';

export const COUNCIL_ENDPOINT_REGISTRY: readonly CouncilEndpointEntry[] = [
  // ------------------------------------------------------------ metadata
  entry({
    contract_id: 'council.capabilities.get',
    method: 'GET',
    path: '/api/council/capabilities',
    request_schema: null,
    response_schema: 'CouncilCapabilities (registry and route catalog metadata)',
    authorization_purpose: 'council_run',
    idempotency: 'safe_read',
    version_rule: SAFE_READ_VERSION,
    service_owner: 'CWE-029 (foundation metadata over CWE-008 catalog)',
    readiness: 'ready',
    owning_unit: 'CWE-029',
    surface: 'Council capabilities metadata',
  }),
  entry({
    contract_id: 'council.advisors.get',
    method: 'GET',
    path: '/api/council/advisors',
    request_schema: null,
    response_schema: 'SeatRoster (canonical CWE-003 contract data)',
    authorization_purpose: 'council_run',
    idempotency: 'safe_read',
    version_rule: SAFE_READ_VERSION,
    service_owner: 'CWE-029 (canonical contract roster)',
    readiness: 'ready',
    owning_unit: 'CWE-029',
    surface: 'Council advisor roster',
  }),
  entry({
    contract_id: 'council.models.get',
    method: 'GET',
    path: '/api/council/models',
    request_schema: null,
    response_schema: 'RouteCatalogEntry[] (CWE-008 explicit route catalog)',
    authorization_purpose: 'council_run',
    idempotency: 'safe_read',
    version_rule: SAFE_READ_VERSION,
    service_owner: 'CWE-008 route catalog, served by CWE-029',
    readiness: 'ready',
    owning_unit: 'CWE-029',
    surface: 'Council model route catalog',
  }),
  entry({
    contract_id: 'council.models.probe',
    method: 'POST',
    path: '/api/council/models/probe',
    request_schema: 'ModelProbeRequest (route reference)',
    response_schema: 'RouteEvidence (CWE-009 transport probe)',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: 'Probe results are recorded as route evidence with a probe timestamp.',
    service_owner: 'CWE-009 (transport probes)',
    readiness: 'not_ready',
    owning_unit: 'CWE-009',
    surface: 'Model route probe',
  }),

  // ------------------------------------------------------------ sessions
  entry({
    contract_id: 'council.sessions.list',
    method: 'GET',
    path: '/api/council/sessions',
    request_schema: null,
    response_schema: 'CouncilSessionSummary[] (committed store state)',
    authorization_purpose: 'council_run',
    idempotency: 'safe_read',
    version_rule: SAFE_READ_VERSION,
    service_owner: 'CWE-006 store, served by CWE-029',
    readiness: 'ready',
    owning_unit: 'CWE-029',
    surface: 'Council session list',
  }),
  entry({
    contract_id: 'council.sessions.create',
    method: 'POST',
    path: '/api/council/sessions',
    request_schema:
      'SessionDraftRequest (foundation draft input composing CWE-003 DecisionBrief and SessionSpec)',
    response_schema: 'CouncilStoredSession (CWE-006 store record)',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule:
      'Creates a DRAFT at state_version 0 and brief revision 1; no inference or task dispatch.',
    service_owner: 'CWE-006 store, served by CWE-029 (draft only)',
    readiness: 'ready',
    owning_unit: 'CWE-029',
    surface: 'Council session draft creation',
  }),
  entry({
    contract_id: 'council.sessions.get',
    method: 'GET',
    path: '/api/council/sessions/:id',
    request_schema: null,
    response_schema: 'CouncilStoredSession (CWE-006 store record)',
    authorization_purpose: 'council_run',
    idempotency: 'safe_read',
    version_rule: SAFE_READ_VERSION,
    service_owner: 'CWE-006 store, served by CWE-029',
    readiness: 'ready',
    owning_unit: 'CWE-029',
    surface: 'Council session detail',
  }),
  entry({
    contract_id: 'council.sessions.brief.patch',
    method: 'PATCH',
    path: '/api/council/sessions/:id/brief',
    request_schema:
      'BriefRevisionRequest (DecisionBrief content plus expected_revision)',
    response_schema: 'CouncilStoredSession (CWE-006 store record)',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule:
      'expected_revision must equal the current brief revision; a mismatch returns VERSION_MISMATCH and writes nothing.',
    service_owner: 'CWE-006 store, served by CWE-029 (draft brief revisions)',
    readiness: 'ready',
    owning_unit: 'CWE-029',
    surface: 'Council session brief revision',
  }),
  entry({
    contract_id: 'council.sessions.verdict.get',
    method: 'GET',
    path: '/api/council/sessions/:id/verdict',
    request_schema: null,
    response_schema:
      'Verdict (CWE-003) or the explicit not_ready verdict state when no verdict is committed',
    authorization_purpose: 'council_run',
    idempotency: 'safe_read',
    version_rule: SAFE_READ_VERSION,
    service_owner: 'CWE-026 verdict service; committed reads served by CWE-029',
    readiness: 'ready',
    owning_unit: 'CWE-029',
    surface: 'Council session verdict read',
  }),
  entry({
    contract_id: 'council.sessions.events.get',
    method: 'GET',
    path: '/api/council/sessions/:id/events',
    request_schema: null,
    response_schema: 'CouncilEvent stream page (durable event journal)',
    authorization_purpose: 'council_run',
    idempotency: 'safe_read',
    version_rule: 'Journal sequence cursor; sequences are gapless per session.',
    service_owner: 'CWE-030 (event surface over the CWE-006 journal)',
    readiness: 'not_ready',
    owning_unit: 'CWE-030',
    surface: 'Council session event stream',
  }),
  entry({
    contract_id: 'council.sessions.evidence.get',
    method: 'GET',
    path: '/api/council/sessions/:id/evidence/:evidenceId',
    request_schema: null,
    response_schema: 'EvidenceManifestEntry content (committed evidence)',
    authorization_purpose: 'council_run',
    idempotency: 'safe_read',
    version_rule: SAFE_READ_VERSION,
    service_owner: 'CWE-025 (evidence production during council runs)',
    readiness: 'not_ready',
    owning_unit: 'CWE-025',
    surface: 'Council session evidence read',
  }),

  // ------------------------------------------------- run control (CWE-027)
  entry({
    contract_id: 'council.sessions.start',
    method: 'POST',
    path: '/api/council/sessions/:id/start',
    request_schema: 'RunStartRequest (run authorization reference)',
    response_schema: 'OperationReceipt (202 on admission)',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: SESSION_VERSION,
    service_owner: 'CWE-027 with CWE-028 and CWE-049',
    readiness: 'not_ready',
    owning_unit: 'CWE-027',
    surface: 'Council session run start',
  }),
  entry({
    contract_id: 'council.sessions.pause',
    method: 'POST',
    path: '/api/council/sessions/:id/pause',
    request_schema: 'RunControlRequest (expected state version)',
    response_schema: 'OperationReceipt',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: SESSION_VERSION,
    service_owner: 'CWE-027 with CWE-028 and CWE-049',
    readiness: 'not_ready',
    owning_unit: 'CWE-027',
    surface: 'Council session run pause',
  }),
  entry({
    contract_id: 'council.sessions.cancel',
    method: 'POST',
    path: '/api/council/sessions/:id/cancel',
    request_schema: 'RunControlRequest (expected state version)',
    response_schema: 'OperationReceipt',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: SESSION_VERSION,
    service_owner: 'CWE-027 with CWE-028 and CWE-049',
    readiness: 'not_ready',
    owning_unit: 'CWE-027',
    surface: 'Council session run cancel',
  }),
  entry({
    contract_id: 'council.sessions.resume',
    method: 'POST',
    path: '/api/council/sessions/:id/resume',
    request_schema: 'RunControlRequest (expected state version)',
    response_schema: 'OperationReceipt',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: SESSION_VERSION,
    service_owner: 'CWE-027 with CWE-028 and CWE-049',
    readiness: 'not_ready',
    owning_unit: 'CWE-027',
    surface: 'Council session run resume',
  }),

  // ------------------------------------------- run authorization (CWE-049)
  entry({
    contract_id: 'council.sessions.run_authorization.preview',
    method: 'POST',
    path: '/api/council/sessions/:id/run-authorization/preview',
    request_schema: 'RunPreviewRequest (frozen brief revision)',
    response_schema: 'RunPreview (CWE-003); preview never approves',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: 'Preview binds the frozen brief revision and content hash.',
    service_owner: 'CWE-049 (run preview, approval, admission)',
    readiness: 'not_ready',
    owning_unit: 'CWE-049',
    surface: 'Council run authorization preview',
  }),
  entry({
    contract_id: 'council.sessions.run_authorization.approve',
    method: 'POST',
    path: '/api/council/sessions/:id/run-authorization/approve',
    request_schema: 'RunApprovalRequest (preview reference)',
    response_schema: 'RunGrant (CWE-003); approval never executes',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: 'Approval binds the exact preview hash it approves.',
    service_owner: 'CWE-049 (run preview, approval, admission)',
    readiness: 'not_ready',
    owning_unit: 'CWE-049',
    surface: 'Council run authorization approval',
  }),
  entry({
    contract_id: 'council.sessions.run_authorization.get',
    method: 'GET',
    path: '/api/council/sessions/:id/run-authorization',
    request_schema: null,
    response_schema: 'RunGrant (CWE-003) with grant status',
    authorization_purpose: 'council_run',
    idempotency: 'safe_read',
    version_rule: SAFE_READ_VERSION,
    service_owner: 'CWE-049 (run preview, approval, admission)',
    readiness: 'not_ready',
    owning_unit: 'CWE-049',
    surface: 'Council run authorization read',
  }),
  entry({
    contract_id: 'council.sessions.run_authorization.revoke',
    method: 'POST',
    path: '/api/council/sessions/:id/run-authorization/revoke',
    request_schema: 'RunGrantRevocationRequest',
    response_schema: 'RunGrant (CWE-003) with revoked status',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: 'Revocation bumps the session revocation generation.',
    service_owner: 'CWE-049 (run preview, approval, admission)',
    readiness: 'not_ready',
    owning_unit: 'CWE-049',
    surface: 'Council run authorization revocation',
  }),

  // ------------------------------------------------- decision and follow-on
  entry({
    contract_id: 'council.sessions.decision',
    method: 'POST',
    path: '/api/council/sessions/:id/decision',
    request_schema: 'ClientDecisionRequest (chosen option)',
    response_schema: 'Verdict with the recorded client decision',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: 'Decision binds the current verdict revision.',
    service_owner: 'CWE-050 (post-verdict lifecycle coordination)',
    readiness: 'not_ready',
    owning_unit: 'CWE-050',
    surface: 'Council session decision recording',
  }),
  entry({
    contract_id: 'council.sessions.follow_up',
    method: 'POST',
    path: '/api/council/sessions/:id/follow-up',
    request_schema: 'FollowUpRequest (question for the council)',
    response_schema: 'OperationReceipt (202 on admission)',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: SESSION_VERSION,
    service_owner: 'CWE-050 (follow-up coordination)',
    readiness: 'not_ready',
    owning_unit: 'CWE-050',
    surface: 'Council session follow-up',
  }),
  entry({
    contract_id: 'council.sessions.rerun',
    method: 'POST',
    path: '/api/council/sessions/:id/rerun',
    request_schema: 'RerunRequest (brief revision to rerun)',
    response_schema: 'OperationReceipt (202 on admission)',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: SESSION_VERSION,
    service_owner: 'CWE-050 (rerun coordination)',
    readiness: 'not_ready',
    owning_unit: 'CWE-050',
    surface: 'Council session rerun',
  }),
  entry({
    contract_id: 'council.sessions.outcomes',
    method: 'POST',
    path: '/api/council/sessions/:id/outcomes',
    request_schema: 'OutcomeReportRequest (observed outcomes)',
    response_schema: 'OperationReceipt',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: 'Outcomes append to the session record; they never rewrite a verdict.',
    service_owner: 'CWE-050 (outcomes coordination)',
    readiness: 'not_ready',
    owning_unit: 'CWE-050',
    surface: 'Council session outcome reporting',
  }),

  // ------------------------------------------------- action plan (CWE-036)
  entry({
    contract_id: 'council.sessions.action_plan.preview',
    method: 'POST',
    path: '/api/council/sessions/:id/action-plan/preview',
    request_schema: 'ActionPlanPreviewRequest (verdict revision)',
    response_schema: 'ActionProposal[] preview; preview never approves',
    authorization_purpose: 'action_plan_approval',
    idempotency: 'required_key',
    version_rule: 'Preview binds the verdict revision it was built from.',
    service_owner: 'CWE-036 (Kanban single-parent action plans)',
    readiness: 'not_ready',
    owning_unit: 'CWE-036',
    surface: 'Council action plan preview',
  }),
  entry({
    contract_id: 'council.sessions.action_plan.approve',
    method: 'POST',
    path: '/api/council/sessions/:id/action-plan/approve',
    request_schema: 'ActionPlanApprovalRequest (preview reference)',
    response_schema: 'ApprovalRecord (CWE-003); approval never creates tasks',
    authorization_purpose: 'action_plan_approval',
    idempotency: 'required_key',
    version_rule: 'Approval binds the exact preview hash it approves.',
    service_owner: 'CWE-036 (Kanban single-parent action plans)',
    readiness: 'not_ready',
    owning_unit: 'CWE-036',
    surface: 'Council action plan approval',
  }),
  entry({
    contract_id: 'council.sessions.action_plan.create',
    method: 'POST',
    path: '/api/council/sessions/:id/action-plan/create',
    request_schema: 'ActionPlanCreateRequest (approval reference)',
    response_schema: 'OperationReceipt (parent task reference)',
    authorization_purpose: 'execution',
    idempotency: 'required_key',
    version_rule: 'Creation requires a committed approval for the same preview hash.',
    service_owner: 'CWE-036 (Kanban single-parent action plans)',
    readiness: 'not_ready',
    owning_unit: 'CWE-036',
    surface: 'Council action plan creation',
  }),

  // ------------------------------------------------------- exports (CWE-038)
  entry({
    contract_id: 'council.exports.create',
    method: 'POST',
    path: '/api/council/exports',
    request_schema: 'ExportRequest (session and format)',
    response_schema: 'ExportRecord (202 on acceptance)',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: 'Exports render committed session state only.',
    service_owner: 'CWE-038 (report exports)',
    readiness: 'not_ready',
    owning_unit: 'CWE-038',
    surface: 'Council report export creation',
  }),
  entry({
    contract_id: 'council.exports.get',
    method: 'GET',
    path: '/api/council/exports/:exportId',
    request_schema: null,
    response_schema: 'ExportRecord with download state',
    authorization_purpose: 'council_run',
    idempotency: 'safe_read',
    version_rule: SAFE_READ_VERSION,
    service_owner: 'CWE-038 (report exports)',
    readiness: 'not_ready',
    owning_unit: 'CWE-038',
    surface: 'Council report export read',
  }),

  // ------------------------------------------- lifecycle coordination (CWE-050)
  entry({
    contract_id: 'council.sessions.archive',
    method: 'POST',
    path: '/api/council/sessions/:id/archive',
    request_schema: 'ArchiveRequest',
    response_schema: 'CouncilStoredSession with the archive flag set',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: SESSION_VERSION,
    service_owner: 'CWE-050 (archive coordination)',
    readiness: 'not_ready',
    owning_unit: 'CWE-050',
    surface: 'Council session archive',
  }),
  entry({
    contract_id: 'council.sessions.delete',
    method: 'DELETE',
    path: '/api/council/sessions/:id',
    request_schema: 'SessionDeleteRequest (explicit confirmation)',
    response_schema: 'DeletionReceipt (tombstone reference, no content)',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: 'Deletion writes a tombstone; late writes are blocked.',
    service_owner: 'CWE-050 (delete coordination)',
    readiness: 'not_ready',
    owning_unit: 'CWE-050',
    surface: 'Council session deletion',
  }),
  entry({
    contract_id: 'council.settings.get',
    method: 'GET',
    path: '/api/council/settings',
    request_schema: null,
    response_schema: 'CouncilSettings (CWE-003)',
    authorization_purpose: 'council_run',
    idempotency: 'safe_read',
    version_rule: SAFE_READ_VERSION,
    service_owner: 'CWE-050 (settings coordination)',
    readiness: 'not_ready',
    owning_unit: 'CWE-050',
    surface: 'Council settings read',
  }),
  entry({
    contract_id: 'council.settings.patch',
    method: 'PATCH',
    path: '/api/council/settings',
    request_schema: 'CouncilSettings (CWE-003)',
    response_schema: 'CouncilSettings (CWE-003)',
    authorization_purpose: 'council_run',
    idempotency: 'required_key',
    version_rule: 'Settings carry their own revision; stale writers conflict.',
    service_owner: 'CWE-050 (settings coordination)',
    readiness: 'not_ready',
    owning_unit: 'CWE-050',
    surface: 'Council settings update',
  }),
];

const BY_ID = new Map(
  COUNCIL_ENDPOINT_REGISTRY.map((item) => [item.contract.contract_id, item]),
);
const BY_ROUTE = new Map(
  COUNCIL_ENDPOINT_REGISTRY.map((item) => [
    `${item.contract.method} ${item.contract.path}`,
    item,
  ]),
);

export function endpointById(contractId: string): CouncilEndpointEntry {
  const found = BY_ID.get(contractId);
  if (!found) throw new Error(`Unknown council endpoint contract id: ${contractId}`);
  return found;
}

export function endpointByRoute(
  method: string,
  path: string,
): CouncilEndpointEntry | null {
  return BY_ROUTE.get(`${method.toUpperCase()} ${path}`) ?? null;
}

export function registrySummary(): {
  total: number;
  ready: number;
  not_ready: number;
  by_owning_unit: Record<string, number>;
} {
  const byUnit: Record<string, number> = {};
  let ready = 0;
  for (const item of COUNCIL_ENDPOINT_REGISTRY) {
    if (item.readiness === 'ready') ready += 1;
    byUnit[item.owning_unit] = (byUnit[item.owning_unit] ?? 0) + 1;
  }
  return {
    total: COUNCIL_ENDPOINT_REGISTRY.length,
    ready,
    not_ready: COUNCIL_ENDPOINT_REGISTRY.length - ready,
    by_owning_unit: byUnit,
  };
}
