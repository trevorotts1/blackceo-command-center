/**
 * Unit tests — finding 38: a missing skill binding must NOT silently permit
 * unrelated skills.
 *
 * `matchSkillsForTask()` (src/lib/context-pack.ts) used to return unrestricted
 * candidates when (a) no bound skill matched the installed files, or (b) the
 * skill-department-map was missing/unreadable. An absent onboarding tree or a
 * dangling skill symlink therefore produced an UNRELATED skill handoff instead
 * of a missing-dependency state.
 *
 * Proves the fix for both states, and that the two are DISTINGUISHED:
 *   • config_absent       — onboarding tree not on the box (no roots, no map)
 *   • deps_unresolvable   — configuration present but names missing things
 *                           (map path missing/unparseable, bound skill absent,
 *                            dangling skill symlink)
 * Both block the handoff ([] from the matcher) and name the missing paths; a
 * healthy box still resolves (control test — no over-blocking).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 * NO network: every embedding-provider key is cleared so the keyword path runs.
 */

// C8 — DB isolation, must be the FIRST import (the bound-skill test seeds rows).
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { matchSkillsForTask } from '../../src/lib/context-pack';

interface Resolution {
  status: string;
  detail: string;
  missingPaths: string[];
}

/** The classification surface the dispatch sites use to name missing paths. */
async function resolution(agentId?: string | null): Promise<Resolution> {
  const mod = (await import('../../src/lib/context-pack')) as unknown as {
    resolveSkillDependencies?: (o?: { agentId?: string | null }) => Resolution;
  };
  assert.equal(
    typeof mod.resolveSkillDependencies,
    'function',
    'context-pack must export resolveSkillDependencies() so dispatch can name the missing paths',
  );
  return mod.resolveSkillDependencies!({ agentId });
}

/** One isolated "box": fresh HOME, pinned skill root, explicit map choice. */
interface Box {
  home: string;
  skillsDir: string;
  mapPath: string;
  writeSkill: (dir: string, name: string, description: string) => void;
}

function makeBox(o: { map: 'valid' | 'none' | 'missing' | 'broken' }): Box {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'l23-home-'));
  const skillsDir = path.join(home, 'skills-box');
  fs.mkdirSync(skillsDir, { recursive: true });

  process.env.HOME = home;
  delete process.env.BLACKCEO_COMMAND_CENTER_ROOT;
  process.env.CC_SKILL_ROOTS = skillsDir;
  delete process.env.SKILL_DEPARTMENT_MAP;
  delete process.env.CC_SKILL_DEPARTMENT_MAP;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_AI_STUDIO_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.SOP_EMBEDDING_PROVIDER;

  const mapPath = path.join(home, 'skill-department-map.json');
  if (o.map === 'valid') {
    fs.writeFileSync(mapPath, JSON.stringify({ 'video-editor': ['media'] }), 'utf8');
    process.env.CC_SKILL_DEPARTMENT_MAP = mapPath;
  } else if (o.map === 'broken') {
    fs.writeFileSync(mapPath, '{"departments": ', 'utf8'); // truncated JSON
    process.env.CC_SKILL_DEPARTMENT_MAP = mapPath;
  } else if (o.map === 'missing') {
    process.env.CC_SKILL_DEPARTMENT_MAP = mapPath; // configured, but not on disk
  }
  // 'none' → both env vars unset and HOME is empty: no map anywhere.

  const writeSkill = (dir: string, name: string, description: string): void => {
    const skillDir = path.join(skillsDir, dir);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
      'utf8',
    );
  };

  return { home, skillsDir, mapPath, writeSkill };
}

const VIDEO_TASK = {
  title: 'Edit the raw video footage into a short promo',
  description: 'Cut and render the video with captions and transitions.',
};

// ---------------------------------------------------------------------------
// State 1 — ABSENT CONFIGURATION (onboarding tree not on this box)
// ---------------------------------------------------------------------------

test('absent dept map + installed skills → config_absent, handoff blocked, paths named', async () => {
  const box = makeBox({ map: 'none' });
  box.writeSkill('video-editor', 'video-editor', 'Edit and render video clips, timelines and captions.');

  // Failing-before shape: this used to return the video skill ("unscoped").
  const matches = await matchSkillsForTask(VIDEO_TASK);
  assert.deepEqual(
    matches,
    [],
    'absent onboarding config must not hand off an unrelated/unscoped skill',
  );

  const r = await resolution();
  assert.equal(r.status, 'config_absent', `expected config_absent, got ${r.status} (${r.detail})`);
  assert.ok(
    r.missingPaths.some((p) => p.endsWith('skill-department-map.json')),
    `missingPaths must name the probed map locations, got: ${JSON.stringify(r.missingPaths)}`,
  );
});

test('absent skill roots entirely → config_absent naming the probed roots', async () => {
  const box = makeBox({ map: 'none' });
  process.env.CC_SKILL_ROOTS = path.join(box.home, 'no-skills-here');

  const matches = await matchSkillsForTask(VIDEO_TASK);
  assert.deepEqual(matches, []);

  const r = await resolution();
  assert.equal(r.status, 'config_absent');
  assert.ok(
    r.missingPaths.includes(path.join(box.home, 'no-skills-here')),
    `missingPaths must name the absent root, got: ${JSON.stringify(r.missingPaths)}`,
  );
});

