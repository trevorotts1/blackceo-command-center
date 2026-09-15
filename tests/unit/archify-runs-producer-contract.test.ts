/**
 * archify-runs-producer-contract.test.ts — the CROSS-LANGUAGE guard for the
 * Skill 69 archify board door (POST /api/archify-runs + PATCH
 * /api/archify-runs/[id]).
 *
 * WHY THIS FILE EXISTS
 *   A shipped bug 400'd EVERY board move: the Python producer
 *   (69-archify/scripts/cc_board.py) sent the MOVE body key `"phase"` while the
 *   server schema (`UpdateArchifyRunPhaseSchema`, src/lib/validation.ts) requires
 *   `"phase_slug"`. Both halves were individually "correct" and every
 *   single-repo suite stayed green:
 *     - the CC suites build their move bodies from the SERVER's own vocabulary,
 *       so they can never notice what the producer actually puts on the wire;
 *     - the producer's own selftest asserts against its own literals.
 *   Only manual probing against a live board found it. This file closes that
 *   gap: it runs the producer's REAL payload builders in python3 and feeds their
 *   REAL output through the REAL zod schemas. No hand-written fixture stands in
 *   for either side, so a rename on either side fails HERE (build red) instead of
 *   in production (every move 404/400).
 *
 * THE SIBLING-REPO GUARD
 *   The producer lives in the sibling onboarding repo
 *   (`../onb-archify/69-archify/scripts/cc_board.py`, i.e. a SIBLING of this CC
 *   worktree). That repo is not always checked out — so when the file is absent
 *   (or python3 is not on PATH) this suite SKIPS loudly with the path it looked
 *   for, rather than failing. The Command Center repo must stay testable on its
 *   own; the guard simply re-arms itself wherever the producer IS present.
 *
 * './_isolated-db' MUST stay the FIRST import: this file imports
 * DEFAULT_ARCHIFY_PHASES from '@/lib/archify-runs', which pulls in '@/lib/db'
 * (module-level DB_PATH). Without the isolation import the harness would freeze
 * DB_PATH to the live mission-control.db (see tests/unit/_isolated-db.ts and
 * tests/unit/c8-db-isolation-guard.test.ts).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CreateArchifyRunSchema, UpdateArchifyRunPhaseSchema } from '@/lib/validation';
import { DEFAULT_ARCHIFY_PHASES } from '@/lib/archify-runs';

// ---------------------------------------------------------------------------
// Locate the producer. REPO_ROOT is derived from THIS file (not process.cwd()),
// so the guard resolves the same path however the suite is invoked:
//   <repo>/tests/unit/archify-runs-producer-contract.test.ts → <repo>
//   <repo>/../onb-archify/69-archify/scripts/cc_board.py      → the producer
// CC_ARCHIFY_PRODUCER_PATH overrides the location (a checkout that is not the
// sibling dir) — and is what makes this guard itself falsifiable: point it at a
// copy of the producer with the `phase`/`phase_slug` drift reintroduced and the
// assertions below must FAIL.
// ---------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PRODUCER_PATH = process.env.CC_ARCHIFY_PRODUCER_PATH
  ? path.resolve(process.env.CC_ARCHIFY_PRODUCER_PATH)
  : path.resolve(REPO_ROOT, '..', 'onb-archify', '69-archify', 'scripts', 'cc_board.py');
const PRODUCER_DIR = path.dirname(PRODUCER_PATH);

const RUN_ID = 'archify-contract-0001';
const BLOCKED_ASK = 'Provide the Kie.ai API key so the render phase can run.';

/**
 * The emitter: import the producer as a module and print its REAL payload
 * builder outputs as JSON. Pure functions only — `build_run_payload` /
 * `build_create_payload` / `build_move_payload` never touch the network, the
 * environment or the run-state file, and importing the module does not run its
 * CLI (the `if __name__ == "__main__"` guard holds because the module is loaded
 * under the name "cc_board").
 *
 * Run with cwd = the producer's own directory, so any sibling import a future
 * version adds resolves exactly as it does in production.
 */
