/**
 * Local installation capability capture (CTR-165, server-only).
 *
 * The Command Center only captures a snapshot directly when it runs on the
 * installation it is serving (the authenticated principal's tenant kind is
 * `self`). It uses the existing platform resolver, never a hardcoded
 * `~/.openclaw`, and reads only:
 *   - `<openclaw root>/skills/<folder>/SKILL.md` frontmatter `name` and
 *     `description` (first 12 KB of the file);
 *   - `<openclaw root>/agents/dept-*` folder names, and only when the
 *     folder is operational (it carries `models.json` or an `agent/`
 *     directory);
 *   - an explicitly configured `<claude skills root>` when
 *     `CC_CLAUDE_SKILLS_ROOT` is set. There is no implicit home-directory
 *     path.
 *
 * It never reads prompts, instructions, private memory, credentials,
 * databases, or configuration values, and it never executes a skill. For a
 * remote client the Command Center does not read that box at all; the
 * client runtime pushes a snapshot through the authenticated ingest route.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openclawConfigPath } from '../platform';
import {
  CAPABILITY_SNAPSHOT_LIMITS,
  CAPABILITY_SNAPSHOT_SCHEMA,
  type CapabilityAvailability,
  type CapabilitySource,
  type InstallationCapabilityEntry,
  type InstallationCapabilitySnapshot,
} from './capability-snapshot';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const TEMPLATE_NAME_RE =
  /^(?:_|\.)|(^|[-_.])(template|templates|example|examples|sample)([-_.]|$)/i;
const TRAILING_FUNCTION_WORDS =
  /\s+(?:and|or|but|nor|to|of|for|with|from|by|in|on|at|as|the|a|an|is|are|was|were|be|been)$/i;

function cleanText(value: string, max: number): string {
  const collapsed = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  const budget = Math.max(1, max - 1);
  const sliced = collapsed.slice(0, budget);
  const boundary = Math.max(
    sliced.lastIndexOf(' '),
    sliced.lastIndexOf(','),
    sliced.lastIndexOf(';'),
  );
  let cut = boundary >= Math.floor(budget * 0.6) ? sliced.slice(0, boundary) : sliced;
  cut = cut.replace(/[\s,;]+$/, '');
  let previous = '';
  while (previous !== cut) {
    previous = cut;
    cut = cut.replace(TRAILING_FUNCTION_WORDS, '');
  }
  cut = cut.replace(/[\s,;]+$/, '');
  const fallback = sliced.trimEnd();
  if (fallback === '') return '…';
  const marked = cut === '' ? fallback : cut;
  return marked.endsWith('…') ? marked : `${marked}…`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sortedEntries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** YAML frontmatter, top of file only; folded indented lines are joined. */
