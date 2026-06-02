/**
 * Department Configuration
 *
 * This file defines the default department definitions for the Command Center.
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
 * Default departments — Command Center standard department structure.
 * CEO/COM is the master/fallback department with highest priority.
 * Exported so callers can use it as a typed constant without loading from disk.
 */
export const DEFAULT_DEPARTMENTS: DepartmentConfig[] = [
  {
    id: 'ceo-com',
    name: 'CEO / COM',
    keywords: [
      'ceo', 'com', 'central operations', 'chief', 'executive', 'strategy', 'vision',
      'leadership', 'oversight', 'master', 'fallback', 'dispatch', 'coordinate',
      'direct', 'command', 'general', 'overview', 'mission control', 'admin',
    ],
    agentRoles: [
      'CEO', 'COM', 'Central Operations Manager', 'Chief of Mission', 'Master Agent',
      'Executive Assistant', 'Strategist',
    ],
    priority: 10,
  },
  {
    id: 'marketing',
    name: 'Marketing',
    keywords: [
      'marketing', 'campaign', 'brand', 'social media', 'content', 'ads', 'advertising',
      'email', 'newsletter', 'seo', 'funnel', 'leads', 'outreach', 'promotion',
      'advertisement', 'branding', 'market', 'viral', 'engagement', 'clicks',
    ],
    agentRoles: [
      'Social Media', 'Content', 'Marketing', 'Content Writer', 'Social Media Agent',
      'Marketing Specialist', 'Campaign Manager', 'SEO Specialist',
    ],
    priority: 7,
  },
  {
    id: 'sales',
    name: 'Sales',
    keywords: [
      'sales', 'crm', 'lead', 'prospect', 'pipeline', 'deal', 'close', 'convert',
      'revenue', 'quota', 'follow up', 'client', 'proposal', 'pitch', 'closing',
      'opportunity', 'negotiation', 'contract', 'purchase', 'buyer',
    ],
    agentRoles: [
      'Sales', 'CRM', 'Convert and Flow', 'Sales Agent', 'Sales Rep',
      'Account Executive', 'Business Development', 'Closer',
    ],
    priority: 8,
  },
  {
    id: 'billing',
    name: 'Billing',
    keywords: [
      'billing', 'invoice', 'payment', 'charge', 'subscription', 'pricing', 'bill',
      'transaction', 'refund', 'credit', 'debit', 'fee', 'cost', 'revenue recognition',
      'accounts receivable', 'ar', 'payment processing', 'stripe', 'paypal',
    ],
    agentRoles: [
      'Billing', 'Billing Agent', 'Accounts Receivable', 'Payment Processor',
      'Invoice Manager', 'Subscription Manager',
    ],
    priority: 8,
  },
  {
    id: 'customer-support',
    name: 'Customer Support',
    keywords: [
      'support', 'customer', 'help', 'ticket', 'issue', 'complaint', 'refund',
      'onboarding', 'question', 'inquiry', 'service', 'client care', 'assistance',
      'troubleshoot', 'problem', 'bug report', 'user issue', 'help desk',
    ],
    agentRoles: [
      'Support', 'Support Agent', 'Customer Service', 'Customer Care',
      'Help Desk', 'Technical Support', 'Success Manager',
    ],
    priority: 7,
  },
  {
    id: 'crm',
    name: 'CRM',
    keywords: [
      'crm', 'contact', 'contacts', 'list', 'lists', 'segment', 'segmentation',
      'enrichment', 'enrich', 'sequence', 'sequences', 'cadence', 'nurture',
      'ghl', 'gohighlevel', 'tags', 'tagging', 'pipeline stage', 'workflow trigger',
      'lead capture', 'opt-in', 'list hygiene', 'unsubscribe', 'deliverability',
    ],
    agentRoles: [
      'CRM Agent', 'GHL Specialist', 'Convert and Flow', 'List Manager',
      'Sequence Builder', 'Contact Enricher', 'Pipeline Operator',
    ],
    priority: 8,
  },
  {
    id: 'openclaw-maintenance',
    name: 'OpenClaw Maintenance',
    keywords: [
      'openclaw', 'maintenance', 'skill update', 'sunday update', 'cron',
      'system integrity', 'qc', 'quality control', 'agent health', 'heartbeat',
      'version bump', 'install', 'reinstall', 'patch', 'hotfix', 'rollback',
      'mission control', 'memory wiki', 'self improvement', 'orchestrator',
      'agent dispatch', 'dispatcher', 'self heal',
    ],
    agentRoles: [
      'OpenClaw Maintenance', 'Self-Improvement Agent', 'System Integrity Agent',
      'Sunday Update Runner', 'QC Agent', 'Skill Updater', 'Agent Mechanic',
    ],
    priority: 9,
  },
  {
    id: 'legal-compliance',
    name: 'Legal / Compliance',
    keywords: [
      'legal', 'law', 'compliance', 'contract', 'agreement', 'terms', 'policy',
      'privacy', 'gdpr', 'regulation', 'license', 'intellectual property', 'ip',
      'copyright', 'trademark', 'nda', 'liability', 'risk', 'disclaimer', 'terms of service',
    ],
    agentRoles: [
      'Legal', 'Compliance', 'Legal Counsel', 'Contract Manager', 'Policy Officer',
      'Risk Manager', 'IP Specialist', 'Compliance Agent',
    ],
    priority: 8,
  },
  {
    id: 'social-media',
    name: 'Social Media',
    keywords: [
      'social media', 'organic', 'instagram', 'ig', 'tiktok', 'twitter', 'x post',
      'linkedin', 'facebook', 'youtube short', 'reel', 'reels', 'short',
      'follower', 'followers', 'engagement', 'comment', 'dm', 'direct message',
      'post', 'posting', 'caption', 'hashtag', 'story', 'thread', 'content calendar',
      'creator', 'algorithm', 'viral',
    ],
    agentRoles: [
      'Social Media Agent', 'Social Media Planner', 'Community Manager',
      'Engagement Agent', 'Content Scheduler', 'Caption Creator',
    ],
    priority: 7,
  },
  {
    id: 'paid-advertisement',
    name: 'Paid Advertisement',
    keywords: [
      'paid ads', 'paid advertising', 'meta ads', 'facebook ads', 'instagram ads',
      'google ads', 'youtube ads', 'tiktok ads', 'roas', 'cpa', 'cac', 'cpc', 'cpm',
      'ad spend', 'ad budget', 'ad creative', 'ad copy', 'targeting', 'audience',
      'lookalike', 'retargeting', 'conversion tracking', 'pixel', 'utm', 'campaign budget',
    ],
    agentRoles: [
      'Paid Ads Agent', 'Media Buyer', 'Ad Specialist', 'Performance Marketer',
      'Ad Creative Producer', 'Conversion Tracking Specialist',
    ],
    priority: 7,
  },
  {
    id: 'web-development',
    name: 'Web Development',
    keywords: [
      'web', 'website', 'frontend', 'backend', 'fullstack', 'react', 'vue', 'angular',
      'html', 'css', 'javascript', 'typescript', 'node', 'nextjs', 'wordpress',
      'web app', 'landing page', 'site', 'web design', 'responsive', 'webflow',
    ],
    agentRoles: [
      'Web Developer', 'Frontend Developer', 'Backend Developer', 'Fullstack Developer',
      'Web Engineer', 'JavaScript Developer', 'React Developer',
    ],
    priority: 7,
  },
  {
    id: 'app-development',
    name: 'App Development',
    keywords: [
      'app', 'mobile', 'ios', 'android', 'react native', 'flutter', 'swift',
      'kotlin', 'mobile app', 'application', 'apk', 'app store', 'play store',
      'pwa', 'progressive web app', 'mobile development', 'native app',
    ],
    agentRoles: [
      'App Developer', 'Mobile Developer', 'iOS Developer', 'Android Developer',
      'React Native Developer', 'Flutter Developer', 'Mobile Engineer',
    ],
    priority: 7,
  },
  {
    id: 'graphics',
    name: 'Graphics',
    keywords: [
      'graphic', 'design', 'visual', 'logo', 'branding', 'image', 'illustration',
      'ui', 'ux', 'mockup', 'layout', 'color', 'typography', 'photoshop', 'figma',
      'sketch', 'adobe', 'vector', 'svg', 'png', 'infographic', 'banner',
    ],
    agentRoles: [
      'Designer', 'Graphics', 'Graphics Agent', 'Graphic Designer', 'UI Designer',
      'UX Designer', 'Visual Designer', 'Brand Designer', 'Illustrator',
    ],
    priority: 6,
  },
  {
    id: 'video-production',
    name: 'Video Production',
    keywords: [
      'video', 'film', 'movie', 'footage', 'edit', 'editing', 'premiere', 'final cut',
      'after effects', 'motion graphics', 'animation', 'render', 'cut', 'clip',
      'youtube', 'vimeo', 'video ad', 'commercial', 'reel', 'b-roll', 'color grade',
    ],
    agentRoles: [
      'Video Editor', 'Videographer', 'Motion Designer', 'Video Producer',
      'Animator', 'Colorist', 'Post Production', 'Video Agent',
    ],
    priority: 6,
  },
  {
    id: 'audio-production',
    name: 'Audio Production',
    keywords: [
      'audio', 'sound', 'music', 'podcast', 'voiceover', 'voice over', 'narration',
      'recording', 'mix', 'mastering', 'eq', 'compression', 'jingle', 'soundtrack',
      'audiobook', 'radio', 'spotify', 'apple music', 'sound design', 'foley',
    ],
    agentRoles: [
      'Audio Engineer', 'Sound Designer', 'Podcast Editor', 'Voiceover Artist',
      'Music Producer', 'Mixer', 'Mastering Engineer', 'Audio Agent',
    ],
    priority: 6,
  },
  {
    id: 'research',
    name: 'Research',
    keywords: [
      'research', 'analyze', 'analysis', 'data', 'report', 'survey', 'study',
      'investigate', 'market research', 'competitor', 'trend', 'insight', 'scrape',
      'benchmark', 'statistics', 'dataset', 'findings', 'white paper', 'case study',
    ],
    agentRoles: [
      'Researcher', 'Research Agent', 'Scraper', 'Scraper Agent', 'Analytics',
      'Data Analyst', 'Market Researcher', 'Research Specialist',
    ],
    priority: 6,
  },
  {
    id: 'communications',
    name: 'Communications',
    keywords: [
      'communications', 'pr', 'public relations', 'media', 'press', 'announcement',
      'newsletter', 'email blast', 'internal comms', 'external comms', 'messaging',
      'spokesperson', 'interview', 'presentation', 'speaking', 'event', 'webinar',
    ],
    agentRoles: [
      'Communications', 'PR Specialist', 'Public Relations', 'Communications Manager',
      'Media Relations', 'Spokesperson', 'Communications Agent',
    ],
    priority: 7,
  },
  {
    id: 'security',
    name: 'Security Team',
    keywords: [
      'security', 'incident', 'breach', 'access', 'credentials', 'credential', 'anomaly',
      'monitor', 'monitoring', 'hygiene', '2fa', 'mfa', 'threat', 'vulnerability',
      'patch', 'firewall', 'audit', 'compliance audit', 'intrusion', 'phishing',
      'malware', 'ransomware', 'zero-day', 'pen test', 'penetration test',
      'soc', 'siem', 'alert', 'revoke', 'rotate key', 'api key', 'secret', 'token rotation',
      'ip block', 'acl', 'permission scope', 'least privilege', 'access control',
    ],
    agentRoles: [
      'Security Monitor', 'Incident Responder', 'Credential Auditor',
      'Security Agent', 'Security Analyst', 'Threat Analyst',
      'Compliance Auditor', 'Access Control Specialist',
    ],
    priority: 9,
  },
];

