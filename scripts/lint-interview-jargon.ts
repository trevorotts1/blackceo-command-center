#!/usr/bin/env npx tsx
/**
 * scripts/lint-interview-jargon.ts  (Wave 5 · P3-4)
 *
 * Build-time lint of the /interview surface's USER-FACING strings against the
 * Skill-23 forbidden client-facing jargon list.
 *
 *   Acceptance (WAVE5-INTERVIEW-APP-BUILD-PLAN P3-4):
 *     • fails CI if a forbidden term appears in an interview UI string
 *     • loads the term list from the CANONICAL forbidden-jargon.json — no local copy
 *
 * ── Single source of truth ────────────────────────────────────────────────────
 * The term list is NEVER inlined here. It is loaded at runtime from the canonical
 *   23-ai-workforce-blueprint/interview/forbidden-jargon.json
 * exactly the way scripts/qc-interview-completion.py loads it (skill_dir /
 * "interview" / "forbidden-jargon.json", then jargon_data["terms"]). We resolve
 * the skill tree through the SAME seam the interview API routes use
 * (src/lib/interview/paths.ts → resolveSkillScriptsDir), so the app, the QC gate
 * and this lint all agree on which file is canonical. If the canonical file
 * cannot be located the lint HARD-FAILS (cannot verify ⇒ fail CI) rather than
 * silently passing.
 *
 * ── clientAnswerExempt ────────────────────────────────────────────────────────
 * forbidden-jargon.json marks "agent" clientAnswerExempt: in the transcript QC
 * scan that term is forbidden only in AI-authored prose, not inside a quoted
 * client answer. Static UI copy contains NO quoted-client-answer spans — every
 * string in an interview component is developer-authored copy the owner will
 * read — so the exemption does not apply here and ALL terms (including "agent")
 * are scanned. This is the whole point of the doctrine: the owner never sees the
 * word "agent".
 *
 * ── Matching ──────────────────────────────────────────────────────────────────
 * Word-boundary, case-insensitive, per the file's own `notes`. Multi-word terms
 * ("tech stack", "sub agent") match as complete phrases and tolerate wrapped
 * whitespace (JSX / template literals split across lines) by allowing \s+ between
 * words. term + every listed variant is checked; one hit per term per string.
 *
 * ── What counts as a "UI string" ──────────────────────────────────────────────
 * We parse each interview source file with the TypeScript compiler API and scan
 * ONLY rendered copy — JSX text and string / template literals — so identifiers,
 * comments and imports (which legitimately reference the OpenClaw "agent") never
 * false-positive. Non-textual string positions are skipped: module specifiers,
 * object-literal keys, and JSX attributes whose name is not user-visible
 * (className, id, key, href, src, style, role, data-*, …). User-visible attrs
 * (aria-label, title, alt, placeholder, …) ARE scanned.
 *
 * ── Scope ─────────────────────────────────────────────────────────────────────
 * The interview UI roots below. Extra roots may be added via --root <dir>
 * (repeatable) or INTERVIEW_UI_ROOTS (path-separated). The canonical JSON path
 * may be overridden via --jargon-list <file> or FORBIDDEN_JARGON_JSON.
 *
 * Usage:
 *   npx tsx scripts/lint-interview-jargon.ts
 *   npx tsx scripts/lint-interview-jargon.ts --root src/app/interview --jargon-list /path/to/forbidden-jargon.json
 *
 * Exit: 0 = clean · 1 = jargon hit(s) or canonical list unresolved.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { resolveSkillScriptsDir } from '../src/lib/interview/paths';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── UI roots (interview surface) ──────────────────────────────────────────────
// Directories whose string / JSX copy is rendered to the business owner. Kept as
// a labelled constant so new interview screens are trivial to add.
const DEFAULT_UI_ROOTS: ReadonlyArray<string> = [
  'src/app/interview',
  'src/components/interview',
  'src/app/onboarding/resume',
];

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.jsx', '.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'coverage']);

// JSX attributes that never carry owner-facing prose (so their string values are
// not scanned). Anything NOT in this set (aria-label, title, alt, placeholder,
// label, …) IS treated as user-facing.
const NON_TEXT_JSX_ATTRS = new Set([
  'classname',
  'class',
  'id',
  'key',
  'ref',
  'href',
  'src',
  'srcset',
  'rel',
  'target',
  'type',
  'name',
  'htmlfor',
  'role',
  'style',
  'slot',
  'tabindex',
  'data-testid',
  'testid',
  'as',
  'variant',
  'size',
  'color',
]);

// ── term list (loaded from canonical JSON — NEVER inlined) ─────────────────────

interface JargonTerm {
  term: string;
  variants?: string[];
  clientAnswerExempt?: boolean;
  [k: string]: unknown;
}
interface ForbiddenJargonFile {
  terms?: JargonTerm[];
  [k: string]: unknown;
}

/**
 * Resolve the canonical forbidden-jargon.json. Order:
 *   1. --jargon-list <file>
 *   2. FORBIDDEN_JARGON_JSON env
 *   3. skill tree via resolveSkillScriptsDir() → ../interview/forbidden-jargon.json
 *      (mirrors qc-interview-completion.py: skill_dir/"interview"/"forbidden-jargon.json")
 *   4. common local onboarding checkouts next to this repo
 * Returns the first path that EXISTS, or null.
 */