const EMITTER = `
import importlib.util, json, os, sys

spec = importlib.util.spec_from_file_location(
    "cc_board", os.path.join(os.getcwd(), "cc_board.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# The create builder has shipped under both names; accept either, fail loudly on
# neither (a rename that this guard cannot follow must break the build, not pass
# vacuously).
create_builder = getattr(mod, "build_create_payload", None) or \\
    getattr(mod, "build_run_payload", None)
if create_builder is None:
    sys.exit("cc_board.py exposes neither build_create_payload() nor build_run_payload()")
move_builder = getattr(mod, "build_move_payload", None)
if move_builder is None:
    sys.exit("cc_board.py no longer exposes build_move_payload()")

phases = list(getattr(mod, "PHASES", ()))
if not phases:
    sys.exit("cc_board.py no longer exposes its PHASES tuple")

payloads = {
    "phases": phases,
    "create": create_builder(
        "${RUN_ID}",
        diagram_type="architecture",
        title="Payments Platform Overview",
        source_path="examples/web-app.architecture.json",
    ),
    "move": move_builder("render", "done"),
    "blocked": move_builder(
        "authoring",
        "blocked",
        blocked_reason="credential",
        blocked_on_human="operator",
        ask="${BLOCKED_ASK}",
    ),
    # One move per lifecycle phase: proves every card CREATE makes is
    # addressable by the producer's own --phase vocabulary.
    "moves_per_phase": [move_builder(p, "in_progress") for p in phases],
}
print(json.dumps(payloads))
`;

interface ProducerPayloads {
  /** The producer's PHASES tuple, in lifecycle order. */
  phases: string[];
  create: Record<string, unknown>;
  move: Record<string, unknown>;
  blocked: Record<string, unknown>;
  moves_per_phase: Array<Record<string, unknown>>;
}

/** Is python3 runnable here? Checked once, at module load. */
function python3Available(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const PRODUCER_PRESENT = fs.existsSync(PRODUCER_PATH);
const PYTHON_PRESENT = PRODUCER_PRESENT && python3Available();

/**
 * `false` (run the suite) when the producer is reachable; otherwise the reason
 * node:test prints as `# SKIP` — never a silent green.
 */
const SKIP: boolean | string = PRODUCER_PRESENT
  ? PYTHON_PRESENT
    ? false
    : 'python3 is not on PATH — the Skill 69 producer is Python, so its real payload builders cannot be executed. Cross-language contract guard SKIPPED.'
  : `Skill 69 producer not checked out at ${PRODUCER_PATH} (sibling repo ../onb-archify) — cross-language contract guard SKIPPED so this repo stays testable without it.`;

let cached: ProducerPayloads | null = null;

function producerPayloads(): ProducerPayloads {
  if (cached) return cached;
  let raw: string;
  try {
    raw = execFileSync('python3', ['-c', EMITTER], { cwd: PRODUCER_DIR, encoding: 'utf8' });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    assert.fail(
      `could not run the Skill 69 producer's pure payload builders (${PRODUCER_PATH}):\n` +
        `${e.stderr || e.message || String(err)}`,
    );
  }
  cached = JSON.parse(raw) as ProducerPayloads;
  return cached;
}

/** Minimal structural view of a zod schema, so one helper serves both. */
type ParseableSchema = {
  safeParse(input: unknown): { success: boolean; error?: { issues: unknown } };
};

/**
 * Assert the schema ACCEPTS a real producer payload. On refusal the payload and
 * the zod issues are both printed — drift is diagnosable in one run instead of
 * needing a second probe against a live board.
 */
function assertAccepted(schema: ParseableSchema, payload: unknown, what: string): void {
  const result = schema.safeParse(payload);
  assert.equal(
    result.success,
    true,
    `${what} was REFUSED by the server schema — producer/server drift.\n` +
      `payload:\n${JSON.stringify(payload, null, 2)}\n` +
      `zod issues:\n${JSON.stringify(result.error?.issues ?? [], null, 2)}`,
  );
}

test(
  'PRODUCER → SERVER: the real CREATE payload (architecture) passes CreateArchifyRunSchema',
  { skip: SKIP },
  () => {
    const { create } = producerPayloads();
    assertAccepted(CreateArchifyRunSchema, create, 'cc_board.build_run_payload(diagram_type="architecture")');

    const parsed = CreateArchifyRunSchema.safeParse(create);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.run_id, RUN_ID, 'the producer run_id is the grouping id');
      assert.equal(parsed.data.title, 'Payments Platform Overview');
      assert.equal(parsed.data.diagram_type, 'architecture');
    }

    // The producer sends keys the server schema does not declare
    // (idempotency_key / description). Zod strips unknown keys — it must NOT
    // reject them, or every live CREATE 400s. Pin that contract explicitly.
    assert.ok('idempotency_key' in create, 'producer still sends idempotency_key');
    assert.ok('description' in create, 'producer still sends description');
  },
);

