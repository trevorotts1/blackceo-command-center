import Database from 'better-sqlite3';

const DB_PATH = process.env.DATABASE_PATH;

console.log(`[dryrun] Opening database: ${DB_PATH}`);
const db = new Database(DB_PATH);
console.log(`[dryrun] DB opened, migration count before: ${db.prepare('SELECT count(*) c FROM _migrations').get().c}`);

// Import the TypeScript module via tsx's register
const { runMigrations } = await import('./src/lib/db/migrations.ts');
console.log('[dryrun] runMigrations loaded, executing...');
runMigrations(db);
console.log(`[dryrun] Done. migration count after: ${db.prepare('SELECT count(*) c FROM _migrations').get().c}`);
db.close();
