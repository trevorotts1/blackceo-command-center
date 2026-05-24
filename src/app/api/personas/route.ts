import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import os from 'os';

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
    const personas: PersonaResponseItem[] = Object.entries(raw).map(([id, entry]) => ({
      id,
      author: entry.author,
      book: entry.book,
      domain: entry.domain || [],
      perspective: entry.perspective || [],
      custom: entry.custom || [],
      category: categoryForEntry(entry),
      blueprint_preview: blueprintPreview(entry),
    }));

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
