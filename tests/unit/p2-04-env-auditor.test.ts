/**
 * P2-04 (c) steps 1-2 — the LLM env-auditor ("Deep Scan").
 *
 * FAIL-FIRST: against the pre-P2-04 tree, `src/lib/env-auditor.ts` does not
 * exist, so every import below fails and every test in this file errors.
 * With the P2-04 build the module exists and every test passes.
 *
 * Coverage (mirrors the P2-04(e) QC break-it probes):
 *   1. redactValue never contains the input value.
 *   2. gatherCandidateEnvEntries redacts every value it finds and correctly
 *      flags which keys the STANDARD resolver already recognizes.
 *   3. buildAuditPrompt NEVER contains a raw secret substring — only
 *      <SET:len=N> markers — even when fed real-looking secret values.
 *   4. parseAuditResponse — THE BREAK-IT TEST: a decoy `FAKE_STRIPE_KEY` and
 *      an oddly-named real-shaped Ollama key are both offered as candidates;
 *      the auditor must classify ONLY the latter. A response that tries to
 *      classify the decoy under a fabricated/non-existent provider slug is
 *      structurally dropped (never trusts the model blindly), independent of
 *      whether the model followed the prompt's instructions.
 *   5. saveSuggestions / listPendingSuggestions: never persists a suggestion
 *      the standard resolver already recognizes; a re-scan replaces the
 *      previous PENDING batch without touching confirmed/dismissed history;
 *      the secret VALUE never lands in the suggestions table.
 *   6. confirmEnvAuditSuggestion is the ONLY function that writes a key, and
 *      only for a confirmed id — re-reads the value FRESH rather than from
 *      the DB; a second confirm on the same id fails (no double-write).
 *   7. dismissEnvAuditSuggestion marks a row dismissed without ever writing
 *      a key.
 *   8. runEnvAudit end-to-end via an injected callOverride (no network) —
 *      the secret value never appears anywhere in the returned result.
 *
 * Runs via the Node built-in test runner (`npm run test:unit`).
 */

// C8 — DB isolation. env-auditor.ts pulls in '@/lib/db' transitively.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// gatherCandidateEnvEntries / openclawConfigPath / getSelfClient all read from
// os.homedir() — on THIS machine that is the operator's REAL home directory,
// which really does carry real credentials. Point HOME at a throwaway temp
// dir for the whole suite so this test NEVER reads or touches the operator's
// actual ~/.openclaw. os.homedir() honors $HOME on POSIX. Must be set before
// any project module that might cache a homedir-derived path is imported.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-p204-env-auditor-home-'));
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = FAKE_HOME;
delete process.env.OPENCLAW_PROJECT_DIR; // don't let a real project dir leak in

const OPENCLAW_DIR = path.join(FAKE_HOME, '.openclaw');
const ENV_FILE = path.join(OPENCLAW_DIR, '.env');
const CONFIG_FILE = path.join(OPENCLAW_DIR, 'openclaw.json');

const FAKE_OLLAMA_UNCONVENTIONAL = 'sk-fake-my-ollama-token-unconventional-0000000000000000000000';
const FAKE_STRIPE_DECOY = 'sk_live_fake_stripe_decoy_not_an_llm_provider_key_1111111111111';
const FAKE_OLLAMA_CONVENTIONAL = 'sk-fake-ollama-cloud-conventional-2222222222222222222222222222222';

type EnvAuditorModule = typeof import('../../src/lib/env-auditor');
let mod: EnvAuditorModule;

test.before(async () => {
  mod = await import('../../src/lib/env-auditor');
});

function resetFixtureFiles() {
  fs.rmSync(OPENCLAW_DIR, { recursive: true, force: true });
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
}

function writeEnvFile(contents: string) {
  fs.writeFileSync(ENV_FILE, contents, 'utf8');
}

