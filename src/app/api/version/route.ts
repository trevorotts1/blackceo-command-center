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
 *   - `buildVersion`    — recorded once when this build's route module first
 *                         loaded, immune to the checkout moving underneath it;
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
 * Build-recorded revision, captured the first time this module is evaluated
 * and never re-read, so it cannot follow a checkout that moves under the
 * running process.
 *
 * ponytail: a first-load record, not git-verified build provenance — a
 * `git pull` landing before evaluation moves it, whether evaluation happens
 * at `next start` or lazily on the route's first request (module-evaluation
 * timing for `force-dynamic` routes is not observed here, only inferred).
 * Upgrade path: stamp the revision at build time via next.config `env` and
 * read that here.
 */
const BUILD_VERSION_RECORD = readCheckoutVersion();

export async function GET() {
  const checkout = readCheckoutVersion();
  // Both reads report: a degraded read whose cause got swallowed would leave a
  // null field unexplained in an endpoint that exists to explain drift.
  const error = [checkout.error, BUILD_VERSION_RECORD.error].filter(Boolean).join('; ') || undefined;
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
