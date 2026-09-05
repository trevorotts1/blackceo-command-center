import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import os from 'node:os';
import { safeReadFileUtf8 } from '@/lib/fs/safe-fs';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { readBuildState } from '@/lib/interview/seam';
import { verifiedBuild, verifiedCommandCenter } from '@/lib/interview/build-verification';
import { queryOne } from '@/lib/db';
import { proxyTenantBoard } from '@/lib/tenant-board-proxy';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
const headers = { 'cache-control': 'private, no-store' };

export async function GET(request: NextRequest) {
  try {
    const context = await resolveTenantContext(request);
    if (context.kind === 'client') return proxyTenantBoard(request, ['onboarding', 'build-status']);
    const state = readBuildState() as Record<string, unknown> | null;
    if (!state) return NextResponse.json({ stage: 'idle', message: 'No active build has been recorded.', documents_total: 0, documents_complete: 0, departments: [], eta_minutes: 0 }, { headers });
    const company = queryOne<{slug:string}>('SELECT slug FROM companies WHERE id = ?', [context.companyId]);
    const slug = typeof state.companySlug === 'string' ? state.companySlug : company?.slug;
    if (!slug || !/^[a-z0-9][a-z0-9_-]*$/.test(slug) || (company && company.slug !== slug) ||
        (state.companyId && state.companyId !== context.companyId)) {
      return NextResponse.json({ error: 'build_company_mismatch', message: 'Build identity needs verification for this company.' }, { status: 409, headers });
    }
    if (typeof state.buildId !== 'string' || !state.buildId) {
      return NextResponse.json({ error: 'build_identity_missing', message: 'This build needs a current verification record. Ask your operator to resume validation.' }, { status: 409, headers });
    }
    const isComplete = verifiedBuild(state) && verifiedCommandCenter(state);
    const roots = [
      process.env.OPENCLAW_COMPANY_ROOT,
      '/data/openclaw-master-files/zero-human-company',
      path.join(os.homedir(), 'Downloads', 'openclaw-master-files', 'zero-human-company'),
      path.join(os.homedir(), '.openclaw', 'workspace', 'zero-human-company'),
      path.join(os.homedir(), 'clawd', 'zero-human-company'),
    ].filter((root): root is string => !!root);
    const files = process.env.ZERO_HUMAN_COMPANY_DIR
      ? [path.join(process.env.ZERO_HUMAN_COMPANY_DIR, 'build-progress.json')]
      : roots.map(root => path.join(root, slug, 'build-progress.json'));
    for (const file of files) {
      const raw = safeReadFileUtf8(file);
      if (!raw) continue;
      let progress: Record<string, unknown>;
      try { progress = JSON.parse(raw); } catch { continue; }
      if (!progress || progress.company_slug !== slug || progress.build_id !== state.buildId) continue;
      const complete = isComplete;
      return NextResponse.json({ ...progress,
        stage: progress.stage === 'complete' && !complete ? 'validating' : progress.stage,
        company_id: context.companyId, company_slug: slug, build_id: state.buildId,
        completion_verified: complete,
        completion_verification: state.completionVerification,
      }, { headers });
    }
    return NextResponse.json({ stage: isComplete ? 'complete' : 'waiting',
      message: isComplete ? 'Your workforce build is verified.' : 'Waiting for current build progress from your installation.',
      company_id: context.companyId, company_slug: slug, build_id: state.buildId,
      completion_verified: isComplete, completion_verification: state.completionVerification,
      documents_total: 0, documents_complete: 0, departments: [], eta_minutes: 0,
    }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof TenantAccessError ? 'forbidden' : 'build_status_unavailable',
      message: 'Your build status could not be verified. Please retry.' },
      { status: error instanceof TenantAccessError ? 403 : 503, headers });
  }
}
