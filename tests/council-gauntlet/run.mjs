/**
 * run.mjs — CWE-044 client gauntlet orchestrator.
 *
 * One command (`npm run test:council:visual`, the Section 37.1
 * surface) executes the entire gauntlet against the CURRENT tree
 * and writes gauntlet-results.json plus all evidence artifacts to
 * $GAUNTLET_OUT (default ~/workspace/skill77/cwe-044/evidence).
 *
 * Pipeline:
 *   1. Regenerate the CWE-038 export fixtures from the ONB runtime
 *      (byte drift is caught by the PDF suite's manifest check).
 *   2. Render the composed-page snapshots from this tree's real
 *      components (vitest snapshot generator).
 *   3. Bundle the interactive harness page from this tree's real
 *      components (esbuild).
 *   4. Browser suites (Playwright/Chromium): viewports (T098),
 *      keyboard and motion (T099), theme contrast (T100), composed
 *      Section 7 label, journey gate + usability evidence
 *      (T124/T097/T155), interface feedback and initial load (T154).
 *   5. Node suites: rendered PDF (T106), the 501-event resync
 *      branch, recorded-load REST budgets (T154).
 *   6. Event-to-UI suite (vitest + jsdom over the real store).
 *
 * The post-CWE-050 acceptance re-run is this same command on the
 * composed tree: nothing here is tree-specific except the checks
 * themselves. Exit code is nonzero iff any check FAILS; pending
 * (PENDING_CWE050_RERUN) and not_run results are reported, never
 * counted as passes and never as failures.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT_DIR =
  process.env.GAUNTLET_OUT ?? join(homedir(), 'workspace/skill77/cwe-044/evidence');
mkdirSync(OUT_DIR, { recursive: true });

const suites = [];
let currentSuite = null;

function step(name, fn) {
  currentSuite = { suite: name, checks: [] };
  suites.push(currentSuite);
  return fn();
}

function record(id, status, label, detail) {
  currentSuite.checks.push({ id, status, label, detail });
}

function runCmd(label, cmd, args, opts = {}) {
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    cwd: REPO,
    env: { ...process.env, GAUNTLET_OUT: OUT_DIR },
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (res.error) {
    record(label, 'fail', label, `spawn error after ${secs}s: ${res.error.message}`);
    return { ok: false, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }
  const ok = res.status === 0;
  record(
    label,
    ok ? 'pass' : 'fail',
    label,
    `exit ${res.status} in ${secs}s`,
  );
  return { ok, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Run a node:test file and turn each TAP result into a check. */
function runNodeTestSuite(suiteName, file) {
  const res = spawnSync(
    'node',
    [
      '--import',
      'tsx',
      '--import',
      './tests/setup/no-owner-telegram.ts',
      '--test',
      '--test-reporter=tap',
      file,
    ],
    {
      cwd: REPO,
      env: { ...process.env, GAUNTLET_OUT: OUT_DIR },
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const tap = res.stdout ?? '';
  let saw = 0;
  for (const line of tap.split('\n')) {
    const ok = /^ok \d+ - (.+)$/.exec(line);
    const notOk = /^not ok \d+ - (.+)$/.exec(line);
    if (ok) {
      saw++;
      record(`${suiteName}`, 'pass', ok[1], file);
    } else if (notOk) {
      saw++;
      record(`${suiteName}`, 'fail', notOk[1], `${file}\n${tap.slice(-2000)}`);
    }
  }
  if (saw === 0) {
    record(
      suiteName,
      'fail',
      `${file} produced no TAP results`,
      (res.stderr ?? '').slice(-2000) || tap.slice(-2000),
    );
  }
}

/* ── 1-3: fixture + snapshot + bundle generation ──────────────── */
await step('generation', async () => {
  runCmd('cwe038-fixtures', 'node', [join(HERE, 'make-cwe038-fixtures.mjs')]);
  runCmd('snapshots', 'npx', [
    'vitest',
    'run',
    '--config',
    'vitest.council-gauntlet.config.ts',
    'tests/unit/council-gauntlet-snapshots.test.tsx',
  ]);
  runCmd('interactive-bundle', 'node', [join(HERE, 'build-interactive.mjs')]);
});

/* ── 4: browser suites ────────────────────────────────────────── */
for (const [name, file] of [
  ['viewports', 'suite-viewports.mjs'],
  ['keyboard', 'suite-keyboard.mjs'],
  ['contrast', 'suite-contrast.mjs'],
  ['labels', 'suite-labels.mjs'],
  ['journey', 'suite-journey.mjs'],
  ['feedback', 'suite-feedback.mjs'],
]) {
  await step(name, async () => {
    try {
      const mod = await import(join(HERE, file));
      const result = await mod.run(REPO);
      for (const c of result.checks) record(c.id, c.status, c.name, c.detail);
    } catch (err) {
      record(name, 'fail', `${name} suite crashed`, String(err?.stack ?? err));
    }
  });
}

/* ── 5: node suites ───────────────────────────────────────────── */
await step('pdf', async () => {
  runNodeTestSuite('pdf', 'tests/unit/council-gauntlet-pdf.test.ts');
});
await step('resync501', async () => {
  runNodeTestSuite('resync501', 'tests/unit/council-gauntlet-resync501.test.ts');
});
await step('perf-rest', async () => {
  runNodeTestSuite('perf-rest', 'tests/unit/council-gauntlet-perf.test.ts');
});

/* ── 6: event-to-UI ───────────────────────────────────────────── */
await step('event-to-ui', async () => {
  const res = runCmd('eventui-vitest', 'npx', [
    'vitest',
    'run',
    '--config',
    'vitest.council-gauntlet.config.ts',
    'tests/unit/council-gauntlet-eventui.test.tsx',
  ]);
  const line = (res.stdout + res.stderr)
    .split('\n')
    .find((l) => l.includes('event-to-UI:'));
  if (line) {
    record('T154-event-to-ui', res.ok ? 'pass' : 'fail', 'committed event to visible UI (200 samples)', line.trim());
  }
});

/* ── aggregate ────────────────────────────────────────────────── */
const all = suites.flatMap((s) => s.checks.map((c) => ({ suite: s.suite, ...c })));
const counts = {
  pass: all.filter((c) => c.status === 'pass').length,
  fail: all.filter((c) => c.status === 'fail').length,
  pending_cwe050_rerun: all.filter((c) => c.status === 'pending_cwe050_rerun').length,
  not_run: all.filter((c) => c.status === 'not_run').length,
};
const results = {
  gauntlet: 'CWE-044 client gauntlet',
  generated_at: new Date().toISOString(),
  tree: process.env.GAUNTLET_TREE_LABEL ?? 'cc-cwe044 (base 7811128 + CWE-044 harness)',
  counts,
  suites,
};
writeFileSync(join(OUT_DIR, 'gauntlet-results.json'), JSON.stringify(results, null, 2) + '\n');

console.log(`\n=== CWE-044 gauntlet: ${counts.pass} pass, ${counts.fail} fail, ${counts.pending_cwe050_rerun} pending CWE-050 re-run, ${counts.not_run} not run ===`);
for (const c of all) {
  if (c.status !== 'pass') console.log(`${c.status.toUpperCase()} [${c.suite}] ${c.id}: ${c.label}`);
}
console.log(`results: ${join(OUT_DIR, 'gauntlet-results.json')}`);
process.exit(counts.fail > 0 ? 1 : 0);
