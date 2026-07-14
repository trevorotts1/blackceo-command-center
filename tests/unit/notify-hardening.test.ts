/**
 * notify-hardening.test.ts — SAFETY-02 / -03 / -04 / -05.
 *
 * These are the gaps SAFETY-01 (the fail-closed test-runner gate, see
 * tests/unit/notify-no-send-in-tests.test.ts) does NOT close. SAFETY-01 stops a
 * TEST from sending. It does not stop:
 *
 *   - a test READING the live ~/.openclaw/openclaw.json and resolving a real chat
 *     id (the gate is the only thing standing between that and a send)   → SAFETY-02
 *   - PRODUCTION flooding the operator: notifySystem()'s operator rung had no
 *     dedup and no rate limit at all                                     → SAFETY-03
 *   - the undeliverable escalation relaying the FULL task payload 1:1 to the
 *     operator, forever, because his own box can never resolve an owner  → SAFETY-04
 *   - a BARE `npx tsx scripts/smoke-*.ts` run, which sets none of the test-runner
 *     env vars the gate keys on, and so is indistinguishable from prod   → SAFETY-05
 *
 * SAFETY-03 and SAFETY-04 are PRODUCTION defects. No env gate would have caught
 * them: on the operator's own box every owner notification is structurally
 * undeliverable, and each one became an un-deduped, un-rate-limited DM carrying the
 * whole task body.
 *
 * Run: node --import tsx --test tests/unit/notify-hardening.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const OPERATOR_ID = '5252140759'; // in the built-in DEFAULT_OPERATOR_CHAT_IDS

function makeBox(allowFrom: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hardening-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'openclaw.json'),
    JSON.stringify({ channels: { telegram: { allowFrom } } }),
    'utf8',
  );
  process.env.OPENCLAW_WORKSPACE_PATH = workspace;
  return workspace;
}

async function freshNotify() {
  const mod = await import(`../../src/lib/notify?u=${Math.random()}`);
  return mod as typeof import('../../src/lib/notify');
}

function cleanEnv(): void {
  delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
  delete process.env.OPENCLAW_OWNER_CHAT_ID;
  delete process.env.CC_OPERATOR_CHAT_ID;
  delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
  delete process.env.OPENCLAW_WORKSPACE_PATH;
  delete process.env.OPENCLAW_WORKSPACE_ROOT;
}

/**
 * Capture sends, using the SAFETY-01 pattern from notify-undeliverable-escalation:
 * the opt-in is coupled to the install of the execFile double, so a send can never
 * be permitted unless execFile is ALREADY a test double. Also resets the SAFETY-03
 * throttles, whose module-level state otherwise leaks between tests in this file.
 */
function captureSends(notify: typeof import('../../src/lib/notify')): {
  sends: Array<{ chatId: string; message: string }>;
  restore: () => void;
} {
  const sends: Array<{ chatId: string; message: string }> = [];
  const cp = require('child_process') as typeof import('child_process');
  const realExecFile = cp.execFile;
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
  notify.__resetNotifyThrottleForTests();
  // @ts-expect-error — test double
  cp.execFile = (_file: string, args: string[], _o: unknown, cb?: (e: unknown) => void) => {
    const t = args.indexOf('--target');
    const m = args.indexOf('--message');
    if (t !== -1 && m !== -1) sends.push({ chatId: args[t + 1], message: args[m + 1] });
    if (cb) cb(null);
    return { on: () => {}, unref: () => {} };
  };
  return {
    sends,
    restore: () => {
      // @ts-expect-error — restore
      cp.execFile = realExecFile;
      delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
      notify.__resetNotifyThrottleForTests();
    },
  };
}

