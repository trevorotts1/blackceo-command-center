/**
 * WF17 — Command Center routing + ContextPack for the GHL hybrid build
 * (Document 1 §14.1-14.3, §14.10, §14.11, §32.4; Document 2 WF17 lines 526-537).
 *
 * Acceptance covered here:
 *   A20 — existing department aliases and native skill/SOP bindings route tasks
 *         correctly without duplicate departments (CC side).
 *   A21 — automatic and manual dispatch include the same required capability
 *         references (proved on the ONE shared composition both call sites use;
 *         the manual call-site wiring itself is a WF18 file and is filed as a
 *         change request from this lane — see the lane receipt).
 *
 * What these tests deliberately do NOT do:
 *   • no live provider/network call (no embedding key, node:test only);
 *   • no fake success — a pointer that is not on disk is asserted
 *     `resolvable: false` rather than pretended;
 *   • no rewriting of the JEV-first precedence or the runtime workspace roster —
 *     those are asserted as PRESERVED, not replaced.
 *
 * Runs under: node --import tsx --import ./tests/setup/no-owner-telegram.ts
 *             --import ./tests/setup/tmp-sandbox.ts --test <this file>
 */

// C8 — DB isolation. Static imports below transitively pull '@/lib/db', whose
// module-level DB_PATH freezes at eval time. This must stay the FIRST import.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CANONICAL_SLUGS,
  canonicalDeptFromAnyLabel,
  canonicalDeptSlug,
} from '../../src/lib/routing/canonical-slug';
import {
  DEFAULT_DEPARTMENTS,
  GHL_HYBRID_INTENT_ROUTES,
  type DepartmentConfig,
} from '../../src/lib/routing/departments.config';
import {
  DEPARTMENT_PICKER_ORDER,
  comDispatch,
  pickDepartment,
  type AgentWithLoad,
} from '../../src/lib/routing/department-router';
import {
  buildContextPack,
  buildDispatchReferenceSection,
  renderContextPackSection,
  type BuildContextPackInput,
} from '../../src/lib/context-pack';

// A box with the decision-engine core installed would let JEV decide first and
// make the outcome host-dependent. These assertions are about the keyword/hint
// contract and the explicit-tag path; keep JEV off, exactly as the existing
// intelligent-routing suite does.
process.env.DECISION_ENGINE_MODE = 'off';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeAgent(
  overrides: Partial<AgentWithLoad> & { id: string; name: string; role: string },
): AgentWithLoad {
  return {
    status: 'active',
    workspace_id: overrides.id,
    is_master: false,
    active_tasks: 0,
    department: overrides.role,
    description: '',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    model: 'test',
    persona: null,
    ...overrides,
  } as AgentWithLoad;
}

/** A configured (workspace-table) department row, as loadDepartments() builds it. */
function makeDept(
  id: string,
  name: string,
  hint: DepartmentConfig,
  overrides: Partial<DepartmentConfig> = {},
): DepartmentConfig {
  return { ...hint, id, slug: id, name, ...overrides };
}

/** The §32.4 intents, one pick per capability, used by the real-routing cases. */
function intentFor(capability: string): string {
  const row = GHL_HYBRID_INTENT_ROUTES.find((r) => r.capability === capability);
  assert.ok(row, `no §32.4 intent row for capability "${capability}"`);
  return row!.intent;
}

const KEYWORD_ONLY = { order: ['keyword' as const], tail: [] as const };

// ── A20.1 — the §14.3 alias contract ────────────────────────────────────────

test('A20 alias: onboarding folder labels fold onto the existing canonical ids', () => {
  assert.strictEqual(canonicalDeptSlug('courses'), 'course-creator');
  assert.strictEqual(canonicalDeptSlug('community-builder'), 'community-management');
  // Display punctuation/spaces are normalized through the existing utility.
  assert.strictEqual(canonicalDeptSlug('community builder'), 'community builder'); // bare slug fn: no punctuation pass
  assert.strictEqual(canonicalDeptFromAnyLabel('Community Builder'), 'community-management');
  assert.strictEqual(canonicalDeptFromAnyLabel('Courses'), 'course-creator');
});

