import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { run, queryOne } from '@/lib/db';
import { broadcast } from '@/lib/events';

// PATCH /api/recommendations/[id]/outcome - Record an outcome measurement
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const { before_score, after_score, notes } = body;

    if (
      typeof before_score !== 'number' ||
      typeof after_score !== 'number' ||
      before_score < 0 ||
      before_score > 100 ||
      after_score < 0 ||
      after_score > 100
    ) {
      return NextResponse.json(
        { error: 'before_score and after_score must be numbers between 0 and 100' },
        { status: 400 }
      );
    }

    // Check recommendation exists
    const rec = queryOne<{ id: string }>(
      'SELECT id FROM recommendations WHERE id = ?',
      [id]
    );

    if (!rec) {
      return NextResponse.json(
        { error: 'Recommendation not found' },
        { status: 404 }
      );
    }

    const now = new Date().toISOString();
    const improvementPct =
      before_score > 0
        ? Math.round(((after_score - before_score) / before_score) * 100 * 10) / 10
        : after_score > 0
          ? 100
          : 0;

    // Record outcome
    const outcomeId = uuidv4();
    run(
      `INSERT INTO recommendation_outcomes (id, recommendation_id, measured_at, before_score, after_score, improvement_pct, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [outcomeId, id, now, before_score, after_score, improvementPct, notes || null]
    );

    // Update the recommendation with effectiveness score
    const effectivenessScore = Math.min(100, Math.max(0, Math.round(after_score)));
    run(
      `UPDATE recommendations
       SET effectiveness_score = ?, measured_at = ?, outcome_notes = ?
       WHERE id = ?`,
      [effectivenessScore, now, notes || null, id]
    );

    const outcome = queryOne(
      'SELECT * FROM recommendation_outcomes WHERE id = ?',
      [outcomeId]
    );

    broadcast({
      type: 'recommendation_outcome_recorded',
      payload: { recommendation_id: id, outcome },
    });

    return NextResponse.json({
      success: true,
      outcome,
    });
  } catch (error) {
    console.error('Failed to record recommendation outcome:', error);
    return NextResponse.json(
      { error: 'Failed to record outcome' },
      { status: 500 }
    );
  }
}