// ─── SAFETY-02: a test cannot even SEE the live box ──────────────────────────
test('SAFETY-02: under a test env the resolver refuses the LIVE openclaw.json', async () => {
  cleanEnv();
  // NOTE: no OPENCLAW_WORKSPACE_PATH override at all. This previously fell through
  // to $HOME/.openclaw and read the operator's REAL config — which is how a test
  // resolved his true chat id. It must land in a tmp sandbox instead.
  const notify = await freshNotify();
  assert.equal(
    notify.resolveOwnerChatId(),
    null,
    'an un-sandboxed test must resolve NO owner chat id from the live box',
  );
  assert.equal(
    notify.resolveOperatorChatId(),
    null,
    'an un-sandboxed test must resolve NO operator chat id from the live box',
  );
});

// ─── SAFETY-04: the escalation survives; the verbatim relay does not ─────────
test('SAFETY-04: the undeliverable escalation carries a COUNT, never the task payload', async () => {
  cleanEnv();
  const workspace = makeBox([OPERATOR_ID]); // operator-only box => owner is always null
  const notify = await freshNotify();
  const cap = captureSends(notify);
  try {
    const SECRET = 'Draft the Q3 budget summary both-gates-inert-13';
    assert.equal(notify.resolveOwnerChatId(), null, 'precondition: operator box has no owner');

    notify.notifyOwner(SECRET);

    // It STILL escalates to the operator — MSG-07 is not reverted.
    assert.equal(cap.sends.length, 1, 'the undeliverable notification must still escalate');
    assert.equal(cap.sends[0].chatId, OPERATOR_ID, 'the escalation goes to the OPERATOR');

    // …but it must NOT carry the payload. That 1:1 relay is the flood.
    assert.ok(
      !cap.sends[0].message.includes(SECRET),
      'the escalation must NOT forward the task payload — the verbatim relay IS the bug',
    );
    assert.match(cap.sends[0].message, /undeliverable/i, 'it says plainly what happened');
    assert.match(cap.sends[0].message, /notification-failures\.jsonl/, 'it points at the log');

    // …and the durable JSONL keeps the FULL detail, unconditionally.
    const ledger = path.join(workspace, 'notification-failures.jsonl');
    const recs = fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; message: string });
    const owner = recs.find((r) => r.kind === 'owner_undeliverable');
    assert.ok(owner, 'the undeliverable owner alert is durably recorded');
    assert.equal(owner.message, SECRET, 'nothing is lost — the full payload is on disk');
  } finally {
    cap.restore();
  }
});

test('SAFETY-04: a burst of undeliverables produces ONE digest, not one DM each', async () => {
  cleanEnv();
  const workspace = makeBox([OPERATOR_ID]);
  const notify = await freshNotify();
  const cap = captureSends(notify);
  try {
    for (let i = 0; i < 12; i++) notify.notifyOwner(`task payload #${i}`);

    // The old code sent 12 DMs, each carrying a full task body. Now: one digest.
    assert.equal(cap.sends.length, 1, '12 undeliverables must collapse into ONE operator digest');
    for (let i = 0; i < 12; i++) {
      assert.ok(
        !cap.sends[0].message.includes(`task payload #${i}`),
        'the digest carries no payloads at all',
      );
    }

    // …while all 12 remain on disk in full.
    const ledger = path.join(workspace, 'notification-failures.jsonl');
    const owner = fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string })
      .filter((r) => r.kind === 'owner_undeliverable');
    assert.equal(owner.length, 12, 'every undeliverable is recorded — aggregation is not loss');
  } finally {
    cap.restore();
  }
});

// ─── SAFETY-03: dedup ────────────────────────────────────────────────────────
test('SAFETY-03: an identical operator alert is de-duplicated within the TTL', async () => {
  cleanEnv();
  makeBox([OPERATOR_ID]);
  const notify = await freshNotify();
  const cap = captureSends(notify);
  try {
    for (let i = 0; i < 5; i++) notify.notifySystem('gateway down: connection refused');
    assert.equal(cap.sends.length, 1, 'the same alert 5x must reach the operator ONCE');
  } finally {
    cap.restore();
  }
});

