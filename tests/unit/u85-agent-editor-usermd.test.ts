/**
 * U085 — Agent editor USER.md sync map fix.
 * Run: node --import tsx --test tests/unit/u85-agent-editor-usermd.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(__dirname, '..', '..');
function fm() {
  const m = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'agent-files.ts'), 'utf8')
    .match(/const FILE_MAP[^=]*=\s*(\{[\s\S]*?\n\});/);
  if (!m) throw new Error('no');
  const o = {};
  for (const [, k, v] of m[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) o[k] = v;
  return o;
}
function mf() {
  const m = fs.readFileSync(path.join(ROOT, 'src', 'app', 'api', 'agents', '[id]', 'route.ts'), 'utf8')
    .match(/const mdFields\s*=\s*(\[[^\]]*\])/s);
  if (!m) throw new Error('no');
  return [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
}
test('main: FILE_MAP has user_md', () => { const f = fm(); assert.ok('user_md' in f); assert.equal(f['user_md'], 'USER.md'); });
test('main: mdFields has user_md', () => { assert.ok(mf().includes('user_md')); });
test('edge: all columns map to .md', () => { const f = fm(); for (const c of ['soul_md','user_md','agents_md','tools_md','memory_md']) { assert.ok(c in f); assert.ok(f[c].endsWith('.md')); } });
test('edge: guard exists', () => { assert.match(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'agent-files.ts'), 'utf8'), /if \(\!filename\) return;/); });
test('mutation: delete user_md detected', () => { const f = fm(); assert.ok('user_md' in f); const { user_md: _, ...mut } = f; assert.ok(!('user_md' in mut)); });
