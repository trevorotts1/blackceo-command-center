/**
 * Department Configuration
 *
 * This file defines the default department definitions for the Command Center.
 * DEFAULT_DEPARTMENTS is a SEED / KEYWORD-HINT source only. The canonical
 * routing universe is ALWAYS the client's own workspaces table — every
 * department the client actually has (regardless of name) is routable.
 *
 * The routing system loads departments at runtime via loadDepartments():
 *   1. DEPARTMENTS_CONFIG_PATH env var → external JSON file (operator override)
 *   2. Client's workspaces table (EVERY row → routable dept, custom names included)
 *      - purpose string = workspace.description ?? SOP keywords ?? seed hint ?? name
 *      - DEFAULT_DEPARTMENTS enriches keyword hints for standard dept names
 *   3. DEFAULT_DEPARTMENTS constant (built-in fallback when DB is empty/unavailable)
 *
 * Schema: DepartmentConfig[]
 */

import fs from 'fs';
import path from 'path';
import { canonicalDeptSlug } from './canonical-slug';

export interface DepartmentConfig {
  /** Unique slug for this department (used in task.department field) */
  id: string;
  /** Display name */
  name: string;
  /**
   * Short purpose string describing what this department does.
   * Used as the primary semantic classification signal.
   * Sources (in order): workspace.description → SOP keywords → seed hint → name.
   */
  purpose: string;
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
 *
 * These are SEED definitions: the `purpose` field and `keywords` act as
 * hint-enrichers for standard department names when building the routing
 * universe from the client's workspaces table. They do NOT limit which
 * departments are routable — any workspace row is routable regardless of
 * whether its name appears here.
 *
 * Exported so callers can use it as a typed constant without loading from disk.
 */
export const DEFAULT_DEPARTMENTS: DepartmentConfig[] = [
  {
    id: 'master-orchestrator',
    name: 'CEO / COM',
    purpose:
      'Strategic oversight, cross-department coordination, task dispatch, executive decision-making, and company mission control. Routes tasks; never executes them directly.',
    keywords: [
      'ceo',
      'com',
      'central operations',
      'chief',
      'executive',
      'strategy',
      'vision',
      'leadership',
      'oversight',
      'master',
      'fallback',
      'dispatch',
      'coordinate',
      'direct',
      'command',
      'general',
      'overview',
      'mission control',
      'admin',
    ],
    agentRoles: [
      'CEO',
      'COM',
      'Central Operations Manager',
      'Chief of Mission',
      'Master Agent',
      'Executive Assistant',
      'Strategist',
    ],
    priority: 10,
  },
  {
    id: 'marketing',
    name: 'Marketing',
    purpose:
      'Marketing campaigns, brand awareness, content creation, SEO, email marketing, funnels, lead generation, and promotional outreach.',
    keywords: [
      'marketing',
      'campaign',
      'brand',
      'social media',
      'content',
      'ads',
      'advertising',
      'email',
      'newsletter',
      'seo',
      'funnel',
      'leads',
      'outreach',
      'promotion',
      'advertisement',
      'branding',
      'market',
      'viral',
      'engagement',
      'clicks',
    ],
    agentRoles: [
      'Social Media',
      'Content',
      'Marketing',
      'Content Writer',
      'Social Media Agent',
      'Marketing Specialist',
      'Campaign Manager',
      'SEO Specialist',
    ],
    priority: 7,
  },
  {
    id: 'sales',
    name: 'Sales',
    purpose:
      'Sales pipeline management, lead qualification, deal closing, client proposals, revenue generation, and follow-up sequences.',
    keywords: [
      'sales',
      'crm',
      'lead',
      'prospect',
      'pipeline',
      'deal',
      'close',
      'convert',
      'revenue',
      'quota',
      'follow up',
      'client',
      'proposal',
      'pitch',
      'closing',
      'opportunity',
      'negotiation',
      'contract',
      'purchase',
      'buyer',
    ],
    agentRoles: [
      'Sales',
      'CRM',
      'Convert and Flow',
      'Sales Agent',
      'Sales Rep',
      'Account Executive',
      'Business Development',
      'Closer',
    ],
    priority: 8,
  },
  {
    id: 'billing-finance',
    name: 'Billing / Finance',
    purpose:
      'Invoicing, payment processing, subscriptions, financial transactions, refunds, billing disputes, and accounts receivable.',
    keywords: [
      'billing',
      'invoice',
      'payment',
      'charge',
      'subscription',
      'pricing',
      'bill',
      'transaction',
      'refund',
      'credit',
      'debit',
      'fee',
      'cost',
      'revenue recognition',
      'accounts receivable',
      'ar',
      'payment processing',
      'stripe',
      'paypal',
    ],
    agentRoles: [
      'Billing',
      'Billing Agent',
      'Accounts Receivable',
      'Payment Processor',
      'Invoice Manager',
      'Subscription Manager',
    ],
    priority: 8,
  },
  {
    id: 'customer-support',
    name: 'Customer Support',
    purpose:
      'Customer help desk, support tickets, issue resolution, client onboarding, complaint handling, and user troubleshooting.',
    keywords: [
      'support',
      'customer',
      'help',
      'ticket',
      'issue',
      'complaint',
      'refund',
      'onboarding',
      'question',
      'inquiry',
      'service',
      'client care',
      'assistance',
      'troubleshoot',
      'problem',
      'bug report',
      'user issue',
      'help desk',
    ],
    agentRoles: [
      'Support',
      'Support Agent',
      'Customer Service',
      'Customer Care',
      'Help Desk',
      'Technical Support',
      'Success Manager',
    ],
    priority: 7,
  },
  {
    id: 'crm',
    name: 'CRM',
    purpose:
      'Contact management, list segmentation, lead nurturing sequences, GHL automations, pipeline stages, and email deliverability.',
    keywords: [
      'crm',
      'contact',
      'contacts',
      'list',
      'lists',
      'segment',
      'segmentation',
      'enrichment',
      'enrich',
      'sequence',
      'sequences',
      'cadence',
      'nurture',
      'ghl',
      'gohighlevel',
      'tags',
      'tagging',
      'pipeline stage',
      'workflow trigger',
      'lead capture',
      'opt-in',
      'list hygiene',
      'unsubscribe',
      'deliverability',
    ],
    agentRoles: [
      'CRM Agent',
      'GHL Specialist',
      'Convert and Flow',
      'List Manager',
      'Sequence Builder',
      'Contact Enricher',
      'Pipeline Operator',
    ],
    priority: 8,
  },
  {
    id: 'openclaw-maintenance',
    name: 'OpenClaw Maintenance',
    purpose:
      'AI system maintenance, agent updates, skill installations, system integrity checks, version bumps, cron jobs, and self-healing automation.',
    keywords: [
      'openclaw',
      'maintenance',
      'skill update',
      'sunday update',
      'cron',
      'system integrity',
      'qc',
      'quality control',
      'agent health',
      'heartbeat',
      'version bump',
      'install',
      'reinstall',
      'patch',
      'hotfix',
      'rollback',
      'mission control',
      'memory wiki',
      'self improvement',
      'orchestrator',
      'agent dispatch',
      'dispatcher',
      'self heal',
    ],
    agentRoles: [
      'OpenClaw Maintenance',
      'Self-Improvement Agent',
      'System Integrity Agent',
      'Sunday Update Runner',
      'QC Agent',
      'Skill Updater',
      'Agent Mechanic',
    ],
    priority: 9,
  },
  {
    id: 'legal',
    name: 'Legal / Compliance',
    purpose:
      'Legal documents, contracts, compliance, privacy policy, terms of service, intellectual property, NDAs, and regulatory risk management.',
    keywords: [
      'legal',
      'law',
      'compliance',
      'contract',
      'agreement',
      'terms',
      'policy',
      'privacy',
      'gdpr',
      'regulation',
      'license',
      'intellectual property',
      'ip',
      'copyright',
      'trademark',
      'nda',
      'liability',
      'risk',
      'disclaimer',
      'terms of service',
    ],
    agentRoles: [
      'Legal',
      'Compliance',
      'Legal Counsel',
      'Contract Manager',
      'Policy Officer',
      'Risk Manager',
      'IP Specialist',
      'Compliance Agent',
    ],
    priority: 8,
  },
  {
    id: 'social-media',
    name: 'Social Media',
    purpose:
      'Organic social media posting, Instagram, TikTok, LinkedIn, Facebook, YouTube Shorts, Reels, captions, hashtags, and content calendars.',
    keywords: [
      'social media',
      'organic',
      'instagram',
      'ig',
      'tiktok',
      'twitter',
      'x post',
      'linkedin',
      'facebook',
      'youtube short',
      'reel',
      'reels',
      'short',
      'follower',
      'followers',
      'engagement',
      'comment',
      'dm',
      'direct message',
      'post',
      'posting',
      'caption',
      'hashtag',
      'story',
      'thread',
      'content calendar',
      'creator',
      'algorithm',
      'viral',
    ],
    agentRoles: [
      'Social Media Agent',
      'Social Media Planner',
      'Community Manager',
      'Engagement Agent',
      'Content Scheduler',
      'Caption Creator',
    ],
    priority: 7,
  },
  {
    id: 'paid-advertisement',
    name: 'Paid Advertisement',
    purpose:
      'Paid ad campaigns on Meta, Google, TikTok, YouTube; ROAS optimization, ad creatives, targeting, retargeting, and conversion tracking.',
    keywords: [
      'paid ads',
      'paid advertising',
      'meta ads',
      'facebook ads',
      'instagram ads',
      'google ads',
      'youtube ads',
      'tiktok ads',
      'roas',
      'cpa',
      'cac',
      'cpc',
      'cpm',
      'ad spend',
      'ad budget',
      'ad creative',
      'ad copy',
      'targeting',
      'audience',
      'lookalike',
      'retargeting',
      'conversion tracking',
      'pixel',
      'utm',
      'campaign budget',
    ],
    agentRoles: [
      'Paid Ads Agent',
      'Media Buyer',
      'Ad Specialist',
      'Performance Marketer',
      'Ad Creative Producer',
      'Conversion Tracking Specialist',
    ],
    priority: 7,
  },
  {
    id: 'web-development',
    name: 'Web Development',
    purpose:
      'Website development, web apps, landing pages, frontend/backend engineering, Next.js, WordPress, Webflow, and responsive web design.',
    keywords: [
      'web',
      'website',
      'frontend',
      'backend',
      'fullstack',
      'react',
      'vue',
      'angular',
      'html',
      'css',
      'javascript',
      'typescript',
      'node',
      'nextjs',
      'wordpress',
      'web app',
      'landing page',
      'site',
      'web design',
      'responsive',
      'webflow',
    ],
    agentRoles: [
      'Web Developer',
      'Frontend Developer',
      'Backend Developer',
      'Fullstack Developer',
      'Web Engineer',
      'JavaScript Developer',
      'React Developer',
    ],
    priority: 7,
  },
  {
    id: 'app-development',
    name: 'App Development',
    purpose:
      'Mobile app development for iOS and Android, React Native, Flutter, PWAs, and App Store/Play Store publishing.',
    keywords: [
      'app',
      'mobile',
      'ios',
      'android',
      'react native',
      'flutter',
      'swift',
      'kotlin',
      'mobile app',
      'application',
      'apk',
      'app store',
      'play store',
      'pwa',
      'progressive web app',
      'mobile development',
      'native app',
    ],
    agentRoles: [
      'App Developer',
      'Mobile Developer',
      'iOS Developer',
      'Android Developer',
      'React Native Developer',
      'Flutter Developer',
      'Mobile Engineer',
    ],
    priority: 7,
  },
  {
    id: 'graphics',
    name: 'Graphics',
    purpose:
      'Graphic design, logo creation, brand visuals, UI/UX design, illustrations, mockups, banners, and visual assets.',
    keywords: [
      'graphic',
      'design',
      'visual',
      'logo',
      'branding',
      'image',
      'illustration',
      'ui',
      'ux',
      'mockup',
      'layout',
      'color',
      'typography',
      'photoshop',
      'figma',
      'sketch',
      'adobe',
      'vector',
      'svg',
      'png',
      'infographic',
      'banner',
    ],
    agentRoles: [
      'Designer',
      'Graphics',
      'Graphics Agent',
      'Graphic Designer',
      'UI Designer',
      'UX Designer',
      'Visual Designer',
      'Brand Designer',
      'Illustrator',
    ],
    priority: 6,
  },
  {
    id: 'video',
    name: 'Video Production',
    purpose:
      'Video editing, production, filming, motion graphics, animation, color grading, YouTube content, and commercial video ads.',
    keywords: [
      'video',
      'film',
      'movie',
      'footage',
      'edit',
      'editing',
      'premiere',
      'final cut',
      'after effects',
      'motion graphics',
      'animation',
      'render',
      'cut',
      'clip',
      'youtube',
      'vimeo',
      'video ad',
      'commercial',
      'reel',
      'b-roll',
      'color grade',
    ],
    agentRoles: [
      'Video Editor',
      'Videographer',
      'Motion Designer',
      'Video Producer',
      'Animator',
      'Colorist',
      'Post Production',
      'Video Agent',
    ],
    priority: 6,
  },
  {
    id: 'audio',
    name: 'Audio Production',
    purpose:
      'Audio engineering, music production, podcast editing, voiceover recording, sound design, mixing, mastering, and jingles.',
    keywords: [
      'audio',
      'sound',
      'music',
      'podcast',
      'voiceover',
      'voice over',
      'narration',
      'recording',
      'mix',
      'mastering',
      'eq',
      'compression',
      'jingle',
      'soundtrack',
      'audiobook',
      'radio',
      'spotify',
      'apple music',
      'sound design',
      'foley',
    ],
    agentRoles: [
      'Audio Engineer',
      'Sound Designer',
      'Podcast Editor',
      'Voiceover Artist',
      'Music Producer',
      'Mixer',
      'Mastering Engineer',
      'Audio Agent',
    ],
    priority: 6,
  },
  {
    id: 'research',
    name: 'Research',
    purpose:
      'Market research, data analysis, competitor intelligence, surveys, reports, trend analysis, and white papers.',
    keywords: [
      'research',
      'analyze',
      'analysis',
      'data',
      'report',
      'survey',
      'study',
      'investigate',
      'market research',
      'competitor',
      'trend',
      'insight',
      'scrape',
      'benchmark',
      'statistics',
      'dataset',
      'findings',
      'white paper',
      'case study',
    ],
    agentRoles: [
      'Researcher',
      'Research Agent',
      'Scraper',
      'Scraper Agent',
      'Analytics',
      'Data Analyst',
      'Market Researcher',
      'Research Specialist',
    ],
    priority: 6,
  },
  {
    id: 'communications',
    name: 'Communications',
    purpose:
      'Public relations, press releases, media outreach, newsletters, internal/external communications, spokesperson messaging, and events.',
    keywords: [
      'communications',
      'pr',
      'public relations',
      'media',
      'press',
      'announcement',
      'newsletter',
      'email blast',
      'internal comms',
      'external comms',
      'messaging',
      'spokesperson',
      'interview',
      'presentation',
      'speaking',
      'event',
      'webinar',
    ],
    agentRoles: [
      'Communications',
      'PR Specialist',
      'Public Relations',
      'Communications Manager',
      'Media Relations',
      'Spokesperson',
      'Communications Agent',
    ],
    priority: 7,
  },
  // ── ZHC extended canonical departments ─────────────────────────────────────
  {
    id: 'presentations',
    name: 'Presentations',
    purpose:
      'Slide decks, pitch decks, PowerPoint/Keynote/Google Slides presentations, boardroom decks, and investor pitch materials.',
    keywords: [
      'presentation',
      'slide',
      'deck',
      'pitch deck',
      'powerpoint',
      'keynote',
      'google slides',
      'slide show',
      'pitch',
      'boardroom',
      'investor deck',
    ],
    agentRoles: ['Presentation Specialist', 'Deck Designer', 'Pitch Analyst'],
    priority: 5,
  },
  {
    id: 'client-coaches',
    name: 'Client Coaches',
    purpose:
      'Client coaching, success journeys, accountability check-ins, progress reviews, client retention, and onboarding support.',
    keywords: [
      'coaching',
      'coach',
      'client onboarding',
      'client success',
      'client journey',
      'accountability',
      'check-in',
      'progress review',
      'client retention',
    ],
    agentRoles: ['Client Coach', 'Success Coach', 'Onboarding Specialist'],
    priority: 6,
  },
  {
    id: 'course-creator',
    name: 'Course Creator',
    purpose:
      'Online course creation, curriculum design, lesson modules, LMS platforms (Kajabi, Teachable, Thinkific), and e-learning content.',
    keywords: [
      'course',
      'curriculum',
      'lesson',
      'module',
      'training',
      'lms',
      'kajabi',
      'teachable',
      'thinkific',
      'e-learning',
      'online course',
      'education',
    ],
    agentRoles: ['Course Creator', 'Curriculum Designer', 'Instructional Designer'],
    priority: 5,
  },
  {
    id: 'podcast',
    name: 'Podcast',
    purpose:
      'Podcast production, episode scripts, show notes, transcripts, RSS distribution, Spotify/Apple Podcasts, and audio content strategy.',
    keywords: [
      'podcast',
      'episode',
      'interview',
      'show notes',
      'transcript',
      'audio content',
      'rss',
      'spotify podcast',
      'apple podcast',
      'distribution',
      'episode script',
    ],
    agentRoles: ['Podcast Producer', 'Podcast Editor', 'Show Notes Writer'],
    priority: 5,
  },
  {
    id: 'community-management',
    name: 'Community Management',
    purpose:
      'Online community management, Discord/Slack communities, member engagement, moderation, community events, and group growth.',
    keywords: [
      'community',
      'discord',
      'slack community',
      'group',
      'tribe',
      'member',
      'engagement',
      'moderation',
      'onboarding member',
      'community event',
      'forum',
    ],
    agentRoles: ['Community Manager', 'Community Builder', 'Moderator'],
    priority: 6,
  },
  {
    id: 'personal-assistant',
    name: 'Personal Assistant',
    purpose:
      'Personal scheduling, calendar management, reminders, appointments, travel arrangements, inbox management, and administrative tasks.',
    keywords: [
      'personal',
      'schedule',
      'calendar',
      'reminder',
      'book appointment',
      'travel',
      'inbox management',
      'errands',
      'personal tasks',
      'assistant',
      'administrative',
    ],
    agentRoles: ['Personal Assistant', 'Executive Assistant', 'Administrative Agent'],
    priority: 5,
  },
  {
    id: 'security',
    name: 'Security Team',
    purpose:
      'Security monitoring, incident response, credential auditing, access control, threat detection, vulnerability management, and compliance audits.',
    keywords: [
      'security',
      'incident',
      'breach',
      'access',
      'credentials',
      'credential',
      'anomaly',
      'monitor',
      'monitoring',
      'hygiene',
      '2fa',
      'mfa',
      'threat',
      'vulnerability',
      'patch',
      'firewall',
      'audit',
      'compliance audit',
      'intrusion',
      'phishing',
      'malware',
      'ransomware',
      'zero-day',
      'pen test',
      'penetration test',
      'soc',
      'siem',
      'alert',
      'revoke',
      'rotate key',
      'api key',
      'secret',
      'token rotation',
      'ip block',
      'acl',
      'permission scope',
      'least privilege',
      'access control',
    ],
    agentRoles: [
      'Security Monitor',
      'Incident Responder',
      'Credential Auditor',
      'Security Agent',
      'Security Analyst',
      'Threat Analyst',
      'Compliance Auditor',
      'Access Control Specialist',
    ],
    priority: 9,
  },
];

// ---------------------------------------------------------------------------
// Internal helpers for loadDepartments
// ---------------------------------------------------------------------------

/**
 * Build a lookup map from canonical slug → DEFAULT_DEPARTMENTS entry so we
 * can enrich purpose/keywords/agentRoles when the client names a workspace
 * that maps to a standard dept.
 */
function buildDefaultMap(): Map<string, DepartmentConfig> {
  const m = new Map<string, DepartmentConfig>();
  for (const d of DEFAULT_DEPARTMENTS) {
    m.set(canonicalDeptSlug(d.id), d);
    m.set(d.name.toLowerCase().trim(), d);
  }
  return m;
}

/**
 * Derive a `purpose` string for a workspace row.
 *
 * Sources (in priority order):
 *  1. workspace.description (if non-empty)
 *  2. Aggregated SOP task_keywords for that workspace (joined from sops table)
 *  3. DEFAULT_DEPARTMENTS hint for a matching canonical slug
 *  4. Workspace name (bare fallback — always non-empty)
 */
function derivePurpose(
  ws: { id: string; slug: string; name: string; description: string | null },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  defaultMap: Map<string, DepartmentConfig>,
): string {
  if (ws.description && ws.description.trim().length > 0) {
    return ws.description.trim();
  }

  try {
    const sopRows = db
      .prepare(
        'SELECT task_keywords FROM sops WHERE workspace_id = ? AND task_keywords IS NOT NULL AND deleted_at IS NULL LIMIT 20',
      )
      .all(ws.id) as { task_keywords: string }[];

    if (sopRows.length > 0) {
      const kwSet = new Set<string>();
      for (const row of sopRows) {
        for (const kw of row.task_keywords.split(/[,\n]+/)) {
          const trimmed = kw.trim();
          if (trimmed.length > 0 && trimmed.length < 60) {
            kwSet.add(trimmed.toLowerCase());
          }
        }
      }
      if (kwSet.size > 0) {
        const kwStr = Array.from(kwSet).slice(0, 30).join(', ');
        return `${ws.name}: ${kwStr}`;
      }
    }
  } catch {
    // DB query failed — fall through
  }

  const canon = canonicalDeptSlug(ws.id) || canonicalDeptSlug(ws.slug);
  const seed = defaultMap.get(canon) ?? defaultMap.get(ws.name.toLowerCase().trim());
  if (seed?.purpose) {
    return seed.purpose;
  }

  return ws.name;
}

/**
 * Build a DepartmentConfig from a raw workspace row.
 * Merges keyword hints from DEFAULT_DEPARTMENTS when names align.
 */
function workspaceToDept(
  ws: { id: string; slug: string; name: string; description: string | null },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  defaultMap: Map<string, DepartmentConfig>,
): DepartmentConfig {
  const canon = canonicalDeptSlug(ws.id) || canonicalDeptSlug(ws.slug);
  const seed = defaultMap.get(canon) ?? defaultMap.get(ws.name.toLowerCase().trim());

  return {
    // Use the workspace's actual id/name — NOT the hardcoded canonical slug.
    // This is the key fix: the routing universe uses the CLIENT'S real names.
    id: ws.id,
    name: ws.name,
    purpose: derivePurpose(ws, db, defaultMap),
    keywords: seed?.keywords ?? [],
    agentRoles: seed?.agentRoles ?? [],
    priority: seed?.priority ?? 5,
  };
}

// ---------------------------------------------------------------------------
// loadDepartments — public API
// ---------------------------------------------------------------------------

/**
 * Load departments for the current workspace.
 *
 * Routing universe resolution order:
 *   1. DEPARTMENTS_CONFIG_PATH env var → external JSON file (operator override)
 *   2. Client's workspaces table — EVERY row becomes a routable department,
 *      regardless of name. Custom dept names ("Brand Storytelling Lab",
 *      "Revenue Ignition") are fully included. DEFAULT_DEPARTMENTS keywords/
 *      purpose/roles are merged in as hints when the name matches a standard
 *      dept. purpose = workspace.description ?? SOP keywords ?? seed hint ?? name.
 *   3. DEFAULT_DEPARTMENTS constant — fallback when DB is empty or unavailable.
 *
 * Errors at each step are logged and the next step is tried.
 */
export function loadDepartments(): DepartmentConfig[] {
  // ── Step 1: external JSON override ────────────────────────────────────────
  const configPath = process.env.DEPARTMENTS_CONFIG_PATH;
  if (configPath) {
    try {
      const resolved = path.resolve(configPath);
      const raw = fs.readFileSync(resolved, 'utf-8');
      const parsed: DepartmentConfig[] = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        throw new Error('Departments config must be a JSON array');
      }
      for (const dept of parsed) {
        if (!dept.id || !dept.name || !Array.isArray(dept.keywords)) {
          throw new Error(`Invalid department entry: ${JSON.stringify(dept)}`);
        }
        if (!dept.purpose) {
          dept.purpose = dept.name;
        }
      }

      console.log(`[DepartmentConfig] Loaded ${parsed.length} departments from ${resolved}`);
      return parsed;
    } catch (err) {
      console.warn(
        `[DepartmentConfig] Failed to load from DEPARTMENTS_CONFIG_PATH="${configPath}": ${(err as Error).message}. Falling back to DB.`,
      );
    }
  }

