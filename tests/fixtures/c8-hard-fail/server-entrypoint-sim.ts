/**
 * server-entrypoint-sim.ts — stands in for src/instrumentation.ts's boot
 * sequence, minus everything that isn't the DB-resolution question.
 *
 * Sets the SAME marker src/instrumentation.ts sets, in the SAME order
 * (synchronously, before the dynamic `@/lib/db` import), then opens the
 * database and reports the resolved path + a live open/write/read round
 * trip so the parent test can assert the server path is genuinely
 * unaffected by the C8 hard-isolation guard.
 *
 * Deliberately excluded from the c8-db-isolation-guard.test.ts scan by
 * living under tests/fixtures/ (that scanner skips any `fixtures` dir) —
 * this file intentionally does NOT set DATABASE_PATH, because proving the
 * marker-only path is the whole point.
 */
(globalThis as unknown as { __CC_SERVER_ENTRYPOINT__?: boolean }).__CC_SERVER_ENTRYPOINT__ = true;

async function main() {
  const dbmod = await import('../../../src/lib/db');
  console.log('DB_PATH=' + dbmod.getDbPath());
  // Prove it isn't just a string — the server path actually opens/migrates.
  const handle = dbmod.getDb();
  handle.exec("CREATE TABLE IF NOT EXISTS c8_probe (id INTEGER PRIMARY KEY, val TEXT)");
  handle.prepare('INSERT INTO c8_probe (val) VALUES (?)').run('server-path-ok');
  const row = handle.prepare('SELECT val FROM c8_probe ORDER BY id DESC LIMIT 1').get() as { val: string };
  console.log('PROBE_ROW=' + row.val);
  dbmod.closeDb();
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.stack || err.message : err));
  process.exit(1);
});