test.after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  try {
    fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── 1. redactValue ────────────────────────────────────────────────────────

test('[P2-04] redactValue never contains the input value, and encodes the real length', () => {
  const redacted = mod.redactValue(FAKE_OLLAMA_UNCONVENTIONAL);
  assert.match(redacted, /^<SET:len=\d+>$/);
  assert.equal(redacted, `<SET:len=${FAKE_OLLAMA_UNCONVENTIONAL.length}>`);
  assert.ok(!redacted.includes(FAKE_OLLAMA_UNCONVENTIONAL));
});

// ── 2. gatherCandidateEnvEntries ──────────────────────────────────────────

test('[P2-04] gatherCandidateEnvEntries redacts every value and flags standard-resolver recognition correctly', () => {
  resetFixtureFiles();
  writeEnvFile(
    [
      `OLLAMA_CLOUD_API_KEY=${FAKE_OLLAMA_CONVENTIONAL}`,
      `MY_OLLAMA_TOKEN=${FAKE_OLLAMA_UNCONVENTIONAL}`,
      `FAKE_STRIPE_KEY=${FAKE_STRIPE_DECOY}`,
    ].join('\n'),
  );

  const candidates = mod.gatherCandidateEnvEntries();
  const byName = new Map(candidates.map((c) => [c.env_var, c]));

  assert.ok(byName.has('OLLAMA_CLOUD_API_KEY'));
  assert.ok(byName.has('MY_OLLAMA_TOKEN'));
  assert.ok(byName.has('FAKE_STRIPE_KEY'));

  // Every value must be redacted — never the raw secret.
  for (const c of candidates) {
    assert.match(c.redacted, /^<SET:len=\d+>$/);
  }
  assert.equal(byName.get('OLLAMA_CLOUD_API_KEY')!.redacted, `<SET:len=${FAKE_OLLAMA_CONVENTIONAL.length}>`);
  assert.equal(byName.get('MY_OLLAMA_TOKEN')!.redacted, `<SET:len=${FAKE_OLLAMA_UNCONVENTIONAL.length}>`);

  // The conventional name is already recognized by the standard resolver;
  // the unconventional name and the decoy are NOT — this is the entire gap
  // the auditor exists to close.
  assert.equal(byName.get('OLLAMA_CLOUD_API_KEY')!.already_recognized_provider, 'ollama-cloud');
  assert.equal(byName.get('MY_OLLAMA_TOKEN')!.already_recognized_provider, null);
  assert.equal(byName.get('FAKE_STRIPE_KEY')!.already_recognized_provider, null);
});

test('[P2-04] gatherCandidateEnvEntries never logs a raw secret value to any console channel', (t) => {
  resetFixtureFiles();
  writeEnvFile(`MY_OLLAMA_TOKEN=${FAKE_OLLAMA_UNCONVENTIONAL}`);

  const calls: string[] = [];
  const channels: Array<'log' | 'warn' | 'error' | 'info' | 'debug'> = ['log', 'warn', 'error', 'info', 'debug'];
  const originals = channels.map((c) => console[c]);
  for (const c of channels) {
    console[c] = ((...args: unknown[]) => {
      calls.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    }) as typeof console.log;
  }
  t.after(() => {
    channels.forEach((c, i) => {
      console[c] = originals[i];
    });
  });

  mod.gatherCandidateEnvEntries();

  for (const line of calls) {
    assert.ok(!line.includes(FAKE_OLLAMA_UNCONVENTIONAL), `console output leaked the raw secret: ${line}`);
  }
});

// ── 3. buildAuditPrompt ───────────────────────────────────────────────────

test('[P2-04] buildAuditPrompt NEVER contains a raw secret substring, only redaction markers', () => {
  resetFixtureFiles();
  writeEnvFile(
    [`OLLAMA_CLOUD_API_KEY=${FAKE_OLLAMA_CONVENTIONAL}`, `MY_OLLAMA_TOKEN=${FAKE_OLLAMA_UNCONVENTIONAL}`, `FAKE_STRIPE_KEY=${FAKE_STRIPE_DECOY}`].join(
      '\n',
    ),
  );
  const candidates = mod.gatherCandidateEnvEntries();
  const prompt = mod.buildAuditPrompt(candidates, ['leftover.env.bak']);

  assert.ok(!prompt.includes(FAKE_OLLAMA_CONVENTIONAL));
  assert.ok(!prompt.includes(FAKE_OLLAMA_UNCONVENTIONAL));
  assert.ok(!prompt.includes(FAKE_STRIPE_DECOY));
  assert.match(prompt, /<SET:len=\d+>/);
  assert.ok(prompt.includes('ollama-cloud')); // known-slug list sanity
  assert.ok(prompt.includes('leftover.env.bak')); // extra-files filenames surfaced
});

// ── 4. parseAuditResponse — the break-it test ─────────────────────────────

test('[P2-04 BREAK-IT] classifies only the real LLM-provider key when the model behaves', () => {
  resetFixtureFiles();
  writeEnvFile([`MY_OLLAMA_TOKEN=${FAKE_OLLAMA_UNCONVENTIONAL}`, `FAKE_STRIPE_KEY=${FAKE_STRIPE_DECOY}`].join('\n'));
  const candidates = mod.gatherCandidateEnvEntries();

  const wellBehaved = JSON.stringify({
    suggestions: [
      { env_var: 'MY_OLLAMA_TOKEN', provider: 'ollama-cloud', confidence: 'high', reason: 'shaped like an Ollama Cloud token' },
    ],
    unreadable_providers: [],
  });

  const parsed = mod.parseAuditResponse(wellBehaved, candidates);
  assert.equal(parsed.suggestions.length, 1);
  assert.equal(parsed.suggestions[0].env_var, 'MY_OLLAMA_TOKEN');
  assert.equal(parsed.suggestions[0].provider, 'ollama-cloud');
});

test('[P2-04 BREAK-IT] a misbehaving response classifying the Stripe decoy under a FABRICATED provider slug is structurally dropped', () => {
  resetFixtureFiles();
  writeEnvFile([`MY_OLLAMA_TOKEN=${FAKE_OLLAMA_UNCONVENTIONAL}`, `FAKE_STRIPE_KEY=${FAKE_STRIPE_DECOY}`].join('\n'));
  const candidates = mod.gatherCandidateEnvEntries();

  const misbehaving = JSON.stringify({
    suggestions: [
      { env_var: 'MY_OLLAMA_TOKEN', provider: 'ollama-cloud', confidence: 'high', reason: 'real' },
      // "stripe" is not a registered LLM/media provider slug in this system —
      // this must be dropped structurally, not merely by prompt compliance.
      { env_var: 'FAKE_STRIPE_KEY', provider: 'stripe', confidence: 'high', reason: 'hallucinated' },
    ],
    unreadable_providers: [],
  });

  const parsed = mod.parseAuditResponse(misbehaving, candidates);
  assert.equal(parsed.suggestions.length, 1, 'only the real provider slug suggestion should survive');
  assert.equal(parsed.suggestions[0].env_var, 'MY_OLLAMA_TOKEN');
  assert.ok(!parsed.suggestions.some((s) => s.env_var === 'FAKE_STRIPE_KEY'));
});

test('[P2-04 BREAK-IT] a hallucinated env-var name we never offered is dropped', () => {
  resetFixtureFiles();
  writeEnvFile(`MY_OLLAMA_TOKEN=${FAKE_OLLAMA_UNCONVENTIONAL}`);
  const candidates = mod.gatherCandidateEnvEntries();

  const hallucinated = JSON.stringify({
    suggestions: [{ env_var: 'SOME_KEY_WE_NEVER_OFFERED', provider: 'ollama-cloud', confidence: 'high', reason: 'made up' }],
    unreadable_providers: [],
  });

  const parsed = mod.parseAuditResponse(hallucinated, candidates);
  assert.equal(parsed.suggestions.length, 0);
});

test('[P2-04] parseAuditResponse tolerates prose/code-fence wrapping around the JSON object', () => {
  resetFixtureFiles();
  writeEnvFile(`MY_OLLAMA_TOKEN=${FAKE_OLLAMA_UNCONVENTIONAL}`);
  const candidates = mod.gatherCandidateEnvEntries();

  const wrapped =
    '```json\n' +
    JSON.stringify({
      suggestions: [{ env_var: 'MY_OLLAMA_TOKEN', provider: 'ollama-cloud', confidence: 'medium', reason: 'ok' }],
      unreadable_providers: ['kie'],
    }) +
    '\n```';

  const parsed = mod.parseAuditResponse(wrapped, candidates);
  assert.equal(parsed.suggestions.length, 1);
  assert.deepEqual(parsed.unreadable_providers, ['kie']);
});

test('[P2-04] parseAuditResponse returns empty on unparseable garbage (never throws)', () => {
  const parsed = mod.parseAuditResponse('not json at all', []);
  assert.deepEqual(parsed, { suggestions: [], unreadable_providers: [] });
});

// ── 5. saveSuggestions / listPendingSuggestions ───────────────────────────

test('[P2-04] saveSuggestions skips a pairing the standard resolver already recognizes', () => {
  resetFixtureFiles();
  writeEnvFile(`OLLAMA_CLOUD_API_KEY=${FAKE_OLLAMA_CONVENTIONAL}`);
  const candidates = mod.gatherCandidateEnvEntries();

  const parsed = mod.parseAuditResponse(
    JSON.stringify({
      suggestions: [{ env_var: 'OLLAMA_CLOUD_API_KEY', provider: 'ollama-cloud', confidence: 'high', reason: 'already correct' }],
      unreadable_providers: [],
    }),
    candidates,
  );

  const saved = mod.saveSuggestions(candidates, parsed);
  assert.equal(saved, 0, 'nothing new to confirm for an already-recognized pairing');
  assert.equal(mod.listPendingSuggestions().length, 0);
});

test('[P2-04] saveSuggestions persists a genuinely new suggestion, never the secret value; a re-scan replaces the previous pending batch', () => {
  resetFixtureFiles();
  writeEnvFile(`MY_OLLAMA_TOKEN=${FAKE_OLLAMA_UNCONVENTIONAL}`);
  const candidates = mod.gatherCandidateEnvEntries();
  const parsed = mod.parseAuditResponse(
    JSON.stringify({
      suggestions: [{ env_var: 'MY_OLLAMA_TOKEN', provider: 'ollama-cloud', confidence: 'high', reason: 'shaped like Ollama' }],
      unreadable_providers: [],
    }),
    candidates,
  );

  const saved = mod.saveSuggestions(candidates, parsed);
  assert.equal(saved, 1);

  const pending = mod.listPendingSuggestions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].env_var, 'MY_OLLAMA_TOKEN');
  assert.equal(pending[0].suggested_provider, 'ollama-cloud');
  assert.equal(pending[0].status, 'pending');

  // The secret value must never appear anywhere in the persisted row.
  const rowText = JSON.stringify(pending[0]);
  assert.ok(!rowText.includes(FAKE_OLLAMA_UNCONVENTIONAL));

  // A second save() call (simulating a re-scan) replaces the pending batch
  // rather than piling up a duplicate.
  const saved2 = mod.saveSuggestions(candidates, parsed);
  assert.equal(saved2, 1);
  assert.equal(mod.listPendingSuggestions().length, 1, 'a re-scan must not duplicate the pending row');
});

