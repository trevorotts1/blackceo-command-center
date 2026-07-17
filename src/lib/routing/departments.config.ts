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
import type Database from 'better-sqlite3';
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
  // U118 (2026-07-16, operator ruling — "THEN USE THE STANDALONE WORKSPACE
  // IF IT ALREADY EXISTS"): registers the department Skill 6's
  // 06-ghl-install-pages/tools/cc_board.py has ALWAYS unconditionally stamped
  // department_slug='funnels' for (job_type defaults to 'funnel'), which was
  // NEVER a registered department here — every funnel card on a standard-floor
  // box silently misrouted to general-task via INGEST-06's unrecognized-slug
  // tier (src/app/api/tasks/ingest/route.ts's resolveWorkspaceId). Deliberately
  // NOT added to VERTICAL_PACK_DEPARTMENTS below — the stamp is unconditional
  // for every funnel job regardless of a client's declared vertical, so this
  // must be universal/mandatory (falls through checkAddDepartmentSync's
  // unconditional-allow path), exactly like general-task. Mirrors the ONB
  // repo's department-naming-map.json mandatory.funnels entry (23 mandatory
  // depts there now). Overlaps 'marketing' (id 'marketing', keyword 'funnel'
  // above) and 'web-development' by DESIGN — both already carry their own
  // funnel-adjacent roles (Marketing's Funnel Strategist / Signature Funnel
  // Specialist; Web Development's Funnel Builder Specialist / its own
  // Signature Funnel Specialist + Sales Page Assets Specialist doors) and
  // neither is touched here. See funnels-suggested-roles.md (ONB repo) for the
  // full, deliberate overlap documentation. This is department #26 —
  // DEFAULT_DEPARTMENTS' "exactly 25" QC gate is updated to 26 alongside this.
  {
    id: 'funnels',
    name: 'Funnels',
    purpose:
      'Owns the automated GHL sales-funnel build queue Skill 6 creates: the cut/import/verify/provision execution chain, build QA, and conversion-tracking verification for job_type=\'funnel\' cards. Distinct from Marketing\'s funnel strategy/copy and Web Development\'s broader funnel-building tooling.',
    keywords: [
      'funnel',
      'funnels',
      'sales funnel',
      'opt-in page',
      'optin',
      'checkout flow',
      'order bump',
      'upsell',
      'downsell',
      'tripwire',
      'signature funnel',
      'sales page assets',
      'ghl funnel',
      'funnel build',
    ],
    agentRoles: [
      'Director of Funnels',
      'GHL Funnel Build Specialist',
      'Funnel QA & Conversion Verification Specialist',
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
      // NOTE: bare 'pitch' removed (presentation-reflex misfire) — it is a Sales
      // keyword too (a "sales pitch" / marketing pitch), and keywordScore does a
      // substring match, so bare 'pitch' let a Marketing/Sales ask misroute to
      // Presentations. The specific 'pitch deck' + 'investor deck' below keep a
      // genuine investor-deck ask routing here.
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
  // ── General Task — mandatory catch-all ────────────────────────────────────
  // ROUTING RULE: General Task NEVER wins on merit. priority=1 + empty keywords
  // means rankDepartments() scores it 0 (filtered out by `score > 0` guard) and
  // semanticRankDepartments() will naturally rank it last for most real task text
  // because its purpose is intentionally vague. It is reached ONLY via the
  // explicit MIN_ROUTING_CONFIDENCE floor in comDispatch() (Step 3.5).
  //
  // Design intent: a catch-all that prevents tasks being force-fit into the
  // wrong dept when routing confidence is low. The recurrence detector
  // (general-task-recurrence.ts) watches patterns in tasks that land here and
  // recommends standing up a dedicated dept when >3/month recur.
  //
  // D-C2 / D8 — RATIFIED 2026-07-16 by the operator as REJECT (see
  // ledgers/ratified-decisions-2026-07-16.md in trevorotts1/openclaw-onboarding).
  // The proposed rename of the catch-all's client-facing display name to
  // "General Stuff" is REJECTED — it stays "General Task". Reasoning: every
  // other department on a client's board carries a real name (Marketing,
  // Sales, Billing & Finance); "Stuff" reads as a junk drawer, an admission
  // nobody knew what to call it, while "General Task" at least sounds like
  // work — clients are paying for an AI workforce and the board should read
  // like one. The slug (below, general-task) was never in question either
  // way — it is FROZEN — routing (this file), the ingest fallbacks
  // (ingest/route.ts INGEST-06 + tier-4), migration 059's sort-order pin, and
  // the recurrence detector above all key on it, never the display name.
  // Migration 109 defensively normalizes any already-provisioned box whose
  // `workspaces.name` row drifted from the canonical "General Task" (e.g. a
  // stray "General Stuff" from local testing of the now-rejected proposal)
  // back to it — idempotent, slug-keyed UPDATE.
  {
    id: 'general-task',
    name: 'General Task',
    purpose:
      'Catch-all department for tasks that do not confidently match any dedicated department. Triages, executes one-off work, or re-routes once classified. Monitors recurring patterns and recommends new dedicated departments.',
    keywords: [], // intentionally empty — never wins keyword routing
    agentRoles: [
      'Head of General Task',
      'Generalist Operator',
      'Triage Classifier',
      'General Task Specialist',
    ],
    priority: 1, // intentionally lowest — only reached via confidence-floor fallback
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
// U107 (E5-2, closes G2a) — vertical never force-added to a client who is not
// that vertical.
//
// DEFAULT_DEPARTMENTS above is a SEED / KEYWORD-HINT source (see the file
// header) with 25 entries — that count is a QC gate
// (tests/unit/intelligent-routing.test.ts "DEFAULT_DEPARTMENTS has exactly 25
// canonical departments") and stays untouched here. THREE of those 25 are
// vertical-pack departments, not universal ones: a client who never declared
// the owning vertical in their interview should never see them provisioned.
//
//   client-coaches       -> pack 'personal-pro-dev'
//   course-creator       -> pack 'personal-pro-dev'
//   community-management -> pack 'content-creator'
//
// Mirrors the LANDED ONB guard's dept_pack_index() over
// 23-ai-workforce-blueprint/department-naming-map.json (v2.6.1): every dept
// inside a vertical_packs[*].auto_add_departments list maps to that pack,
// with LAST-PACK-WINS when a dept id appears in more than one pack (Python
// dict-iteration order). `presentations` and `podcast` are ALSO pack
// departments but carry universal_primary=true in their winning pack, so the
// guard (both here and in the Python) allows them unconditionally — they are
// NOT in this map. `podcast` in particular is order-fragile: it is
// non-universal in personal-pro-dev but universal_primary=true in
// content-creator, and content-creator is the LAST pack in naming-map key
// order today, so it resolves ALLOWED. If department-naming-map.json's key
// order ever changes, podcast could flip to REFUSED — this map would then be
// stale for a 4th id. The parity fixture
// (src/lib/routing/__fixtures__/vertical-derivation) is the drift detector:
// regenerate it (scripts/regen-vertical-derivation-golden.sh) whenever the
// naming map changes and a diff here is the signal to update this table.
export const VERTICAL_PACK_DEPARTMENTS: Readonly<Record<string, string>> = Object.freeze({
  'client-coaches': 'personal-pro-dev',
  'course-creator': 'personal-pro-dev',
  'community-management': 'content-creator',
});

/**
 * U107 config flag: the derivation guard is additive behind this flag per the
 * spec's revert clause ("revert = flip the flag"). Defaults ON. Set
 * VERTICAL_DERIVATION_GUARD_ENABLED=false to restore pre-U107 behavior
 * (DEFAULT_DEPARTMENTS returned unfiltered from the step-3 fallback).
 */
export function isVerticalDerivationGuardEnabled(): boolean {
  return process.env.VERTICAL_DERIVATION_GUARD_ENABLED !== 'false';
}

export interface CheckAddVerdict {
  allowed: boolean;
  error: string | null;
}

/**
 * U107 REFUSAL primitive (BINARY acceptance (c)) — pure, synchronous TS
 * mirror of vertical-derivation-guard.py's check_add(): a department that is
 * not a vertical-pack department at all (mandatory/universal/custom), or
 * whose owning pack IS in the declared set, is always allowed. A
 * vertical-specific department whose pack is NOT declared is refused with the
 * SAME named error text the Python guard emits (byte-identical modulo the
 * declared-set rendering), so a log/receipt grep for "VERTICAL_NOT_DECLARED"
 * matches on both sides of this unit.
 *
 * This does not shell out — see seam.ts's checkAddDepartment() for the
 * independently-executed live Python verdict (defense in depth / drift
 * detection). This sync version is what the hot step-3 fallback path below
 * actually uses, since loadDepartments() cannot go async without a much
 * larger refactor of every caller.
 */
export function checkAddDepartmentSync(
  deptId: string,
  declaredPacks: readonly string[],
): CheckAddVerdict {
  const pack = VERTICAL_PACK_DEPARTMENTS[deptId];
  if (!pack) return { allowed: true, error: null };
  const declared = new Set(declaredPacks);
  if (declared.has(pack)) return { allowed: true, error: null };
  const declaredList = Array.from(declared).sort();
  return {
    allowed: false,
    error:
      `VERTICAL_NOT_DECLARED: refusing to add department '${deptId}' — it belongs to ` +
      `vertical pack '${pack}', which the interview did not declare ` +
      `(declared packs: ${declaredList.length ? JSON.stringify(declaredList) : "['none']"}).`,
  };
}

/**
 * U107 BINARY acceptance (a)/(b): the default/floor set returned when the
 * workspaces table is empty (loadDepartments() step 3) STRICTLY derives its
 * vertical-specific departments from interview-declared signals — zero
 * declared verticals means zero vertical-specific departments in the floor;
 * a declared pack means that pack's departments ARE in the floor (no
 * false-negative). Mandatory + universal-primary departments (the other 22)
 * are never gated — checkAddDepartmentSync() allows them unconditionally.
 *
 * Behind isVerticalDerivationGuardEnabled(): when the flag is off, returns
 * DEFAULT_DEPARTMENTS unfiltered (pre-U107 behavior) — the spec's revert path.
 */
export function getDefaultFloorDepartments(
  declaredPacksOverride?: readonly string[],
): DepartmentConfig[] {
  if (!isVerticalDerivationGuardEnabled()) return DEFAULT_DEPARTMENTS;
  // Lazy require to avoid a hard module-load-time dependency from routing/ on
  // interview/ (mirrors the existing dynamic `require('../db')` pattern in
  // this file) and to keep this function importable in isolation by tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { declaredVerticalPacks } = require('../interview/seam') as typeof import('../interview/seam');
  const declared = declaredPacksOverride ?? declaredVerticalPacks();
  return DEFAULT_DEPARTMENTS.filter((d) => checkAddDepartmentSync(d.id, declared).allowed);
}

export interface VerticalDerivationVerdict {
  declaredVerticals: string[];
  provisionedVerticalDepartments: { id: string; pack: string }[];
  violations: { id: string; pack: string; reason: string }[];
  verdict: 'PASS' | 'FAIL';
  generatedAt: string;
}

/**
 * U107 audit/receipt: evaluate the default floor set that
 * getDefaultFloorDepartments() would return, asserting provisioned ⊆ declared
 * for every vertical-specific department — the CC-side mirror of
 * vertical-derivation-guard.py's evaluate_vertical_derivation(), scoped to
 * this repo's own floor-set surface (DEFAULT_DEPARTMENTS) rather than an
 * on-disk department directory (CC has no such directory; its "provisioned
 * set" IS this array as filtered by the guard).
 */
export function evaluateDefaultFloorVerticalDerivation(
  declaredPacksOverride?: readonly string[],
): VerticalDerivationVerdict {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { declaredVerticalPacks } = require('../interview/seam') as typeof import('../interview/seam');
  const declared = declaredPacksOverride ?? declaredVerticalPacks();
  const declaredSet = new Set(declared);
  const floor = getDefaultFloorDepartments(declared);

  const provisioned: { id: string; pack: string }[] = [];
  const violations: { id: string; pack: string; reason: string }[] = [];
  for (const dept of floor) {
    const pack = VERTICAL_PACK_DEPARTMENTS[dept.id];
    if (!pack) continue;
    provisioned.push({ id: dept.id, pack });
    if (!declaredSet.has(pack)) {
      violations.push({
        id: dept.id,
        pack,
        reason: `VERTICAL_NOT_DECLARED: department '${dept.id}' (pack '${pack}') is in the provisioned floor set but pack '${pack}' is not in the declared set (${Array.from(declaredSet).sort().join(', ') || 'none'}).`,
      });
    }
  }

  return {
    declaredVerticals: Array.from(declaredSet).sort(),
    provisionedVerticalDepartments: provisioned,
    violations,
    verdict: violations.length ? 'FAIL' : 'PASS',
    generatedAt: new Date().toISOString(),
  };
}

/**
 * U107 receipt writer: persists the verdict to
 * <workspace>/provisioning/cc-vertical-derivation.json — a CC-specific
 * filename, deliberately distinct from the ONB leg's own
 * provisioning/vertical-derivation.json (same workspace root, different
 * writer; two processes must never race the same file). Never throws — a
 * disk failure here must not break loadDepartments().
 */
export function writeVerticalDerivationReceipt(
  verdict: VerticalDerivationVerdict,
  outPath?: string,
): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveWorkspaceDir } = require('../interview/paths') as typeof import('../interview/paths');
    const dest =
      outPath ?? path.join(resolveWorkspaceDir(), 'provisioning', 'cc-vertical-derivation.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(
      dest,
      JSON.stringify(
        { ...verdict, schemaVersion: '1.0', source: 'departments.config.ts evaluateDefaultFloorVerticalDerivation (U107)' },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    return true;
  } catch {
    return false;
  }
}

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
  db: Database.Database,
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
  db: Database.Database,
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

  // ── Step 3: fallback to the vertical-derivation-guarded floor ──────────────
  // U107 (E5-2, closes G2a): this is the ONLY path that can hand a client all
  // 25 DEFAULT_DEPARTMENTS with zero interview context — the exact "vertical
  // force-added to a client who is not that vertical" shape. Return the
  // filtered floor (getDefaultFloorDepartments()), never the raw constant.
  const floor = getDefaultFloorDepartments();
  const verdict = evaluateDefaultFloorVerticalDerivation();
  writeVerticalDerivationReceipt(verdict); // best-effort; never throws
  if (floor.length !== DEFAULT_DEPARTMENTS.length) {
    console.log(
      `[DepartmentConfig] U107 guard excluded ${DEFAULT_DEPARTMENTS.length - floor.length} ` +
        `undeclared vertical-specific department(s) from the fallback floor ` +
        `(declared: ${verdict.declaredVerticals.length ? verdict.declaredVerticals.join(', ') : 'none'}).`,
    );
  }
  return floor;
}
