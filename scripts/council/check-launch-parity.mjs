#!/usr/bin/env node
/**
 * CTR-191 launch-parity regression check (static, no browser, no network).
 *
 * Encodes the ONE launch contract every Council entry point must satisfy:
 * `/council` serves the SAME canonical chamber bundle the OpenClaw and
 * claude-nine entry opens (`public/chamber`, synced verbatim from the active
 * council runtime release and pinned by PROVENANCE.json), and that bundle
 * reads this app's own authorized managed store through a thin adapter. It
 * fails if `/council` goes back to a second renderer, if the served bundle
 * drifts from its pinned digests, or if the adapter stops supplying the
 * fields the canonical renderer folds.
 *
 * Trevor owns functional testing. This check reads source only; it is not
 * proof of a rendered screen.
 *
 *   node scripts/council/check-launch-parity.mjs
 *   exit 0 = contract holds, 1 = a contract clause is broken
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
};

// 1. /council opens the CANONICAL chamber bundle — the same screen the
//    OpenClaw and claude-nine entry opens — not a second renderer that
//    imitates it. The rewrite, not a redirect, keeps the URL.
const nextConfig = read('next.config.mjs');
check(
  '/council rewrites to the canonical chamber document',
  /source:\s*'\/council'[\s\S]*?destination:\s*'\/chamber\/index\.html'/.test(nextConfig),
);
check(
  'the canonical session read is rerouted for JSON only',
  /source:\s*'\/council\/:sessionId'[\s\S]*?application\/json[\s\S]*?destination:\s*'\/api\/council\/chamber-sessions\/:sessionId'/.test(
    nextConfig,
  ),
);
check(
  '/council is not a redirect',
  !/redirect:\s*\{[\s\S]*?source:\s*'\/council'/.test(nextConfig),
);

// 2. The served bundle is the canonical artifact: its index loads only files
//    that ship beside it, and PROVENANCE.json pins every file's digest.
const chamberIndex = read('public/chamber/index.html');
const assetRefs = [...chamberIndex.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
check('canonical chamber index loads its own assets', assetRefs.length >= 15);
for (const asset of assetRefs) {
  check(`canonical asset present: ${asset}`, existsSync(join(ROOT, 'public/chamber', asset)));
}

const provenance = JSON.parse(read('public/chamber/PROVENANCE.json'));
check('provenance pins a release', typeof provenance.releaseId === 'string' && provenance.releaseId.length > 0);
for (const [rel, digest] of Object.entries(provenance.files)) {
  check(
    `provenance digest matches: ${rel}`,
    sha256File(join(ROOT, 'public/chamber', rel)) === digest,
  );
}

// 3. The adapter serves this app's own managed records, and reads the fields
//    the canonical renderer folds: spec, brief, state, cards, verdict.
const adapter = read('src/app/api/council/chamber-sessions/[sessionId]/route.ts');
for (const field of ['spec', 'brief', 'state', 'cards', 'verdict']) {
  check(`adapter serves ${field}`, new RegExp(`${field}:`).test(adapter));
}
check('adapter uses the authorized session read', /authorizeSessionRead\(/.test(adapter));
check('adapter reads the caller scope', /checkBodyScope\(/.test(adapter));

// 4. Contract fields the canonical renderer reads that this app must supply.
const sessionsRoute = read('src/app/api/council/sessions/route.ts');
check('session list carries the question', /question:\s*row\.question/.test(sessionsRoute));
const eventStream = read('src/lib/council/events/stream.ts');
check('committed frames carry created_at', /created_at:\s*event\.occurred_at/.test(eventStream));

// 5. Managed ownership: the Command Center never forwards a session into the
//    standalone council service.
const home = read('src/components/council/CouncilHome.tsx');
for (const source of [home, adapter, nextConfig]) {
  check(
    'no standalone council origin in the entry',
    !/trevor-council\.zerohumanworkforce\.com|127\.0\.0\.1:8787|:8787/.test(source),
  );
}

// 6. Managed ownership: the Command Center never forwards a session into the
//    standalone council service.
check(
  'no standalone council origin in the entry',
  !/trevor-council\.zerohumanworkforce\.com|:8787/.test(home),
);

if (failures.length > 0) {
  process.stderr.write(`CTR-191 launch parity: FAIL (${failures.length})\n`);
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}

process.stdout.write('CTR-191 launch parity: contract holds (static source check only).\n');
