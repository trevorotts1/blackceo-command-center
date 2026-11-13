// @vitest-environment jsdom
/**
 * BU-104 — the building page tells the truth when nothing is moving.
 *
 * Two halves, both in this one file because this is the only test file the unit
 * names:
 *   1. the REAL GET handler of /api/onboarding/build-status, driven against a
 *      temp progress file under `state.companyRoot` — companyRoot searched
 *      FIRST, a sparse progress file defaulted to the keys the page requires,
 *      and `waiting_minutes` computed from `interviewCompletedAt`;
 *   2. the REAL building page rendered with @testing-library/react — a wait of
 *      120 minutes or more says "still being prepared" and hides the stage
 *      label, while a short wait still shows the stage label.
 *
 * Collaborators this unit does not own are stubbed (tenant identity, the
 * build-state seam, the db, next/navigation, global fetch) so no live database
 * and no live box are touched.
 *
 * Runs standalone: npx vitest run src/app/api/onboarding/build-status/__tests__/route.test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextRequest } from 'next/server';

const companyRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu104-company-'));
const state: Record<string, unknown> = {};

vi.mock('@/lib/auth/tenant-context', () => ({
  resolveTenantContext: async () => ({ kind: 'self', companyId: 'co-1' }),
  TenantAccessError: class TenantAccessError extends Error { status = 403; },
}));
vi.mock('@/lib/tenant-board-proxy', () => ({ proxyTenantBoard: async () => { throw new Error('unexpected tenant proxy'); } }));
vi.mock('@/lib/db', () => ({ queryOne: () => ({ slug: 'acme' }) }));
vi.mock('@/lib/interview/seam', () => ({ readBuildState: () => state }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/onboarding/building',
}));

const { GET } = await import('../route');
const { default: OnboardingBuildingPage } = await import('../../../../onboarding/building/page');

function request(): NextRequest {
  return new NextRequest('http://box.test/api/onboarding/build-status');
}

beforeEach(() => {
  for (const key of Object.keys(state)) delete state[key];
  vi.unstubAllEnvs();
  fs.rmSync(path.join(companyRootDir, 'build-progress.json'), { force: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(path.join(companyRootDir, 'build-progress.json'), { force: true });
});

describe('GET /api/onboarding/build-status', () => {
  it('defaults a sparse companyRoot progress file and reports the real wait', async () => {
    state.companySlug = 'acme';
    state.buildId = 'build-1';
    state.companyRoot = companyRootDir;
    state.interviewCompletedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(companyRootDir, 'build-progress.json'),
      JSON.stringify({ stage: 'qc', company_slug: 'acme', build_id: 'build-1' }));

    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.stage).toBe('qc');
    expect(body.departments).toEqual([]);
    expect(body.documents_total).toBe(0);
    expect(body.documents_complete).toBe(0);
    expect(body.eta_minutes).toBe(0);
    expect(body.message).toBe('');
    expect(body.waiting_minutes).toBeGreaterThanOrEqual(180);
  });

  it('still defaults the page keys when companyRoot is not an absolute path', async () => {
    state.companySlug = 'acme';
    state.buildId = 'build-1';
    state.companyRoot = 'relative/company';
    state.interviewCompletedAt = 'not-a-date';
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu104-empty-'));
    vi.stubEnv('ZERO_HUMAN_COMPANY_DIR', emptyDir);

    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.stage).toBe('waiting');
    expect(body.departments).toEqual([]);
    expect(body.documents_total).toBe(0);
    expect(body.waiting_minutes).toBeNull();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});

/** Serve one canned build-status payload to the page's poll. */
function stubStatus(payload: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
}

describe('building page', () => {
  const base = {
    stage: 'qc', completion_verified: false, message: 'Quality reviewing every document...',
    documents_total: 0, documents_complete: 0, departments: [], eta_minutes: 0,
  };

  it('states a long unmoving wait instead of a stage label', async () => {
    stubStatus({ ...base, waiting_minutes: 180 });
    render(<OnboardingBuildingPage />);

    expect(await screen.findByText(/still being prepared/)).toBeTruthy();
    expect(screen.queryByText(/Quality reviewing/)).toBeNull();
    expect(screen.queryByText('Overall progress')).toBeNull();
  });

  it('keeps the stage label for a short wait', async () => {
    stubStatus({ ...base, waiting_minutes: 5 });
    render(<OnboardingBuildingPage />);

    expect(await screen.findByText('Quality reviewing every document...')).toBeTruthy();
    expect(screen.queryByText(/still being prepared/)).toBeNull();
  });
});