// ─── SAFETY-03: rate limit ───────────────────────────────────────────────────
test('SAFETY-03: an operator flood is capped and the overflow is recorded, not sent', async () => {
  cleanEnv();
  const workspace = makeBox([OPERATOR_ID]);
  const notify = await freshNotify();
  const cap = captureSends(notify);
  try {
    // 20 DISTINCT alerts (so dedup does not apply) inside one minute.
    for (let i = 0; i < 20; i++) notify.notifySystem(`distinct alert ${i}`);

    // The token bucket admits 5/min; the rest are collapsed, not delivered.
    assert.equal(cap.sends.length, 5, 'at most 5 operator DMs per minute');

    // Suppression is never data loss: the overflow is on disk, in full.
    const ledger = path.join(workspace, 'notification-failures.jsonl');
    const suppressed = fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { suppressed?: string })
      .filter((r) => r.suppressed === 'rate_limited');
    assert.equal(suppressed.length, 15, 'every rate-limited alert is still recorded in full');
  } finally {
    cap.restore();
  }
});

// ─── SAFETY-05: the smoke-script muzzle is CHECKED, not remembered ───────────
test('SAFETY-05: every smoke script that can reach notify.ts imports the muzzle', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const TARGET = path.join(ROOT, 'src/lib/notify.ts');
  const GUARD = path.join(ROOT, 'scripts/lib/no-outbound-sends.ts');

  const candidates = (base: string): string[] => {
    const out = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
    // Smoke scripts import compiled specifiers ('../src/.../route.js') that resolve
    // to .ts sources under tsx. Miss this and the walk silently finds nothing.
    if (base.endsWith('.js')) {
      const s = base.slice(0, -3);
      out.push(`${s}.ts`, `${s}.tsx`);
    }
    return out;
  };
  const resolveSpec = (spec: string, from: string): string | null => {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
    else return null;
    for (const c of candidates(base)) {
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch {
        /* not this candidate */
      }
    }
    return null;
  };
  // Three import FORMS, and all three matter:
  //   from '...'      static named/default import
  //   import('...')   dynamic import — how the smoke scripts pull in API routes
  //   import '...'    BARE side-effect import — which is exactly the form the
  //                   muzzle itself uses. Omit this alternative and the check
  //                   silently never sees the guard, so it fails every script it
  //                   is meant to certify.
  const importsOf = (f: string): string[] =>
    [
      ...fs
        .readFileSync(f, 'utf8')
        .matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g),
    ]
      .map((m) => resolveSpec(m[1], f))
      .filter((x): x is string => Boolean(x));
  const reaches = (entry: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const f = stack.pop() as string;
      if (seen.has(f)) continue;
      seen.add(f);
      if (f === target) return true;
      for (const i of importsOf(f)) if (!seen.has(i)) stack.push(i);
    }
    return false;
  };

  const smokes = fs
    .readdirSync(path.join(ROOT, 'scripts'))
    .filter((f) => /^smoke-.*\.ts$/.test(f))
    .map((f) => path.join(ROOT, 'scripts', f));

  assert.ok(smokes.length > 0, 'sanity: there are smoke scripts to check');
  assert.ok(fs.existsSync(GUARD), 'sanity: the muzzle module exists');

  const reaching = smokes.filter((s) => reaches(s, TARGET));
  assert.ok(
    reaching.length > 0,
    'sanity: the import walk works — at least one smoke script reaches notify.ts',
  );

  for (const s of reaching) {
    assert.ok(
      importsOf(s).includes(GUARD),
      `scripts/${path.basename(s)} can reach src/lib/notify.ts but does NOT import ` +
        `scripts/lib/no-outbound-sends.ts. A bare \`tsx\` run sets no test-runner env, so ` +
        `notify.ts CANNOT self-detect there — this script would send REAL Telegram messages ` +
        `to a human. Add \`import './lib/no-outbound-sends.js';\` as its FIRST import.`,
    );
  }
});