test('A20 alias: platform spellings all fold onto crm (never sales)', () => {
  for (const spelling of ['ghl', 'GHL', 'GoHighLevel', 'gohighlevel', 'HighLevel', 'High Level']) {
    assert.strictEqual(canonicalDeptFromAnyLabel(spelling), 'crm', `"${spelling}" must canonicalize to crm`);
  }
  for (const spelling of ['convert-and-flow', 'Convert and Flow', 'Convert & Flow', 'convertandflow']) {
    assert.strictEqual(canonicalDeptFromAnyLabel(spelling), 'crm', `"${spelling}" must canonicalize to crm`);
  }
  // Regression guard for the trap this alias deliberately avoids: the product
  // name must never be read as a lead-closing instruction.
  assert.notStrictEqual(canonicalDeptFromAnyLabel('Convert and Flow'), 'sales');
});

test('A20 alias: canonical ids and unknown custom labels are never rewritten', () => {
  assert.strictEqual(canonicalDeptSlug('course-creator'), 'course-creator');
  assert.strictEqual(canonicalDeptSlug('community-management'), 'community-management');
  assert.strictEqual(canonicalDeptSlug('crm'), 'crm');
  assert.strictEqual(canonicalDeptSlug('sales'), 'sales');
  // The existing over-strip guard still holds (pinned by
  // canonical-slug-trailing-dept-suffix.test.ts / prd-2.9f-null-dept-slug).
  assert.strictEqual(canonicalDeptSlug('my-custom-dept'), 'my-custom-dept');
  assert.strictEqual(canonicalDeptFromAnyLabel('Brand Storytelling Lab'), 'brand-storytelling-lab');
});

// ── A20.2 — explicit owner choice, on an EXISTING configured workspace ──────

test('A20 explicit: a configured "Community Builder" workspace receives a Community Builder tag', async () => {
  const hint = DEFAULT_DEPARTMENTS.find((d) => d.id === 'community-management')!;
  // An existing box provisioned from the onboarding tree stored the label id.
  const workspace = makeDept('community-builder', 'Community Builder', hint);
  const agent = makeAgent({
    id: 'agent-community',
    name: 'Marta',
    role: 'Community Manager',
    workspace_id: 'community-builder',
  });

  const routed = await comDispatch(
    {
      title: 'Set up the members area',
      description: 'Create the group and its Learning association',
      priority: 'medium',
      department: 'Community Builder',
    },
    [agent],
    [workspace],
  );

  assert.ok(routed, 'an explicit tag on an existing workspace must route');
  assert.strictEqual(routed!.agentId, 'agent-community');
  assert.strictEqual(routed!.department, 'Community Builder');
  assert.ok(routed!.reason.includes('Explicit department tag'));
});

test('A20 explicit: a platform tag ("GoHighLevel") reaches the configured crm workspace', async () => {
  const hint = DEFAULT_DEPARTMENTS.find((d) => d.id === 'crm')!;
  const crmWorkspace = makeDept('crm', 'CRM', hint);
  const salesWorkspace = makeDept('sales', 'Sales', DEFAULT_DEPARTMENTS.find((d) => d.id === 'sales')!);
  const crmAgent = makeAgent({ id: 'agent-crm', name: 'Dana', role: 'GHL Specialist', workspace_id: 'crm' });
  const salesAgent = makeAgent({ id: 'agent-sales', name: 'Omar', role: 'Sales Rep', workspace_id: 'sales' });

  const routed = await comDispatch(
    {
      title: 'Rebuild the welcome automation',
      description: 'Technical platform work',
      priority: 'medium',
      department: 'GoHighLevel',
    },
    [crmAgent, salesAgent],
    [crmWorkspace, salesWorkspace],
  );

  assert.ok(routed, 'the platform tag must resolve to the configured crm workspace');
  assert.strictEqual(routed!.agentId, 'agent-crm');
  assert.strictEqual(routed!.department, 'CRM');
});

