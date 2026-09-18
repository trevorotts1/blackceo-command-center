/**
 * npm >= 11.19 / 12 blocks dependency install scripts unless the root
 * package.json lists them in allowScripts, and refuses an allow-scripts CLI
 * or environment policy in a project-scoped install. `npm ci` exports every
 * config to its lifecycle children as npm_config_*, so a user-level
 * ~/.npmrc `allow-scripts=<pkg>` (left by an unrelated global install)
 * reached our postinstall's nested `npm rebuild` and failed the deploy on a
 * client Mac 2026-09-18 with EALLOWSCRIPTS. Policy lives in package.json
 * and the postinstall clears the inherited variable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('allowScripts declares every dependency that needs an install script', () => {
  const allow = pkg.allowScripts;
  assert.ok(allow && typeof allow === 'object', 'allowScripts field present');
  for (const name of ['better-sqlite3', 'esbuild', 'unrs-resolver', 'fsevents']) {
    assert.equal(allow[name], true, `${name} allowed (unpinned so dependency bumps do not silently drop the native build)`);
  }
});

test('the postinstall rebuild clears the inherited allow-scripts policy before nesting npm', () => {
  assert.match(pkg.scripts.postinstall, /^npm_config_allow_scripts= npm rebuild better-sqlite3$/);
});

test('no repo script passes --allow-scripts to a project-scoped npm command', () => {
  for (const f of ['scripts/atomic-deploy.sh', 'scripts/cc-start.sh']) {
    const text = readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
    assert.ok(!/npm (ci|install|rebuild)[^\n]*--allow-scripts/.test(text), `${f} passes no --allow-scripts flag`);
  }
});
