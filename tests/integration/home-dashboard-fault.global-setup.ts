/**
 * Global setup for the U43 (C/C-12) home-dashboard induced-failure E2E: reset
 * the throwaway fixture (fresh DB, interview pre-completed) before the server
 * + tests start.
 */

import { resetFixture } from './home-dashboard-fault.fixture';

export default async function globalSetup(): Promise<void> {
  resetFixture();
}
