import { NextRequest, NextResponse } from 'next/server';
import { run, queryOne } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Recommendation } from '@/lib/types';

// POST /api/recommendations/[id]/approve - Approve a recommendation
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const now = new Date().toISOString();

    // Update recommendation status
    run(
      `UPDATE recommendations 
       SET status = 'approved', resolved_at = ?
       WHERE id = ?`,
      [now, id]
    );

    // Fetch updated recommendation
    const rec = queryOne<Recommendation>(
      'SELECT * FROM recommendations WHERE id = ?',
      [id]
    );

    if (!rec) {
      return NextResponse.json(
        { error: 'Recommendation not found' },
        { status: 404 }
      );
    }

    // Parse supporting_data if it's a string
    const recommendation: Recommendation = {
      ...rec,
      supporting_data: rec.supporting_data && typeof rec.supporting_data === 'string'
        ? JSON.parse(rec.supporting_data)
        : rec.supporting_data,
    };

    // Broadcast update
    broadcast({
      type: 'recommendation_updated',
      payload: recommendation,
    });

    return NextResponse.json({
      success: true,
      message: 'Recommendation approved',
      recommendation,
    });
  } catch (error) {
    console.error('Failed to approve recommendation:', error);
    return NextResponse.json(
      { error: 'Failed to approve recommendation' },
      { status: 500 }
    );
  }
}