// ── 6. confirmEnvAuditSuggestion — the ONLY place a key is ever written ──

test('[P2-04] confirmEnvAuditSuggestion writes the key ONLY on confirm, re-reads it fresh, and refuses a second confirm', async () => {
  resetFixtureFiles();
  writeEnvFile(`MY_OLLAMA_TOKEN=${FAKE_OLLAMA_UNCONVENTIONAL}`);
  const candidates = mod.gatherCandidateEnvEntries();
  const parsed = mod.parseAuditResponse(
    JSON.stringify({
      suggestions: [{ env_var: 'MY_OLLAMA_TOKEN', provider: 'ollama-cloud', confidence: 'high', reason: 'shaped like Ollama' }],
      unreadable_providers: [],
    }),
    candidates,
  );
  mod.saveSuggestions(candidates, parsed);
  const [suggestion] = mod.listPendingSuggestions();
  assert.ok(suggestion, 'fixture suggestion must exist');

  // Before confirm: nothing has been auto-wired — no openclaw.json exists yet.
  assert.equal(fs.existsSync(CONFIG_FILE), false);

  const result = await mod.confirmEnvAuditSuggestion(suggestion.id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.env_var, 'OLLAMA_CLOUD_API_KEY');

  // The confirmed write actually landed, under the CANONICAL env-var name,
  // with the value re-read fresh from the .env file (not round-tripped
  // through the LLM or the suggestions table).
  assert.equal(fs.existsSync(CONFIG_FILE), true);
  const written = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  assert.equal(written.env.vars.OLLAMA_CLOUD_API_KEY, FAKE_OLLAMA_UNCONVENTIONAL);

  // The suggestion is now confirmed, not pending.
  assert.equal(mod.listPendingSuggestions().length, 0);

  // A second confirm on the same id must fail — no double-write.
  const second = await mod.confirmEnvAuditSuggestion(suggestion.id);
  assert.equal(second.ok, false);
  assert.match(second.error ?? '', /already confirmed/);
});

