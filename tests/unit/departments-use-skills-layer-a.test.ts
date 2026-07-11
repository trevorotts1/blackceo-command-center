/**
 * Unit tests — Layer A: departments-that-use-skills (task → skill matcher)
 *
 * Proves that `matchSkillsForTask()` (src/lib/context-pack.ts):
 *   1. Globs installed SKILL.md files under the (env-overridable) skill roots
 *      and returns at most the top-N (default 3) matches.
 *   2. Ranks by keyword overlap when no embedding key is configured (the
 *      zero-config fallback) — the most relevant skill wins.
 *   3. Dept-scopes candidates via the onboarding skill-department-map.json:
 *      a skill mapped to another department is excluded; an unmapped skill is
 *      always a candidate; the same skill is included for its own department.
 *   4. Returns [] when no skills are installed / nothing matches.
 *   5. `renderMatchedSkillsSection()` emits the "SKILLS AVAILABLE FOR THIS TASK"
 *      block, and `buildContextPack()` threads `matched_skills` through so
 *      `renderContextPackSection()` renders them.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 * NO network calls: every embedding-provider key is cleared in the environment
 * so the matcher takes the keyword path deterministically.
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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  matchSkillsForTask,
  renderMatchedSkillsSection,
  buildContextPack,
  renderContextPackSection,
} from '../../src/lib/context-pack';

// ---------------------------------------------------------------------------
// Fixture: a temp skills tree + a skill-department-map.json
// ---------------------------------------------------------------------------

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skills-layer-a-'));
const SKILLS_DIR = path.join(TMP_ROOT, 'skills');
const MAP_PATH = path.join(TMP_ROOT, 'skill-department-map.json');

function writeSkill(dir: string, name: string, description: string): void {
  const skillDir = path.join(SKILLS_DIR, dir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`,
    'utf8',
  );
}

// Distinct-keyword skills so keyword scoring is unambiguous.
writeSkill('video-editor', 'video-editor', 'Edit and render video clips, timelines, transitions and captions.');
writeSkill('video-captioner', 'video-captioner', 'Add synced captions and subtitles to a finished video.');
writeSkill('invoice-bot', 'invoice-bot', 'Generate and send customer invoices and payment reminders.');
writeSkill('data-cleaner', 'data-cleaner', 'Clean, dedupe and normalize spreadsheet datasets.');
writeSkill('seo-writer', 'seo-writer', 'Write search-optimized marketing blog articles and website copy.');
writeSkill('audio-mixer', 'audio-mixer', 'Mix and master multitrack audio and podcast episodes.');

// seo-writer is scoped to marketing ONLY; every other skill is unmapped (global).
fs.writeFileSync(MAP_PATH, JSON.stringify({ 'seo-writer': ['marketing'] }, null, 2), 'utf8');

// ---------------------------------------------------------------------------
// Environment: pin the skill roots + map, and clear every embedding key so the
// matcher is deterministic (keyword path, no network).
// ---------------------------------------------------------------------------

function pinEnv(): void {
  process.env.CC_SKILL_ROOTS = SKILLS_DIR;
  process.env.CC_SKILL_DEPARTMENT_MAP = MAP_PATH;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_AI_STUDIO_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.SOP_EMBEDDING_PROVIDER;
}
pinEnv();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('globs SKILL.md files and keyword-ranks the most relevant skill first', async () => {
  pinEnv();
  const matches = await matchSkillsForTask({
    title: 'Produce a promotional video with captions',
    description: 'Edit the raw footage into a short video with animated captions and transitions.',
  });

  assert.ok(matches.length > 0, 'expected at least one keyword match');
  assert.ok(matches.length <= 3, `expected top-3 cap, got ${matches.length}`);
  assert.equal(matches[0].matchKind, 'keyword', 'no embedding key → keyword path');

  const names = matches.map((m) => m.name);
  assert.ok(
    names.includes('video-editor') || names.includes('video-captioner'),
    `expected a video skill to match, got: ${names.join(', ')}`,
  );
  // The invoice / data / audio skills share none of the task keywords.
  assert.ok(!names.includes('invoice-bot'), 'unrelated invoice skill must not match');
  assert.ok(!names.includes('data-cleaner'), 'unrelated data skill must not match');

  // Location points at a real SKILL.md on disk.
  for (const m of matches) {
    assert.ok(m.location.endsWith('SKILL.md'), 'location must be a SKILL.md path');
    assert.equal(m.resolvable, true, 'fixture SKILL.md must resolve on disk');
    assert.ok(m.score > 0, 'keyword match must have a positive score');
  }
});

test('caps results at the top-3 by default and honours an explicit limit', async () => {
  pinEnv();
  // A broad task that matches many skills (video + captions + audio + data + copy).
  const many = await matchSkillsForTask({
    title: 'Video, audio, captions, spreadsheet and marketing copy work',
    description: 'A grab-bag task touching video, audio, captions, datasets and articles.',
  });
  assert.ok(many.length <= 3, `default cap is 3, got ${many.length}`);

  const limited = await matchSkillsForTask(
    {
      title: 'Video, audio, captions, spreadsheet and marketing copy work',
      description: 'A grab-bag task touching video, audio, captions, datasets and articles.',
    },
    { limit: 2 },
  );
  assert.ok(limited.length <= 2, `explicit limit=2 not honoured, got ${limited.length}`);
});

test('dept-scopes candidates via skill-department-map.json', async () => {
  pinEnv();
  const task = {
    title: 'Write marketing blog articles and website copy',
    description: 'Produce optimized marketing articles and copy for the site.',
  };

  // seo-writer is mapped to marketing ONLY → excluded for a non-marketing dept
  // even though its keywords match the task best.
  const eng = await matchSkillsForTask({ ...task, department: 'engineering' });
  assert.ok(
    !eng.map((m) => m.name).includes('seo-writer'),
    'seo-writer is scoped to marketing and must be excluded for engineering',
  );

  // For the marketing department the same skill IS a candidate (and top match).
  const mkt = await matchSkillsForTask({ ...task, department: 'marketing' });
  assert.ok(
    mkt.map((m) => m.name).includes('seo-writer'),
    'seo-writer must be available to its own (marketing) department',
  );
});

test('unmapped skills are globally available regardless of department', async () => {
  pinEnv();
  // video-editor is NOT in the map → available to any department.
  const matches = await matchSkillsForTask({
    title: 'Edit a video with transitions',
    description: 'Cut and render the video with transitions and captions.',
    department: 'engineering',
  });
  assert.ok(
    matches.map((m) => m.name).includes('video-editor'),
    'unmapped skill must be available to any department',
  );
});

test('returns [] when the skill roots contain no skills', async () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skills-empty-'));
  process.env.CC_SKILL_ROOTS = emptyRoot;
  const matches = await matchSkillsForTask({ title: 'anything', description: 'at all' });
  assert.deepEqual(matches, []);
  pinEnv(); // restore for later tests
});

test('discovers skills reached through a symlinked directory', async () => {
  pinEnv();
  // Plugin skills under ~/.claude/skills are commonly symlinks; the Dirent
  // type is neither file nor dir for a symlink, so the walker must stat-follow.
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skills-external-'));
  const realSkillDir = path.join(externalDir, 'motion-grapher');
  fs.mkdirSync(realSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(realSkillDir, 'SKILL.md'),
    '---\nname: motion-grapher\ndescription: Build keyframe motion graphics and animated lower-thirds.\n---\n',
    'utf8',
  );
  const linkPath = path.join(SKILLS_DIR, 'motion-grapher-link');
  try {
    fs.symlinkSync(realSkillDir, linkPath, 'dir');
  } catch {
    return; // symlinks unsupported on this host — skip
  }

  const matches = await matchSkillsForTask({
    title: 'Create keyframe motion graphics',
    description: 'Produce animated keyframe lower-thirds for the reel.',
  });
  assert.ok(
    matches.map((m) => m.name).includes('motion-grapher'),
    `symlinked skill must be discovered, got: ${matches.map((m) => m.name).join(', ')}`,
  );

  fs.rmSync(linkPath, { force: true });
});

test('renderMatchedSkillsSection emits the SKILLS AVAILABLE block', async () => {
  pinEnv();
  const matches = await matchSkillsForTask({
    title: 'Edit a video with captions',
    description: 'Render the video with captions and transitions.',
  });
  assert.ok(matches.length > 0);

  const rendered = renderMatchedSkillsSection(matches);
  assert.match(rendered, /SKILLS AVAILABLE FOR THIS TASK/);
  assert.match(rendered, new RegExp(matches[0].name));
  assert.ok(rendered.includes(matches[0].location), 'render must include the SKILL.md path');

  // Empty input → no-op block.
  assert.equal(renderMatchedSkillsSection([]), '');
});

test('buildContextPack threads matched_skills through to the render', async () => {
  pinEnv();
  const matched = await matchSkillsForTask({
    title: 'Edit a video with captions',
    description: 'Render the video with captions and transitions.',
  });
  assert.ok(matched.length > 0);

  const pack = buildContextPack({
    task: { id: 't1', title: 'Edit a video with captions', description: 'x', department: null, workspace_id: null },
    agent: { id: 'a1', name: 'Editor', role: 'video' },
    specialistType: 'permanent',
    matchedSkills: matched,
  });

  assert.equal(pack.matched_skills.length, matched.length);
  assert.equal(pack.matched_skills[0].name, matched[0].name);

  const section = renderContextPackSection(pack);
  assert.match(section, /SKILLS AVAILABLE FOR THIS TASK/);

  // Default (no matchedSkills passed) → empty array, never undefined.
  const bare = buildContextPack({
    task: { id: 't2', title: 'x', description: 'y', department: null, workspace_id: null },
    agent: { id: 'a2', name: 'Nobody', role: 'general' },
    specialistType: 'on-call',
  });
  assert.deepEqual(bare.matched_skills, []);
});
