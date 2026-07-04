/**
 * zhe-web-lib.mjs — sandbox + web-path driver for the P3-8 prove-zhe web e2e.
 *
 * This is the load-bearing half of the harness. It:
 *   1. builds an ISOLATED sandbox (a throwaway HOME) and asserts, LOUDLY and
 *      BEFORE any script runs, that every interview-state path the app + the
 *      Skill-23 shell scripts resolve lands INSIDE that sandbox — because
 *      update-interview-state.sh / record-dept-decision.sh / build-workforce.py
 *      resolve /data-else-$HOME and IGNORE the app's workspace override, so an
 *      un-sandboxed run would corrupt the operator's live workspace;
 *   2. neutralizes the auto-closeout build-kick by stripping any PATH entry that
 *      resolves an `openclaw` binary (the --complete script only sends a Telegram
 *      [WORKFORCE-RESUME] kick when `command -v openclaw` succeeds AND QC passes);
 *   3. drives the REAL web path through the app's own interview seam
 *      (src/lib/interview/seam.ts) — the exact server layer every
 *      /api/interview/* route calls — recording provenanced decisions and
 *      pressing update-interview-state.sh --complete;
 *   4. exposes probes into the REAL Python enforcers (via zhe_gate_probes.py) so
 *      the four ZHE gates are proven against the actual build gate, not a mirror.
 *
 * NOTHING here ever touches ~/.openclaw or ~/.clawdbot: HOME is repointed to a
 * fresh mkdtemp per sandbox and the resolved paths are asserted in-bounds first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as seam from '../../src/lib/interview/seam.ts';
import {
  buildStatePath,
  resolveWorkspaceDir,
  companyDiscoveryDir,
} from '../../src/lib/interview/paths.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBES = path.join(HERE, 'zhe_gate_probes.py');

/* ── Captured at import time, BEFORE any sandbox repoints HOME ─────────────── */
const REAL_HOME = process.env.HOME || os.homedir();
export const SKILL_SCRIPTS =
  (process.env.OPENCLAW_SKILL23_SCRIPTS && process.env.OPENCLAW_SKILL23_SCRIPTS.trim()) ||
  path.join(REAL_HOME, '.openclaw', 'skills', '23-ai-workforce-blueprint', 'scripts');

/** True when the Skill-23 enforcer scripts are installed on this box. The full
 *  gate proof needs the REAL scripts; where they are absent (e.g. a bare CI
 *  checkout of command-center only) the suite skips LOUDLY rather than fake-pass. */
export function skill23Available() {
  return (
    fs.existsSync(path.join(SKILL_SCRIPTS, 'list-canonical-departments.py')) &&
    fs.existsSync(path.join(SKILL_SCRIPTS, 'update-interview-state.sh')) &&
    fs.existsSync(path.join(SKILL_SCRIPTS, 'record-dept-decision.sh')) &&
    fs.existsSync(path.join(SKILL_SCRIPTS, 'build-workforce.py')) &&
    fs.existsSync(path.join(SKILL_SCRIPTS, 'department-floor.py')) &&
    fs.existsSync(path.join(SKILL_SCRIPTS, 'prove-zhe.py'))
  );
}

/**
 * Compute a PATH that keeps every tool the Skill-23 scripts need (bash, python3,
 * jq, node, coreutils) but drops any directory that resolves an `openclaw`
 * binary — so the --complete auto-closeout can never fire a real Telegram kick
 * from a test box. Portable: on CI (no openclaw) the PATH is unchanged.
 */
function safePath() {
  const entries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const kept = entries.filter((dir) => {
    try {
      return !fs.existsSync(path.join(dir, 'openclaw'));
    } catch {
      return true;
    }
  });
  // Guarantee the core system dirs are present even if the original PATH was thin.
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (!kept.includes(d) && fs.existsSync(d)) kept.push(d);
  }
  return kept.join(path.delimiter);
}

const SAFE_PATH = safePath();

