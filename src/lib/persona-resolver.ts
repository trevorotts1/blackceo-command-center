/**
 * Persona Content Resolver
 * 
 * Fetches persona content from the gemini-index.sqlite database.
 * Handles both direct persona lookup (by slug) and auto-selection (via gemini-search.py).
 */

import { execSync } from 'child_process';
import path from 'path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.PERSONA_DB_PATH || path.join(
  process.env.HOME || '/Users/blackceomacmini',
  'clawd/data/coaching-personas/gemini-index.sqlite'
);

export interface PersonaContent {
  slug: string;
  name: string;
  author: string;
  book: string;
  category: string;
  content: string;
  source: 'direct' | 'auto' | 'fallback';
  score?: number;
}

export interface AutoSelectedPersona {
  score: number;
  persona: string;
  content: string;
}

/**
 * Get persona content by slug from the SQLite database.
 * Returns the persona-blueprint.md content for the given persona.
 */
export function getPersonaBySlug(slug: string): PersonaContent | null {
  try {
    if (!slug || slug === 'auto') {
      return null;
    }

    const db = new Database(DB_PATH, { readonly: true });
    
    // Look for persona-blueprint.md for this slug
    const row = db.prepare(
      `SELECT file_path, content FROM embeddings 
       WHERE file_path LIKE ? 
       AND file_path LIKE '%persona-blueprint.md%'
       LIMIT 1`
    ).get(`%${slug}%`) as { file_path: string; content: string } | undefined;
    
    db.close();

    if (!row || !row.content) {
      console.warn(`[PersonaResolver] No content found for persona: ${slug}`);
      return null;
    }

    // Extract persona details from the file path
    const personaName = path.basename(path.dirname(row.file_path));
    const { author, book, category } = getPersonaDetails(slug);

    return {
      slug,
      name: personaName,
      author,
      book,
      category,
      content: row.content,
      source: 'direct',
    };
  } catch (error) {
    console.error(`[PersonaResolver] Error fetching persona ${slug}:`, error);
    return null;
  }
}

/**
 * Auto-select personas using gemini-search.py based on task description.
 * Returns top 3 matching personas sorted by relevance score.
 */