test(
  'PRODUCER → SERVER: the real MOVE payload (render → done) passes UpdateArchifyRunPhaseSchema',
  { skip: SKIP },
  () => {
    const { move } = producerPayloads();
    assertAccepted(
      UpdateArchifyRunPhaseSchema,
      move,
      'cc_board.build_move_payload("render", "done")',
    );

    const parsed = UpdateArchifyRunPhaseSchema.safeParse(move);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.phase_slug, 'render');
      assert.equal(parsed.data.status, 'done');
    }
  },
);

test(
  'PRODUCER → SERVER: the real BLOCKED move payload passes UpdateArchifyRunPhaseSchema',
  { skip: SKIP },
  () => {
    const { blocked } = producerPayloads();
    assertAccepted(
      UpdateArchifyRunPhaseSchema,
      blocked,
      'cc_board.build_move_payload("authoring", "blocked", blocked_reason=…, ask=…)',
    );

    const parsed = UpdateArchifyRunPhaseSchema.safeParse(blocked);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      // The blocked triad must survive validation intact — a stripped ask is an
      // unanswerable-forever card (src/lib/blocked-ask.ts).
      assert.equal(parsed.data.status, 'blocked');
      assert.equal(parsed.data.blocked_reason, 'credential');
      assert.equal(parsed.data.blocked_on_human, 'operator');
      assert.equal(parsed.data.ask, BLOCKED_ASK);
    }
  },
);

test(
  'REGRESSION (the shipped 400-on-every-move bug): the move body key is phase_slug, never phase',
  { skip: SKIP },
  () => {
    const { move, blocked, moves_per_phase } = producerPayloads();

    // 1. The wire body carries the key the server requires.
    assert.ok('phase_slug' in move, 'build_move_payload must send `phase_slug`');
    assert.equal(move.phase_slug, 'render');
    assert.ok('phase_slug' in blocked, 'a blocked move sends `phase_slug` too');

    // 2. …and NOT the legacy key that 400'd every board move.
    for (const [what, payload] of [
      ['normal move', move],
      ['blocked move', blocked],
    ] as const) {
      assert.ok(
        !('phase' in payload),
        `the ${what} body must not carry the legacy \`phase\` key — that exact spelling is what made every board move 400`,
      );
    }

    // 3. Negative control: the PRE-FIX body must be refused. If this ever
    //    passes, the schema was loosened and the guard above is vacuous.
    const shippedBugBody = { phase: move.phase_slug, status: move.status };
    const verdict = UpdateArchifyRunPhaseSchema.safeParse(shippedBugBody);
    assert.equal(
      verdict.success,
      false,
      `the pre-fix body ${JSON.stringify(shippedBugBody)} was accepted — the phase_slug requirement is gone`,
    );
    if (!verdict.success) {
      assert.ok(
        verdict.error.issues.some((issue) => issue.path.includes('phase_slug')),
        'the refusal must name phase_slug as the missing field',
      );
    }

    // 4. Every phase the producer can name is a legal MOVE body.
    assert.equal(moves_per_phase.length, producerPayloads().phases.length);
    for (const payload of moves_per_phase) {
      assertAccepted(UpdateArchifyRunPhaseSchema, payload, `move for phase ${String(payload.phase_slug)}`);
    }
  },
);

test(
  'VOCABULARY: the producer PHASES tuple and DEFAULT_ARCHIFY_PHASES are the same list',
  { skip: SKIP },
  () => {
    const { phases, create } = producerPayloads();
    const producerSlugs = phases;
    const serverSlugs = DEFAULT_ARCHIFY_PHASES.map((p) => p.slug);

    // The Task-2 bug class: a CREATE that omits `phases` mints cards from the
    // server default, and the producer then addresses them by its OWN slugs. If
    // the two lists disagree, those cards can never be moved.
    assert.deepEqual(
      serverSlugs,
      producerSlugs,
      'DEFAULT_ARCHIFY_PHASES must mirror the producer vocabulary exactly, in order',
    );

    // The list the producer actually puts on the wire is that same vocabulary.
    const createSlugs = (create.phases as Array<{ slug: string; title?: string }>).map((p) => p.slug);
    assert.deepEqual(createSlugs, producerSlugs, 'CREATE phases match the producer PHASES tuple');

    // And the server default carries a usable human title for every slug.
    for (const phase of DEFAULT_ARCHIFY_PHASES) {
      assert.ok(phase.title && phase.title.trim().length > 0, `default title for ${phase.slug}`);
      assert.ok(phase.title.length <= 500, `default title for ${phase.slug} fits the schema cap`);
    }
  },
);
