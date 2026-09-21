#!/usr/bin/env node
/**
 * OPENCLAW CONTRACT CHECK — "does the gateway this box actually runs still
 * speak the protocol this codebase writes against?"
 *
 * WHY THIS EXISTS. Every gateway call in src/lib/openclaw/client.ts is written
 * against an UNVERSIONED, UNDOCUMENTED wire contract that lives only inside the
 * installed `openclaw` package. When upstream renames a field, drops a handler
 * or re-shapes a result, nothing in this repo fails: the call still compiles,
 * still type-checks, still ships, and then returns the wrong thing FOREVER at
 * runtime. That is not hypothetical — it is how three live defects were found
 * on one box:
 *   - `sessions.list` returns an OBJECT (`{ts,path,count,defaults,sessions:[]}`)
 *     and the client treated it as an array, so `Array.isArray(...)` was always
 *     false and the runtime-model resolver silently returned null every time.
 *   - `sessions.send` requires `{key,message}` and the client sent
 *     `{session_id,content}` — rejected by a closed schema, every send.
 *   - `sessions.history` HAS NO HANDLER AT ALL (0 references in 2026.9.4 and
 *     2026.9.5); the real method is `chat.history`.
 * A type error would have caught none of them. This check does.
 *
 * WHAT IT ASSERTS, AND HOW. The schemas are read by IMPORTING the gateway's own
 * protocol module (`dist/gateway/protocol/index.js`) — TypeBox schemas are plain
 * JSON objects, so the assertions run against the REAL contract object the
 * gateway validates with, not a transcription of it. What the protocol module
 * does not export (handler registration, the failover reason list, config
 * precedence, the concurrency default) is proved by searching the dist for the
 * defining SYMBOL, never a filename: upstream content-hashes every chunk name,
 * so `sessions-rlbLHLas.mjs` in 2026.9.4 is `session-utils-DCz7_NNh.mjs` in
 * 2026.9.5 and a filename-pinned check would break on every release while
 * proving nothing.
 *
 * NEGATIVE RESULTS. A failure NAMES the contract and the sources searched. A
 * check that cannot run its own instrument (missing dist, unimportable protocol
 * module) reports UNDETERMINED and exits non-zero — it never reports a contract
 * as broken on the strength of a search that did not work.
 *
 * USAGE
 *   node scripts/openclaw-contract-check.mjs            # resolve the installed openclaw
 *   OPENCLAW_DIST=/path/to/openclaw/dist node scripts/openclaw-contract-check.mjs
 *   node scripts/openclaw-contract-check.mjs --json     # machine-readable
 *
 * EXIT CODES
 *   0  every hard contract holds (warnings may still be printed)
 *   1  at least one hard contract FAILED, or the check could not be run
 *
 * Bypass in update.sh with OPENCLAW_CONTRACT_CHECK=0.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const JSON_OUT = process.argv.includes('--json');

/* ────────────────────────────── dist resolution ─────────────────────────── */

/** Every place looked, in order, so a "not found" can NAME its sources. */
const sourcesTried = [];

function isOpenClawPackageDir(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg?.name === 'openclaw' ? pkg : null;
  } catch { return null; }
}

/** `command -v` proves a NAME resolves — never that the thing behind it is the
 *  package we want. So the bin is followed to a real directory and that
 *  directory is required to hold an openclaw package.json. */
