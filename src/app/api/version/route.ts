import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/version
 *
 * P1-03 step 3 (dashboard / cards intermittent-load fix): a tiny route that
 * exposes the repo's canonical version string so the dashboard footer can
 * render a version stamp. This is the same `/version` file `scripts/
 * bump-version.sh` treats as the source of truth for the CC repo (kept in
 * lockstep with package.json / package-lock.json by that script) — read here
 * rather than duplicated, so this route can never drift from the file the
 * bump script writes.
 *
 * Root-cause context (P1-03 class 1, "build-generation drift"): different
 * boxes can be serving different deployed generations of the same repo at
 * the same moment (stale `.next`, a box that hasn't picked up the latest
 * `git pull`, etc). Exposing the version makes that instantly diagnosable —
 * "you're on v5.14.0, current is v5.17.0" — instead of a silent mystery.
 *
 * Never throws: a missing/unreadable version file degrades to a 200 with
 * version: null rather than a 500, so this diagnostic endpoint can never
 * itself become a source of dashboard breakage.
 */
export async function GET() {
  try {
    const versionFilePath = path.join(process.cwd(), 'version');
    const raw = fs.readFileSync(versionFilePath, 'utf-8').trim();
    if (!raw) {
      return NextResponse.json({ version: null, error: 'version file is empty' }, { status: 200 });
    }
    return NextResponse.json({ version: raw });
  } catch (error) {
    return NextResponse.json(
      { version: null, error: error instanceof Error ? error.message : 'unknown error' },
      { status: 200 },
    );
  }
}
