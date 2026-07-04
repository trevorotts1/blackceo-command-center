/**
 * prove-zhe-web.e2e.mjs — P3-8: prove a completed interview through THIS app
 * produces a Zero-Human-Everything-compliant build state, and FAIL loudly if any
 * ZHE gate is bypassable from the web path.
 *
 * WHAT IT PROVES (all against a SANDBOXED throwaway HOME — see zhe-web-lib.mjs):
 *   • The web path (app interview seam -> the SAME Skill-23 shell scripts the
 *     Telegram agent presses) drives consent -> genuine transcript (>=3 Q/A) ->
 *     full provenanced decision coverage -> update-interview-state.sh --complete,
 *     landing interviewComplete=true.
 *   • The four ZHE gates hold against the REAL enforcers and CANNOT be bypassed:
 *       Gate #2  consent / exit 87  (build-workforce._enforce_consent_or_refuse)
 *       Gate #3  decision-coverage / exit-88 web refusal  (seam + complete route)
 *       Gate #8  provenanced-decline (build-workforce._canonical_decline_set)
 *       Expected-set equality (seam == list-canonical == department-floor; no
 *                              hardcoded 28/29 — version-safe floor)
 *   • prove-zhe.py --local: EXEMPT path passes for a not-completed box, and
 *     overall_pass on a full-ZHE web-built company fixture.
 *   • SEEDED VIOLATIONS make the aggregate ZHE verdict go RED (loud failure).
 *
 * RUN (CI, deps installed):   node --import tsx --test tests/e2e/prove-zhe-web.e2e.mjs
 * RUN (local, zero deps):     node --experimental-strip-types \
 *                               --import ./tests/e2e/ts-register.mjs \
 *                               --test tests/e2e/prove-zhe-web.e2e.mjs
 * BUILD-VERDICT CLI (seeded-violation demo, exits non-zero on a non-compliant
 * build):                     node ... tests/e2e/prove-zhe-web.e2e.mjs --build[ --seed=<gate>]
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  test,
  assert,
  seam,
  SKILL_SCRIPTS,
  skill23Available,
  makeSandbox,
  assertSandboxed,
  writeGenuineTranscript,
  writeSyntheticTranscript,
  driveWebPath,
  injectBareDecline,
  injectBareYes,
  probeConsentGate,
  probeDeclineClassifier,
  probeFloorCount,
  buildZheFixture,
  runProveZhe,
  evaluateZheWebBuild,
} from './zhe-web-lib.mjs';

/* ── CLI build-verdict mode (seeded-violation demonstration) ───────────────── */
if (process.argv.includes('--build')) {
  await runBuildVerdictCli();
} else if (!skill23Available()) {
  test('prove-zhe web e2e — SKIPPED (Skill-23 enforcers not installed)', { skip: true }, () => {});
  // eslint-disable-next-line no-console
  console.error(
    `[prove-zhe-web] SKIPPED: Skill-23 scripts not found at ${SKILL_SCRIPTS}. ` +
      `Set OPENCLAW_SKILL23_SCRIPTS or check out the onboarding skill to run the full gate.`,
  );
} else {
  registerSuite();
}

