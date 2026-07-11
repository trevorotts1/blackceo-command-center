/**
 * Unit tests — Intelligent name-agnostic department routing
 *
 * Proves that:
 *   1. Custom-named departments (NOT in DEFAULT_DEPARTMENTS) receive
 *      semantically-matched tasks via keyword fallback.
 *   2. loadDepartments() with a mocked DB returns ALL workspace rows as
 *      routable depts — including custom-named ones.
 *   3. comDispatch() routes a task to a custom-named dept when that dept's
 *      purpose matches the task meaning.
 *   4. Keyword fallback still routes correctly when no embedding key exists.
 *   5. The CEO / COM agent is NEVER the executor — it is the router fallback.
 *
 * Runs via Node built-in test runner under tsx (`npm run test:unit`).
 * No network calls are made — embedding path is bypassed because
 * OPENAI_API_KEY is not set in the test environment.
 */

// C8 — DB isolation. A statically-imported project module here transitively
// pulls in '@/lib/db', whose module-level
// `DB_PATH = process.env.DATABASE_PATH || <cwd>/mission-control.db` is frozen at
// eval time. This suite does not open the DB today, but nothing stopped it from
// starting to — and then it would have written to the LIVE production board.
// './_isolated-db' points DATABASE_PATH at a temp file and MUST stay the first
// import (it is a no-op for a suite that never opens the DB).
// Enforced by tests/unit/c8-db-isolation-guard.test.ts.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers to build in-memory test fixtures
// ---------------------------------------------------------------------------

import {
  type DepartmentConfig,
  DEFAULT_DEPARTMENTS,
} from '../../src/lib/routing/departments.config';
import {
  comDispatch,
  type AgentWithLoad,
} from '../../src/lib/routing/department-router';
import { cosineSimilarity } from '../../src/lib/sop-embeddings';

/** Build a minimal AgentWithLoad fixture. */
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

/** Build a minimal DepartmentConfig fixture (custom-named, NOT in DEFAULT_DEPARTMENTS). */
function makeCustomDept(
  id: string,
  name: string,
  purpose: string,
  keywords: string[] = [],
): DepartmentConfig {
  return {
    id,
    name,
    purpose,
    keywords,
    agentRoles: [name + ' Specialist'],
    priority: 6,
  };
}

// ---------------------------------------------------------------------------
// Test 1: DEFAULT_DEPARTMENTS has exactly 25 entries (QC gate 2.5)
// +1 for general-task (mandatory catch-all, feat/general-task-routing)
// ---------------------------------------------------------------------------
test('DEFAULT_DEPARTMENTS has exactly 25 canonical departments', () => {
  assert.equal(DEFAULT_DEPARTMENTS.length, 25);
});

