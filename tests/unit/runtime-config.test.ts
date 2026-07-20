import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureRuntimeConfigFile,
  runtimeConfigPath,
  runtimeConfigTemplatePath,
  type RuntimeConfigName,
} from '../../src/lib/runtime-config';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-runtime-config-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  return root;
}

test('all four per-box configs generate from tracked templates without mutating templates', () => {
  const root = fixtureRoot();
  const names: RuntimeConfigName[] = [
    'company-config.json',
    'departments.json',
    'board-slas.json',
    'logo-config.json',
  ];

  for (const name of names) {
    const template = runtimeConfigTemplatePath(name, root);
    const runtime = runtimeConfigPath(name, root);
    const expected = JSON.stringify({ fixture: name });
    fs.writeFileSync(template, expected);

    assert.equal(fs.existsSync(runtime), false);
    assert.equal(ensureRuntimeConfigFile(name, root), runtime);
    assert.equal(fs.readFileSync(runtime, 'utf8'), expected);

    fs.writeFileSync(runtime, JSON.stringify({ customized: name }));
    assert.equal(ensureRuntimeConfigFile(name, root), runtime);
    assert.equal(fs.readFileSync(runtime, 'utf8'), JSON.stringify({ customized: name }));
    assert.equal(fs.readFileSync(template, 'utf8'), expected);
  }
});

test('a missing template leaves the runtime path absent for safe caller fallback', () => {
  const root = fixtureRoot();
  const runtime = ensureRuntimeConfigFile('company-config.json', root);
  assert.equal(runtime, path.join(root, 'config', 'company-config.json'));
  assert.equal(fs.existsSync(runtime), false);
});