test('[P2-04] confirmEnvAuditSuggestion refuses when the source value can no longer be re-read', async () => {
  resetFixtureFiles();
  writeEnvFile(`MY_OLLAMA_TOKEN=${FAKE_OLLAMA_UNCONVENTIONAL}`);
  const candidates = mod.gatherCandidateEnvEntries();
  const parsed = mod.parseAuditResponse(
    JSON.stringify({
      suggestions: [{ env_var: 'MY_OLLAMA_TOKEN', provider: 'ollama-cloud', confidence: 'high', reason: 'x' }],
      unreadable_providers: [],
    }),
    candidates,
  );
  mod.saveSuggestions(candidates, parsed);
  const [suggestion] = mod.listPendingSuggestions();

  // The value disappears out from under the suggestion (file rewritten/removed).
  fs.rmSync(ENV_FILE);

  const result = await mod.confirmEnvAuditSuggestion(suggestion.id);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /could not be re-read/);
  assert.equal(fs.existsSync(CONFIG_FILE), false, 'must never write when the value cannot be re-verified');
});

// ── 7. dismissEnvAuditSuggestion ──────────────────────────────────────────

test('[P2-04] dismissEnvAuditSuggestion marks a row dismissed without ever writing a key', () => {
  resetFixtureFiles();
  writeEnvFile(`MY_OLLAMA_TOKEN=${FAKE_OLLAMA_UNCONVENTIONAL}`);
  const candidates = mod.gatherCandidateEnvEntries();
  const parsed = mod.parseAuditResponse(
    JSON.stringify({
      suggestions: [{ env_var: 'MY_OLLAMA_TOKEN', provider: 'ollama-cloud', confidence: 'low', reason: 'x' }],
      unreadable_providers: [],
    }),
    candidates,
  );
  mod.saveSuggestions(candidates, parsed);
  const [suggestion] = mod.listPendingSuggestions();

  const result = mod.dismissEnvAuditSuggestion(suggestion.id);
  assert.equal(result.ok, true);
  assert.equal(mod.listPendingSuggestions().length, 0);
  assert.equal(fs.existsSync(CONFIG_FILE), false);

  const second = mod.dismissEnvAuditSuggestion(suggestion.id);
  assert.equal(second.ok, false);
});

