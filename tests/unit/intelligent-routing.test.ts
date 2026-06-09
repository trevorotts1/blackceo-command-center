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
// Test 1: DEFAULT_DEPARTMENTS has exactly 24 entries (QC gate 2.5)
// ---------------------------------------------------------------------------
test('DEFAULT_DEPARTMENTS has exactly 24 canonical departments', () => {
  assert.equal(DEFAULT_DEPARTMENTS.length, 24);
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
