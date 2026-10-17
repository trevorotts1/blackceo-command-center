/**
 * CWE-008: explicit route selection adapter (directive Section 35 contracts
 * T025, T026, T028, plus the unit's required negatives).
 *
 * - T025: an explicit supported route reaches the adapter unchanged; unrelated
 *   model-preference cascades are not consulted.
 * - T026: a route forbidden by unrelated fleet defaults can use the scoped
 *   council policy without changing other skills (fleet selector behavior is
 *   asserted unchanged in the same run).
 * - T028: an unsupported requested reasoning setting is reported; it is
 *   neither silently renamed nor falsely claimed active.
 * - Negative: a cascade that would substitute the selected route is refused,
 *   or surfaced as an explicit approved change with a new route revision.
 * - Negative: a body-supplied company ID is not proof of scope.
 * - Negative: credential values never appear in emitted payloads (the
 *   catalog-side proof lives in council-route-catalog.test.ts; here the
 *   selection snapshot and client payload are checked the same way).
 *
 * Runs via the Node built-in test runner under tsx (npm run test:unit).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildRouteCatalog,
  HIDDEN_IDENTITY_STATEMENT,
  type ProviderRouteDescriptor,
} from '../../src/lib/council/providers';
import {
  applyHostResolution,
  createRouteSelection,
  selectionClientPayload,
  CouncilSelectionError,
  type TrustedScope,
} from '../../src/lib/council/explicit-selection';
import {
  checkModelSovereignty,
  isForbidden,
  selectTaskModel,
} from '../../src/lib/model-selector';
import type { ModelRegistryEntry } from '../../src/lib/model-registry-types';

const TRUSTED_SCOPE: TrustedScope = {
  tenantId: 'tenant-fixture',
  companyId: 'company-trusted',
  installationId: 'installation-fixture',
  ownerSubject: 'owner-fixture',
};

const CREATED_AT = '2026-10-14T00:00:00.000Z';

function fixedRoute(overrides: Partial<ProviderRouteDescriptor> = {}): ProviderRouteDescriptor {
  return {
    routeId: 'fixture-cloud/fixture-model-a',
    providerSlug: 'fixture-cloud',
    displayLabel: 'Fixture Model A',
    kind: 'fixed_model',
    modelId: 'fixture-cloud/fixture-model-a',
    combinationMembers: [],
    providerAccountRef: 'fixture-account-1',
    capability: {
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
      capabilities: ['text', 'streaming', 'reasoning'],
      supportedReasoningLevels: ['auto', 'low', 'medium', 'high'],
    },
    credential: { state: 'present', envVar: 'FIXTURE_CLOUD_API_KEY', source: 'process.env', checked: [] },
    ...overrides,
  };
}

function selectionFor(
  route: ProviderRouteDescriptor,
  request: Record<string, unknown> = {},
  scope: TrustedScope = TRUSTED_SCOPE,
) {
  const catalog = buildRouteCatalog([route]);
  return createRouteSelection(
    catalog[0],
    { routeId: route.routeId, ...request },
    scope,
    { routeRevision: 1, createdAt: CREATED_AT },
  );
}

function registryEntry(modelId: string, provider: string): ModelRegistryEntry {
  return {
    id: 1,
    model_id: modelId,
    label: modelId,
    provider,
    family: null,
    context_window: 128000,
    input_cost_per_million: 1,
    output_cost_per_million: 1,
    pricing_model: 'per_token',
    pricing_source: 'fixture',
    capabilities: ['text'],
    status: 'active',
    added_at: CREATED_AT,
    last_seen_at: CREATED_AT,
    raw_metadata: {},
  };
}

// ---------------------------------------------------------------------------
// T025
// ---------------------------------------------------------------------------

test('T025: an explicitly selected route is accepted unchanged when the host uses it', () => {
  const selection = selectionFor(fixedRoute());
  assert.equal(selection.requestedModelOrAlias, 'fixture-cloud/fixture-model-a');
  assert.equal(selection.fallbackPolicy, 'none');
  const outcome = applyHostResolution(selection, {
    source: 'explicit_route',
    attemptedModelId: 'fixture-cloud/fixture-model-a',
    reportedModelId: 'fixture-cloud/fixture-model-a',
  });
  assert.equal(outcome.outcome, 'accepted');
  assert.equal(outcome.effectiveModelId, 'fixture-cloud/fixture-model-a');
  assert.equal(outcome.identityLevel, 'reported_identity');
});

test('T025 negative: a cascade winner that differs from the selection is refused, never substituted', () => {
  // What the unrelated fleet cascade WOULD pick from the same inventory: the
  // tier-1 fixture wins the cascade, not the client's selected route.
  const inventory = [
    registryEntry('fixture-cloud/fixture-model-a', 'fixture-cloud'),
    registryEntry('ollama-cloud/fixture-tier1-model', 'ollama-cloud'),
  ];
  const cascade = selectTaskModel({
    title: 'Fixture task',
    description: 'Fixture description',
    department: 'general',
    required_modality: 'text',
    inventory,
  });
  assert.equal(cascade.model_id, 'ollama-cloud/fixture-tier1-model');

  const selection = selectionFor(fixedRoute());
  const outcome = applyHostResolution(selection, {
    source: 'cascade',
    attemptedModelId: String(cascade.model_id),
  });
  assert.equal(outcome.outcome, 'refused');
  assert.equal(outcome.effectiveModelId, null);
  const refusal = outcome.events.find((e) => e.type === 'substitution_refused');
  assert.ok(refusal && refusal.type === 'substitution_refused');
  assert.equal(refusal.requestedModelOrAlias, 'fixture-cloud/fixture-model-a');
  assert.equal(refusal.attemptedModelId, 'ollama-cloud/fixture-tier1-model');
  // The selection itself is untouched by the refused attempt.
  assert.equal(selection.requestedModelOrAlias, 'fixture-cloud/fixture-model-a');
});

test('T025 invariant: the council adapter never imports the host cascade modules', () => {
  const councilDir = path.join(process.cwd(), 'src/lib/council');
  for (const file of ['providers.ts', 'explicit-selection.ts']) {
    const source = fs.readFileSync(path.join(councilDir, file), 'utf8');
    const imports = source
      .split('\n')
      .filter((line) => /^\s*import\s/.test(line) || /from\s+'/.test(line));
    for (const line of imports) {
      assert.equal(/model-selector|intelligence-resolver|runtime-model/.test(line), false, `${file}: ${line}`);
    }
  }
});

// ---------------------------------------------------------------------------
// T026
// ---------------------------------------------------------------------------

test('T026: a route forbidden by fleet defaults is selectable through the scoped council policy', () => {
  const forbiddenId = 'anthropic/fixture-model-a';
  // Fleet defaults forbid this route family for generic task dispatch...
  assert.equal(isForbidden(forbiddenId), true);
  const violation = checkModelSovereignty(forbiddenId, [], 'text');
  assert.ok(violation && violation.reason === 'forbidden_prefix');

  // ...but the council-scoped adapter honors the client's explicit choice.
  const route = fixedRoute({
    routeId: forbiddenId,
    providerSlug: 'anthropic',
    modelId: forbiddenId,
    displayLabel: 'Fixture Forbidden-Route Model',
  });
  const selection = selectionFor(route);
  const outcome = applyHostResolution(selection, {
    source: 'explicit_route',
    attemptedModelId: forbiddenId,
    reportedModelId: forbiddenId,
  });
  assert.equal(outcome.outcome, 'accepted');
  assert.equal(outcome.effectiveModelId, forbiddenId);

  // Unrelated fleet policy is unchanged by the council path existing.
  assert.equal(isForbidden(forbiddenId), true);
  assert.ok(checkModelSovereignty(forbiddenId, [], 'text') !== null);
});

// ---------------------------------------------------------------------------
// T028
// ---------------------------------------------------------------------------

test('T028: an unsupported reasoning preference is reported, not renamed, not claimed active', () => {
  const selection = selectionFor(fixedRoute(), { reasoningPreference: 'max' });
  assert.equal(selection.reasoning.requested, 'max');
  assert.equal(selection.reasoning.applied, null);
  assert.equal(selection.reasoning.supported, false);
  assert.ok(selection.reasoning.limitation !== null);
  assert.ok(selection.reasoning.limitation.includes('"max"'));
  assert.ok(selection.reasoning.limitation.includes('not claimed active'));
});

test('T028: a supported preference applies exactly, and auto stays unforced', () => {
  const high = selectionFor(fixedRoute(), { reasoningPreference: 'high' });
  assert.equal(high.reasoning.applied, 'high');
  assert.equal(high.reasoning.supported, true);

  const auto = selectionFor(fixedRoute(), { reasoningPreference: 'auto' });
  assert.equal(auto.reasoning.applied, 'auto');
  assert.equal(auto.reasoning.supported, true);
});

test('T028: an unprobed route records the preference without claiming it active', () => {
  const route = fixedRoute({
    capability: {
      contextWindowTokens: 64000,
      maxOutputTokens: null,
      capabilities: ['text'],
      supportedReasoningLevels: null,
    },
  });
  const selection = selectionFor(route, { reasoningPreference: 'high' });
  assert.equal(selection.reasoning.requested, 'high');
  assert.equal(selection.reasoning.applied, null);
  assert.equal(selection.reasoning.supported, null);
  assert.ok(selection.reasoning.limitation !== null);
});

// ---------------------------------------------------------------------------
// Scope negative
// ---------------------------------------------------------------------------

test('negative: a body-supplied company ID is not proof of scope', () => {
  // Conflicting body company id: rejected outright.
  assert.throws(
    () => selectionFor(fixedRoute(), { companyId: 'company-attacker' }),
    (err: unknown) =>
      err instanceof CouncilSelectionError && err.code === 'UNTRUSTED_SCOPE_FIELD',
  );
  // Matching body company id: accepted, but scope still comes from the
  // trusted argument, which is a different object than the request body.
  const selection = selectionFor(fixedRoute(), { companyId: 'company-trusted' });
  assert.equal(selection.scope.companyId, 'company-trusted');
  assert.equal(selection.scope.tenantId, 'tenant-fixture');
  assert.equal(selectionClientPayload(selection).companyId, 'company-trusted');
});

// ---------------------------------------------------------------------------
// Fallback policy behavior
// ---------------------------------------------------------------------------

test('an approved fallback change is surfaced with a change record and a new route revision', () => {
  const selection = selectionFor(fixedRoute(), {
    fallbackPolicy: 'client_approved_only',
  });
  const refused = applyHostResolution(selection, {
    source: 'fallback',
    attemptedModelId: 'fixture-cloud/fixture-model-b',
  });
  assert.equal(refused.outcome, 'refused');

  const approved = applyHostResolution(selection, {
    source: 'fallback',
    attemptedModelId: 'fixture-cloud/fixture-model-b',
    approval: {
      approvalRef: 'approval-fixture-1',
      reason: 'Selected route unavailable in this region',
      costImplication: 'Replacement is in the same price class.',
    },
  });
  assert.equal(approved.outcome, 'substituted_with_approval');
  assert.ok(approved.changeRecord);
  assert.equal(approved.changeRecord.originalRoute, 'fixture-cloud/fixture-model-a');
  assert.equal(approved.changeRecord.replacementRoute, 'fixture-cloud/fixture-model-b');
  assert.equal(approved.changeRecord.newRouteRevision, 2);
  assert.equal(approved.changeRecord.approvalRef, 'approval-fixture-1');
});

test('a provider-reported identity that conflicts with the requested model is surfaced as refused', () => {
  const selection = selectionFor(fixedRoute());
  const outcome = applyHostResolution(selection, {
    source: 'runtime_reconcile',
    attemptedModelId: 'fixture-cloud/fixture-model-a',
    reportedModelId: 'fixture-cloud/fixture-model-other',
  });
  assert.equal(outcome.outcome, 'refused');
  const refusal = outcome.events.find((e) => e.type === 'substitution_refused');
  assert.ok(refusal && refusal.type === 'substitution_refused');
  assert.equal(refusal.attemptedModelId, 'fixture-cloud/fixture-model-other');
});

// ---------------------------------------------------------------------------
// Combination routes (9Router-style), Section 13.5
// ---------------------------------------------------------------------------

function combinationSelection() {
  const route = fixedRoute({
    routeId: 'fixture-router/combination-1',
    providerSlug: 'fixture-router',
    displayLabel: 'Fixture Combination',
    kind: 'combination',
    modelId: null,
    combinationMembers: ['fixture-cloud/fixture-model-a', 'fixture-cloud/fixture-model-b'],
  });
  return selectionFor(route);
}

test('a combination resolves only to an approved member and records the member', () => {
  const selection = combinationSelection();
  const outcome = applyHostResolution(selection, {
    source: 'combination_member',
    attemptedModelId: 'fixture-cloud/fixture-model-b',
  });
  assert.equal(outcome.outcome, 'accepted');
  assert.equal(outcome.effectiveModelId, 'fixture-cloud/fixture-model-b');
  assert.ok(outcome.events.some((e) => e.type === 'combination_member_resolved'));
});

test('a combination refuses a non-member model', () => {
  const selection = combinationSelection();
  const outcome = applyHostResolution(selection, {
    source: 'combination_member',
    attemptedModelId: 'other-provider/fixture-model-x',
  });
  assert.equal(outcome.outcome, 'refused');
  assert.equal(outcome.effectiveModelId, null);
});

test('a hidden combination identity is stated, never invented', () => {
  const selection = combinationSelection();
  const outcome = applyHostResolution(selection, {
    source: 'combination_member',
    attemptedModelId: null,
    reportedModelId: null,
  });
  assert.equal(outcome.outcome, 'accepted');
  assert.equal(outcome.effectiveModelId, null);
  assert.equal(outcome.identityStatement, HIDDEN_IDENTITY_STATEMENT);
  assert.equal(outcome.identityLevel, 'configured');
});

test('a model prose claim never raises the identity level', () => {
  const selection = selectionFor(fixedRoute());
  const outcome = applyHostResolution(selection, {
    source: 'explicit_route',
    attemptedModelId: 'fixture-cloud/fixture-model-a',
    proseClaimedModelId: 'fixture-cloud/fixture-model-a',
  });
  assert.equal(outcome.outcome, 'accepted');
  // No structured reported identity was supplied, so the level stays at the
  // selection's configured level even though the prose claimed the model.
  assert.equal(outcome.identityLevel, 'configured');
  assert.ok(outcome.events.some((e) => e.type === 'prose_identity_claim_ignored'));
});

// ---------------------------------------------------------------------------
// Selection snapshot completeness (build step 2)
// ---------------------------------------------------------------------------

test('the selection snapshot persists route, alias, reasoning, fallback, account, and capability facts', () => {
  const selection = selectionFor(fixedRoute(), {
    reasoningPreference: 'medium',
    providerAccountRef: 'fixture-account-override',
  });
  const payload = selectionClientPayload(selection);
  assert.equal(payload.requestedRoute, 'fixture-cloud/fixture-model-a');
  assert.equal(payload.requestedModelOrAlias, 'fixture-cloud/fixture-model-a');
  assert.equal(payload.reasoning.applied, 'medium');
  assert.equal(payload.fallbackPolicy, 'none');
  assert.equal(payload.providerAccountRef, 'fixture-account-override');
  assert.equal(payload.capability.contextWindowTokens, 128000);
  assert.equal(payload.credential.state, 'present');
  assert.equal(payload.credential.envVar, 'FIXTURE_CLOUD_API_KEY');
  assert.equal('value' in payload.credential, false);
});
