// Department Memory Seed Script
// Seeds departments with 3-5 starter memories each

import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from './index';

interface DeptSeed {
  id: string;
  name: string;
  memories: { memory_type: string; content: string; importance: number }[];
}

const DEPT_SEEDS: DeptSeed[] = [
  {
    id: 'marketing',
    name: 'Marketing',
    memories: [
      { memory_type: 'goal', content: 'Goal: Reduce cost per lead (CPL) to $20 by Q2 2026', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All campaigns must use company brand colors', importance: 4 },
      { memory_type: 'context', content: 'Context: Primary audience is Black entrepreneurs aged 30-55 across US metro areas', importance: 4 },
      { memory_type: 'lesson', content: 'Lesson: Email sequences with personalization outperform generic blasts by 3x on open rates', importance: 3 },
    ],
  },
  {
    id: 'sales',
    name: 'Sales',
    memories: [
      { memory_type: 'goal', content: 'Goal: Close 40 enterprise deals per quarter by Q3 2026', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All pricing discounts above 15% require VP approval', importance: 4 },
      { memory_type: 'context', content: 'Context: Average deal size is $4,200/month with 6-month average close cycle', importance: 3 },
      { memory_type: 'lesson', content: 'Lesson: Demos scheduled within 24 hours of lead capture convert at 2.5x the rate', importance: 4 },
    ],
  },
  {
    id: 'billing',
    name: 'Billing / Finance',
    memories: [
      { memory_type: 'goal', content: 'Goal: Reduce average invoice collection time from 45 days to 30 days', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All refunds over $500 must be reviewed by finance lead', importance: 4 },
      { memory_type: 'context', content: 'Context: 85% of revenue is recurring subscriptions, 15% is one-time services', importance: 3 },
      { memory_type: 'lesson', content: 'Lesson: Automated payment reminders at day 7, 14, and 21 reduced late payments by 35%', importance: 3 },
    ],
  },
  {
    id: 'support',
    name: 'Customer Support',
    memories: [
      { memory_type: 'goal', content: 'Goal: Maintain 95%+ CSAT score and reduce first response time to under 2 hours', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All escalations must be acknowledged within 30 minutes during business hours', importance: 5 },
      { memory_type: 'context', content: 'Context: Top 3 ticket categories: billing questions (35%), feature requests (28%), technical issues (22%)', importance: 3 },
      { memory_type: 'lesson', content: 'Lesson: Proactive check-in emails reduced churn by 12% in pilot program', importance: 3 },
    ],
  },
  {
    id: 'operations',
    name: 'Operations',
    memories: [
      { memory_type: 'goal', content: 'Goal: Automate 60% of recurring operational workflows by end of 2026', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All new processes must be documented before deployment', importance: 4 },
      { memory_type: 'context', content: 'Context: 12 core workflows currently run manually, 8 have automation potential', importance: 3 },
    ],
  },
  {
    id: 'creative',
    name: 'Creative',
    memories: [
      { memory_type: 'goal', content: 'Goal: Increase content production volume by 25% while maintaining quality score above 90%', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All assets must pass brand compliance checklist before publication', importance: 4 },
      { memory_type: 'context', content: 'Context: Content calendar is planned 4 weeks ahead, social posts are 2 weeks ahead', importance: 3 },
      { memory_type: 'lesson', content: 'Lesson: Video content generates 4x more engagement than static images across all platforms', importance: 3 },
    ],
  },
  {
    id: 'hr',
    name: 'HR / People',
    memories: [
      { memory_type: 'goal', content: 'Goal: Reduce onboarding completion time from 14 days to 7 days', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All job postings must include salary range and benefits summary', importance: 4 },
      { memory_type: 'context', content: 'Context: Team is fully remote, 85% US-based, async-first communication culture', importance: 3 },
    ],
  },
  {
    id: 'legal',
    name: 'Legal / Compliance',
    memories: [
      { memory_type: 'goal', content: 'Goal: Achieve 100% compliance audit pass rate for 2026', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All contracts must be reviewed within 5 business days of submission', importance: 5 },
      { memory_type: 'context', content: 'Context: Key compliance frameworks: SOC 2 Type II, GDPR, CCPA', importance: 4 },
      { memory_type: 'lesson', content: 'Lesson: Pre-approved contract templates reduced legal review time by 40%', importance: 3 },
    ],
  },
  {
    id: 'it',
    name: 'IT / Tech',
    memories: [
      { memory_type: 'goal', content: 'Goal: Maintain 99.95% uptime across all production services', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: Zero critical security vulnerabilities in production within 24 hours of detection', importance: 5 },
      { memory_type: 'context', content: 'Context: Infrastructure runs on AWS (primary) with Cloudflare CDN edge', importance: 3 },
      { memory_type: 'lesson', content: 'Lesson: Blue-green deployments eliminated downtime during releases', importance: 3 },
    ],
  },
  {
    id: 'webdev',
    name: 'Web Development',
    memories: [
      { memory_type: 'goal', content: 'Goal: Achieve sub-2-second page load times on all web properties', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All PRs require at least one review and passing CI before merge', importance: 4 },
      { memory_type: 'context', content: 'Context: Primary stack is Next.js + TypeScript, deployed via Vercel and Cloudflare', importance: 3 },
      { memory_type: 'lesson', content: 'Lesson: Implementing lazy loading on images reduced LCP by 40% site-wide', importance: 3 },
    ],
  },
  {
    id: 'appdev',
    name: 'App Development',
    memories: [
      { memory_type: 'goal', content: 'Goal: Ship v2.0 mobile app with offline support by Q3 2026', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All features must have automated test coverage before release', importance: 4 },
      { memory_type: 'context', content: 'Context: React Native codebase, iOS and Android, 45K monthly active users', importance: 3 },
    ],
  },
  {
    id: 'graphics',
    name: 'Graphics',
    memories: [
      { memory_type: 'goal', content: 'Goal: Build comprehensive design system with 100+ reusable components', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All deliverables must be provided in SVG, PNG (2x), and Figma source', importance: 4 },
      { memory_type: 'context', content: 'Context: Brand palette is navy (#1a2744), gold (#d4a843), white, with accent coral (#e8614d)', importance: 4 },
      { memory_type: 'lesson', content: 'Lesson: Component-based design reduced turnaround time for marketing assets by 50%', importance: 3 },
    ],
  },
  {
    id: 'video',
    name: 'Video',
    memories: [
      { memory_type: 'goal', content: 'Goal: Produce 20 high-quality video pieces per month across all channels', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All videos must be captioned and available in 9:16, 16:9, and 1:1 formats', importance: 4 },
      { memory_type: 'context', content: 'Context: Primary platforms are YouTube, Instagram Reels, and TikTok', importance: 3 },
    ],
  },
  {
    id: 'audio',
    name: 'Audio',
    memories: [
      { memory_type: 'goal', content: 'Goal: Launch weekly company podcast with 5,000 downloads per episode by Q4 2026', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All audio content must be mastered to -16 LUFS for consistent loudness', importance: 4 },
      { memory_type: 'context', content: 'Context: Recording setup uses Rode PodMic, Focusrite Scarlett, Riverside for remote', importance: 3 },
      { memory_type: 'lesson', content: 'Lesson: Episodes under 35 minutes have 60% higher completion rates', importance: 3 },
    ],
  },
  {
    id: 'research',
    name: 'Research',
    memories: [
      { memory_type: 'goal', content: 'Goal: Deliver quarterly market analysis reports 2 weeks ahead of board meetings', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All research claims must cite primary sources with links', importance: 4 },
      { memory_type: 'context', content: 'Context: Focus areas include Black entrepreneurship trends, fintech, and SaaS market dynamics', importance: 3 },
    ],
  },
  {
    id: 'comms',
    name: 'Communications',
    memories: [
      { memory_type: 'goal', content: 'Goal: Increase internal communication response rate to 90% within 4 hours', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All external press statements must be approved by CEO before release', importance: 5 },
      { memory_type: 'context', content: 'Context: Internal channels include Slack (primary), email (weekly digest), and town halls (monthly)', importance: 3 },
      { memory_type: 'lesson', content: 'Lesson: Short-form video updates outperform long email newsletters by 3x on engagement', importance: 3 },
    ],
  },
  {
    id: 'ceo',
    name: 'CEO / COM',
    memories: [
      { memory_type: 'goal', content: 'Goal: Achieve $10M ARR milestone by end of FY2026', importance: 5 },
      { memory_type: 'constraint', content: 'Constraint: All strategic pivots require board-level approval and 30-day impact analysis', importance: 5 },
      { memory_type: 'context', content: 'Context: Company focus is empowering Black entrepreneurs through AI-powered business tools', importance: 5 },
      { memory_type: 'lesson', content: 'Lesson: Weekly cross-department sync reduced project delays by 28% since implementation', importance: 4 },
    ],
  },
];

export function seedDeptMemory(workspaceId: string = 'default'): number {
  const db = getDb();
  const now = new Date().toISOString();
  let count = 0;

  // Check if already seeded (look for any dept memory rows)
  const existing = db.prepare(
    'SELECT COUNT(*) as cnt FROM dept_memory'
  ).get() as { cnt: number };

  if (existing.cnt > 0) {
    console.log(`[Seed] Dept memory already seeded (${existing.cnt} rows). Skipping.`);
    return existing.cnt;
  }

  for (const dept of DEPT_SEEDS) {
    for (const mem of dept.memories) {
      db.prepare(
        `INSERT INTO dept_memory (id, workspace_id, memory_type, content, created_by, importance, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'system', ?, ?, ?)`
      ).run(uuidv4(), dept.id, mem.memory_type, mem.content, mem.importance, now, now);
      count++;
    }
  }

  console.log(`[Seed] Seeded ${count} department memories across ${DEPT_SEEDS.length} departments for workspace '${workspaceId}'`);
  return count;
}

// Run directly
if (require.main === module) {
  try {
    seedDeptMemory();
    closeDb();
  } catch (err) {
    console.error('[Seed] Failed:', err);
    process.exit(1);
  }
}
