import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';

// GET /api/kpi-snapshots - Retrieve latest KPI snapshots
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const departmentId = searchParams.get('department_id') || 'company';
    const days = parseInt(searchParams.get('days') || '30', 10);
    const kpiId = searchParams.get('kpi_id');

    let sql = `
      SELECT id, department_id, kpi_id, kpi_name, value, target, unit, snapshot_date, created_at
      FROM kpi_snapshots
      WHERE department_id = ?
        AND snapshot_date >= date('now', '-' || ? || ' days')
    `;
    const params: unknown[] = [departmentId, days];

    if (kpiId) {
      sql += ' AND kpi_id = ?';
      params.push(kpiId);
    }

    sql += ' ORDER BY snapshot_date DESC, created_at DESC';

    const snapshots = queryAll(sql, params);

    // Also get the latest value per kpi_id
    const latestSql = `
      SELECT kpi_id, kpi_name, value, target, unit, snapshot_date, created_at
      FROM kpi_snapshots
      WHERE department_id = ?
        ${kpiId ? 'AND kpi_id = ?' : ''}
        AND snapshot_date = (
          SELECT MAX(snapshot_date) FROM kpi_snapshots s2
          WHERE s2.kpi_id = kpi_snapshots.kpi_id
            AND s2.department_id = kpi_snapshots.department_id
        )
      ORDER BY created_at DESC
    `;
    const latestParams: unknown[] = [departmentId];
    if (kpiId) latestParams.push(kpiId);
    const latest = queryAll(latestSql, latestParams);

    return NextResponse.json({ snapshots, latest });
  } catch (error) {
    console.error('GET /api/kpi-snapshots error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch KPI snapshots' },
      { status: 500 }
    );
  }
}

// POST /api/kpi-snapshots - Save a KPI snapshot entry
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      kpi_id,
      kpi_name,
      value,
      target,
      unit = 'count',
      department_id = 'company',
      snapshot_date,
    } = body;

    // Validate required fields
    if (!kpi_id || !kpi_name || value === undefined || !snapshot_date) {
      return NextResponse.json(
        { error: 'Missing required fields: kpi_id, kpi_name, value, snapshot_date' },
        { status: 400 }
      );
    }

    if (typeof value !== 'number' || isNaN(value)) {
      return NextResponse.json(
        { error: 'value must be a valid number' },
        { status: 400 }
      );
    }

    const id = uuidv4();

    run(
      `INSERT INTO kpi_snapshots (id, department_id, kpi_id, kpi_name, value, target, unit, snapshot_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, department_id, kpi_id, kpi_name, value, target ?? null, unit, snapshot_date]
    );

    const inserted = queryOne(
      'SELECT * FROM kpi_snapshots WHERE id = ?',
      [id]
    );

    return NextResponse.json({ success: true, snapshot: inserted }, { status: 201 });
  } catch (error) {
    console.error('POST /api/kpi-snapshots error:', error);
    return NextResponse.json(
      { error: 'Failed to save KPI snapshot' },
      { status: 500 }
    );
  }
}
