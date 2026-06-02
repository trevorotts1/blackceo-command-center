/**
 * Starter SOP library + idempotent seeder (B6).
 *
 * This is the SINGLE source of truth for the starter SOPs. It is consumed by:
 *   - `scripts/seed-starter-sops.ts` (manual `npm run db:seed:sops`), and
 *   - the first-boot DB-init path (`runMigrations` → `seedStarterSOPs`) in
 *     `src/lib/db/migrations.ts`, which is also where the Skill-23
 *     (ai-workforce-blueprint) workspace auto-seed runs. Chaining the SOP seed
 *     to that same place guarantees the role library (workspaces/agents) AND
 *     the SOPs load together exactly where the client runs Skill 23 — never an
 *     empty SOP table that silently blocks the Triad Rule.
 *
 * Idempotent: skips any SOP whose slug already exists, so it is safe to run on
 * every boot. Takes a `better-sqlite3` Database handle directly so it can run
 * inside the migration runner without re-entering getDb().
 *
 * Department slugs (one starter SOP each) align with the default Skill-23
 * department set: ceo, marketing, sales, billing, support, legal, webdev,
 * appdev, graphics, video, audio, research, comms, crm, openclaw, social,
 * paid-ads.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface SeedSOPStep {
  name: string;
  checklist?: string[];
  success_criteria?: string;
  persona_hint?: string;
}

export interface SeedSOP {
  slug: string;
  name: string;
  description: string;
  department: string;
  task_keywords: string;
  steps: SeedSOPStep[];
  success_criteria: string;
  persona_hints: string[];
}

export const STARTER_SOPS: SeedSOP[] = [
  // 1. CEO
  {
    slug: 'ceo-weekly-strategic-review',
    name: 'Weekly Strategic Review',
    description: 'Cadenced review of company-wide metrics, blocked items, and next-week priorities.',
    department: 'ceo',
    task_keywords: 'strategy,review,weekly,priorities,goals,kpi,planning',
    steps: [
      { name: 'Pull KPI snapshot', checklist: ['Revenue', 'Cash runway', 'Active customers', 'Top 3 risks'], success_criteria: 'One-page dashboard, no missing metrics' },
      { name: 'Audit last-week commitments', checklist: ['What shipped', 'What slipped + why', 'Decisions still open'], success_criteria: 'Every slip has a root cause and an owner' },
      { name: 'Set this-week priorities', checklist: ['Max 3 priorities', 'Each tied to a KPI', 'Single owner per priority'], success_criteria: 'Priorities pass the "would I bet $10k on this?" test' },
      { name: 'Identify blockers to escalate', checklist: ['What needs the CEO personally', 'What can be delegated', 'What can wait'], success_criteria: 'Clear delegation list, nothing parked in CEO inbox by default' },
      { name: 'Write the weekly note', checklist: ['Wins', 'Misses', 'Priorities', 'Asks'], success_criteria: 'Under 400 words, no fluff' },
    ],
    success_criteria: 'Team leaves the week knowing the top 3 priorities and who owns each',
    persona_hints: ['horowitz-hard-thing', 'collins-good-to-great', 'grove-high-output-management'],
  },

  // 2. Marketing
  {
    slug: 'marketing-campaign-launch',
    name: 'Campaign Launch Playbook',
    description: 'Standard playbook for launching a new marketing campaign end-to-end.',
    department: 'marketing',
    task_keywords: 'campaign,launch,marketing,promo,announcement,go-to-market',
    steps: [
      { name: 'Define audience + offer', checklist: ['Single primary audience', 'One offer, one CTA', 'Quantified outcome promise'], success_criteria: 'Can describe the campaign in one sentence' },
      { name: 'Build messaging hierarchy', checklist: ['Headline', '3 supporting beats', 'Proof points', 'Objection answers'], success_criteria: 'Reader gets the value in 5 seconds' },
      { name: 'Create assets', checklist: ['Landing page', 'Email sequence', 'Social cuts', 'Ads'], success_criteria: 'Brand-consistent, mobile-checked, links verified' },
      { name: 'Set up tracking', checklist: ['UTMs', 'Conversion events', 'Attribution model'], success_criteria: 'Every channel attributable in dashboard' },
      { name: 'Launch + monitor day 1-7', checklist: ['Daily CPA check', 'Reply/comment triage', 'Creative refresh signals'], success_criteria: 'CPA on target by day 3 or kill switch fires' },
    ],
    success_criteria: 'Campaign hits target CAC and >1.5x return on creative spend by day 14',
    persona_hints: ['godin-purple-cow', 'ries-22-immutable-laws', 'priestley-key-person-influence'],
  },

  // 3. Sales
  {
    slug: 'sales-cold-outreach',
    name: 'Cold Outreach Email Sequence',
    description: 'Five-step playbook for cold email that gets replies, not "unsubscribe".',
    department: 'sales',
    task_keywords: 'cold,outreach,email,prospect,follow-up,sequence,sdr',
    steps: [
      { name: 'Research the prospect', checklist: ['LinkedIn profile read', 'Company recent news', 'One pain point identified'], success_criteria: 'Can state 3 specific facts about them' },
      { name: 'Draft subject line', checklist: ['Under 50 chars', 'No buzzwords', 'Personalized'], success_criteria: 'Open rate prediction > 30%' },
      { name: 'Write opener', checklist: ['References their specific pain', 'Quantified outcome from similar customer'], success_criteria: 'Reader feels seen in first 2 sentences' },
      { name: 'Body + CTA', checklist: ['Single clear ask', '20-min call max', 'Easy yes/no'], success_criteria: 'One unambiguous next step' },
      { name: 'PS + social proof', checklist: ['Logo/name they recognize', 'Relevant industry'], success_criteria: 'Adds 1 line of credibility' },
    ],
    success_criteria: 'Email achieves >30% open + >15% reply on cold list',
    persona_hints: ['voss-never-split-difference', 'bly-copywriters-handbook', 'wiebe-copy-hackers', 'jones-exactly-what-to-say'],
  },

  // 4. Billing
  {
    slug: 'billing-failed-payment-recovery',
    name: 'Failed Payment Recovery',
    description: 'Recover revenue from declined cards without churning the customer.',
    department: 'billing',
    task_keywords: 'billing,payment,failed,decline,dunning,retry,churn,invoice',
    steps: [
      { name: 'Classify failure reason', checklist: ['Hard decline vs soft decline', 'Card expired', 'Fraud flag', 'Insufficient funds'], success_criteria: 'Each failure routed to the right recovery path' },
      { name: 'Schedule retry cascade', checklist: ['Day 1 retry', 'Day 3 retry', 'Day 7 retry'], success_criteria: 'Retries respect bank cool-off windows' },
      { name: 'Send recovery comms', checklist: ['Day 1: gentle nudge', 'Day 3: update card link', 'Day 7: pause warning'], success_criteria: 'Customer-friendly tone, never accusatory' },
      { name: 'Offer to help', checklist: ['Live chat option', 'Account pause option', 'Plan downgrade option'], success_criteria: 'No customer feels trapped' },
      { name: 'Post-recovery confirmation', checklist: ['Receipt sent', 'Account fully restored', 'Note in CRM'], success_criteria: 'Customer knows it is resolved' },
    ],
    success_criteria: 'Recover >60% of soft-decline MRR within 14 days, churn-rate < pre-decline baseline',
    persona_hints: ['cialdini-influence', 'voss-never-split-difference'],
  },

  // 5. Support
  {
    slug: 'support-ticket-triage',
    name: 'Support Ticket Triage + Resolution',
    description: 'Standard triage flow for inbound support tickets to maximize first-contact resolution.',
    department: 'support',
    task_keywords: 'support,ticket,issue,help,customer,bug,question',
    steps: [
      { name: 'Acknowledge within SLA', checklist: ['First response < 1 hour', 'Restate the problem in their words'], success_criteria: 'Customer knows a human saw it' },
      { name: 'Reproduce or verify', checklist: ['Steps to reproduce', 'Screenshots if UI', 'Logs if backend'], success_criteria: 'Issue is verifiably real, not assumed' },
      { name: 'Resolve or escalate', checklist: ['Known issue → KB link', 'New issue → engineering ticket', 'Edge case → workaround offered'], success_criteria: 'Customer has a path forward in this reply' },
      { name: 'Confirm the fix landed', checklist: ['Ask customer to verify', 'Reopen on no-reply within 48h'], success_criteria: 'No silent abandonment' },
      { name: 'Close + KB update', checklist: ['Update KB if pattern repeats 3x', 'Tag root cause for product'], success_criteria: 'Pattern visible in monthly review' },
    ],
    success_criteria: 'CSAT > 90%, first-contact resolution > 70%, median resolution < 24h',
    persona_hints: ['cialdini-influence', 'voss-never-split-difference', 'sinek-start-with-why'],
  },

  // 6. Legal
  {
    slug: 'legal-contract-review',
    name: 'Contract Review (Inbound Counterparty)',
    description: 'Review an incoming contract against company red-lines and risk thresholds.',
    department: 'legal',
    task_keywords: 'contract,legal,review,agreement,nda,msa,terms,redline',
    steps: [
      { name: 'Identify document type', checklist: ['NDA', 'MSA', 'SOW', 'Vendor terms', 'License'], success_criteria: 'Correct red-line checklist loaded' },
      { name: 'Run red-line scan', checklist: ['Indemnity caps', 'IP ownership', 'Termination', 'Data clauses', 'Auto-renewal', 'Liability cap'], success_criteria: 'Every red-line clause noted with stance' },
      { name: 'Flag deal-breakers', checklist: ['Unlimited liability', 'Broad IP assignment', 'One-sided termination'], success_criteria: 'Deal-breakers escalated before any negotiation' },
      { name: 'Draft counter-proposals', checklist: ['Alt language ready', 'Fallback positions', 'Walk-away line'], success_criteria: 'Counterparty has clear, polite redlines' },
      { name: 'Final review + sign-off', checklist: ['All redlines resolved', 'Effective date confirmed', 'Counter-signature path clear'], success_criteria: 'Nothing executable that the company would not defend in court' },
    ],
    success_criteria: 'Zero contract incidents traced to clauses signed without review',
    persona_hints: ['voss-never-split-difference', 'sutton-bullshit-detector'],
  },

  // 7. Webdev
  {
    slug: 'webdev-feature-ship',
    name: 'Web Feature Ship Cycle',
    description: 'Spec → build → QA → deploy a new web feature without breaking prod.',
    department: 'webdev',
    task_keywords: 'web,feature,build,deploy,frontend,backend,ship,release',
    steps: [
      { name: 'Confirm spec', checklist: ['Acceptance criteria', 'Edge cases', 'Out-of-scope explicit'], success_criteria: 'No ambiguity before code is written' },
      { name: 'Branch + build', checklist: ['Feature branch off main', 'Tests written first', 'No console errors'], success_criteria: 'Local build green, lint clean' },
      { name: 'Self-review + QA', checklist: ['Mobile + desktop', 'Keyboard nav', 'Slow-network probe'], success_criteria: 'Feature degrades gracefully' },
      { name: 'PR + code review', checklist: ['CI green', 'Reviewer-friendly description', 'Migrations called out'], success_criteria: '1-2 round trips max with reviewer' },
      { name: 'Deploy + smoke test', checklist: ['Deploy to staging', 'Smoke check', 'Promote to prod', 'Rollback plan in PR'], success_criteria: 'No regressions in error monitoring 1h post-deploy' },
    ],
    success_criteria: 'Feature ships, error rate flat, no rollback needed',
    persona_hints: ['martin-clean-code', 'beck-tdd', 'fowler-refactoring'],
  },

  // 8. Appdev
  {
    slug: 'appdev-mobile-release',
    name: 'Mobile App Release Cycle',
    description: 'Build, test, and release a mobile app update to TestFlight / Internal Track → production.',
    department: 'appdev',
    task_keywords: 'mobile,app,ios,android,release,build,store,testflight',
    steps: [
      { name: 'Bump version + changelog', checklist: ['Semver bump', 'Plain-English changelog', 'Crash-fix notes'], success_criteria: 'Store reviewer can understand the changes' },
      { name: 'Run device matrix', checklist: ['iOS oldest supported', 'iOS latest', 'Android oldest', 'Android latest', 'Tablet check'], success_criteria: 'No crashes on any device class' },
      { name: 'Beta release', checklist: ['TestFlight build pushed', 'Internal Track pushed', '20+ beta users notified'], success_criteria: '48h beta with no P0 reports' },
      { name: 'Store submission', checklist: ['Screenshots updated', 'Privacy manifest current', 'App Review notes'], success_criteria: 'No rejection on first submit' },
      { name: 'Phased rollout', checklist: ['1% → 10% → 50% → 100%', 'Crash rate gate at each step', 'Rollback ready'], success_criteria: 'Crash-free rate stays > 99.5%' },
    ],
    success_criteria: 'Release ships at 100%, crash-free > 99.5%, no emergency hotfix',
    persona_hints: ['martin-clean-code', 'beck-tdd'],
  },

  // 9. Graphics
  {
    slug: 'graphics-asset-production',
    name: 'Graphic Asset Production',
    description: 'Brief → concept → execution → handoff for any static visual asset.',
    department: 'graphics',
    task_keywords: 'graphic,design,asset,visual,logo,banner,thumbnail,image',
    steps: [
      { name: 'Lock the brief', checklist: ['Purpose', 'Audience', 'Where it lives', 'Brand constraints', 'Dimensions'], success_criteria: 'Brief fits on one page, no ambiguity' },
      { name: 'Concept exploration', checklist: ['3 distinct directions', 'Mood references', 'Type/color choices'], success_criteria: 'Stakeholder picks one direction without "can I see more?"' },
      { name: 'Execute chosen direction', checklist: ['Pixel grid clean', 'Typography on baseline', 'Color contrast WCAG AA'], success_criteria: 'Looks intentional at any zoom level' },
      { name: 'Round 1 review', checklist: ['Annotated feedback only', 'Max 5 changes', 'No "make it pop"'], success_criteria: 'Feedback is specific and actionable' },
      { name: 'Final delivery', checklist: ['All required formats exported', 'File naming convention', 'Brand kit updated if reusable'], success_criteria: 'Asset is plug-and-play, no missing fonts/colors' },
    ],
    success_criteria: 'Asset approved in ≤ 2 revision rounds and lands in brand library',
    persona_hints: ['lupton-thinking-with-type', 'godin-purple-cow'],
  },

  // 10. Video
  {
    slug: 'video-short-form-production',
    name: 'Short-Form Video Production',
    description: 'Produce a 30-90s short-form video (Reels/Shorts/TikTok) from idea to publish.',
    department: 'video',
    task_keywords: 'video,short-form,reels,tiktok,shorts,produce,edit,publish',
    steps: [
      { name: 'Hook + payoff', checklist: ['Hook lands in first 1.5s', 'Payoff promised in hook is delivered', 'Single message'], success_criteria: 'Watch-time prediction > 70%' },
      { name: 'Script + shot list', checklist: ['Beat-by-beat script', 'B-roll list', 'Captions written'], success_criteria: 'Editor can cut without director on set' },
      { name: 'Shoot', checklist: ['Vertical 9:16', 'Audio levels checked', 'Two takes per beat'], success_criteria: 'Footage usable without re-shoots' },
      { name: 'Edit + captions', checklist: ['Pace cuts to beat', 'Burned-in captions', 'Sound design pass'], success_criteria: 'Watchable with sound off' },
      { name: 'Publish + monitor', checklist: ['Caption + hashtags', 'Posted at peak window', '24h performance check'], success_criteria: 'Hits platform median retention curve' },
    ],
    success_criteria: 'Video clears platform median for retention + saves in first 48h',
    persona_hints: ['godin-purple-cow', 'priestley-key-person-influence'],
  },

  // 11. Audio
  {
    slug: 'audio-podcast-episode',
    name: 'Podcast Episode Production',
    description: 'Plan → record → edit → publish a podcast episode end-to-end.',
    department: 'audio',
    task_keywords: 'audio,podcast,episode,record,edit,publish,interview',
    steps: [
      { name: 'Episode brief', checklist: ['Topic + angle', 'Guest research (if any)', 'Audience takeaway'], success_criteria: 'One sentence of "why listen?"' },
      { name: 'Record', checklist: ['Levels at -12dB', 'Local backup recording', 'Quiet environment', 'Pre-roll + slate'], success_criteria: 'Clean WAV per channel, no clipping' },
      { name: 'Edit + clean audio', checklist: ['Hum/noise removal', 'Filler-word pass', 'Music + intro', 'Loudness to -16 LUFS'], success_criteria: 'Sounds professional on phone speakers' },
      { name: 'Show notes + chapters', checklist: ['Title under 60 chars', 'Show notes with timestamps', 'Guest links'], success_criteria: 'Listener can scan and decide to play' },
      { name: 'Publish + cross-promote', checklist: ['RSS', 'Apple', 'Spotify', 'YouTube cut', 'Social pull-quotes'], success_criteria: 'Episode visible on all channels at publish time' },
    ],
    success_criteria: 'Episode completes ≥ 75% listen-through on top of feed',
    persona_hints: ['priestley-key-person-influence', 'sinek-start-with-why'],
  },

  // 12. Research
  {
    slug: 'research-market-deep-dive',
    name: 'Market Deep-Dive',
    description: 'Produce an unbiased market research report on a niche, competitor, or opportunity.',
    department: 'research',
    task_keywords: 'research,market,competitor,analysis,report,intel,insights',
    steps: [
      { name: 'Frame the question', checklist: ['Decision the research will inform', 'Audience', 'Decision deadline'], success_criteria: 'Research stops when the decision can be made' },
      { name: 'Source map', checklist: ['Primary sources', 'Secondary sources', 'Adversarial sources'], success_criteria: 'No echo chamber — at least one contrarian source' },
      { name: 'Synthesize', checklist: ['Facts vs claims separated', 'Confidence per claim', 'Surprises flagged'], success_criteria: 'Reader can audit every claim' },
      { name: 'Draft + adversarial review', checklist: ['Steelman the opposite view', 'List unknowns', 'Limit on scope explicit'], success_criteria: 'A skeptic would not call it propaganda' },
      { name: 'Recommendation', checklist: ['Top 1 recommended action', 'Top 1 do-not-do', 'Confidence percentage'], success_criteria: 'Decision-maker can act from the summary alone' },
    ],
    success_criteria: 'Report drives a real decision and holds up 90 days later',
    persona_hints: ['taleb-fooled-by-randomness', 'kahneman-thinking-fast-slow', 'sutton-bullshit-detector'],
  },

  // 13. Comms
  {
    slug: 'comms-internal-announcement',
    name: 'Internal Announcement',
    description: 'Communicate an internal change (org, policy, product) without rumor mill blowback.',
    department: 'comms',
    task_keywords: 'comms,announcement,internal,memo,update,company,policy',
    steps: [
      { name: 'Decide what + why + when', checklist: ['What changes', 'Why now', 'When effective'], success_criteria: 'Three sentences, no jargon' },
      { name: 'Identify impacted groups', checklist: ['Who is directly impacted', 'Who is indirectly impacted', 'Who hears before announcement'], success_criteria: 'No one is blindsided' },
      { name: 'Sequence the rollout', checklist: ['1:1s for directly impacted', 'Small group brief', 'Company-wide message'], success_criteria: 'Order is intentional, not last-minute' },
      { name: 'Draft the message', checklist: ['Lead with the change', 'Then the why', 'Then the support'], success_criteria: 'Reader knows what to do after reading' },
      { name: 'Open Q&A channel', checklist: ['Live Q&A or async thread', 'Most-asked questions answered publicly', 'Follow-up note in 7d'], success_criteria: 'Questions surface and get answered in the open' },
    ],
    success_criteria: 'Announcement lands without surprise resignations or rumor escalation',
    persona_hints: ['sinek-start-with-why', 'cialdini-influence', 'grove-high-output-management'],
  },

  // 14. CRM
  {
    slug: 'crm-pipeline-hygiene',
    name: 'CRM Pipeline Hygiene',
    description: 'Weekly hygiene pass on CRM pipeline so forecast is trustworthy.',
    department: 'crm',
    task_keywords: 'crm,pipeline,hygiene,forecast,deals,opportunity,stage,hubspot,ghl',
    steps: [
      { name: 'Stale deal sweep', checklist: ['No activity > 30 days', 'No next step booked', 'No close date set'], success_criteria: 'Every stale deal has a decision: nudge, demote, close-lost' },
      { name: 'Stage integrity', checklist: ['Each deal meets stage entry criteria', 'Close date is realistic', 'Amount is current'], success_criteria: 'Stage definitions are honest' },
      { name: 'Forecast rollup', checklist: ['Commit', 'Best-case', 'Pipeline coverage ≥ 3x quota'], success_criteria: 'Forecast matches what reps would bet on' },
      { name: 'Activity audit', checklist: ['Calls logged', 'Emails synced', 'Notes from last meeting'], success_criteria: 'Anyone could pick up the deal' },
      { name: 'Coaching list', checklist: ['Top 3 deals to coach this week', 'Top risk', 'Top opportunity'], success_criteria: 'Sales leader knows where to spend coaching time' },
    ],
    success_criteria: 'Forecast accuracy improves week-over-week; no deal closes "we forgot about"',
    persona_hints: ['rackham-spin-selling', 'grove-high-output-management', 'voss-never-split-difference'],
  },

  // 15. OpenClaw
  {
    slug: 'openclaw-skill-build',
    name: 'OpenClaw Skill Build + Ship',
    description: 'Standard playbook for building, testing, and shipping a new OpenClaw skill.',
    department: 'openclaw',
    task_keywords: 'openclaw,skill,build,ship,agent,automation,workflow',
    steps: [
      { name: 'Define skill spec', checklist: ['Input shape', 'Output shape', 'Failure modes', 'Idempotency'], success_criteria: 'Skill can be tested without humans' },
      { name: 'Wire data sources', checklist: ['Use existing TOOLS.md helper if present', 'No reinventing API clients', 'Credentials via env, never hardcoded'], success_criteria: 'TOOLS.md FIRST — no new code path if helper exists' },
      { name: 'Implement + test', checklist: ['Happy path', 'Error path', 'Timeout/retry', 'Real-world fixture'], success_criteria: 'Skill survives an adversarial test run' },
      { name: 'Enforce skill-chain', checklist: ['State field present', 'Resume loop / cron fires', 'Not a "AUTOMATIC NEXT STEP" prose comment'], success_criteria: 'Skill chain is mechanically enforced, not aspirational' },
      { name: 'Document + register', checklist: ['INSTRUCTIONS.md updated', 'TOOLS.md updated if new helper added', 'Version bumped', 'Listed in update-skills.sh'], success_criteria: 'Future agents discover it without being told' },
    ],
    success_criteria: 'Skill ships, runs unattended for 7 days without intervention',
    persona_hints: ['martin-clean-code', 'beck-tdd', 'kahneman-thinking-fast-slow'],
  },

  // 16. Social
  {
    slug: 'social-content-pillar-week',
    name: 'Weekly Social Content Pillar Cycle',
    description: 'Produce one week of social content from a single pillar idea.',
    department: 'social',
    task_keywords: 'social,content,instagram,twitter,linkedin,post,pillar,calendar',
    steps: [
      { name: 'Choose the pillar', checklist: ['Tied to business outcome', 'On-brand', 'Sustainable for 4 weeks'], success_criteria: 'Pillar passes "can we make 20 posts about this?" test' },
      { name: 'Atomize into 5-7 posts', checklist: ['Hook variations', 'Format mix (text, carousel, video, image)', 'CTAs varied'], success_criteria: 'No two posts look the same in the feed' },
      { name: 'Produce assets in batch', checklist: ['Same lighting/setup', 'Captions drafted', 'Hashtag set per platform'], success_criteria: 'Week produced in one sitting' },
      { name: 'Schedule + cross-post', checklist: ['Native upload per platform', 'Peak-window slots', 'Stories + main feed plan'], success_criteria: 'No platform left empty for >36h' },
      { name: 'Engage + measure', checklist: ['Reply window first 60 min', 'Top-of-funnel metric per post', 'End-of-week pattern review'], success_criteria: 'Wins identified, losers killed off the pillar' },
    ],
    success_criteria: 'Audience growth + engagement up week-over-week on pillar topic',
    persona_hints: ['godin-purple-cow', 'priestley-key-person-influence', 'sinek-start-with-why'],
  },

  // 17. Paid Ads
  {
    slug: 'paid-ads-meta-campaign',
    name: 'Meta Paid Campaign Setup + Optimization',
    description: 'Launch and optimize a paid Meta campaign with disciplined testing structure.',
    department: 'paid-ads',
    task_keywords: 'paid,ads,meta,facebook,instagram,campaign,roas,cpa,optimize',
    steps: [
      { name: 'Pixel + events check', checklist: ['Pixel firing on key pages', 'Conversion events deduped', 'CAPI live'], success_criteria: 'Event quality score > 7 in Events Manager' },
      { name: 'Campaign structure', checklist: ['CBO or ABO chosen for stage', 'Audiences distinct (no overlap)', 'Creative test isolated from audience test'], success_criteria: 'Each test changes one variable' },
      { name: 'Creative production', checklist: ['3 hooks × 3 bodies × 2 CTAs', 'UGC + studio mix', 'Format: static, video, carousel'], success_criteria: 'At least 18 creatives to learn from' },
      { name: 'Launch + 72h learning', checklist: ['Daily spend cap honors learning phase', 'No edits in first 48h', 'CPA + CTR + thumb-stop tracked'], success_criteria: 'Algorithm exits learning phase cleanly' },
      { name: 'Scale or kill', checklist: ['Winners: scale 20% per 48h', 'Losers: kill at 3x CPA target', 'Refresh creatives at fatigue threshold'], success_criteria: 'ROAS holds within ±15% as spend doubles' },
    ],
    success_criteria: 'Campaign hits target ROAS and scales without breaking it',
    persona_hints: ['godin-purple-cow', 'priestley-key-person-influence', 'bly-copywriters-handbook'],
  },

  // 18. Security
  {
    slug: 'security-incident-response',
    name: 'Security Incident Response + Hygiene',
    description: 'Detect, log, contain, and recover from a security anomaly while enforcing ongoing credential hygiene.',
    department: 'security',
    task_keywords: 'security,incident,breach,access,credentials,anomaly,monitor,hygiene,2fa,threat',
    steps: [
      {
        name: 'Detect + log the anomaly',
        checklist: [
          'Unusual login geo or time',
          'Unexpected API key usage',
          'Failed auth spike',
          'New device / new IP on privileged account',
          'Log entry with timestamp, source IP, affected system, and severity (P1–P3)',
        ],
        success_criteria: 'Every anomaly has a written log entry before any action is taken',
        persona_hint: 'threat-intel-first',
      },
      {
        name: 'Classify severity',
        checklist: [
          'P1: active breach / data exfiltration in progress',
          'P2: unauthorized access confirmed, no confirmed exfil',
          'P3: suspicious signal, no confirmed access',
          'Assign owner for the incident',
        ],
        success_criteria: 'Severity set, owner named, within 5 min of detection',
        persona_hint: 'nist-incident-classification',
      },
      {
        name: 'Contain',
        checklist: [
          'Revoke or rotate the compromised credential immediately',
          'Suspend affected session tokens',
          'Block source IP if external threat',
          'Isolate affected service if breach is active',
          'Notify Trevor / client owner via secure channel',
        ],
        success_criteria: 'Threat vector is closed before investigation continues',
        persona_hint: 'contain-before-investigate',
      },
      {
        name: 'Investigate + root-cause',
        checklist: [
          'Audit logs pulled for ±24h window',
          'Access scope of compromise determined',
          'Lateral movement checked (other creds, other services)',
          'Root cause identified: phishing / leaked .env / weak password / misconfigured ACL',
        ],
        success_criteria: 'Root cause documented with evidence, not assumptions',
        persona_hint: 'five-whys',
      },
      {
        name: 'Recover + harden',
        checklist: [
          'All affected credentials rotated',
          '2FA enforced on re-entry',
          'Affected service fully restored and smoke-tested',
          'Incident report written (timeline, impact, fix, prevention)',
          'Preventive control added (e.g., alert rule, env-secret audit, permission scope reduction)',
        ],
        success_criteria: 'Service restored, same attack vector is mechanically blocked going forward',
        persona_hint: 'defense-in-depth',
      },
    ],
    success_criteria: 'Incident contained within 15 min of detection, root cause documented, and recurrence prevented by a new control',
    persona_hints: ['schneier-secrets-lies', 'anderson-security-engineering', 'nist-cybersecurity-framework'],
  },

  // 19. HR / People
  {
    slug: 'hr-people-onboarding',
    name: 'Team Member Onboarding',
    description: 'Bring a new employee, contractor, or VA fully online — access, context, and culture — in the first 5 days.',
    department: 'hr-people',
    task_keywords: 'hr,onboarding,hire,contractor,va,access,people,culture,role',
    steps: [
      {
        name: 'Pre-day-1 provisioning',
        checklist: [
          'Accounts created: email, Slack/Telegram, CRM, project management',
          'Permissions scoped to role only (least privilege)',
          'Equipment or access link sent 48h before start',
          'Welcome message drafted and scheduled',
        ],
        success_criteria: 'New member can log in on day 1 without waiting on IT',
        persona_hint: 'system-ready-before-human',
      },
      {
        name: 'Day-1 orientation',
        checklist: [
          'Company mission + values — in their own words (not PowerPoint)',
          'Their role\'s success definition for first 30 days',
          'Who to ask for what',
          'Communication norms (response SLA, async vs sync)',
        ],
        success_criteria: 'Member can describe what "winning" looks like in their role',
        persona_hint: 'sinek-start-with-why',
      },
      {
        name: 'Week-1 ramp tasks',
        checklist: [
          '3–5 low-stakes tasks to build context',
          'Shadow one full client/customer interaction',
          'Review SOPs for their department',
          'Ask: "What was unclear?" — record answers for SOP improvement',
        ],
        success_criteria: 'Member completes at least 3 real tasks by end of week 1',
        persona_hint: 'action-over-orientation',
      },
      {
        name: '30-day check-in',
        checklist: [
          'Are they hitting the 30-day success definition?',
          'What\'s blocking them?',
          'Do they have what they need?',
          'Adjust role scope if spec was wrong',
        ],
        success_criteria: '30-day fit decision is data-driven, not gut-feel',
        persona_hint: 'grove-high-output-management',
      },
      {
        name: 'Offboarding trigger readiness',
        checklist: [
          'All credentials documented in password manager (never in their head only)',
          'Access revocation checklist exists and is tested',
          'Knowledge capture protocol in place',
        ],
        success_criteria: 'If this person left tomorrow, nothing is lost and nothing stays accessible',
        persona_hint: 'bus-factor-zero',
      },
    ],
    success_criteria: 'Member is independently productive by day 30 and offboarding takes < 1 hour',
    persona_hints: ['grove-high-output-management', 'horowitz-hard-thing', 'sinek-start-with-why'],
  },

  // 20. Finance / Accounting
  {
    slug: 'finance-month-end-close',
    name: 'Month-End Close + Cash Flow Review',
    description: 'Close the books, reconcile accounts, and produce a clear cash position at the end of every month.',
    department: 'finance-accounting',
    task_keywords: 'finance,accounting,month-end,close,cash-flow,reconcile,p&l,balance-sheet,bookkeeping',
    steps: [
      {
        name: 'Collect all transactions',
        checklist: [
          'Bank feeds synced or CSV imported',
          'Credit card statements pulled',
          'Stripe / payment processor exports pulled',
          'Expenses submitted by all team members',
        ],
        success_criteria: 'No transaction older than 30 days is uncategorized',
        persona_hint: 'complete-before-classify',
      },
      {
        name: 'Categorize + reconcile',
        checklist: [
          'Each transaction matched to a chart-of-accounts category',
          'Bank balance in software matches bank statement balance',
          'Outstanding checks and deposits noted',
          'Duplicate transactions flagged and removed',
        ],
        success_criteria: 'Reconciliation difference is $0 or variance explained',
        persona_hint: 'trust-but-verify',
      },
      {
        name: 'AP / AR sweep',
        checklist: [
          'Invoices sent for all delivered work',
          'Overdue AR > 30 days — follow-up triggered',
          'Vendor bills confirmed and scheduled for payment',
          'No surprise payables outstanding',
        ],
        success_criteria: 'AR aging and AP schedule both accurate to the day',
        persona_hint: 'cash-is-king',
      },
      {
        name: 'Produce P&L + cash position',
        checklist: [
          'Revenue vs prior month',
          'Top 5 expense categories vs budget',
          'Net operating income',
          'Current cash balance and days of runway',
        ],
        success_criteria: 'CEO can make a spend decision from this one page',
        persona_hint: 'metrics-drive-decisions',
      },
      {
        name: 'Flag and act on anomalies',
        checklist: [
          'Any expense > 20% above prior month — explained',
          'Revenue miss > 10% — root cause noted',
          'Runway drop > 15% — escalate to CEO',
          'Upcoming large outflows on the calendar',
        ],
        success_criteria: 'No financial surprise lands in the CEO\'s lap at the next board meeting',
        persona_hint: 'no-surprises-doctrine',
      },
    ],
    success_criteria: 'Books closed by day 5 of following month, cash position accurate, and one-page summary in CEO\'s inbox',
    persona_hints: ['ramsey-total-money-makeover', 'grove-high-output-management', 'horowitz-hard-thing'],
  },

  // 21. Operations
  {
    slug: 'operations-weekly-ops-review',
    name: 'Weekly Operations Review',
    description: 'Audit SOPs, tool stack, vendor status, and open project intake every week to keep operations from drifting.',
    department: 'operations',
    task_keywords: 'operations,ops,process,workflow,vendor,project,intake,sop,systems,tools',
    steps: [
      {
        name: 'Open project intake',
        checklist: [
          'New requests captured in one place (not inboxes)',
          'Each request triaged: scope, owner, deadline, priority',
          'Requests with no owner flagged for CEO decision',
        ],
        success_criteria: 'Nothing is floating in someone\'s DMs that should be a tracked project',
        persona_hint: 'gtd-capture-everything',
      },
      {
        name: 'In-flight project health',
        checklist: [
          'Each project has a status: on-track / at-risk / blocked',
          'Blocked items have a named unblocking action and deadline',
          'Projects with no update in > 7 days flagged',
        ],
        success_criteria: 'Any project can be explained in 10 seconds',
        persona_hint: 'clarity-over-detail',
      },
      {
        name: 'Tool stack audit',
        checklist: [
          'Active subscriptions match tools actually in use',
          'Any duplicate tools (two project managers, two CRMs)',
          'Any new shadow IT introduced this week',
          'Upcoming renewals in next 30 days',
        ],
        success_criteria: 'No zombie subscriptions; every tool has a named owner',
        persona_hint: 'one-tool-per-function',
      },
      {
        name: 'Vendor + contractor check-in',
        checklist: [
          'Deliverables on track',
          'Invoices pending vs received',
          'SLA compliance check',
          'Renewal / offboarding decisions due',
        ],
        success_criteria: 'No vendor goes silent for > 14 days without a follow-up action',
        persona_hint: 'vendor-accountability',
      },
      {
        name: 'SOP health pass',
        checklist: [
          'Any SOP broken by a tool change this week',
          'Any repeated mistake that needs a new SOP',
          'One SOP improved or created this week (continuous improvement)',
        ],
        success_criteria: 'SOPs reflect how work is actually done, not how it was done 6 months ago',
        persona_hint: 'living-documentation',
      },
    ],
    success_criteria: 'Operations are frictionless: no project surprise, no zombie tool, no untracked vendor',
    persona_hints: ['grove-high-output-management', 'allen-getting-things-done', 'collins-good-to-great'],
  },

  // 22. Data Analytics
  {
    slug: 'data-analytics-weekly-dashboard',
    name: 'Weekly Analytics Dashboard + Insight Report',
    description: 'Pull, validate, and narrate the weekly data story so every department acts on facts, not vibes.',
    department: 'data-analytics',
    task_keywords: 'data,analytics,dashboard,metrics,kpi,report,insights,funnel,attribution,bi',
    steps: [
      {
        name: 'Pull fresh data from all sources',
        checklist: [
          'CRM (pipeline, close rate, velocity)',
          'Marketing (impressions, CPL, CAC)',
          'Product (DAU/WAU, churn, feature adoption)',
          'Finance (revenue, MRR, burn)',
          'Support (ticket volume, CSAT, resolution time)',
        ],
        success_criteria: 'Single source of truth — no department uses a different number for the same metric',
        persona_hint: 'single-source-of-truth',
      },
      {
        name: 'Validate data quality',
        checklist: [
          'Spot-check 3 numbers against raw source',
          'Flag missing segments or broken tracking',
          'Confirm date ranges are consistent across sources',
          'Note any tracking gaps or anomalies before publishing',
        ],
        success_criteria: 'Published number is auditable back to raw data within 5 min',
        persona_hint: 'garbage-in-garbage-out',
      },
      {
        name: 'Identify week-over-week signals',
        checklist: [
          'Metrics up > 10%: confirm driver',
          'Metrics down > 10%: root-cause hypothesis',
          'New pattern not seen in prior 4 weeks',
          'Leading vs lagging indicator split',
        ],
        success_criteria: 'At least one genuine insight — not just "revenue was $X"',
        persona_hint: 'signal-vs-noise',
      },
      {
        name: 'Build the narrative',
        checklist: [
          'Start with the most important metric',
          'One paragraph per department max',
          'Each paragraph ends with a recommended action',
          'Flag one metric to watch next week',
        ],
        success_criteria: 'Reader knows what to do differently this week after reading',
        persona_hint: 'data-tells-a-story',
      },
      {
        name: 'Distribute + act',
        checklist: [
          'Report in CEO\'s inbox by Monday 9am',
          'Department owners tagged on their section',
          'Recommended actions tracked to completion next week',
          'Disagreements with the data surfaced, not buried',
        ],
        success_criteria: 'Every recommended action is assigned to a person with a deadline',
        persona_hint: 'accountability-not-reporting',
      },
    ],
    success_criteria: 'Decisions made this week can be traced to a specific metric; no gut-feel calls that data could have answered',
    persona_hints: ['kahneman-thinking-fast-slow', 'taleb-fooled-by-randomness', 'grove-high-output-management'],
  },

  // 23. Executive Assistant
  {
    slug: 'executive-assistant-weekly-ops',
    name: 'Executive Assistant Weekly Ops Cycle',
    description: 'Keep the CEO\'s calendar, inbox, and action-item list at zero overhead every week.',
    department: 'executive-assistant',
    task_keywords: 'executive,assistant,ea,calendar,inbox,scheduling,meeting-prep,action-items,admin,leverage',
    steps: [
      {
        name: 'Monday morning calendar audit',
        checklist: [
          'All meetings this week have agendas or pre-reads',
          'No back-to-back meetings > 2h without a buffer',
          'High-energy work blocked as deep-work (no meetings)',
          'Travel / logistics confirmed for any off-site',
        ],
        success_criteria: 'CEO\'s week is structurally sound before Monday 9am',
        persona_hint: 'protect-the-calendar',
      },
      {
        name: 'Inbox triage (daily)',
        checklist: [
          'Emails sorted: needs-reply, FYI, junk, delegate',
          'Anything > 48h old without reply flagged to CEO',
          'Meeting requests vetted against CEO\'s priorities',
          'Newsletters / digests routed to a reading folder, not inbox',
        ],
        success_criteria: 'CEO spends < 20 min/day on email; everything else is handled',
        persona_hint: 'inbox-zero-as-default',
      },
      {
        name: 'Meeting prep packets',
        checklist: [
          'Sent 24h before every external meeting',
          'Attendee context: who they are, what they want, what the CEO wants',
          'Agenda with time-boxes',
          'Supporting docs linked',
          'CEO\'s goal for the meeting in one sentence',
        ],
        success_criteria: 'CEO never walks into a meeting cold',
        persona_hint: 'preparation-is-leverage',
      },
      {
        name: 'Action-item capture + follow-up',
        checklist: [
          'Every meeting ends with written action items (owner + deadline)',
          'Items sent to owners within 1h of meeting close',
          'Follow-up pings sent 24h before deadline',
          'Completed items logged, not just deleted',
        ],
        success_criteria: 'Nothing slips through. If it was said, it was written. If it was written, it was followed up.',
        persona_hint: 'close-the-loop',
      },
      {
        name: 'Friday wrap + next-week preview',
        checklist: [
          'Open action items: status update requested from owners',
          'Next-week priorities confirmed with CEO',
          'Any scheduling changes finalized',
          'Weekly brief note to CEO: done / outstanding / watching',
        ],
        success_criteria: 'CEO walks into Monday knowing exactly what is happening — no Sunday anxiety',
        persona_hint: 'end-of-week-clarity',
      },
    ],
    success_criteria: 'CEO operates at strategic altitude: < 30 min/day on admin, zero missed commitments, every meeting purposeful',
    persona_hints: ['grove-high-output-management', 'allen-getting-things-done', 'horowitz-hard-thing'],
  },
];

export interface SeedResult {
  inserted: number;
  skipped: number;
  total: number;
}

/**
 * Idempotently seed the starter SOP library into the given DB handle.
 * Skips any SOP whose slug already exists. Safe to run on every boot.
 */
export function seedStarterSOPs(db: Database.Database): SeedResult {
  let inserted = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  const findStmt = db.prepare('SELECT id FROM sops WHERE slug = ?');
  const insertStmt = db.prepare(
    `INSERT INTO sops (id, name, slug, description, version, department, task_keywords, steps, success_criteria, persona_hints, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const sop of STARTER_SOPS) {
    const existing = findStmt.get(sop.slug) as { id: string } | undefined;
    if (existing) {
      skipped++;
      continue;
    }
    insertStmt.run(
      randomUUID(),
      sop.name,
      sop.slug,
      sop.description,
      sop.department,
      sop.task_keywords,
      JSON.stringify(sop.steps),
      sop.success_criteria,
      JSON.stringify(sop.persona_hints),
      now,
      now
    );
    inserted++;
  }

  return { inserted, skipped, total: STARTER_SOPS.length };
}