// ── A20.3 — hint refinement: technical CRM vs lead closing ─────────────────

test('A20 hints: a technical GoHighLevel request routes to CRM, not Sales', async () => {
  const pick = await pickDepartment(
    {
      title: 'Build a GHL workflow automation with a webhook trigger and custom fields',
      description: 'Wire the automation into our sub-account and verify the integration',
      priority: 'medium',
    },
    DEFAULT_DEPARTMENTS,
    KEYWORD_ONLY,
  );

  assert.strictEqual(pick.method, 'keyword');
  assert.ok(pick.department, `expected a confident department, got: ${pick.note}`);
  assert.strictEqual(pick.department!.id, 'crm', `expected crm, got ${pick.department!.name} (${pick.note})`);
});

test('A20 hints: Sales lead closing still routes to Sales', async () => {
  const pick = await pickDepartment(
    {
      title: 'Close the deal with the prospects in our pipeline',
      description: 'Follow up with the leads from last week and close deals before Friday',
      priority: 'high',
    },
    DEFAULT_DEPARTMENTS,
    KEYWORD_ONLY,
  );

  assert.strictEqual(pick.method, 'keyword');
  assert.ok(pick.department, `expected a confident department, got: ${pick.note}`);
  assert.strictEqual(pick.department!.id, 'sales', `expected sales, got ${pick.department!.name} (${pick.note})`);
});

// ── A20.4 — §32.4 intents: real routing for the unambiguous ones ────────────

test('A20 §32.4: a native Voice AI receptionist routes to CRM (existing department)', async () => {
  const pick = await pickDepartment(
    { title: intentFor('native-ai'), description: '', priority: 'medium' },
    DEFAULT_DEPARTMENTS,
    KEYWORD_ONLY,
  );
  assert.strictEqual(pick.department?.id, 'crm', `expected crm, got ${pick.department?.name} (${pick.note})`);
});

test('A20 §32.4: an approved-files knowledge base routes to CRM', async () => {
  const pick = await pickDepartment(
    { title: intentFor('knowledge-base'), description: '', priority: 'medium' },
    DEFAULT_DEPARTMENTS,
    KEYWORD_ONLY,
  );
  assert.strictEqual(pick.department?.id, 'crm', `expected crm, got ${pick.department?.name} (${pick.note})`);
});

test('A20 §32.4: automation-failure monitoring routes to CRM (no new workflow created)', async () => {
  const pick = await pickDepartment(
    { title: intentFor('workflow-monitoring'), description: '', priority: 'medium' },
    DEFAULT_DEPARTMENTS,
    KEYWORD_ONLY,
  );
  assert.strictEqual(pick.department?.id, 'crm', `expected crm, got ${pick.department?.name} (${pick.note})`);
});

test('A20 §32.4: a course live-session room routes to the existing Courses department', async () => {
  const pick = await pickDepartment(
    { title: intentFor('meeting-room'), description: '', priority: 'medium' },
    DEFAULT_DEPARTMENTS,
    KEYWORD_ONLY,
  );
  assert.strictEqual(pick.department?.id, 'course-creator', `expected course-creator, got ${pick.department?.name} (${pick.note})`);
});

test('A20 §32.4: a native chat widget on a website routes to the existing page owner', async () => {
  const pick = await pickDepartment(
    { title: intentFor('chat-widget'), description: '', priority: 'medium' },
    DEFAULT_DEPARTMENTS,
    KEYWORD_ONLY,
  );
  assert.strictEqual(pick.department?.id, 'web-development', `expected web-development, got ${pick.department?.name} (${pick.note})`);
});