function distFromBin() {
  let bin;
  try { bin = execFileSync('sh', ['-c', 'command -v openclaw'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
  if (!bin) return null;
  let real;
  try { real = fs.realpathSync(bin); } catch { return null; }
  for (let dir = path.dirname(real), i = 0; i < 6; dir = path.dirname(dir), i++) {
    if (isOpenClawPackageDir(dir)) return dir;
    if (dir === path.dirname(dir)) break;
  }
  return null;
}

function npmGlobalRoot() {
  try { return execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

function resolveDist() {
  if (process.env.OPENCLAW_DIST) {
    const dist = path.resolve(process.env.OPENCLAW_DIST);
    sourcesTried.push(`OPENCLAW_DIST=${dist}`);
    if (fs.existsSync(dist)) return { dist, pkgDir: path.dirname(dist) };
    return null;
  }

  const candidates = [];
  const require_ = createRequire(path.join(process.cwd(), 'noop.js'));
  try { candidates.push(path.dirname(require_.resolve('openclaw/package.json'))); } catch { /* not a local dep */ }
  sourcesTried.push('require.resolve("openclaw/package.json") from the repo');

  const fromBin = distFromBin();
  sourcesTried.push('realpath of `command -v openclaw`');
  if (fromBin) candidates.push(fromBin);

  const gRoot = npmGlobalRoot();
  sourcesTried.push(gRoot ? `npm root -g (${gRoot})` : 'npm root -g (unavailable)');
  if (gRoot) candidates.push(path.join(gRoot, 'openclaw'));

  for (const prefix of [
    path.join(os.homedir(), '.npm-global/lib/node_modules'),
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    '/usr/lib/node_modules',
  ]) {
    sourcesTried.push(path.join(prefix, 'openclaw'));
    candidates.push(path.join(prefix, 'openclaw'));
  }

  for (const pkgDir of candidates) {
    const pkg = isOpenClawPackageDir(pkgDir);
    if (!pkg) continue;
    const dist = path.join(pkgDir, 'dist');
    if (fs.existsSync(dist)) return { dist, pkgDir, version: pkg.version };
  }
  return null;
}

/* ─────────────────────────────── dist search ────────────────────────────── */

/**
 * Search the dist for a DEFINING SYMBOL. Filenames are content-hashed per
 * release and are never used as an anchor.
 *
 * grep's exit codes are load-bearing here: 0 = matched, 1 = no match, >=2 = the
 * search itself failed (unreadable path, bad pattern). A search failure is
 * UNDETERMINED, never "the symbol is absent".
 */
function grepDist(dist, pattern, { fixed = false } = {}) {
  const args = ['-rl', fixed ? '-F' : '-E', '--include=*.mjs', '--include=*.js', pattern, dist];
  try {
    const out = execFileSync('grep', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, files: out.split('\n').filter(Boolean) };
  } catch (err) {
    if (err && err.status === 1) return { ok: true, files: [] };
    return { ok: false, error: err?.stderr?.toString?.().trim() || err?.message || 'grep failed' };
  }
}

/** Read every file that defines `symbol` and return their joined text. */
function readMatching(dist, pattern) {
  const hit = grepDist(dist, pattern);
  if (!hit.ok) return { ok: false, error: hit.error };
  let text = '';
  for (const f of hit.files) { try { text += fs.readFileSync(f, 'utf8'); } catch { /* unreadable chunk */ } }
  return { ok: true, files: hit.files, text };
}

/**
 * EVERY occurrence of a declaration, each as its own slice — never the first
 * occurrence of a concatenation.
 *
 * WHY THIS IS NOT `readMatching(...).indexOf(...)`: upstream ships the SAME
 * function twice, once in a readable chunk and once inside the minified
 * `dist/worker/worker.mjs` mega-bundle, and `grep -rl` returns them in
 * filesystem traversal order — which differs between macOS and Linux. Slicing
 * from the first occurrence therefore examined the readable copy on a developer
 * Mac and the MINIFIED copy on a CI runner, for the same openclaw version. The
 * minified copy spells its string literals with backticks, so a search for
 * `"entries"` found nothing and the check reported a contract break that did not
 * exist. Same version, opposite verdicts, decided by the filesystem: that is a
 * broken instrument, not a broken contract.
 *
 * So: yield every occurrence, let the caller accept if ANY of them proves the
 * contract, and compare string literals through `quoted()` below so the minified
 * spelling counts too.
 */
function bodiesFor(dist, declPattern, sliceLength = 1500) {
  const hit = grepDist(dist, declPattern);
  if (!hit.ok) return { ok: false, error: hit.error };
  const decl = new RegExp(declPattern, 'g');
  const bodies = [];
  for (const file of hit.files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    decl.lastIndex = 0;
    let m;
    while ((m = decl.exec(text)) !== null) {
      bodies.push({ file, body: text.slice(m.index, m.index + sliceLength) });
      decl.lastIndex = m.index + 1;
      if (bodies.length > 64) break; // a pathological match count is not evidence
    }
  }
  return { ok: true, files: hit.files, bodies };
}

/**
 * The index of a string literal, whichever way it is quoted. Minified chunks use
 * backticks where the readable source uses double quotes, and a check that only
 * knows one spelling silently measures the wrong thing.
 */
function quotedIndex(haystack, literal) {
  let best = -1;
  for (const q of ['"', "'", '`']) {
    const at = haystack.indexOf(q + literal + q);
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }
  return best;
}
function hasQuoted(haystack, literal) { return quotedIndex(haystack, literal) >= 0; }

/* ──────────────────────────────── results ───────────────────────────────── */

const results = [];
/** hard: a FAIL exits 1. soft: reported, never gating. */
function record(name, status, detail, { hard = true } = {}) {
  results.push({ name, status, detail, hard });
}
function pass(name, detail) { record(name, 'PASS', detail); }
function fail(name, detail) { record(name, 'FAIL', detail); }
function warn(name, detail) { record(name, 'WARN', detail, { hard: false }); }
function info(name, detail) { record(name, 'INFO', detail, { hard: false }); }
/** The instrument did not run. Never reported as a broken contract. */
function undetermined(name, detail) { record(name, 'UNDETERMINED', detail); }

function requireAll(schema, expected) {
  const req = Array.isArray(schema?.required) ? schema.required : [];
  return expected.filter((k) => !req.includes(k));
}

/* ──────────────────────────────── the checks ────────────────────────────── */

async function main() {
  const found = resolveDist();
  if (!found) {
    const msg = `No openclaw dist found. Searched: ${sourcesTried.join(' | ')}. `
      + `Set OPENCLAW_DIST to the dist directory to check a specific install.`;
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, reason: 'dist-not-found', sourcesTried }, null, 2));
    else console.error(`[openclaw-contract-check] UNDETERMINED — ${msg}`);
    process.exit(1);
  }
  const { dist, pkgDir } = found;
  let version = found.version;
  if (!version) { try { version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version; } catch { /* unversioned */ } }

  // The protocol module is the instrument. If it will not import, nothing below
  // is evidence about any contract.
  let proto;
  const protoPath = path.join(dist, 'gateway', 'protocol', 'index.js');
  try { proto = await import(pathToFileURL(protoPath).href); }
  catch (err) {
    const msg = `Could not import the gateway protocol module at ${protoPath}: ${err?.message}. `
      + `Every schema assertion below is UNDETERMINED, not failed.`;
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, reason: 'protocol-unimportable', dist, version, error: String(err?.message) }, null, 2));
    else console.error(`[openclaw-contract-check] UNDETERMINED — ${msg}`);
    process.exit(1);
  }

  // ── 1. chat.send params ────────────────────────────────────────────────
  // The client's send path writes this schema. `model` has never been a field
  // on it: the per-session model is an attribute of the SESSION, set at
  // sessions.create / modelOverride, and a closed schema rejects the whole
  // call if one is smuggled into a send.
  {
    const name = 'ChatSendParamsSchema';
    const s = proto.ChatSendParamsSchema;
    if (!s) fail(name, `not exported by ${protoPath}`);
    else {
      const problems = [];
      if (s.additionalProperties !== false) problems.push(`additionalProperties is ${JSON.stringify(s.additionalProperties)}, expected false (the schema must stay CLOSED)`);
      const missing = requireAll(s, ['sessionKey', 'message', 'idempotencyKey']);
      if (missing.length) problems.push(`required is missing ${missing.join(', ')} (got ${JSON.stringify(s.required)})`);
      if (Object.prototype.hasOwnProperty.call(s.properties ?? {}, 'model')) problems.push('a `model` property APPEARED on chat.send — per-send model selection is a new contract; review src/lib/openclaw/client.ts before adopting it');
      problems.length ? fail(name, problems.join('; ')) : pass(name, `closed; required=[${s.required.join(',')}]; no model field`);
    }
  }

  // ── 2. chat.history handler + params ───────────────────────────────────
  // This is the method `getSessionHistory()` calls. `sessions.history` does not
  // exist (see check 3b) — if this handler ever goes, history readback in the
  // interview turn route dies silently.
  {
    const name = 'chat.history handler + params';
    const s = proto.ChatHistoryParamsSchema;
    const reg = readMatching(dist, "[\"'`]chat\\.history[\"'`]\\s*:");
    if (!s) fail(name, 'ChatHistoryParamsSchema is not exported by the protocol module');
    else if (!reg.ok) undetermined(name, `params schema present, but the handler search failed: ${reg.error}`);
    else if (!reg.files.length) fail(name, `no handler registration ("chat.history":) found anywhere under ${dist}`);
    else {
      const missing = requireAll(s, ['sessionKey']);
      missing.length
        ? fail(name, `params.required is missing ${missing.join(', ')} (got ${JSON.stringify(s.required)})`)
        : pass(name, `handler registered in ${reg.files.length} chunk(s); params require sessionKey`);
    }
  }

  // ── 3. sessions.list result carries `sessions` ─────────────────────────
  // THE defect that made listSessions() return an object to callers expecting
  // an array. The result builder is the contract: the payload is an envelope
  // and the array lives under `sessions`.
  {
    const name = 'sessions.list result envelope';
    const hit = readMatching(dist, 'function buildSessionsListResult');
    if (!hit.ok) undetermined(name, `search failed: ${hit.error}`);
    else if (!hit.files.length) fail(name, `buildSessionsListResult not found under ${dist} — the sessions.list result shape can no longer be proved; re-verify src/lib/openclaw/client.ts listSessions() by hand`);
    else if (!/\bsessions\b/.test(hit.text)) fail(name, 'buildSessionsListResult no longer mentions a `sessions` key');
    else pass(name, `buildSessionsListResult returns an envelope with a \`sessions\` key (${hit.files.length} chunk(s)) — listSessions() must keep unwrapping it`);
  }

  // ── 3b. sessions.history must stay ABSENT ──────────────────────────────
  // Recorded as INFO, not a gate: if upstream ever ADDS it, that is news, not a
  // break. The client calls chat.history either way.
  {
    const name = 'sessions.history (expected absent)';
    const hit = grepDist(dist, "[\"'`]sessions\\.history[\"'`]");
    if (!hit.ok) undetermined(name, `search failed: ${hit.error}`);
    else if (!hit.files.length) pass(name, 'absent, as expected — chat.history is the real method');
    else info(name, `a sessions.history method now appears in ${hit.files.length} chunk(s); the client deliberately uses chat.history`);
  }

  // ── 4. sessions.create accepts label + model ───────────────────────────
  {
    const name = 'SessionsCreateParamsSchema';
    const s = proto.SessionsCreateParamsSchema;
    if (!s) fail(name, 'not exported by the protocol module');
    else {
      const props = Object.keys(s.properties ?? {});
      const missing = ['label', 'model'].filter((k) => !props.includes(k));
      missing.length
        ? fail(name, `properties are missing ${missing.join(', ')} — createSession() rides attribution on \`label\``)
        : pass(name, 'accepts label and model');
    }
  }

  // ── 5. sessions.send required = [key, message] ─────────────────────────
  // The exact shape sendMessage() must produce. `{session_id, content}` is
  // rejected outright by this closed schema.
  {
    const name = 'SessionsSendParamsSchema';
    const s = proto.SessionsSendParamsSchema;
    if (!s) fail(name, 'not exported by the protocol module');
    else {
      const req = Array.isArray(s.required) ? [...s.required].sort() : [];
      const problems = [];
      if (s.additionalProperties !== false) problems.push(`additionalProperties is ${JSON.stringify(s.additionalProperties)}, expected false`);
      if (req.join(',') !== 'key,message') problems.push(`required is [${req.join(',')}], expected exactly [key,message] — sendMessage() sends {key,message}`);
      problems.length ? fail(name, problems.join('; ')) : pass(name, 'closed; required=[key,message]');
    }
  }

  // ── 6. failover reasons ────────────────────────────────────────────────
  {
    const name = 'FAILOVER_REASONS + TRANSIENT_FALLBACK_REASONS';
    const hit = readMatching(dist, 'const FAILOVER_REASONS = \\[');
    const transient = grepDist(dist, 'TRANSIENT_FALLBACK_REASONS');
    if (!hit.ok) undetermined(name, `FAILOVER_REASONS search failed: ${hit.error}`);
    else if (!transient.ok) undetermined(name, `TRANSIENT_FALLBACK_REASONS search failed: ${transient.error}`);
    else if (!hit.files.length) fail(name, `FAILOVER_REASONS not found under ${dist}`);
    else {
      const problems = [];
      if (!hasQuoted(hit.text, 'rate_limit')) problems.push('FAILOVER_REASONS no longer lists "rate_limit" — provider rate limits would stop failing over');
      if (!transient.files.length) problems.push('TRANSIENT_FALLBACK_REASONS not found anywhere in the dist');
      problems.length ? fail(name, problems.join('; ')) : pass(name, 'FAILOVER_REASONS includes "rate_limit"; TRANSIENT_FALLBACK_REASONS present');
    }
  }

  // ── 7. agents.entries wins over agents.list ────────────────────────────
  // The roster precedence the dashboard's agent count depends on: a config that
  // declares `agents.entries` must be read from entries, and `agents.list`
  // ignored. Anchored on readAgentRosterProperty, which is where the rule lives
  // and is byte-identical across 2026.9.4 and 2026.9.5 — NOT on
  // listAgentEntries, whose body upstream refactored into a helper between those
  // versions without changing the rule. Every occurrence is examined and ANY one
  // proving the order is enough, because the same function ships twice (readable
  // chunk + minified bundle) in an order the filesystem decides.
  {
    const name = 'agents roster precedence (entries over list)';
    const found = bodiesFor(dist, 'function readAgentRosterProperty');
    if (!found.ok) undetermined(name, `search failed: ${found.error}`);
    else if (!found.bodies.length) fail(name, `readAgentRosterProperty not found under ${dist} — roster precedence can no longer be proved`);
    else {
      let proved = null;
      const seen = [];
      for (const { file, body } of found.bodies) {
        const entriesAt = quotedIndex(body, 'entries');
        const listAt = quotedIndex(body, 'list');
        if (entriesAt < 0 || listAt < 0) { seen.push(`${path.basename(file)}: missing one of the branches`); continue; }
        if (entriesAt > listAt) { seen.push(`${path.basename(file)}: list is checked BEFORE entries`); continue; }
        proved = file;
        break;
      }
      // The entries roster must still be read as a keyed record. Both the
      // readable and the minified copy spell this the same way.
      const consumer = grepDist(dist, 'Object\\.entries\\(\\s*roster\\.value\\s*\\)');
      if (!proved) fail(name, `no copy of readAgentRosterProperty checks "entries" before "list" (${seen.join('; ') || 'no readable body'})`);
      else if (!consumer.ok) undetermined(name, `precedence proved in ${path.basename(proved)}, but the Object.entries consumer search failed: ${consumer.error}`);
      else if (!consumer.files.length) fail(name, 'no `Object.entries(roster.value)` consumer found — the entries roster may no longer be read as a keyed record');
      else pass(name, `\`entries\` is checked before \`list\` (proved in ${path.basename(proved)} of ${found.bodies.length} copies); read with Object.entries(roster.value)`);
    }
  }

  // ── 8. agents.defaults.maxConcurrent default — REPORTED, never gating ──
  // The formula changed between 2026.9.4 (clamp to 8..16) and 2026.9.5
  // (8 or cpus x 4, unbounded above). A box that sets no explicit value gets a
  // DIFFERENT concurrency ceiling purely from upgrading, which is a capacity
  // change nobody asked for. Reported so the number is visible, warned when the
  // box has not pinned it. Every copy is tried, first one that parses wins.
  {
    const name = 'agents.defaults.maxConcurrent default';
    const found = bodiesFor(dist, 'function resolveDefaultAgentMaxConcurrent', 1200);
    if (!found.ok) undetermined(name, `search failed: ${found.error}`);
    else if (!found.bodies.length) warn(name, `resolveDefaultAgentMaxConcurrent not found under ${dist} — the default cannot be reported`);
    else {
      const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
      let formula = 'unrecognised';
      let effective = null;
      for (const { body } of found.bodies) {
        const perCpu = /availableParallelism\s*\*\s*([A-Za-z_$][\w$]*|\d+)/.exec(body);
        if (/Math\.min\(/.test(body) && /MAX_AGENT_MAX_CONCURRENT|,\s*16\b/.test(body)) {
          formula = 'min(MAX=16, max(MIN=8, cpus))';
          effective = Math.min(16, Math.max(8, cpus));
          break;
        }
        if (perCpu) {
          const token = perCpu[1];
          // The multiplier may be a literal or a constant declared elsewhere in
          // the same chunk; both spellings are resolved, neither is guessed.
          const lit = /^\d+$/.test(token)
            ? Number(token)
            : Number(new RegExp(`${token}\\s*=\\s*(\\d+)`).exec(found.bodies.map((b) => b.body).join('\n'))?.[1] ?? NaN);
          formula = `max(MIN=8, cpus x ${Number.isFinite(lit) ? lit : token})`;
          if (Number.isFinite(lit)) { effective = Math.max(8, cpus * lit); break; }
        }
      }
      info(name, `formula: ${formula}; this box has ${cpus} cpu(s)${effective === null ? '' : ` → default ${effective}`}`);

      // A box with no explicit value inherits whatever the installed version
      // decides — and that number just changed across a patch release.
      const cfgPath = process.env.OPENCLAW_CONFIG
        || path.join(process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw'), 'openclaw.json');
      let explicit;
      try { explicit = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))?.agents?.defaults?.maxConcurrent; } catch { explicit = undefined; }
      if (explicit === undefined) {
        warn(`${name} (this box)`, `${cfgPath} sets no agents.defaults.maxConcurrent, so this box inherits the version default${effective === null ? '' : ` (${effective})`}. Pin it if the concurrency ceiling matters — it changed between 2026.9.4 and 2026.9.5.`);
      } else {
        info(`${name} (this box)`, `${cfgPath} pins agents.defaults.maxConcurrent=${explicit}; the version default does not apply`);
      }
    }
  }

  // ── 9. models.providers.<n>.apiKey ─────────────────────────────────────
  {
    const name = 'models.providers.*.apiKey';
    const hit = grepDist(dist, 'models\\.providers\\.\\*\\.apiKey', { fixed: false });
    if (!hit.ok) undetermined(name, `search failed: ${hit.error}`);
    else if (!hit.files.length) fail(name, `the models.providers.*.apiKey config field is no longer described anywhere under ${dist} — provider key wiring may have moved`);
    else pass(name, `present in ${hit.files.length} chunk(s)`);
  }

  // ── 10. per-session model override ─────────────────────────────────────
  // runtime-model.ts reports the model a session is ACTUALLY running on. That
  // answer comes from the override fields this resolver reads.
  {
    const name = 'resolveSessionModelRef (per-session model override)';
    const hit = readMatching(dist, 'function resolveSessionModelRef');
    if (!hit.ok) undetermined(name, `search failed: ${hit.error}`);
    else if (!hit.files.length) fail(name, `resolveSessionModelRef not found under ${dist}`);
    else {
      const missing = ['modelOverride', 'providerOverride'].filter((f) => !hit.text.includes(f));
      missing.length
        ? fail(name, `resolveSessionModelRef no longer reads entry.${missing.join(' / entry.')}`)
        : pass(name, 'reads entry.modelOverride and entry.providerOverride');
    }
  }

  /* ───────────────────────────────── report ─────────────────────────────── */

  const hardFailures = results.filter((r) => r.hard && r.status !== 'PASS');
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: hardFailures.length === 0, dist, version, results }, null, 2));
  } else {
    const w = Math.max(...results.map((r) => r.name.length), 8);
    console.log(`\nOpenClaw contract check — openclaw ${version ?? 'unknown version'}`);
    console.log(`dist: ${dist}\n`);
    console.log(`${'CONTRACT'.padEnd(w)}  STATUS         DETAIL`);
    console.log(`${'-'.repeat(w)}  -------------  ${'-'.repeat(60)}`);
    for (const r of results) console.log(`${r.name.padEnd(w)}  ${r.status.padEnd(13)}  ${r.detail}`);
    console.log('');
    if (hardFailures.length) {
      console.error(`FAILED — ${hardFailures.length} contract(s) no longer hold against openclaw ${version ?? '(unknown)'}:`);
      for (const r of hardFailures) console.error(`  - ${r.name}: ${r.detail}`);
      console.error('\nThe gateway client in src/lib/openclaw/client.ts is written against these contracts. Fix the client before deploying against this version.');
    } else {
      console.log(`OK — all ${results.filter((r) => r.status === 'PASS').length} hard contracts hold against openclaw ${version ?? '(unknown)'}.`);
    }
  }
  process.exit(hardFailures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`[openclaw-contract-check] UNDETERMINED — the check itself threw: ${err?.stack || err}`);
  process.exit(1);
});
