/**
 * Global setup for the P5-01 responsive-proof E2E: reset the throwaway
 * fixture (fresh DB, interview pre-completed) before the server + tests
 * start.
 */

import { resetFixture } from './my-ai-ceo-responsive.fixture';

export default async function globalSetup(): Promise<void> {
  resetFixture();
}
