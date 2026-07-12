/**
 * Global setup for the P2-03 create-task E2E: reset the throwaway fixture
 * (fresh DB, interview pre-completed) before the server + tests start.
 */

import { resetFixture } from './create-task.fixture';

export default async function globalSetup(): Promise<void> {
  resetFixture();
}