/**
 * Create a fresh sandbox: a throwaway HOME with .openclaw/workspace seeded, and
 * process env repointed so BOTH the app seam and the Skill-23 shell scripts
 * resolve state inside it. Then run the MANDATORY in-bounds assertion.
 *
 * Returns { home, workspace, buildState, companyDiscovery, cleanup }.
 */
export function makeSandbox(label = 'zhe-web') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const workspace = path.join(home, '.openclaw', 'workspace');
  const cd = path.join(workspace, 'company-discovery');
  fs.mkdirSync(cd, { recursive: true });
  const bs = path.join(workspace, '.workforce-build-state.json');
  fs.writeFileSync(bs, '{}\n');

  // Repoint BOTH resolution surfaces at the sandbox.
  process.env.HOME = home;
  process.env.OPENCLAW_WORKSPACE_ROOT = workspace; // app seam override
  process.env.OPENCLAW_SKILL23_SCRIPTS = SKILL_SCRIPTS; // app seam script dir
  process.env.PATH = SAFE_PATH; // openclaw-free -> no Telegram kick

  assertSandboxed(home, workspace);

  return {
    home,
    workspace,
    buildState: bs,
    companyDiscovery: cd,
    cleanup() {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * MANDATORY SAFETY GATE. Aborts the whole run (throws) unless every path the app
 * and the Skill-23 scripts will write is provably inside the throwaway HOME, and
 * HOME is not the operator's real home. Also confirms `openclaw` is unreachable
 * on the child PATH. Prints the resolved paths so a reviewer sees the in-bounds
 * proof BEFORE any script fires.
 */
export function assertSandboxed(home, workspace) {
  const inside = (p) => {
    const rp = path.resolve(p);
    return rp === path.resolve(home) || rp.startsWith(path.resolve(home) + path.sep);
  };

  const appWorkspace = resolveWorkspaceDir(); // what the app seam will read/write
  const appBuildState = buildStatePath();
  const appDiscovery = companyDiscoveryDir();

  // eslint-disable-next-line no-console
  console.log(
    `[sandbox] HOME=${home}\n` +
      `[sandbox] app workspace  = ${appWorkspace}\n` +
      `[sandbox] app buildState = ${appBuildState}\n` +
      `[sandbox] app discovery  = ${appDiscovery}`,
  );

  if (path.resolve(home) === path.resolve(REAL_HOME)) {
    throw new Error(`REFUSING TO RUN: sandbox HOME equals the real HOME (${REAL_HOME}).`);
  }
  for (const [name, p] of [
    ['workspace(param)', workspace],
    ['app.workspace', appWorkspace],
    ['app.buildState', appBuildState],
    ['app.companyDiscovery', appDiscovery],
  ]) {
    if (!inside(p)) {
      throw new Error(
        `REFUSING TO RUN: ${name} resolves OUTSIDE the sandbox HOME.\n` +
          `  sandbox HOME = ${home}\n  ${name} = ${p}\n` +
          `An un-sandboxed Skill-23 script write would corrupt the operator's live workspace.`,
      );
    }
  }
  // The scripts must NOT be able to fire a Telegram build-kick from a test box.
  let openclawResolved = '';
  try {
    openclawResolved = execFileSync('bash', ['-lc', 'command -v openclaw || true'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: SAFE_PATH },
    }).trim();
  } catch {
    openclawResolved = '';
  }
  if (openclawResolved) {
    throw new Error(
      `REFUSING TO RUN: an 'openclaw' binary is still reachable on the child PATH ` +
        `(${openclawResolved}); the --complete kick could send a real Telegram message.`,
    );
  }
}

/* ── Transcript writers ───────────────────────────────────────────────────── */

const GENUINE_QA = [
  ['What does your company do?', 'We run a boutique coffee roastery serving wholesale and retail across three states, with about forty staff.'],
  ['Who are your customers?', 'Independent cafes, regional grocery chains, and direct-to-consumer subscribers who want single-origin beans.'],
  ['What are your biggest operational bottlenecks?', 'Order fulfilment during seasonal spikes and coordinating green-bean sourcing with importers.'],
  ['What would you automate first?', 'Customer support triage and the weekly production scheduling that eats a full day.'],
  ['How do you handle marketing today?', 'Mostly founder-led social plus an email list of roughly nine thousand subscribers.'],
];

/** Write a GENUINE transcript (>=3 **Q:** blocks, >512 bytes, no synthetic header). */
export function writeGenuineTranscript(sb) {
  const blocks = GENUINE_QA.map(
    ([q, a]) => `**Q:** ${q}\n**A:** ${a}\n**Logged:** July 04, 2026\n`,
  );
  const text = `# Workforce Interview Answers\n\n${blocks.join('\n---\n')}\n`;
  fs.writeFileSync(path.join(sb.companyDiscovery, 'workforce-interview-answers.md'), text);
}

/** Write a SYNTHETIC (fabricated, non-interactive) transcript — the header that
 *  build-workforce stamps on config-synthesized answers. It must NOT count as a
 *  genuine interview even if interviewComplete is force-set (fabrication guard). */
export function writeSyntheticTranscript(sb) {
  const text =
    '# Workforce Interview Answers (Non-Interactive)\n\n' +
    GENUINE_QA.map(([q, a]) => `**Q:** ${q}\n**A:** ${a}\n`).join('\n---\n') +
    '\n';
  fs.writeFileSync(path.join(sb.companyDiscovery, 'workforce-interview-answers.md'), text);
}

/* ── Web-path driver (uses the REAL app seam) ─────────────────────────────── */

/**
 * Drive the interview web path exactly as the /api/interview/* routes do, via
 * the app seam:
 *   • record a provenanced YES/NO/LATER for every expected canonical dept
 *     (record-dept-decision.sh), with one provenanced NO to exercise the decline
 *     path — EXCEPT any id in opts.skipIds (left undecided => coverage gap), and
 *   • optionally press update-interview-state.sh --complete.
 *
 * @returns { canonical, expected, declineId }
 */
export async function driveWebPath(sb, opts = {}) {
  const { skipIds = [], complete = true, ownerId = 'owner@fixture.test' } = opts;
  const canonical = await seam.listCanonicalDepartments();
  const expected = seam.computeExpectedDecisionIds(canonical);
  assert.ok(expected.length > 0, 'expected canonical decision set must be non-empty');

  const skip = new Set(skipIds.map(seam.norm));
  // Make the LAST expected dept a provenanced decline (honored NO), unless skipped.
  const declineId = expected[expected.length - 1];

  for (const id of expected) {
    if (skip.has(seam.norm(id))) continue;
    const decision = id === declineId ? 'no' : 'yes';
    await seam.recordDeptDecision({ dept: id, decision, by: ownerId, source: 'owner-interview' });
  }

  if (complete) {
    await seam.updateInterviewState({ complete: true });
  }
  return { canonical, expected, declineId };
}

/** Hand-write a BARE (un-provenanced) decline directly into build-state,
 *  bypassing record-dept-decision.sh — the exact fabrication vector gate #8
 *  must reject (WG-5). Returns the id written. */
export function injectBareDecline(sb, id) {
  const raw = JSON.parse(fs.readFileSync(sb.buildState, 'utf-8'));
  raw.canonicalReconciliation = raw.canonicalReconciliation || {};
  raw.canonicalReconciliation.decisions = raw.canonicalReconciliation.decisions || {};
  raw.canonicalReconciliation.decisions[id] = 'no'; // bare string, no provenance
  fs.writeFileSync(sb.buildState, JSON.stringify(raw, null, 2));
  return id;
}

/** Hand-write a BARE (un-provenanced) YES for an id — a fake "coverage" attempt
 *  that must NOT satisfy the decision-coverage gate (must be provenanced). */
export function injectBareYes(sb, id) {
  const raw = JSON.parse(fs.readFileSync(sb.buildState, 'utf-8'));
  raw.canonicalReconciliation = raw.canonicalReconciliation || {};
  raw.canonicalReconciliation.decisions = raw.canonicalReconciliation.decisions || {};
  raw.canonicalReconciliation.decisions[id] = 'yes';
  fs.writeFileSync(sb.buildState, JSON.stringify(raw, null, 2));
  return id;
}

/* ── Real-enforcer probes (Python) ────────────────────────────────────────── */

function runProbe(args) {
  const out = execFileSync('python3', [PROBES, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: SAFE_PATH },
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = out.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

/** REAL build-workforce owner-consent gate. {refused, exit} — exit 87 == pending. */
export function probeConsentGate() {
  return runProbe(['consent', SKILL_SCRIPTS]);
}

/** REAL build-workforce._canonical_decline_set on a state file.
 *  {declined:[...], rejectedWarning:bool}. */
export function probeDeclineClassifier(stateJsonPath) {
  return runProbe(['decline', SKILL_SCRIPTS, stateJsonPath]);
}

/** REAL department-floor expected floor (no declines) for an (empty) depts dir. */
export function probeFloorCount(departmentsDir) {
  return runProbe(['floor-count', SKILL_SCRIPTS, departmentsDir]);
}

/** Build a full Zero-Human-Everything oc-root fixture around a completed
 *  build-state, so prove-zhe.py --local returns overall_pass. */
export function buildZheFixture(ocRoot, srcBuildState, nPersonas = 54, nIndexRows = 4413) {
  return runProbe(['build-zhe-fixture', ocRoot, srcBuildState, String(nPersonas), String(nIndexRows)]);
}

/**
 * Run prove-zhe.py --local against an oc-root, from a SANDBOX COPY of the script
 * so its receipt is written into the sandbox (never the live skill tree). Returns
 * { exit, receipt } where receipt is the parsed receipt JSON.
 */
export function runProveZhe(sb, ocRoot) {
  const scriptCopy = path.join(sb.home, 'prove-zhe.py');
  fs.copyFileSync(path.join(SKILL_SCRIPTS, 'prove-zhe.py'), scriptCopy);
  let exit = 0;
  try {
    execFileSync('python3', [scriptCopy, '--local', ocRoot], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: SAFE_PATH },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    exit = typeof e.status === 'number' ? e.status : 1;
  }
  const receiptsDir = path.join(sb.home, 'receipts');
  const files = fs.existsSync(receiptsDir)
    ? fs.readdirSync(receiptsDir).filter((f) => f.endsWith('.json')).sort()
    : [];
  assert.ok(files.length > 0, 'prove-zhe must write a receipt into the sandbox');
  const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir, files[files.length - 1]), 'utf-8'));
  // Prove the receipt never escaped the sandbox.
  assert.ok(
    path.resolve(receiptsDir).startsWith(path.resolve(sb.home) + path.sep),
    'prove-zhe receipt must live inside the sandbox',
  );
  return { exit, receipt };
}

/* ── Aggregate ZHE web-build verdict (for the seeded-violation demo) ───────── */

/**
 * Read the CURRENT sandbox state and return an aggregate compliance verdict over
 * the interview-side ZHE gates, using the real seam + the real Python consent
 * gate. Used to demonstrate the harness goes RED on a seeded gate violation.
 */
export async function evaluateZheWebBuild() {
  const snapshot = await seam.getInterviewGateSnapshot();
  const consent = probeConsentGate();
  const gates = {
    // Gate #2 (consent/exit-87): a genuine transcript exists -> build not refused.
    consent: consent.refused === false,
    // Gate #3 (coverage/exit-88): every expected dept has a provenanced decision.
    decisionCoverage: snapshot.flags.decisionCoverageComplete === true,
    // Gate #8: zero un-provenanced declines.
    declineProvenance: snapshot.flags.noUnprovenancedDeclines === true,
    // Gate #2 positive: a genuine (non-synthetic) transcript is present.
    genuineTranscript: snapshot.flags.genuineTranscriptReady === true,
  };
  const compliant = Object.values(gates).every(Boolean);
  return { compliant, gates, consentExit: consent.exit, snapshot };
}

/* Re-export the seam so the suite drives the very same module. */
export { seam, test, assert };