/**
 * Load departments for the current workspace.
 *
 * Resolution order:
 *   1. DEPARTMENTS_CONFIG_PATH env var (external JSON file)
 *   2. Database workspaces table (filters DEFAULT_DEPARTMENTS to only existing workspaces)
 *   3. DEFAULT_DEPARTMENTS constant (built-in fallback if DB is empty)
 *
 * Errors in the external file log a warning and fall back to defaults.
 */
export function loadDepartments(): DepartmentConfig[] {
  let allDepartments: DepartmentConfig[] = DEFAULT_DEPARTMENTS;
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
      allDepartments = parsed;
    } catch (err) {
      console.warn(
        `[DepartmentConfig] Failed to load from DEPARTMENTS_CONFIG_PATH="${configPath}": ${(err as Error).message}. Falling back to defaults.`,
      );
    }
  }

  // Filter to only departments that exist as workspaces in the database
  try {
    // Dynamic import to avoid circular dependency at module load time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require('../db');
    const db = getDb();
    const workspaces = db.prepare('SELECT slug FROM workspaces').all() as { slug: string }[];
    const workspaceSlugs = new Set(workspaces.map((w) => w.slug));

    if (workspaceSlugs.size > 0) {
      const filtered = allDepartments.filter((dept) => workspaceSlugs.has(dept.id));
      if (filtered.length > 0) {
        console.log(`[DepartmentConfig] Filtered to ${filtered.length} departments matching workspaces in DB`);
        return filtered;
      }
    }
  } catch (err) {
    console.warn(`[DepartmentConfig] Could not query workspaces from DB: ${(err as Error).message}. Using all defaults.`);
  }

  return allDepartments;
}
