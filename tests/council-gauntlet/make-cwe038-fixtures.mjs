/**
 * make-cwe038-fixtures.mjs — CWE-044 gauntlet fixture builder.
 *
 * CWE-038's export service lives in the ONB skill runtime (no
 * renderer in its dependency bill, which is why its pdf deliverable
 * is registered not_ready and CWE-044 owns the rendered PDF). This
 * builder runs CWE-038's OWN service code, unmodified, in a scratch
 * copy, and commits its byte-exact outputs as gauntlet fixtures:
 *
 *   fixtures/cwe038/golden-print.html  (the exact bytes CWE-044's
 *   fixtures/cwe038/golden.md           PDF renderer consumes)
 *   fixtures/cwe038/golden-record.json
 *   fixtures/cwe038/long-print.html    (long evidence table variant)
 *   fixtures/cwe038/manifest.json      (provenance + sha256s +
 *                                       the typed pdf refusal)
 *
 * The fixture construction replicates CWE-038's own golden test
 * (runtime/tests/reports.test.ts, fixture identity
 * cwe-038-synthetic-fixtures/v1): the Section 32.2 golden verdict,
 * A = 132/22, B = 168/22, C = 145/22.
 *
 * Re-run contract: at the post-CWE-050 re-run, point GAUNTLET_ONB_SRC
 * at the composed ONB tree; this script regenerates the fixtures and
 * the gauntlet's drift check compares bytes against the committed
 * copies (any drift fails loudly; it is never silently absorbed).
 *
 * The ONB worktree is only ever READ. The scratch copy lives outside
 * both repos at ~/workspace/skill77/cwe-044/scratch-onb-runtime.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures', 'cwe038');
const SCRATCH = join(
  homedir(),
  'workspace/skill77/cwe-044/scratch-onb-runtime',
);
const ONB_SKILL =
  process.env.GAUNTLET_ONB_SRC ??
  join(
    homedir(),
    'workspace/skill77/worktrees/onb-cwe038/77-council-of-wise-elders',
  );
const ONB_RUNTIME = join(ONB_SKILL, 'runtime');

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim();
}

let onbCommit = 'unknown';
try {
  onbCommit = sh('git', ['-C', ONB_SKILL, 'rev-parse', 'HEAD']);
} catch {
  onbCommit = 'unknown (not a git checkout)';
}

mkdirSync(SCRATCH, { recursive: true });
rmSync(join(SCRATCH, 'src'), { recursive: true, force: true });
cpSync(join(ONB_RUNTIME, 'src'), join(SCRATCH, 'src'), { recursive: true });
for (const f of ['package.json', 'package-lock.json', 'tsconfig.json']) {
  const src = join(ONB_RUNTIME, f);
  if (existsSync(src)) cpSync(src, join(SCRATCH, f));
}
if (!existsSync(join(SCRATCH, 'node_modules'))) {
  console.log('installing scratch runtime dependencies (npm ci)…');
  sh('npm', ['ci', '--no-audit', '--no-fund'], SCRATCH);
}

const DRIVER = String.raw`
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalHash,
  GOLDEN_WEIGHTS,
  SEAT_IDS,
} from './src/contracts/index.js';
import { analyzeDecision } from './src/scoring/index.js';
import {
  aggregateEvidenceStrength,
  buildScoredVerdict,
  summarizeMainReasons,
  summarizeStrongestDissent,
} from './src/protocol/verdict.js';
import {
  InMemoryDeliverableRegistry,
  InMemoryExportJournal,
  PDF_MISSING_PIECE,
  ReportExportError,
  ReportExportService,
} from './src/reports/index.js';

const OUT = process.argv[2];
const ONB_COMMIT = process.argv[3];
mkdirSync(OUT, { recursive: true });

const HASH_B = 'b'.repeat(64);
const SESSION_ID = 'sess-fixture-1';
const HOST_STAMP = {
  scope: {
    tenant_id: 'tenant-fixture',
    company_id: 'company-fixture',
    installation_id: 'install-fixture',
    owner_subject: null,
  },
  operation_id: 'op-fixture-1',
  route_id: 'route-fixture-1',
  session_id: SESSION_ID,
  stamped_at: '2026-10-14T02:05:00Z',
  source_status: 'verified',
};
const GOLDEN_WEIGHT_MAP = Object.fromEntries(
  SEAT_IDS.map((seatId, i) => [seatId, GOLDEN_WEIGHTS[i]]),
);
const SCOPE = {
  tenant_id: 'tenant-fixture',
  company_id: 'company-fixture',
  installation_id: 'install-fixture',
  owner_subject: 'owner-1',
};
const OWNER = {
  tenant_id: 'tenant-fixture',
  company_id: 'company-fixture',
  installation_id: 'install-fixture',
  subject: 'owner-1',
  channel: 'browser',
  support_access: false,
};
const ALL_BIBLIOGRAPHIC = Object.fromEntries(
  SEAT_IDS.map((seatId) => [seatId, 'bibliographic_only']),
);

function makeBrief(sessionId, overrides = {}) {
  return {
    schema_version: 'wise-elders.brief/v1',
    brief_id: 'brief-fixture-1',
    session_id: sessionId,
    revision: 1,
    question: 'Should we pilot the revised offer before a broad launch?',
    facts: [
      { id: 'fact-1', statement: 'Current offer converts at a measured baseline.', evidence_ids: ['ev-1'] },
    ],
    assumptions: [],
    unknowns: [],
    constraints: [],
    options: [
      { id: 'A', label: 'Keep the current offer', kind: 'status_quo' },
      { id: 'B', label: 'Pilot the revised offer', kind: 'bounded_test' },
      { id: 'C', label: 'Launch the revised offer broadly', kind: 'change' },
    ],
    relevance_weights: { ...GOLDEN_WEIGHT_MAP },
    critical_domains: [],
    evidence_manifest: [
      { evidence_id: 'ev-1', sha256: HASH_B, source_kind: 'client_document', locator: 'doc:baseline-metrics' },
      { evidence_id: 'ev-brunson-nms', sha256: 'c'.repeat(64), source_kind: 'book', locator: 'skill22:brunson-network-marketing-secrets' },
    ],
    private_preference_ref: null,
    created_at: '2026-10-14T02:00:00Z',
    display_timezone: 'America/New_York',
    ...overrides,
  };
}

const GOLDEN_TABLE = {
  A: { 'simon-sinek': 6, 'td-jakes': 5, 'oprah-winfrey': 6, 'tiffany-aliche': 8, 'russell-brunson': 5, 'michelle-obama': 6, 'brene-brown': 6, 'dennis-kimbro': 6, 'les-brown': 6 },
  B: { 'simon-sinek': 8, 'td-jakes': 8, 'oprah-winfrey': 7, 'tiffany-aliche': 6, 'russell-brunson': 9, 'michelle-obama': 8, 'brene-brown': 7, 'dennis-kimbro': 8, 'les-brown': 8 },
  C: { 'simon-sinek': 7, 'td-jakes': 9, 'oprah-winfrey': 7, 'tiffany-aliche': 3, 'russell-brunson': 8, 'michelle-obama': 6, 'brene-brown': 5, 'dennis-kimbro': 7, 'les-brown': 8 },
};

function advisorCard(seatId, table, sessionId, overrides = {}) {
  return {
    schema_version: 'wise-elders.card/v1',
    card_kind: 'advisor',
    session_id: sessionId,
    brief_revision: 1,
    round: 2,
    seat_id: seatId,
    input_manifest_sha256: HASH_B,
    pack_version: 'pack-fixture-1.0.0',
    stance: 'conditional',
    preferred_option_id: 'B',
    option_scores: ['A', 'B', 'C'].map((optionId) => ({
      option_id: optionId,
      score: table[optionId][seatId],
      rationale: 'Fixture rationale for ' + optionId + ' from ' + seatId + '.',
      evidence_ids: ['ev-1'],
    })),
    framework_applications: [],
    decisive_arguments: ['Decisive argument from ' + seatId + '.'],
    strongest_objection: 'Strongest objection from ' + seatId + '.',
    conditions: [],
    critical_unknowns: [],
    change_my_mind: 'Measured evidence to the contrary.',
    challenges_answered: [],
    quotes: [],
    evidence_strength: 'medium',
    minority_position: null,
    host: { ...HOST_STAMP, session_id: sessionId },
    ...overrides,
  };
}

function buildVerdictFromCards(cards, brief) {
  const analysis = analyzeDecision({
    options: brief.options,
    active_seat_ids: SEAT_IDS,
    weights: brief.relevance_weights,
    scores: cards.flatMap((card) =>
      card.option_scores.map((s) => ({
        option_id: s.option_id,
        seat_id: card.seat_id,
        score: s.score,
      })),
    ),
    critical_domains: brief.critical_domains,
  });
  return buildScoredVerdict({
    analysis,
    session_id: brief.session_id,
    verdict_revision: 1,
    brief_sha256: canonicalHash(brief),
    weights: brief.relevance_weights,
    evidence_strength: aggregateEvidenceStrength(cards),
    hard_constraint_findings: [],
    main_reasons: summarizeMainReasons(cards, analysis.recommended_option_id),
    strongest_dissent: summarizeStrongestDissent(cards, analysis.recommended_option_id),
    accepted_amendments: [],
    rejected_amendments: [],
    critical_unknowns: [],
    prerequisites: analysis.prerequisites_needed,
    action_proposals: [],
    cheapest_informative_test: null,
    stop_criteria: [],
    review_criteria: [],
    resolution_support: null,
    ratification_status: 'not_required',
  });
}

function makeService() {
  const journal = new InMemoryExportJournal();
  const registry = new InMemoryDeliverableRegistry();
  return { service: new ReportExportService({ journal, registry }), journal, registry };
}

function requestFor(brief, cards, verdict, requestId) {
  return {
    request_id: requestId,
    principal: OWNER,
    session_id: SESSION_ID,
    session_scope: SCOPE,
    session_visibility: 'company',
    verdict,
    brief,
    final_cards: cards,
    current_verdict_revision: 1,
    formats: ['record_json', 'markdown', 'print_html'],
    context: {
      report_date: '2026-10-14',
      session_mode: 'full',
      seat_qualifications: { ...ALL_BIBLIOGRAPHIC },
    },
    exported_at: '2026-10-14T12:00:00Z',
  };
}

function bytesOf(result, format) {
  const a = result.artifacts.find((x) => x.format === format);
  if (!a) throw new Error('missing artifact ' + format);
  return a.bytes;
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/* Golden export */
const brief = makeBrief(SESSION_ID);
const cards = SEAT_IDS.map((seatId) => advisorCard(seatId, GOLDEN_TABLE, SESSION_ID));
const verdict = buildVerdictFromCards(cards, brief);
const { service } = makeService();
const result = await service.exportReport(requestFor(brief, cards, verdict, 'req-gauntlet-1'));

