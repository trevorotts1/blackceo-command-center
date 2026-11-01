#!/usr/bin/env node
/**
 * CI PIN DRIFT CHECK — makes the runner image and action refs every workflow
 * runs on explicit, and makes a change to either one go red.
 *
 * WHY THIS EXISTS. `runs-on: ubuntu-latest` and `actions/checkout@v4` are not
 * pins. `ubuntu-latest` moves when GitHub publishes a new image, and a major
 * action tag can be retagged in place or taken over upstream. Both drift with
 * NOT ONE BYTE changing in this repo, so no diff, review, test or release note
 * can see it — the build silently starts running somewhere else. The fix is
 * not a better test of the workflow; it is to stop declaring the workflow in
 * floating terms and then to fail when someone puts the float back.
 *
 * ONE PLACE TO BUMP. The three constants below are the single source of truth:
 *   RUNNER_IMAGE       the only runner image any job may use
 *   ALLOWED_USES       every external action ref a workflow may name
 *   (anything else, including a new action, must be added here deliberately)
 *
 * SCOPE, HONESTLY. A major tag (`@v4`) still floats inside its major; full
 * commit-SHA pinning is the stronger control and a larger change. This check
 * catches the ref leaving the reviewed set, not a retag of the same major.
 *
 * ponytail: allowlist of major tags, not 40-hex SHAs — add SHA pinning when the
 * supply-chain pass lands; the file this check reads does not change.
 *
 * USAGE
 *   node scripts/check-ci-pins.mjs [root]     # root defaults to the repo
 *   exit 0 = every pin explicit and in the reviewed set
 *   exit 1 = drift, one named line per finding
 *   exit 2 = the check could not run (no workflows, unreadable tree) — never a pass
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER_IMAGE = 'ubuntu-24.04';
const ALLOWED_USES = new Set([
  'actions/checkout@v4',
  'actions/setup-node@v4',
  'actions/setup-python@v5',
  'actions/upload-artifact@v4',
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(here, '..'));
const WF = path.join(ROOT, '.github', 'workflows');

let files;
try {
  files = fs.readdirSync(WF).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
} catch (err) {
  console.error(`UNDETERMINED: cannot read ${WF} — ${err?.message || err}`);
  process.exit(2);
}
if (!files.length) {
  console.error(`UNDETERMINED: no workflow files under ${WF}`);
  process.exit(2);
}

const findings = [];
let runsOn = 0;
let uses = 0;

const unquote = (v) => v.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');

for (const file of files) {
  const full = path.join(WF, file);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (err) {
    findings.push(`${file}: unreadable — ${err?.message || err}`);
    continue;
  }
  text.split('\n').forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    const runs = line.match(/^\s*runs-on:\s*(.+?)\s*$/);
    if (runs) {
      runsOn += 1;
      const value = unquote(runs[1]);
      if (value !== RUNNER_IMAGE) {
        const kind = value.endsWith('-latest') ? 'floating runner' : 'runner pin drift';
        findings.push(`${at}: ${kind} — runs-on: ${value} (expected ${RUNNER_IMAGE})`);
      }
      return;
    }
    const use = line.match(/^\s*(?:-\s*)?uses:\s*(.+?)\s*$/);
    if (use) {
      const value = unquote(use[1]);
      if (value.startsWith('./')) return; // local composite action, not a pin
      uses += 1;
      if (!ALLOWED_USES.has(value)) {
        findings.push(`${at}: action pin not in the reviewed set — uses: ${value}`);
      }
    }
  });
}

// A guard that scanned nothing proves nothing: absent or unparsed pins must be
// UNDETERMINED, never a silent pass.
if (!runsOn) {
  console.error(`UNDETERMINED: found 0 runs-on pins across ${files.length} workflow file(s) at ${WF}`);
  process.exit(2);
}

if (findings.length) {
  console.error(`CI PIN DRIFT — ${findings.length} finding(s) in ${files.length} workflow file(s)`);
  for (const f of findings) console.error(`  ${f}`);
  console.error('');
  console.error(`FIX: pin runs-on to ${RUNNER_IMAGE}; add any new action to ALLOWED_USES in`);
  console.error('     scripts/check-ci-pins.mjs only after reviewing it.');
  process.exit(1);
}

console.log(`OK — ${runsOn} runner pin(s) and ${uses} action ref(s) across ${files.length} workflow file(s) match the reviewed set.`);
