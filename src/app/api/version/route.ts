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
 * fix-45: the endpoint used to read the checkout only, so a checkout that
 * moved under an older running build advertised the newer number and the
 * drift became invisible. The response now labels two values:
 *   - `buildVersion`    — recorded once when this build's process loaded,
 *                         immune to the checkout moving underneath it;
 *   - `checkoutVersion` — read live from disk on every request (what the
 *                         checkout says right now).
 * They differ exactly when the checkout has moved since the running build.
 * `version` stays a legacy alias of `checkoutVersion` for the footer chip.
 *
 * Never throws: a missing/unreadable version file degrades to a 200 with
 * nulls rather than a 500, so this diagnostic endpoint can never itself become
 * a source of dashboard breakage.
 */

type VersionRead = { version: string | null; error?: string };

/** Reads the repo-root `version` file. Never throws. */
function readCheckoutVersion(): VersionRead {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'version'), 'utf-8').trim();
    if (!raw) return { version: null, error: 'version file is empty' };
    return { version: raw };
  } catch (error) {
    return { version: null, error: error instanceof Error ? error.message : 'unknown error' };
  }
}

/**
 * Build-recorded revision, captured at module load (server start from the
 * built bundle) and never re-read, so it cannot follow a checkout that moves.
 *
 * ponytail: a process-start record, not git-verified build provenance — a
 * `git pull` landing between `next build` and `next start` still moves it.
 * Upgrade path: stamp the revision at build time via next.config `env` and
 * read that here.
 */
const BUILD_VERSION_RECORD = readCheckoutVersion();

export async function GET() {
  const checkout = readCheckoutVersion();
  const error = checkout.error ?? BUILD_VERSION_RECORD.error;
  return NextResponse.json(
    {
      version: checkout.version, // legacy alias, live checkout value
      checkoutVersion: checkout.version,
      buildVersion: BUILD_VERSION_RECORD.version,
      ...(error ? { error } : {}),
    },
    { status: 200 },
  );
}