function resolveJargonPath(cliPath: string | null): string | null {
  const candidates: string[] = [];
  if (cliPath) candidates.push(path.resolve(cliPath));
  if (process.env.FORBIDDEN_JARGON_JSON) {
    candidates.push(path.resolve(process.env.FORBIDDEN_JARGON_JSON));
  }
  // Canonical: same resolution the interview routes + the QC gate use.
  const skillDir = path.dirname(resolveSkillScriptsDir()); // .../23-ai-workforce-blueprint
  candidates.push(path.join(skillDir, 'interview', 'forbidden-jargon.json'));
  // Sibling onboarding checkouts (developer machines / CI layouts).
  const rel = ['23-ai-workforce-blueprint', 'interview', 'forbidden-jargon.json'];
  candidates.push(path.join(REPO_ROOT, '..', 'openclaw-onboarding', ...rel));
  candidates.push(path.join(REPO_ROOT, '..', 'onboarding', ...rel));

  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function loadTerms(jargonPath: string): JargonTerm[] {
  let raw: string;
  try {
    raw = fs.readFileSync(jargonPath, 'utf-8');
  } catch (err) {
    fail(`could not read canonical forbidden-jargon.json at ${jargonPath}: ${String(err)}`);
  }
  let data: ForbiddenJargonFile;
  try {
    data = JSON.parse(raw) as ForbiddenJargonFile;
  } catch (err) {
    fail(`could not parse forbidden-jargon.json at ${jargonPath}: ${String(err)}`);
  }
  const terms = data!.terms;
  if (!Array.isArray(terms) || terms.length === 0) {
    fail(`forbidden-jargon.json at ${jargonPath} has no "terms" array`);
  }
  return terms!;
}

// ── matching ──────────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CompiledTerm {
  term: string;
  patterns: { variant: string; re: RegExp }[];
}

/** Build one word-boundary, case-insensitive, whitespace-tolerant regex per variant. */
function compileTerms(terms: JargonTerm[]): CompiledTerm[] {
  return terms.map((entry) => {
    const variants = [entry.term, ...(entry.variants ?? [])].filter(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    const patterns = variants.map((variant) => {
      const body = variant
        .trim()
        .split(/\s+/)
        .map((w) => escapeRegExp(w))
        .join('\\s+');
      return { variant, re: new RegExp(`\\b${body}\\b`, 'i') };
    });
    return { term: entry.term, patterns };
  });
}

interface Hit {
  file: string;
  line: number;
  term: string;
  matchedVariant: string;
  snippet: string;
}

/** Scan one extracted UI string; at most one hit per term. */
function scanString(
  text: string,
  compiled: CompiledTerm[],
  file: string,
  baseLine: number,
  hits: Hit[],
): void {
  for (const ct of compiled) {
    for (const { variant, re } of ct.patterns) {
      const m = re.exec(text);
      if (m) {
        const before = text.slice(0, m.index);
        const line = baseLine + (before.match(/\n/g)?.length ?? 0);
        const raw = text.replace(/\s+/g, ' ').trim();
        hits.push({
          file,
          line,
          term: ct.term,
          matchedVariant: variant,
          snippet: raw.length > 100 ? raw.slice(0, 100) + '…' : raw,
        });
        break; // one hit per term per string
      }
    }
  }
}

// ── UI-string extraction (TypeScript AST) ─────────────────────────────────────

function jsxAttrNameOf(node: ts.Node): string | null {
  // If `node` is the value/initializer of a JSX attribute, return the attr name.
  let cur: ts.Node | undefined = node;
  // A JsxExpression wraps {"..."}; step through it.
  if (cur.parent && ts.isJsxExpression(cur.parent)) cur = cur.parent;
  const parent = cur.parent;
  if (parent && ts.isJsxAttribute(parent) && parent.initializer === cur) {
    return parent.name.getText().toLowerCase();
  }
  return null;
}

function isNonUiStringPosition(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): boolean {
  const parent = node.parent;
  if (!parent) return false;
  // Module specifiers: import/export "..."
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  // require('...') / import('...')
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    const ex = parent.expression;
    if (ts.isIdentifier(ex) && ex.text === 'require') return true;
    if (ex.kind === ts.SyntaxKind.ImportKeyword) return true;
  }
  // Object-literal property KEYS ({ "className": ... }) — not rendered copy.
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  // Object-literal property VALUES under a non-textual key ({ className: 'x' },
  // { testId: 'agent-row' }) — config, not owner-facing copy.
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const key = parent.name.getText().replace(/^['"]|['"]$/g, '').toLowerCase();
    if (NON_TEXT_JSX_ATTRS.has(key) || key.startsWith('data-')) return true;
  }
  // Non-textual JSX attributes (className, id, href, data-*, …).
  const attr = jsxAttrNameOf(node);
  if (attr && (NON_TEXT_JSX_ATTRS.has(attr) || attr.startsWith('data-'))) return true;
  return false;
}

/**
 * True when a string literal is a CSS class-name list rather than owner-facing
 * copy — e.g. the interview theme map's `bubbleAgent: 'iv-bubble iv-bubble-agent'`.
 * Such a value is developer-only styling data (BEM/kebab class tokens under a
 * semantic key like `bubbleAgent`, which the NON_TEXT_JSX_ATTRS key-skip does not
 * catch), never prose the owner reads — the '-agent' inside `iv-bubble-agent` is a
 * class token, not the word "agent" in a sentence.
 *
 * Rule (deliberately conservative to avoid false NEGATIVES on real copy): skip
 * ONLY when every whitespace-separated token is a lowercase kebab identifier AND
 * at least one token contains a hyphen. So a bare word ("agent"), a Title-Case
 * label ("Departments") or a real sentence is still scanned — the exemption is
 * limited to strings that can only be class names.
 */
function looksLikeCssClassList(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const kebab = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  if (!tokens.every((t) => kebab.test(t))) return false;
  return tokens.some((t) => t.includes('-'));
}

function extractFromFile(file: string, compiled: CompiledTerm[], hits: Hit[]): void {
  const text = fs.readFileSync(file, 'utf-8');
  const rel = path.relative(REPO_ROOT, file);
  const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, kind);

  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isNonUiStringPosition(node) && !looksLikeCssClassList(node.text)) {
        // content starts one char after the opening quote/backtick
        scanString(node.text, compiled, rel, lineOf(node.getStart(sf) + 1), hits);
      }
    } else if (ts.isTemplateExpression(node)) {
      // Scan the static chunks only (skip ${...} interpolations).
      scanString(node.head.text, compiled, rel, lineOf(node.head.getStart(sf) + 1), hits);
      for (const span of node.templateSpans) {
        scanString(span.literal.text, compiled, rel, lineOf(span.literal.getStart(sf) + 1), hits);
      }
    } else if (ts.isJsxText(node)) {
      const t = node.text;
      if (t.trim().length > 0) scanString(t, compiled, rel, lineOf(node.getStart(sf)), hits);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ── file discovery ────────────────────────────────────────────────────────────

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if (e.isFile() && SCANNED_EXTENSIONS.has(path.extname(e.name))) {
      out.push(full);
    }
  }
}

