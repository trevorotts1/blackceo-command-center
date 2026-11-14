/**
 * state-identity.test.ts — BU-107.
 *
 * Proves `stampStateIdentity` writes the three identity stamps through the
 * Skill-23 state module (`workforce_state.update`, which holds the write lock),
 * never through a bare read-modify-write, and still refuses a state that
 * already carries a DIFFERENT company stamp.
 *
 * The real `workforce_state.py` is required: point the test at a checked-out
 * onboarding tree's `23-ai-workforce-blueprint/scripts` folder with
 * `AIWF_ONBOARDING_SKILL23_SCRIPTS`. Without it these tests are skipped, not
 * passed — a skip means the fixture path was not supplied.
 *
 *   AIWF_ONBOARDING_SKILL23_SCRIPTS=<onboarding>/23-ai-workforce-blueprint/scripts \
 *     npx vitest run src/lib/interview/__tests__/state-identity.test.ts
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stampStateIdentity, type StateIdentityContext } from '@/lib/interview/state-identity';

const onboardingScripts = process.env.AIWF_ONBOARDING_SKILL23_SCRIPTS;

const CONTEXT: StateIdentityContext = {
  companyId: 'co-bu107',
  installationId: 'in-bu107',
  tenantId: 'te-bu107',
};

const stateBytes = (state: Record<string, unknown>): string =>
  `${JSON.stringify(state, null, 2)}\n`;

describe.skipIf(!onboardingScripts)('stampStateIdentity (BU-107)', () => {
  let root: string;
  let workspace: string;
  let statePath: string;
  const savedWorkspaceRoot = process.env.OPENCLAW_WORKSPACE_ROOT;
  const savedScripts = process.env.OPENCLAW_SKILL23_SCRIPTS;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'bu107-identity-'));
    workspace = path.join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    statePath = path.join(workspace, '.workforce-build-state.json');
    process.env.OPENCLAW_WORKSPACE_ROOT = workspace;
    process.env.OPENCLAW_SKILL23_SCRIPTS = onboardingScripts;
  });

  afterEach(() => {
    if (savedWorkspaceRoot === undefined) delete process.env.OPENCLAW_WORKSPACE_ROOT;
    else process.env.OPENCLAW_WORKSPACE_ROOT = savedWorkspaceRoot;
    if (savedScripts === undefined) delete process.env.OPENCLAW_SKILL23_SCRIPTS;
    else process.env.OPENCLAW_SKILL23_SCRIPTS = savedScripts;
    rmSync(root, { recursive: true, force: true });
  });

  it('stamps all three identities and keeps interviewComplete', () => {
    writeFileSync(statePath, stateBytes({ interviewComplete: true }));

    expect(stampStateIdentity(CONTEXT)).toBe(true);

    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    expect(state.companyId).toBe(CONTEXT.companyId);
    expect(state.installationId).toBe(CONTEXT.installationId);
    expect(state.tenantId).toBe(CONTEXT.tenantId);
    expect(state.interviewComplete).toBe(true);
  });

  it('refuses a state stamped for a different company and changes no bytes', () => {
    const before = stateBytes({ interviewComplete: true, companyId: 'co-foreign' });
    writeFileSync(statePath, before);

    expect(stampStateIdentity(CONTEXT)).toBe(false);
    expect(readFileSync(statePath, 'utf-8')).toBe(before);
  });

  it('returns false and changes no bytes when the scripts folder does not exist', () => {
    process.env.OPENCLAW_SKILL23_SCRIPTS = path.join(root, 'no-such-scripts');
    const before = stateBytes({ interviewComplete: true });
    writeFileSync(statePath, before);

    expect(stampStateIdentity(CONTEXT)).toBe(false);
    expect(readFileSync(statePath, 'utf-8')).toBe(before);
  });
});
