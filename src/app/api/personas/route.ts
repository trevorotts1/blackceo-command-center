import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import os from 'os';

// ── needs-tags.json reader ────────────────────────────────────────────────
// Written by box-side converge (sync-extensions.sh --converge) at
//   <OC_ROOT>/extension-sync/needs-tags.json
// Schema: { "generated_at": "ISO-8601", "untagged": ["<slug>", ...] }
function loadUntaggedPersonaSlugs(): Set<string> {
  const home = process.env.HOME || os.homedir();
  const ocRoot = process.env.OPENCLAW_ROOT ||
    (existsSync('/data/.openclaw') ? '/data/.openclaw' : join(home, '.openclaw'));

  const candidates = [
    join(ocRoot, 'extension-sync', 'needs-tags.json'),
    join(process.cwd(), 'extension-sync', 'needs-tags.json'),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf-8')) as { untagged?: string[] };
        if (Array.isArray(raw.untagged)) return new Set(raw.untagged);
      } catch {
        // Corrupt file — treat as empty
      }
    }
  }
  return new Set();
}

export const dynamic = 'force-dynamic';

interface PersonaCategoryEntry {
  author: string;
  book: string;
  domain: string[];
  perspective: string[];
  custom: string[];
}

interface PersonaResponseItem {
  id: string;
  author: string;
  book: string;
  domain: string[];
  perspective: string[];
  custom: string[];
  category: string;
  blueprint_preview: string;
  // Tag-gate fields (§2.6): set by converge when domain or perspective is empty.
  needs_tags?: boolean;
  routable?: boolean;
}

const DOMAIN_TO_CATEGORY: Record<string, string> = {
  marketing: 'Marketing & Content',
  sales: 'Sales & Revenue',
  leadership: 'Leadership & Strategy',
  finance: 'Finance & Business Health',
  operations: 'Productivity & Systems',
  communication: 'Communication',
  copywriting: 'Marketing & Content',
  mindset: 'Coaching & Development',
  'productivity-systems': 'Productivity & Systems',
  coaching: 'Coaching & Development',
  'strategy-innovation': 'Leadership & Strategy',
  'personal-development': 'Coaching & Development',
};

function categoryForEntry(entry: PersonaCategoryEntry): string {
  for (const d of entry.domain || []) {
    if (DOMAIN_TO_CATEGORY[d]) return DOMAIN_TO_CATEGORY[d];
  }
  return 'General';
}

function loadPersonaCategoriesFile(): Record<string, PersonaCategoryEntry> {
  const homedir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const workspaceBase = process.env.WORKSPACE_BASE_PATH
    ? resolve(process.env.WORKSPACE_BASE_PATH.replace(/^~/, homedir))
    : join(homedir, 'clawd');

  const candidatePaths = [
    join(workspaceBase, 'coaching-personas', 'persona-categories.json'),
    join(homedir, 'Downloads', 'openclaw-master-files', 'coaching-personas', 'persona-categories.json'),
    join(
      homedir,
      '.openclaw',
      'skills',
      '22-book-to-persona-coaching-leadership-system',
      'persona-categories.json'
    ),
    // Onboarding installer location
    join('/opt', 'openclaw', 'skills', '22-book-to-persona-coaching-leadership-system', 'persona-categories.json'),
  ];

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf-8'));
        return raw.personas || {};
      } catch (e) {
        console.error('[Personas API] failed to parse', p, e);
      }
    }
  }
  return {};
}

function blueprintPreview(entry: PersonaCategoryEntry): string {
  const domains = (entry.domain || []).join(', ');
  const perspective = (entry.perspective || []).slice(0, 2).join(' / ');
  if (!domains && !perspective) {
    return `${entry.author}'s perspective from "${entry.book}".`;
  }
  return [
    `${entry.author}'s lens from "${entry.book}".`,
    domains ? `Domains: ${domains}.` : '',
    perspective ? `Style: ${perspective}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * GET /api/personas
 *
 * Returns the full persona catalog used by Skill 22 / persona-selector-v2,
 * loaded from persona-categories.json. Powers the /personas viewer page.
 */
export async function GET() {
  try {
    const raw = loadPersonaCategoriesFile();
    // Load converge-written needs-tags set (§2.6). A persona with empty domain
    // or perspective is not routable — mark it visibly, never silently omit.
    const untaggedSlugs = loadUntaggedPersonaSlugs();

    const personas: PersonaResponseItem[] = Object.entries(raw).map(([id, entry]) => {
      const hasDomain = Array.isArray(entry.domain) && entry.domain.length > 0;
      const hasPerspective = Array.isArray(entry.perspective) && entry.perspective.length > 0;
      // A persona needs tags if: the converge-written set says so, OR if the
      // domain/perspective arrays are genuinely empty (catches the orchestrator's
      // empty-tag stub before converge has run).
      const needsTags = untaggedSlugs.has(id) || !hasDomain || !hasPerspective;
      return {
        id,
        author: entry.author,
        book: entry.book,
        domain: entry.domain || [],
        perspective: entry.perspective || [],
        custom: entry.custom || [],
        category: categoryForEntry(entry),
        blueprint_preview: blueprintPreview(entry),
        needs_tags: needsTags,
        routable: !needsTags,
      };
    });

    // Stable sort: category then author surname.
    personas.sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return a.author.localeCompare(b.author);
    });

    return NextResponse.json({
      total: personas.length,
      personas,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/personas] failed:', err);
    return NextResponse.json(
      { total: 0, personas: [], error: 'Failed to load personas' },
      { status: 500 }
    );
  }
}
