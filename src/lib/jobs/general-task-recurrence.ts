/**
 * General-Task Recurrence Detector
 *
 * Weekly job (Sunday 04:30) that clusters tasks routed to the `general-task`
 * department over the past 30 days. When a cluster of similar tasks reaches
 * ≥4 members in that window (i.e. >3/month), it upserts a `recommendations`
 * row suggesting the operator stand up a dedicated department for that
 * recurring pattern.
 *
 * Design principles:
 *   - Reuses the existing `recommendations` table (category='try') — no new
 *     schema. Zero migration required.
 *   - Idempotent on a stable SHA-256 cluster hash: re-runs UPDATE the count on
 *     an existing pending recommendation rather than inserting a duplicate.
 *   - Suppresses dismissed recommendations: a cluster the operator already
 *     dismissed will not re-surface until its signature hash changes (i.e. the
 *     pattern meaningfully shifts).
 *   - Never crashes the scheduler: wrapped by the caller in scheduler.ts.
 *
 * Cluster algorithm: same Jaccard / top-keyword approach as sop-learning.ts
 * `clusterTasks()` but applied only to general-task dept rows and keyed on
 * a stable hash of the top-3 signature keywords.
 */

import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GeneralTaskRow {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
}

interface TaskCluster {
  signatureKeywords: string[];
  clusterHash: string;
  taskIds: string[];
  sampleTitles: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rolling window for recurrence detection (days). */
const WINDOW_DAYS = 30;

/** Minimum cluster size to trigger a recommendation (>3/month). */
const MIN_CLUSTER_SIZE = 4;

/** Number of top keywords used as the cluster signature. */
const SIGNATURE_KEYWORDS = 3;

// ---------------------------------------------------------------------------
// Text normalization (mirrors sop-learning.ts approach)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'this', 'that', 'it', 'its', 'i',
  'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them',
  'please', 'need', 'want', 'make', 'create', 'get', 'set', 'up', 'new',
  'add', 'update', 'task', 'tasks', 'work', 'job',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function taskTokens(task: GeneralTaskRow): string[] {
  return tokenize(`${task.title} ${task.description ?? ''}`);
}

function topKeywords(tokens: string[], n: number): string[] {
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([kw]) => kw);
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

function clusterGeneralTasks(tasks: GeneralTaskRow[]): TaskCluster[] {
  if (tasks.length === 0) return [];

  // Build a primary keyword per task (its single highest-frequency token).
  const taskKws: { task: GeneralTaskRow; primaryKw: string; tokens: string[] }[] = tasks.map(
    (task) => {
      const tokens = taskTokens(task);
      const [primaryKw = 'misc'] = topKeywords(tokens, 1);
      return { task, primaryKw, tokens };
    },
  );

  // Group by primary keyword.
  const groups = new Map<string, (typeof taskKws)[number][]>();
  for (const item of taskKws) {
    const arr = groups.get(item.primaryKw) ?? [];
    arr.push(item);
    groups.set(item.primaryKw, arr);
  }

  const clusters: TaskCluster[] = [];
  for (const [, members] of Array.from(groups.entries())) {
    if (members.length < MIN_CLUSTER_SIZE) continue;

    const corpus = members.flatMap((m) => m.tokens);
    const sigKws = topKeywords(corpus, SIGNATURE_KEYWORDS);

    // Stable hash: sorted keywords → SHA-256 → first 16 hex chars.
    const clusterHash = createHash('sha256')
      .update([...sigKws].sort().join(':'))
      .digest('hex')
      .slice(0, 16);

    clusters.push({
      signatureKeywords: sigKws,
      clusterHash,
      taskIds: members.map((m) => m.task.id),
      sampleTitles: members.slice(0, 4).map((m) => m.task.title),
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Recommendation upsert
// ---------------------------------------------------------------------------

function inferDeptName(sigKws: string[]): string {
  if (sigKws.length === 0) return 'New Department';
  // Capitalize each word and join with space (e.g. ["email","follow","up"] →
  // "Email Follow Up Department").
  return sigKws.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') + ' Department';
}

function upsertRecurrenceRecommendation(cluster: TaskCluster): { created: boolean } {
  const existingRow = queryOne<{
    id: string;
    status: string;
    supporting_data: string | null;
  }>(
    `SELECT id, status, supporting_data FROM recommendations
     WHERE department_id = 'general-task'
     AND   category = 'try'
     AND   supporting_data LIKE ?
     LIMIT 1`,
    [`%"clusterHash":"${cluster.clusterHash}"%`],
  );

  // Suppress dismissed clusters — operator already said "no" for this pattern.
  if (existingRow?.status === 'dismissed') {
    return { created: false };
  }

  const suggestedName = inferDeptName(cluster.signatureKeywords);
  const supportingData = JSON.stringify({
    clusterHash: cluster.clusterHash,
    signatureKeywords: cluster.signatureKeywords,
    count: cluster.taskIds.length,
    sampleTaskIds: cluster.taskIds.slice(0, 6),
    sampleTitles: cluster.sampleTitles,
    suggestedDeptSlug: cluster.signatureKeywords.slice(0, 2).join('-').replace(/\s+/g, '-'),
    windowDays: WINDOW_DAYS,
    detectedAt: new Date().toISOString(),
  });

  if (existingRow) {
    // Update the count + evidence on an existing pending/saved recommendation.
    run(
      `UPDATE recommendations
       SET title           = ?,
           description     = ?,
           supporting_data = ?,
           confidence      = ?,
           created_at      = created_at  -- preserve original detection date
       WHERE id = ?`,
      [
        `Consider a dedicated ${suggestedName}`,
        `${cluster.taskIds.length} tasks in the last ${WINDOW_DAYS} days matched the pattern "${cluster.signatureKeywords.join(', ')}". This recurrence suggests a dedicated department would handle these tasks more effectively than General Task.`,
        supportingData,
        Math.min(0.5 + cluster.taskIds.length * 0.05, 0.95),
        existingRow.id,
      ],
    );
    return { created: false };
  }

  // Insert a new recommendation.
  run(
    `INSERT INTO recommendations
       (id, department_id, category, title, description, supporting_data, confidence, status)
     VALUES (?, 'general-task', 'try', ?, ?, ?, ?, 'pending')`,
    [
      uuidv4(),
      `Consider a dedicated ${suggestedName}`,
      `${cluster.taskIds.length} tasks in the last ${WINDOW_DAYS} days matched the pattern "${cluster.signatureKeywords.join(', ')}". This recurrence suggests a dedicated department would handle these tasks more effectively than General Task.`,
      supportingData,
      Math.min(0.5 + cluster.taskIds.length * 0.05, 0.95),
    ],
  );
  return { created: true };
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

export interface RecurrenceDetectionResult {
  scanned_tasks: number;
  clusters_found: number;
  recommendations_upserted: number;
  recommendations_created: number;
}

/**
 * Run the General Task recurrence detector.
 *
 * Called by scheduler.ts (weekly, Sunday 04:30) and by
 * GET /api/cron/general-task-recurrence for manual triggers.
 *
 * Safe to call multiple times — idempotent on cluster hash.
 */
export function runGeneralTaskRecurrenceDetection(): RecurrenceDetectionResult {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Pull all general-task dept rows in the window (non-archived).
  const tasks = queryAll<GeneralTaskRow>(
    `SELECT id, title, description, created_at
     FROM tasks
     WHERE (department = 'general-task' OR department = 'General Task')
     AND   created_at >= ?
     AND   (archived_at IS NULL OR archived_at = '')
     ORDER BY created_at DESC`,
    [since],
  );

  if (tasks.length === 0) {
    return { scanned_tasks: 0, clusters_found: 0, recommendations_upserted: 0, recommendations_created: 0 };
  }

  const clusters = clusterGeneralTasks(tasks);
  let upserted = 0;
  let created = 0;

  for (const cluster of clusters) {
    const result = upsertRecurrenceRecommendation(cluster);
    upserted++;
    if (result.created) created++;
  }

  return {
    scanned_tasks: tasks.length,
    clusters_found: clusters.length,
    recommendations_upserted: upserted,
    recommendations_created: created,
  };
}