/* ── The suite ─────────────────────────────────────────────────────────────── */
function registerSuite() {
  /* 0) The sandbox SAFETY gate itself must bite. ------------------------------ */
  test('0. sandbox safety gate refuses when interview paths escape HOME', () => {
    const home = fs.mkdtempSync(path.join(require_tmp(), 'zhe-escape-'));
    try {
      // Point the app workspace override OUTSIDE the sandbox HOME.
      const outside = fs.mkdtempSync(path.join(require_tmp(), 'zhe-outside-'));
      process.env.HOME = home;
      process.env.OPENCLAW_WORKSPACE_ROOT = outside;
      assert.throws(
        () => assertSandboxed(home, outside),
        /resolves OUTSIDE the sandbox HOME/,
        'the guard MUST refuse when the app workspace escapes the sandbox',
      );
      fs.rmSync(outside, { recursive: true, force: true });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  /* 1) GOOD RUN — full web path to interviewComplete, all gate flags green. ---- */
  test('1. GOOD RUN: web path -> genuine interview -> interviewComplete, gates green', async () => {
    const sb = makeSandbox('zhe-good');
    try {
      writeGenuineTranscript(sb);
      const { expected, declineId } = await driveWebPath(sb, { complete: false });

      // Pre-complete snapshot: all three UI gate flags are green.
      const snap = await seam.getInterviewGateSnapshot();
      assert.equal(snap.flags.genuineTranscriptReady, true, 'transcript must be genuine');
      assert.equal(snap.flags.decisionCoverageComplete, true, 'coverage must be complete');
      assert.equal(snap.flags.noUnprovenancedDeclines, true, 'no un-provenanced declines');
      assert.ok(snap.coverage.declined.includes(declineId), 'the provenanced NO is an honored decline');
      assert.equal(snap.coverage.missing.length, 0);

      // Press the SAME script the Telegram agent presses.
      await seam.updateInterviewState({ complete: true });
      const state = seam.readBuildState();
      assert.equal(state.interviewComplete, true, 'interviewComplete must be set by the script');
      assert.ok(state.interviewCompletedAt, 'interviewCompletedAt stamped');

      // Every recorded decision is a fully-provenanced object (no bare strings).
      const decisions = state.canonicalReconciliation.decisions;
      for (const id of expected) {
        assert.ok(seam.isProvenanced(decisions[id]), `decision for ${id} must be provenanced`);
      }
    } finally {
      sb.cleanup();
    }
  });

  /* 2) GATE #2 — consent / exit 87 (build-workforce fabrication guard). -------- */
  test('2. GATE consent/87: no/synthetic transcript refused (87); genuine passes', async () => {
    // (a) genuine transcript -> consent gate PASSES (not refused).
    let sb = makeSandbox('zhe-consent-ok');
    try {
      writeGenuineTranscript(sb);
      const ok = probeConsentGate();
      assert.equal(ok.refused, false, 'genuine transcript must pass the consent gate');
    } finally {
      sb.cleanup();
    }

    // (b) NO transcript at all -> REFUSED with exit 87.
    sb = makeSandbox('zhe-consent-none');
    try {
      const none = probeConsentGate();
      assert.equal(none.refused, true);
      assert.equal(none.exit, 87, 'missing interview must refuse with EXIT_INTERVIEW_PENDING=87');
    } finally {
      sb.cleanup();
    }

    // (c) BYPASS BLOCKED: synthetic (fabricated) transcript + a hand-forced
    //     interviewComplete=true flag must STILL refuse with 87 — a flag is not
    //     proof and the synthetic header never counts as a genuine interview.
    sb = makeSandbox('zhe-consent-synthetic');
    try {
      writeSyntheticTranscript(sb);
      const raw = JSON.parse(fs.readFileSync(sb.buildState, 'utf-8'));
      raw.interviewComplete = true; // force the flag — must not help
      fs.writeFileSync(sb.buildState, JSON.stringify(raw, null, 2));
      const bypass = probeConsentGate();
      assert.equal(bypass.refused, true, 'a synthetic transcript must NOT bypass consent');
      assert.equal(bypass.exit, 87);
    } finally {
      sb.cleanup();
    }
  });

  /* 3) GATE #3 — decision coverage / exit-88 web refusal. --------------------- */
  test('3. GATE coverage/88: complete when all decided; a gap blocks; bare YES does not count', async () => {
    // Full coverage -> complete (the complete route would proceed).
    let sb = makeSandbox('zhe-cov-full');
    try {
      writeGenuineTranscript(sb);
      await driveWebPath(sb, { complete: false });
      const snap = await seam.getInterviewGateSnapshot();
      assert.equal(snap.flags.decisionCoverageComplete, true);
    } finally {
      sb.cleanup();
    }

    // One undecided dept -> coverage incomplete (the complete route 409s
    // reconciliation_pending / exit-88), listing the missing id.
    sb = makeSandbox('zhe-cov-gap');
    try {
      writeGenuineTranscript(sb);
      const canonical = await seam.listCanonicalDepartments();
      const expected = seam.computeExpectedDecisionIds(canonical);
      const gapId = expected[0];
      await driveWebPath(sb, { complete: false, skipIds: [gapId] });
      let snap = await seam.getInterviewGateSnapshot();
      assert.equal(snap.flags.decisionCoverageComplete, false, 'a gap must block coverage');
      assert.ok(
        snap.coverage.missing.map(seam.norm).includes(seam.norm(gapId)),
        'the missing dept must be reported',
      );

      // BYPASS BLOCKED: a hand-written BARE yes must not satisfy coverage.
      injectBareYes(sb, gapId);
      snap = await seam.getInterviewGateSnapshot();
      assert.equal(
        snap.flags.decisionCoverageComplete,
        false,
        'a bare (un-provenanced) YES must NOT satisfy the coverage gate',
      );
    } finally {
      sb.cleanup();
    }
  });

  /* 4) GATE #8 — provenanced decline (real classifier + seam agree). ---------- */
  test('4. GATE decline/#8: provenanced NO honored; bare NO rejected by real classifier + seam', async () => {
    const sb = makeSandbox('zhe-decline');
    try {
      writeGenuineTranscript(sb);
      const { declineId } = await driveWebPath(sb, { complete: false });

      // Provenanced NO -> REAL build-workforce classifier HONORS it (declined set),
      // no rejection warning; seam agrees (declined, noUnprovenancedDeclines true).
      let py = probeDeclineClassifier(sb.buildState);
      assert.ok(
        py.declined.map(seam.norm).includes(seam.norm(declineId)),
        'the provenanced NO must be honored by the real Python classifier',
      );
      assert.equal(py.rejectedWarning, false, 'a provenanced NO must not warn');
      let snap = await seam.getInterviewGateSnapshot();
      assert.equal(snap.flags.noUnprovenancedDeclines, true);

      // BYPASS BLOCKED (WG-5): a hand-written BARE `decisions[id]='no'` is REJECTED
      // by BOTH the real classifier (dept stays in floor + warning) and the seam.
      const bareId = injectBareDecline(sb, 'compliance');
      py = probeDeclineClassifier(sb.buildState);
      assert.ok(
        !py.declined.map(seam.norm).includes(seam.norm(bareId)),
        'a bare un-provenanced NO must NOT be honored (fail-safe to larger floor)',
      );
      assert.equal(py.rejectedWarning, true, 'the real classifier must emit [DECLINE REJECTED]');
      snap = await seam.getInterviewGateSnapshot();
      assert.equal(
        snap.flags.noUnprovenancedDeclines,
        false,
        'the seam must also flag the un-provenanced decline',
      );
      assert.ok(
        snap.coverage.rejections.map(seam.norm).includes(seam.norm(bareId)),
        'the seam must classify the bare NO as a rejection, not a decline',
      );
    } finally {
      sb.cleanup();
    }
  });

  /* 5) EXPECTED-SET EQUALITY — no drift, no hardcoded 28/29. ------------------ */
  test('5. GATE expected-set: seam == list-canonical == department-floor; version-safe', async () => {
    const sb = makeSandbox('zhe-expected');
    try {
      const canonical = await seam.listCanonicalDepartments();
      const expected = seam.computeExpectedDecisionIds(canonical);
      const expectedSet = new Set(expected.map(seam.norm));

      // seam expected set == list-canonical mandatory ∪ universal-primary ids.
      const canonicalIds = [
        ...canonical.mandatory.map((d) => d.id),
        ...canonical.universal_primary_vertical.map((d) => d.id),
      ].map(seam.norm);
      assert.deepEqual(
        [...expectedSet].sort(),
        [...new Set(canonicalIds)].sort(),
        'seam expected set must equal the live canonical floor ids',
      );

      // Size tracks the LIVE floor (dynamic), never a hardcoded count.
      assert.equal(
        expected.length,
        canonical.floor,
        'expected count must equal the live floor',
      );
      assert.equal(
        canonical.floor,
        canonical.mandatory_count + canonical.universal_primary_count,
        'floor = mandatory + universal-primary',
      );

      // department-floor.py (no declines) reports the SAME expected floor.
      const emptyDepts = path.join(sb.home, 'empty-departments');
      fs.mkdirSync(emptyDepts, { recursive: true });
      const floor = probeFloorCount(emptyDepts);
      assert.equal(
        floor.expectedFloorCount,
        canonical.floor,
        'department-floor.py expected floor must equal list-canonical floor',
      );
      assert.deepEqual(
        [...new Set(floor.expectedFloor.map(seam.norm))].sort(),
        [...expectedSet].sort(),
        'department-floor expected ids must equal the seam expected set',
      );

      // The seam must NOT hardcode a canonical count (28/29): it derives the floor
      // from list-canonical-departments.py at runtime (version-safety, WG-8).
      const seamSrc = fs.readFileSync(
        path.join(process.cwd(), 'src/lib/interview/seam.ts'),
        'utf-8',
      );
      assert.ok(
        /listCanonicalDepartments/.test(seamSrc),
        'seam must derive the floor from listCanonicalDepartments',
      );
      // Strip block + line comments so the "no hardcoded 28/29" check inspects only
      // executable code (the doctrine comments deliberately mention "28/29").
      const seamCode = seamSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      assert.ok(
        !/\b(28|29)\b/.test(seamCode),
        'seam must not hardcode a canonical department count (28/29) in code',
      );
    } finally {
      sb.cleanup();
    }
  });

  /* 6) prove-zhe EXEMPT path — a not-completed box carries no ZHE obligation. -- */
  test('6. prove-zhe: EXEMPT path passes for a not-completed box (exit 0)', () => {
    const sb = makeSandbox('zhe-exempt');
    try {
      const ocRoot = path.join(sb.home, 'oc-exempt');
      fs.mkdirSync(path.join(ocRoot, 'workspace'), { recursive: true });
      fs.writeFileSync(path.join(ocRoot, 'openclaw.json'), JSON.stringify({ agents: { list: [] } }));
      fs.writeFileSync(
        path.join(ocRoot, 'workspace', '.workforce-build-state.json'),
        JSON.stringify({ interviewComplete: false }),
      );
      const { exit, receipt } = runProveZhe(sb, ocRoot);
      assert.equal(exit, 0, 'exempt box must exit 0');
      assert.equal(receipt.exempt, true);
      assert.equal(receipt.overall_pass, true);
      assert.equal(receipt.interview_complete, false);
    } finally {
      sb.cleanup();
    }
  });

  /* 7) prove-zhe overall_pass on the full-ZHE web-built company. -------------- */
  test('7. prove-zhe: overall_pass on the full-ZHE web-built company fixture', async () => {
    const sb = makeSandbox('zhe-full');
    try {
      // Drive the real web path to interviewComplete first.
      writeGenuineTranscript(sb);
      await driveWebPath(sb, { complete: true });
      const state = seam.readBuildState();
      assert.equal(state.interviewComplete, true);

      // Wrap it in a full Zero-Human-Everything oc-root (personas + section-tagged
      // index + Command Center board + registered dept agents + AGENTS.md).
      const ocRoot = path.join(sb.home, 'oc-full');
      const info = buildZheFixture(ocRoot, sb.buildState);
      assert.equal(info.personas, 54);

      const { exit, receipt } = runProveZhe(sb, ocRoot);
      assert.equal(receipt.exempt, false, 'a completed box is NOT exempt — it is held to the ZHE');
      assert.equal(receipt.interview_complete, true);
      for (const [name, chk] of Object.entries(receipt.checks)) {
        assert.equal(chk.pass, true, `ZHE check '${name}' must pass: ${chk.detail}`);
      }
      assert.equal(receipt.overall_pass, true, 'prove-zhe overall_pass on the web fixture');
      assert.equal(exit, 0);
    } finally {
      sb.cleanup();
    }
  });

  /* 8) SEEDED VIOLATIONS — the aggregate ZHE verdict must go RED. ------------- */
  test('8a. SEEDED: a missing decision makes the ZHE verdict FAIL', async () => {
    const sb = makeSandbox('zhe-seed-gap');
    try {
      writeGenuineTranscript(sb);
      const canonical = await seam.listCanonicalDepartments();
      const gapId = seam.computeExpectedDecisionIds(canonical)[0];
      await driveWebPath(sb, { complete: false, skipIds: [gapId] });
      const verdict = await evaluateZheWebBuild();
      assert.equal(verdict.compliant, false, 'a coverage gap must fail the ZHE verdict');
      assert.equal(verdict.gates.decisionCoverage, false);
    } finally {
      sb.cleanup();
    }
  });

  test('8b. SEEDED: a bare un-provenanced decline makes the ZHE verdict FAIL', async () => {
    const sb = makeSandbox('zhe-seed-bare');
    try {
      writeGenuineTranscript(sb);
      await driveWebPath(sb, { complete: false });
      injectBareDecline(sb, 'compliance');
      const verdict = await evaluateZheWebBuild();
      assert.equal(verdict.compliant, false, 'an un-provenanced decline must fail the ZHE verdict');
      assert.equal(verdict.gates.declineProvenance, false);
    } finally {
      sb.cleanup();
    }
  });

  test('8c. SEEDED: a synthetic transcript makes the ZHE verdict FAIL (consent 87)', async () => {
    const sb = makeSandbox('zhe-seed-synth');
    try {
      writeSyntheticTranscript(sb);
      await driveWebPath(sb, { complete: false });
      const verdict = await evaluateZheWebBuild();
      assert.equal(verdict.compliant, false, 'a synthetic transcript must fail the ZHE verdict');
      assert.equal(verdict.gates.consent, false);
      assert.equal(verdict.consentExit, 87, 'the real consent gate must report exit 87');
    } finally {
      sb.cleanup();
    }
  });
}

/* ── helpers ───────────────────────────────────────────────────────────────── */
function require_tmp() {
  return fs.realpathSync(process.env.TMPDIR || '/tmp');
}

/**
 * CLI build-verdict: drive a compliant web build, optionally SEED one violation,
 * then exit 0 iff the resulting build is ZHE-compliant (so a seeded violation
 * makes the harness exit NON-ZERO — the "correctly fails on a seeded gate
 * violation" demonstration). Usage: --build [--seed=missing|bare-decline|synthetic]
 */
async function runBuildVerdictCli() {
  if (!skill23Available()) {
    // eslint-disable-next-line no-console
    console.error(`[--build] Skill-23 scripts not found at ${SKILL_SCRIPTS}; cannot run.`);
    process.exit(2);
  }
  const seedArg = (process.argv.find((a) => a.startsWith('--seed=')) || '').split('=')[1] || 'none';
  const sb = makeSandbox('zhe-cli');
  let compliant = false;
  try {
    if (seedArg === 'synthetic') writeSyntheticTranscript(sb);
    else writeGenuineTranscript(sb);

    const canonical = await seam.listCanonicalDepartments();
    const gapId = seam.computeExpectedDecisionIds(canonical)[0];
    await driveWebPath(sb, { complete: false, skipIds: seedArg === 'missing' ? [gapId] : [] });
    if (seedArg === 'bare-decline') injectBareDecline(sb, 'compliance');

    const verdict = await evaluateZheWebBuild();
    compliant = verdict.compliant;
    // eslint-disable-next-line no-console
    console.log(
      `[--build seed=${seedArg}] ZHE verdict: ${verdict.compliant ? 'COMPLIANT' : 'FAIL'} ` +
        `gates=${JSON.stringify(verdict.gates)} consentExit=${verdict.consentExit}`,
    );
  } finally {
    sb.cleanup(); // process.exit below skips finally, so clean up FIRST
  }
  process.exit(compliant ? 0 : 1);
}
