/**
 * Seed 60 days of historical KPI data + industry benchmarks
 * Run: npx tsx src/lib/db/seed-kpi-history.ts
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from './index';

// Industry benchmark definitions per department
interface BenchmarkDef {
  deptId: string;
  kpiId: string;
  kpiName: string;
  benchmark: number;
  target: number;
  unit: 'currency' | 'percent' | 'count';
}

const BENCHMARKS: BenchmarkDef[] = [
  // Marketing
  { deptId: 'marketing', kpiId: 'cpl', kpiName: 'Cost Per Lead', benchmark: 28, target: 25, unit: 'currency' },
  { deptId: 'marketing', kpiId: 'conversion', kpiName: 'Conversion Rate', benchmark: 18, target: 22, unit: 'percent' },
  { deptId: 'marketing', kpiId: 'email-open', kpiName: 'Email Open Rate', benchmark: 22, target: 28, unit: 'percent' },
  { deptId: 'marketing', kpiId: 'social-reach', kpiName: 'Social Reach', benchmark: 35000, target: 40000, unit: 'count' },
  // Sales
  { deptId: 'sales', kpiId: 'response-time', kpiName: 'Lead Response Time', benchmark: 6, target: 5, unit: 'count' },
  { deptId: 'sales', kpiId: 'conversion', kpiName: 'Conversion Rate', benchmark: 18, target: 22, unit: 'percent' },
  { deptId: 'sales', kpiId: 'deals-closed', kpiName: 'Deals Closed', benchmark: 8, target: 12, unit: 'count' },
  { deptId: 'sales', kpiId: 'pipeline-value', kpiName: 'Pipeline Value', benchmark: 200000, target: 280000, unit: 'currency' },
  // Support
  { deptId: 'support', kpiId: 'resolution-time', kpiName: 'Avg Resolution Time', benchmark: 24, target: 18, unit: 'count' },
  { deptId: 'support', kpiId: 'satisfaction', kpiName: 'CSAT Score', benchmark: 82, target: 90, unit: 'percent' },
  { deptId: 'support', kpiId: 'first-contact', kpiName: 'First Contact Resolution', benchmark: 71, target: 80, unit: 'percent' },
  { deptId: 'support', kpiId: 'tickets-resolved', kpiName: 'Tickets Resolved', benchmark: 120, target: 150, unit: 'count' },
  // HR
  { deptId: 'hr', kpiId: 'retention', kpiName: 'Retention Rate', benchmark: 85, target: 90, unit: 'percent' },
  { deptId: 'hr', kpiId: 'time-to-hire', kpiName: 'Time to Hire', benchmark: 28, target: 21, unit: 'count' },
  { deptId: 'hr', kpiId: 'satisfaction', kpiName: 'Employee Satisfaction', benchmark: 74, target: 80, unit: 'percent' },
  { deptId: 'hr', kpiId: 'onboarding', kpiName: 'Onboarding Completion', benchmark: 78, target: 90, unit: 'percent' },
  // Billing
  { deptId: 'billing', kpiId: 'collection-rate', kpiName: 'Collection Rate', benchmark: 88, target: 95, unit: 'percent' },
  { deptId: 'billing', kpiId: 'processing-time', kpiName: 'Processing Time', benchmark: 48, target: 24, unit: 'count' },
  { deptId: 'billing', kpiId: 'accuracy', kpiName: 'Invoice Accuracy', benchmark: 95, target: 99, unit: 'percent' },
  // Operations
  { deptId: 'operations', kpiId: 'automation', kpiName: 'Process Automation', benchmark: 55, target: 70, unit: 'percent' },
  { deptId: 'operations', kpiId: 'throughput', kpiName: 'Task Throughput', benchmark: 12, target: 18, unit: 'count' },
  { deptId: 'operations', kpiId: 'downtime', kpiName: 'System Downtime', benchmark: 5, target: 2, unit: 'count' },
  // Creative
  { deptId: 'creative', kpiId: 'output', kpiName: 'Content Output', benchmark: 15, target: 20, unit: 'count' },
  { deptId: 'creative', kpiId: 'quality', kpiName: 'Quality Score', benchmark: 80, target: 90, unit: 'percent' },
  { deptId: 'creative', kpiId: 'brand-consistency', kpiName: 'Brand Consistency', benchmark: 75, target: 90, unit: 'percent' },
  // Legal
  { deptId: 'legal', kpiId: 'compliance', kpiName: 'Compliance Score', benchmark: 90, target: 98, unit: 'percent' },
  { deptId: 'legal', kpiId: 'review-time', kpiName: 'Contract Review Time', benchmark: 72, target: 48, unit: 'count' },
  // IT
  { deptId: 'it', kpiId: 'uptime', kpiName: 'System Uptime', benchmark: 99.0, target: 99.9, unit: 'percent' },
  { deptId: 'it', kpiId: 'incidents', kpiName: 'Incidents Resolved', benchmark: 10, target: 15, unit: 'count' },
  { deptId: 'it', kpiId: 'patch-rate', kpiName: 'Patch Compliance', benchmark: 85, target: 95, unit: 'percent' },
  // Web Development
  { deptId: 'webdev', kpiId: 'deploy-freq', kpiName: 'Deploy Frequency', benchmark: 5, target: 10, unit: 'count' },
  { deptId: 'webdev', kpiId: 'build-success', kpiName: 'Build Success Rate', benchmark: 90, target: 98, unit: 'percent' },
  { deptId: 'webdev', kpiId: 'load-time', kpiName: 'Page Load Time', benchmark: 3.5, target: 2.0, unit: 'count' },
  // App Development
  { deptId: 'appdev', kpiId: 'features-shipped', kpiName: 'Features Shipped', benchmark: 4, target: 8, unit: 'count' },
  { deptId: 'appdev', kpiId: 'bug-fix-time', kpiName: 'Avg Bug Fix Time', benchmark: 48, target: 24, unit: 'count' },
  { deptId: 'appdev', kpiId: 'test-coverage', kpiName: 'Test Coverage', benchmark: 75, target: 85, unit: 'percent' },
  // Graphics
  { deptId: 'graphics', kpiId: 'design-output', kpiName: 'Design Output', benchmark: 20, target: 30, unit: 'count' },
  { deptId: 'graphics', kpiId: 'approval-rate', kpiName: 'Client Approval Rate', benchmark: 75, target: 90, unit: 'percent' },
  // Video
  { deptId: 'video', kpiId: 'production-vol', kpiName: 'Production Volume', benchmark: 8, target: 12, unit: 'count' },
  { deptId: 'video', kpiId: 'render-time', kpiName: 'Avg Render Time', benchmark: 45, target: 30, unit: 'count' },
  // Audio
  { deptId: 'audio', kpiId: 'production-vol', kpiName: 'Production Volume', benchmark: 6, target: 10, unit: 'count' },
  { deptId: 'audio', kpiId: 'quality-score', kpiName: 'Quality Score', benchmark: 80, target: 90, unit: 'percent' },
  // Research
  { deptId: 'research', kpiId: 'reports-delivered', kpiName: 'Reports Delivered', benchmark: 4, target: 8, unit: 'count' },
  { deptId: 'research', kpiId: 'insights-actioned', kpiName: 'Insights Actioned', benchmark: 50, target: 70, unit: 'percent' },
  // Communications
  { deptId: 'comms', kpiId: 'response-rate', kpiName: 'Response Rate', benchmark: 65, target: 80, unit: 'percent' },
  { deptId: 'comms', kpiId: 'media-mentions', kpiName: 'Media Mentions', benchmark: 10, target: 20, unit: 'count' },
  // CEO
  { deptId: 'ceo', kpiId: 'strategic-progress', kpiName: 'Strategic Progress', benchmark: 60, target: 80, unit: 'percent' },
  { deptId: 'ceo', kpiId: 'cross-dept-coord', kpiName: 'Cross-Dept Coordination', benchmark: 65, target: 85, unit: 'percent' },
];

// Seeded random for reproducibility
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function generateHistoricalValue(
  benchmark: number,
  dayIndex: number,
  totalDays: number,
  rand: () => number
): number {
  // Growth curve: start at ~80% of benchmark, trend up to ~110% of benchmark
  const progress = dayIndex / totalDays;
  const baseMultiplier = 0.80 + progress * 0.30;
  // Add daily noise: +/- 10%
  const noise = (rand() - 0.5) * 0.20;
  const value = benchmark * (baseMultiplier + noise);
  return Math.round(value * 100) / 100;
}

function generateDateStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

export function seedKPIHistory(workspaceId?: string) {
  const db = getDb();
  const rand = seededRandom(42);
  const TOTAL_DAYS = 60;

  // Load department IDs that actually exist in the workspaces table
  const workspaces = db.prepare('SELECT slug FROM workspaces').all() as { slug: string }[];
  const existingSlugs = new Set(workspaces.map((w) => w.slug));

  // Filter benchmarks to only include departments that exist as workspaces
  let benchmarksToSeed = BENCHMARKS.filter((bmk) => existingSlugs.has(bmk.deptId));

  // If no workspaces exist yet, seed all benchmarks (bootstrap case)
  if (existingSlugs.size === 0) {
    console.log('[seed-kpi] No workspaces found in DB — seeding all benchmarks for bootstrap');
    benchmarksToSeed = BENCHMARKS;
  }

  const deptCount = new Set(benchmarksToSeed.map((b) => b.deptId)).size;
  console.log(`[seed-kpi] Seeding ${TOTAL_DAYS} days of KPI history for ${deptCount} departments`);

  // Check existing data
  const existing = db.prepare(
    'SELECT COUNT(*) as cnt FROM kpi_snapshots'
  ).get() as { cnt: number };

  if (existing.cnt > 0) {
    console.log(`[seed-kpi] Found ${existing.cnt} existing snapshots, clearing and re-seeding...`);
    db.exec('DELETE FROM kpi_snapshots');
  }

  const insert = db.prepare(`
    INSERT INTO kpi_snapshots (id, department_id, kpi_id, kpi_name, value, target, unit, snapshot_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (const bmk of benchmarksToSeed) {
      for (let day = TOTAL_DAYS - 1; day >= 0; day--) {
        const value = generateHistoricalValue(bmk.benchmark, TOTAL_DAYS - 1 - day, TOTAL_DAYS, rand);
        const dateStr = generateDateStr(day);

        insert.run(
          uuidv4(),
          bmk.deptId,
          bmk.kpiId,
          bmk.kpiName,
          value,
          bmk.target,
          bmk.unit,
          dateStr
        );
      }
    }

    // Also insert benchmark rows (one per KPI, dated today, tagged)
    for (const bmk of benchmarksToSeed) {
      insert.run(
        uuidv4(),
        bmk.deptId,
        `${bmk.kpiId}__benchmark`,
        `${bmk.kpiName} (Industry Avg)`,
        bmk.benchmark,
        bmk.target,
        bmk.unit,
        generateDateStr(0)
      );
    }
  });

  insertMany();

  const total = db.prepare('SELECT COUNT(*) as cnt FROM kpi_snapshots').get() as { cnt: number };
  console.log(`[seed-kpi] Done. Total snapshots: ${total.cnt}`);
  console.log(`[seed-kpi] Departments seeded: ${deptCount}`);
  console.log(`[seed-kpi] KPIs per dept: varies`);

  return total.cnt;
}

// Allow direct execution
if (require.main === module) {
  seedKPIHistory();
  closeDb();
}
