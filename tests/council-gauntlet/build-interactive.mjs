/**
 * build-interactive.mjs — CWE-044 gauntlet: builds the interactive
 * harness page (real components, bundled with the repo's esbuild)
 * into the gauntlet evidence dir, next to the static snapshots.
 *
 *   node tests/council-gauntlet/build-interactive.mjs
 *
 * Env: GAUNTLET_OUT (default ~/workspace/skill77/cwe-044/evidence).
 * The medallion URLs are file:// URLs into THIS worktree's vendored
 * portraits, computed at build time, so a re-run on another tree
 * points at that tree's assets.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const outDir =
  process.env.GAUNTLET_OUT ??
  path.join(os.homedir(), 'workspace/skill77/cwe-044/evidence');
fs.mkdirSync(outDir, { recursive: true });

const esbuild = path.join(repoRoot, 'node_modules/.bin/esbuild');
execFileSync(
  esbuild,
  [
    'tests/council-gauntlet/interactive-entry.tsx',
    '--bundle',
    '--platform=browser',
    '--format=esm',
    '--target=es2022',
    `--alias:@=${path.join(repoRoot, 'src')}`,
    // The contracts barrel re-exports a Node-only schema generator;
    // its dynamic node: imports stay external and are never invoked
    // by the components this page mounts.
    '--external:node:*',
    `--outfile=${path.join(outDir, 'gauntlet-bundle.js')}`,
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

const portraitsDir = path.join(
  repoRoot,
  'src/components/council/portraits',
);
const seats = [
  'simon-sinek',
  'td-jakes',
  'oprah-winfrey',
  'tiffany-aliche',
  'russell-brunson',
  'michelle-obama',
  'brene-brown',
  'dennis-kimbro',
  'les-brown',
];
const small = {};
const large = {};
for (const seat of seats) {
  small[seat] = `file://${portraitsDir}/${seat}-sm.svg`;
  large[seat] = `file://${portraitsDir}/${seat}.svg`;
}

const html = `<!doctype html>
<!-- CWE-044 gauntlet interactive harness. Real CouncilShell + CouncilVerdict
     components of this tree, bundled with esbuild, over synthetic fixtures
     only (CWE-032 room fixture, CWE-034 session fixtures). No real client,
     session, or model output. Built by tests/council-gauntlet/build-interactive.mjs. -->
<html><head><meta charset="utf-8"><title>CWE-044 gauntlet: interactive room and verdict</title>
<link rel="stylesheet" href="./gauntlet-bundle.css">
</head>
<body style="margin:0">
<div id="gauntlet-root"></div>
<script>window.__GAUNTLET_MEDALLIONS__ = ${JSON.stringify({ small, large })};</script>
<script type="module" src="./gauntlet-bundle.js"></script>
</body></html>
`;
fs.writeFileSync(path.join(outDir, 'gauntlet-interactive.html'), html);
console.log(`interactive harness written to ${outDir}`);
