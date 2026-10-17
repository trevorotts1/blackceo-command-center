/**
 * suite-journey.mjs — CWE-044 gauntlet: T124 final-journey gate,
 * T097 automated leg, and T155 usability-evidence separation.
 *
 * T124 (Section 34.3 / Section 35): the final user-journey gate
 * requires the completed action services and final API, not only UI
 * or component mocks. This suite reads the tree's own endpoint
 * registry (src/lib/council/api/registry.ts) and reports every
 * journey-required contract that is not ready. While any is not
 * ready the gate is PENDING_CWE050_RERUN with the assertion already
 * written: on the CWE-050 tree the same code passes the gate and the
 * end-to-end traversal becomes the acceptance evidence.
 *
 * T097: the automated leg traverses the composed component journey
 * (intake review snapshot -> session page -> recommendation) and is
 * labeled COMPONENT_LEVEL, which is explicitly NOT a T097 pass. The
 * human leg (one owner-authorized nontechnical tester) is NOT_RUN on
 * this stream: no such tester was in this lane, and T155 forbids
 * representing automated traversal as a human study.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT_DIR, fail, launchBrowser, notRun, pass, pending } from './lib.mjs';

const JOURNEY_CONTRACTS = [
  'sessions.start',
  'sessions.decision',
  'sessions.follow_up',
  'sessions.outcomes',
  'sessions.action_plan.preview',
  'sessions.action_plan.approve',
  'sessions.action_plan.create',
  'exports.create',
];

function registryReadiness(repoRoot) {
  const src = readFileSync(
    join(repoRoot, 'src/lib/council/api/registry.ts'),
    'utf8',
  );
  const out = {};
  for (const contract of JOURNEY_CONTRACTS) {
    // Registry entries are `contract_id: 'council.<contract>'` with
    // the readiness field a few lines below.
    const re = new RegExp(
      `contract_id: 'council\\.${contract.replace(/\./g, '\\.')}'[\\s\\S]{0,1600}?readiness: '([a-z_]+)'`,
    );
    const m = src.match(re);
    out[contract] = m ? m[1] : 'not_found';
  }
  return out;
}

export async function run(repoRoot) {
  const checks = [];
  const readiness = registryReadiness(repoRoot);
  const notReady = Object.entries(readiness).filter(
    ([, r]) => r !== 'ready',
  );

  /* ── T124 gate ─────────────────────────────────────────────── */
  checks.push(
    notReady.length === 0
      ? pass(
          'T124-final-journey-gate',
          'all journey-required action services are ready in the endpoint registry; the end-to-end traversal is the acceptance leg',
          JSON.stringify(readiness),
        )
      : pending(
          'T124-final-journey-gate',
          'final journey gate: completed action services and final API required',
          `not ready on this tree: ${notReady
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}. On the CWE-050 tree this same check passes the gate only when every listed contract reads ready.`,
        ),
  );

  /* ── T097 automated leg (COMPONENT_LEVEL, never a T097 pass) ── */
  const browser = await launchBrowser();
  try {
    const { serveOutDir } = await import('./lib.mjs');
    const server = await serveOutDir();
    try {
      const page = await browser.newPage({
        viewport: { width: 1366, height: 768 },
      });
      await page.goto(`${server.base}/gauntlet-interactive.html`, {
        waitUntil: 'networkidle',
      });
      await page.waitForSelector('[data-testid="council-verdict"]', {
        timeout: 20000,
      });
      const traversal = await page.evaluate(() => {
        const headline =
          document
            .querySelector('[data-testid="verdict-recommendation"] h2')
            ?.textContent?.trim() ?? '';
        const room = document.querySelector('[data-testid="council-room"]');
        const verdict = document.querySelector('[data-testid="council-verdict"]');
        const verdictAfterRoom =
          room && verdict
            ? Boolean(
                room.compareDocumentPosition(verdict) &
                  Node.DOCUMENT_POSITION_FOLLOWING,
              )
            : false;
        return { headline, verdictAfterRoom };
      });
      checks.push(
        traversal.headline.includes('Pilot the revised offer') &&
          traversal.verdictAfterRoom
          ? pass(
              'T097-automated-leg',
              'COMPONENT_LEVEL traversal: the composed session surface presents the room and the recommendation headline without terminal steps',
              `headline="${traversal.headline}"`,
            )
          : fail(
              'T097-automated-leg',
              'COMPONENT_LEVEL traversal of the recommendation surface',
              JSON.stringify(traversal),
            ),
      );
      await page.close();
    } finally {
      server.close();
    }
  } finally {
    await browser.close();
  }

  checks.push(
    notReady.length === 0
      ? pass(
          'T097-end-to-end',
          'end-to-end journey contracts ready; human usability leg still tracked separately below',
          '',
        )
      : pending(
          'T097-end-to-end',
          'end-to-end intake to recommendation journey against the final API',
          'sessions.start and the action services are not ready on this tree; the COMPONENT_LEVEL leg above is not a substitute',
        ),
  );

  /* ── T097 human leg + T155 separation ──────────────────────── */
  checks.push(
    notRun(
      'T097-human-tester',
      'nontechnical human tester completes the journey unaided',
      'no owner-authorized nontechnical human tester was available in this stream; per Section 32.6 the human leg stays NOT_RUN and is never inferred from automated results',
    ),
  );

  const usability = {
    contract: 'T155',
    generated_at: new Date().toISOString(),
    human_testing: {
      status: 'NOT_RUN',
      reason:
        'No owner-authorized nontechnical tester participated in this stream. Human usability evidence is recorded as NOT_RUN, per the directive: never represent automated testing as a human study.',
      sessions: [],
    },
    automated_testing: {
      status: 'EXECUTED',
      kind: 'independent AI/browser testing (Playwright/Chromium gauntlet)',
      suites: [
        'viewports (T098)',
        'keyboard and motion (T099)',
        'theme contrast (T100)',
        'composed-page label',
        'journey gate (T124)',
      ],
      note: 'Automated results are evidence about the software only; they are not usability-study evidence and are stored separately from human_testing above.',
    },
  };
  writeFileSync(
    join(OUT_DIR, 'usability-evidence.json'),
    JSON.stringify(usability, null, 2) + '\n',
  );
  checks.push(
    pass(
      'T155-evidence-separation',
      'usability evidence emitted with human_testing NOT_RUN kept mechanically separate from automated_testing results',
      'usability-evidence.json',
    ),
  );

  return { suite: 'journey gate and usability evidence (T124/T097/T155)', checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { checks } = await run(process.cwd());
  for (const c of checks) console.log(`${c.status.toUpperCase()} ${c.id}: ${c.detail}`);
  process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0);
}
