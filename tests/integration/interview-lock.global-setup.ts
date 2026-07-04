/**
 * Global setup for the interview-lock E2E: seed the throwaway fixture workspace
 * in the LOCKED (interview-incomplete) state before the server + tests start, so
 * the very first navigation in the suite is gated. The spec flips it to complete
 * inside the unlock test and restores it afterward.
 */

import { ensureWorkspace, writeBuildState } from './interview-lock.fixture';

export default async function globalSetup(): Promise<void> {
  ensureWorkspace();
  writeBuildState(false); // start locked / interview incomplete
}