/* Long variant: same verdict inputs, evidence manifest extended so
 * the evidence table spans several pages (page-break and repeating
 * header evidence for T106). */
const extraEvidence = Array.from({ length: 55 }, (_, i) => ({
  evidence_id: 'ev-long-' + (i + 1),
  sha256: sha256('gauntlet-long-evidence-' + (i + 1)),
  source_kind: 'client_document',
  locator: 'doc:appendix-item-' + (i + 1),
}));
const longBrief = makeBrief(SESSION_ID, {
  evidence_manifest: [...brief.evidence_manifest, ...extraEvidence],
});
const longVerdict = buildVerdictFromCards(cards, longBrief);
const longResult = await makeService().service.exportReport(
  requestFor(longBrief, cards, longVerdict, 'req-gauntlet-long'),
);

/* The pdf refusal, from the service itself. */
let refusal = null;
try {
  await makeService().service.exportReport({
    ...requestFor(brief, cards, verdict, 'req-gauntlet-pdf'),
    formats: ['pdf'],
  });
} catch (err) {
  if (err instanceof ReportExportError) {
    refusal = { name: err.name, code: err.code, message: err.message };
  } else {
    throw err;
  }
}
if (!refusal) throw new Error('pdf request did not refuse');

const files = {
  'golden-print.html': bytesOf(result, 'print_html'),
  'golden.md': bytesOf(result, 'markdown'),
  'golden-record.json': bytesOf(result, 'record_json'),
  'long-print.html': bytesOf(longResult, 'print_html'),
};
const manifest = {
  fixture_identity: 'cwe-038-synthetic-fixtures/v1',
  generated_by: 'CWE-044 gauntlet fixture builder (make-cwe038-fixtures.mjs)',
  generated_at: new Date().toISOString(),
  onb_runtime_commit: ONB_COMMIT,
  report_revision_id: result.report_revision_id,
  verdict_content_sha256: result.verdict_content_sha256,
  export_states: result.states,
  pdf_refusal: { ...refusal, missing_piece: PDF_MISSING_PIECE },
  artifacts: Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: Buffer.byteLength(bytes, 'utf8') }]),
  ),
};
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(join(OUT, name), bytes, 'utf8');
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('fixtures written: ' + Object.keys(files).join(', '));
console.log('pdf refusal: ' + JSON.stringify(refusal));
console.log('report revision: ' + result.report_revision_id);
`;

writeFileSync(join(SCRATCH, 'gauntlet-driver.mts'), DRIVER);
mkdirSync(FIXTURES_DIR, { recursive: true });
const out = sh(
  'npx',
  ['tsx', 'gauntlet-driver.mts', FIXTURES_DIR, onbCommit],
  SCRATCH,
);
console.log(out);
console.log(`CWE-038 fixtures regenerated from ${ONB_RUNTIME} @ ${onbCommit}`);
