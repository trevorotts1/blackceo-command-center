import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Recommendation } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/recommendations - List all recommendations
//
// U56 (E.2 / JM-U52) — this route used to auto-seed 5 hardcoded canned rows
// into the LIVE `recommendations` table on the first empty GET (a
// module-level constant + a seed-if-empty helper, both deleted from this
// file), and returned a bare array while the department detail page reads
// `recData.recommendations` — a double break (fake seeded rows AND an
// envelope mismatch that made the real "Department Recommendations" section
// permanently empty). Both are removed: no seed-on-read, and the response
// now carries `{ recommendations: [...] }`. The five previously-seeded rows
// are purged by migration 103 (`purge_demo_recommendations_seed` in
// src/lib/db/migrations.ts) rather than here — this route never touches
// historical data, only serves reads.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const departmentId = searchParams.get('department_id');
    const category = searchParams.get('category');
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    let sql = `
      SELECT
        r.*
      FROM recommendations r
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

    return NextResponse.json({ recommendations: transformedRecommendations });
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
