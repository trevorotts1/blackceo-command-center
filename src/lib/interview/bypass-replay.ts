/**
 * Interview-bypass replay guard (MR-17 fix2).
 *
 * WHY THIS EXISTS:
 *   The U057 "Skip for now" bypass token (`signInterviewBypassToken` in
 *   gate-cookie.ts) is an HMAC-signed `{exp}` blob with a 1-hour TTL. A signed
 *   token proves the SERVER minted it and that it has not expired — but it does
 *   NOT bind the token to a single presentation. A captured token (a URL copied
 *   from a browser history / proxy log / the `?bypass_interview=` query param,
 *   or a lifted cookie) is therefore REPLAYABLE by anyone for its whole 1-hour
 *   window: the signature stays valid on every re-presentation. Haiku flagged
 *   exactly this ("Bypass token in URL replayable 1h no nonce").
 *
 * THE FIX — nonce + revocation:
 *   Each bypass token now carries a random `nonce` (see gate-cookie.ts). This
 *   module keeps a process-local ledger of every nonce it has seen and whether
 *   it has been consumed:
 *     • `recordBypassNonce(nonce, exp)`  — the minter registers a fresh nonce.
 *     • `consumeBypassNonce(nonce, exp)` — the verifier consumes it ONCE.
 *   A nonce is single-use: the FIRST valid presentation consumes it and every
 *   subsequent presentation (a replay) is refused. That closes the replay
 *   window — a stolen token works zero extra times against the process that
 *   issued it, and at most once anywhere.
 *
 * EDGE-SAFETY (critical — mirror gate-cookie.ts):
 *   src/middleware.ts runs in the EDGE runtime and imports this module, so it
 *   must import NOTHING Node-only (no `fs`, no `node:crypto`, no better-sqlite3,
 *   no seam.ts). It uses only Web-standard globals (globalThis.crypto.getRandomValues)
 *   plus a module-scope Map, all of which exist in BOTH the Edge middleware
 *   runtime and the Node server runtime. A single Node import here would break
 *   the Edge build.
 *
 * HONEST SCOPE — process-local, not distributed:
 *   The ledger is a module-scope Map, i.e. PER-PROCESS. This is the strongest
 *   revocation the Edge runtime allows (Edge has no fs / DB / shared cache).
 *   Concretely:
 *     • The Node minter (the `skipInterviewForNow` server action) and the Edge
 *       middleware run in the SAME single-process `next start` box this product
 *       ships, so a nonce minted by the server action is consumed by the
 *       middleware — single-use holds end to end.
 *     • A token hand-constructed by an operator (the documented
 *       `?bypass_interview=` admin escape hatch) carries a nonce the process
 *       never minted; an unrecognised nonce is admitted ONCE and then marked
 *       consumed, so even an operator-crafted URL cannot be replayed against
 *       the same box.
 *     • Across a multi-replica deployment the ledger is not shared, so a token
 *       replays once per replica. Full cross-replica revocation needs a shared
 *       store the Edge runtime cannot reach; that is out of scope here.
 *   The ledger self-prunes expired nonces (bounded memory) and is capped so a
 *   flood of junk nonces cannot grow it without bound.
 */

/**
 * Hard cap on retained nonce entries. A flood of junk (forged) nonces cannot
 * grow the ledger without bound; once the cap is reached we evict the
 * soonest-expiring entries first (they are the least useful to keep). A legit
 * bypass nonce lives at most BYPASS_TTL_SECONDS (1h), so under normal use the
 * ledger is tiny and the cap is never approached.
 */
const MAX_NONCES = 10_000;

interface NonceEntry {
  /** unix-seconds expiry of the token this nonce rode in. */
  exp: number;
  /** true once a verifier has accepted this nonce (single-use latch). */
  consumed: boolean;
}

/** nonce (random string) → ledger entry. */
const nonces = new Map<string, NonceEntry>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Drop every nonce whose expiry has passed. Cheap; keeps the map bounded. */
function pruneExpired(): void {
  const now = nowSeconds();
  const expired: string[] = [];
  nonces.forEach((entry, nonce) => {
    if (entry.exp < now) expired.push(nonce);
  });
  for (let i = 0; i < expired.length; i++) nonces.delete(expired[i]);
}

/** Evict soonest-expiring entries until back at/under the cap. */
function enforceCap(): void {
  if (nonces.size <= MAX_NONCES) return;
  const ordered: Array<[string, number]> = [];
  nonces.forEach((entry, nonce) => {
    ordered.push([nonce, entry.exp]);
  });
  ordered.sort((a, b) => a[1] - b[1]);
  const excess = nonces.size - MAX_NONCES;
  for (let i = 0; i < excess; i++) nonces.delete(ordered[i][0]);
}

/**
 * Generate a cryptographically-random nonce for a fresh bypass token.
 * Edge-safe: uses globalThis.crypto.getRandomValues (present in both the Edge
 * middleware runtime and Node), never `node:crypto`.
 */
export function generateBypassNonce(): string {
  const bytes = new Uint8Array(16); // 128 bits of randomness
  globalThis.crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Register a freshly-minted nonce as live (unconsumed). Called by the minter
 * (signInterviewBypassToken) so the verifier can later consume it. A repeated
 * nonce simply resets to unconsumed (re-mint is harmless). Bounded by MAX_NONCES.
 */
export function recordBypassNonce(nonce: string, exp: number): void {
  if (!nonce || typeof nonce !== 'string') return;
  pruneExpired();
  nonces.set(nonce, { exp, consumed: false });
  enforceCap();
}

/**
 * Single-use nonce check for the verifier. Returns true EXACTLY ONCE per nonce:
 *   • a live, unexpired, previously-recorded, unconsumed nonce → consumed,
 *     returns true; every later call for that nonce returns false (replay);
 *   • an already-consumed nonce → refused (false) — this is the replay block;
 *   • an expired nonce → refused (false);
 *   • an unrecognised nonce (operator hand-crafted the token, or a multi-replica
 *     box minted it elsewhere) → admitted ONCE and recorded as consumed, so it
 *     cannot be replayed against THIS process either.
 * The "admit-once-then-consume" rule for unrecognised nonces preserves the
 * documented admin escape hatch while still killing its replayability.
 */
export function consumeBypassNonce(nonce: string, exp: number): boolean {
  if (!nonce || typeof nonce !== 'string') return false;
  const now = nowSeconds();
  if (exp < now) return false; // expired → refuse
  const entry = nonces.get(nonce);
  if (entry) {
    if (entry.consumed) return false; // already used → replay refused
    entry.consumed = true; // consume the single use
    return true;
  }
  // Unrecognised but well-formed and unexpired: admit once, then record it as
  // consumed so a replay against this process is refused.
  nonces.set(nonce, { exp, consumed: true });
  enforceCap();
  return true;
}

/**
 * Test-only: reset the ledger so suites start from a clean slate. Not part of
 * the runtime contract — production never calls this.
 */
export function __resetBypassNoncesForTest(): void {
  nonces.clear();
}
