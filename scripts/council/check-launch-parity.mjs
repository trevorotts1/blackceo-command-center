#!/usr/bin/env node
/**
 * CTR-191 launch-parity regression check (static, no browser, no network).
 *
 * Encodes the ONE launch contract every Council entry point must satisfy:
 * the chamber opens first, bound to a real sitting, and the sitting's
 * results sit below the room. It fails if a setup step ever reappears in
 * front of the chamber, or if the room goes back to rendering only an
 * always-idle stage.
 *
 * Trevor owns functional testing. This check reads source only; it is not
 * proof of a rendered screen.
 *
 *   node scripts/council/check-launch-parity.mjs
 *   exit 0 = contract holds, 1 = a contract clause is broken
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
};

const page = read('src/app/council/page.tsx');
const home = read('src/components/council/CouncilHome.tsx');

// 1. The /council route renders the chamber home. No other entry screen
//    stands in front of it.
check('/council mounts CouncilHome', /<CouncilHome\s*\/>/.test(page));
check('/council does not render an intake composer at the route', !/DecisionComposer/.test(page));

// 2. The chamber binds a real sitting to the room: the selected session is
//    read and handed to the live session renderer.
check('chamber selects a sitting', /selectChamberSession\(/.test(home));
check('chamber renders the live session in the room', /<CouncilLiveSession/.test(home));
check('chamber keeps the idle room for an empty store', /IDLE_CHAMBER_ROOM/.test(home));

// 3. No setup form gates the chamber. The pre-CTR-191 entry put
//    action="/council/new" above the room; that is the regression.
check('no intake form gates the chamber', !/action=["']\/council\/new["']/.test(home));
check('no intake input gates the chamber', !/name=["']question["']/.test(home));

// 4. The sitting's controls are chamber controls.
for (const id of [
  'council-chamber-new-question',
  'council-chamber-past-sessions',
  'council-chamber-advisors',
]) {
  check(`chamber control present: ${id}`, home.includes(id));
}

// 5. Results render below the room on the same page.
check('verdict renders on the chamber page', /<CouncilVerdict/.test(home));
check(
  'verdict follows the room',
  home.indexOf('<CouncilLiveSession') >= 0 &&
    home.indexOf('<CouncilVerdict') > home.indexOf('<CouncilLiveSession'),
);

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