// ── A20.4b — the seed entries themselves stay structurally complete ─────────
// A hint edit that silently drops `name` from an entry does not fail any type
// check (the field is required, but the object is built from a superset literal),
// and loadDepartments() then throws inside its try block, degrading EVERY client
// to the DEFAULT floor with keyword-less departments. This guard makes that
// failure loud and local.
test('A20 config: every DEFAULT_DEPARTMENTS entry keeps id, display name, purpose and keyword list', () => {
  for (const d of DEFAULT_DEPARTMENTS) {
    assert.ok(typeof d.id === 'string' && d.id.length > 0, 'an entry lost its id');
    assert.ok(typeof d.name === 'string' && d.name.trim().length > 0, `dept "${d.id}" lost its display name`);
    assert.ok(typeof d.purpose === 'string' && d.purpose.trim().length > 0, `dept "${d.id}" lost its purpose`);
    assert.ok(Array.isArray(d.keywords), `dept "${d.id}" lost its keyword list`);
    assert.ok(typeof d.priority === 'number', `dept "${d.id}" lost its priority`);
  }
});

// ── A20.5 — the frozen intent→department table itself ──────────────────────

test('A20 §32.4: every intent maps ONLY to departments that already exist (no minted department)', () => {
  const capabilities = new Set(GHL_HYBRID_INTENT_ROUTES.map((r) => r.capability));
  assert.deepStrictEqual(
    [...capabilities].sort(),
    ['chat-widget', 'knowledge-base', 'marketing-quiz', 'meeting-room', 'native-ai', 'projects', 'workflow-monitoring'],
    'all seven §32.4 capability families must be covered',
  );

  const defaultIds = new Set(DEFAULT_DEPARTMENTS.map((d) => d.id));
  for (const route of GHL_HYBRID_INTENT_ROUTES) {
    assert.ok(route.departments.length > 0, `"${route.intent}" must name at least one department`);
    for (const slug of route.departments) {
      assert.ok(CANONICAL_SLUGS.has(slug), `"${slug}" (for "${route.intent}") is not a canonical department`);
      assert.ok(defaultIds.has(slug), `"${slug}" (for "${route.intent}") is not in DEFAULT_DEPARTMENTS`);
      assert.strictEqual(canonicalDeptSlug(slug), slug, `"${slug}" must stay stable under canonicalization`);
    }
  }

  // No per-family department was minted, and the floor count is untouched.
  assert.strictEqual(DEFAULT_DEPARTMENTS.length, 26);
  for (const family of ['voice', 'knowledge', 'widget', 'meeting', 'project', 'quiz']) {
    assert.ok(
      !DEFAULT_DEPARTMENTS.some((d) => d.id.includes(family)),
      `a "${family}" department must not be minted — §32.4 routes to existing departments`,
    );
  }
});

// ── A20.6 — owner choice + opt-out + JEV precedence preserved ──────────────

test('A20 precedence: the picker order is still JEV → semantic → keyword', () => {
  assert.deepStrictEqual([...DEPARTMENT_PICKER_ORDER], ['jev', 'semantic', 'keyword']);
});

test('A20 opt-out: a client without the courses department gets a catch-all hold, never a fabricated one', async () => {
  // The client's runtime roster (what loadDepartments returns) has NO course
  // department — the client disabled it. DEFAULT_DEPARTMENTS must not re-add it.
  const graphics = makeDept('graphics', 'Graphics', DEFAULT_DEPARTMENTS.find((d) => d.id === 'graphics')!);
  const general = makeDept(
    'general-task',
    'General Task',
    DEFAULT_DEPARTMENTS.find((d) => d.id === 'general-task')!,
    { keywords: [] },
  );
  const graphicsAgent = makeAgent({ id: 'agent-graphics', name: 'Lee', role: 'Designer', workspace_id: 'graphics' });
  const generalAgent = makeAgent({ id: 'agent-general', name: 'Sam', role: 'Generalist Operator', workspace_id: 'general-task' });

  const routed = await comDispatch(
    {
      title: 'Build module 3 of the flagship course',
      description: 'Course lessons and curriculum',
      priority: 'medium',
      department: 'courses',
    },
    [graphicsAgent, generalAgent],
    [graphics, general],
  );

  assert.ok(routed, 'an unroutable explicit tag must still land on the catch-all, not disappear');
  assert.strictEqual(routed!.agentId, 'agent-general', 'the disabled department must not be fabricated');
  assert.notStrictEqual(routed!.department, 'Course Creator');
  assert.ok(routed!.reason.startsWith('[catch-all]'), `expected a catch-all hold, got: ${routed!.reason}`);
});

