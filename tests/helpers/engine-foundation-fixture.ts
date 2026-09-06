/** Cross-repository fixture. Only operates on the explicitly provided test DB. */
import Database from 'better-sqlite3';
import { schema } from '../../src/lib/db/schema';
import { runMigrations, reseedWorkspacesFromConfig } from '../../src/lib/db/migrations';
const dbPath = process.env.DATABASE_PATH;
if (!dbPath || !dbPath.endsWith('.test.db')) throw new Error('Explicit isolated .test.db required');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
if (process.argv[2] === 'init') db.exec(schema);
runMigrations(db);
if (process.argv[2] === 'converge') {
  const one = reseedWorkspacesFromConfig(db, { force: true });
  const two = reseedWorkspacesFromConfig(db, { force: true });
  if (one.outcome !== 'seeded' || two.outcome !== 'seeded') throw new Error(JSON.stringify({ one, two }));
}
if (db.pragma('foreign_key_check').length) throw new Error('Dangling foreign keys');
db.close();