// ── 8. runEnvAudit end-to-end (no network — injected callOverride) ───────

test('[P2-04] runEnvAudit end-to-end via callOverride never leaks the secret value in its result', async () => {
  resetFixtureFiles();
  writeEnvFile([`MY_OLLAMA_TOKEN=${FAKE_OLLAMA_UNCONVENTIONAL}`, `FAKE_STRIPE_KEY=${FAKE_STRIPE_DECOY}`].join('\n'));

  const result = await mod.runEnvAudit({
    callOverride: async (prompt) => {
      // The injected "model" only ever sees the redacted prompt — assert that
      // here too, inside the call site, as an extra guarantee.
      assert.ok(!prompt.includes(FAKE_OLLAMA_UNCONVENTIONAL));
      assert.ok(!prompt.includes(FAKE_STRIPE_DECOY));
      return JSON.stringify({
        suggestions: [{ env_var: 'MY_OLLAMA_TOKEN', provider: 'ollama-cloud', confidence: 'high', reason: 'shaped like Ollama' }],
        unreadable_providers: [],
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.candidates_found, 2);
  assert.equal(result.suggestions_saved, 1);

  const resultText = JSON.stringify(result);
  assert.ok(!resultText.includes(FAKE_OLLAMA_UNCONVENTIONAL));
  assert.ok(!resultText.includes(FAKE_STRIPE_DECOY));

  const pending = mod.listPendingSuggestions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].env_var, 'MY_OLLAMA_TOKEN');
});

test('[P2-04] runEnvAudit reports ok:true with zero candidates when nothing is found (never fabricates)', async () => {
  resetFixtureFiles(); // empty .openclaw dir, no .env file
  const result = await mod.runEnvAudit({ callOverride: async () => '{"suggestions":[],"unreadable_providers":[]}' });
  assert.equal(result.ok, true);
  assert.equal(result.candidates_found, 0);
  assert.equal(result.suggestions_saved, 0);
});

// ── 9. resolveAuditorModel degrades honestly with no local inventory ─────

test('[P2-04] resolveAuditorModel returns null (never fabricates a model) when the box has no active catalog', () => {
  // The isolated test DB has no model_registry rows seeded.
  const choice = mod.resolveAuditorModel();
  assert.equal(choice, null);
});