// ── A21 — ContextPack: normalized department + required hybrid references ───

/** A throwaway box root with the hybrid SOP cluster and the supporting skills. */
function makeHybridBox(): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wf17-hybrid-box-'));
  const skills = path.join(home, 'skills');
  for (const dir of [
    '06-ghl-install-pages',
    '29-ghl-api-knowledge',
    '35-community-publishing',
    '36-ghl-mcp-discovery',
    '44-convert-and-flow-operator',
  ]) {
    fs.mkdirSync(path.join(skills, dir), { recursive: true });
    fs.writeFileSync(
      path.join(skills, dir, 'SKILL.md'),
      `---\nname: ${dir}\ndescription: fixture skill for WF17\n---\n\n# ${dir}\n`,
      'utf8',
    );
  }
  const hybridSop = path.join(home, 'clawd', 'openclaw-onboarding', 'universal-sops', 'ghl-hybrid-operations');
  fs.mkdirSync(hybridSop, { recursive: true });
  fs.writeFileSync(path.join(hybridSop, 'README.md'), '# GHL hybrid operations\n', 'utf8');

  const prevHome = process.env.HOME;
  const prevRoots = process.env.CC_SKILL_ROOTS;
  const prevPlatform = process.env.OPENCLAW_PLATFORM;
  process.env.HOME = home;
  process.env.CC_SKILL_ROOTS = skills;
  process.env.OPENCLAW_PLATFORM = 'mac-mini';

  return {
    home,
    cleanup: () => {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevRoots === undefined) delete process.env.CC_SKILL_ROOTS; else process.env.CC_SKILL_ROOTS = prevRoots;
      if (prevPlatform === undefined) delete process.env.OPENCLAW_PLATFORM; else process.env.OPENCLAW_PLATFORM = prevPlatform;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function packInput(department: string | null, role: string): BuildContextPackInput {
  return {
    task: { id: 'task-wf17', title: 'Community group setup', description: 'Members area for the course group', department, workspace_id: 'ws-community' },
    agent: { id: 'agent-wf17', name: 'Marta', role },
    specialistType: 'permanent',
    sop: { id: 'sop-1', name: 'Community group setup', department: department ?? undefined, role },
    matchedSkills: [],
  };
}

test('A21 pack: the owning department is normalized and the hybrid SOP + Skill 29/36 pointers are carried', () => {
  const box = makeHybridBox();
  try {
    const pack = buildContextPack(packInput('Community Builder', 'Community Manager'));

    assert.strictEqual(pack.department, 'community-management', 'the pack must carry the NORMALIZED owning department');

    const hybridSop = pack.doc_pointers.find((p) => p.kind === 'hybrid-sop');
    assert.ok(hybridSop, 'the hybrid SOP cluster pointer must be in the pack');
    assert.strictEqual(hybridSop!.resolvable, true, `hybrid SOP should resolve on the fixture box: ${hybridSop!.location}`);

    const skillLabels = pack.doc_pointers.filter((p) => p.kind === 'skill-reference');
    const byNumber = (n: string) => skillLabels.find((p) => p.label.startsWith(`Skill ${n} `));
    for (const n of ['6', '35', '29', '36']) {
      assert.ok(byNumber(n), `Skill ${n} pointer missing from the pack`);
      assert.strictEqual(byNumber(n)!.resolvable, true, `Skill ${n} should resolve on the fixture box`);
    }

    // The rendered dispatch section carries them too — a pointer the agent never
    // reads is not a handoff.
    const section = renderContextPackSection(pack);
    assert.ok(section.includes('GHL hybrid operations SOP cluster'));
    assert.ok(section.includes('Skill 29'));
    assert.ok(section.includes('Skill 36'));
  } finally {
    box.cleanup();
  }
});

test('A21 pack: a technical CRM task carries the Skill 44/29/36 pointers', () => {
  const box = makeHybridBox();
  try {
    const pack = buildContextPack(packInput('crm', 'GHL Specialist'));
    assert.strictEqual(pack.department, 'crm');
    const labels = pack.doc_pointers.filter((p) => p.kind === 'skill-reference').map((p) => p.label);
    assert.ok(labels.some((l) => l.startsWith('Skill 44 ')), `missing Skill 44 in ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => l.startsWith('Skill 29 ')));
    assert.ok(labels.some((l) => l.startsWith('Skill 36 ')));
  } finally {
    box.cleanup();
  }
});

test('A21 pack: a non-hybrid department gets NO hybrid pointers (no widened scope)', () => {
  const box = makeHybridBox();
  try {
    const pack = buildContextPack(packInput('graphics', 'Designer'));
    assert.strictEqual(pack.department, 'graphics');
    assert.strictEqual(pack.doc_pointers.some((p) => p.kind === 'hybrid-sop'), false);
    assert.strictEqual(pack.doc_pointers.some((p) => p.kind === 'skill-reference'), false);
  } finally {
    box.cleanup();
  }
});

test('A21 pack: a missing hybrid install degrades honestly (descriptor pointer, resolvable:false)', () => {
  const prevHome = process.env.HOME;
  const prevRoots = process.env.CC_SKILL_ROOTS;
  const prevPlatform = process.env.OPENCLAW_PLATFORM;
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf17-empty-box-'));
  process.env.HOME = emptyHome;
  process.env.CC_SKILL_ROOTS = path.join(emptyHome, 'no-skills');
  process.env.OPENCLAW_PLATFORM = 'mac-mini';
  try {
    const pack = buildContextPack(packInput('crm', 'GHL Specialist'));
    const refs = pack.doc_pointers.filter((p) => p.kind === 'skill-reference' || p.kind === 'hybrid-sop');
    assert.ok(refs.length > 0, 'the required references are still NAMED');
    assert.ok(refs.every((p) => p.resolvable === false), 'nothing may claim to resolve on an empty box');
    assert.ok(refs.every((p) => !path.isAbsolute(p.location) || !fs.existsSync(p.location)), 'no fabricated path');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevRoots === undefined) delete process.env.CC_SKILL_ROOTS; else process.env.CC_SKILL_ROOTS = prevRoots;
    if (prevPlatform === undefined) delete process.env.OPENCLAW_PLATFORM; else process.env.OPENCLAW_PLATFORM = prevPlatform;
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});

test('A21 parity: one shared composition — the same task/agent/SOP yields the identical reference section', () => {
  const box = makeHybridBox();
  try {
    const input = packInput('Community Builder', 'Community Manager');
    // The automatic path's composition (build + render) and the shared helper the
    // manual call site must use are the same thing.
    const autoComposition = renderContextPackSection(buildContextPack(input));
    const sharedComposition = buildDispatchReferenceSection(input);
    assert.strictEqual(sharedComposition, autoComposition);

    // …and it is deterministic, so two dispatch paths given the same inputs can
    // never drift into different reference sets.
    const second = buildDispatchReferenceSection(packInput('Community Builder', 'Community Manager'));
    assert.strictEqual(second, sharedComposition);

    // The required hybrid references are present in that shared section.
    assert.ok(sharedComposition.includes('GHL hybrid operations SOP cluster'));
    assert.ok(sharedComposition.includes('Skill 6'));
    assert.ok(sharedComposition.includes('Skill 36'));
  } finally {
    box.cleanup();
  }
});
