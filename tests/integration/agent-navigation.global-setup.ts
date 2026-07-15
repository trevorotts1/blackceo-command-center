/**
 * Global setup for the U58 agent-navigation E2E: reset the throwaway fixture
 * (fresh DB, interview pre-completed) before the server + tests start.
 */

import { resetFixture } from './agent-navigation.fixture';

export default async function globalSetup(): Promise<void> {
  resetFixture();
}