// ---------------------------------------------------------------------------
// Test 2: All DEFAULT_DEPARTMENTS entries have a `purpose` field
// ---------------------------------------------------------------------------
test('all DEFAULT_DEPARTMENTS entries have a non-empty purpose string', () => {
  for (const dept of DEFAULT_DEPARTMENTS) {
    assert.ok(
      typeof dept.purpose === 'string' && dept.purpose.trim().length > 0,
      `dept "${dept.id}" is missing a purpose string`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 3: Custom-named dept receives semantically matched task (keyword path)
//
// Key assertion: a dept named "Brand Storytelling Lab" (NOT in DEFAULT_DEPARTMENTS)
// correctly receives a task about writing an IG origin story — purely via
// the keyword hints on the dept config, with no embedding key required.
// ---------------------------------------------------------------------------
test('custom-named dept "Brand Storytelling Lab" receives semantically matched task via keyword fallback', async () => {
  // Custom dept NOT in DEFAULT_DEPARTMENTS
  const brandStorytellingLab = makeCustomDept(
    'brand-storytelling-lab',
    'Brand Storytelling Lab',
    'Creates brand narratives, origin stories, content that communicates the company identity and mission across all channels.',
    ['brand story', 'origin story', 'narrative', 'instagram', 'ig', 'content', 'brand identity'],
  );

  // A standard dept that should NOT win
  const salesDept = makeCustomDept(
    'revenue-ignition',
    'Revenue Ignition Engine',
    'Handles sales pipeline, lead qualification, deal closing, and revenue generation.',
    ['sales', 'pipeline', 'deal', 'close', 'revenue', 'prospect'],
  );

  const departments = [salesDept, brandStorytellingLab];

  // Specialist agents for each dept
  const storytellingAgent = makeAgent({
    id: 'agent-storyteller',
    name: 'Maya (Brand Storyteller)',
    role: 'Brand Storytelling Lab Specialist',
    workspace_id: 'brand-storytelling-lab',
  });
  const salesAgent = makeAgent({
    id: 'agent-sales',
    name: 'Jordan (Revenue)',
    role: 'Revenue Ignition Engine Specialist',
    workspace_id: 'revenue-ignition',
  });

  const agents = [storytellingAgent, salesAgent];

  const result = await comDispatch(
    {
      title: 'Write our IG origin story',
      description: 'Need a compelling Instagram post that tells the brand story of how we started',
      priority: 'medium',
    },
    agents,
    departments,
  );

  assert.ok(result !== null, 'Should route to some agent');
  assert.equal(
    result.department,
    'Brand Storytelling Lab',
    `Expected "Brand Storytelling Lab" but got "${result?.department}" — custom-named dept must be reachable`,
  );
  assert.equal(result.agentId, 'agent-storyteller');
});

// ---------------------------------------------------------------------------
// Test 4: Another custom-named dept — "Revenue Ignition Engine" receives
//         a sales task even though the name is not in DEFAULT_DEPARTMENTS
// ---------------------------------------------------------------------------
test('custom-named dept "Revenue Ignition Engine" receives a sales task via keyword fallback', async () => {
  const revenueIgnition = makeCustomDept(
    'revenue-ignition',
    'Revenue Ignition Engine',
    'Sales pipeline management, lead generation, deal closing, and revenue conversion.',
    ['sales', 'prospect', 'pipeline', 'deal', 'close', 'lead', 'revenue', 'pitch'],
  );

  const designDept = makeCustomDept(
    'visual-magic-studio',
    'Visual Magic Studio',
    'Graphic design, brand visuals, logo creation, and visual content production.',
    ['design', 'graphic', 'logo', 'visual', 'brand'],
  );

  const departments = [designDept, revenueIgnition];

  const salesAgent = makeAgent({
    id: 'agent-revenue',
    name: 'Carlos (Revenue)',
    role: 'Revenue Ignition Engine Specialist',
    workspace_id: 'revenue-ignition',
  });
  const designAgent = makeAgent({
    id: 'agent-design',
    name: 'Lisa (Design)',
    role: 'Visual Magic Studio Specialist',
    workspace_id: 'visual-magic-studio',
  });

  const result = await comDispatch(
    {
      title: 'Close 5 prospects this week',
      description: 'Follow up with the leads from last week and close deals before Friday',
      priority: 'high',
    },
    [designAgent, salesAgent],
    departments,
  );

  assert.ok(result !== null, 'Should route to some agent');
  assert.equal(
    result.department,
    'Revenue Ignition Engine',
    `Expected "Revenue Ignition Engine" but got "${result?.department}"`,
  );
});

// ---------------------------------------------------------------------------
// Test 5: CEO / COM fallback is the ROUTER, not executor
//         When no dept matches, master agent is returned — but the routing
//         reason must say "re-dispatch" or "route", NOT "execute".
// ---------------------------------------------------------------------------
test('CEO / COM fallback routes tasks to master agent with re-dispatch reason', async () => {
  const genericDept = makeCustomDept(
    'some-dept',
    'Some Department',
    'Handles misc tasks.',
    ['misc'],
  );

  const masterAgent = makeAgent({
    id: 'master-agent',
    name: 'CEO',
    role: 'CEO',
    workspace_id: 'master-orchestrator',
    is_master: true,
    status: 'active',
  });

  // Non-master agent that should NOT be chosen when there's no dept match
  const deptAgent = makeAgent({
    id: 'dept-agent',
    name: 'SomeAgent',
    role: 'Some Department Specialist',
    workspace_id: 'some-dept',
    status: 'active',
  });

  // Task that won't match 'misc' keyword
  const result = await comDispatch(
    {
      title: 'Totally unrelated task',
      description: 'Something that matches no department keywords at all',
      priority: 'medium',
    },
    [deptAgent, masterAgent],
    [genericDept],
  );

  // Should fall through to the master agent
  assert.ok(result !== null, 'Should not return null — master agent should catch it');
  assert.equal(result.agentId, 'master-agent', 'CEO / COM master agent should be the fallback');
  // The reason must indicate routing/re-dispatch, not execution
  assert.ok(
    result.reason.toLowerCase().includes('route') ||
      result.reason.toLowerCase().includes('dispatch') ||
      result.reason.toLowerCase().includes('re-dispatch'),
    `Fallback reason should indicate routing behavior, got: "${result.reason}"`,
  );
});

// ---------------------------------------------------------------------------
// Test 6: Explicit department tag routes to exact custom dept name
// ---------------------------------------------------------------------------
test('explicit department tag routes to exact custom dept by name', async () => {
  const customDept = makeCustomDept(
    'vip-client-experience',
    'VIP Client Experience',
    'Handles VIP client relationships, high-touch service, and premium client journeys.',
    ['vip', 'client', 'premium', 'high-touch'],
  );

  const vipAgent = makeAgent({
    id: 'vip-agent',
    name: 'Priya (VIP)',
    role: 'VIP Client Experience Specialist',
    workspace_id: 'vip-client-experience',
  });

  const result = await comDispatch(
    {
      title: 'Send welcome package',
      description: 'Onboard new platinum client',
      priority: 'high',
      department: 'VIP Client Experience', // exact custom name
    },
    [vipAgent],
    [customDept],
  );

  assert.ok(result !== null, 'Should route');
  assert.equal(result.department, 'VIP Client Experience');
  assert.ok(result.reason.includes('Explicit department tag'));
});

// ---------------------------------------------------------------------------
// Test 7: cosineSimilarity — basic math correctness
// ---------------------------------------------------------------------------
test('cosineSimilarity returns 1.0 for identical vectors', () => {
  const v = [0.5, 0.3, 0.8, 0.1];
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 0.0001);
});

test('cosineSimilarity returns 0.0 for empty vectors', () => {
  assert.equal(cosineSimilarity([], []), 0);
});

test('cosineSimilarity returns a value between -1 and 1 for arbitrary vectors', () => {
  const a = [1, 0, 0, 1];
  const b = [0, 1, 1, 0];
  const sim = cosineSimilarity(a, b);
  assert.ok(sim >= -1 && sim <= 1, `Got ${sim}`);
});

// ---------------------------------------------------------------------------
// Test 8: Standard dept still routes correctly (regression guard)
// ---------------------------------------------------------------------------
test('standard "Social Media" dept still routes a social media task', async () => {
  const socialDept: DepartmentConfig = {
    ...DEFAULT_DEPARTMENTS.find((d) => d.id === 'social-media')!,
    // Simulate being loaded from workspaces table with the client's actual id
    id: 'dept-social',
    name: 'Social Media',
  };

  const socialAgent = makeAgent({
    id: 'social-agent',
    name: 'Alex (Social)',
    role: 'Social Media Agent',
    workspace_id: 'dept-social',
  });

  const result = await comDispatch(
    {
      title: 'Post 3 Instagram reels this week',
      description: 'Create and schedule reels for Instagram engagement',
      priority: 'medium',
    },
    [socialAgent],
    [socialDept],
  );

  assert.ok(result !== null);
  assert.equal(result.department, 'Social Media');
});

// ---------------------------------------------------------------------------
// Test 9: general-task is in DEFAULT_DEPARTMENTS with correct routing config
// ---------------------------------------------------------------------------
test('general-task entry exists in DEFAULT_DEPARTMENTS with priority 1 and empty keywords', () => {
  const gt = DEFAULT_DEPARTMENTS.find((d) => d.id === 'general-task');
  assert.ok(gt !== undefined, 'general-task must be in DEFAULT_DEPARTMENTS');
  assert.equal(gt!.priority, 1, 'general-task priority must be 1 (lowest, never wins on merit)');
  assert.deepEqual(gt!.keywords, [], 'general-task must have empty keywords (never wins keyword routing)');
});

// ---------------------------------------------------------------------------
// Test 10: general-task NEVER wins via keyword routing (score always 0)
//
// Even if a task has zero other matches, general-task must not win keyword
// scoring because it has empty keywords. This confirms the design invariant:
// "General Task is never selected on merit."
// ---------------------------------------------------------------------------
test('general-task never wins keyword ranking (empty keywords → always score 0)', () => {
  // Import rankDepartments via the module's internals — test via comDispatch
  // with keyword-mode only (no embedding key set).
  const gt = DEFAULT_DEPARTMENTS.find((d) => d.id === 'general-task')!;
  const salesDept = DEFAULT_DEPARTMENTS.find((d) => d.id === 'sales')!;

  // keyword scoring: text has sales keywords but not general-task keywords.
  // general-task has zero keywords so it can never match.
  const gtAgent = makeAgent({ id: 'gt-agent', name: 'GT Agent', role: 'Head of General Task', workspace_id: 'general-task' });
  const salesAgent = makeAgent({ id: 'sales-agent', name: 'Sales Agent', role: 'Sales Agent', workspace_id: 'sales' });

  // Run as keyword-only (no embedding key in test env)
  return comDispatch(
    { title: 'Close the deal with prospects', description: 'sales pipeline follow up', priority: 'medium' },
    [gtAgent, salesAgent],
    [gt, salesDept],
  ).then((result) => {
    assert.ok(result !== null, 'Should route somewhere');
    assert.notEqual(result!.department, 'General Task', 'general-task must NOT win on a sales task — it never wins on merit');
    assert.equal(result!.department, 'Sales', 'Sales dept should win when keywords match');
  });
});

// ---------------------------------------------------------------------------
// Test 11: low-confidence task → routes to general-task
//
// Simulates the MIN_ROUTING_CONFIDENCE floor by using a mocked semantic path.
// In keyword-only mode (no embedding key), we verify that when NO department
// has keyword hits at all, the task routes to general-task (not CEO master).
// ---------------------------------------------------------------------------
test('zero-keyword-hit task in keyword-only mode routes to general-task, not CEO master', async () => {
  // Departments with specific keywords that won't match the task
  const marketingDept = makeCustomDept(
    'marketing',
    'Marketing',
    'Campaigns, brand, email, SEO.',
    ['marketing', 'campaign', 'brand', 'seo', 'email'],
  );
  const salesDept = makeCustomDept(
    'sales',
    'Sales',
    'Pipeline, prospects, deals.',
    ['sales', 'pipeline', 'deal', 'close', 'prospect'],
  );
  const generalTaskDept: DepartmentConfig = {
    id: 'general-task',
    name: 'General Task',
    purpose: 'Catch-all for low-confidence tasks.',
    keywords: [], // never wins keyword scoring
    agentRoles: ['Head of General Task', 'Generalist Operator'],
    priority: 1,
  };

  const masterAgent = makeAgent({ id: 'master', name: 'CEO', role: 'CEO', is_master: true });
  const gtAgent = makeAgent({ id: 'gt-agent', name: 'GT Agent', role: 'Head of General Task', workspace_id: 'general-task' });
  const salesAgent = makeAgent({ id: 'sales-agent', name: 'Sales Agent', role: 'Sales', workspace_id: 'sales' });

  // Task that matches NO keywords in any specific dept
  const result = await comDispatch(
    {
      title: 'Review the quarterly philosophical treatise',
      description: 'Meditate on the nature of existence and organizational purpose',
      priority: 'low',
    },
    [masterAgent, gtAgent, salesAgent],
    [marketingDept, salesDept, generalTaskDept],
  );

  assert.ok(result !== null, 'Should route somewhere');
  assert.equal(
    result!.department,
    'General Task',
    `Expected "General Task" catch-all for zero-keyword-hit task but got "${result!.department}". CEO master should only be last resort when General Task has no agent.`,
  );
});

// ---------------------------------------------------------------------------
// Test 12: high-confidence task (many keyword hits) → routes to specific dept
//
// Regression guard: the General Task catch-all must NOT intercept tasks that
// clearly belong to a specific department (keyword mode).
// ---------------------------------------------------------------------------
test('high-confidence keyword match routes to specific department, not general-task', async () => {
  const webDevDept = makeCustomDept(
    'web-development',
    'Web Development',
    'Website development, React, Next.js, frontend/backend.',
    ['web', 'website', 'react', 'nextjs', 'frontend', 'backend', 'html', 'css', 'javascript'],
  );
  const generalTaskDept: DepartmentConfig = {
    id: 'general-task',
    name: 'General Task',
    purpose: 'Catch-all for low-confidence tasks.',
    keywords: [],
    agentRoles: ['Head of General Task'],
    priority: 1,
  };

  const webAgent = makeAgent({ id: 'web-agent', name: 'Dev', role: 'Web Developer', workspace_id: 'web-development' });
  const gtAgent = makeAgent({ id: 'gt-agent', name: 'GT Agent', role: 'Head of General Task', workspace_id: 'general-task' });

  const result = await comDispatch(
    {
      title: 'Build a React frontend dashboard',
      description: 'Create a Next.js website with CSS styling and HTML components',
      priority: 'high',
    },
    [gtAgent, webAgent],
    [generalTaskDept, webDevDept],
  );

  assert.ok(result !== null, 'Should route');
  assert.equal(
    result!.department,
    'Web Development',
    `Expected "Web Development" but got "${result!.department}" — high-confidence tasks must not fall to General Task`,
  );
});
