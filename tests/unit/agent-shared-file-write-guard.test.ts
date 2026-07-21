/**
 * CC-SHARED-001 — T1-04 and T0-43.
 *
 * T1-04: every agent directory's AGENTS.md, TOOLS.md and USER.md are SYMBOLIC
 *   LINKS to agents/_shared/… (mode 120000, the same blob hash across all 23
 *   agent directories). `writeAgentFile` wrote straight through them, so ONE
 *   agent-scoped save from the per-agent editor replaced the operating rules —
 *   including the safety rules — for every agent in the company, and the
 *   response returned the single updated agent as if one agent had changed.
 *   agents/_shared/AGENTS.md itself lists "Editing this file (it's shared —
 *   edit `agents/_shared/AGENTS.md` instead)" among prohibited actions.
 *
 * T0-43: `user_md` was absent from the file map entirely, so the owner-profile
 *   save was accepted by the database and never written to disk. Every agent's
 *   startup procedure reads USER.md, so the agents kept running on the previous
 *   owner context while the interface kept showing the new text (it reads the
 *   database). The divergence was invisible from both ends.
 *
 * These tests use a REAL temporary agents tree with REAL symlinks, in the same
 * shape the repository ships (`agents/_shared/<FILE>` plus per-agent links), so
 * the fixture corresponds to what a real box has — the repository check at the
 * end asserts exactly that correspondence against the checked-in tree.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type AgentFiles = typeof import('../../src/lib/agent-files');

const loadAgentFiles = async (): Promise<AgentFiles> =>
  (await import('../../src/lib/agent-files')) as AgentFiles;

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Build a throwaway agents tree that mirrors the shipped shape and point the
 * writer at it with CC_AGENTS_DIR (the module's first-class override), so the
 * real repository tree is never touched.
 */
