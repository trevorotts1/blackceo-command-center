import { NextRequest, NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';

// GET /api/kpi-history?workspace_id=X&metric=Y&days=30
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const departmentId = searchParams.get('department_id') || searchParams.get('workspace_id') || 'company';
    const metricId = searchParams.get('metric') || searchParams.get('kpi_id');
    const days = parseInt(searchParams.get('days') || '30', 10);

    let sql = `
      SELECT id, department_id, kpi_id, kpi_name, value, target, unit, snapshot_date, created_at
      FROM kpi_snapshots
      WHERE department_id = ?
        AND snapshot_date >= date('now', '-' || ? || ' days')
        AND kpi_id NOT LIKE '%__benchmark%'
    `;
    const params: unknown[] = [departmentId, days];

    if (metricId) {
      sql += ' AND kpi_id = ?';
      params.push(metricId);
    }

    sql += ' ORDER BY snapshot_date ASC';

    const data = queryAll(sql, params);

    return NextResponse.json({
      success: true,
      data,
      count: data.length,
      department_id: departmentId,
      days,
    });
  } catch (error) {
    console.error('GET /api/kpi-history error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch KPI history' },
      { status: 500 }
    );
  }
}
