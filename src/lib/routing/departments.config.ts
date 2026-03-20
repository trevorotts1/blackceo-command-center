/**
 * Department Configuration
 *
 * This file defines the default department definitions for the BlackCEO Command Center.
 * Workspaces can override or extend these definitions by setting DEPARTMENTS_CONFIG_PATH
 * to a JSON file, or by populating the workspace_departments table.
 *
 * The routing system loads departments at startup via loadDepartments().
 * It tries (in order):
 *   1. DEPARTMENTS_CONFIG_PATH env var → external JSON file
 *   2. This file's DEFAULT_DEPARTMENTS constant (always-available fallback)
 *
 * To customize departments for a workspace, create a JSON file that follows
 * the DepartmentConfig schema and point DEPARTMENTS_CONFIG_PATH at it.
 *
 * Schema: DepartmentConfig[]
 */

import fs from 'fs';
import path from 'path';

export interface DepartmentConfig {
  /** Unique slug for this department (used in task.department field) */
  id: string;
  /** Display name */
  name: string;
  /** Keywords that suggest a task belongs to this department */
  keywords: string[];
  /** Agent roles that can handle this department's tasks */
  agentRoles: string[];
  /**
   * Priority weight (1-10). Higher = this department gets routed first
   * when keywords match equally across multiple departments.
   */
  priority: number;
}

/**
 * Default 8 departments — matches the original hardcoded list.
 * Exported so callers can use it as a typed constant without loading from disk.
 */
export const DEFAULT_DEPARTMENTS: DepartmentConfig[] = [
  {
    id: 'marketing',
    name: 'Marketing',
    keywords: [
      'marketing', 'campaign', 'brand', 'social media', 'content', 'ads', 'advertising',
      'email', 'newsletter', 'seo', 'funnel', 'leads', 'outreach', 'promotion',
    ],
    agentRoles: [
      'Social Media', 'Content', 'Marketing', 'Content Writer', 'Social Media Agent',
    ],
    priority: 7,
  },
  {
    id: 'sales',
    name: 'Sales',
    keywords: [
      'sales', 'crm', 'lead', 'prospect', 'pipeline', 'deal', 'close', 'convert',
      'revenue', 'quota', 'follow up', 'client', 'proposal', 'pitch',
    ],
    agentRoles: [
      'Sales', 'CRM', 'Convert and Flow', 'Sales Agent',
    ],
    priority: 8,
  },
  {
    id: 'operations',
    name: 'Operations',
    keywords: [
      'operations', 'process', 'workflow', 'automation', 'n8n', 'zapier', 'system',
      'efficiency', 'ops', 'standard', 'procedure', 'sop', 'infrastructure',
    ],
    agentRoles: [
      'Operations', 'Operations Admin', 'Automation', 'N8N', 'N8N Workflow Builder',
    ],
    priority: 7,
  },
  {
    id: 'technology',
    name: 'Technology',
    keywords: [
      'code', 'develop', 'engineer', 'software', 'app', 'website', 'build', 'fix',
      'bug', 'deploy', 'api', 'database', 'technical', 'programming', 'script',
      'integration', 'backend', 'frontend',
    ],
    agentRoles: [
      'Developer', 'App Builder', 'Website Developer', 'QA', 'QA Testing',
    ],
    priority: 8,
  },
  {
    id: 'content',
    name: 'Content',
    keywords: [
      'write', 'blog', 'article', 'post', 'copy', 'script', 'video', 'podcast',
      'audio', 'transcript', 'caption', 'content creation', 'book', 'course',
    ],
    agentRoles: [
      'Content Writer', 'Writer', 'Video', 'Podcast', 'Book Writer', 'Course Agent',
      'Anthology Writer',
    ],
    priority: 6,
  },
  {
    id: 'design',
    name: 'Design',
    keywords: [
      'design', 'graphic', 'visual', 'logo', 'branding', 'image', 'creative',
      'illustration', 'ui', 'ux', 'mockup', 'layout', 'color', 'typography',
    ],
    agentRoles: [
      'Designer', 'Graphics', 'Graphics Agent',
    ],
    priority: 6,
  },
  {
    id: 'support',
    name: 'Support',
    keywords: [
      'support', 'customer', 'help', 'ticket', 'issue', 'complaint', 'refund',
      'onboarding', 'question', 'inquiry', 'service', 'client care',
    ],
    agentRoles: [
      'Support', 'Support Agent', 'Customer Service',
    ],
    priority: 7,
  },
  {
    id: 'research',
    name: 'Research',
    keywords: [
      'research', 'analyze', 'analysis', 'data', 'report', 'survey', 'study',
      'investigate', 'market research', 'competitor', 'trend', 'insight', 'scrape',
    ],
    agentRoles: [
      'Researcher', 'Research Agent', 'Scraper', 'Scraper Agent', 'Analytics',
    ],
    priority: 6,
  },
];

/**
 * Load departments for the current workspace.
 *
 * Resolution order:
 *   1. DEPARTMENTS_CONFIG_PATH env var (external JSON file)
 *   2. DEFAULT_DEPARTMENTS constant (built-in fallback)
 *
 * Errors in the external file log a warning and fall back to defaults.
 */
export function loadDepartments(): DepartmentConfig[] {
  const configPath = process.env.DEPARTMENTS_CONFIG_PATH;

  if (configPath) {
    try {
      const resolved = path.resolve(configPath);
      const raw = fs.readFileSync(resolved, 'utf-8');
      const parsed: DepartmentConfig[] = JSON.parse(raw);

      // Basic schema validation
      if (!Array.isArray(parsed)) {
        throw new Error('Departments config must be a JSON array');
      }
      for (const dept of parsed) {
        if (!dept.id || !dept.name || !Array.isArray(dept.keywords)) {
          throw new Error(`Invalid department entry: ${JSON.stringify(dept)}`);
        }
      }

      console.log(`[DepartmentConfig] Loaded ${parsed.length} departments from ${resolved}`);
      return parsed;
    } catch (err) {
      console.warn(
        `[DepartmentConfig] Failed to load from DEPARTMENTS_CONFIG_PATH="${configPath}": ${(err as Error).message}. Falling back to defaults.`,
      );
    }
  }

  return DEFAULT_DEPARTMENTS;
}
