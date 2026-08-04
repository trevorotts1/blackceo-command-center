/**
 * Global setup for the interview-lock E2E: seed the throwaway fixture workspace
 * in the LOCKED (interview-incomplete) state before the server + tests start, so
 * the very first navigation in the suite is gated. The spec flips it to complete
 * inside the unlock test and restores it afterward.
 *
 * STANDARD-FIRST (PHASE 6b): also seed the fixture company dir with the
 * chosen-departments artifact BEFORE the webServer boots, so the boot-time
 * workspace auto-seed (which reads departments.json via the fixture's
 * ZERO_HUMAN_COMPANY_DIR) has the artifact the standard-ready cases assert on.
 * writeDepartmentsJson is idempotent — the spec's standard-ready block re-writes
 * it defensively before each of its cases.
 */

import {
  ensureWorkspace,
  writeBuildState,
  writeDepartmentsJson,
} from './interview-lock.fixture';

export default async function globalSetup(): Promise<void> {
  ensureWorkspace();
  writeDepartmentsJson(); // standard-ready chosen artifact (idempotent)
  writeBuildState(false); // start locked / interview incomplete
}
