/**
 * plain-script-sim.ts — stands in for an ordinary maintenance/test script run
 * bare from the app directory: no DATABASE_PATH, no server marker, nothing.
 *
 * This is the EXACT shape of the historical C8 leak (a script that reaches
 * `@/lib/db` without isolating first). The import below is a plain, hoisted,
 * STATIC import — matching how real offending scripts looked before this fix
 * — so it must fail at module-evaluation time, before `main()` ever runs.
 *
 * Deliberately excluded from the c8-db-isolation-guard.test.ts scan by living
 * under tests/fixtures/ — this file intentionally has NO isolation, because
 * proving the un-isolated case hard-fails is the whole point.
 */
import { DB_PATH } from '../../../src/lib/db';

console.log('UNEXPECTED SUCCESS: resolved DB_PATH=' + DB_PATH);
