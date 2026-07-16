/**
 * plain-script-sim.ts — stands in for an ordinary maintenance/test script run
 * bare from the app directory: no DATABASE_PATH, no server marker, nothing.
 *
 * This is the EXACT shape of the historical C8 leak (a script that reaches
 * `@/lib/db` without isolating first). The import below is a plain, hoisted,
 * STATIC import — matching how real offending scripts looked before this fix.
 *
 * Under C8 LAZY resolution the import itself now succeeds (that is what makes
 * `next build` able to collect page data at all); the guard fires on the FIRST
 * USE instead. So this fixture must actually CALL getDbPath() to stand in for
 * the historical leak — and it must still exit non-zero, print no success
 * marker, and leave no database file behind. Importing is not accessing.
 *
 * Deliberately excluded from the c8-db-isolation-guard.test.ts scan by living
 * under tests/fixtures/ — this file intentionally has NO isolation, because
 * proving the un-isolated case hard-fails is the whole point.
 */
import { getDbPath } from '../../../src/lib/db';

// getDbPath() throws INSIDE this expression, so console.log is never reached —
// the 'UNEXPECTED SUCCESS' marker the guard test greps for cannot be printed.
console.log('UNEXPECTED SUCCESS: resolved DB_PATH=' + getDbPath());
