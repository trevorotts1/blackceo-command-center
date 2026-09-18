/** next.config.mjs must never hand Next an absolute distDir. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function distDirWith(value: string | undefined): Promise<string> {
  if (value === undefined) delete process.env.NEXT_DIST_DIR; else process.env.NEXT_DIST_DIR = value;
  const url = pathToFileURL(path.join(process.cwd(), 'next.config.mjs')).href + `?v=${Math.random()}`;
  const mod = await import(url);
  return (mod.default as { distDir: string }).distDir;
}

test('unset → .next; relative passes through', async () => {
  assert.equal(await distDirWith(undefined), '.next');
  assert.equal(await distDirWith('.next.tmp.123'), '.next.tmp.123');
});

test('absolute inside the project → relative form; absolute outside → .next', async () => {
  assert.equal(await distDirWith(path.join(process.cwd(), '.next')), '.next');
  assert.equal(await distDirWith(path.join(process.cwd(), '.next.tmp.9')), '.next.tmp.9');
  assert.equal(await distDirWith('/definitely/elsewhere/.next'), '.next');
});