// ---------------------------------------------------------------------------
// State 2 — CONFIGURED BUT UNRESOLVABLE
// ---------------------------------------------------------------------------

test('configured dept map path that does not exist → deps_unresolvable, handoff blocked', async () => {
  const box = makeBox({ map: 'missing' });
  box.writeSkill('video-editor', 'video-editor', 'Edit and render video clips, timelines and captions.');

  const matches = await matchSkillsForTask(VIDEO_TASK);
  assert.deepEqual(matches, [], 'a configured-but-missing dept map must not fall through to global scope');

  const r = await resolution();
  assert.equal(r.status, 'deps_unresolvable', `expected deps_unresolvable, got ${r.status} (${r.detail})`);
  assert.deepEqual(r.missingPaths, [box.mapPath]);
});

test('configured dept map that will not parse → deps_unresolvable, handoff blocked', async () => {
  const box = makeBox({ map: 'broken' });
  box.writeSkill('video-editor', 'video-editor', 'Edit and render video clips, timelines and captions.');

  const matches = await matchSkillsForTask(VIDEO_TASK);
  assert.deepEqual(matches, [], 'an unreadable dept map must block the handoff, not widen it');

  const r = await resolution();
  assert.equal(r.status, 'deps_unresolvable', `expected deps_unresolvable, got ${r.status} (${r.detail})`);
  assert.deepEqual(r.missingPaths, [box.mapPath]);
  assert.match(r.detail, /unreadable|unparseable/i);
});

test('dangling skill symlink → deps_unresolvable naming the link, handoff blocked', async () => {
  const box = makeBox({ map: 'valid' });
  box.writeSkill('video-editor', 'video-editor', 'Edit and render video clips, timelines and captions.');

  const link = path.join(box.skillsDir, 'podcast-production-engine');
  try {
    fs.symlinkSync(path.join(box.home, 'gone-skill-tree'), link, 'dir');
  } catch {
    return; // symlinks unsupported on this host — skip
  }

  const matches = await matchSkillsForTask(VIDEO_TASK);
  assert.deepEqual(matches, [], 'a broken skill symlink must not hand off a different skill');

  const r = await resolution();
  assert.equal(r.status, 'deps_unresolvable', `expected deps_unresolvable, got ${r.status} (${r.detail})`);
  assert.ok(
    r.missingPaths.includes(link),
    `missingPaths must name the dangling link, got: ${JSON.stringify(r.missingPaths)}`,
  );

  fs.rmSync(link, { force: true });
});

test('agent bound to a skill that is not installed → deps_unresolvable, handoff blocked', async () => {
  const box = makeBox({ map: 'valid' });
  // An unrelated skill IS installed; the bound engine is NOT.
  box.writeSkill('video-editor', 'video-editor', 'Edit and render video clips, timelines and captions.');

  const missingSource = path.join(box.home, 'not-installed', '58-podcast-production-engine');

  const db = (await import('../../src/lib/db')).getDb();
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES (?, ?, ?)').run(
    'l23-ws',
    'L23 Test',
    'l23-ws',
  );
  db.prepare('INSERT OR REPLACE INTO agents (id, name, role, workspace_id) VALUES (?, ?, ?, ?)').run(
    'l23-agent',
    'L23 Agent',
    'specialist',
    'l23-ws',
  );
  db.prepare('INSERT OR REPLACE INTO skills (id, slug, name, source_path, enabled) VALUES (?, ?, ?, ?, 1)').run(
    'l23-skill',
    '58-podcast-production-engine',
    'podcast-production-engine',
    missingSource,
  );
  db.prepare('INSERT OR REPLACE INTO agent_skills (agent_id, skill_id) VALUES (?, ?)').run(
    'l23-agent',
    'l23-skill',
  );

  const matches = await matchSkillsForTask(VIDEO_TASK, { agentId: 'l23-agent' });
  assert.deepEqual(
    matches,
    [],
    'when every bound skill is missing on disk, an unrelated installed skill must NOT be handed off',
  );

  const r = await resolution('l23-agent');
  assert.equal(r.status, 'deps_unresolvable', `expected deps_unresolvable, got ${r.status} (${r.detail})`);
  assert.ok(
    r.missingPaths.includes(missingSource),
    `missingPaths must name the bound skill's source_path, got: ${JSON.stringify(r.missingPaths)}`,
  );
});

// ---------------------------------------------------------------------------
// Control — a healthy box still resolves (the fix must not over-block)
// ---------------------------------------------------------------------------

test('healthy box (map + installed skill) → ok and the skill is still handed off', async () => {
  const box = makeBox({ map: 'valid' });
  box.writeSkill('video-editor', 'video-editor', 'Edit and render video clips, timelines and captions.');

  const matches = await matchSkillsForTask(VIDEO_TASK);
  assert.ok(matches.length > 0, 'a healthy box must still hand off its installed skill');
  assert.equal(matches[0].name, 'video-editor');

  const r = await resolution();
  assert.equal(r.status, 'ok', `expected ok, got ${r.status} (${r.detail})`);
  assert.deepEqual(r.missingPaths, []);
});
