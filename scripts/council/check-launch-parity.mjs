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

// 7. CTR-191 canonical New-question call contracts. The unchanged chamber
//    calls these exact paths and reads these exact top-level shapes; a CC
//    envelope wrapper would silently break the dialog.
const routesRoute = 'src/app/api/council/routes/route.ts';
check('routes endpoint exists', existsSync(join(ROOT, routesRoute)));
if (existsSync(join(ROOT, routesRoute))) {
  const src = read(routesRoute);
  check(
    'routes endpoint answers the canonical top-level shape',
    /NextResponse\.json\(\s*payload/.test(src) && /const payload = \{ routes, harness_defaults \}/.test(src),
  );
  check('routes endpoint never emits credential values', !/credential\s*:/.test(src));
}

const conveneRoute = 'src/app/api/council/convene/route.ts';
check('convene endpoint exists', existsSync(join(ROOT, conveneRoute)));
if (existsSync(join(ROOT, conveneRoute))) {
  const src = read(conveneRoute);
  check('convene requires the CSRF mutation proof', /requireMutationProof\(request\)/.test(src));
  check(
    'convene composes the existing owner approval flow',
    /previewRunAuthorization\(/.test(src) &&
      /approveRunAuthorization\(/.test(src) &&
      /startSessionRun\(/.test(src),
  );
  check(
    'convene approves only as the managed principal',
    /authority_mode:\s*'managed_principal'/.test(src),
  );
  check(
    'convene never accepts a caller route snapshot',
    !/body\.route_snapshot|body\.authority_mode|body\.ceilings|body\.grant_id/.test(src),
  );
  const allowlist = src.slice(
    src.indexOf('const TOP_LEVEL_FIELDS'),
    src.indexOf('] as const', src.indexOf('const TOP_LEVEL_FIELDS')),
  );
  check(
    'convene body allowlist excludes caller authority',
    !/route_snapshot|authority_mode|ceilings|signature|grant_id/.test(allowlist),
  );
  check(
    'convene returns the canonical 202 session id before work',
    /status:\s*202/.test(src) && /session_id:\s*sessionId/.test(src),
  );
  check(
    'convene hands the durable job to the existing run worker without awaiting it',
    /void import\('@\/lib\/council\/engine'\)/.test(src) &&
      /drainCouncilRunsOnce\(\)/.test(src),
  );
  check(
    'convene answers canonical top-level errors with recovery',
    /code:\s*translated\.code/.test(src) && /recovery:\s*recoveryFor/.test(src),
  );
}

check(
  'canonical report PDF download is rerouted',
  /source:\s*'\/council\/:sessionId\/report\.pdf'[\s\S]*?destination:\s*'\/api\/council\/chamber-sessions\/:sessionId\/report\.pdf'/.test(
    nextConfig,
  ),
);
const reportRoute = 'src/app/api/council/chamber-sessions/[sessionId]/report.pdf/route.ts';
check('canonical report PDF route exists', existsSync(join(ROOT, reportRoute)));
if (existsSync(join(ROOT, reportRoute))) {
  const src = read(reportRoute);
  check('report PDF uses the authorized session read', /authorizeSessionRead\(/.test(src));
  check('report PDF serves application/pdf bytes', /renderSessionReportPdf\(/.test(src));
}

check(
  'the chamber adapter answers the canonical top-level session shape',
  /const payload = \{[\s\S]*?session:/.test(adapter) &&
    /NextResponse\.json\(\s*payload/.test(adapter) &&
    !/respondOk\(/.test(adapter),
);
check(
  'the session list carries the canonical top-level fields',
  /\.\.\.data,/.test(sessionsRoute),
);

const statusPage = 'src/app/status/page.tsx';
check('canonical /status page exists', existsSync(join(ROOT, statusPage)));
if (existsSync(join(ROOT, statusPage))) {
  const src = read(statusPage);
  check(
    'status page reads the existing protected status endpoint',
    /fetch\('\/api\/system\/status'/.test(src),
  );
  check(
    'status page states a blocked dependency instead of a healthy default',
    /STATUS_METADATA_UNAVAILABLE/.test(src) && /STATUS_METADATA_UNREACHABLE/.test(src),
  );
}

// The canonical document's relative references resolve at `/`, not
// `/chamber/`; every one it names must have a root rewrite to the bundle.
for (const asset of assetRefs) {
  check(
    `root asset rewrite declared: ${asset}`,
    new RegExp(`'${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(nextConfig),
  );
}
check(
  'root asset rewrite maps to the canonical chamber directory',
  /source:\s*`\/\$\{asset\}`[\s\S]*?destination:\s*`\/chamber\/\$\{asset\}`/.test(nextConfig),
);
check(
  'portrait requests rewrite to the canonical chamber portraits',
  /source:\s*'\/portraits\/:file\*'[\s\S]*?destination:\s*'\/chamber\/portraits\/:file\*'/.test(
    nextConfig,
  ),
);

if (failures.length > 0) {
  process.stderr.write(`CTR-191 launch parity: FAIL (${failures.length})\n`);
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}

process.stdout.write('CTR-191 launch parity: contract holds (static source check only).\n');
