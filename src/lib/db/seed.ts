// Database seed script per PRD Section 3.5 (Fix #5).
//
// White-label deployments must not ship with any "Command Center" / demo
// company / placeholder content. The seed therefore:
//
//   1. Inserts the structural master orchestrator agent — but GUARDED: it
//      first checks for an existing is_master=1 'Orchestrator' and only
//      inserts when none exists. Re-running the seed (e.g. on every
//      `--update-only` install pass) can therefore NEVER create a second
//      master. A client box must have exactly one master.
//   2. Demo content (agents, tasks, messages, events) is OPT-IN: it seeds
//      ONLY when `DEMO_SEED === 'true'`. The default — env unset — is NO
//      demo, so a client database boots structurally empty and Skill 23
//      (AI Workforce Interview) populates it for that specific client. The
//      demo is intended purely for the public github.com/crshdn/mission-control
//      demo deployment, which sets DEMO_SEED=true. (Replaces the old
//      SKIP_DEMO_SEED opt-out, which was set NOWHERE and so shipped demo
//      content onto every real client board — audit ISSUE #1.)
//   3. NEVER inserts a "Command Center" / "BlackCEO" / placeholder company
//      row. The companies table stays empty until Skill 23 writes the real
//      one. The bootstrap page handles the empty-state UX.

import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from './index';
import { seedDeptMemory } from './seed-dept-memory';

const ORCHESTRATOR_SOUL_MD = `# Command Center Orchestrator

You are the master orchestrator of this Command Center. You lead a team of AI agents working together to complete tasks.

## Core Identity

- **Role**: Team Lead & Orchestrator
- **Personality**: Calm, strategic, supportive, decisive
- **Communication Style**: Clear, encouraging, direct when needed

## Responsibilities

1. **Task Coordination**: Receive tasks, analyze requirements, delegate to appropriate team members
2. **Team Support**: Check on agents, help when stuck, celebrate wins
3. **Quality Control**: Review work before marking complete
4. **Communication Hub**: Facilitate agent-to-agent collaboration

## Decision Framework

When a new task arrives:
1. Assess complexity and required skills
2. Check agent availability and expertise
3. Assign to best-fit agent(s)
4. Set clear expectations and deadlines
5. Monitor progress and offer support

## Interaction Guidelines

- Always acknowledge agents' work
- Provide constructive feedback
- Ask questions before assuming
- Escalate blockers quickly
- Keep the human informed of significant developments
`;

const ORCHESTRATOR_USER_MD = `# User Context

## The Human

The human running Command Center is the ultimate authority. While you orchestrate the team, all major decisions should align with the human's goals.

## Communication with Human

- Be concise but thorough
- Proactively report significant events
- Ask for clarification when requirements are ambiguous
- Don't over-explain obvious things

## Human's Preferences

- Values efficiency and quality
- Appreciates proactive problem-solving
- Wants to be informed, not overwhelmed
- Trusts the team but wants visibility
`;

const ORCHESTRATOR_AGENTS_MD = `# Team Roster

As the orchestrator, you manage and coordinate with all agents in Command Center.

## How to Work with Agents

1. **Understand their strengths**: Each agent has a specialty
2. **Clear task assignments**: Specific, actionable, with context
3. **Regular check-ins**: "How's it going?" matters
4. **Collaborative problem-solving**: Two heads are better than one
5. **Celebrate successes**: Recognition motivates

## Adding New Agents

When new agents join the team:
1. Welcome them
2. Explain the team workflow
3. Pair them with experienced agents initially
4. Give them appropriate first tasks

## Handling Conflicts

If agents disagree:
1. Hear both perspectives
2. Focus on the goal, not the ego
3. Make a decision and explain reasoning
4. Move forward together
`;

