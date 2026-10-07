/**
 * Department profiles for the routing pickers (Trevor 2026-10-07, accuracy toward 95%).
 *
 * Why static and in-repo, not derived from the DB at runtime: most departments' live SOP titles are role
 * boilerplate ("Director of Bugs", "Roles Library Directory", "how-to.md (stub)"), so a profile mined from them
 * cannot say what a department does NOT handle, and "does not handle" is what separates the confused pairs
 * (Personal Assistant vs General Task, Research vs Marketing, Healer vs the department that owns the broken
 * thing). A reviewed, versioned file is deterministic, testable and diffable; the LIVE part of the profile is the
 * nearest SOP titles, which sop-vote.ts reads from the box's own sops table per task. A department the client
 * created (no entry here) falls back to its own `purpose`.
 *
 * Keys are canonical slugs (canonicalDeptSlug). `words` are extra distinguishing JEV vocabulary.
 */
import type { DepartmentConfig } from './departments.config';
import { canonicalDeptSlug } from './canonical-slug';

export interface DepartmentProfile {
  owns: string;
  typical: string[];
  not: string;
  words: string[];
}

export const DEPARTMENT_PROFILES: Record<string, DepartmentProfile> = {
  marketing: {
    owns: 'Brand, messaging, content and campaign strategy: what we say and to whom.',
    typical: ['marketing plans', 'newsletter and email copy', 'lead magnets', 'case studies', 'content calendars', 'brand messaging', 'promo planning'],
    not: 'Not research or data gathering (Research), not paid ads (Paid Advertisement), not posting to platforms (Social Media), not building pages (Web Development, Funnels).',
    words: ['newsletter', 'tagline', 'messaging', 'lead magnet', 'case study', 'content calendar'],
  },
  sales: {
    owns: 'Selling to leads and prospects: outreach, follow-up, proposals, pipeline and closing.',
    typical: ['cold outreach scripts', 'follow up with leads', 'proposals', 'prospect lists', 'objection handling', 'pipeline and deal updates', 'closing calls'],
    not: 'Not messages to existing clients who are not buying (Customer Support), not the CRM tooling itself (CRM), not funnel pages (Funnels).',
    words: ['prospects', 'proposal', 'close', 'objection', 'discovery calls', 'pricing inquiry'],
  },
  'billing-finance': {
    owns: 'Money in and out: invoices, payments, collections, refunds of charges, expenses, subscriptions, bookkeeping and financial reports.',
    typical: ['send an invoice', 'chase late payers', 'payment plans', 'categorize expenses', 'profit and loss', 'cancel a subscription', 'pay a bill'],
    not: 'Not a bug in a payment automation (Healer or Bugs), not hiring a bookkeeper (General Task).',
    words: ['invoice', 'payment', 'refund', 'expenses', 'subscription', 'accountant', 'bill'],
  },
  'customer-support': {
    owns: 'Helping existing customers and members: tickets, complaints, returns, FAQs, onboarding and check-ins with clients.',
    typical: ['answer support tickets', 'login problems', 'angry reviews', 'process a return', 'member FAQ', 'client onboarding checklist', 'check-in message to clients', 'thank-you cards to clients'],
    not: 'Not selling or closing (Sales), not researching what the market thinks (Research), not fixing a software bug (Bugs).',
    words: ['customer', 'ticket', 'member', 'client', 'return', 'complaint', 'check-in'],
  },
  'web-development': {
    owns: 'The company website: pages, content edits, speed, SEO, analytics installs, links and layout.',
    typical: ['edit a website page', 'footer or header', 'testimonials section', 'site speed', 'SEO', 'install analytics', 'team bios on the website', 'terms page build'],
    not: 'Not GoHighLevel funnels and order forms (Funnels), not a logged error to track (Bugs), not writing the copy strategy (Marketing).',
    words: ['website', 'homepage', 'footer', 'site', 'seo', 'wordpress', 'bios'],
  },
  funnels: {
    owns: 'Sales funnels built in GoHighLevel: opt-in pages, order forms, upsells and downsells, webinar and challenge funnels, funnel steps and their dates.',
    typical: ['build a GHL funnel', 'order form and upsell', 'downsell after checkout', 'opt-in page', 'clone a challenge funnel', 'change the webinar date', 'thank-you page and calendar'],
    not: 'Not the main website (Web Development), not email automations or contacts (CRM), not ad campaigns (Paid Advertisement).',
    words: ['funnel', 'upsell', 'downsell', 'opt-in', 'order form', 'checkout', 'webinar', 'ghl'],
  },
  'app-development': {
    owns: 'Mobile, desktop and web applications as software products: building, features, releases and app-store work.',
    typical: ['build a mobile app', 'desktop tool', 'PWA', 'push notifications', 'iOS or Android crash', 'scope an app'],
    not: 'Not the marketing website (Web Development), not a one-off bug report to log (Bugs), not a product requirements plan for a big program (Project Architecture Office).',
    words: ['app', 'ios', 'android', 'pwa', 'mobile', 'desktop tool'],
  },
  graphics: {
    owns: 'Visual design: logos, flyers, graphics, thumbnails, infographics, business cards and slide decks.',
    typical: ['design a logo', 'Instagram graphic', 'YouTube thumbnail', 'flyer', 'slides for a talk', 'business card', 'infographic'],
    not: 'Not video editing (Video), not audio (Audio), not writing the copy (Marketing).',
    words: ['logo', 'flyer', 'slides', 'thumbnail', 'infographic', 'brochure design', 'business card', 'deck'],
  },
  video: {
    owns: 'Video production: recording, editing, reels, captions, scripts for video, shot lists, AI avatar video and YouTube video work.',
    typical: ['edit a recording', 'cut reels', 'video script', 'YouTube titles and tags', 'AI avatar video', 'captions', 'shot list for a shoot'],
    not: 'Not podcast or audio-only work (Audio), not still graphics (Graphics), not CRM data (CRM): a shoot or shot list is Video.',
    words: ['video', 'shot list', 'shoot', 'footage', 'reels', 'youtube', 'avatar', 'recording'],
  },
  audio: {
    owns: 'Audio production: podcasts, voiceovers, jingles, noise cleanup, voice cloning, show notes.',
    typical: ['edit a podcast episode', 'voiceover', 'intro jingle', 'noise cleanup', 'AI voice clone', 'show notes'],
    not: 'Not video editing (Video), not a podcast logo (Graphics), not pitching to podcasts (Communications).',
    words: ['podcast', 'episode', 'voiceover', 'jingle', 'audio', 'voice clone', 'show notes'],
  },
  research: {
    owns: 'Finding out facts and analyzing them: competitors, markets, prices, customer opinions, options comparisons, survey and ad-results analysis.',
    typical: ['competitor research and pricing', 'what people complain about in reviews', 'market data such as average costs', 'should we expand', 'compare tools', 'survey customers', 'analyze results'],
    not: 'Research gathers and analyzes; it does not write the marketing piece (Marketing), answer a customer (Customer Support) or plan a rollout (Project Architecture Office). "Find out", "look into", "compare", "pull together data" are Research.',
    words: ['research', 'competitors', 'compare', 'find out', 'analyze', 'survey', 'data on', 'look into'],
  },
  communications: {
    owns: 'Public and internal announcements, press, speeches, interviews, investor and team updates, statements.',
    typical: ['press release', 'team announcement', 'talking points', 'pitch to podcasts as a guest', 'statement to the media', 'investor update'],
    not: 'Not social posts (Social Media), not marketing campaigns (Marketing), not the website content (Web Development).',
    words: ['press release', 'announcement', 'talking points', 'investors', 'statement', 'radio interview'],
  },
  crm: {
    owns: 'The CRM (GoHighLevel contacts and automation): tags, contacts, pipelines, workflows, email automations, deliverability, imports.',
    typical: ['tag contacts', 'duplicate contacts', 'email automation', 'deliverability and spam', 'import contacts', 'text workflow for new leads', 'pipeline stage'],
    not: 'Not video work (Video), not selling itself (Sales), not building funnel pages (Funnels).',
    words: ['crm', 'contacts', 'tag', 'workflow', 'automation', 'deliverability', 'pipeline stage'],
  },
  'openclaw-maintenance': {
    owns: 'Care of the AI system itself: updates, backups, agent health, the Telegram bot, logs, disk, installing skills.',
    typical: ['update the AI system', 'back up agent memory', 'bot stopped responding', 'agent health check', 'clear logs', 'install a skill'],
    not: 'Not a business process that broke (Healer), not a website or app bug (Bugs).',
    words: ['ai system', 'agents', 'telegram bot', 'backup', 'skill', 'logs', 'disk'],
  },
  legal: {
    owns: 'Legal and compliance: contracts, NDAs, terms, privacy policy, trademarks, licensing, leases.',
    typical: ['review a contract', 'NDA', 'privacy policy and GDPR', 'trademark a name', 'music licensing', 'lease review', 'send the latest contract'],
    not: 'Not a public statement (Communications), not building the terms page (Web Development).',
    words: ['contract', 'nda', 'trademark', 'privacy policy', 'gdpr', 'lease', 'terms and conditions', 'allowed to use'],
  },
  'social-media': {
    owns: 'Posting and growing on social platforms: posts, comments, scheduling, groups, threads, followers.',
    typical: ['post photos on Facebook and Instagram', 'LinkedIn posts', 'reply to TikTok comments', 'grow Instagram', 'schedule posts', 'Facebook group', 'Twitter thread'],
    not: 'Not paid ads (Paid Advertisement), not graphic design (Graphics), not video editing (Video).',
    words: ['post', 'instagram', 'facebook', 'linkedin', 'tiktok', 'twitter', 'followers', 'comments'],
  },
  'paid-advertisement': {
    owns: 'Paid ad campaigns: Facebook/Meta, Google, TikTok and audio ads, budgets, retargeting, cost per lead.',
    typical: ['launch a Facebook ad campaign', 'pause ads', 'ad copy', 'retargeting', 'cost per lead', 'ad budget', 'Spotify audio ad'],
    not: 'Not organic posting (Social Media), not general marketing plans (Marketing).',
    words: ['ads', 'ad campaign', 'budget', 'retargeting', 'cost per lead', 'meta', 'google ads'],
  },
  'personal-assistant': {
    owns: "The owner's personal errands and calendar: travel, reservations, reminders, appointments, scheduling and rescheduling meetings and calls, gifts, inbox, personal purchases and family matters.",
    typical: ['book a flight', 'clean up my inbox', 'schedule a call', 'remind me to call someone', 'restaurant reservation', 'reschedule a meeting', 'order a gift', 'car service appointment'],
    not: 'Personal or calendar work is ALWAYS Personal Assistant, never General Task. Not business operations (those go to the matching department).',
    words: ['remind me', 'schedule a call', 'reschedule', 'book me', 'reservation', 'gift', 'appointment', 'my inbox', 'oil change'],
  },
  'project-architecture-office': {
    owns: 'Planning large cross-department work: rollouts, launches, PRDs, phases and milestones, timelines, coordination across several departments.',
    typical: ['plan a whole rollout start to finish', 'write a PRD', 'break a redesign into phases and milestones', 'coordinate a launch across marketing, sales and support', 'timeline for a migration'],
    not: 'Any multi-department launch or rollout plan is Project Architecture Office, not General Task. Not a single-department task and not pure fact research (Research).',
    words: ['rollout', 'launch across', 'coordinate', 'milestones', 'phases', 'prd', 'timeline', 'start to finish'],
  },
  bugs: {
    owns: 'Reporting and tracking things that are broken or glitching: error logs, bug lists, triage, broken links and buttons that need a ticket.',
    typical: ['log and track an error', 'file a bug', 'keep a list of glitches', 'triage error reports', 'broken calendar link', 'checkout button does nothing'],
    not: 'A broken thing reported or tracked is Bugs, not General Task. Not fixing a repeating process failure at its root (Healer).',
    words: ['bug', 'glitch', 'error', 'broken', 'throwing an error', 'file a bug', 'triage'],
  },
  healer: {
    owns: 'Fixing a process that keeps failing, whatever department it belongs to: root cause analysis, repeated mistakes, repairing an SOP so the failure stops.',
    typical: ['same failure keeps happening', 'find the root cause and fix it so it stops', 'agents keep making the same mistake and fix their SOP', 'process broke again', 'root cause analysis'],
    not: 'Healer owns the repair of a recurring failure even when the broken thing is billing, the welcome sequence or invoices; do not send it to the department that owns the broken thing.',
    words: ['root cause', 'keeps failing', 'same mistake', 'fix their sop', 'broke again', 'so it stops', 'skip people'],
  },
  'quality-control': {
    owns: 'Reviewing, checking and scoring work and SOPs against standards: proofreading, audits, SOP and role reviews, quality scoring.',
    typical: ['proofread a page', 'review SOPs for specificity', 'audit roles', 'check quality before it goes live', 'score support replies'],
    not: 'Proofreading and reviewing existing work is Quality Control even when the work is a sales page or a sales SOP; it does not write or build the work.',
    words: ['proofread', 'review the', 'audit', 'check the quality', 'score', 'flag anything vague'],
  },
  'general-task': {
    owns: 'Only work that fits NO department: office admin, hiring and job descriptions, unrecognizable or gibberish requests, true one-offs.',
    typical: ['order office supplies', 'find a cleaning service', 'organize shared drive folders', 'write a job description', 'plan a team retreat', 'translate a document'],
    not: 'Never personal errands, reminders, scheduling or gifts (Personal Assistant), never multi-department launches or rollouts (Project Architecture Office), never broken things (Bugs). When any department plausibly owns the task, choose that department.',
    words: [],
  },
};

export function profileFor(d: Pick<DepartmentConfig, 'id' | 'slug'>): DepartmentProfile | undefined {
  return DEPARTMENT_PROFILES[canonicalDeptSlug(d.slug || d.id)];
}

/** One text block for the model pick: what the department owns, typical work, what it does not handle. */
export function profileText(d: DepartmentConfig): string {
  const p = profileFor(d);
  if (!p) return d.purpose;
  return `${p.owns} Typical: ${p.typical.join('; ')}. ${p.not}`;
}
