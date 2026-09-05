import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db';
import type Database from 'better-sqlite3';

interface JobContext { name: string; owner: string; signal: AbortSignal; db: Database.Database }
const context = new AsyncLocalStorage<JobContext>();
const active = new Set<string>();
export function throwIfJobLeaseLost(): void {
 const job = context.getStore();
 if (!job) return;
 if (job.signal.aborted || !job.db.prepare('SELECT 1 FROM scheduler_leases WHERE job_name=? AND owner=? AND expires_at>?')
   .get(job.name,job.owner,new Date().toISOString())) throw new Error('scheduler_lease_lost');
}
/** A timed-out body keeps its local non-overlap lock until it actually settles.
 * Durable expiry allows another process to recover; late mutation boundaries
 * must call throwIfJobLeaseLost (dispatch, intake and reconciliation do so). */
export async function runLeasedJob<T>(name: string, fn: () => Promise<T> | T,
 timeoutMs = 90_000, db = getDb()): Promise<{ skipped: boolean; result?: T }> {
 if (active.has(name)) return { skipped: true };
 const owner = randomUUID();
 const now = new Date().toISOString();
 const lease = db.prepare(`INSERT INTO scheduler_leases(job_name,owner,expires_at,updated_at) VALUES(?,?,?,?)
 ON CONFLICT(job_name) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at,updated_at=excluded.updated_at
 WHERE scheduler_leases.expires_at <= excluded.updated_at`)
 .run(name,owner,new Date(Date.now()+timeoutMs).toISOString(),now);
 if (lease.changes !== 1) return { skipped: true };
 active.add(name);
 const abort = new AbortController();
 let timer: ReturnType<typeof setTimeout> | undefined;
 const body = context.run({name,owner,signal:abort.signal,db}, () => Promise.resolve().then(fn));
 const release = () => {
  active.delete(name);
  db.prepare('DELETE FROM scheduler_leases WHERE job_name=? AND owner=?').run(name,owner);
 };
 // Keep a rejection handler on the underlying body after a timeout.
 void body.then(release,release).catch(() => {});
 try {
  const result = await Promise.race([body,new Promise<never>((_,reject) => {
   timer=setTimeout(() => { abort.abort(); reject(new Error('scheduler_job_timeout')); },timeoutMs);
  })]);
  return { skipped: false, result };
 } finally { if (timer) clearTimeout(timer); }
}
