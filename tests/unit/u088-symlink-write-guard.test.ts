import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writeAgentFile, checkSharedFileSymlink, SharedFileSymlinkError, agentSlug, ensureAgentsDir } from '../../src/lib/agent-files';

const AGENTS = path.join(process.cwd(), 'agents');
const TEST_AGENT = 'u088-test-agent';
const SHARED = path.join(AGENTS, '_shared');
const AGENT_DIR = path.join(AGENTS, agentSlug(TEST_AGENT));

function setup() {
  ensureAgentsDir();
  fs.mkdirSync(SHARED, { recursive: true });
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHARED, 'AGENTS.md'), '# Shared Rules');
  fs.writeFileSync(path.join(SHARED, 'TOOLS.md'), '# Shared Tools');
  // Symlink shared files into agent dir
  try { fs.unlinkSync(path.join(AGENT_DIR, 'AGENTS.md')); } catch {}
  try { fs.unlinkSync(path.join(AGENT_DIR, 'TOOLS.md')); } catch {}
  fs.symlinkSync(path.join(SHARED, 'AGENTS.md'), path.join(AGENT_DIR, 'AGENTS.md'));
  fs.symlinkSync(path.join(SHARED, 'TOOLS.md'), path.join(AGENT_DIR, 'TOOLS.md'));
  // Clean non-shared files
  try { fs.unlinkSync(path.join(AGENT_DIR, 'SOUL.md')); } catch {}
  try { fs.unlinkSync(path.join(AGENT_DIR, 'MEMORY.md')); } catch {}
}

function cleanup() {
  try { fs.rmSync(AGENT_DIR, { recursive: true, force: true }); } catch {}
}

test('T1: writeAgentFile throws on symlinked AGENTS.md', () => {
  setup();
  try {
    assert.throws(
      () => writeAgentFile(TEST_AGENT, 'agents_md', '# New'),
      SharedFileSymlinkError
    );
  } finally { cleanup(); }
});

test('T2: writeAgentFile throws on symlinked TOOLS.md', () => {
  setup();
  try {
    assert.throws(
      () => writeAgentFile(TEST_AGENT, 'tools_md', '# New'),
      SharedFileSymlinkError
    );
  } finally { cleanup(); }
});

test('T3: writeAgentFile succeeds on SOUL.md (non-shared)', () => {
  setup();
  try {
    assert.doesNotThrow(() => writeAgentFile(TEST_AGENT, 'soul_md', '# Updated'));
    assert.equal(fs.readFileSync(path.join(AGENT_DIR, 'SOUL.md'), 'utf-8'), '# Updated');
  } finally { cleanup(); }
});

test('T4: writeAgentFile succeeds on new MEMORY.md (non-shared)', () => {
  setup();
  try {
    assert.doesNotThrow(() => writeAgentFile(TEST_AGENT, 'memory_md', '# Memory'));
    assert.ok(fs.existsSync(path.join(AGENT_DIR, 'MEMORY.md')));
  } finally { cleanup(); }
});

test('T5: writeAgentFile succeeds on non-symlinked AGENTS.md', () => {
  setup();
  try {
    // Remove the symlink, write directly
    fs.unlinkSync(path.join(AGENT_DIR, 'AGENTS.md'));
    assert.doesNotThrow(() => writeAgentFile(TEST_AGENT, 'agents_md', '# Direct'));
    assert.equal(fs.readFileSync(path.join(AGENT_DIR, 'AGENTS.md'), 'utf-8'), '# Direct');
  } finally { cleanup(); }
});

test('T6: checkSharedFileSymlink true for symlinked AGENTS.md', () => {
  setup();
  try {
    assert.equal(checkSharedFileSymlink(TEST_AGENT, 'agents_md'), true);
  } finally { cleanup(); }
});

test('T7: checkSharedFileSymlink false for non-shared soul_md', () => {
  setup();
  try {
    assert.equal(checkSharedFileSymlink(TEST_AGENT, 'soul_md'), false);
  } finally { cleanup(); }
});

test('T8: checkSharedFileSymlink false for non-symlink shared file', () => {
  setup();
  try {
    fs.unlinkSync(path.join(AGENT_DIR, 'AGENTS.md'));
    fs.writeFileSync(path.join(AGENT_DIR, 'AGENTS.md'), '# Direct');
    assert.equal(checkSharedFileSymlink(TEST_AGENT, 'agents_md'), false);
  } finally { cleanup(); }
});

test('T9: writeAgentFile no-op on unknown column', () => {
  setup();
  try {
    assert.doesNotThrow(() => writeAgentFile(TEST_AGENT, 'nonexistent' as any, '# X'));
  } finally { cleanup(); }
});

test('T10: SharedFileSymlinkError properties', () => {
  setup();
  try {
    try { writeAgentFile(TEST_AGENT, 'agents_md', '# X'); assert.fail('should throw'); } catch (e) {
      assert.ok(e instanceof SharedFileSymlinkError);
      assert.equal((e as any).column, 'agents_md');
      assert.equal((e as any).agentName, TEST_AGENT);
      assert.ok((e as any).message.includes('symlink'));
    }
  } finally { cleanup(); }
});