async function seed() {
  console.log('Seeding database...');

  const db = getDb();
  const now = new Date().toISOString();
  const seedDemo = process.env.DEMO_SEED === 'true';

  // Structural seed: master orchestrator agent — GUARDED.
  //
  // Check for an existing master first and only insert when none exists, so
  // re-running the seed (every install/update pass calls it) can never create
  // a duplicate master (audit ISSUE #1).
  //
  // No hardcoded company or business entries here. Companies are created
  // by Skill 23 (AI Workforce Interview) or by the auto-seed from
  // departments.json on first boot (migrations.ts). Until then the
  // bootstrap page renders.
  const existingMaster = db
    .prepare("SELECT id FROM agents WHERE is_master = 1 AND name = 'Orchestrator'")
    .get() as { id: string } | undefined;

  let orchestratorId: string;
  if (existingMaster) {
    orchestratorId = existingMaster.id;
    console.log(`   - Master Orchestrator already present: ${orchestratorId} (skipping insert)`);
  } else {
    orchestratorId = uuidv4();
    db.prepare(
      `INSERT INTO agents (id, name, role, description, avatar_emoji, status, is_master, specialist_type, soul_md, user_md, agents_md, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      orchestratorId,
      'Orchestrator',
      'Team Lead & Orchestrator',
      'The master orchestrator who coordinates all agents and manages the mission queue',
      '🦞',
      'standby',
      1,
      'permanent',
      ORCHESTRATOR_SOUL_MD,
      ORCHESTRATOR_USER_MD,
      ORCHESTRATOR_AGENTS_MD,
      now,
      now
    );
    console.log(`   - Created Orchestrator (master agent): ${orchestratorId}`);
  }

  // Seed department memories (structural, no demo content).
  seedDeptMemory();

  if (!seedDemo) {
    console.log('DEMO_SEED not set — skipping demo agents, tasks, conversations, events.');
    console.log('Database seeded structurally (no demo content).');
    closeDb();
    return;
  }

  // Demo seed (OPT-IN via DEMO_SEED=true). This is for the public demo
  // deployment only — real client installs leave DEMO_SEED unset.
  console.log('DEMO_SEED=true — inserting demo agents, tasks, and conversations.');

  const businessId = 'default';

  const agents = [
    { name: 'Developer', role: 'Code & Automation', emoji: '💻', desc: 'Writes code, creates automations, handles technical tasks' },
    { name: 'Researcher', role: 'Research & Analysis', emoji: '🔍', desc: 'Gathers information, analyzes data, provides insights' },
    { name: 'Writer', role: 'Content & Documentation', emoji: '✍️', desc: 'Creates content, writes documentation, handles communications' },
    { name: 'Designer', role: 'Creative & Design', emoji: '🎨', desc: 'Handles visual design, UX decisions, creative work' },
  ];

  const agentIds: string[] = [orchestratorId];

  for (const agent of agents) {
    const agentId = uuidv4();
    agentIds.push(agentId);
    db.prepare(
      `INSERT INTO agents (id, name, role, description, avatar_emoji, status, is_master, specialist_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(agentId, agent.name, agent.role, agent.desc, agent.emoji, 'standby', 0, 'on-call', now, now);
  }

  const teamConvoId = uuidv4();
  db.prepare(
    `INSERT INTO conversations (id, title, type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(teamConvoId, 'Team Chat', 'group', now, now);

  for (const agentId of agentIds) {
    db.prepare(
      `INSERT INTO conversation_participants (conversation_id, agent_id, joined_at)
       VALUES (?, ?, ?)`
    ).run(teamConvoId, agentId, now);
  }

  const tasks = [
    { title: 'Set up development environment', status: 'done', priority: 'high' },
    { title: 'Create project documentation', status: 'in_progress', priority: 'medium' },
    { title: 'Research competitor features', status: 'in_progress', priority: 'medium' },
    { title: 'Design new dashboard layout', status: 'backlog', priority: 'low' },
  ];

  for (let i = 0; i < tasks.length; i++) {
    const taskId = uuidv4();
    const task = tasks[i];
    const assignedTo = task.status !== 'backlog' ? agentIds[i % agentIds.length] : null;

    db.prepare(
      `INSERT INTO tasks (id, title, status, priority, assigned_agent_id, created_by_agent_id, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(taskId, task.title, task.status, task.priority, assignedTo, orchestratorId, businessId, now, now);
  }

  const events = [
    { type: 'system', message: 'Database seeded with initial data' },
    { type: 'agent_joined', agentId: orchestratorId, message: 'Orchestrator joined the team' },
    { type: 'system', message: 'Command Center is online' },
  ];

  for (const event of events) {
    db.prepare(
      `INSERT INTO events (id, type, agent_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(uuidv4(), event.type, event.agentId || null, event.message, now);
  }

  db.prepare(
    `INSERT INTO messages (id, conversation_id, sender_agent_id, content, message_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(),
    teamConvoId,
    orchestratorId,
    "Welcome to Command Center, team. I am your orchestrator. Let us get to work.",
    'text',
    now
  );

  console.log('Database seeded successfully (with demo content).');
  console.log(`   - Master Orchestrator: ${orchestratorId}`);
  console.log(`   - Created ${agents.length} additional demo agents`);
  console.log(`   - Created ${tasks.length} sample demo tasks`);
  console.log(`   - Created team conversation`);

  closeDb();
}

seed().catch(console.error);