  // ── Step 2: build routing universe from the client's workspaces table ─────
  // EVERY workspace row is routable — custom department names are fully
  // supported. DEFAULT_DEPARTMENTS is used only for hint enrichment.
  try {
    // Dynamic import to avoid circular dependency at module load time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDb } = require('../db');
    const db = getDb();

    const workspaces = db
      .prepare('SELECT id, slug, name, description FROM workspaces ORDER BY name ASC')
      .all() as { id: string; slug: string; name: string; description: string | null }[];

    if (workspaces.length > 0) {
      const defaultMap = buildDefaultMap();
      const departments = workspaces.map((ws) => workspaceToDept(ws, db, defaultMap));

      console.log(
        `[DepartmentConfig] Loaded ${departments.length} departments from workspaces table (semantic routing active)`,
      );
      return departments;
    }

    console.log('[DepartmentConfig] Workspaces table is empty — falling back to DEFAULT_DEPARTMENTS');
  } catch (err) {
    console.warn(
      `[DepartmentConfig] Could not query workspaces from DB: ${(err as Error).message}. Using DEFAULT_DEPARTMENTS.`,
    );
  }

  // ── Step 3: fallback to DEFAULT_DEPARTMENTS ────────────────────────────────
  return DEFAULT_DEPARTMENTS;
}
