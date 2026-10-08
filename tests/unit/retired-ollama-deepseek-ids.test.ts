/**
 * Ollama Cloud retired every deepseek-v4-flash build on 2026-09-25 (HTTP 410).
 * Fails if one is used as a LIVE default, and proves boxes still naming one heal.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { successorModelId } from '../../src/lib/retired-models';
import { FLEET_PRIMARY_MODEL_ID } from '../../src/lib/model-registry';

test('successorModelId maps retired ollama ids, keeps prefix, leaves other providers alone', () => {
  const live = 'deepseek-v4.1-flash:cloud';
  for (const [i, o] of [
    ['deepseek-v4-flash:cloud', live], ['deepseek-v4-flash:0731', live], ['deepseek-v4-flash:0731-cloud', live],
    ['ollama/deepseek-v4-flash:0731-cloud', `ollama/${live}`], ['ollama-cloud/deepseek-v4-flash:cloud', `ollama-cloud/${live}`],
    ['ollama/deepseek-v4-flash', `ollama/${live}`],
    ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash'], ['ds/deepseek-v4-flash', 'ds/deepseek-v4-flash'],
    ['openrouter/deepseek/deepseek-v4-flash', 'openrouter/deepseek/deepseek-v4-flash'],
    ['deepseek-v4-flash', 'deepseek-v4-flash'], [live, live],
  ]) assert.equal(successorModelId(i), o, i);
});

test('the fleet primary default is not a retired id', () => {
  assert.equal(FLEET_PRIMARY_MODEL_ID, 'ollama-cloud/deepseek-v4.1-flash:cloud');
});

test('no retired Ollama deepseek-v4-flash id is a live default in src/scripts/fleet-heartbeat', () => {
  let raw = '';
  try { raw = execFileSync('git', ['grep', '-nE', '(ollama(-cloud)?/)?deepseek-v4-flash(:cloud|:0731(-cloud)?)', '--', 'src', 'scripts', 'fleet-heartbeat', ':!src/lib/retired-models.ts'], { encoding: 'utf8' }); } catch (e: any) { if (e.status !== 1) throw e; /* 1 = no matches */ }
  const out = raw.split('\n').filter(Boolean)
    // comments describing the retirement are fine; code lines are not
    .filter((l) => !/^\S+?:\d+:\s*(\/\/|\*|\/\*|#)/.test(l));
  assert.deepEqual(out, []);
});

test('a box whose openclaw.json still names a retired id heals to the successor on read', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { resolveBoxDefaultModelChain } = await import('../../src/lib/runtime-model');
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'retired-heal-')), 'openclaw.json');
  fs.writeFileSync(p, JSON.stringify({ agents: { defaults: { model: { primary: 'ollama/deepseek-v4-flash:0731-cloud', fallbacks: ['ollama-cloud/deepseek-v4-flash:cloud'] } } } }));
  assert.deepEqual(resolveBoxDefaultModelChain(p), ['ollama/deepseek-v4.1-flash:cloud', 'ollama-cloud/deepseek-v4.1-flash:cloud']);
});
