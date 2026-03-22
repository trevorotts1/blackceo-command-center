import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Recommendation } from '@/lib/types';

// Demo recommendations to seed the database
const DEMO_RECOMMENDATIONS = [
  {
    department_id: 'marketing-dept',
    category: 'do-more' as const,
    title: 'Double Down on Email Campaigns',
    description: 'Your email open rates have increased 34% over the past 60 days. Consider increasing frequency from weekly to twice weekly.',
    supporting_data: JSON.stringify({
      metric: 'email_open_rate',
      currentValue: '34%',
      previousValue: '22%',
      trend: 'up',
      period: '60 days',
      industryBenchmark: '21%',
    }),
    confidence: 0.87,
  },
  {
    department_id: 'sales-dept',
    category: 'stop' as const,
    title: 'Pause Cold Calling Campaign',
    description: 'Cold calling conversion has dropped to 1.2% over the past 3 weeks. Resources would be better allocated to warm lead follow-up.',
    supporting_data: JSON.stringify({
      metric: 'cold_call_conversion',
      currentValue: '1.2%',
      previousValue: '3.8%',
      trend: 'down',
      period: '3 weeks',
      industryBenchmark: '2.5%',
      reasoning: 'Conversion rate has declined for 3 consecutive weeks while warm leads show 12% conversion.',
    }),
    confidence: 0.92,
  },
  {
    department_id: 'operations-dept',
    category: 'watch' as const,
    title: 'Monitor Task Completion Times',
    description: 'Operations tasks are taking 15% longer to complete this week. Watch for bottlenecks in the approval workflow.',
    supporting_data: JSON.stringify({
      metric: 'avg_task_completion_time',
      currentValue: '4.2 days',
      previousValue: '3.6 days',
      trend: 'up',
      period: '1 week',
      threshold: '4.5 days',
      reasoning: 'Trend is concerning but not yet critical. Monitor for another week before taking action.',
    }),
    confidence: 0.76,
  },
  {
    department_id: 'finance-dept',
    category: 'try' as const,
    title: 'Automate Invoice Reminders',
    description: 'Try automating payment reminders 3 days before due date. Similar businesses see 23% reduction in late payments.',
    supporting_data: JSON.stringify({
      metric: 'late_payment_rate',
      currentValue: '18%',
      industryBenchmark: '12%',
      potentialImprovement: '23% reduction',
      suggestedAction: 'Implement automated reminders via email and SMS',
      testPeriod: '30 days',
    }),
    confidence: 0.81,
  },
  {
    department_id: 'product-dept',
    category: 'do-more' as const,
    title: 'Expand User Testing Program',
    description: 'User feedback scores improved 28% since testing began. Expanding the program could accelerate product-market fit.',
    supporting_data: JSON.stringify({
      metric: 'user_satisfaction_score',
      currentValue: '8.2/10',
      previousValue: '6.4/10',
      trend: 'up',
      period: '90 days',
      participantCount: 45,
      suggestedExpansion: 'Increase to 100 participants',
    }),
    confidence: 0.79,
  },
];

// Seed demo recommendations if table is empty
function seedRecommendationsIfEmpty() {
  const count = queryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM recommendations'
  );
  
  if (count && count.count === 0) {
    console.log('[API] Seeding demo recommendations...');
    for (const rec of DEMO_RECOMMENDATIONS) {
      run(
        `INSERT INTO recommendations (id, department_id, category, title, description, supporting_data, confidence, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), rec.department_id, rec.category, rec.title, rec.description, rec.supporting_data, rec.confidence, 'pending']
      );
    }
    console.log('[API] Seeded', DEMO_RECOMMENDATIONS.length, 'recommendations');
  }
}

// GET /api/recommendations - List all recommendations
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const departmentId = searchParams.get('department_id');
    const category = searchParams.get('category');
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    // Seed demo data on first load
    seedRecommendationsIfEmpty();

    let sql = `
      SELECT
        r.*,
        d.name as department_name
      FROM recommendations r
      LEFT JOIN departments d ON r.department_id = d.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (status) {
      sql += ' AND r.status = ?';
      params.push(status);
    }
    if (departmentId) {
      sql += ' AND r.department_id = ?';
      params.push(departmentId);
    }
    if (category) {
      sql += ' AND r.category = ?';
      params.push(category);
    }

    sql += ' ORDER BY r.confidence DESC, r.created_at DESC';
    sql += ' LIMIT ?';
    params.push(limit);

    const recommendations = queryAll<Recommendation & { department_name?: string }>(sql, params);

    // Transform to include parsed supporting_data
    const transformedRecommendations = recommendations.map((rec) => ({
      ...rec,
      supporting_data: rec.supporting_data ? JSON.parse(rec.supporting_data) : null,
    }));

    return NextResponse.json(transformedRecommendations);
  } catch (error) {
    console.error('Failed to fetch recommendations:', error);
    return NextResponse.json({ error: 'Failed to fetch recommendations' }, { status: 500 });
  }
}

// POST /api/recommendations - Create a new recommendation (for agent use)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const id = uuidv4();
    const now = new Date().toISOString();

    run(
      `INSERT INTO recommendations (id, department_id, category, title, description, supporting_data, confidence, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.department_id,
        body.category,
        body.title,
        body.description,
        body.supporting_data ? JSON.stringify(body.supporting_data) : null,
        body.confidence || 0.7,
        'pending',
        now,
      ]
    );

    const recommendation = queryOne<Recommendation>(
      'SELECT * FROM recommendations WHERE id = ?',
      [id]
    );

    if (recommendation) {
      broadcast({
        type: 'recommendation_created',
        payload: {
          ...recommendation,
          supporting_data: recommendation.supporting_data ? JSON.parse(recommendation.supporting_data) : null,
        },
      });
    }

    return NextResponse.json(recommendation, { status: 201 });
  } catch (error) {
    console.error('Failed to create recommendation:', error);
    return NextResponse.json({ error: 'Failed to create recommendation' }, { status: 500 });
  }
}