function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (key !== null && /^\s+\S/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`;
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) {
      key = null;
      continue;
    }
    key = pair[1];
    out[key] = pair[2].trim();
  }
  for (const [name, value] of Object.entries(out)) {
    out[name] = value.replace(/^(["'])(.*)\1$/, '$2').trim();
  }
  return out;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug === '' ? 'unnamed' : slug;
}

function skillSlug(folder: string): string {
  return slugify(folder.replace(/^\d+[-_]/, ''));
}

const ACRONYMS: ReadonlySet<string> = new Set([
  'ai', 'api', 'ceo', 'cfo', 'cmo', 'coo', 'crm', 'cto', 'ghl', 'hr',
  'kpi', 'llm', 'pr', 'qa', 'qc', 'seo', 'sop', 'ui', 'ux', 'vsl',
]);

function humanizeDepartment(folder: string): string {
  return folder
    .replace(/^dept-/, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    )
    .join(' ');
}

function readSkillEntry(
  skillsRoot: string,
  folder: string,
  source: CapabilitySource,
  availability: CapabilityAvailability,
): InstallationCapabilityEntry | null {
  if (TEMPLATE_NAME_RE.test(folder)) return null;
  const dir = join(skillsRoot, folder);
  if (!isDirectory(dir)) return null;
  const skillFile = join(dir, 'SKILL.md');
  if (!isFile(skillFile)) return null;
  let head = '';
  try {
    head = readFileSync(skillFile, 'utf8').slice(0, 12_000);
  } catch {
    return null;
  }
  const meta = frontmatter(head);
  const slug = skillSlug(folder) || folder.toLowerCase();
  const name = cleanText(
    meta.name && meta.name.trim().length > 0 ? meta.name : slug || folder,
    CAPABILITY_SNAPSHOT_LIMITS.max_name,
  );
  const rawDescription = meta.description ?? '';
  const description =
    rawDescription.trim() === ''
      ? null
      : cleanText(rawDescription, CAPABILITY_SNAPSHOT_LIMITS.max_description);
  return {
    capability_id: `skill:${slug}`,
    kind: 'skill',
    name: name || slug,
    description,
    availability,
    source,
    recorded_reference_ids: [],
  };
}

function readDepartmentEntry(
  agentsRoot: string,
  folder: string,
  availability: CapabilityAvailability,
): InstallationCapabilityEntry | null {
  if (!folder.startsWith('dept-')) return null;
  if (TEMPLATE_NAME_RE.test(folder.slice('dept-'.length))) return null;
  const dir = join(agentsRoot, folder);
  if (!isDirectory(dir)) return null;
  // Configured only: a department carries its model config or an agent
  // runtime directory. A bare template folder is not a configured department.
  const configured =
    isFile(join(dir, 'models.json')) || isDirectory(join(dir, 'agent'));
  if (!configured) return null;
  const slug = slugify(folder);
  return {
    capability_id: `department:${slug}`,
    kind: 'department',
    name: humanizeDepartment(slug),
    description: null,
    availability,
    source: 'openclaw.departments',
    recorded_reference_ids: [],
  };
}

export interface CaptureLocalCapabilitiesOptions {
  installation_id: string;
  /** `YYYY-MM-DD`; the sitting date or the export date. */
  captured_at: string;
  availability?: CapabilityAvailability;
  max_items?: number;
}

/**
 * Read THIS installation's inventory through the existing platform resolver.
 * Never throws: an unreadable folder is reported in `limitations`, never
 * turned into an invented entry.
 */
export function captureLocalCapabilities(
  options: CaptureLocalCapabilitiesOptions,
): InstallationCapabilitySnapshot {
  const availability = options.availability ?? 'available_now';
  const limit = Math.max(
    1,
    Math.min(
      options.max_items ?? CAPABILITY_SNAPSHOT_LIMITS.max_items,
      CAPABILITY_SNAPSHOT_LIMITS.max_items,
    ),
  );
  const items: InstallationCapabilityEntry[] = [];
  const limitations: string[] = [
    "Read from this installation's own skill and department folders through the Command Center platform resolver. Skill instructions, prompts, private memory, credentials, databases, and configuration values were not read.",
  ];

  const openclawRoot = dirname(openclawConfigPath());
  const skillsRoot = join(openclawRoot, 'skills');
  if (isDirectory(skillsRoot)) {
    for (const folder of sortedEntries(skillsRoot)) {
      const entry = readSkillEntry(
        skillsRoot,
        folder,
        'openclaw.skills',
        availability,
      );
      if (entry) items.push(entry);
    }
  } else {
    limitations.push(
      'No OpenClaw skills folder was found on this installation, so no skills are listed.',
    );
  }

  const agentsRoot = join(openclawRoot, 'agents');
  if (isDirectory(agentsRoot)) {
    for (const folder of sortedEntries(agentsRoot)) {
      const entry = readDepartmentEntry(agentsRoot, folder, availability);
      if (entry) items.push(entry);
    }
  } else {
    limitations.push(
      'No OpenClaw agents folder was found on this installation, so no departments are listed.',
    );
  }

  const claudeRoot = (process.env.CC_CLAUDE_SKILLS_ROOT ?? '').trim();
  if (claudeRoot && isDirectory(claudeRoot)) {
    for (const folder of sortedEntries(claudeRoot)) {
      const entry = readSkillEntry(
        claudeRoot,
        folder,
        'claude.skills',
        availability,
      );
      if (entry) items.push(entry);
    }
  }

  const byId = new Map<string, InstallationCapabilityEntry>();
  for (const entry of items) {
    if (!byId.has(entry.capability_id)) byId.set(entry.capability_id, entry);
  }
  const ordered = [...byId.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'department' ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.capability_id.localeCompare(b.capability_id);
  });
  const kept = ordered.slice(0, limit);
  if (ordered.length > kept.length) {
    limitations.push(
      `${ordered.length - kept.length} further installed item(s) were left out to keep the report readable.`,
    );
  }
  limitations.push(
    "Descriptions are the skill's own frontmatter description, shortened to 320 characters when longer. Departments are listed by their configured folder name because this installation records no separate department description.",
  );

  return {
    schema_version: CAPABILITY_SNAPSHOT_SCHEMA,
    installation_id: options.installation_id,
    captured_at: options.captured_at,
    basis: 'at_export',
    items: kept,
    limitations,
  };
}
