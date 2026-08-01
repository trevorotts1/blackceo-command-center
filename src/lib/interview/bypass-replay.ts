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
 * THE FIX — nonce + revocation, SPLIT BY SURFACE (read carefully):
 *   Each bypass token carries a random `nonce` (see gate-cookie.ts). This module
 *   keeps a process-local ledger of every nonce it has seen and whether it has
 *   been consumed. The two bypass SURFACES get different nonce semantics, because
 *   a persistent cookie CANNOT be single-use without breaking the feature:
 *
 *     • `?bypass_interview=` URL escape hatch → SINGLE-USE. The URL is the
 *       capture-prone surface Haiku named (it lands in browser history, proxy /
 *       access logs, Referer headers). `consumeBypassNonce` admits the FIRST
 *       valid presentation and refuses every replay, so a copied URL dies after
 *       one use. This is the replay window that was actually flagged, and it is
 *       the one that CAN be closed.
 *
 *     • `mc_interview_bypass` cookie → NON-CONSUMING, TTL-scoped. The browser
 *       resends the SAME httpOnly cookie on every navigation for the whole 1h
 *       session; if the verifier consumed the nonce on the first load, every
 *       later page load would bounce the operator back to /interview (a hard
 *       regression of U057 "Skip for now"). `checkBypassNonce` validates the
 *       nonce WITHOUT consuming it, so the cookie grants the full TTL session.
 *       The cookie is httpOnly + SameSite=lax and never appears in a URL, log,
 *       or Referer, so it is not the capture surface the finding targets; its
 *       residual is the ordinary one every session cookie carries (XSS theft),
 *       bounded by the 1h TTL.
 *
 *   Ledger operations:
 *     • `recordBypassNonce(nonce, exp)`  — the minter registers a fresh nonce.
 *     • `consumeBypassNonce(nonce, exp)` — URL verifier: admit-once, then latch.
 *     • `checkBypassNonce(nonce, exp)`   — cookie verifier: validate, no latch.
 *
 * EDGE-SAFETY (critical — mirror gate-cookie.ts):
 *   src/middleware.ts runs in the EDGE runtime and imports this module, so it
 *   must import NOTHING Node-only (no `fs`, no `node:crypto`, no better-sqlite3,
 *   no seam.ts). It uses only Web-standard globals (globalThis.crypto.getRandomValues)
 *   plus a module-scope Map, all of which exist in BOTH the Edge middleware
 *   runtime and the Node server runtime. A single Node import here would break
 *   the Edge build.
 *
 * HONEST SCOPE — process-local, and the Edge/Node realms are SEPARATE:
 *   The ledger is a module-scope Map. Next.js runs the Edge middleware in an
 *   ISOLATED VM context (next/dist/server/web/sandbox/context.js → vm.runInContext),
 *   so the middleware's copy of this module is a DIFFERENT realm from the Node
 *   server action that mints the cookie — their Maps do NOT share state (the
 *   middleware itself documents this: "module state does not cross that
 *   boundary", src/middleware.ts). Consequences, all handled by the design above:
 *     • A Node-minted cookie nonce is UNRECOGNISED in the middleware's ledger.
 *       `checkBypassNonce` therefore must NOT treat "unrecognised" as fatal —
 *       it validates any well-formed, unexpired nonce (the cookie path never
 *       relies on the ledger having recorded the nonce). This is what keeps the
 *       cookie feature working across the realm boundary.
 *     • The URL escape hatch is operator-hand-built and verified entirely within
 *       the middleware realm, so `consumeBypassNonce`'s admit-once-then-consume
 *       rule makes it single-use against the box. (A Node-minted token presented
 *       as a URL would be admitted once as an unrecognised nonce — acceptable:
 *       the URL surface is not how the minter is used, and it is still single-use.)
 *     • Across a multi-replica deployment the ledger is not shared, so a URL
 *       token replays once per replica. Full cross-replica revocation needs a
 *       shared store the Edge runtime cannot reach; out of scope here.
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
 * NON-consuming nonce check for the COOKIE verifier. Unlike consumeBypassNonce,
 * this does NOT latch the nonce, so the same cookie stays valid for its whole
 * TTL — required because the browser resends the identical httpOnly cookie on
 * every navigation of a "Skip for now" session (consuming it would bounce the
 * operator to /interview on the second page load).
 *
 * Returns true for any well-formed, unexpired nonce — whether or not this
 * process recorded it. That is deliberate and load-bearing: the cookie is minted
 * by a Node server action that lives in a DIFFERENT VM realm than the Edge
 * middleware (see the module docstring), so its nonce is normally UNRECOGNISED
 * here. Treating "unrecognised" as valid is what keeps the cookie feature working
 * across the realm boundary. The cookie's replay exposure is bounded by its 1h
 * TTL and by the fact that it is httpOnly + SameSite=lax and never rides in a
 * URL, log, or Referer — it is not the capture surface the MR-17 finding targets
 * (that is the `?bypass_interview=` URL, which uses consumeBypassNonce instead).
 *
 * An EXPIRED nonce is still refused (the TTL is the cookie's revocation bound).
 * A nonce this process has already CONSUMED via the URL path is also refused, so
 * a token burned as a one-time URL cannot then be laundered into a cookie grant.
 */
export function checkBypassNonce(nonce: string, exp: number): boolean {
  if (!nonce || typeof nonce !== 'string') return false;
  const now = nowSeconds();
  if (exp < now) return false; // expired → refuse (TTL is the revocation bound)
  const entry = nonces.get(nonce);
  if (entry && entry.consumed) return false; // burned as a URL → no cookie grant
  return true; // well-formed + unexpired (+ unconsumed) → valid for the session
}

/**
 * Test-only: reset the ledger so suites start from a clean slate. Not part of
 * the runtime contract — production never calls this.
 */
export function __resetBypassNoncesForTest(): void {
  nonces.clear();
}
