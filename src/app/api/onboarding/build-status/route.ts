import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { safeReaddirNames, safeReadFileUtf8 } from '@/lib/fs/safe-fs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Returns build progress for the active AI Workforce build.
 *
 * Reads from `[ZHC]/[active-company]/build-progress.json` written by the
 * build-workforce.py orchestration. Falls back to an idle response if no
 * active build exists.
 */
function findActiveBuildProgress(): any | null {
  const candidates: string[] = [];
  if (process.env.OPENCLAW_COMPANY_ROOT) {
    candidates.push(process.env.OPENCLAW_COMPANY_ROOT);
  }
  // Canonical ZHC company root that build-workforce.py writes to (via
  // shared-utils/detect_platform.get_openclaw_paths → master_files/
  // zero-human-company). Kept in sync with the producer so the page finds
  // build-progress.json even when OPENCLAW_COMPANY_ROOT is not exported.
  candidates.push('/data/openclaw-master-files/zero-human-company'); // VPS
  candidates.push(path.join(os.homedir(), 'Downloads', 'openclaw-master-files', 'zero-human-company')); // Mac
  if (fs.existsSync('/data/.openclaw/workspace/zero-human-company')) {
    candidates.push('/data/.openclaw/workspace/zero-human-company');
  }
  candidates.push(path.join(os.homedir(), 'clawd', 'zero-human-company'));
  candidates.push(path.join(os.homedir(), '.openclaw', 'workspace', 'zero-human-company'));

  for (const root of candidates) {
    // safeReaddirNames / safeReadFileUtf8 never block this request thread on a
    // TCC-gated root (~/Downloads is a candidate): a raw opendir/open there
    // would hang the whole Node process forever. Absent/blocked → [] / null.
    for (const entry of safeReaddirNames(root)) {
      const progressFile = path.join(root, entry, 'build-progress.json');
      const raw = safeReadFileUtf8(progressFile);
      if (raw == null) continue;
      try {
        return JSON.parse(raw);
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function GET() {
  const progress = findActiveBuildProgress();
  if (progress) {
    return NextResponse.json(progress);
  }
  return NextResponse.json({
    stage: 'idle',
    message: 'No active build found',
    documents_total: 0,
    documents_complete: 0,
    departments: [],
    eta_minutes: 0,
  });
}
