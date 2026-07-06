#!/usr/bin/env node
/**
 * Demo Seed Script — Creates a realistic workspace with agents and tasks
 * for the Mission Control live demo.
 * 
 * Usage: node scripts/demo-seed.js [--db path/to/db]
 */

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const dbPath = process.argv.includes('--db') 
  ? process.argv[process.argv.indexOf('--db') + 1]
  : path.join(process.cwd(), 'mission-control.db');

console.log(`[Demo Seed] Database: ${dbPath}`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString().replace('T', ' ').replace('Z', '');

// --- Workspace ---
const wsId = uuid();
const wsSlug = 'ai-dev-team';
db.prepare(`INSERT OR REPLACE INTO workspaces (id, name, slug, description, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run(wsId, 'AI Development Team', wsSlug, 'Building the next generation of AI-powered tools', '🚀', now(), now());

console.log(`[Demo Seed] Workspace: ${wsId} (${wsSlug})`);

// --- Agents ---
const agents = [
  { name: 'Charlie', role: 'orchestrator', status: 'working', avatar: '🦞', model: 'ollama/deepseek-v4-pro:cloud' },
  { name: 'Builder', role: 'builder', status: 'working', avatar: '🔨', model: 'ollama/deepseek-v4-pro:cloud' },
  { name: 'Tester', role: 'tester', status: 'standby', avatar: '🧪', model: 'ollama/deepseek-v4-pro:cloud' },
  { name: 'Reviewer', role: 'reviewer', status: 'standby', avatar: '👁️', model: 'ollama/deepseek-v4-pro:cloud' },
  { name: 'Researcher', role: 'researcher', status: 'standby', avatar: '🔍', model: 'ollama/deepseek-v4-pro:cloud' },
];

const agentIds = {};
for (const agent of agents) {
  const id = uuid();
  agentIds[agent.name] = id;
  db.prepare(`INSERT OR REPLACE INTO agents (id, name, role, status, workspace_id, created_at, updated_at, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, agent.name, agent.role, agent.status, wsId, now(), now(), agent.model);
  console.log(`[Demo Seed] Agent: ${agent.avatar} ${agent.name} (${agent.role}) — ${agent.status}`);
}

// --- Tasks across multiple statuses ---
// priority values MUST match the tasks.priority CHECK constraint
// ('low','medium','high','critical') — 'normal'/'urgent' previously used here
// failed the CHECK and aborted the demo seed with SQLITE_CONSTRAINT.
const tasks = [
  // Planning
  { title: 'Design webhook retry system', desc: 'Implement exponential backoff for failed webhook deliveries with configurable max retries', status: 'planning', priority: 'high' },
  
  // Inbox
  { title: 'Add dark/light theme toggle', desc: 'User preference for theme with system default detection and localStorage persistence', status: 'inbox', priority: 'medium' },
  { title: 'Create API rate limiter', desc: 'Token bucket rate limiting middleware with per-IP and per-token tracking', status: 'inbox', priority: 'high' },
  
  // Assigned
  { title: 'Build notification system', desc: 'Real-time browser notifications for task updates, agent status changes, and system alerts', status: 'assigned', priority: 'high', agent: 'Builder' },
  
  // In Progress
  { title: 'Implement task dependencies', desc: 'Allow tasks to declare prerequisites. Block dispatch until dependencies are resolved. Show dependency graph in UI.', status: 'in_progress', priority: 'critical', agent: 'Builder' },
  { title: 'Add WebSocket reconnection logic', desc: 'Auto-reconnect with exponential backoff when Gateway connection drops. Show connection status in header.', status: 'in_progress', priority: 'high', agent: 'Charlie' },
  
  // Testing
  { title: 'Implement file preview endpoint', desc: 'Render markdown, images, and code files inline in the deliverables panel', status: 'testing', priority: 'medium', agent: 'Tester' },
  
  // Review
  { title: 'Add agent performance metrics', desc: 'Track task completion time, success rate, and token usage per agent. Display in agent modal.', status: 'review', priority: 'medium', agent: 'Reviewer' },
  
  // Done (recent)
  { title: 'Security hardening — auth middleware', desc: 'Bearer token authentication, Zod validation, path traversal protection, security headers', status: 'done', priority: 'critical', agent: 'Builder' },
  { title: 'Redesign kanban board layout', desc: 'Wider columns, better card design, smooth drag animations, status indicators', status: 'done', priority: 'medium', agent: 'Builder' },
  { title: 'Set up CI/CD pipeline', desc: 'GitHub Actions for lint, build, and test on every PR. Auto-deploy to staging.', status: 'done', priority: 'high', agent: 'Charlie' },
];

const taskIds = [];
for (const task of tasks) {
  const id = uuid();
  taskIds.push({ id, ...task });
  const agentId = task.agent ? agentIds[task.agent] : null;
  const mins = Math.floor(Math.random() * 120);
  const createdAt = new Date(Date.now() - mins * 60000).toISOString().replace('T', ' ').replace('Z', '');
  
  db.prepare(`INSERT OR REPLACE INTO tasks (id, title, description, status, priority, workspace_id, assigned_agent_id, created_by_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, task.title, task.desc, task.status, task.priority, wsId, agentId, agentIds['Charlie'], createdAt, now());
  
  console.log(`[Demo Seed] Task: [${task.status}] ${task.title}`);
}

// --- Activity Events ---
const activityTypes = [
  { type: 'status_change', messages: [
    'Task moved to {status}',
    'Status updated: {status}',
    'Transitioned to {status}',
  ]},
  { type: 'comment', messages: [
    'Starting work on this task. Estimated completion: 2 hours.',
    'Found an edge case in the input validation. Adding additional Zod schema checks.',
    'Build passing. All 47 tests green. Ready for review.',
    'Code review complete. Two minor suggestions — applying now.',
    'Deployed to staging. Running integration tests.',
    'All tests passing. Merging to main.',
    'This looks good. Clean implementation with proper error handling.',
    'Researching best practices for this approach before starting.',
    'Initial implementation complete. Need to add error boundaries.',
    'Performance benchmarks look good. 3ms p99 response time.',
  ]},
  { type: 'deliverable', messages: [
    'Created: src/lib/notification-service.ts',
    'Created: src/components/TaskDependencyGraph.tsx',
    'Updated: src/middleware.ts — added rate limiting',
    'Created: tests/integration/webhook-retry.test.ts',
    'Generated: docs/API-REFERENCE.md',
  ]},
];

// Add realistic activities to in-progress and completed tasks
const activeTasks = taskIds.filter(t => ['in_progress', 'testing', 'review', 'done'].includes(t.status));
for (const task of activeTasks) {
  const numActivities = 3 + Math.floor(Math.random() * 5);
  for (let i = 0; i < numActivities; i++) {
    const typeGroup = activityTypes[Math.floor(Math.random() * activityTypes.length)];
    const message = typeGroup.messages[Math.floor(Math.random() * typeGroup.messages.length)]
      .replace('{status}', task.status);
    const agentId = task.agent ? agentIds[task.agent] : agentIds['Charlie'];
    const minsAgo = Math.floor(Math.random() * 60) + (numActivities - i) * 5;
    const ts = new Date(Date.now() - minsAgo * 60000).toISOString().replace('T', ' ').replace('Z', '');
    
    db.prepare(`INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(uuid(), task.id, agentId, typeGroup.type, message, ts);
  }
}

// --- System Events for Live Feed ---
const events = [
  { type: 'agent_joined', message: `🦞 Charlie joined the team`, agentId: agentIds['Charlie'] },
  { type: 'agent_joined', message: `🔨 Builder joined the team`, agentId: agentIds['Builder'] },
  { type: 'agent_joined', message: `🧪 Tester joined the team`, agentId: agentIds['Tester'] },
  { type: 'agent_joined', message: `👁️ Reviewer joined the team`, agentId: agentIds['Reviewer'] },
  { type: 'agent_joined', message: `🔍 Researcher joined the team`, agentId: agentIds['Researcher'] },
  { type: 'task_created', message: `New task: Security hardening — auth middleware` },
  { type: 'task_updated', message: `Task "Security hardening" moved to done` },
  { type: 'task_created', message: `New task: Implement task dependencies` },
  { type: 'task_updated', message: `Task "Task dependencies" assigned to Builder` },
  { type: 'system', message: `🔒 Security audit completed — 19/19 checks passed` },
];

for (let i = 0; i < events.length; i++) {
  const minsAgo = (events.length - i) * 8;
  const ts = new Date(Date.now() - minsAgo * 60000).toISOString().replace('T', ' ').replace('Z', '');
  db.prepare(`INSERT INTO events (id, type, message, agent_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(uuid(), events[i].type, events[i].message, events[i].agentId || null, ts);
}

console.log(`\n[Demo Seed] ✅ Complete!`);
console.log(`  Workspace: AI Development Team`);
console.log(`  Agents: ${agents.length}`);
console.log(`  Tasks: ${tasks.length}`);
console.log(`  Activities: ${activeTasks.length * 5}+`);
console.log(`  Events: ${events.length}`);

db.close();