// ── cli ───────────────────────────────────────────────────────────────────────

interface Args {
  roots: string[];
  jargonList: string | null;
}
function parseArgs(argv: string[]): Args {
  const roots: string[] = [];
  let jargonList: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') roots.push(argv[++i]);
    else if (a.startsWith('--root=')) roots.push(a.slice('--root='.length));
    else if (a === '--jargon-list') jargonList = argv[++i];
    else if (a.startsWith('--jargon-list=')) jargonList = a.slice('--jargon-list='.length);
  }
  if (process.env.INTERVIEW_UI_ROOTS) {
    for (const r of process.env.INTERVIEW_UI_ROOTS.split(path.delimiter)) {
      if (r.trim()) roots.push(r.trim());
    }
  }
  return { roots, jargonList };
}

function fail(msg: string): never {
  console.error(`[lint-interview-jargon] FAIL: ${msg}`);
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const jargonPath = resolveJargonPath(args.jargonList);
  if (!jargonPath) {
    fail(
      'canonical forbidden-jargon.json not found. Point --jargon-list or ' +
        'FORBIDDEN_JARGON_JSON at 23-ai-workforce-blueprint/interview/forbidden-jargon.json, ' +
        'or install the Skill-23 tree (OPENCLAW_SKILL23_SCRIPTS).',
    );
  }
  const compiled = compileTerms(loadTerms(jargonPath));

  const rootRels = args.roots.length ? args.roots : [...DEFAULT_UI_ROOTS];
  const files: string[] = [];
  for (const r of rootRels) {
    const abs = path.isAbsolute(r) ? r : path.join(REPO_ROOT, r);
    walk(abs, files);
  }

  const hits: Hit[] = [];
  for (const f of files) {
    try {
      extractFromFile(f, compiled, hits);
    } catch (err) {
      fail(`could not scan ${path.relative(REPO_ROOT, f)}: ${String(err)}`);
    }
  }

  console.error(
    `[lint-interview-jargon] canonical list: ${jargonPath}\n` +
      `[lint-interview-jargon] scanned ${files.length} file(s) across ${rootRels.length} root(s): ` +
      rootRels.join(', '),
  );

  if (hits.length === 0) {
    console.error('[lint-interview-jargon] PASS: no forbidden jargon in interview UI strings.');
    process.exit(0);
  }

  console.error(`\n[lint-interview-jargon] FAIL: ${hits.length} forbidden jargon hit(s):`);
  for (const h of hits) {
    console.error(
      `  ${h.file}:${h.line}  '${h.term}'` +
        (h.matchedVariant !== h.term ? ` (as "${h.matchedVariant}")` : '') +
        `  →  ${h.snippet}`,
    );
  }
  console.error(
    '\nReplace with owner-friendly language (see approvedReplacement in ' +
      'forbidden-jargon.json). The owner must never read internal jargon.',
  );
  process.exit(1);
}

main();
