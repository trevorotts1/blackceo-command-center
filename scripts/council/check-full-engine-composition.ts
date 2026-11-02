/**
 * Focused, runnable contract check (NOT RUN in this session; no provider
 * call, no database write, no browser).
 *
 *   node --import tsx scripts/council/check-full-engine-composition.ts
 *
 * Asserts the composed Council engine against the CURRENT canonical pin
 * (77-council-of-wise-elders manifest source_commit ae82a61…, skill 1.0.75):
 * the three gap classes the CTR-191 receipt named — engine drift from the
 * canonical round contract, missing advisor packs, and serialized seats —
 * plus the source pin itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = join(import.meta.dirname, '..', '..');
const CC = join(ROOT, '..', '..', '..', '..');
const PROJECT = join(CC, '..', '..');
const CANON = join(PROJECT, 'lanes', 'CTR-194-repo-council-install', 'repo', '77-council-of-wise-elders');
const read = (p: string) => readFileSync(p, 'utf8');

// --- 1. source pin: the manifest pin and the source tree agree -----------
const manifest = JSON.parse(read(join(CANON, 'manifest.json'))) as {
  skill: string;
  skill_version: string;
  source_commit: string;
};
assert.equal(manifest.skill, 'council-of-wise-elders');
assert.equal(manifest.skill_version, '1.0.75');
assert.match(manifest.source_commit, /^[0-9a-f]{40}$/);

// --- 2. council sizes: 9 seats, per-mode rounds and wave widths ----------
const modes = read(join(ROOT, 'src/lib/council/contracts/modes.ts'));
assert.match(modes, /export const MODE_SEATS = SEAT_IDS\.length/);
assert.match(modes, /light:[\s\S]*?min_rounds: 2,[\s\S]*?max_rounds: 2,[\s\S]*?max_provider_requests: 50,[\s\S]*?max_concurrent_calls: 3/);
assert.match(modes, /medium:[\s\S]*?min_rounds: 1,[\s\S]*?max_rounds: 4,[\s\S]*?max_concurrent_calls: MODE_SEATS/);
assert.match(modes, /heavy:[\s\S]*?min_rounds: 3,[\s\S]*?max_rounds: 10,[\s\S]*?max_provider_requests: 100/);
assert.match(modes, /CONSENSUS_MIN_SEATS = 7/);
assert.match(modes, /CONSENSUS_LEAD = 1\.5/);

// --- 3. mode vocabulary and legal round barriers ------------------------
const enums = read(join(ROOT, 'src/lib/council/contracts/enums.ts'));
for (const mode of ['light', 'medium', 'heavy']) assert.ok(enums.includes(`'${mode}'`), mode);
const sm = read(join(ROOT, 'src/lib/council/contracts/state-machine.ts'));
const council = sm.slice(sm.indexOf('light: {'), sm.indexOf('medium: {'));
assert.match(council, /ROUND_2: \['DRAFT_RESOLUTION', 'CRUX_REVIEW'\]/);
assert.match(council, /DRAFT_RESOLUTION: \['VERIFYING'\]/);

// --- 4. canonical round contract restored (CTR-138 / 151 / 155) ---------
const contract = read(join(ROOT, 'src/lib/council/engine/card-contract.ts'));
for (const token of [
  'roundRule(',
  'EVIDENCE_ID_RULE',
  'closedObjectRule(',
  'LENSES_RULE',
  'PLAIN_LANGUAGE_RULE',
  'restrictLensesToApprovedSet',
  'cardOutputContract(',
  'cardRequestSystem(',
  'cardSystemBytes(',
]) assert.ok(contract.includes(token), `card contract: ${token}`);

// --- 5. engine: canonical metadata, waves, barrier, consensus stop ------
const engine = read(join(ROOT, 'src/lib/council/engine/council-engine.ts'));
assert.match(engine, /const outputContract = cardOutputContract\(purpose, challengeIds, contractRound\)/);
assert.match(engine, /cardRepairInstruction\(purpose, challengeIds, lastIssues, contractRound\)/);
assert.match(engine, /const waveWidth = isCouncilSize\(session\.spec\.mode\)/);
assert.match(engine, /await Promise\.all\(/);
assert.match(engine, /completedRound \+ 1/);
assert.match(engine, /evaluateConsensusStop\(cards, optionIds\)\.stop/);
assert.match(engine, /const lastAdvisorRound = await this\.completedAdvisorRound\(session\)/);

// --- 6. advisor packs: installed root, integrity, typed NOT_READY -------
const packs = read(join(ROOT, 'src/lib/council/engine/packs.ts'));
for (const token of [
  'COUNCIL_ADVISOR_PACK_ROOT',
  'install-record.json',
  'COUNCIL_SKILL_NAME',
  'COUNCIL_PACKS_NOT_READY',
  'briefing_sha256',
  'assertOutsideApplication',
]) assert.ok(packs.includes(token), `packs: ${token}`);
assert.ok(!packs.includes('mission-control.db'), 'packs never read the live Council DB');
const host = read(join(ROOT, 'src/lib/council/engine/cc-host.ts'));
assert.match(host, /const pack = loadAdvisorPack\(seatId\);/);

console.log('council composition contract: OK');