async function withAgentsTree<T>(
  agentNames: string[],
  fn: (ctx: { root: string; agentsDir: string; mod: AgentFiles }) => Promise<T> | T
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-shared-file-'));
  const agentsDir = path.join(root, 'agents');
  const sharedDir = path.join(agentsDir, '_shared');
  fs.mkdirSync(sharedDir, { recursive: true });

  const SHARED = ['AGENTS.md', 'TOOLS.md', 'USER.md'];
  const PER_AGENT = ['SOUL.md', 'MEMORY.md'];
  for (const f of SHARED) {
    fs.writeFileSync(path.join(sharedDir, f), `# shared ${f}\ncompany-wide rules\n`, 'utf-8');
  }
  for (const name of agentNames) {
    const dir = path.join(agentsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of SHARED) {
      fs.symlinkSync(path.join('..', '_shared', f), path.join(dir, f));
    }
    for (const f of PER_AGENT) {
      fs.writeFileSync(path.join(dir, f), `# ${name} ${f}\n`, 'utf-8');
    }
  }

  const previous = process.env.CC_AGENTS_DIR;
  process.env.CC_AGENTS_DIR = agentsDir;
  try {
    const mod = await loadAgentFiles();
    return await fn({ root, agentsDir, mod });
  } finally {
    if (previous === undefined) delete process.env.CC_AGENTS_DIR;
    else process.env.CC_AGENTS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const sha = (p: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('T1-04: an agent-scoped write through a shared symlink is REFUSED, and nothing changes', async () => {
  await withAgentsTree(['alpha-agent', 'beta-agent', 'gamma-agent'], async ({ agentsDir, mod }) => {
    const sharedPath = path.join(agentsDir, '_shared', 'AGENTS.md');
    const before = sha(sharedPath);
    const betaBefore = sha(path.join(agentsDir, 'beta-agent', 'AGENTS.md'));

    assert.throws(
      () => mod.writeAgentFile('alpha-agent', 'agents_md', 'REWRITTEN BY ONE AGENT'),
      (err: unknown) => err instanceof mod.SharedFileError,
      'writing an inherited file must throw SharedFileError'
    );

    assert.equal(sha(sharedPath), before, 'the shared file must be byte-unchanged');
    assert.equal(
      sha(path.join(agentsDir, 'beta-agent', 'AGENTS.md')),
      betaBefore,
      "no other agent's file may change"
    );
  });
});

test('T1-04 MUTATION: without the guard, one save rewrites every agent (the assertion is discriminating)', async () => {
  await withAgentsTree(['alpha-agent', 'beta-agent', 'gamma-agent'], async ({ agentsDir }) => {
    const sharedPath = path.join(agentsDir, '_shared', 'AGENTS.md');
    const before = sha(sharedPath);

    // The pre-fix writer, verbatim: no lstat, no link check.
    fs.writeFileSync(path.join(agentsDir, 'alpha-agent', 'AGENTS.md'), 'REWRITTEN BY ONE AGENT', 'utf-8');

    assert.notEqual(sha(sharedPath), before, 'the pre-fix writer must have rewritten the shared file');
    for (const other of ['beta-agent', 'gamma-agent']) {
      assert.equal(
        fs.readFileSync(path.join(agentsDir, other, 'AGENTS.md'), 'utf-8'),
        'REWRITTEN BY ONE AGENT',
        `${other} must have been rewritten too — that is the defect this guard prevents`
      );
    }
  });
});

test('T1-04: every inherited column is detected, and per-agent files still write', async () => {
  await withAgentsTree(['alpha-agent'], async ({ agentsDir, mod }) => {
    const inherited = mod.inheritedFields('alpha-agent').sort();
    assert.deepEqual(
      inherited,
      ['agents_md', 'tools_md', 'user_md'],
      'AGENTS.md, TOOLS.md and USER.md are the inherited files in the shipped shape'
    );

    // ANTI-FALSE-POSITIVE: a genuinely per-agent file still writes normally.
    mod.writeAgentFile('alpha-agent', 'soul_md', '# alpha soul v2\n');
    assert.equal(
      fs.readFileSync(path.join(agentsDir, 'alpha-agent', 'SOUL.md'), 'utf-8'),
      '# alpha soul v2\n'
    );
    mod.writeAgentFile('alpha-agent', 'memory_md', '# alpha memory v2\n');
    assert.equal(
      fs.readFileSync(path.join(agentsDir, 'alpha-agent', 'MEMORY.md'), 'utf-8'),
      '# alpha memory v2\n'
    );
  });
});

test('T0-43: user_md is mapped, so a save either writes the file or is refused — never both-and-neither', async () => {
  await withAgentsTree(['alpha-agent'], async ({ agentsDir, mod }) => {
    // Inherited in the shipped shape → refused, and the file is untouched.
    const sharedUser = path.join(agentsDir, '_shared', 'USER.md');
    const before = sha(sharedUser);
    assert.throws(
      () => mod.writeAgentFile('alpha-agent', 'user_md', 'NEW OWNER PROFILE'),
      (err: unknown) => err instanceof mod.SharedFileError
    );
    assert.equal(sha(sharedUser), before);

    // When USER.md is NOT a link (an agent that owns its own profile), the save
    // reaches disk — it is no longer silently dropped for want of a map entry.
    const dir = path.join(agentsDir, 'alpha-agent');
    fs.unlinkSync(path.join(dir, 'USER.md'));
    fs.writeFileSync(path.join(dir, 'USER.md'), '# old profile\n', 'utf-8');
    mod.writeAgentFile('alpha-agent', 'user_md', '# new profile\n');
    assert.equal(fs.readFileSync(path.join(dir, 'USER.md'), 'utf-8'), '# new profile\n');
  });
});

test('the ONE authorised company-wide write reaches the shared file, and only that', async () => {
  await withAgentsTree(['alpha-agent', 'beta-agent'], async ({ agentsDir, mod }) => {
    mod.writeSharedFile('AGENTS.md', '# shared AGENTS.md\ndeliberate company-wide change\n');
    assert.match(
      fs.readFileSync(path.join(agentsDir, '_shared', 'AGENTS.md'), 'utf-8'),
      /deliberate company-wide change/
    );
    // Both agents see it, because that is what "shared" means.
    for (const a of ['alpha-agent', 'beta-agent']) {
      assert.match(
        fs.readFileSync(path.join(agentsDir, a, 'AGENTS.md'), 'utf-8'),
        /deliberate company-wide change/
      );
    }
    assert.throws(
      () => mod.writeSharedFile('NOT-MANAGED.md', 'x'),
      /not one of the managed agent files/
    );
  });
});

test('repository check: no agent-scoped write path targets a symlinked file', async () => {
  // E5 — the fixture above corresponds to the real tree: assert the shipped
  // agents/ directory really does carry per-agent symlinks into _shared, and
  // that EVERY such link is a column the guard governs. If a new shared file
  // appears (or a link is added for a column the map does not know), this fails.
  const agentsDir = path.join(REPO_ROOT, 'agents');
  assert.ok(fs.existsSync(agentsDir), 'the repository ships an agents/ directory');

  const previous = process.env.CC_AGENTS_DIR;
  process.env.CC_AGENTS_DIR = agentsDir;
  const mod = await loadAgentFiles();

  const managed = new Set(['SOUL.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'MEMORY.md']);
  const dirs = fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_shared')
    .map((d) => d.name);

  assert.ok(dirs.length > 0, 'there is at least one agent directory to check');

  let linkedFiles = 0;
  for (const dir of dirs) {
    for (const entry of fs.readdirSync(path.join(agentsDir, dir), { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      if (!managed.has(entry.name)) continue;
      linkedFiles += 1;
      const target = fs.readlinkSync(path.join(agentsDir, dir, entry.name));
      assert.match(
        target,
        /_shared\//,
        `${dir}/${entry.name} links outside agents/_shared (${target})`
      );
    }
  }
  assert.ok(
    linkedFiles > 0,
    'the shipped tree really does use symlinks for shared files (if this fails the fixture no longer matches production)'
  );

  // Every managed filename must be reachable from the column map, so a shared
  // file can never be edited through a column the preflight does not check.
  const columns = ['soul_md', 'user_md', 'agents_md', 'tools_md', 'memory_md'];
  const covered = new Set<string>();
  for (const dir of dirs.slice(0, 1)) {
    for (const column of columns) {
      const t = mod.sharedFileTarget(dir, column);
      if (t !== null) covered.add(column);
    }
  }
  assert.ok(
    covered.size > 0,
    'the guard resolves at least one inherited column against the real tree'
  );
  if (previous === undefined) delete process.env.CC_AGENTS_DIR;
  else process.env.CC_AGENTS_DIR = previous;
});

// ───────────────────────────────────────────────────────────────────────────
// Route level: the PATCH handler must refuse an inherited field BEFORE the
// database write, so the record and the disk can never disagree about whether
// a save happened.
// ───────────────────────────────────────────────────────────────────────────
test('T1-04/T0-43 route: saving an inherited field returns 409 and changes neither disk nor database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-shared-route-'));
  const agentsDir = path.join(root, 'agents');
  const sharedDir = path.join(agentsDir, '_shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  for (const f of ['AGENTS.md', 'TOOLS.md', 'USER.md']) {
    fs.writeFileSync(path.join(sharedDir, f), `# shared ${f}\ncompany-wide rules\n`, 'utf-8');
  }

  const previous = process.env.CC_AGENTS_DIR;
  process.env.CC_AGENTS_DIR = agentsDir;
  try {
    await import('./_isolated-db');
    const { run, queryOne } = await import('../../src/lib/db');
    const { v4: uuidv4 } = await import('uuid');
    const { PATCH } = await import('../../src/app/api/agents/[id]/route');
    const { NextRequest } = await import('next/server');

    const wsId = `ws-shared-${uuidv4()}`;
    run(`INSERT INTO workspaces (id, name, slug, description, icon) VALUES (?, ?, ?, ?, ?)`, [
      wsId,
      'Shared File Guard',
      `shared-file-guard-${uuidv4()}`,
      'fixture',
      '🔒',
    ]);
    const agentId = uuidv4();
    const agentName = 'Guarded Agent';
    run(
      `INSERT INTO agents (id, workspace_id, name, role, status, agents_md, user_md, soul_md, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, wsId, agentName, 'fixture', 'standby', '# original rules\n', '# original owner\n',
       '# original soul\n', new Date().toISOString(), new Date().toISOString()]
    );

    // The agent's directory mirrors the shipped shape: inherited links.
    const slugDir = path.join(agentsDir, 'guarded-agent');
    fs.mkdirSync(slugDir, { recursive: true });
    for (const f of ['AGENTS.md', 'TOOLS.md', 'USER.md']) {
      fs.symlinkSync(path.join('..', '_shared', f), path.join(slugDir, f));
    }
    fs.writeFileSync(path.join(slugDir, 'SOUL.md'), '# original soul\n', 'utf-8');

    const sharedBefore = sha(path.join(sharedDir, 'AGENTS.md'));

    const patch = (body: unknown) =>
      PATCH(
        new NextRequest(`http://localhost/api/agents/${agentId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: agentId }) }
      );

    const res = await patch({ agents_md: 'REWRITTEN BY ONE AGENT' });
    assert.equal(res.status, 409, 'an inherited field must be refused with a conflict');
    const payload = await res.json();
    assert.equal(payload.code, 'SHARED_FILE');
    assert.deepEqual(payload.fields, ['agents_md'], 'the response names the inherited field');

    assert.equal(sha(path.join(sharedDir, 'AGENTS.md')), sharedBefore, 'the shared file is byte-unchanged');
    const row = queryOne<{ agents_md: string }>('SELECT agents_md FROM agents WHERE id = ?', [agentId]);
    assert.equal(
      row?.agents_md,
      '# original rules\n',
      'the database was not updated either — the preflight runs BEFORE the write'
    );

    // The owner profile is inherited in this shape too: refused, not silently
    // accepted-and-never-written (T0-43).
    const resUser = await patch({ user_md: 'NEW OWNER PROFILE' });
    assert.equal(resUser.status, 409);
    const userRow = queryOne<{ user_md: string }>('SELECT user_md FROM agents WHERE id = ?', [agentId]);
    assert.equal(userRow?.user_md, '# original owner\n', 'the owner profile was not silently updated');

    // ANTI-FALSE-POSITIVE: a per-agent field still saves, and the response
    // names which fields are inherited so the editor can render them read-only.
    const resSoul = await patch({ soul_md: '# updated soul\n' });
    assert.equal(resSoul.status, 200, 'a per-agent field must still save');
    const soulPayload = await resSoul.json();
    assert.deepEqual(
      [...soulPayload.inherited_fields].sort(),
      ['agents_md', 'tools_md', 'user_md'],
      'the response names the inherited fields'
    );
    assert.equal(fs.readFileSync(path.join(slugDir, 'SOUL.md'), 'utf-8'), '# updated soul\n');
  } finally {
    if (previous === undefined) delete process.env.CC_AGENTS_DIR;
    else process.env.CC_AGENTS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