export function autoSelectPersonas(taskDescription: string, limit: number = 3): AutoSelectedPersona[] {
  try {
    if (!taskDescription || taskDescription.trim().length < 10) {
      console.log('[PersonaResolver] Task description too short for auto-selection');
      return [];
    }

    const scriptPath = path.join(
      process.env.HOME || '/Users/blackceomacmini',
      'clawd/scripts/gemini-search.py'
    );

    // Escape the query for shell safety
    const escapedQuery = taskDescription.replace(/"/g, '\\"').replace(/\$/g, '\\$');
    
    const result = execSync(
      `python3 "${scriptPath}" "${escapedQuery}" --limit ${limit}`,
      {
        encoding: 'utf-8',
        timeout: 30000, // 30 second timeout
        env: {
          ...process.env,
          GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
        },
      }
    );

    return parseGeminiSearchOutput(result);
  } catch (error) {
    // Exit code 2 means API key issue - use fallback
    if (error instanceof Error && error.message.includes('exit code 2')) {
      console.warn('[PersonaResolver] Gemini API key issue, using fallback selection');
      return getFallbackPersonas(taskDescription, limit);
    }
    
    console.error('[PersonaResolver] Auto-selection failed:', error);
    return [];
  }
}

/**
 * Parse the output from gemini-search.py into structured results.
 */
function parseGeminiSearchOutput(output: string): AutoSelectedPersona[] {
  const results: AutoSelectedPersona[] = [];
  const lines = output.split('\n');
  
  let currentPersona: Partial<AutoSelectedPersona> = {};
  let contentLines: string[] = [];
  
  for (const line of lines) {
    // Parse header line: "[1] SCORE: 0.8234 | PERSONA: hormozi-100m-offers"
    const headerMatch = line.match(/^\[(\d+)\] SCORE: ([\d.]+) \| PERSONA: (.+)$/);
    if (headerMatch) {
      // Save previous persona if exists
      if (currentPersona.persona && contentLines.length > 0) {
        results.push({
          score: currentPersona.score || 0,
          persona: currentPersona.persona,
          content: contentLines.join('\n').trim(),
        });
      }
      
      // Start new persona
      currentPersona = {
        score: parseFloat(headerMatch[2]),
        persona: headerMatch[3].trim(),
      };
      contentLines = [];
    } else if (line.startsWith('-'.repeat(40))) {
      // Divider line - skip
      continue;
    } else if (currentPersona.persona) {
      // Content line
      contentLines.push(line);
    }
  }
  
  // Don't forget the last persona
  if (currentPersona.persona && contentLines.length > 0) {
    results.push({
      score: currentPersona.score || 0,
      persona: currentPersona.persona,
      content: contentLines.join('\n').trim(),
    });
  }
  
  return results;
}

/**
 * Fallback persona selection based on keyword matching.
 * Used when Gemini API is unavailable.
 */
function getFallbackPersonas(taskDescription: string, limit: number): AutoSelectedPersona[] {
  const lowerDesc = taskDescription.toLowerCase();
  
  // Simple keyword-based scoring
  const keywordMap: Record<string, string[]> = {
    'hormozi-100m-offers': ['offer', 'pricing', 'value', 'sale', 'grand slam', 'irresistible'],
    'miller-building-storybrand-2': ['story', 'brand', 'message', 'customer', 'hero', 'narrative'],
    'voss-never-split-difference': ['negotiate', 'negotiation', 'deal', 'no', 'tactical', 'empathy'],
    'clear-atomic-habits': ['habit', 'routine', 'behavior', 'change', 'system', 'atomic'],
    'cialdini-influence': ['persuasion', 'persuade', 'influence', 'psychology', 'compliance'],
    'sinek-start-with-why': ['purpose', 'why', 'inspire', 'leadership', 'vision', 'mission'],
    'robbins-five-second-rule': ['confidence', 'courage', 'action', 'fear', 'procrastinate'],
    'collins-good-to-great': ['excellence', 'flywheel', 'hedgehog', 'discipline', 'level 5'],
  };
  
  const scored = Object.entries(keywordMap).map(([slug, keywords]) => {
    const score = keywords.reduce((acc, keyword) => {
      return acc + (lowerDesc.includes(keyword) ? 1 : 0);
    }, 0);
    return { slug, score };
  });
  
  const topMatches = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  return topMatches.map(m => {
    const persona = getPersonaBySlug(m.slug);
    return {
      score: m.score / 5, // Normalize to ~0-1 range
      persona: m.slug,
      content: persona?.content || `Fallback persona: ${m.slug}`,
    };
  });
}

/**
 * Get persona details (author, book, category) from hardcoded map.
 * This mirrors the data in /api/settings/intelligence/route.ts
 */
function getPersonaDetails(slug: string): { author: string; book: string; category: string } {
  const details: Record<string, { author: string; book: string; category: string }> = {
    // Sales & Revenue
    'hormozi-100m-offers': { author: 'Alex Hormozi', book: '$100M Offers', category: 'Sales & Revenue' },
    'voss-never-split-difference': { author: 'Chris Voss', book: 'Never Split the Difference', category: 'Sales & Revenue' },
    'rackham-spin-selling': { author: 'Neil Rackham', book: 'SPIN Selling', category: 'Sales & Revenue' },
    'pink-to-sell-is-human': { author: 'Daniel Pink', book: 'To Sell Is Human', category: 'Sales & Revenue' },
    'jones-exactly-what-to-say': { author: 'Phil Jones', book: 'Exactly What to Say', category: 'Sales & Revenue' },
    'kane-hook-point': { author: 'Brendan Kane', book: 'Hook Point', category: 'Sales & Revenue' },
    'priestley-oversubscribed': { author: 'Daniel Priestley', book: 'Oversubscribed', category: 'Sales & Revenue' },
    // Marketing & Content
    'miller-building-storybrand-2': { author: 'Donald Miller', book: 'Building a StoryBrand', category: 'Marketing & Content' },
    'godin-this-is-marketing': { author: 'Seth Godin', book: 'This Is Marketing', category: 'Marketing & Content' },
    'bly-copywriters-handbook': { author: 'Robert Bly', book: "The Copywriter's Handbook", category: 'Marketing & Content' },
    'wiebe-copy-hackers': { author: 'Joanna Wiebe', book: 'Copy Hackers', category: 'Marketing & Content' },
    'cialdini-influence': { author: 'Robert Cialdini', book: 'Influence', category: 'Marketing & Content' },
    'charvet-words-change-minds': { author: 'Shelle Rose Charvet', book: 'Words That Change Minds', category: 'Marketing & Content' },
    // Leadership & Strategy
    'sinek-start-with-why': { author: 'Simon Sinek', book: 'Start With Why', category: 'Leadership & Strategy' },
    'sinek-find-your-why': { author: 'Simon Sinek', book: 'Find Your Why', category: 'Leadership & Strategy' },
    'collins-good-to-great': { author: 'Jim Collins', book: 'Good to Great', category: 'Leadership & Strategy' },
    'samit-disrupt-yourself': { author: 'Jay Samit', book: 'Disrupt Yourself', category: 'Leadership & Strategy' },
    'lakhiani-extraordinary-mind': { author: 'Vishen Lakhiani', book: 'The Code of the Extraordinary Mind', category: 'Leadership & Strategy' },
    'grover-relentless': { author: 'Tim Grover', book: 'Relentless', category: 'Leadership & Strategy' },
    // Productivity & Systems
    'clear-atomic-habits': { author: 'James Clear', book: 'Atomic Habits', category: 'Productivity & Systems' },
    'forte-building-second-brain': { author: 'Tiago Forte', book: 'Building a Second Brain', category: 'Productivity & Systems' },
    'forte-para-method': { author: 'Tiago Forte', book: 'The PARA Method', category: 'Productivity & Systems' },
    'moran-12-week-year': { author: 'Brian Moran', book: 'The 12 Week Year', category: 'Productivity & Systems' },
    'duhigg-power-of-habit': { author: 'Charles Duhigg', book: 'The Power of Habit', category: 'Productivity & Systems' },
    'pink-when': { author: 'Daniel Pink', book: 'When', category: 'Productivity & Systems' },
    // Finance & Business Health
    'michalowicz-profit-first': { author: 'Mike Michalowicz', book: 'Profit First', category: 'Finance & Business Health' },
    // Coaching & Human Development
    'robbins-five-second-rule': { author: 'Mel Robbins', book: 'The 5 Second Rule', category: 'Coaching & Development' },
    'robbins-let-them-theory': { author: 'Mel Robbins', book: 'The Let Them Theory', category: 'Coaching & Development' },
    'sharma-5am-club': { author: 'Robin Sharma', book: 'The 5 AM Club', category: 'Coaching & Development' },
    'goggins-cant-hurt-me': { author: 'David Goggins', book: "Can't Hurt Me", category: 'Coaching & Development' },
    'jakes-instinct': { author: 'T.D. Jakes', book: 'Instinct', category: 'Coaching & Development' },
    'pink-drive': { author: 'Daniel Pink', book: 'Drive', category: 'Coaching & Development' },
    'attwood-passion-test': { author: 'Janet Attwood', book: 'The Passion Test', category: 'Coaching & Development' },
    'grenny-crucial-conversations': { author: 'Joseph Grenny', book: 'Crucial Conversations', category: 'Coaching & Development' },
    // Emotional Intelligence & Relationships
    'tawwab-set-boundaries-find-peace': { author: 'Nedra Glover Tawwab', book: 'Set Boundaries, Find Peace', category: 'Emotional Intelligence' },
    'brown-atlas-of-heart': { author: 'Brene Brown', book: 'Atlas of the Heart', category: 'Emotional Intelligence' },
    'obama-becoming': { author: 'Michelle Obama', book: 'Becoming', category: 'Emotional Intelligence' },
    'obama-light-we-carry': { author: 'Michelle Obama', book: 'The Light We Carry', category: 'Emotional Intelligence' },
  };

  return details[slug] || { author: 'Unknown', book: 'Unknown', category: 'General' };
}

/**
 * Format persona content for injection into system prompt.
 * Returns a formatted string ready to be prepended to the task message.
 */
export function formatPersonaForPrompt(persona: PersonaContent | AutoSelectedPersona): string {
  const content = 'content' in persona ? persona.content : '';
  const score = 'score' in persona ? persona.score : undefined;
  const slug = 'slug' in persona ? persona.slug : persona.persona;
  const details = getPersonaDetails(slug);
  
  let formatted = `## 🎭 ACTIVE PERSONA: ${details.author} — "${details.book}"\n\n`;
  formatted += `**Category:** ${details.category}\n`;
  
  if (score !== undefined) {
    formatted += `**Match Score:** ${(score * 100).toFixed(1)}%\n`;
  }
  
  formatted += `**Source:** ${'source' in persona ? persona.source : 'auto-selected'}\n\n`;
  formatted += `---\n\n`;
  formatted += `### Persona Instructions\n\n`;
  formatted += `You are embodying the methodology and expertise from "${details.book}" by ${details.author}. `;
  formatted += `Approach this task using the frameworks, principles, and mental models from this book. `;
  formatted += `Let this author's philosophy guide your thinking and output.\n\n`;
  
  // Include the full blueprint content (truncated if too long)
  const maxContentLength = 8000; // Limit to prevent token overflow
  const truncatedContent = content.length > maxContentLength 
    ? content.substring(0, maxContentLength) + '\n\n[Content truncated due to length...]'
    : content;
  
  formatted += `### Full Persona Blueprint\n\n${truncatedContent}\n\n`;
  formatted += `---\n\n`;
  
  return formatted;
}

/**
 * Main entry point: resolve persona content for a task.
 * 
 * @param personaSetting - The persona setting from intelligence resolver ('auto' or a slug)
 * @param taskDescription - The task description for auto-selection context
 * @returns Formatted persona prompt section, or null if no persona should be injected
 */
export function resolvePersonaContent(
  personaSetting: string,
  taskDescription: string
): string | null {
  // If persona is explicitly set to a specific slug, use it
  if (personaSetting && personaSetting !== 'auto') {
    const persona = getPersonaBySlug(personaSetting);
    if (persona) {
      console.log(`[PersonaResolver] Using explicit persona: ${personaSetting}`);
      return formatPersonaForPrompt(persona);
    }
    console.warn(`[PersonaResolver] Explicit persona not found: ${personaSetting}`);
    return null;
  }
  
  // Auto-selection mode
  if (personaSetting === 'auto') {
    console.log('[PersonaResolver] Running auto-selection for task...');
    const autoPersonas = autoSelectPersonas(taskDescription, 1);
    
    if (autoPersonas.length > 0 && autoPersonas[0].score > 0.5) {
      console.log(`[PersonaResolver] Auto-selected: ${autoPersonas[0].persona} (score: ${autoPersonas[0].score})`);
      return formatPersonaForPrompt(autoPersonas[0]);
    }
    
    console.log('[PersonaResolver] No strong persona match found, proceeding without persona injection');
    return null;
  }
  
  return null;
}

/**
 * Multi-persona mode: Get top N personas for complex tasks.
 * Useful when a task might benefit from multiple perspectives.
 */
export function resolveMultiPersonaContent(
  taskDescription: string,
  count: number = 3
): string | null {
  const personas = autoSelectPersonas(taskDescription, count);
  
  if (personas.length === 0) {
    return null;
  }
  
  let formatted = `## 🎭 ACTIVE PERSONAS: Multi-Perspective Mode\n\n`;
  formatted += `This task will be approached from ${personas.length} complementary perspectives:\n\n`;
  
  for (let i = 0; i < personas.length; i++) {
    const p = personas[i];
    const details = getPersonaDetails(p.persona);
    formatted += `${i + 1}. **${details.author}** — "${details.book}" (${(p.score * 100).toFixed(1)}% match)\n`;
  }
  
  formatted += `\n---\n\n`;
  
  // Include full content of top persona only to save tokens
  const topPersona = personas[0];
  const details = getPersonaDetails(topPersona.persona);
  formatted += `### Primary Persona: ${details.author}\n\n`;
  
  const maxContentLength = 6000;
  const truncatedContent = topPersona.content.length > maxContentLength 
    ? topPersona.content.substring(0, maxContentLength) + '\n\n[Content truncated...]'
    : topPersona.content;
  
  formatted += truncatedContent;
  formatted += `\n\n---\n\n`;
  
  return formatted;
}
