// scripts/pm2-single-instance-guard.mjs — U066 single-instance commit-time guard (audit H-C8)
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const shortHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
function sourceId(p) { return basename(p); }

export function describeApp(rawApp) {
  return {
    name: typeof rawApp.name === 'string' ? rawApp.name : '(unnamed)',
    execMode: rawApp.exec_mode,
    instances: rawApp.instances,
    cwd: typeof rawApp.cwd === 'string' ? rawApp.cwd : undefined,
    databasePath: rawApp.env && typeof rawApp.env.DATABASE_PATH === 'string' ? rawApp.env.DATABASE_PATH : undefined,
    isCommandCenter: typeof rawApp.args === 'string' && rawApp.args.includes('cc-start.sh'),
  };
}

export function loadRequirableConfig(absPath) {
  const source = sourceId(absPath);
  try {
    const mod = require_(absPath);
    return { source, apps: Array.isArray(mod.apps) ? mod.apps : [] };
  } catch (e) { return { source, apps: [], error: true, errorName: e.name }; }
}

export function loadShellTemplateConfig(absPath) {
  const source = sourceId(absPath);
  let text;
  try { text = readFileSync(absPath, 'utf8'); } catch (e) {
    return { source, apps: [], error: true, errorName: e.name, parseError: 'TEMPLATE-UNPARSEABLE' };
  }
  const lines = text.split('\n');
  let si = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('CANONICAL_ECOSYSTEM="')) { si = i; break; }
  }
  if (si >= 0) {
    const first = lines[si].slice(lines[si].indexOf('CANONICAL_ECOSYSTEM="') + 'CANONICAL_ECOSYSTEM="'.length);
    const js = [first];
    for (let i = si + 1; i < lines.length; i++) { const t = lines[i].trimEnd(); js.push(t); if (/^};"$/.test(t)) break; }
    let joined = js.join('\n');
    const ls = joined.lastIndexOf('};"'); if (ls >= 0) joined = joined.slice(0, ls + 2);
    joined = joined.replace(/\\"/g, '"').replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, '__SHELL_VAR_$1__');
    try {
      const r = new Function('module', joined + '; return module.exports;')({ exports: {} });
      return { source, apps: Array.isArray(r.apps) ? r.apps : [] };
    } catch (e) { return { source, apps: [], error: true, errorName: e.name, parseError: 'TEMPLATE-UNPARSEABLE' }; }
  }
  let ms = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].trimStart().startsWith('module.exports')) { ms = i; break; } }
  if (ms >= 0) {
    const js = [];
    for (let i = ms; i < lines.length; i++) { js.push(lines[i]); if (/^};?\s*$/.test(lines[i])) break; }
    try {
      const r = new Function('module', js.join('\n') + '; return module.exports;')({ exports: {} });
      return { source, apps: Array.isArray(r.apps) ? r.apps : [] };
    } catch (e) { return { source, apps: [], error: true, errorName: e.name, parseError: 'TEMPLATE-UNPARSEABLE' }; }
  }
  return { source, apps: [], error: true, errorName: 'Error', parseError: 'TEMPLATE-UNPARSEABLE' };
}

export function auditApps(apps, source) {
  const hard = [], advisory = [];
  for (const a of apps) {
    if (a.execMode !== undefined && a.execMode !== 'fork')
      hard.push({ code: 'EXEC-MODE-NOT-FORK', app: a.name, source, value: a.execMode });
    if (a.instances !== undefined && a.instances !== 1)
      hard.push({ code: 'INSTANCES-NOT-ONE', app: a.name, source, value: a.instances });
    if (a.instances === undefined)
      advisory.push({ code: 'INSTANCES-UNDECLARED', app: a.name, source, message: 'app does not declare `instances`. An explicit `instances: 1` removes the dependence on a PM2 default this repository has not pinned.' });
  }
  const cc = apps.filter(x => x.isCommandCenter && typeof x.databasePath === 'string');
  for (let i = 0; i < cc.length; i++)
    for (let j = i + 1; j < cc.length; j++)
      if (cc[i].databasePath === cc[j].databasePath)
        hard.push({ code: 'SHARED-DATABASE-PATH', app: cc[i].name, pairedApp: cc[j].name, source, pathDigest: shortHash(cc[i].databasePath), message: 'Two Command Center processes sharing one DATABASE_PATH hold two independent clients Sets over one shared source of truth.' });
  const ccwd = apps.filter(x => x.isCommandCenter && typeof x.cwd === 'string');
  const m = new Map();
  for (const a of ccwd) { if (!m.has(a.cwd)) m.set(a.cwd, []); m.get(a.cwd).push(a.name); }
  for (const [cwd, names] of m)
    if (names.length > 1)
      advisory.push({ code: 'SHARED-WORKING-DIRECTORY', apps: names, source, cwdDigest: shortHash(cwd), appCount: names.length, message: 'more than one Command Center app shares this working directory — invisible to warnIfClustered().' });
  return { hard, advisory };
}

export function runGuard({ files, repoRoot } = {}) {
  const root = repoRoot || process.cwd();
  const isExplicit = files && files.length > 0;
  const defaults = ['ecosystem.config.cjs','scripts/demo/demo.ecosystem.config.cjs','scripts/install/mac-mini-bootstrap.sh','scripts/install/vps-docker-bootstrap.sh'];
  const fList = isExplicit ? files : defaults;
  let paths;
  if (isExplicit) paths = fList.map(f => { try { return resolve(root, f); } catch { return f; } });
  else paths = fList.map(f => resolve(root, f));
  const allH = [], allA = [], sources = []; let ac = 0;
  for (const ap of paths) {
    let r;
    if (ap.endsWith('.cjs')) r = loadRequirableConfig(ap);
    else if (ap.endsWith('.sh')) r = loadShellTemplateConfig(ap);
    else continue;
    if (r.error && ap.endsWith('.sh')) allH.push({ code: 'TEMPLATE-UNPARSEABLE', source: r.source, errorName: r.errorName || 'Error' });
    if (r.error && isExplicit && ap.endsWith('.cjs')) allH.push({ code: 'LOAD-ERROR', source: r.source, errorName: r.errorName || 'Error' });
    if (!r.apps || r.apps.length === 0) { sources.push({ source: r.source, apps: 0, error: !!r.error }); continue; }
    const n = r.apps.map(describeApp);
    const { hard, advisory } = auditApps(n, r.source);
    allH.push(...hard); allA.push(...advisory); ac += n.length;
    sources.push({ source: r.source, apps: n.length });
  }
  const pass = allH.length === 0;
  return { pass, hard: allH, advisory: allA, appCount: ac, sources };
}

if (process.argv[1]) {
  const selfPath = realpathSync(fileURLToPath(import.meta.url));
  const argPath = realpathSync(resolve(process.argv[1]));
  if (selfPath === argPath) {
    const a = process.argv.slice(2);
    const r = runGuard(a.length > 0 ? { files: a } : {});
    console.log(JSON.stringify({ pass: r.pass, appCount: r.appCount, hard: r.hard, advisory: r.advisory }, null, 2));
    process.exit(r.pass ? 0 : 1);
  }
}
